# Offline Shopping Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shopping list app load and work with no network — view your lists, tick items off, and have those ticks reach Drive when the connection returns.

**Architecture:** A service worker precaches the whole app shell so the page loads offline at all. A new `connectivity.js` module is the single source of truth for "is Drive reachable", fed both by `navigator.onLine` and by whether Drive calls actually succeed — the second matters more, because in a shop `navigator.onLine` is usually `true` while every request quietly hangs. The auth gate gains a "Continue offline" path, the UI renders read-only while offline, and the existing ten-second poller pushes pending ticks on recovery.

**Tech Stack:** Vanilla ES modules, no build step, zero runtime dependencies. IndexedDB for storage, Google Drive v3 for sync. Tests: `node --test` for pure logic, Playwright (installed outside the repo) for browser behaviour.

**Spec:** `docs/superpowers/specs/2026-09-12-offline-shopping-design.md`

## Global Constraints

- **Zero runtime dependencies and no build step.** The `shopping-spa/` directory must remain directly servable. Do not add `package.json`, a bundler, or any npm dependency to the repo.
  - `node --test` prints `[MODULE_TYPELESS_PACKAGE_JSON] Warning ... add "type": "module" to /Users/franck/package.json` for every `.js` module it loads. **This is pre-existing** — `tree.js` and `transfer.js` already do it — and it is the direct consequence of having no `package.json`. Ignore it. Do not "fix" it by adding one.
- **Browser floor:** Chrome 103+, Safari 16+, Firefox 100+ (required by `AbortSignal.timeout`).
- **All service worker paths are relative** (`./index.html`, never `/index.html`) — the app is served from `https://franck-roland.github.io/shopping-spa/` in production and `http://localhost:8765/` in verification.
- **`googleapis.com` and `accounts.google.com` are never intercepted or cached** by the service worker.
- **Offline scope is read-and-tick only.** Ticking items is allowed offline; every structural edit (add/rename/delete items and categories, list titles, creating lists, import, share) is disabled, not queued.
- **No OAuth popup may ever open unprompted.** Only the two sign-in button handlers may trigger interactive authentication.
- **Never mutate `doc.mode` to enforce offline read-only.** The stored mode is the user's choice and must survive. Compute an effective mode instead.
- Existing code style: two-space indent, double-quoted strings, `function` declarations over arrow consts at module level, comments that explain *why*.

## Deviation from the spec (accepted)

The spec describes `DriveAuth.ensureToken({ interactive })` with the poller and recovery push passing `interactive: false`. In implementation this collapses further: **`ensureToken()` becomes non-interactive unconditionally and the parameter is dropped.** The spec lists only the two sign-in button handlers as interactive callers, and those already call `DriveAuth.signInInteractive()` directly rather than going through `ensureToken()` — so no call site would ever pass `true`, and the parameter would be dead code. The spec's intent (no unprompted popup, ever) is fully preserved.

**Behaviour change this implies:** if your token expires while you are online and you tap `Sync now`, you now get a "sign in to sync" status instead of a re-auth popup. Tapping `Sign in` in the top bar recovers. This is deliberate and is the same trade the spec already accepted for the reconnect path.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `shopping-spa/js/connectivity.js` | Reachability state, failure backoff, `OfflineError`, error classification. The hinge every other change depends on. |
| `shopping-spa/js/connectivity.test.mjs` | `node --test` coverage for the above. |
| `shopping-spa/js/driveAuth.test.mjs` | `node --test` coverage for the pure token decision. |
| `shopping-spa/sw.js` | App shell precache. Cache-first, versioned. |
| `shopping-spa/manifest.webmanifest` | Installability. |
| `shopping-spa/icons/icon.svg` | Icon source, committed so the PNGs can be regenerated. |
| `shopping-spa/icons/icon-192.png`, `icon-512.png` | Manifest icons. |
| `docs/superpowers/verification/offline.mjs` | Playwright coverage of the offline behaviour. |

**Modified:**

| File | Change |
| --- | --- |
| `shopping-spa/js/driveAuth.js` | Pure `tokenDecision()`; `ensureToken()` stops prompting. |
| `shopping-spa/js/driveApi.js` | 8s timeout, reachability reporting, `OfflineError`. |
| `shopping-spa/js/app.js` | SW registration; gate third state; derived `state.offline`; poller guard; recovery push. |
| `shopping-spa/js/ui.js` | Read-only rendering; effective mode. |
| `shopping-spa/index.html` | Manifest link, Continue-offline button, offline banner. |
| `shopping-spa/styles.css` | `.offline` banner styling. |
| `docs/superpowers/verification/*.mjs` | `serviceWorkers: "block"` on all 7 existing scripts. |
| `docs/superpowers/verification/README.md` | New row, new run instructions, `VERSION` bump note. |

---

### Task 1: Connectivity module

The single source of truth for reachability. Pure enough to test entirely under `node --test` with an injected clock — no browser, no Playwright.

**Files:**
- Create: `shopping-spa/js/connectivity.js`
- Test: `shopping-spa/js/connectivity.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class OfflineError extends Error` — `name === "OfflineError"`.
  - `isNetworkError(err): boolean`
  - `createConnectivity({ nav, clock, setTimer, clearTimer, addListener }): { isOffline(), noteSuccess(), noteFailure(err), subscribe(fn) }` — `subscribe` returns an unsubscribe function; `fn` receives the new boolean.
  - `Connectivity` — a default singleton built from browser globals, which is what the app imports.

- [ ] **Step 1: Write the failing test**

Create `shopping-spa/js/connectivity.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectivity, isNetworkError, OfflineError } from "./connectivity.js";

/** A connectivity instance with a clock and timers we control. */
function harness({ onLine = true } = {}){
  const nav = { onLine };
  let now = 1_000_000;
  const timers = [];
  const listeners = new Map();

  const c = createConnectivity({
    nav,
    clock: () => now,
    setTimer: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length - 1; },
    clearTimer: (id) => { if(timers[id]) timers[id] = null; },
    addListener: (type, fn) => listeners.set(type, fn)
  });

  return {
    c, nav,
    advance(ms){
      now += ms;
      for(const t of timers){ if(t && t.at <= now){ const fn = t.fn; t.fn = null; fn?.(); } }
    },
    fire(type){ listeners.get(type)?.(); }
  };
}

test("online by default", () => {
  const { c } = harness();
  assert.equal(c.isOffline(), false);
});

test("navigator.onLine false means offline", () => {
  const { c } = harness({ onLine: false });
  assert.equal(c.isOffline(), true);
});

test("a network failure opens a 15s backoff", () => {
  const { c, advance } = harness();
  c.noteFailure(new TypeError("Failed to fetch"));
  assert.equal(c.isOffline(), true);
  advance(14_999);
  assert.equal(c.isOffline(), true, "still inside the backoff");
  advance(2);
  assert.equal(c.isOffline(), false, "backoff expired");
});

test("consecutive failures extend the backoff 15 -> 30 -> 60 and cap", () => {
  const { c, advance } = harness();
  c.noteFailure(new TypeError("x"));
  advance(15_001);

  c.noteFailure(new TypeError("x"));
  advance(15_001);
  assert.equal(c.isOffline(), true, "second failure should last 30s");
  advance(15_001);
  assert.equal(c.isOffline(), false);

  c.noteFailure(new TypeError("x"));
  advance(30_001);
  assert.equal(c.isOffline(), true, "third failure should last 60s");
  advance(30_001);
  assert.equal(c.isOffline(), false);

  c.noteFailure(new TypeError("x"));
  advance(60_001);
  assert.equal(c.isOffline(), false, "the ladder caps at 60s");
});

test("a success clears the backoff and resets the ladder", () => {
  const { c, advance } = harness();
  c.noteFailure(new TypeError("x"));
  c.noteFailure(new TypeError("x"));
  c.noteSuccess();
  assert.equal(c.isOffline(), false, "cleared immediately");

  c.noteFailure(new TypeError("x"));
  advance(15_001);
  assert.equal(c.isOffline(), false, "ladder restarted at 15s");
});

test("an HTTP-level error is not evidence of being offline", () => {
  const { c } = harness();
  c.noteFailure(new Error("Drive listFiles failed: 403"));
  assert.equal(c.isOffline(), false);
});

test("isNetworkError classifies by cause, not by message", () => {
  assert.equal(isNetworkError(new TypeError("Failed to fetch")), true);
  assert.equal(isNetworkError(Object.assign(new Error("t"), { name: "AbortError" })), true);
  assert.equal(isNetworkError(Object.assign(new Error("t"), { name: "TimeoutError" })), true);
  assert.equal(isNetworkError(new OfflineError()), true);
  assert.equal(isNetworkError(new Error("Drive getFileContent failed: 404")), false);
  assert.equal(isNetworkError(null), false);
});

test("subscribers fire on transition only", () => {
  const { c, advance } = harness();
  const seen = [];
  c.subscribe(v => seen.push(v));

  c.noteFailure(new TypeError("x"));
  c.noteFailure(new TypeError("x"));
  assert.deepEqual(seen, [true], "two failures, one transition");

  advance(60_001);
  assert.deepEqual(seen, [true, false], "recovery is announced");
});

test("unsubscribe stops delivery", () => {
  const { c } = harness();
  const seen = [];
  const off = c.subscribe(v => seen.push(v));
  off();
  c.noteFailure(new TypeError("x"));
  assert.deepEqual(seen, []);
});

test("the online event clears a backoff immediately", () => {
  const { c, fire } = harness();
  c.noteFailure(new TypeError("x"));
  assert.equal(c.isOffline(), true);
  fire("online");
  assert.equal(c.isOffline(), false);
});

test("the offline event is announced to subscribers", () => {
  const { c, nav, fire } = harness();
  const seen = [];
  c.subscribe(v => seen.push(v));
  nav.onLine = false;
  fire("offline");
  assert.deepEqual(seen, [true]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd shopping-spa && node --test js/connectivity.test.mjs`
Expected: FAIL — `Cannot find module './connectivity.js'`.

- [ ] **Step 3: Write the implementation**

Create `shopping-spa/js/connectivity.js`:

```js
// Is Drive reachable? One source of truth, fed by two kinds of evidence: the
// browser's own online/offline events, and whether Drive calls actually
// succeed. The second matters more. In a shop navigator.onLine is usually
// still true while every request quietly hangs, so believing it alone would
// leave the app pretending to be online for the whole trip.

const BACKOFF_LADDER_MS = [15_000, 30_000, 60_000];

/** Thrown when a Drive call could not reach the network at all. */
export class OfflineError extends Error {
  constructor(message = "Offline"){
    super(message);
    this.name = "OfflineError";
  }
}

/**
 * A failure counts as evidence of being offline only when no HTTP response
 * arrived. A 403 or a 404 proves the network works, and must keep surfacing as
 * the real error it is rather than hiding behind an offline banner.
 */
export function isNetworkError(err){
  if(!err) return false;
  if(err instanceof OfflineError) return true;
  if(err.name === "AbortError" || err.name === "TimeoutError") return true;
  return err instanceof TypeError;
}

export function createConnectivity({
  nav = globalThis.navigator,
  clock = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  addListener = (type, fn) => globalThis.addEventListener?.(type, fn)
} = {}){
  let backoffUntil = 0;
  let rung = -1;
  let timer = null;
  const subscribers = new Set();

  function isOffline(){
    if(nav && nav.onLine === false) return true;
    return clock() < backoffUntil;
  }

  let last = isOffline();

  function emit(){
    const cur = isOffline();
    if(cur === last) return;
    last = cur;
    // Copy first: a subscriber is allowed to unsubscribe from inside its own
    // callback, which would otherwise mutate the set mid-iteration.
    for(const fn of [...subscribers]) fn(cur);
  }

  // The backoff expires by the clock, not by anything calling in, so recovery
  // would go unannounced without a timer. app.js pushes pending ticks on that
  // announcement, so it has to be real rather than discovered on the next poll.
  function arm(){
    if(timer !== null){ clearTimer(timer); timer = null; }
    const ms = backoffUntil - clock();
    if(ms > 0){
      timer = setTimer(() => { timer = null; emit(); }, ms);
    }
  }

  function clear(){
    backoffUntil = 0;
    rung = -1;
    arm();
    emit();
  }

  function noteSuccess(){
    clear();
  }

  function noteFailure(err){
    if(!isNetworkError(err)){
      // Drive answered, so the network is fine even though the call failed.
      noteSuccess();
      return;
    }
    rung = Math.min(rung + 1, BACKOFF_LADDER_MS.length - 1);
    backoffUntil = clock() + BACKOFF_LADDER_MS[rung];
    arm();
    emit();
  }

  function subscribe(fn){
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  addListener("online", clear);
  addListener("offline", emit);

  return { isOffline, noteSuccess, noteFailure, subscribe };
}

/** What the app uses. Tests build their own with createConnectivity(). */
export const Connectivity = createConnectivity();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd shopping-spa && node --test js/connectivity.test.mjs`
Expected: `pass 11`, `fail 0`. (The module-type warning described in Global Constraints will appear first. It is expected.)

This module and this exact test file were run before the plan was written: 11/11 pass. If they do not pass for you, the transcription is wrong, not the design.

- [ ] **Step 5: Confirm the existing suite still passes**

Run: `cd shopping-spa && node --test js/transfer.test.mjs js/tree.test.mjs js/connectivity.test.mjs`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add shopping-spa/js/connectivity.js shopping-spa/js/connectivity.test.mjs
git commit -m "Add a connectivity module with a failure backoff"
```

---

### Task 2: Stop the unprompted OAuth popup, and fail fast on weak signal

Two changes that belong together: authentication stops prompting, and the transport gains a timeout so one-bar signal fails in 8 seconds instead of hanging. Either alone leaves the mid-aisle popup or the hang in place.

**Files:**
- Modify: `shopping-spa/js/driveAuth.js`
- Modify: `shopping-spa/js/driveApi.js`
- Test: `shopping-spa/js/driveAuth.test.mjs`

**Interfaces:**
- Consumes: `Connectivity`, `OfflineError` from Task 1.
- Produces:
  - `tokenDecision(token, nowMs, skewMs?): "use" | "none"` — exported from `driveAuth.js`, pure.
  - `DriveAuth.ensureToken(): Promise<{access_token, expires_at} | null>` — **now returns `null` instead of prompting**.
  - Every `DriveApi` method now throws `OfflineError` when the network is unreachable, and still throws a plain `Error` for HTTP failures exactly as before.

- [ ] **Step 1: Write the failing test**

Create `shopping-spa/js/driveAuth.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenDecision } from "./driveAuth.js";

const NOW = 1_000_000;

test("a comfortably valid token is used", () => {
  assert.equal(tokenDecision({ access_token: "t", expires_at: NOW + 600_000 }, NOW), "use");
});

test("a missing token yields none rather than a prompt", () => {
  assert.equal(tokenDecision(null, NOW), "none");
});

test("an expired token yields none", () => {
  assert.equal(tokenDecision({ access_token: "t", expires_at: NOW - 1 }, NOW), "none");
});

test("a token inside the clock-skew margin is treated as expired", () => {
  // 10s of life left, and the margin is 30s: too close to start a request with.
  assert.equal(tokenDecision({ access_token: "t", expires_at: NOW + 10_000 }, NOW), "none");
});

test("the skew margin is configurable", () => {
  assert.equal(tokenDecision({ access_token: "t", expires_at: NOW + 10_000 }, NOW, 5_000), "use");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd shopping-spa && node --test js/driveAuth.test.mjs`
Expected: FAIL — `tokenDecision is not a function` (it is not exported yet).

- [ ] **Step 3: Add the pure decision and stop prompting**

In `shopping-spa/js/driveAuth.js`, add this exported function just above `export const DriveAuth = {`:

```js
/**
 * Should a request go ahead with this token? Pure, so it can be tested without
 * a browser — the IO (sessionStorage, the GIS popup) stays in ensureToken.
 *
 * There is deliberately no "reauth" outcome. Re-authentication needs a Google
 * popup, and a popup that opens because a background poller ticked is exactly
 * the thing this app must never do while you are standing in a shop.
 */
export function tokenDecision(token, nowMs, skewMs = 30_000){
  if(token && token.expires_at > nowMs + skewMs) return "use";
  return "none";
}
```

Then replace the whole `ensureToken` method:

```js
  async ensureToken(){
    const token = getToken();
    if(tokenDecision(token, Date.now()) === "use") return token;

    // No silent refresh is possible without a server, and prompting here would
    // open an OAuth popup from whatever happened to call us — including the
    // ten-second poller. Callers treat null as "not signed in right now"; the
    // sign-in buttons are the only interactive path.
    return null;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd shopping-spa && node --test js/driveAuth.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add timeouts and reachability reporting to the transport**

In `shopping-spa/js/driveApi.js`, replace the import block and `authedFetch`:

```js
import { DriveAuth } from "./driveAuth.js";
import { Connectivity, OfflineError } from "./connectivity.js";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

// Long enough for a slow-but-real connection, short enough that a dead one
// does not hold the UI for half a minute. A shop's one-bar signal keeps a
// socket open indefinitely, so without this the app never learns it is stuck.
const TIMEOUT_MS = 8000;

async function authedFetch(url, options = {}){
  const token = await DriveAuth.ensureToken();
  if(!token) throw new OfflineError("Not signed in");

  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token.access_token}`);

  let res;
  try{
    res = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }catch(err){
    // No response at all: DNS, socket, or our own timeout. This is the only
    // kind of failure that proves anything about reachability.
    Connectivity.noteFailure(err);
    throw new OfflineError("Drive is unreachable");
  }

  // Any HTTP status means the network works. The status itself is the caller's
  // problem, and they already handle it.
  Connectivity.noteSuccess();
  return res;
}
```

The rest of `driveApi.js` is unchanged — every method keeps its existing `if(!res.ok) throw new Error(...)` handling.

- [ ] **Step 6: Verify the whole pure suite still passes**

Run: `cd shopping-spa && node --test js/transfer.test.mjs js/tree.test.mjs js/connectivity.test.mjs js/driveAuth.test.mjs`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add shopping-spa/js/driveAuth.js shopping-spa/js/driveApi.js shopping-spa/js/driveAuth.test.mjs
git commit -m "Never open an OAuth popup from a background call"
```

---

### Task 3: Service worker, manifest and icons

This is the task that makes the page load at all with no network. It is independently valuable: even with nothing else done, the app would open offline and show whatever the last render left.

**Files:**
- Create: `shopping-spa/icons/icon.svg`, `shopping-spa/icons/icon-192.png`, `shopping-spa/icons/icon-512.png`
- Create: `shopping-spa/manifest.webmanifest`
- Create: `shopping-spa/sw.js`
- Modify: `shopping-spa/index.html`
- Modify: `shopping-spa/js/app.js`

**Interfaces:**
- Consumes: `shopping-spa/js/connectivity.js` must exist (Task 1) — it is in the precache list.
- Produces: nothing other modules import. `sw.js` is loaded by the browser, not by the module graph.

- [ ] **Step 1: Create the icon source**

Create `shopping-spa/icons/icon.svg`. The colours are `--bg` and `--primary` from `styles.css`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#0b0d10"/>
  <g stroke="#3b82f6" stroke-width="26" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M112 128 h44 l50 176 h158 l40 -120 H184"/>
    <circle cx="220" cy="368" r="22"/>
    <circle cx="342" cy="368" r="22"/>
  </g>
</svg>
```

- [ ] **Step 2: Rasterize the two PNGs**

`qlmanage` and `sips` are macOS built-ins, so this needs nothing installed. Run each command separately from the repo root:

```bash
qlmanage -t -s 512 -o shopping-spa/icons shopping-spa/icons/icon.svg
```
```bash
mv shopping-spa/icons/icon.svg.png shopping-spa/icons/icon-512.png
```
```bash
cp shopping-spa/icons/icon-512.png shopping-spa/icons/icon-192.png
```
```bash
sips -z 192 192 shopping-spa/icons/icon-192.png
```

Verify both:

```bash
sips -g pixelWidth -g pixelHeight shopping-spa/icons/icon-192.png shopping-spa/icons/icon-512.png
```
Expected: 192×192 and 512×512.

- [ ] **Step 3: Create the manifest**

Create `shopping-spa/manifest.webmanifest`:

```json
{
  "name": "Shopping Lists",
  "short_name": "Shopping",
  "description": "Local-first shopping lists with Google Drive sync.",
  "start_url": "./index.html",
  "scope": "./",
  "display": "standalone",
  "background_color": "#0b0d10",
  "theme_color": "#0b0d10",
  "icons": [
    { "src": "./icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "./icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "./icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

- [ ] **Step 4: Create the service worker**

Create `shopping-spa/sw.js`:

```js
/* Offline app shell.
 *
 * BUMP `VERSION` WHENEVER ANY PRECACHED FILE CHANGES. The cache is served
 * before the network, so a deploy without a bump keeps serving the old bundle
 * and looks like it did nothing at all.
 *
 * The precache list is written by hand because this repo has no build step and
 * keeping it that way is worth more than the maintenance. It must list every
 * runtime module — a missing one only fails once you are already offline.
 */
const VERSION = "v1";
const CACHE = `shopping-spa-${VERSION}`;

const PRECACHE = [
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./js/app.js",
  "./js/config.js",
  "./js/conflictDiff.js",
  "./js/connectivity.js",
  "./js/db.js",
  "./js/driveApi.js",
  "./js/driveAuth.js",
  "./js/driveSync.js",
  "./js/focus.js",
  "./js/modal.js",
  "./js/model.js",
  "./js/transfer.js",
  "./js/tree.js",
  "./js/ui.js",
  "./js/util.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE);
    // Safe despite "new version goes live at the next launch": the app has no
    // lazy-loaded modules, so every file is already in the running page's
    // module graph. Swapping the cache underneath changes nothing until the
    // next navigation, which is exactly the intended behaviour.
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(n => n === CACHE ? null : caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if(req.method !== "GET") return;

  const url = new URL(req.url);
  // Drive and Google Identity are never cached and never intercepted: a stale
  // API response would be worse than no response, and an intercepted OAuth
  // flow would simply break.
  if(url.origin !== self.location.origin) return;

  // A navigation to any path in scope is the app itself.
  if(req.mode === "navigate"){
    event.respondWith((async () => {
      const cached = await caches.match("./index.html");
      return cached || fetch(req);
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if(cached) return cached;
    // Deliberately not cached: the cache stays exactly the precache set, so
    // what it holds is predictable and a bad response cannot poison it.
    return fetch(req);
  })());
});
```

- [ ] **Step 5: Link the manifest**

In `shopping-spa/index.html`, add after the `<link rel="stylesheet" ...>` line:

```html
  <link rel="manifest" href="./manifest.webmanifest" />
  <meta name="theme-color" content="#0b0d10" />
  <link rel="apple-touch-icon" href="./icons/icon-192.png" />
```

- [ ] **Step 6: Register the worker**

In `shopping-spa/js/app.js`, add this function just above `async function boot(){`:

```js
/**
 * Registration is best-effort. A browser that refuses one — private browsing,
 * an insecure origin, an old build — must still boot exactly as it always did,
 * just without the offline cache. This is never a reason to fail.
 */
function registerServiceWorker(){
  if(!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./sw.js").catch(e => {
    console.warn("Service worker registration failed; continuing online-only.", e);
  });
}
```

And call it as the first statement inside `boot()`:

```js
async function boot(){
  registerServiceWorker();
  await DriveAuth.init();
  await loadAll();
```

- [ ] **Step 7: Verify it caches and serves offline**

Serve the app (from the repo root, in its own terminal):

```bash
cd shopping-spa && python3 -m http.server 8765
```

Then in Chrome at `http://localhost:8765/index.html`: load once, confirm in DevTools → Application → Service Workers that `sw.js` is activated and Cache Storage holds `shopping-spa-v1` with 20 entries. Then tick DevTools → Network → Offline and reload.

Expected: the page renders (the auth gate appears — that is Task 4's job to improve), and **no request for `index.html`, `styles.css` or any `js/*.js` fails**. Requests to `accounts.google.com` failing offline is correct and expected.

- [ ] **Step 8: Commit**

```bash
git add shopping-spa/sw.js shopping-spa/manifest.webmanifest shopping-spa/icons shopping-spa/index.html shopping-spa/js/app.js
git commit -m "Precache the app shell so the page loads offline"
```

---

### Task 4: The gate's third state

Until now, being signed out means being locked out. This adds the way in.

**Files:**
- Modify: `shopping-spa/index.html`
- Modify: `shopping-spa/styles.css`
- Modify: `shopping-spa/js/app.js`

**Interfaces:**
- Consumes: `Connectivity` from Task 1.
- Produces:
  - `state.offline: boolean` — read by `ui.js` in Task 5. Computed fresh inside `getState()`, so consumers never see a stale value.
  - DOM ids `#btnContinueOffline` and `#offlineBanner`.

- [ ] **Step 1: Add the button and the banner**

In `shopping-spa/index.html`, inside `<div class="auth-card">`, add after the existing `#btnSignInGate` button:

```html
      <button id="btnContinueOffline" class="btn" hidden>Continue offline with saved lists</button>
```

Then add the banner as the **first child** of `<section class="content">`, before `<div id="emptyState" ...>`. It sits outside `#listView` deliberately: you need to be told you are offline even when no list is selected.

```html
      <div id="offlineBanner" class="offline hidden">
        <div>
          <div class="offline-title">Offline</div>
          <div class="muted small">You can tick items off. Editing and syncing resume when you are back online.</div>
        </div>
      </div>
```

- [ ] **Step 2: Style the banner**

In `shopping-spa/styles.css`, add immediately after the `.conflict-title` rule (around line 338):

```css
.offline{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  border:1px solid rgba(245,158,11,.45);
  background:rgba(245,158,11,.10);
  border-radius:16px;
  padding:12px;
  margin-bottom:12px;
}
.offline-title{ font-weight:750; }
```

- [ ] **Step 3: Wire the offline state into app.js**

In `shopping-spa/js/app.js`, add to the import block:

```js
import { Connectivity } from "./connectivity.js";
```

Add to the `els` object:

```js
  btnContinueOffline: document.getElementById("btnContinueOffline"),
```

Add a module-level flag just below `let state = { ... };`:

```js
// Set when you deliberately choose offline mode at the gate. It is separate
// from Connectivity's verdict because it must not evaporate the moment a bar
// of signal comes back — you leave this mode by signing in, not by walking
// past a window.
let offlineModeChosen = false;
```

Replace `getState` so the flag is always fresh:

```js
// Derived on read rather than stored: a cached copy and Connectivity's verdict
// would drift apart, and the banner and the disabled buttons would disagree.
function getState(){
  state.offline = offlineModeChosen || Connectivity.isOffline();
  return state;
}
```

- [ ] **Step 4: Give the gate its third state**

Replace `refreshAuthUI()` entirely:

```js
function refreshAuthUI(){
  const signedIn = DriveAuth.isSignedIn();
  state.auth.isSignedIn = signedIn;
  const offline = getState().offline;

  els.btnSignIn.disabled = signedIn;
  els.btnSignOut.disabled = !signedIn;
  els.btnSync.disabled = !signedIn || !state.activeDoc || offline;

  if(signedIn || offlineModeChosen){
    showAuthGate(false);
    setSyncStatus(signedIn ? (offline ? "Offline" : "Signed in") : "Offline — saved lists only");
    return;
  }

  // Offering to continue offline with nothing saved would open an empty app
  // and look broken, so the button only appears when there is something to show.
  const hasLocal = state.lists.length > 0;
  els.btnContinueOffline.hidden = !hasLocal;
  showAuthGate(true, hasLocal
    ? "Sign in to sync, or continue offline with the lists saved on this device."
    : "No lists are saved on this device yet, so signing in is the only way in.");
  setSyncStatus("Not signed in");
}
```

- [ ] **Step 5: Bind the button**

In `boot()`, next to the existing `els.btnSignInGate` listener, add:

```js
  els.btnContinueOffline.addEventListener("click", () => {
    offlineModeChosen = true;
    refreshAuthUI();
    ui.render();
  });
```

And in **both** sign-in success paths (the `els.btnSignIn` handler and the `els.btnSignInGate` handler), add `offlineModeChosen = false;` as the first statement after `await DriveAuth.signInInteractive();`, so a successful sign-in leaves offline mode.

- [ ] **Step 6: Verify by hand**

With the app served at `http://localhost:8765/index.html`:

1. Sign in, let at least one list load, then close and reopen the tab (this drops the `sessionStorage` token, reproducing the real shopping case).
2. Expected: the gate appears **with** "Continue offline with saved lists".
3. Tap it. Expected: the gate closes, your lists render, the amber Offline banner shows, the status line reads "Offline — saved lists only".
4. In a fresh profile with no lists saved, expected: the gate appears **without** the button, and explains why.

- [ ] **Step 7: Commit**

```bash
git add shopping-spa/index.html shopping-spa/styles.css shopping-spa/js/app.js
git commit -m "Let the gate be passed offline when lists are already saved"
```

---

### Task 5: Read-only rendering

The app now lets you in offline. This stops it offering you things it cannot do.

**Files:**
- Modify: `shopping-spa/js/ui.js`

**Interfaces:**
- Consumes: `state.offline` from Task 4.
- Produces: nothing other modules import.

- [ ] **Step 1: Add the element references**

In `shopping-spa/js/ui.js`, add to the `els` object inside `createUI`:

```js
    offlineBanner: document.getElementById("offlineBanner"),
```

- [ ] **Step 2: Add the effective-mode helper**

Add just below the `liveDoc` function inside `createUI`:

```js
  // The stored mode is what you chose; the effective mode is what we can
  // honour right now. Offline pins to shopping *without* touching doc.mode —
  // writing to it would mark the doc dirty and push a mode change you never
  // asked for to every other device.
  function effectiveMode(doc){
    if(getState().offline) return "shopping";
    return doc.mode || "shopping";
  }
```

- [ ] **Step 3: Use it everywhere the mode gates an affordance**

Four replacements in `ui.js`. **Leave line ~366 alone** — the `doc.mode === "edit"` inside `renderLists()` is a badge describing each saved list, not a live affordance, and must keep showing the stored mode.

In `buildItemRow`, the two lines inside the template literal:

```js
        ${effectiveMode(doc) === "edit" ? `<button class="btn btn-small" data-act="edit">Edit</button>` : ""}
        ${effectiveMode(doc) === "edit" ? `<button class="btn btn-small btn-danger" data-act="del">Delete</button>` : ""}
```

In `renderHeader`, the footer bar line and the two segmented-button lines:

```js
      footerbar.classList.toggle("hidden", effectiveMode(doc) === "shopping");
```
```js
    els.modeEdit.classList.toggle("active", effectiveMode(doc) === "edit");
    els.modeShop.classList.toggle("active", effectiveMode(doc) === "shopping");
```

This alone removes every per-item Edit and Delete button while offline, because they were already gated on edit mode.

- [ ] **Step 4: Suppress the section add button**

In `buildSectionRow`, change the guard around the `➕` button from:

```js
    if(row.id !== ORPHAN_SECTION_ID){
```

to:

```js
    // "Uncategorized" is a synthetic section, not a real category — there is
    // nothing to add an item to. Offline there is nothing to add anywhere.
    if(row.id !== ORPHAN_SECTION_ID && !getState().offline){
```

- [ ] **Step 5: Suppress the category menu and drag handle**

In `renderCategoryTree`, immediately before `row.innerHTML = \`` add:

```js
      const ro = getState().offline;
```

Change the drag-handle branch to require write access:

```js
        ${node.id !== "c_root" && !ro
          ? `<span class="handle" title="Drag to move" draggable="true" data-handle="1">⋮⋮</span>`
          : `<span style="width:34px; display:inline-block;"></span>`
      }
```

And the actions block:

```js
      <div class="actions">
        ${ro ? "" : `<button class="iconbtn menubtn" type="button" data-menu="1"
                aria-haspopup="menu" aria-expanded="false"
                title="Category actions" aria-label="Actions for ${escapeHtml(node.name)}">⋯</button>`}
      </div>
```

Then guard the listener that binds to it, since the element is now sometimes absent. Replace:

```js
      const menuBtn = row.querySelector("[data-menu='1']");
      menuBtn.addEventListener("click", (e) => {
```

with:

```js
      const menuBtn = row.querySelector("[data-menu='1']");
      menuBtn?.addEventListener("click", (e) => {
```

- [ ] **Step 6: Disable the static controls**

Add this function inside `createUI`, just above `function render(){`:

```js
  // Disabled, not hidden. A greyed-out control says "this exists and is
  // temporarily unavailable"; a control that has vanished reads as a bug, and
  // sends you hunting for a feature you think you have lost.
  function applyReadOnly(){
    const st = getState();
    const ro = !!st.offline;

    els.btnNewList.disabled = ro;
    els.btnImportShared.disabled = ro;
    els.btnImportFile.disabled = ro;
    els.btnAddCategory.disabled = ro;
    els.btnAddItem.disabled = ro;
    els.btnQuickAdd.disabled = ro;
    els.newItemInput.disabled = ro;
    els.btnDeleteList.disabled = ro;
    els.modeEdit.disabled = ro;
    els.listTitle.readOnly = ro;

    // Sharing needs Drive whether or not you are offline.
    els.btnShare.disabled = ro || !st.auth.isSignedIn;

    els.offlineBanner.classList.toggle("hidden", !ro);
  }
```

Remove the now-duplicated `els.btnShare.disabled = !signedIn;` line from `renderHeader()` — `applyReadOnly` owns it.

Call it first in `render()`:

```js
  function render(){
    applyReadOnly();
    renderTabButtons();
    renderLists();
    renderHeader();
    renderConflict();

    const st = getState();
    if(!st.activeDoc) return;

    renderCategoryTree();
    renderItems();
  }
```

`applyReadOnly` runs before the early return so the banner shows even with no list selected.

- [ ] **Step 7: Verify by hand**

Serve the app, sign in, load a list, then set DevTools → Network → Offline and wait for a poll to fail (up to ~10s).

Expected: the amber banner appears; `+ New`, `+ Shared`, `Import file`, `+ Category`, `+ Item`, `Add`, `Delete`, `Share` and `Edit` are all visibly disabled; the item input is disabled; the list title cannot be typed into; the `⋮⋮` handles and `⋯` menus are gone from the category tree; the `➕` on section headers is gone.

**Ticking a checkbox must still work**, and the item must stay ticked across a re-render. Switch DevTools back online and confirm the banner clears and the controls come back.

- [ ] **Step 8: Commit**

```bash
git add shopping-spa/js/ui.js
git commit -m "Render read-only while offline"
```

---

### Task 6: Push pending ticks when the connection returns

**Files:**
- Modify: `shopping-spa/js/app.js`

**Interfaces:**
- Consumes: `Connectivity.subscribe` (Task 1), `DriveAuth.ensureToken()` returning `null` (Task 2), `state.offline` (Task 4).
- Produces: nothing other modules import.

- [ ] **Step 1: Stop the poller from working while offline**

In `startPolling(ui)`, add as the first guard inside the interval callback, above the existing `if(!state.auth.isSignedIn) return;`:

```js
    if(Connectivity.isOffline()) return;
```

- [ ] **Step 2: Make a failed sync say something useful**

In `syncActive()`, replace the `catch` block:

```js
  }catch(e){
    console.error(e);
    if(e instanceof OfflineError){
      // Nothing was lost: the doc is still dirty in IndexedDB and will go up
      // on the next successful sync.
      setSyncStatus(DriveAuth.isSignedIn()
        ? "Offline — will sync when you're back"
        : "Offline changes saved — sign in to sync");
      return;
    }
    setSyncStatus("Sync failed: " + e.message);
  }
```

And extend the import from Task 4:

```js
import { Connectivity, OfflineError } from "./connectivity.js";
```

- [ ] **Step 3: Push on recovery**

Add this function just above `async function boot(){`:

```js
/**
 * Ticks made in the shop live in IndexedDB with dirty=true. The merge in
 * model.js is per-item last-write-wins on updatedAt, and toggling a checkbox
 * bumps it, so they land without conflict — there is no queue to replay.
 */
function watchForReconnect(ui){
  Connectivity.subscribe(async (offline) => {
    // Re-render either way: the banner and the disabled controls follow this.
    ui.render();
    refreshAuthUI();
    if(offline) return;

    if(!state.activeDoc || !state.activeDoc.dirty) return;
    if(!DriveAuth.isSignedIn()){
      setSyncStatus("Offline changes saved — sign in to sync");
      return;
    }

    await syncActive();
    ui.render();
  });
}
```

Call it in `boot()` next to `startPolling(ui)`:

```js
  watchForReconnect(ui);
  startPolling(ui);
```

- [ ] **Step 4: Verify by hand**

Serve the app, sign in, open a list. Then:

1. DevTools → Network → Offline. Wait for the banner.
2. Tick two or three items.
3. DevTools → Network → Online.

Expected: within a few seconds the banner clears, the status line reads `Synced ✅`, and the sidebar card for the list stops saying "unsynced". Reload the page and confirm the ticks survived.

Then the expired-token path: repeat steps 1–2, close the tab (dropping the `sessionStorage` token), reopen offline, tap `Continue offline`, go back online.

Expected: status reads "Offline changes saved — sign in to sync". **No Google popup appears at any point.** Sign in, and the ticks go up.

- [ ] **Step 5: Commit**

```bash
git add shopping-spa/js/app.js
git commit -m "Push offline ticks when the connection returns"
```

---

### Task 7: Browser verification

**Files:**
- Create: `docs/superpowers/verification/offline.mjs`
- Modify: all 7 existing `docs/superpowers/verification/*.mjs`
- Modify: `docs/superpowers/verification/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Block the service worker in the existing scripts**

The new worker caches app files across runs, which makes the existing checks intermittently serve stale code — and it presents as unrelated flakiness, so it is worth doing before anything else.

In each of `check.mjs`, `boot.mjs`, `conflict.mjs`, `staleness.mjs`, `importflow.mjs`, `itemsview.mjs`, `share.mjs`, replace:

```js
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
```

with:

```js
const browser = await chromium.launch({ channel: "chrome" });
// The app registers a service worker. Left alone it would cache app files
// across runs and serve stale code into checks that look unrelated.
const context = await browser.newContext({ serviceWorkers: "block" });
const page = await context.newPage();
```

- [ ] **Step 2: Write the offline check**

Create `docs/superpowers/verification/offline.mjs`:

```js
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
 */
async function seeded({ serviceWorkers = "block" } = {}){
  const context = await browser.newContext({ serviceWorkers });
  const page = await context.newPage();
  await page.addInitScript(() => {
    indexedDB.deleteDatabase("shopping_spa_db");
  });
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
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  await page.addInitScript(() => { indexedDB.deleteDatabase("shopping_spa_db"); });
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
  const googleHits = [];
  await context.route("**://accounts.google.com/**", route => {
    googleHits.push(route.request().url());
    route.abort();
  });
  await context.route("**://*.googleapis.com/**", route => {
    googleHits.push(route.request().url());
    route.abort();
  });

  await page.reload();
  await page.click("#btnContinueOffline");
  await context.setOffline(true);
  // Two full poll intervals.
  await page.waitForTimeout(21_000);

  assert.deepEqual(googleHits, [], "a background call tried to reach Google");
  await context.close();
});

console.log(results.join("\n"));
await browser.close();
```

- [ ] **Step 3: Run it**

Serve the app in its own terminal:

```bash
cd shopping-spa && python3 -m http.server 8765
```

Then, from the scratch Playwright install described in the README:

```bash
HARNESS_URL=http://localhost:8765/index.html node <repo>/docs/superpowers/verification/offline.mjs
```

Expected: 7 `PASS` lines, exit code 0.

- [ ] **Step 4: Re-run the whole existing suite**

Run each of the 7 existing scripts as documented in the README, plus:

```bash
cd shopping-spa && node --test js/transfer.test.mjs js/tree.test.mjs js/connectivity.test.mjs js/driveAuth.test.mjs
```

Expected: everything that passed before still passes. If a browser check now fails, confirm Step 1 was applied to that script before looking anywhere else.

- [ ] **Step 5: Update the README**

In `docs/superpowers/verification/README.md`:

Change the title line to mention offline, and the pure-logic command to:

```bash
cd <repo>/shopping-spa && node --test js/transfer.test.mjs js/tree.test.mjs js/connectivity.test.mjs js/driveAuth.test.mjs
```

Add a numbered run block after the share one:

```bash
# 10. Offline shopping mode (7 assertions)
HARNESS_URL=http://localhost:8765/index.html \
  node <repo>/docs/superpowers/verification/offline.mjs
```

Add a row to the coverage table:

| `offline.mjs` | Offline shopping mode. Covers: the app shell is served from the service worker cache with the network cut and no same-origin request fails; the gate offers "Continue offline" when lists are saved and hides it when none are; continuing offline renders the lists behind an offline banner; every structural control is disabled and the category menus, drag handles and section add buttons are gone; a tick still reaches IndexedDB and marks the doc dirty; and two full poll intervals pass without a single background request to `accounts.google.com` or `googleapis.com`. |

And add this note near the top, after the "Nothing here is part of the site" paragraph:

> **The app registers a service worker.** Every script in this directory opens
> its context with `serviceWorkers: "block"` so cached files cannot leak
> between runs — `offline.mjs` deliberately allows one in the single check that
> tests the cache itself. If you add a script here, block it too.
>
> **After changing any file under `shopping-spa/`, bump `VERSION` in
> `shopping-spa/sw.js`.** The cache is served ahead of the network, so a deploy
> without a bump keeps serving the old bundle and looks like it did nothing.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/verification
git commit -m "Verify offline shopping mode in a real browser"
```

---

## Self-Review

**Spec coverage** — every section of the spec maps to a task:

| Spec section | Task |
| --- | --- |
| 1. Service worker | 3 |
| 2. Manifest | 3 |
| 3. Connectivity | 1 |
| 4. Transport hardening | 2 |
| 5. The gate | 4 |
| 6. Read-only rendering | 5 |
| 7. Recovery | 6 |
| Error handling table | 3 (registration non-fatal), 6 (`OfflineError` status), 2 (HTTP errors unchanged) |
| Testing | 1, 2 (`node --test`), 7 (Playwright, `serviceWorkers: "block"`, README) |

**Known gap, accepted:** the spec's "Stuck on a stale cached version → bump `VERSION`" recovery is documentation only, covered by the README note in Task 7 Step 5 and the comment at the top of `sw.js`. There is nothing to implement.

**Type consistency** — checked across tasks: `isOffline()`, `noteSuccess()`, `noteFailure(err)`, `subscribe(fn)` are used in Tasks 2, 4, 5 and 6 exactly as Task 1 defines them. `OfflineError` is constructed in Task 2 and caught by `instanceof` in Task 6. `tokenDecision` returns only `"use"` or `"none"`, and Task 2 Step 3 branches on exactly those. `state.offline` is produced in Task 4 and consumed in Task 5. `#btnContinueOffline` and `#offlineBanner` are created in Task 4 and referenced in Tasks 5 and 7.

**Ordering constraint:** Task 3's precache list includes `./js/connectivity.js`, so Task 1 must land first or the service worker install will reject and offline caching will silently not happen.
