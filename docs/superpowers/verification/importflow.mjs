// Drives the real import/export UI in a browser: the file picker, the
// replace-or-new dialog, the reset-checked option, and the replace confirm.
// Drive calls are stubbed, since sign-in cannot happen headlessly.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const URL = process.env.HARNESS_URL;
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
page.on("pageerror", e => { console.error("PAGE ERROR:", e.message); process.exitCode = 1; });

// An export file produced by transfer.serializeDoc, written to disk so the
// real <input type="file"> can be used.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "importflow-"));
const payload = {
  app: "shopping-spa", schemaVersion: 1, exportedAt: 1,
  title: "Weekend BBQ", mode: "shopping", ui: { hideChecked: false },
  categories: [
    { id: "c_root", name: "All", parentId: null, order: 0 },
    { id: "c_a", name: "Meat", parentId: "c_root", order: 0 }
  ],
  items: [
    { id: "s1", label: "Sausages", qty: 12, unit: null, categoryId: "c_a", checked: true },
    { id: "s2", label: "Charcoal", qty: 1, unit: "bag", categoryId: "c_root", checked: false }
  ]
};
const goodFile = path.join(tmp, "weekend-bbq.json");
fs.writeFileSync(goodFile, JSON.stringify(payload));

const brokenFile = path.join(tmp, "broken.json");
fs.writeFileSync(brokenFile, "{ this is not json");

const wrongFile = path.join(tmp, "wrong.json");
fs.writeFileSync(wrongFile, JSON.stringify({ hello: "world" }));

// The app's state is private to app.js, so the fakes have to be in place before
// it boots. Serve stub modules in place of the storage and Drive layers; the
// import/export code under test is untouched.
const STUB_DB = `
const T = 1000;
globalThis.__lists = [{
  schemaVersion: 1, listId: "L1", title: "Groceries", mode: "shopping",
  ui: { hideChecked: false },
  categories: [{ id: "c_root", name: "All", parentId: null, order: 0, updatedAt: T, deletedAt: null }],
  items: [
    { id: "i1", label: "Milk",  qty: null, unit: null, categoryId: "c_root", checked: false, updatedAt: T, deletedAt: null },
    { id: "i2", label: "Bread", qty: null, unit: null, categoryId: "c_root", checked: false, updatedAt: T, deletedAt: null }
  ],
  sync: { driveFileId: "F1", driveFolderId: "FOLDER", driveModifiedTime: null, lastPulledAt: null, lastPushedAt: null },
  origin: "my", dirty: false, updatedAt: T
}];
globalThis.__saved = [];

export const DB = {
  async getAllLists(){ return globalThis.__lists; },
  async getList(id){ return globalThis.__lists.find(l => l.listId === id) || null; },
  async putList(doc){
    globalThis.__saved.push(JSON.parse(JSON.stringify(doc)));
    const i = globalThis.__lists.findIndex(l => l.listId === doc.listId);
    if(i === -1) globalThis.__lists.push(doc); else globalThis.__lists[i] = doc;
    return doc;
  },
  async deleteList(id){ globalThis.__lists = globalThis.__lists.filter(l => l.listId !== id); },
  async getSetting(){ return null; },
  async setSetting(){}
};
`;

const STUB_DRIVE_SYNC = `
export const DriveSync = {
  async ensureShoppingFolder(){ return "FOLDER"; },
  async ensureMyListFile(doc){
    doc.sync.driveFileId = "NEWFILE";
    doc.sync.driveFolderId = "FOLDER";
    return doc;
  },
  async listFolderListFiles(){ return []; },
  async pullFileToDoc(){ throw new Error("not used"); },
  async syncDetectConflict(doc){ return { status: "noop", doc }; },
  async importSharedByFileId(){ throw new Error("not used"); },
  async resolveConflict(doc){ return doc; }
};
`;

const STUB_DRIVE_AUTH = `
export const DriveAuth = {
  async init(){},
  isSignedIn(){ return true; },
  async signInInteractive(){},
  async signOut(){},
  getToken(){ return "token"; }
};
`;

const serveStub = (body) => (route) =>
  route.fulfill({ status: 200, contentType: "text/javascript", body });

await page.route("**/js/db.js", serveStub(STUB_DB));
await page.route("**/js/driveSync.js", serveStub(STUB_DRIVE_SYNC));
await page.route("**/js/driveAuth.js", serveStub(STUB_DRIVE_AUTH));

await page.goto(URL, { waitUntil: "load" });
await page.waitForTimeout(800);

async function setup(){
  await page.evaluate(() => {
    document.getElementById("authGate").classList.remove("show");
  });
}

// Each import mutates the app's list set and changes which list is active, so
// checks that care about the active list start from a fresh load.
async function reload(){
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForTimeout(600);
  await setup();
}

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (e) { results.push(`FAIL  ${name} — ${e.message}`); process.exitCode = 1; }
};

await setup();

await check("a malformed file is refused with a readable message", async () => {
  await page.setInputFiles("#importFileInput", brokenFile);
  await page.waitForSelector(".modal-overlay");
  assert.equal(await page.textContent(".modal-title"), "Import failed");
  assert.match(await page.textContent(".modal-body"), /not a valid JSON file/i);
  await page.click(".modal-footer .btn-primary");
  await page.waitForSelector(".modal-overlay", { state: "detached" });
});

await check("JSON that is not a list export is refused", async () => {
  await page.setInputFiles("#importFileInput", wrongFile);
  await page.waitForSelector(".modal-overlay");
  assert.match(await page.textContent(".modal-body"), /not a shopping list export/i);
  await page.click(".modal-footer .btn-primary");
  await page.waitForSelector(".modal-overlay", { state: "detached" });
});

await check("a valid file offers Replace, Create new and Cancel", async () => {
  await page.setInputFiles("#importFileInput", goodFile);
  await page.waitForSelector(".modal-overlay");

  assert.equal(await page.textContent(".modal-title"), "Import list");
  assert.match(await page.textContent(".modal-body"), /Weekend BBQ.*2 item/s);

  const labels = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".modal-footer .btn")).map(b => b.textContent));
  assert.deepEqual(labels, ['Cancel', 'Replace "Groceries" (2)', "Create a new list"]);
});

await check("the reset-checked option appears because the file has ticked items", async () => {
  assert.equal(await page.isVisible("#importResetChecked"), true);
});

await check("Cancel imports nothing", async () => {
  const before = await page.evaluate(() => window.__saved.length);
  await page.click(".modal-footer .btn-ghost");
  await page.waitForSelector(".modal-overlay", { state: "detached" });
  assert.equal(await page.evaluate(() => window.__saved.length), before);
});

await check("Create a new list keeps the ticked item and gets its own Drive file", async () => {
  await page.evaluate(() => { window.__saved = []; });
  await page.setInputFiles("#importFileInput", goodFile);
  await page.waitForSelector(".modal-overlay");
  await page.click(".modal-footer .btn-primary");           // Create a new list
  await page.waitForSelector(".modal-overlay", { state: "detached" });
  await page.waitForFunction(() => window.__saved.length > 0);

  const saved = (await page.evaluate(() => window.__saved)).at(-1);
  assert.equal(saved.title, "Weekend BBQ");
  assert.notEqual(saved.listId, "L1", "overwrote the existing list");
  assert.equal(saved.sync.driveFileId, "NEWFILE", "did not get its own Drive file");
  assert.equal(saved.items.length, 2);
  assert.equal(saved.items.find(i => i.label === "Sausages").checked, true);
});

await check("ticking 'start unchecked' clears the checked state", async () => {
  await page.evaluate(() => { window.__saved = []; });
  await page.setInputFiles("#importFileInput", goodFile);
  await page.waitForSelector(".modal-overlay");
  await page.check("#importResetChecked");
  await page.click(".modal-footer .btn-primary");
  await page.waitForSelector(".modal-overlay", { state: "detached" });
  await page.waitForFunction(() => window.__saved.length > 0);

  const saved = (await page.evaluate(() => window.__saved)).at(-1);
  assert.ok(saved.items.every(i => i.checked === false), "an item stayed ticked");
});

await check("Replace asks a second time before destroying anything", async () => {
  await page.evaluate(() => { window.__saved = []; });
  await page.setInputFiles("#importFileInput", goodFile);
  await page.waitForSelector(".modal-overlay");
  await page.click('.modal-footer .btn-danger');            // Replace
  await page.waitForFunction(() =>
    document.querySelector(".modal-title")?.textContent === "Replace list");

  assert.match(await page.textContent(".modal-body"), /cannot be undone/i);

  await page.click(".modal-footer .btn-ghost");             // Cancel the confirm
  await page.waitForSelector(".modal-overlay", { state: "detached" });
  assert.equal(await page.evaluate(() => window.__saved.length), 0, "wrote despite cancelling");
});

await check("confirming Replace tombstones the old items and keeps the Drive file", async () => {
  await reload();
  await page.evaluate(() => { window.__saved = []; });
  await page.setInputFiles("#importFileInput", goodFile);
  await page.waitForSelector(".modal-overlay");
  await page.click('.modal-footer .btn-danger');            // Replace
  await page.waitForFunction(() =>
    document.querySelector(".modal-title")?.textContent === "Replace list");
  await page.click(".modal-footer .btn-danger");            // Confirm
  await page.waitForSelector(".modal-overlay", { state: "detached" });
  await page.waitForFunction(() => window.__saved.length > 0);

  const saved = (await page.evaluate(() => window.__saved)).at(-1);
  assert.equal(saved.listId, "L1", "the list changed identity");
  assert.equal(saved.sync.driveFileId, "F1", "lost its Drive binding");
  assert.equal(saved.title, "Weekend BBQ");
  assert.equal(saved.dirty, true);

  for(const id of ["i1", "i2"]){
    const old = saved.items.find(i => i.id === id);
    assert.ok(old, `item ${id} was dropped instead of tombstoned`);
    assert.ok(old.deletedAt, `item ${id} was not tombstoned`);
  }
  const live = saved.items.filter(i => !i.deletedAt).map(i => i.label).sort();
  assert.deepEqual(live, ["Charcoal", "Sausages"]);
});

await check("a shared list cannot be replaced", async () => {
  await page.goto(URL, { waitUntil: "load" });
  await page.evaluate(() => { globalThis.__lists[0].origin = "shared"; });
  await page.waitForTimeout(600);
  await setup();

  await page.setInputFiles("#importFileInput", goodFile);
  await page.waitForSelector(".modal-overlay");

  const labels = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".modal-footer .btn")).map(b => b.textContent));
  assert.ok(!labels.some(l => l.startsWith("Replace")), "offered to replace a shared list");
  assert.match(await page.textContent(".modal-body"), /someone else's Drive/i);

  await page.click(".modal-footer .btn-ghost");
  await page.waitForSelector(".modal-overlay", { state: "detached" });
});

await check("Export downloads a dated, slugified json file", async () => {
  await reload();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#btnExport")
  ]);
  const name = download.suggestedFilename();
  assert.match(name, /^groceries-\d{4}-\d{2}-\d{2}\.json$/, `unexpected filename: ${name}`);

  const stream = await download.createReadStream();
  const text = await new Promise(res => {
    let b = ""; stream.on("data", c => b += c); stream.on("end", () => res(b));
  });
  const parsed = JSON.parse(text);
  assert.equal(parsed.app, "shopping-spa");
  assert.equal(parsed.sync, undefined, "the export leaked sync metadata");
  assert.ok(!text.includes("F1"), "the export leaked the Drive file id");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join("\n"));
await browser.close();
