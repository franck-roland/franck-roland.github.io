// Exercises the refactored conflict dialog end-to-end against the real page:
// createUI() is instantiated with a fake state that has a pending conflict, the
// banner's Resolve button is clicked, and the dialog's choice is checked against
// what onResolveConflict receives.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const URL = process.env.HARNESS_URL;
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
page.on("pageerror", e => { console.error("PAGE ERROR:", e.message); process.exitCode = 1; });
await page.goto(URL, { waitUntil: "load" });
await page.waitForTimeout(800);

await page.evaluate(async () => {
  // We fake a signed-in state, so drop the mandatory sign-in overlay that would
  // otherwise sit on top of the page and swallow clicks.
  document.getElementById("authGate").classList.remove("show");

  const { createUI } = await import("./js/ui.js");

  const t = 1000;
  const mk = (over = {}) => ({
    schemaVersion: 1, listId: "L1", title: "Groceries", mode: "shopping",
    ui: { hideChecked: false },
    categories: [{ id: "c_root", name: "All", parentId: null, order: 0, updatedAt: t, deletedAt: null }],
    items: [
      { id: "i1", label: "Milk", qty: null, unit: null, categoryId: "c_root", checked: false, updatedAt: t, deletedAt: null },
      { id: "i2", label: "Bread", qty: null, unit: null, categoryId: "c_root", checked: true, updatedAt: t, deletedAt: null }
    ],
    sync: { driveFileId: "F1", driveFolderId: null, driveModifiedTime: null, lastPulledAt: null, lastPushedAt: null },
    origin: "my", dirty: false, updatedAt: t, ...over
  });

  const local = mk();
  const remote = mk({ title: "Groceries (phone)", updatedAt: t + 5 });
  remote.items[0].label = "Whole milk";
  remote.items[0].updatedAt = t + 5;

  window.__resolvedWith = undefined;

  let state = {
    lists: [local], activeListId: "L1", activeDoc: local,
    selectedCategoryId: "c_root", activeTab: "my",
    auth: { isSignedIn: true }, shoppingFolderId: null,
    conflict: { pending: true, remoteDoc: remote },
    actions: { deleteList: async () => {} }
  };

  const ui = createUI({
    getState: () => state,
    setState: s => { state = s; },
    persistActiveDoc: async () => {},
    onSync: async () => {},
    onImport: async () => {},
    onResolveConflict: async (strategy) => { window.__resolvedWith = strategy; }
  });

  window.__ui = ui;
  ui.render();
});

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (e) { results.push(`FAIL  ${name} — ${e.message}`); process.exitCode = 1; }
};

await check("conflict banner is visible when a conflict is pending", async () => {
  assert.equal(await page.isVisible("#conflictBanner"), true);
});

await check("Resolve opens a dialog carrying the diff summary", async () => {
  await page.click("#btnResolveConflict");
  await page.waitForSelector(".modal-overlay");
  assert.equal(await page.textContent(".modal-title"), "Resolve conflict");
  const pre = await page.textContent(".modal .diff-pre");
  assert.match(pre, /Title: local="Groceries" \| remote="Groceries \(phone\)"/);
  assert.match(pre, /Items: /);
});

await check("the three strategies are offered, Auto-merge primary and rightmost", async () => {
  const labels = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".modal-footer .btn")).map(b => b.textContent));
  assert.deepEqual(labels, ["Keep remote", "Keep mine", "Auto-merge"]);
  assert.equal(await page.evaluate(() =>
    document.querySelector(".modal-footer .btn-primary").textContent), "Auto-merge");
});

await check("dismissing resolves nothing", async () => {
  await page.keyboard.press("Escape");
  await page.waitForSelector(".modal-overlay", { state: "detached" });
  assert.equal(await page.evaluate(() => window.__resolvedWith), undefined);
});

await check("choosing Keep mine passes 'mine' to onResolveConflict", async () => {
  await page.click("#btnResolveConflict");
  await page.waitForSelector(".modal-overlay");
  await page.click(".modal-footer .btn:text-is('Keep mine')");
  await page.waitForFunction(() => window.__resolvedWith !== undefined);
  assert.equal(await page.evaluate(() => window.__resolvedWith), "mine");
});

await check("choosing Auto-merge passes 'merge'", async () => {
  await page.evaluate(() => { window.__resolvedWith = undefined; });
  await page.click("#btnResolveConflict");
  await page.waitForSelector(".modal-overlay");
  await page.click(".modal-footer .btn-primary");
  await page.waitForFunction(() => window.__resolvedWith !== undefined);
  assert.equal(await page.evaluate(() => window.__resolvedWith), "merge");
});

await check("no dialog is left behind", async () => {
  await page.waitForSelector(".modal-overlay", { state: "detached" });
  assert.equal(await page.evaluate(() => document.querySelectorAll(".modal-overlay").length), 0);
  assert.equal(await page.evaluate(() => document.body.classList.contains("modal-open")), false);
});

console.log(results.join("\n"));
await browser.close();
