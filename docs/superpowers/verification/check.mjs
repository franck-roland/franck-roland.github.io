import { chromium } from "playwright";
import assert from "node:assert/strict";

const URL = process.env.HARNESS_URL;
// Drive the locally installed Google Chrome: Playwright's own bundled build is
// not cached at the version this package expects, and downloading one is not
// worth it for a check that runs outside the repo.
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
page.on("pageerror", e => { console.error("PAGE ERROR:", e.message); process.exitCode = 1; });
page.on("console", m => { if(m.type() === "error") console.error("CONSOLE ERROR:", m.text()); });
await page.goto(URL);
await page.waitForFunction(() => window.__ready);

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (e) { results.push(`FAIL  ${name} — ${e.message}`); process.exitCode = 1; }
};

await check("confirm resolves true on the danger button", async () => {
  const p = page.evaluate(() => window.showConfirm("Delete item?", { danger: true, confirmLabel: "Delete" }));
  await page.waitForSelector(".modal-overlay");
  await page.click(".modal-footer .btn-danger");
  assert.equal(await p, true);
});

await check("confirm resolves false on Cancel", async () => {
  const p = page.evaluate(() => window.showConfirm("Delete item?"));
  await page.waitForSelector(".modal-overlay");
  await page.click(".modal-footer .btn-ghost");
  assert.equal(await p, false);
});

await check("Escape dismisses and the app-level handler never fires", async () => {
  await page.evaluate(() => { window.__appEscapeFired = 0; });
  const p = page.evaluate(() => window.showConfirm("Delete item?"));
  await page.waitForSelector(".modal-overlay");
  await page.keyboard.press("Escape");
  assert.equal(await p, false);
  assert.equal(await page.evaluate(() => window.__appEscapeFired), 0, "app Escape handler fired");
});

await check("backdrop click dismisses, inner click does not", async () => {
  const p = page.evaluate(() => window.showPrompt("Item label:", { value: "Milk" }));
  await page.waitForSelector(".modal-overlay");
  await page.click(".modal-body");
  assert.equal(await page.isVisible(".modal-overlay"), true, "closed on an inner click");
  await page.click(".modal-overlay", { position: { x: 5, y: 5 } });
  assert.equal(await p, null);
});

await check("prompt returns the trimmed value, and null when emptied", async () => {
  let p = page.evaluate(() => window.showPrompt("Item label:", { value: "Milk" }));
  await page.waitForSelector(".modal-overlay");
  await page.fill(".modal input", "  Bread  ");
  await page.click(".modal-footer .btn-primary");
  assert.equal(await p, "Bread");

  p = page.evaluate(() => window.showPrompt("Item label:", { value: "Milk" }));
  await page.waitForSelector(".modal-overlay");
  await page.fill(".modal input", "   ");
  await page.click(".modal-footer .btn-primary");
  assert.equal(await p, null, "whitespace-only must behave like cancel");
});

await check("prompt submits on Enter and focuses its input", async () => {
  const p = page.evaluate(() => window.showPrompt("Category name?"));
  await page.waitForSelector(".modal-overlay");
  assert.equal(await page.evaluate(() => document.activeElement.tagName), "INPUT");
  await page.keyboard.type("Dairy");
  await page.keyboard.press("Enter");
  assert.equal(await p, "Dairy");
});

await check("focus is restored to the opener on close", async () => {
  await page.focus("#opener");
  const p = page.evaluate(() => window.showAlert("hi"));
  await page.waitForSelector(".modal-overlay");
  await page.keyboard.press("Escape");
  await p;
  assert.equal(await page.evaluate(() => document.activeElement.id), "opener");
});

await check("modals stack; Escape closes only the topmost", async () => {
  const outer = page.evaluate(() => window.showChoice({
    title: "Import", buttons: [{ label: "Replace", value: "replace", kind: "danger" }]
  }));
  await page.waitForSelector(".modal-overlay");
  const inner = page.evaluate(() => window.showConfirm("Really?", { danger: true }));
  await page.waitForFunction(() => document.querySelectorAll(".modal-overlay").length === 2);
  await page.keyboard.press("Escape");
  assert.equal(await inner, false);
  await page.waitForFunction(() => document.querySelectorAll(".modal-overlay").length === 1);
  await page.click(".modal-footer .btn-danger");
  assert.equal(await outer, "replace");
});

await check("scroll lock is released only when the last modal closes", async () => {
  const outer = page.evaluate(() => window.showAlert("outer"));
  await page.waitForSelector(".modal-overlay");
  const inner = page.evaluate(() => window.showAlert("inner"));
  await page.waitForFunction(() => document.querySelectorAll(".modal-overlay").length === 2);
  await page.keyboard.press("Escape"); await inner;
  assert.equal(await page.evaluate(() => document.body.classList.contains("modal-open")), true);
  await page.keyboard.press("Escape"); await outer;
  assert.equal(await page.evaluate(() => document.body.classList.contains("modal-open")), false);
});

await check("title and message are inserted as text, not HTML", async () => {
  const p = page.evaluate(() => window.showAlert("<img src=x onerror=window.__xss=1>", { title: "<b>t</b>" }));
  await page.waitForSelector(".modal-overlay");
  assert.equal(await page.evaluate(() => document.querySelector(".modal-title").innerHTML), "&lt;b&gt;t&lt;/b&gt;");
  assert.equal(await page.evaluate(() => document.querySelectorAll(".modal-body img").length), 0);
  await page.keyboard.press("Escape");
  await p;
});

await check("no modal is left in the DOM", async () => {
  assert.equal(await page.evaluate(() => document.querySelectorAll(".modal-overlay").length), 0);
});

console.log(results.join("\n"));
await browser.close();
