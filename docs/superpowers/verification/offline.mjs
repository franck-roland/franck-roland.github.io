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
  assert.equal(await page.textContent(".list-card .name"), "Groceries");
  await context.close();
});

await check("structural editing is disabled offline, ticking is not", async () => {
  const { context, page } = await seeded();
  await page.reload();
  await page.click("#btnContinueOffline");
  await page.click(".list-card");

  for(const id of ["#btnNewList", "#btnImportFile", "#btnAddCategory",
                   "#btnAddItem", "#btnQuickAdd", "#newItemInput",
                   "#btnDeleteList", "#btnShare", "#modeEdit"]){
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

console.log(results.join("\n"));
await browser.close();
