// Run with:  node --test js/precache.test.mjs
//
// sw.js precaches a hand-written file list. A module missing from it still
// loads online, and usually offline too in a browser that kept it in its HTTP
// cache, so no browser check reliably notices. Then the cache is evicted and
// the app dies in a shop. This reads the list and the directory and compares.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);
const sw = readFileSync(new URL("sw.js", root), "utf8");

const listed = new Set(
  [...sw.match(/const PRECACHE = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map(m => m[1])
);

test("every app module is precached", () => {
  const modules = readdirSync(new URL("js/", root))
    .filter(f => f.endsWith(".js"))
    .map(f => `./js/${f}`);

  const missing = modules.filter(m => !listed.has(m));
  assert.deepEqual(missing, [], `add these to PRECACHE in sw.js and bump VERSION`);
});

test("every precached file exists", () => {
  const files = [...listed].filter(p => p !== "./");
  const absent = files.filter(p => {
    try{ readFileSync(new URL(p, root)); return false; }
    catch{ return true; }
  });
  assert.deepEqual(absent, []);
});
