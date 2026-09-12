// Loads the real app and fails on any uncaught page error. Sign-in cannot be
// exercised headlessly, but the auth gate rendering proves the whole module
// graph (including modal.js) parsed and ran.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const URL = process.env.HARNESS_URL;
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();

const errors = [];
const badResponses = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message));
page.on("response", r => { if(r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`); });
page.on("requestfailed", r => badResponses.push(`failed ${r.url()}`));

await page.goto(URL, { waitUntil: "load" });
await page.waitForTimeout(1500);

const results = [];
try{
  assert.equal(await page.isVisible("#authGate"), true, "#authGate not visible");
  results.push("PASS  app boots and shows the auth gate");
}catch(e){
  results.push("FAIL  app boots and shows the auth gate — " + e.message);
  process.exitCode = 1;
}

try{
  assert.equal(errors.length, 0, errors.join(" | "));
  results.push("PASS  no uncaught page errors");
}catch(e){
  results.push("FAIL  no uncaught page errors — " + e.message);
  process.exitCode = 1;
}

// Anything the page asked for and did not get. Google Identity Services is
// expected to be unreachable in this environment; a missing local file is not.
const localBad = badResponses.filter(u => u.includes("localhost") && !u.includes("favicon"));
console.log("network problems seen:", badResponses.length ? badResponses.join("\n  ") : "none");
try{
  assert.deepEqual(localBad, [], "local resources failed to load");
  results.push("PASS  every local resource loaded");
}catch(e){
  results.push("FAIL  every local resource loaded — " + e.message);
  process.exitCode = 1;
}

// modal.js must be part of the loaded graph.
try{
  const ok = await page.evaluate(async () => {
    const m = await import("./js/modal.js");
    return typeof m.showConfirm === "function" && typeof m.showChoice === "function";
  });
  assert.equal(ok, true, "modal.js did not expose its API");
  results.push("PASS  modal.js loads inside the app page");
}catch(e){
  results.push("FAIL  modal.js loads inside the app page — " + e.message);
  process.exitCode = 1;
}

console.log(results.join("\n"));
await browser.close();
