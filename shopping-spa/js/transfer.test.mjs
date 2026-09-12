// Run with:  node --test js/transfer.test.mjs
//
// transfer.js is pure — no DOM, no IndexedDB, no Drive — so it is tested here
// rather than in a browser. The DOM-bound parts of import/export live in
// app.js and are covered by the Playwright scripts under docs/superpowers/.

import { test } from "node:test";
import assert from "node:assert/strict";

import { serializeDoc, parseImport, replaceDocContents, exportFilename } from "./transfer.js";

const T = 1000;

function makeDoc(over = {}){
  return {
    schemaVersion: 1,
    listId: "L1",
    title: "Groceries",
    mode: "shopping",
    ui: { hideChecked: false },
    categories: [
      { id: "c_root", name: "All",    parentId: null,     order: 0, updatedAt: T, deletedAt: null },
      { id: "c_1",    name: "Dairy",  parentId: "c_root", order: 0, updatedAt: T, deletedAt: null },
      { id: "c_2",    name: "Cheese", parentId: "c_1",    order: 0, updatedAt: T, deletedAt: null }
    ],
    items: [
      { id: "i1", label: "Milk",   qty: 2,    unit: "L", categoryId: "c_1",    checked: true,  updatedAt: T, deletedAt: null },
      { id: "i2", label: "Brie",   qty: null, unit: null, categoryId: "c_2",   checked: false, updatedAt: T, deletedAt: null },
      { id: "i3", label: "Apples", qty: 6,    unit: null, categoryId: "c_root", checked: false, updatedAt: T, deletedAt: null }
    ],
    sync: {
      driveFileId: "DRIVE_FILE_1",
      driveFolderId: "DRIVE_FOLDER_1",
      driveModifiedTime: "2026-09-01T00:00:00Z",
      lastPulledAt: T,
      lastPushedAt: T
    },
    origin: "my",
    dirty: false,
    updatedAt: T,
    ...over
  };
}

const roundTrip = (doc) => parseImport(JSON.stringify(serializeDoc(doc)));

// --- serializeDoc ---------------------------------------------------------

test("serializeDoc keeps the title, mode and ui", () => {
  const out = serializeDoc(makeDoc());
  assert.equal(out.title, "Groceries");
  assert.equal(out.mode, "shopping");
  assert.deepEqual(out.ui, { hideChecked: false });
});

test("serializeDoc keeps checked, qty and unit on items", () => {
  const out = serializeDoc(makeDoc());
  const milk = out.items.find(i => i.label === "Milk");
  assert.equal(milk.checked, true);
  assert.equal(milk.qty, 2);
  assert.equal(milk.unit, "L");
});

test("serializeDoc never leaks sync metadata, listId or origin", () => {
  const out = serializeDoc(makeDoc());
  assert.equal(out.sync, undefined);
  assert.equal(out.listId, undefined);
  assert.equal(out.origin, undefined);
  assert.equal(out.dirty, undefined);
  assert.ok(!JSON.stringify(out).includes("DRIVE_FILE_1"), "a Drive file id reached the export");
});

test("serializeDoc stamps the app name and an export time", () => {
  const out = serializeDoc(makeDoc());
  assert.equal(out.app, "shopping-spa");
  assert.equal(out.schemaVersion, 1);
  assert.equal(typeof out.exportedAt, "number");
});

test("serializeDoc drops entities that are already tombstoned", () => {
  const doc = makeDoc();
  doc.items[2].deletedAt = T;
  doc.categories[2].deletedAt = T;

  const out = serializeDoc(doc);
  assert.equal(out.items.length, 2, "a deleted item was exported");
  assert.equal(out.categories.length, 2, "a deleted category was exported");
  assert.ok(!out.items.some(i => i.label === "Apples"));
});

// --- parseImport: structure ----------------------------------------------

test("parseImport round-trips the category tree", () => {
  const doc = roundTrip(makeDoc());

  const dairy = doc.categories.find(c => c.name === "Dairy");
  const cheese = doc.categories.find(c => c.name === "Cheese");
  const root = doc.categories.find(c => c.id === "c_root");

  assert.ok(root, "c_root is missing");
  assert.equal(dairy.parentId, root.id);
  assert.equal(cheese.parentId, dairy.id, "nesting was flattened");
});

test("parseImport round-trips items with their category and checked state", () => {
  const doc = roundTrip(makeDoc());

  const dairy = doc.categories.find(c => c.name === "Dairy");
  const milk = doc.items.find(i => i.label === "Milk");

  assert.equal(milk.categoryId, dairy.id);
  assert.equal(milk.checked, true);
  assert.equal(milk.qty, 2);
  assert.equal(milk.unit, "L");
});

test("parseImport preserves sibling order", () => {
  const source = makeDoc();
  source.categories.push(
    { id: "c_3", name: "Bakery", parentId: "c_root", order: 2, updatedAt: T, deletedAt: null },
    { id: "c_4", name: "Frozen", parentId: "c_root", order: 1, updatedAt: T, deletedAt: null }
  );

  const doc = roundTrip(source);
  const root = doc.categories.find(c => c.id === "c_root");
  const names = doc.categories
    .filter(c => c.parentId === root.id)
    .sort((a, b) => a.order - b.order)
    .map(c => c.name);

  assert.deepEqual(names, ["Dairy", "Frozen", "Bakery"]);
});

// --- parseImport: identity ------------------------------------------------

test("parseImport gives the list a fresh listId every time", () => {
  const json = JSON.stringify(serializeDoc(makeDoc()));
  const a = parseImport(json);
  const b = parseImport(json);

  assert.ok(a.listId);
  assert.notEqual(a.listId, "L1", "kept the exporter's listId — would overwrite that list");
  assert.notEqual(a.listId, b.listId, "two imports collided on one listId");
});

test("parseImport regenerates every item and category id", () => {
  const doc = roundTrip(makeDoc());

  const oldCatIds = ["c_1", "c_2"];
  const oldItemIds = ["i1", "i2", "i3"];

  for(const c of doc.categories){
    if(c.id === "c_root") continue;
    assert.ok(!oldCatIds.includes(c.id), `category kept its source id: ${c.id}`);
  }
  for(const i of doc.items){
    assert.ok(!oldItemIds.includes(i.id), `item kept its source id: ${i.id}`);
  }
});

test("parseImport produces an unsynced, dirty list of my own", () => {
  const doc = roundTrip(makeDoc());

  assert.equal(doc.sync.driveFileId, null, "inherited the exporter's Drive file");
  assert.equal(doc.sync.driveFolderId, null);
  assert.equal(doc.origin, "my");
  assert.equal(doc.dirty, true);
});

// --- parseImport: robustness ---------------------------------------------

test("parseImport reparents orphaned categories to the root", () => {
  const payload = serializeDoc(makeDoc());
  payload.categories = payload.categories.filter(c => c.name !== "Dairy"); // orphans Cheese

  const doc = parseImport(JSON.stringify(payload));
  const cheese = doc.categories.find(c => c.name === "Cheese");

  assert.equal(cheese.parentId, "c_root", "an orphan would be invisible in the tree");
});

test("parseImport moves items in an unknown category to the root", () => {
  const payload = serializeDoc(makeDoc());
  payload.items.push({ label: "Ghost", qty: null, unit: null, categoryId: "nope", checked: false });

  const doc = parseImport(JSON.stringify(payload));
  const ghost = doc.items.find(i => i.label === "Ghost");

  assert.equal(ghost.categoryId, "c_root");
});

test("parseImport always provides a root category", () => {
  const payload = serializeDoc(makeDoc());
  payload.categories = [];

  const doc = parseImport(JSON.stringify(payload));
  assert.ok(doc.categories.some(c => c.id === "c_root"));
});

test("parseImport trims labels and drops empty ones", () => {
  const payload = serializeDoc(makeDoc());
  payload.items = [
    { label: "  Milk  ", qty: null, unit: null, categoryId: "c_root", checked: false },
    { label: "   ",      qty: null, unit: null, categoryId: "c_root", checked: false },
    { label: "",         qty: null, unit: null, categoryId: "c_root", checked: false }
  ];

  const doc = parseImport(JSON.stringify(payload));
  assert.equal(doc.items.length, 1);
  assert.equal(doc.items[0].label, "Milk");
});

test("parseImport coerces checked to a boolean and qty to a number or null", () => {
  const payload = serializeDoc(makeDoc());
  payload.items = [
    { label: "A", qty: "3",    unit: "kg", categoryId: "c_root", checked: "yes" },
    { label: "B", qty: "oops", unit: null, categoryId: "c_root", checked: 0 }
  ];

  const doc = parseImport(JSON.stringify(payload));
  const a = doc.items.find(i => i.label === "A");
  const b = doc.items.find(i => i.label === "B");

  assert.equal(a.checked, true);
  assert.equal(a.qty, 3);
  assert.equal(b.checked, false);
  assert.equal(b.qty, null);
});

test("parseImport falls back to a default title when none is usable", () => {
  const payload = serializeDoc(makeDoc());
  payload.title = "   ";
  const doc = parseImport(JSON.stringify(payload));
  assert.equal(doc.title, "Imported list");
});

test("parseImport rejects input that is not JSON", () => {
  assert.throws(() => parseImport("not json at all"), /not a valid JSON file/i);
});

test("parseImport rejects JSON that is not a shopping list", () => {
  assert.throws(() => parseImport(JSON.stringify({ hello: "world" })), /not a shopping list export/i);
});

test("parseImport rejects a schemaVersion it does not understand", () => {
  const payload = serializeDoc(makeDoc());
  payload.schemaVersion = 99;
  assert.throws(() => parseImport(JSON.stringify(payload)), /newer version/i);
});

test("parseImport rejects a payload whose items are not a list", () => {
  const payload = serializeDoc(makeDoc());
  payload.items = { nope: true };
  assert.throws(() => parseImport(JSON.stringify(payload)), /not a shopping list export/i);
});

test("parseImport can drop the checked state on request", () => {
  const payload = JSON.stringify(serializeDoc(makeDoc()));
  const doc = parseImport(payload, { resetChecked: true });
  assert.ok(doc.items.every(i => i.checked === false), "an item stayed ticked");
});

// --- replaceDocContents ---------------------------------------------------

test("replaceDocContents adopts the imported title", () => {
  const target = makeDoc();
  const imported = parseImport(JSON.stringify(serializeDoc(makeDoc({ title: "Weekend BBQ" }))));

  replaceDocContents(target, imported);
  assert.equal(target.title, "Weekend BBQ");
});

test("replaceDocContents keeps the list bound to its own Drive file", () => {
  const target = makeDoc();
  const imported = parseImport(JSON.stringify(serializeDoc(makeDoc())));

  replaceDocContents(target, imported);

  assert.equal(target.listId, "L1", "the list changed identity");
  assert.equal(target.sync.driveFileId, "DRIVE_FILE_1", "lost its Drive binding");
  assert.equal(target.origin, "my");
  assert.equal(target.dirty, true, "the replacement would never be pushed");
});

test("replaceDocContents tombstones the old entities instead of dropping them", () => {
  // mergeEntities in model.js is a union by id: an entity that is simply
  // absent locally comes back from the remote copy on the next sync. Only a
  // tombstone propagates a deletion.
  const target = makeDoc();
  const imported = parseImport(JSON.stringify(serializeDoc(makeDoc({ title: "Other" }))));

  replaceDocContents(target, imported);

  for(const id of ["i1", "i2", "i3"]){
    const old = target.items.find(i => i.id === id);
    assert.ok(old, `item ${id} was dropped rather than tombstoned — sync would resurrect it`);
    assert.ok(old.deletedAt, `item ${id} was not tombstoned`);
  }
  for(const id of ["c_1", "c_2"]){
    const old = target.categories.find(c => c.id === id);
    assert.ok(old, `category ${id} was dropped rather than tombstoned`);
    assert.ok(old.deletedAt, `category ${id} was not tombstoned`);
  }
});

test("replaceDocContents keeps the root category alive as the anchor", () => {
  const target = makeDoc();
  const imported = parseImport(JSON.stringify(serializeDoc(makeDoc())));

  replaceDocContents(target, imported);

  const root = target.categories.find(c => c.id === "c_root");
  assert.ok(root, "the root category vanished");
  assert.equal(root.deletedAt, null, "the root category was tombstoned");
});

test("replaceDocContents leaves exactly the imported entities live", () => {
  const source = makeDoc({ title: "Other" });
  source.items = [
    { id: "x1", label: "Rice",  qty: 1, unit: "kg", categoryId: "c_root", checked: false, updatedAt: T, deletedAt: null },
    { id: "x2", label: "Beans", qty: 2, unit: null, categoryId: "c_root", checked: true,  updatedAt: T, deletedAt: null }
  ];
  source.categories = [{ id: "c_root", name: "All", parentId: null, order: 0, updatedAt: T, deletedAt: null }];

  const target = makeDoc();
  replaceDocContents(target, parseImport(JSON.stringify(serializeDoc(source))));

  const live = target.items.filter(i => !i.deletedAt).map(i => i.label).sort();
  assert.deepEqual(live, ["Beans", "Rice"]);
});

test("replaceDocContents cannot collide the new entities with the tombstones", () => {
  const target = makeDoc();
  const imported = parseImport(JSON.stringify(serializeDoc(makeDoc())));

  replaceDocContents(target, imported);

  const ids = target.items.map(i => i.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate item ids after replace");

  const catIds = target.categories.map(c => c.id);
  assert.equal(new Set(catIds).size, catIds.length, "duplicate category ids after replace");
});

// --- exportFilename -------------------------------------------------------

const SEP_DAY = new Date(2026, 8, 12, 12, 0, 0); // 12 Sep 2026, local

test("exportFilename slugifies the title and stamps the date", () => {
  assert.equal(exportFilename({ title: "Groceries" }, SEP_DAY), "groceries-2026-09-12.json");
});

test("exportFilename folds accents and punctuation into a safe slug", () => {
  assert.equal(exportFilename({ title: "Courses d'été !" }, SEP_DAY), "courses-d-ete-2026-09-12.json");
});

test("exportFilename collapses runs of separators and trims them", () => {
  assert.equal(exportFilename({ title: "  Weekend // BBQ  " }, SEP_DAY), "weekend-bbq-2026-09-12.json");
});

test("exportFilename falls back when the title yields no usable characters", () => {
  assert.equal(exportFilename({ title: "***" }, SEP_DAY), "list-2026-09-12.json");
  assert.equal(exportFilename({ title: "" }, SEP_DAY), "list-2026-09-12.json");
});

test("exportFilename pads single-digit months and days", () => {
  assert.equal(exportFilename({ title: "x" }, new Date(2026, 0, 5, 12, 0, 0)), "x-2026-01-05.json");
});

test("exportFilename keeps the name short enough for any filesystem", () => {
  const name = exportFilename({ title: "a".repeat(300) }, SEP_DAY);
  assert.ok(name.length <= 80, `filename too long: ${name.length}`);
  assert.ok(name.endsWith("-2026-09-12.json"), "the date stamp was truncated away");
});

// --- replaceDocContents, continued ---------------------------------------

test("replaceDocContents bumps updatedAt so the merge prefers the replacement", () => {
  const target = makeDoc();
  const imported = parseImport(JSON.stringify(serializeDoc(makeDoc())));

  replaceDocContents(target, imported);

  const oldItem = target.items.find(i => i.id === "i1");
  assert.ok(oldItem.updatedAt > T, "the tombstone would lose to the remote copy");
  assert.ok(target.updatedAt > T);
});
