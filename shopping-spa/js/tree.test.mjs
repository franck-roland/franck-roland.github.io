// Run with:  node --test js/tree.test.mjs
//
// buildItemsOutline is pure — no DOM, no IndexedDB, no Drive — so it is tested
// here rather than in a browser. The DOM-bound parts of the items view live in
// ui.js and are covered by the Playwright scripts under docs/superpowers/.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildItemsOutline } from "./tree.js";

const T = 1000;
let seq = 0;

function cat(id, name, parentId, order = 0){
  return { id, name, parentId, order, updatedAt: T, deletedAt: null };
}

function item(label, categoryId, over = {}){
  return {
    id: `i_${++seq}`, label, categoryId,
    qty: null, unit: null, checked: false,
    updatedAt: T, deletedAt: null, ...over
  };
}

/** A doc always has the root category; everything else is supplied per test. */
function makeDoc({ categories = [], items = [] } = {}){
  return { categories: [cat("c_root", "All", null, 0), ...categories], items };
}

/**
 * The tree the spec tabulates: Alimentation › Fruits › Bio, plus two siblings
 * and one empty category.
 */
function groceries(){
  return makeDoc({
    categories: [
      cat("c_ali", "Alimentation", "c_root", 0),
      cat("c_fru", "Fruits",       "c_ali",  0),
      cat("c_bio", "Bio",          "c_fru",  0),
      cat("c_poi", "Poissons",     "c_ali",  1),
      cat("c_sur", "Surgeles",     "c_ali",  2)
    ],
    items: [
      item("Sel",     "c_ali"),
      item("Pommes",  "c_fru"),
      item("Carottes","c_fru"),
      item("Tomates", "c_bio"),
      item("Saumon",  "c_poi")
    ]
  });
}

const sections     = out => out.rows.filter(r => r.kind === "section");
const sectionNames = out => sections(out).map(s => s.name);
const labels       = out => out.rows.filter(r => r.kind === "item").map(r => r.item.label);
const section      = (out, name) => sections(out).find(s => s.name === name);

const EDIT = { mode: "edit" };
const SHOP = { mode: "shopping" };

test("the scope root is the first row, and its own items sit one level in", () => {
  const doc = makeDoc({ items: [item("Milk", "c_root"), item("Bread", "c_root")] });

  const out = buildItemsOutline(doc, "c_root", EDIT);

  assert.equal(out.rows[0].kind, "section");
  assert.equal(out.rows[0].depth, 0);
  assert.deepEqual(out.rows.slice(1).map(r => r.kind), ["item", "item"]);
  assert.deepEqual(out.rows.slice(1).map(r => r.depth), [1, 1]);
});

test("three-level nesting produces the depths the spec tabulates", () => {
  const out = buildItemsOutline(groceries(), "c_ali", EDIT);

  assert.deepEqual(
    out.rows.map(r => [r.kind === "section" ? r.name : r.item.label, r.depth]),
    [
      ["Alimentation", 0],
      ["Sel",          1],
      ["Fruits",       1],
      ["Carottes",     2],
      ["Pommes",       2],
      ["Bio",          2],
      ["Tomates",      3],
      ["Poissons",     1],
      ["Saumon",       2],
      ["Surgeles",     1]
    ]
  );
});

test("a section's count covers its whole subtree, not just its own items", () => {
  const out = buildItemsOutline(groceries(), "c_ali", EDIT);

  // Pommes + Carottes, plus Tomates inside Bio.
  assert.equal(section(out, "Fruits").count, 3);
  assert.equal(section(out, "Bio").count, 1);
  assert.equal(section(out, "Alimentation").count, 5);
});

test("hideChecked shrinks counts to what is actually on screen", () => {
  const doc = groceries();
  doc.items.find(i => i.label === "Pommes").checked = true;

  const out = buildItemsOutline(doc, "c_ali", { mode: "edit", hideChecked: true });

  assert.equal(labels(out).includes("Pommes"), false);
  assert.equal(section(out, "Fruits").count, 2);
  assert.equal(out.total, 4);
});

test("a section whose items are all checked reads as empty under hideChecked", () => {
  const doc = groceries();
  doc.items.find(i => i.label === "Saumon").checked = true;

  const out = buildItemsOutline(doc, "c_ali", { mode: "edit", hideChecked: true });

  assert.equal(section(out, "Poissons").count, 0);
  assert.equal(section(out, "Poissons").empty, true);
});

test("shopping mode drops an empty section", () => {
  const out = buildItemsOutline(groceries(), "c_ali", SHOP);

  assert.equal(sectionNames(out).includes("Surgeles"), false);
});

test("shopping mode drops an empty section's whole subtree with it", () => {
  const doc = groceries();
  doc.categories.push(cat("c_gla", "Glaces", "c_sur", 0));   // empty child of an empty parent

  const out = buildItemsOutline(doc, "c_ali", SHOP);

  assert.equal(sectionNames(out).includes("Surgeles"), false);
  assert.equal(sectionNames(out).includes("Glaces"), false);
});

test("edit mode keeps an empty section, flagged and counting zero", () => {
  const out = buildItemsOutline(groceries(), "c_ali", EDIT);

  assert.equal(section(out, "Surgeles").count, 0);
  assert.equal(section(out, "Surgeles").empty, true);
});

test("the scope root renders even when it is empty, so the panel is never headless", () => {
  const doc = makeDoc({ categories: [cat("c_sur", "Surgeles", "c_root", 0)] });

  const out = buildItemsOutline(doc, "c_sur", SHOP);

  assert.deepEqual(sectionNames(out), ["Surgeles"]);
  assert.equal(out.total, 0);
});

test("a collapsed section keeps its count but emits none of its descendants", () => {
  const out = buildItemsOutline(groceries(), "c_ali", {
    mode: "edit",
    collapsed: new Set(["c_fru"])
  });

  assert.equal(section(out, "Fruits").collapsed, true);
  assert.equal(section(out, "Fruits").count, 3);
  assert.equal(sectionNames(out).includes("Bio"), false);
  assert.deepEqual(labels(out), ["Sel", "Saumon"]);
});

test("total ignores collapsing — folding a section hides rows, not items", () => {
  const open   = buildItemsOutline(groceries(), "c_ali", EDIT);
  const folded = buildItemsOutline(groceries(), "c_ali", {
    mode: "edit",
    collapsed: new Set(["c_fru"])
  });

  assert.equal(open.total, 5);
  assert.equal(folded.total, 5);
});

test("scoping to a mid-tree category excludes ancestors and siblings", () => {
  const out = buildItemsOutline(groceries(), "c_fru", EDIT);

  assert.deepEqual(sectionNames(out), ["Fruits", "Bio"]);
  assert.equal(labels(out).includes("Sel"), false);      // the parent's own item
  assert.equal(labels(out).includes("Saumon"), false);   // a sibling's item
});

test("an item whose category no longer exists surfaces under Uncategorized", () => {
  const doc = groceries();
  doc.items.push(item("Piles AA", "c_disparu"));

  const out = buildItemsOutline(doc, "c_root", SHOP);

  const orphans = section(out, "Uncategorized");
  assert.ok(orphans, "expected an Uncategorized section at root scope");
  assert.equal(orphans.count, 1);
  assert.equal(orphans.depth, 0);
  assert.equal(out.rows.at(-1).item.label, "Piles AA");
});

test("Uncategorized is omitted when there are no orphans", () => {
  const out = buildItemsOutline(groceries(), "c_root", SHOP);

  assert.equal(sectionNames(out).includes("Uncategorized"), false);
});

test("orphans stay out of a scope below the root — they belong to no category", () => {
  const doc = groceries();
  doc.items.push(item("Piles AA", "c_disparu"));

  const out = buildItemsOutline(doc, "c_ali", SHOP);

  assert.equal(sectionNames(out).includes("Uncategorized"), false);
  assert.equal(labels(out).includes("Piles AA"), false);
});

test("deleted items and deleted categories are excluded", () => {
  const doc = groceries();
  doc.items.find(i => i.label === "Carottes").deletedAt = T;
  doc.categories.find(c => c.id === "c_poi").deletedAt = T;

  const out = buildItemsOutline(doc, "c_ali", EDIT);

  assert.equal(labels(out).includes("Carottes"), false);
  assert.equal(sectionNames(out).includes("Poissons"), false);
  assert.equal(section(out, "Fruits").count, 2);
});

test("siblings follow their order field, not their position in the array", () => {
  const doc = makeDoc({
    categories: [
      cat("c_b", "Bravo",   "c_root", 2),
      cat("c_a", "Alpha",   "c_root", 0),
      cat("c_c", "Charlie", "c_root", 1)
    ],
    items: [item("x", "c_a"), item("y", "c_b"), item("z", "c_c")]
  });

  const out = buildItemsOutline(doc, "c_root", SHOP);

  assert.deepEqual(sectionNames(out), ["All", "Alpha", "Charlie", "Bravo"]);
});

test("within a section, unchecked items come first, then alphabetical", () => {
  const doc = makeDoc({
    items: [
      item("Pears",  "c_root", { checked: true }),
      item("Milk",   "c_root"),
      item("Apples", "c_root", { checked: true }),
      item("Bread",  "c_root")
    ]
  });

  const out = buildItemsOutline(doc, "c_root", SHOP);

  assert.deepEqual(labels(out), ["Bread", "Milk", "Apples", "Pears"]);
});

test("an unknown scope yields nothing rather than throwing", () => {
  const out = buildItemsOutline(groceries(), "c_nope", SHOP);

  assert.deepEqual(out.rows, []);
  assert.equal(out.total, 0);
});
