// Drives the grouped items outline through the real createUI(), the way
// staleness.mjs does: a hand-made state object rather than a booted app, so the
// category tree and the items panel can be exercised without Drive or IndexedDB.
//
// The pure outline logic (depths, counts, empty-section rules, orphans) is
// covered by `node --test js/tree.test.mjs`. What is proved here is everything
// that only exists in the DOM: folding, the inline add row surviving a
// re-render, the overflow menu, and the staleness guard on the add handler.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const URL = process.env.HARNESS_URL;
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
page.on("pageerror", e => { console.error("PAGE ERROR:", e.message); process.exitCode = 1; });
await page.goto(URL, { waitUntil: "load" });
await page.waitForTimeout(800);

/**
 * Fresh UI over a tree deep enough to matter, containing every edge case the
 * design argues about: an empty category, a long name, and an orphan item.
 */
async function setup(mode = "shopping", selectedCategoryId = "c_ali"){
  // Reload first. collapsedCategoryIds and collapsedSectionIds are module-level
  // in ui.js — deliberately, so a fold survives a re-render — which means a new
  // createUI() over the cached module would inherit the previous check's folds.
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

    window.__mkDoc = (listId = "L1") => ({
      schemaVersion: 1, listId, title: "Groceries", mode,
      ui: { hideChecked: false },
      categories: [
        cat("c_root", "All", null, 0),
        cat("c_long", "Entretien ménager", "c_root", 0),
        cat("c_ali", "Alimentation", "c_root", 1),
        cat("c_fru", "Fruits & Légumes", "c_ali", 0),
        cat("c_bio", "Bio", "c_fru", 0),
        cat("c_poi", "Poissons", "c_ali", 1),
        cat("c_sur", "Surgelés", "c_ali", 2)
      ],
      items: [
        item("i_les", "Lessive", "c_long"),
        item("i_sel", "Sel", "c_ali"),
        item("i_pom", "Pommes", "c_fru"),
        item("i_car", "Carottes", "c_fru"),
        item("i_ban", "Bananes", "c_fru", true),
        item("i_tom", "Tomates bio", "c_bio"),
        item("i_sau", "Saumon", "c_poi"),
        item("i_pil", "Piles AA", "c_disparu")      // category deleted elsewhere
      ],
      sync: { driveFileId: "F1", driveFolderId: null, driveModifiedTime: null, lastPulledAt: null, lastPushedAt: null },
      origin: "my", dirty: false, updatedAt: t
    });

    const doc = window.__mkDoc();
    window.__staleDoc = doc;
    window.__persisted = 0;

    let state = {
      lists: [doc], activeListId: "L1", activeDoc: doc,
      selectedCategoryId, activeTab: "my",
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
      onExport: async () => {},
      onImportFile: async () => {},
      onResolveConflict: async () => {}
    });
    window.__ui = ui;
    ui.render();
  }, { mode, selectedCategoryId });
}

const live  = () => page.evaluate(() => window.__getState().activeDoc);
const stale = () => page.evaluate(() => window.__staleDoc);

/** Labels currently rendered in the items panel, top to bottom. */
const labels = () => page.$$eval("#itemsContainer .item .label", els => els.map(e => e.textContent));
/** Section ids currently rendered, top to bottom. */
const sections = () => page.$$eval("#itemsContainer .sec", els => els.map(e => e.dataset.section));

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (e) { results.push(`FAIL  ${name} — ${e.message}`); process.exitCode = 1; }
};

// ---------------------------------------------------------------------------

await check("selecting a category shows its descendants, not just its own items", async () => {
  await setup("shopping", "c_ali");

  const shown = await labels();
  assert.ok(shown.includes("Sel"), "the category's own item is missing");
  assert.ok(shown.includes("Pommes"), "a child category's item is missing — this is the bug");
  assert.ok(shown.includes("Tomates bio"), "a grandchild's item is missing");
  assert.ok(shown.includes("Saumon"), "a sibling subcategory's item is missing");
  assert.ok(!shown.includes("Lessive"), "an item from outside the scope leaked in");
});

await check("the panel header names the scope and counts the whole subtree", async () => {
  await setup("shopping", "c_ali");

  assert.match(await page.textContent("#itemsTitle"), /Alimentation/);
  assert.equal(await page.textContent("#itemsCount"), "6");
});

await check("an empty section is hidden while shopping and shown while editing", async () => {
  await setup("shopping", "c_ali");
  assert.ok(!(await sections()).includes("c_sur"), "Surgelés showed while shopping");

  await setup("edit", "c_ali");
  assert.ok((await sections()).includes("c_sur"), "Surgelés was missing in edit mode");
});

await check("a section folds and unfolds, and the count stays put", async () => {
  await setup("shopping", "c_ali");

  await page.click('[data-section="c_fru"]');
  let shown = await labels();
  assert.ok(!shown.includes("Pommes"), "folding did not hide the section's items");
  assert.ok(!shown.includes("Tomates bio"), "folding did not hide the nested section");
  assert.ok(shown.includes("Saumon"), "folding one section hid another");
  assert.equal(await page.textContent("#itemsCount"), "6", "folding changed the total");

  await page.click('[data-section="c_fru"]');
  shown = await labels();
  assert.ok(shown.includes("Pommes"), "unfolding did not restore the items");
});

await check("folding survives an unrelated re-render", async () => {
  await setup("shopping", "c_ali");

  await page.click('[data-section="c_fru"]');
  await page.evaluate(() => window.__ui.render());

  assert.ok(!(await labels()).includes("Pommes"), "the fold was lost on re-render");
});

await check("tree folding and section folding do not interfere", async () => {
  await setup("shopping", "c_ali");

  // Fold Alimentation in the tree — navigation only.
  await page.click('.node:has-text("Alimentation") .twisty');

  assert.ok((await labels()).includes("Pommes"),
    "folding the tree branch emptied the items panel");
});

await check("the section ➕ files the item into that subcategory, not the scope", async () => {
  await setup("shopping", "c_ali");

  await page.click('[data-section="c_poi"] .sec-add');
  await page.waitForSelector("[data-add-input='1']");
  await page.fill("[data-add-input='1']", "Cabillaud");
  await page.press("[data-add-input='1']", "Enter");
  await page.waitForTimeout(150);

  const doc = await live();
  const added = doc.items.find(i => i.label === "Cabillaud");
  assert.ok(added, "the item was not added");
  assert.equal(added.categoryId, "c_poi", "the item landed in the wrong category");
});

await check("Enter clears the row but leaves it open for the next item", async () => {
  await setup("shopping", "c_ali");

  await page.click('[data-section="c_poi"] .sec-add');
  await page.fill("[data-add-input='1']", "Cabillaud");
  await page.press("[data-add-input='1']", "Enter");
  await page.waitForTimeout(150);

  const input = await page.$("[data-add-input='1']");
  assert.ok(input, "the add row closed after one item");
  assert.equal(await input.inputValue(), "", "the add row kept the text it just filed");
  assert.ok(await page.evaluate(() =>
    document.activeElement?.dataset?.addInput === "1"), "focus left the add row");
});

await check("an open add row keeps its text across a re-render", async () => {
  await setup("shopping", "c_ali");

  await page.click('[data-section="c_poi"] .sec-add');
  await page.fill("[data-add-input='1']", "Bar de ligne");
  await page.evaluate(() => window.__ui.render());

  assert.equal(await page.inputValue("[data-add-input='1']"), "Bar de ligne",
    "the draft was destroyed by the re-render");
});

await check("Escape closes the add row without adding", async () => {
  await setup("shopping", "c_ali");

  await page.click('[data-section="c_poi"] .sec-add');
  await page.fill("[data-add-input='1']", "Truite");
  await page.press("[data-add-input='1']", "Escape");
  await page.waitForTimeout(100);

  assert.equal(await page.$("[data-add-input='1']"), null, "the add row stayed open");
  const doc = await live();
  assert.ok(!doc.items.some(i => i.label === "Truite"), "Escape added the item anyway");
});

await check("adding into a folded section unfolds it, so the item is visible", async () => {
  await setup("shopping", "c_ali");

  await page.click('[data-section="c_poi"]');                 // fold it
  assert.ok(!(await labels()).includes("Saumon"), "precondition: section was not folded");

  await page.click('[data-section="c_poi"] .sec-add');
  await page.fill("[data-add-input='1']", "Cabillaud");
  await page.press("[data-add-input='1']", "Enter");
  await page.waitForTimeout(150);

  assert.ok((await labels()).includes("Cabillaud"), "the new item landed out of sight");
});

await check("the poller swapping the doc mid-add stops the row writing to a detached doc", async () => {
  await setup("shopping", "c_ali");

  await page.click('[data-section="c_poi"] .sec-add');
  await page.fill("[data-add-input='1']", "Cabillaud");

  // persistActiveDoc resolves on a microtask; swap the doc as the handler awaits.
  await page.evaluate(() => {
    const original = window.__getState().activeDoc;
    window.__staleDoc = original;
    queueMicrotask(() => window.__setActiveDoc(window.__mkDoc("L2")));
  });
  await page.press("[data-add-input='1']", "Enter");
  await page.waitForTimeout(200);

  assert.equal(await page.$("[data-add-input='1']"), null,
    "the add row stayed open over a list the user had left");
});

await check("Uncategorized surfaces an item whose category was deleted elsewhere", async () => {
  await setup("shopping", "c_root");

  assert.ok((await sections()).includes("__orphans"), "no Uncategorized section at root scope");
  assert.ok((await labels()).includes("Piles AA"), "the orphan item was not rendered");
});

await check("Uncategorized offers no add button — it is not a real category", async () => {
  await setup("shopping", "c_root");

  assert.equal(await page.$('[data-section="__orphans"] .sec-add'), null,
    "the orphan section offered an add button");
});

await check("the ⋯ menu opens with the category actions", async () => {
  await setup("shopping", "c_ali");

  await page.click('.node:has-text("Poissons") [data-menu="1"]');
  await page.waitForSelector(".menu");

  const entries = await page.$$eval(".menu button", els => els.map(e => e.textContent));
  assert.deepEqual(entries, ["Add subcategory", "Rename", "Delete"]);
});

await check("the root offers only Add subcategory — it cannot be renamed or deleted", async () => {
  await setup("shopping", "c_ali");

  await page.click('.node:has-text("All") [data-menu="1"]');
  await page.waitForSelector(".menu");

  const entries = await page.$$eval(".menu button", els => els.map(e => e.textContent));
  assert.deepEqual(entries, ["Add subcategory"]);
});

await check("Rename from the menu reaches the modal layer and renames the category", async () => {
  await setup("shopping", "c_ali");

  await page.click('.node:has-text("Poissons") [data-menu="1"]');
  await page.click('.menu button:has-text("Rename")');
  await page.waitForSelector(".modal-overlay");

  await page.fill(".modal-body input", "Poissons & fruits de mer");
  await page.click(".modal-footer .btn-primary");
  await page.waitForSelector(".modal-overlay", { state: "detached" });

  const doc = await live();
  assert.equal(doc.categories.find(c => c.id === "c_poi").name, "Poissons & fruits de mer");
});

await check("Delete from the menu asks first, and dismissing changes nothing", async () => {
  await setup("shopping", "c_ali");

  await page.click('.node:has-text("Poissons") [data-menu="1"]');
  await page.click('.menu button:has-text("Delete")');
  await page.waitForSelector(".modal-overlay");

  await page.keyboard.press("Escape");
  await page.waitForSelector(".modal-overlay", { state: "detached" });

  const doc = await live();
  assert.equal(doc.categories.find(c => c.id === "c_poi").deletedAt, null,
    "dismissing the confirm deleted the category anyway");
});

await check("Escape closes the menu and returns focus to its button", async () => {
  await setup("shopping", "c_ali");

  await page.click('.node:has-text("Poissons") [data-menu="1"]');
  await page.waitForSelector(".menu");
  await page.keyboard.press("Escape");

  assert.equal(await page.$(".menu"), null, "the menu stayed open");
  assert.ok(await page.evaluate(() =>
    document.activeElement?.dataset?.menu === "1"), "focus was not restored to the button");
});

await check("a realistic category name is no longer clipped in the tree", async () => {
  await setup("shopping", "c_root");

  // The name from the original screenshot, which rendered as "Entretien m...".
  const clipped = await page.$eval(
    '.node:has-text("Entretien ménager") .name',
    el => el.scrollWidth > el.clientWidth + 1
  );
  assert.ok(!clipped, "the category name is still truncated");
});

await check("the tree's action column no longer eats half the row", async () => {
  await setup("shopping", "c_root");

  // It was capped at max-width:50% and wrapped onto a second line; one button
  // on one line should now cost a small fraction of the row. Any name can be
  // made long enough to ellipsis, so the row budget is what is worth asserting.
  const { actionShare, stacked } = await page.$eval(
    '.node:has-text("Entretien ménager")',
    el => {
      const a = el.querySelector(".actions").getBoundingClientRect();
      const l = el.querySelector(".left").getBoundingClientRect();
      return {
        actionShare: a.width / el.getBoundingClientRect().width,
        stacked: a.top >= l.bottom || l.top >= a.bottom   // side by side, not wrapped
      };
    }
  );
  assert.ok(actionShare < 0.25, `actions still take ${Math.round(actionShare * 100)}% of the row`);
  assert.ok(!stacked, "the actions wrapped below the name instead of sitting beside it");
});

await check("hide-checked shrinks the counts to what is on screen", async () => {
  await setup("shopping", "c_ali");
  assert.equal(await page.textContent('[data-section="c_fru"] .sec-count'), "4");

  await page.check("#toggleHideChecked");
  await page.waitForTimeout(150);

  assert.equal(await page.textContent('[data-section="c_fru"] .sec-count'), "3",
    "the count still includes checked items");
  assert.ok(!(await labels()).includes("Bananes"), "a checked item stayed on screen");
});

console.log(results.join("\n"));
await browser.close();
