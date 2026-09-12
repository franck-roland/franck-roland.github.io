# Browser verification for the modal layer and list import/export

33 assertions run against a real Chrome. The pure serialization logic is tested
separately and needs nothing from this directory:

```bash
cd <repo>/shopping-spa && node --test js/transfer.test.mjs   # 35 assertions
```

**Nothing here is part of the site** —
`shopping-spa/` keeps zero runtime dependencies and no build step. Playwright is
installed in a scratch directory outside the repository, so these scripts are
inert unless you deliberately run them.

## Running them

```bash
# 1. Scratch install, anywhere outside the repo
mkdir -p /tmp/modalcheck && cd /tmp/modalcheck
npm init -y && npm install playwright

# 2. Serve the app
cd <repo>/shopping-spa && python3 -m http.server 8765 &

# 3. The modal layer in isolation (11 assertions)
cp <repo>/docs/superpowers/verification/harness.html <repo>/shopping-spa/__harness.html
HARNESS_URL=http://localhost:8765/__harness.html \
  node <repo>/docs/superpowers/verification/check.mjs
rm <repo>/shopping-spa/__harness.html      # never commit this

# 4. The real app (4 assertions)
HARNESS_URL=http://localhost:8765/index.html \
  node <repo>/docs/superpowers/verification/boot.mjs

# 5. The conflict dialog (7 assertions)
HARNESS_URL=http://localhost:8765/index.html \
  node <repo>/docs/superpowers/verification/conflict.mjs

# 6. The stale-doc guard (4 assertions)
HARNESS_URL=http://localhost:8765/index.html \
  node <repo>/docs/superpowers/verification/staleness.mjs

# 7. The import/export flow (11 assertions)
HARNESS_URL=http://localhost:8765/index.html \
  node <repo>/docs/superpowers/verification/importflow.mjs
```

Each script prints one `PASS`/`FAIL` line per assertion and exits non-zero on
failure. They launch `channel: "chrome"` — the Google Chrome installed on the
machine — rather than downloading a Playwright build.

## What each one covers

| Script | Covers |
| --- | --- |
| `check.mjs` | The `modal.js` API in isolation: confirm/prompt/alert return values, dismissal by Escape, backdrop and Cancel, trimming, Enter-to-submit, focus restore, stacking, scroll-lock refcounting, and that titles and messages are inserted as text rather than HTML. Also asserts that Escape never reaches the app's own bubble-phase handler while a dialog is open. |
| `boot.mjs` | The real page loads with no uncaught errors and no failed local requests, the auth gate renders, and `modal.js` is part of the module graph. |
| `conflict.mjs` | The refactored conflict dialog, driven through the real `createUI()`: the banner shows, Resolve opens a dialog carrying the diff summary, the three strategies are offered with Auto-merge primary, dismissal resolves nothing, and each choice reaches `onResolveConflict`. |
| `importflow.mjs` | The import/export UI. Serves stub `db.js`, `driveSync.js` and `driveAuth.js` modules via Playwright route interception, so the app boots with a known list and no network. Covers: malformed and non-list files refused; the Replace / Create new / Cancel dialog; the reset-checked option; a new import getting its own Drive file rather than the exporter's; Replace asking a second time, keeping the `listId` and Drive binding, and tombstoning the old items; a shared list never being offered as a replace target; and the export filename, with assertions that no `sync` block or Drive file id reaches the file. |
| `staleness.mjs` | The `liveDoc()` guard in `ui.js`. Simulates the 10-second poller swapping `state.activeDoc` while a confirm is open, and asserts the change lands on the live document rather than the detached one — and that the handler bails without persisting when the user has switched lists. |

`harness.html` is a fixture for `check.mjs` only. It must be copied into
`shopping-spa/` to run (ES modules need a same-origin path) and deleted
afterwards; it is not part of the app.
