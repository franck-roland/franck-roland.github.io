import { CONFIG } from "./config.js";
import { DB } from "./db.js";

const TOKEN_KEY = "drive_access_token";
const EXP_KEY = "drive_access_token_exp";

const GIS_SRC = "https://accounts.google.com/gsi/client";

let tokenClient = null;
let gisLoading = null;

/**
 * Should a request go ahead with this token? Pure, so it can be tested without
 * a browser — the IO (sessionStorage, the GIS popup) stays in ensureToken.
 *
 * There is deliberately no "reauth" outcome. Re-authentication needs a Google
 * popup, and a popup that opens because a background poller ticked is exactly
 * the thing this app must never do while you are standing in a shop.
 */
export function tokenDecision(token, nowMs, skewMs = 30_000){
  if(token && token.expires_at > nowMs + skewMs) return "use";
  return "none";
}

export const DriveAuth = {
  async init(){
    // Restore token from session if present
    const tok = sessionStorage.getItem(TOKEN_KEY);
    const exp = Number(sessionStorage.getItem(EXP_KEY) || "0");
    if(tok && exp > Date.now() + 30_000){
      await DB.setSetting("driveToken", { access_token: tok, expires_at: exp });
    }
  },

  isSignedIn(){
    // Expiry-aware on purpose. A merely *present* token used to read as signed
    // in, which disabled the Sign in button while the token was dead, hid the
    // gate's "Continue offline" button in the very case offline mode was
    // written for, and made a failure while plainly online read as offline.
    return tokenDecision(getToken(), Date.now()) === "use";
  },

  getAccessToken(){
    const t = getToken();
    return t?.access_token || null;
  },

  async signInInteractive(){
    // Only ever reached from the two sign-in buttons, so fetching Google's
    // script from here cannot surprise anyone with an unprompted popup.
    if(!window.google?.accounts?.oauth2){
      await loadGis();
    }
    if(!window.google?.accounts?.oauth2){
      throw new Error("Could not reach Google to sign in. Check your connection, then reload the page.");
    }
    if(!CONFIG.GOOGLE_CLIENT_ID || CONFIG.GOOGLE_CLIENT_ID.includes("PASTE_")){
      throw new Error("Set CONFIG.GOOGLE_CLIENT_ID in js/config.js");
    }

    if(!tokenClient){
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.GOOGLE_CLIENT_ID,
        scope: CONFIG.SCOPES,
        callback: async (resp) => {
          // handled per request below
        }
      });
    }

    const token = await new Promise((resolve, reject) => {
      tokenClient.callback = (resp) => {
        if(resp?.error) return reject(new Error(resp.error));
        // Expires in seconds
        const expiresAt = Date.now() + (resp.expires_in * 1000);
        resolve({ access_token: resp.access_token, expires_at: expiresAt });
      };
      tokenClient.requestAccessToken({ prompt: "consent" });
    });

    await persistToken(token);
    return token;
  },

  async signOut(){
    // NOTE: GIS revocation is optional; we just drop locally.
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(EXP_KEY);
    await DB.setSetting("driveToken", null);
  },

  async ensureToken(){
    const token = getToken();
    if(tokenDecision(token, Date.now()) === "use") return token;

    // No silent refresh is possible without a server, and prompting here would
    // open an OAuth popup from whatever happened to call us — including the
    // ten-second poller. Callers treat null as "not signed in right now"; the
    // sign-in buttons are the only interactive path.
    return null;
  }
};

/**
 * index.html loads the GIS client once, in a script tag, at page load. Boot in
 * a shop and that fetch fails, leaving window.google undefined for the rest of
 * the page's life — so the sign-in tap on the way home, the last step of the
 * whole offline journey, would throw for ever. Load it on demand instead.
 */
function loadGis(){
  if(window.google?.accounts?.oauth2) return Promise.resolve();

  gisLoading ??= new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = GIS_SRC;
    el.async = true;
    el.addEventListener("load", () => resolve());
    el.addEventListener("error", () => {
      // Forget the failure so the next tap tries again: the usual cause is a
      // signal that has not come back yet, but may at any moment.
      gisLoading = null;
      el.remove();
      reject(new Error("Could not reach Google to sign in. Check your connection, then reload the page."));
    });
    document.head.appendChild(el);
  });

  return gisLoading;
}

async function persistToken(token){
  sessionStorage.setItem(TOKEN_KEY, token.access_token);
  sessionStorage.setItem(EXP_KEY, String(token.expires_at));
  await DB.setSetting("driveToken", token);
}

function getToken(){
  // Fast path from session; fallback to IDB setting cache
  const tok = sessionStorage.getItem(TOKEN_KEY);
  const exp = Number(sessionStorage.getItem(EXP_KEY) || "0");
  if(tok && exp) return { access_token: tok, expires_at: exp };
  return null;
}