# Offline shopping mode

**Status:** approved, ready for an implementation plan
**Date:** 2026-09-12

## Problem

The app is meant to be used in a shop, which is exactly where the network is
worst. Today it is unusable there. Three things break, in order of severity:

1. **No service worker.** `index.html`, `styles.css` and the fourteen JS
   modules are fetched from the network on every load. With no connection the
   page does not load at all — there is nothing to be offline *with*.
2. **The auth gate is unconditional.** `refreshAuthUI()` in `app.js` shows a
   blocking gate whenever `DriveAuth.isSignedIn()` is false. Tokens are
   `sessionStorage`-backed and last about an hour, and re-auth needs
   `accounts.google.com`. So an expired token plus no signal locks you out of
   data already sitting in IndexedDB on the device.
3. **Writes go to Drive first.** `createList()` calls `ensureShoppingFolder()`
   then `ensureMyListFile()` before anything is persisted locally, so it throws
   when offline. Note that this design does not *fix* that ordering — the
   chosen scope disables list creation offline instead, so the path is never
   reached. Reordering it to local-first would be the first step if the scope
   ever widens to creating lists offline.

There is also a latent hazard that offline use makes acute: the ten-second
poller calls `DriveSync.syncDetectConflict` → `authedFetch` →
`DriveAuth.ensureToken()`, and `ensureToken()` calls `signInInteractive()` when
the token has expired. That opens a Google OAuth popup — unprompted, mid-aisle,
every ten seconds.

One piece of good news: `mergeEntities()` in `model.js` is per-entity
last-write-wins on `updatedAt`, and `toggleItemChecked()` bumps `updatedAt`.
Ticks made offline therefore merge back cleanly with no conflict.

## Decisions

These were settled during brainstorming and constrain everything below.

| Question | Decision |
| --- | --- |
| What must work offline | **Shop only: read and tick.** View lists, check and uncheck items. Structural edits (add/rename/delete items and categories, list titles, new lists) are disabled offline, not queued. |
| What you see at the gate | **A "Continue offline" button** next to "Sign in with Google". A deliberate tap, not an automatic bypass. |
| What happens on reconnect | **Auto-push, with status.** Ticks go up as soon as Drive is reachable and the status line confirms it. If the token expired, wait for the next sign-in rather than popping a dialog. |
| How new versions are picked up | **Cache-first, update quietly.** A new version downloads in the background and is live at the next launch. Never more than one launch stale. |
| Installable | **Yes.** A web app manifest and icons, so it launches from the home screen without browser chrome. |

## Goals

- The app loads and shows your lists with the network fully off.
- You can tick items off while shopping, and those ticks reach Drive later.
- Nothing ever opens an OAuth popup unless you tapped a sign-in button.
- Weak signal ("one bar") degrades to offline quickly instead of hanging.
- The repo keeps zero runtime dependencies and no build step.

## Non-goals

- Creating lists, importing, sharing or structural editing while offline.
- Queuing arbitrary offline mutations for later replay. Ticks ride on the
  existing `dirty` flag and the existing merge; there is no new queue.
- Background sync via the Background Sync API.
- Changing the conflict model. If someone genuinely edits the same list from
  another device while you shop, today's conflict banner handles it.

## Architecture

Seven files, three of them new.

```
sw.js  (new)                 app shell cache — makes the page load at all
manifest.webmanifest (new)   installability
js/connectivity.js (new)     is Drive reachable? one source of truth
js/driveApi.js               timeouts; reports reachability; OfflineError
js/driveAuth.js              non-interactive token path
js/app.js                    gate third state; offline flag; recovery push
js/ui.js                     read-only rendering
```

`connectivity.js` is the hinge. Everything else either feeds it evidence
(`driveApi`) or reads its verdict (`app`, `ui`).

### 1. Service worker — `shopping-spa/sw.js`

A single `VERSION` constant and a hand-written precache list:

- `./index.html`, `./styles.css`, `./manifest.webmanifest`
- `./icons/icon-192.png`, `./icons/icon-512.png`
- the fifteen runtime modules under `./js/` — `app`, `config`, `connectivity`,
  `conflictDiff`, `db`, `driveApi`, `driveAuth`, `driveSync`, `focus`, `modal`,
  `model`, `transfer`, `tree`, `ui`, `util`. **Not** `*.test.mjs`.

The list is hand-written rather than generated because the repo has no build
step and keeping it that way is worth more than the maintenance.

**Lifecycle.** `install` opens `shopping-spa-<VERSION>`, `addAll`s the
precache, then `skipWaiting()`. `activate` deletes every cache whose name is
not the current one, then `clients.claim()`.

`skipWaiting()` is safe despite the "update quietly" decision because the app
has no lazy-loaded modules — every file is in the module graph by the time boot
finishes. Replacing the cache under a running page therefore changes nothing
until the next navigation, which is precisely the chosen behaviour.

**Fetch.** Same-origin `GET` only; everything else falls through untouched.
Navigation requests are answered with the cached `./index.html`. Other
same-origin GETs are cache-first with a network fallback, and a network
response for something outside the precache list is *not* added to the cache —
the cache stays exactly the precache set, so its contents are predictable.

`googleapis.com` and `accounts.google.com` are never intercepted and never
cached.

**Paths are relative** (`./index.html`, not `/index.html`) so the same file
works at `https://franck-roland.github.io/shopping-spa/` and at
`http://localhost:8765/`.

**Registration** happens in `app.js` during boot, guarded by
`"serviceWorker" in navigator` and wrapped so a rejection is logged and
otherwise ignored. A browser that cannot register one must still boot exactly
as it does today.

**Deployment rule:** bump `VERSION` whenever any precached file changes, or the
old bundle keeps being served. This goes in a comment at the top of `sw.js` and
in the verification README.

### 2. Manifest — `shopping-spa/manifest.webmanifest`

`name`, `short_name` ("Shopping"), `start_url: "./index.html"`,
`scope: "./"`, `display: "standalone"`, a `theme_color` and `background_color`
taken from `styles.css`, and the two icons. Linked from `index.html` with
`<link rel="manifest" href="./manifest.webmanifest">`.

Icons are two PNGs, 192 and 512, generated from the existing 🛒 mark.

### 3. Connectivity — `shopping-spa/js/connectivity.js`

```js
isOffline()        // navigator.onLine === false, OR inside the failure backoff
noteSuccess()      // a Drive call got an HTTP response → clear the backoff
noteFailure(err)   // a network-class failure → start or extend the backoff
subscribe(fn)      // fn(isOffline) on every state change; returns unsubscribe
```

**Backoff.** After a network-class failure, report offline for 15 seconds.
Consecutive failures extend it: 15s → 30s → 60s, capped at 60s. Any success
clears it immediately and resets the ladder. This is what turns a one-bar
connection — where `navigator.onLine` is `true` and requests simply hang — into
something the app treats as offline, instead of a sequence of eight-second
stalls.

**Classification matters.** Only network-class failures count as evidence of
being offline: a `fetch` rejection (`TypeError`) or an `AbortError` from the
timeout. An HTTP response of any status — including 401, 403, 404, 500 — proves
the network works, so it calls `noteSuccess()` and the error surfaces normally
through the existing paths. Misclassifying a 403 as "offline" would silently
hide real Drive errors.

**Window events.** `online` clears the backoff and notifies; `offline` sets the
state and notifies.

The module is pure enough to test under `node --test` with an injected clock
and a fake `navigator`.

### 4. Transport hardening — `driveApi.js`, `driveAuth.js`

**Timeouts.** `authedFetch` passes `AbortSignal.timeout(8000)`. On a `TypeError`
or `AbortError` it calls `Connectivity.noteFailure(err)` and throws
`OfflineError`. On any HTTP response it calls `Connectivity.noteSuccess()` and
returns as before, so existing `if(!res.ok) throw` handling is untouched.

`OfflineError` is a named subclass exported from `connectivity.js` so callers
can distinguish "no network" from "Drive said no".

**Non-interactive auth.** `DriveAuth.ensureToken({ interactive = true } = {})`.
When `interactive` is `false` and the token is absent or expired, return `null`
rather than calling `signInInteractive()`. `authedFetch` takes the same option
and throws `OfflineError` when it receives `null`.

Callers that pass `interactive: false`: the ten-second poller, and the
auto-push on recovery. Callers that stay interactive: the two sign-in button
handlers, and nothing else. **This change alone removes the unprompted OAuth
popup**, independently of everything else in this document.

### 5. The gate — `app.js`

`refreshAuthUI()` grows from two states to three:

- **Signed in.** As today.
- **Signed out, local lists exist.** The gate shows, with a secondary button
  "Continue offline with saved lists". Tapping it sets an offline-mode flag,
  hides the gate, and renders read-only.
- **Signed out, no local lists.** The gate shows as today, plus a line
  explaining nothing is saved on this device — continuing offline would show an
  empty app, so the button is not offered.

`state.offline` is derived: `offlineModeChosen || Connectivity.isOffline()`.
One flag drives the banner and the read-only rendering, so the two can never
disagree.

You leave offline mode by signing in once the network is back;
`initialSyncFromDrive()` then runs exactly as it does today.

### 6. Read-only rendering — `js/ui.js`

The render path derives `readOnly = state.offline`.

**Live offline:** selecting a list, selecting a category, ticking and unticking
items, `Hide checked`, Focus mode, folding sections.

**Disabled offline:** `+ New`, `+ Shared`, `Import file`, `+ Category`,
`+ Item`, the quick-add row, list-title editing, `Delete`, `Share`,
`Sync now`, the per-item `⋯` menu (rename, delete, move), category
drag-and-reorder. The Edit/Shopping toggle pins to Shopping.

Controls are **disabled, not hidden**. A greyed-out control tells you the
feature exists and is temporarily unavailable; a control that has vanished
reads as a bug. A banner above the list carries the reason: offline, ticking
works, editing resumes when the connection does.

### 7. Recovery — `app.js`

`startPolling()` skips its whole body while `Connectivity.isOffline()`, so a
dead network costs nothing every ten seconds.

A `Connectivity.subscribe()` handler watches for the offline → online
transition:

- **Valid token** → run `syncActive()` non-interactively. Status: `Synced ✅`.
  Offline ticks merge through the existing last-write-wins path; only `checked`
  and `updatedAt` changed, so there is nothing to conflict over.
- **Expired token** → status reads "Offline changes saved — sign in to sync".
  Nothing pops. The dirty document waits in IndexedDB until the next sign-in,
  which is already followed by a sync.

## Error handling

| Failure | Behaviour |
| --- | --- |
| Service worker registration rejects (private mode, unsupported browser) | Logged, otherwise ignored. The app boots exactly as it does today, without offline caching. Never fatal. |
| `OfflineError` from a tap you initiated (e.g. `Sync now` as the signal dies) | Status line: "Offline — will sync when you're back". Not a modal. |
| Drive returns 403/404/500 | Unchanged. Proves the network works, so it surfaces as the real error it is. |
| IndexedDB unavailable | Unchanged, and already fatal today. Out of scope. |
| Stuck on a stale cached version | Bump `VERSION`, or unregister the worker in devtools. Documented in the verification README. |

## Testing

The repo's existing split is kept: pure logic under `node --test` inside the
repo, browser behaviour under Playwright installed outside it.

**`shopping-spa/js/connectivity.test.mjs`** — `node --test`, no browser. An
injected clock and a fake `navigator`. Covers: `isOffline()` tracks
`navigator.onLine`; a network failure starts the backoff; the backoff expires
on schedule; consecutive failures extend it 15 → 30 → 60 and cap; a success
clears it and resets the ladder; an HTTP-response error is *not* treated as
offline; `online`/`offline` events notify subscribers; unsubscribe works.

**`docs/superpowers/verification/offline.mjs`** — Playwright, following the
pattern of `importflow.mjs` (route interception for stub modules,
`context.setOffline(true)` for the network). Covers: the page loads and renders
lists with the network cut; the gate offers "Continue offline" only when local
lists exist and omits it when there are none; read-only disables the listed
controls while ticking stays live; a tick reaches IndexedDB; restoring the
network auto-pushes and updates the status; and the poller never reaches
`accounts.google.com` while offline.

**Existing verification scripts need `serviceWorkers: "block"` added to their
`browser.newContext()` call.** Without it the new worker caches app files
across runs and makes them intermittently stale. This is easy to miss and will
present as unrelated flakiness.

The README table gains a row for `offline.mjs` and a note about the `VERSION`
bump.

## Risks and caveats

- **`AbortSignal.timeout` requires Chrome 103+, Safari 16+, Firefox 100+.**
  This is a hard floor for the app after this change. Acceptable for a personal
  app on a modern phone; worth knowing.
- **The `VERSION` bump is manual.** Forgetting it means a deploy that appears
  to do nothing. A build step would remove the footgun, but the repo
  deliberately has none.
- **Cache-first means the first load after a deploy is the old version.** This
  is the chosen behaviour, not a defect, but it will feel surprising the first
  time.
- **`sessionStorage` tokens do not survive a browser restart.** So the common
  shopping path really is "signed out, continue offline", which is why that
  button matters more than it might look.
