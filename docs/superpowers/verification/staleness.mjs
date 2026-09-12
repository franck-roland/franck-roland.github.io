// Proves the guard added in ui.js. The dialogs are async, so the 10s poller in
// app.js can replace state.activeDoc while a confirm is open. Without the
// guard, the handler mutates the object it captured at render time and the
// change is silently lost.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const URL = process.env.HARNESS_URL;
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
page.on("pageerror", e => { console.error("PAGE ERROR:", e.message); process.exitCode = 1; });
await page.goto(URL, { waitUntil: "load" });
await page.waitForTimeout(800);

// Installs a fresh UI in "edit" mode (which is what renders Delete buttons).
async function setup(){
  await page.evaluate(async () => {
    document.getElementById("authGate").classList.remove("show");
    const { createUI } = await import("./js/ui.js");

    const t = 1000;
    window.__mkDoc = (listId = "L1") => ({
      schemaVersion: 1, listId, title: "Groceries", mode: "edit",
      ui: { hideChecked: false },
      categories: [{ id: "c_root", name: "All", parentId: null, order: 0, updatedAt: t, deletedAt: null }],
      items: [
        { id: "i1", label: "Milk", qty: null, unit: null, categoryId: "c_root", checked: false, updatedAt: t, deletedAt: null },
        { id: "i2", label: "Bread", qty: null, unit: null, categoryId: "c_root", checked: false, updatedAt: t, deletedAt: null }
      ],
      sync: { driveFileId: "F1", driveFolderId: null, driveModifiedTime: null, lastPulledAt: null, lastPushedAt: null },
      origin: "my", dirty: false, updatedAt: t
    });

    const doc = window.__mkDoc();
    window.__staleDoc = doc;             // the object the handlers capture
    window.__persisted = 0;

    let state = {
      lists: [doc], activeListId: "L1", activeDoc: doc,
      selectedCategoryId: "c_root", activeTab: "my",
      auth: { isSignedIn: true }, shoppingFolderId: null,
      conflict: { pending: false, remoteDoc: null },
      actions: { deleteList: async () => {} }
    };
    window.__getState = () => state;
    window.__setActiveDoc = (d) => { state.activeDoc = d; state.activeListId = d.listId; state.lists = [d]; };

    const ui = createUI({
      getState: () => state,
      setState: s => { state = s; },
      persistActiveDoc: async () => { window.__persisted++; },
      onSync: async () => {},
      onImport: async () => {},
      onResolveConflict: async () => {}
    });
    window.__ui = ui;
    ui.render();
  });
}

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (e) { results.push(`FAIL  ${name} — ${e.message}`); process.exitCode = 1; }
};

const live = () => page.evaluate(() => window.__getState().activeDoc);
const stale = () => page.evaluate(() => window.__staleDoc);

await setup();

await check("baseline: deleting an item tombstones it on the active doc", async () => {
  await page.click(".items .item:has-text('Milk') button[data-act=del]");
  await page.waitForSelector(".modal-overlay");
  await page.click(".modal-footer .btn-danger");
  await page.waitForSelector(".modal-overlay", { state: "detached" });

  const d = await live();
  const milk = d.items.find(i => i.id === "i1");
  assert.ok(milk.deletedAt, "Milk was not tombstoned");
});

await setup();

await check("poller swaps the doc mid-dialog: the deletion lands on the LIVE doc", async () => {
  await page.click(".items .item:has-text('Milk') button[data-act=del]");
  await page.waitForSelector(".modal-overlay");

  // The poller fires: loadAll() replaces state.activeDoc with a new object for
  // the same list. The handler still holds the old one.
  await page.evaluate(() => window.__setActiveDoc(window.__mkDoc("L1")));

  await page.click(".modal-footer .btn-danger");
  await page.waitForSelector(".modal-overlay", { state: "detached" });

  const liveDoc = await live();
  const staleDoc = await stale();

  assert.ok(liveDoc.items.find(i => i.id === "i1").deletedAt,
    "deletion did not reach the live doc — this is the bug the guard prevents");
  assert.equal(staleDoc.items.find(i => i.id === "i1").deletedAt, null,
    "the detached doc was mutated instead");
});

await setup();

await check("user switched lists mid-dialog: the handler bails, nothing is mutated", async () => {
  await page.click(".items .item:has-text('Milk') button[data-act=del]");
  await page.waitForSelector(".modal-overlay");

  await page.evaluate(() => window.__setActiveDoc(window.__mkDoc("L2")));
  const before = await page.evaluate(() => window.__persisted);

  await page.click(".modal-footer .btn-danger");
  await page.waitForSelector(".modal-overlay", { state: "detached" });

  const liveDoc = await live();
  const staleDoc = await stale();

  assert.equal(liveDoc.items.find(i => i.id === "i1").deletedAt, null,
    "deleted an item on the list the user switched to");
  assert.equal(staleDoc.items.find(i => i.id === "i1").deletedAt, null,
    "mutated the abandoned doc");
  assert.equal(await page.evaluate(() => window.__persisted), before,
    "persisted despite bailing");
});

await setup();

await check("rename is guarded the same way", async () => {
  await page.click(".items .item:has-text('Bread') button[data-act=edit]");
  await page.waitForSelector(".modal-overlay");
  await page.fill(".modal input", "Sourdough");

  await page.evaluate(() => window.__setActiveDoc(window.__mkDoc("L1")));

  await page.click(".modal-footer .btn-primary");
  await page.waitForSelector(".modal-overlay", { state: "detached" });

  const liveDoc = await live();
  const staleDoc = await stale();
  assert.equal(liveDoc.items.find(i => i.id === "i2").label, "Sourdough",
    "rename did not reach the live doc");
  assert.equal(staleDoc.items.find(i => i.id === "i2").label, "Bread",
    "the detached doc was renamed instead");
});

console.log(results.join("\n"));
await browser.close();
