// Item search, in two halves.
//
// Most checks drive the real createUI() over a hand-made state, the way
// itemsview.mjs does, so edit mode and the section add buttons can be reached
// without Drive. The last check boots the whole app with no token and takes the
// "Continue offline" path, because the point of search is finding an item to
// tick in a shop with no signal.
//
// The matching itself (case, accents, ligatures, several terms, highlight
// offsets) and the outline filtering are covered by
// `node --test js/search.test.mjs js/tree.test.mjs`.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const URL = process.env.HARNESS_URL;
const browser = await chromium.launch({ channel: "chrome" });
// The app registers a service worker. Left alone it would cache app files
// across runs and serve stale code into checks that look unrelated.
const context = await browser.newContext({ serviceWorkers: "block" });
// index.html boots the real app, which builds its own createUI() over the same
// DOM. Two UIs mean two listeners on #itemSearch, and the app's — rendering a
// state with no list — would answer Escape first. Stub it out so the page holds
// only the UI under test.
await context.route("**/js/app.js", r =>
  r.fulfill({ contentType: "text/javascript", body: "" }));
const page = await context.newPage();
page.on("pageerror", e => { console.error("PAGE ERROR:", e.message); process.exitCode = 1; });

async function setup(mode = "shopping", selectedCategoryId = "c_fru"){
  // Reload first: the folds and the search's list id are module-level in ui.js.
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForTimeout(300);

  await page.evaluate(async ({ mode, selectedCategoryId }) => {
    document.getElementById("authGate").classList.remove("show");
    document.getElementById("emptyState").classList.add("hidden");
    document.getElementById("listView").classList.remove("hidden");

    const { createUI } = await import("./js/ui.js");
    const t = 1000;

    const cat = (id, name, parentId, order) =>
      ({ id, name, parentId, order, updatedAt: t, deletedAt: null });
    const item = (id, label, categoryId, checked = false) =>
      ({ id, label, qty: null, unit: null, categoryId, checked, updatedAt: t, deletedAt: null });

    window.__mkDoc = (listId, title) => ({
      schemaVersion: 1, listId, title, mode,
      ui: { hideChecked: false },
      categories: [
        cat("c_root", "All", null, 0),
        cat("c_ali", "Alimentation", "c_root", 0),
        cat("c_fru", "Fruits", "c_ali", 0),
        cat("c_cre", "Crèmerie", "c_ali", 1),
        cat("c_mai", "Maison", "c_root", 1)
      ],
      items: [
        item("i_pom", "Pommes", "c_fru"),
        item("i_ban", "Bananes", "c_fru"),
        item("i_lai", "Lait demi-écrémé", "c_cre"),
        item("i_cf",  "Crème fraîche", "c_cre"),
        item("i_lco", "Lait de coco", "c_ali"),
        item("i_eps", "Éponges", "c_mai")
      ],
      sync: { driveFileId: "F", driveFolderId: null, driveModifiedTime: null, lastPulledAt: null, lastPushedAt: null },
      origin: "my", dirty: false, updatedAt: t
    });

    const a = window.__mkDoc("L1", "Groceries");
    const b = window.__mkDoc("L2", "Other");

    let state = {
      lists: [a, b], activeListId: "L1", activeDoc: a,
      selectedCategoryId, activeTab: "my",
      auth: { isSignedIn: true }, shoppingFolderId: null,
      conflict: { pending: false, remoteDoc: null },
      actions: {
        deleteList: async () => {},
        selectList: async (id) => {
          const d = state.lists.find(x => x.listId === id);
          state = { ...state, activeListId: id, activeDoc: d };
          window.__ui.render();
        }
      }
    };
    window.__getState = () => state;

    const ui = createUI({
      getState: () => state,
      setState: s => { state = s; },
      persistActiveDoc: async () => {},
      onSync: async () => {},
      onImport: async () => {},
      onExport: async () => {},
      onImportFile: async () => {},
      onResolveConflict: async () => {}
    });
    window.__ui = ui;
    ui.render();
  }, { mode, selectedCategoryId });
}

const labels   = () => page.$$eval("#itemsContainer .item .label", els => els.map(e => e.textContent));
const sections = () => page.$$eval("#itemsContainer .sec", els => els.map(e => e.dataset.section));
const marks    = () => page.$$eval("#itemsContainer .item mark", els => els.map(e => e.textContent));

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (e) { results.push(`FAIL  ${name} — ${e.message}`); process.exitCode = 1; }
};

// ---------------------------------------------------------------------------

await check("typing filters the items, ignoring case and accents", async () => {
  await setup();
  await page.fill("#itemSearch", "FRAICHE");
  assert.deepEqual(await labels(), ["Crème fraîche"]);
  // "écrémé" folds to "ecreme", so the accent-free query finds both.
  await page.fill("#itemSearch", "creme");
  assert.deepEqual((await labels()).sort(), ["Crème fraîche", "Lait demi-écrémé"]);
});

await check("search covers the whole list, not just the selected category", async () => {
  await setup("shopping", "c_fru");          // scoped to Fruits
  assert.deepEqual((await labels()).sort(), ["Bananes", "Pommes"]);

  await page.fill("#itemSearch", "eponge");
  assert.deepEqual(await labels(), ["Éponges"]);
  assert.equal(await page.textContent("#itemsTitle"), "Items — “eponge”");
});

await check("every word must match, and the count chip counts matches", async () => {
  await setup();
  await page.fill("#itemSearch", "lait");
  assert.deepEqual((await labels()).sort(), ["Lait de coco", "Lait demi-écrémé"]);
  assert.equal(await page.textContent("#itemsCount"), "2");

  await page.fill("#itemSearch", "coco lait");
  assert.deepEqual(await labels(), ["Lait de coco"]);
  assert.equal(await page.textContent("#itemsCount"), "1");
});

await check("only the sections on a match's path are shown", async () => {
  await setup("edit");                        // edit mode keeps empty sections otherwise
  await page.fill("#itemSearch", "fraiche");
  assert.deepEqual(await sections(), ["c_root", "c_ali", "c_cre"]);
});

await check("the matching text is highlighted, and only as text", async () => {
  await setup();
  await page.fill("#itemSearch", "fraiche");
  assert.deepEqual(await marks(), ["fraîche"]);
  // The label is still the label: the highlight added no characters.
  assert.deepEqual(await labels(), ["Crème fraîche"]);
});

await check("a folded section opens while searching and folds back when cleared", async () => {
  await setup("shopping", "c_root");
  await page.click("#itemsContainer .sec[data-section='c_ali']");    // fold
  assert.equal((await labels()).includes("Pommes"), false, "the fold did not take");

  await page.fill("#itemSearch", "pom");
  assert.deepEqual(await labels(), ["Pommes"]);

  // A header does nothing while searching, so the fold cannot be changed by
  // accident and spring on you later.
  await page.click("#itemsContainer .sec[data-section='c_ali']");
  assert.deepEqual(await labels(), ["Pommes"]);

  await page.fill("#itemSearch", "");
  assert.equal((await labels()).includes("Pommes"), false, "the fold was lost");
});

await check("no section add buttons while searching", async () => {
  await setup("edit", "c_root");
  assert.ok(await page.locator(".sec-add").count() > 0, "precondition: add buttons exist");
  await page.fill("#itemSearch", "lait");
  assert.equal(await page.locator(".sec-add").count(), 0);
});

await check("no match says so", async () => {
  await setup();
  await page.fill("#itemSearch", "zzz");
  assert.deepEqual(await labels(), []);
  assert.equal(await page.textContent(".items-empty"), "No items match “zzz”.");
  assert.equal(await page.textContent("#itemsCount"), "0");
});

await check("Escape clears the search, then leaves the box", async () => {
  await setup("shopping", "c_fru");
  await page.fill("#itemSearch", "lait");
  await page.press("#itemSearch", "Escape");
  assert.equal(await page.inputValue("#itemSearch"), "");
  assert.deepEqual((await labels()).sort(), ["Bananes", "Pommes"]);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "itemSearch");

  await page.press("#itemSearch", "Escape");
  assert.notEqual(await page.evaluate(() => document.activeElement?.id), "itemSearch");
});

await check("Escape in the search box does not also leave focus mode", async () => {
  await setup();
  // app.js is stubbed here, so stand in for its document-level Escape handler.
  await page.evaluate(() => {
    window.__docEscapes = 0;
    document.addEventListener("keydown", e => { if(e.key === "Escape") window.__docEscapes++; });
  });
  await page.fill("#itemSearch", "lait");
  await page.press("#itemSearch", "Escape");
  await page.press("#itemSearch", "Escape");
  assert.equal(await page.evaluate(() => window.__docEscapes), 0);
});

await check("ticking a match keeps the search", async () => {
  await setup();
  await page.fill("#itemSearch", "lait");
  await page.locator("#itemsContainer .item input[type=checkbox]").first().check();
  assert.equal(await page.inputValue("#itemSearch"), "lait");
  assert.equal((await labels()).length, 2, "the search was lost on tick");
  const checked = await page.evaluate(() =>
    window.__getState().activeDoc.items.filter(i => i.checked).map(i => i.label));
  assert.equal(checked.length, 1);
});

await check("typing in search closes an open add row instead of losing focus to it", async () => {
  await setup("edit", "c_root");
  await page.click("#itemsContainer .sec[data-section='c_fru'] .sec-add");
  assert.equal(await page.locator("[data-add-input='1']").count(), 1, "precondition: add row open");

  await page.click("#itemSearch");
  await page.keyboard.type("pom");
  assert.equal(await page.inputValue("#itemSearch"), "pom", "keystrokes went elsewhere");
  assert.equal(await page.locator("[data-add-input='1']").count(), 0);
});

await check("opening another list starts a fresh search", async () => {
  await setup();
  await page.fill("#itemSearch", "lait");
  await page.click(".list-card:has-text('Other')");
  assert.equal(await page.inputValue("#itemSearch"), "");
  assert.equal(await page.textContent("#itemsTitle"), "Items — Fruits");
});

await context.close();

// ---------------------------------------------------------------------------
// The real app, offline: the case search exists for.

await check("search works offline, and a tick on a match reaches IndexedDB", async () => {
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const p = await ctx.newPage();
  await p.goto(URL);
  await p.evaluate(async () => {
    const { DB } = await import("./js/db.js");
    const { createNewListDoc, addItem } = await import("./js/model.js");
    const doc = createNewListDoc("Groceries");
    doc.origin = "my";
    doc.sync.driveFileId = "fake-file-id";
    addItem(doc, { label: "Milk" });
    addItem(doc, { label: "Bread" });
    addItem(doc, { label: "Oat milk" });
    doc.dirty = false;
    await DB.putList(doc);
  });
  await p.reload();
  await p.click("#btnContinueOffline");
  await p.click(".list-card");
  assert.equal(await p.isVisible("#offlineBanner"), true, "precondition: offline");

  assert.equal(await p.isDisabled("#itemSearch"), false, "search was disabled offline");
  await p.fill("#itemSearch", "milk");
  const shown = await p.$$eval("#itemsContainer .item .label", els => els.map(e => e.textContent));
  assert.deepEqual(shown.sort(), ["Milk", "Oat milk"]);

  await p.locator("#itemsContainer .item input[type=checkbox]").first().check();
  await p.waitForFunction(async () => {
    const { DB } = await import("./js/db.js");
    const all = await DB.getAllLists();
    return all[0]?.items.filter(i => i.checked).length === 1 && all[0]?.dirty === true;
  }, null, { timeout: 5000 });
  assert.equal(await p.inputValue("#itemSearch"), "milk", "the search was lost on tick");
  await ctx.close();
});

console.log(results.join("\n"));
await browser.close();
