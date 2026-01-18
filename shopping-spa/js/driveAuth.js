import { CONFIG } from "./config.js";
import { DB } from "./db.js";

const TOKEN_KEY = "drive_access_token";
const EXP_KEY = "drive_access_token_exp";

let tokenClient = null;

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
    return getToken() !== null;
  },

  getAccessToken(){
    const t = getToken();
    return t?.access_token || null;
  },

  async signInInteractive(){
    if(!window.google?.accounts?.oauth2){
      throw new Error("Google Identity Services not loaded yet.");
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
    if(token && token.expires_at > Date.now() + 30_000) return token;

    // Re-auth interactively (no server; silent refresh is limited)
    return await DriveAuth.signInInteractive();
  }
};

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