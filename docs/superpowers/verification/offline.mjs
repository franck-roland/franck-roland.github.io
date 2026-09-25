import { chromium } from "playwright";
import assert from "node:assert/strict";

const URL = process.env.HARNESS_URL;
const browser = await chromium.launch({ channel: "chrome" });

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (e) { results.push(`FAIL  ${name} — ${e.message}`); process.exitCode = 1; }
};

/**
 * A context with one list already in IndexedDB and no Drive token, which is
 * the real shopping case: you signed in at home, the tab was closed, and
 * sessionStorage went with it.
 *
 * Deliberately does NOT clear IndexedDB first. A fresh browser context is
 * already an isolated origin with empty storage, and an addInitScript that
 * deleted the database would re-run before every navigation — including the
 * page.reload() each check performs — wiping the list it had just seeded.
 */
async function seeded({ serviceWorkers = "block" } = {}){
  const context = await browser.newContext({ serviceWorkers });
  const page = await context.newPage();
  await page.goto(URL);
  await page.evaluate(async () => {
    const { DB } = await import("./js/db.js");
    const { createNewListDoc, addItem } = await import("./js/model.js");
    const doc = createNewListDoc("Groceries");
    doc.origin = "my";
    doc.sync.driveFileId = "fake-file-id";
    doc.dirty = false;
    addItem(doc, { label: "Milk" });
    addItem(doc, { label: "Bread" });
    doc.dirty = false;
    await DB.putList(doc);
  });
  return { context, page };
}

await check("the app shell is served from cache with the network cut", async () => {
  // A real service worker this time, so the cache is what answers.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(URL);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10_000 });

  await context.setOffline(true);
  const failures = [];
  page.on("requestfailed", r => {
    const u = r.url();
    if(u.startsWith(new global.URL(URL).origin)) failures.push(u);
  });
  await page.reload();

  assert.equal(await page.isVisible(".topbar"), true, "the page did not render offline");
  assert.deepEqual(failures, [], "same-origin requests failed while offline");
  await context.close();
});

await check("the gate offers Continue offline when lists are saved", async () => {
  const { context, page } = await seeded();
  await page.reload();
  await page.waitForSelector("#authGate.show");
  assert.equal(await page.isVisible("#btnContinueOffline"), true);
  await context.close();
});

await check("the gate hides Continue offline when nothing is saved", async () => {
  // A fresh context, deliberately never seeded: empty IndexedDB is the point.
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  await page.goto(URL);
  await page.waitForSelector("#authGate.show");
  assert.equal(await page.isVisible("#btnContinueOffline"), false);
  await context.close();
});

await check("continuing offline shows the lists and the banner", async () => {
  const { context, page } = await seeded();
  await page.reload();
  await page.click("#btnContinueOffline");
  assert.equal(await page.isVisible("#authGate.show"), false, "gate still up");
  assert.equal(await page.isVisible("#offlineBanner"), true, "no offline banner");
  // Offline was *chosen*, and the network coming back does not end that mode
  // — you leave it by signing in — so the banner must not promise otherwise.
  assert.match(await page.textContent("#offlineBannerWhy"), /Sign in to sync/);
  assert.doesNotMatch(await page.textContent("#offlineBannerWhy"), /back online/);
  assert.equal(await page.textContent(".list-card .name"), "Groceries");
  await context.close();
});

await check("structural editing is disabled offline, ticking is not", async () => {
  const { context, page } = await seeded();
  await page.reload();
  await page.click("#btnContinueOffline");
  await page.click(".list-card");

  // The two conflict buttons are in this list because a conflict found just
  // before the signal died survives into offline mode, and "Keep remote"
  // there discards the whole trip's ticks locally with no error to show.
  for(const id of ["#btnNewList", "#btnImportFile", "#btnAddCategory",
                   "#btnAddItem", "#btnQuickAdd", "#newItemInput",
                   "#btnDeleteList", "#btnShare", "#modeEdit",
                   "#btnResolveConflict", "#btnDismissConflict"]){
    assert.equal(await page.isDisabled(id), true, `${id} was still enabled`);
  }
  assert.equal(await page.getAttribute("#listTitle", "readonly") !== null, true, "title was editable");
  assert.equal(await page.locator(".handle").count(), 0, "drag handles still present");
  assert.equal(await page.locator(".menubtn").count(), 0, "category menus still present");
  assert.equal(await page.locator(".sec-add").count(), 0, "section add buttons still present");

  await context.close();
});

await check("a tick offline reaches IndexedDB", async () => {
  const { context, page } = await seeded();
  await page.reload();
  await page.click("#btnContinueOffline");
  await page.click(".list-card");

  await page.locator(".item input[type=checkbox]").first().check();
  await page.waitForFunction(async () => {
    const { DB } = await import("./js/db.js");
    const all = await DB.getAllLists();
    return all[0]?.items.some(i => i.checked) && all[0]?.dirty === true;
  }, null, { timeout: 5000 });

  await context.close();
});

await check("the poller never reaches Google while offline", async () => {
  const { context, page } = await seeded();

  // index.html loads the GIS client from accounts.google.com in a <script>
  // tag on every page load, so hits are only counted once we are offline and
  // the page has settled. The claim under test is that no *background* call
  // reaches Google, not that the tag never loads.
  let recording = false;
  const googleHits = [];
  const watch = route => {
    if(recording) googleHits.push(route.request().url());
    route.abort();
  };
  await context.route("**://accounts.google.com/**", watch);
  await context.route("**://*.googleapis.com/**", watch);

  await page.reload();
  await page.click("#btnContinueOffline");
  await context.setOffline(true);
  await page.waitForTimeout(1000);
  recording = true;

  // Two full poll intervals.
  await page.waitForTimeout(21_000);

  assert.deepEqual(googleHits, [], "a background call tried to reach Google");
  await context.close();
});

// ---------------------------------------------------------------------------
// Signed-in checks.
//
// Every check above boots signed *out*, through seeded(). That is why the two
// worst defects here survived a green suite: neither is reachable without a
// token in sessionStorage, so nothing ever ran the code that held them. The
// four below boot with one.
// ---------------------------------------------------------------------------

const TOKEN_KEY = "drive_access_token";
const EXP_KEY = "drive_access_token_exp";
const T = 1_000_000;

/** The list as it sits on the device. "L1" so the stub remote can match it. */
function groceries({ dirty = false, milkChecked = false, milkUpdatedAt = T } = {}){
  return {
    schemaVersion: 1, listId: "L1", title: "Groceries", mode: "shopping",
    ui: { hideChecked: false },
    categories: [{ id: "c_root", name: "All", parentId: null, order: 0, updatedAt: T, deletedAt: null }],
    items: [
      { id: "i1", label: "Milk",  qty: null, unit: null, categoryId: "c_root",
        checked: milkChecked, updatedAt: milkUpdatedAt, deletedAt: null },
      { id: "i2", label: "Bread", qty: null, unit: null, categoryId: "c_root",
        checked: false, updatedAt: T, deletedAt: null }
    ],
    sync: { driveFileId: "fake-file-id", driveFolderId: "FOLDER",
            driveModifiedTime: null, lastPulledAt: T, lastPushedAt: T },
    origin: "my", dirty, updatedAt: milkUpdatedAt
  };
}

/**
 * A Drive that records what was written to it. Route interception, the way
 * importflow.mjs does it — sign-in cannot happen headlessly, and what is under
 * test is what the app does with the answers, not the transport.
 */
function stubDriveSync({ files = [], docs = {} } = {}){
  return `
globalThis.__pushed = [];
const FILES = ${JSON.stringify(files)};
const DOCS = ${JSON.stringify(docs)};

export const DriveSync = {
  async ensureShoppingFolder(){ return "FOLDER"; },
  async ensureMyListFile(doc){
    doc.sync.driveFileId = "fake-file-id";
    doc.sync.driveFolderId = "FOLDER";
    return doc;
  },
  async listFolderListFiles(){ return structuredClone(FILES); },
  async pullFileToDoc(fileId){
    const doc = structuredClone(DOCS[fileId]);
    doc.sync = { ...doc.sync, driveFileId: fileId, lastPulledAt: Date.now() };
    doc.dirty = false;
    return doc;
  },
  async syncDetectConflict(doc){
    // Faithful to the real one on the point that matters: it writes to Drive
    // only when the doc is dirty, so __pushed is exactly the set of writes.
    const dirty = !!doc.dirty;
    if(dirty) globalThis.__pushed.push(structuredClone(doc));
    const out = structuredClone(doc);
    out.dirty = false;
    out.sync.lastPulledAt = Date.now();
    if(dirty) out.sync.lastPushedAt = Date.now();
    return { status: dirty ? "merged_pushed" : "pulled_only", doc: out, remote: out };
  },
  async pushOverwrite(doc){ globalThis.__pushed.push(structuredClone(doc)); return doc; },
  async importSharedByFileId(){ throw new Error("not used"); },
  async resolveConflict(doc){ return doc; },
  async share(){ return "https://example.invalid/x"; }
};
`;
}

/**
 * Sign-in without a popup: what matters is everything app.js runs *after*
 * signInInteractive() resolves. Backed by sessionStorage so the answer
 * survives the reload the check performs.
 */
const STUB_DRIVE_AUTH = `
function signedIn(){ return sessionStorage.getItem("stub_signed_in") === "1"; }
export function tokenDecision(){ return signedIn() ? "use" : "none"; }

export const DriveAuth = {
  async init(){},
  isSignedIn(){ return signedIn(); },
  getAccessToken(){ return signedIn() ? "fake-token" : null; },
  async signInInteractive(){
    sessionStorage.setItem("stub_signed_in", "1");
    return { access_token: "fake-token", expires_at: Date.now() + 3_600_000 };
  },
  async signOut(){ sessionStorage.removeItem("stub_signed_in"); },
  async ensureToken(){ return signedIn() ? { access_token: "fake-token" } : null; }
};
`;

const serveStub = (body) => (route) =>
  route.fulfill({ status: 200, contentType: "text/javascript", body });

/** A context whose next load boots with a token already in sessionStorage. */
async function withToken({ expired = false, drive = {}, doc = groceries() } = {}){
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  await page.route("**/js/driveSync.js", serveStub(stubDriveSync(drive)));
  await page.goto(URL);
  await page.evaluate(async ({ doc, exp, tokenKey, expKey }) => {
    const { DB } = await import("./js/db.js");
    await DB.putList(doc);
    sessionStorage.setItem(tokenKey, "fake-token");
    sessionStorage.setItem(expKey, String(exp));
  }, { doc, tokenKey: TOKEN_KEY, expKey: EXP_KEY,
       exp: expired ? Date.now() - 60_000 : Date.now() + 3_600_000 });
  return { context, page };
}

const milkBox = (page) =>
  page.locator(".item", { hasText: "Milk" }).locator("input[type=checkbox]");

const statusReads = (page, text) =>
  page.waitForFunction(
    (t) => document.getElementById("syncStatus").textContent === t,
    text, { timeout: 10_000 });

const tickLanded = (page) =>
  page.waitForFunction(async () => {
    const { DB } = await import("./js/db.js");
    return (await DB.getList("L1"))?.dirty === true;
  }, null, { timeout: 5_000 });

await check("reconnecting pushes the ticks made offline and says so", async () => {
  const { context, page } = await withToken();
  await page.reload();
  await page.waitForSelector(".list-card");
  assert.equal(await page.isVisible("#authGate.show"), false, "the gate blocked a signed-in boot");
  await page.click(".list-card");

  await context.setOffline(true);
  await page.waitForSelector("#offlineBanner:not(.hidden)");
  await milkBox(page).check();
  await tickLanded(page);
  assert.deepEqual(await page.evaluate(() => window.__pushed), [],
    "something wrote to Drive while offline");

  await context.setOffline(false);
  // "Synced ✅" is set by syncActive and nothing else, so it is the reconnect
  // push talking rather than the ten-second poller.
  await statusReads(page, "Synced ✅");

  const pushed = await page.evaluate(() => window.__pushed);
  assert.equal(pushed.length > 0, true, "the reconnect pushed nothing");
  assert.equal(pushed.at(-1).items.find(i => i.label === "Milk").checked, true,
    "the tick made in the shop never reached Drive");
  await context.close();
});

await check("an expired token saves the ticks and asks for a sign-in rather than pushing", async () => {
  const { context, page } = await withToken({ expired: true });
  await page.reload();

  // An expired token used to read as signed in, which hid this button in the
  // exact case the gate's third state was written for.
  await page.waitForSelector("#authGate.show");
  assert.equal(await page.isVisible("#btnContinueOffline"), true,
    "an expired token hid the offline way in");
  await page.click("#btnContinueOffline");
  await page.click(".list-card");

  await context.setOffline(true);
  await milkBox(page).check();
  await tickLanded(page);

  await context.setOffline(false);
  await statusReads(page, "Offline changes saved — sign in to sync");
  assert.deepEqual(await page.evaluate(() => window.__pushed), [],
    "pushed to Drive with a dead token");
  await context.close();
});

await check("signing in after an offline trip keeps the ticks made in the shop", async () => {
  // Drive still holds the list as it was before the trip: Milk not ticked.
  const remote = groceries({ milkChecked: false, milkUpdatedAt: T });

  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  await page.route("**/js/driveSync.js", serveStub(stubDriveSync({
    files: [{ id: "fake-file-id", name: "list_L1.json" }],
    docs: { "fake-file-id": remote }
  })));
  await page.route("**/js/driveAuth.js", serveStub(STUB_DRIVE_AUTH));
  await page.goto(URL);

  // The device holds what the trip produced: Milk ticked, newer, and dirty.
  await page.evaluate(async (doc) => {
    const { DB } = await import("./js/db.js");
    await DB.putList(doc);
  }, groceries({ dirty: true, milkChecked: true, milkUpdatedAt: T + 60_000 }));
  await page.reload();

  await page.waitForSelector("#authGate.show");
  await page.click("#btnSignInGate");
  await page.waitForFunction(
    () => document.getElementById("syncStatus").textContent.startsWith("Loaded"),
    null, { timeout: 10_000 });

  const stored = await page.evaluate(async () => {
    const { DB } = await import("./js/db.js");
    return await DB.getList("L1");
  });
  assert.equal(stored.items.find(i => i.label === "Milk").checked, true,
    "signing in overwrote the local doc and destroyed the offline ticks");
  assert.equal(stored.dirty, true,
    "the merged doc lost its dirty flag, so the ticks would never be pushed");
  await context.close();
});

await check("booting offline with a token shows the saved lists, not a fatal error", async () => {
  // A real service worker: booting with no network at all is the whole point,
  // and this path is only reachable because that worker now serves the page.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(URL);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10_000 });

  await page.evaluate(async ({ doc, tokenKey, expKey }) => {
    const { DB } = await import("./js/db.js");
    await DB.putList(doc);
    sessionStorage.setItem(tokenKey, "fake-token");
    sessionStorage.setItem(expKey, String(Date.now() + 3_600_000));
  }, { doc: groceries(), tokenKey: TOKEN_KEY, expKey: EXP_KEY });

  await context.setOffline(true);
  await page.reload();
  // Long enough for the Drive pull to have failed and put a modal up: the
  // fetch rejects at once offline, well before the 8s transport timeout.
  await page.waitForTimeout(3_000);

  assert.equal(await page.locator(".modal-overlay").count(), 0,
    "a fatal-error dialog appeared over the saved lists");
  assert.equal(await page.locator(".list-card").count(), 1, "the lists did not render");
  assert.equal(await page.textContent(".list-card .name"), "Groceries");
  assert.equal(await page.isVisible("#authGate.show"), false, "the gate blocked a signed-in boot");
  // Offline was *detected* here rather than chosen, so the banner says the
  // opposite of what it says on the chosen path above.
  assert.match(await page.textContent("#offlineBannerWhy"), /back online/);
  await context.close();
});

console.log(results.join("\n"));
await browser.close();
