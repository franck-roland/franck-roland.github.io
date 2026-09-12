// Exercises the Share button end-to-end against the real page, the way
// conflict.mjs drives the conflict dialog: createUI() is instantiated with a
// signed-in fake state, #btnShare is clicked, and what reaches onShare is
// checked.
//
// The regression this guards: #btnShare was queried in ui.js and its `disabled`
// state was maintained, but no click listener was ever bound — so the button
// was inert, with no error to show for it.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const URL = process.env.HARNESS_URL;
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
page.on("pageerror", e => { console.error("PAGE ERROR:", e.message); process.exitCode = 1; });
await page.goto(URL, { waitUntil: "load" });
await page.waitForTimeout(800);

/** Rebuild the fake app over the real createUI(). `signedIn` drives the button. */
async function mount(signedIn){
  await page.evaluate(async (isSignedIn) => {
    // We fake a signed-in state, so drop the mandatory sign-in overlay that
    // would otherwise sit on top of the page and swallow clicks.
    document.getElementById("authGate").classList.remove("show");

    const { createUI } = await import("./js/ui.js");

    const t = 1000;
    const doc = {
      schemaVersion: 1, listId: "L1", title: "Groceries", mode: "shopping",
      ui: { hideChecked: false },
      categories: [{ id: "c_root", name: "All", parentId: null, order: 0, updatedAt: t, deletedAt: null }],
      items: [
        { id: "i1", label: "Milk", qty: null, unit: null, categoryId: "c_root", checked: false, updatedAt: t, deletedAt: null }
      ],
      sync: { driveFileId: "F1", driveFolderId: null, driveModifiedTime: null, lastPulledAt: null, lastPushedAt: null },
      origin: "my", dirty: false, updatedAt: t
    };

    window.__shareCalls = 0;

    let state = {
      lists: [doc], activeListId: "L1", activeDoc: doc,
      selectedCategoryId: "c_root", activeTab: "my",
      auth: { isSignedIn }, shoppingFolderId: null,
      conflict: { pending: false, remoteDoc: null },
      actions: { deleteList: async () => {} }
    };

    const ui = createUI({
      getState: () => state,
      setState: s => { state = s; },
      persistActiveDoc: async () => {},
      onSync: async () => {},
      onImport: async () => {},
      onShare: async () => { window.__shareCalls++; },
      onResolveConflict: async () => {}
    });

    window.__ui = ui;
    ui.render();
  }, signedIn);
}

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (e) { results.push(`FAIL  ${name} — ${e.message}`); process.exitCode = 1; }
};

await mount(true);

await check("the Share button is enabled while signed in", async () => {
  assert.equal(await page.isVisible("#btnShare"), true);
  assert.equal(await page.isDisabled("#btnShare"), false);
});

await check("clicking Share reaches onShare", async () => {
  await page.click("#btnShare");
  await page.waitForFunction(() => window.__shareCalls > 0, null, { timeout: 2000 });
  assert.equal(await page.evaluate(() => window.__shareCalls), 1);
});

await check("each click is one call — the handler is bound once", async () => {
  await page.click("#btnShare");
  await page.waitForFunction(() => window.__shareCalls > 1, null, { timeout: 2000 });
  assert.equal(await page.evaluate(() => window.__shareCalls), 2);
});

// A signed-out session has nothing to share with: Drive is where the link comes
// from. The button stays disabled, and a click must not reach the action.
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(800);
await mount(false);

await check("the Share button is disabled while signed out", async () => {
  assert.equal(await page.isDisabled("#btnShare"), true);
});

await check("a disabled Share button does not reach onShare", async () => {
  await page.click("#btnShare", { force: true }).catch(() => {});
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__shareCalls), 0);
});

console.log(results.join("\n"));
await browser.close();
