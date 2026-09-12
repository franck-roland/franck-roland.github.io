# Modal layer and list import/export — design

Date: 2026-09-12
Status: approved; built in two pieces
Scope: `shopping-spa`

## Origin

The request was "add import and export of lists, with checked status". Design
discussion turned it into two pieces of work, because the chosen import flow
("ask whether to replace the open list or create a new one") must be presented
through a dialog, and native `alert`/`confirm`/`prompt` were ruled out for this
project — see the decision log.

**Piece 1 — the modal layer.** Ships first, on its own, so that a destructive
feature is not the first consumer of an unproven dialog system.

**Piece 2 — import/export.** Built on top of piece 1.

## Decision log

| Decision | Choice | Rationale |
| --- | --- | --- |
| Transfer format | JSON only | Lossless round-trip of the category tree, `qty`/`unit`, `order` and `checked`. One parser to harden. |
| Transport | File download + file picker | Works in every browser; no clipboard permission surprises. |
| Import target | Ask: replace the **currently open** list, or create a new one | You can see what you are about to destroy. |
| What a replace keeps | `listId` and the whole `sync` block; adopts the imported `title` | Stays the same Drive file, so everyone synced to it receives the update. |
| Shared lists as replace target | Not allowed | A `shared` list points at someone else's Drive file; replacing it would push over their data. |
| Export scope | The active list; imports are pushed to Drive immediately | Mirrors `createList()`, so an imported list is never stranded locally. |
| Dialogs | A reusable promise-based modal layer; no native dialogs | Native dialogs are unstyleable, look foreign, read poorly on a phone, and OK/Cancel cannot express a three-way choice. |
| Conflict modal | Refactored onto the new layer | One overlay implementation in the codebase. |

## Piece 1 — `js/modal.js`

### API

Every function resolves to `null` on dismissal (Escape, backdrop, Cancel), which
maps exactly onto the existing `if(!name) return;` guards at the call sites.

```js
showModal({ title, body, buttons, size })             // core -> Promise<value|null>
showAlert(message, { title })                         // -> Promise<void>
showConfirm(message, { title, confirmLabel, danger }) // -> Promise<boolean>
showPrompt(message, { title, value, placeholder })    // -> Promise<string|null>
showChoice({ title, body, buttons })                  // -> Promise<value|null>
```

`buttons` is an array of `{ label, value, kind }`, where `kind` is
`primary | danger | ghost`. `body` accepts a string (escaped) or a DOM node
(inserted as-is), so piece 2 can pass a form containing a checkbox.

### Behaviour

- Each call builds its own overlay element and removes it on close. A
  module-level stack permits one modal over another; piece 2 needs exactly that
  (choice dialog, then a destructive confirm).
- Escape closes the topmost modal only. Backdrop click and Cancel resolve `null`.
- `document.activeElement` is saved on open and restored on close. Focus moves to
  the input if there is one, otherwise the primary button. Tab is trapped within
  the overlay.
- `role="dialog"`, `aria-modal="true"`, and `aria-labelledby` pointing at the
  title.
- Body scroll lock via a `modal-open` class on `<body>`, reference-counted
  against the stack depth.

### Escape priority

`js/app.js` already owns a global `keydown` handler with a priority chain (close
the sidebar, then leave focus mode), registered in the bubble phase. `modal.js`
registers its own listener in the **capture** phase and calls `stopPropagation()`
while any modal is open. The app handler therefore never fires while a dialog is
up, and `app.js` needs no knowledge of the modal module.

### Migration — 14 call sites

| Site | Current | Becomes |
| --- | --- | --- |
| `ui.js:120` | `prompt("Category name?")` | `showPrompt` |
| `ui.js:145` | `confirm('Delete list "X"?')` | `showConfirm` (danger) |
| `ui.js:466` | `alert(err.message)` | `showAlert` |
| `ui.js:485` | `prompt("Subcategory name?")` | `showPrompt` |
| `ui.js:496` | `prompt("New name?", c.name)` | `showPrompt` |
| `ui.js:503` | `confirm("Delete this category…")` | `showConfirm` (danger) |
| `ui.js:578` | `prompt("Item label:", it.label)` | `showPrompt` |
| `ui.js:589` | `confirm("Delete item?")` | `showConfirm` (danger) |
| `app.js:109` | `prompt("List title?", "New list")` | `showPrompt` |
| `app.js:133` | `alert("Sign in first.")` | `showAlert` |
| `app.js:137` | `prompt("Paste a Drive link…")` | `showPrompt` |
| `app.js:141` | `alert("Could not extract…")` | `showAlert` |
| `app.js:324` | `alert("Sign-in failed: …")` | `showAlert` |
| `app.js:414` | `alert("Fatal error: …")` | `showAlert`, falling back to native `alert` in a `catch` |

`app.js:414` is the `boot().catch()` handler. If boot failed, the DOM may be
unusable, so it is the one place allowed to fall back to a native dialog.

### The staleness hazard this migration introduces

`confirm()` and `prompt()` are synchronous: the code after them runs in the same
tick. `await showConfirm()` does not. The 10-second poller in `app.js` calls
`loadAll()`, which **reassigns `state.activeDoc` to a freshly deserialised
object**.

`renderItems()` and `renderCategoryTree()` capture `doc` (and `it`) in their
event-handler closures at render time. So:

1. The user clicks delete on an item; the confirm dialog opens.
2. The user hesitates. The poller fires, merges, and replaces `state.activeDoc`.
3. The user confirms. `deleteItem(doc, it.id)` mutates the now-detached object.
4. `persistActiveDoc()` writes `state.activeDoc` — the *new* one. The deletion is
   silently lost.

**Every migrated handler must re-read `getState().activeDoc` after the await**,
and abort (re-rendering) if the active list changed identity underneath it. This
is the primary reason the modal layer ships before the destructive import.

### Styling

`styles.css` already has `.modal-overlay`, `.modal`, `.modal-header`,
`.modal-title`, `.modal-body` and `.modal-footer`, sized `min(720px, 100%)`.
Added: a narrower size variant for one-line confirms, `max-height: 85vh` with a
scrollable body for phones, input styling, and button `kind` variants.

The conflict modal's hardcoded markup is removed from `index.html` and rebuilt as
a `showChoice` call offering Auto-merge / Keep mine / Keep remote.

### Verification

The layer is DOM-bound, and the project is a zero-dependency, zero-build static
site, so adding a DOM test harness is disproportionate. Verified by hand against
a written checklist: all 14 sites; dismissal returning `null` via each of
Escape / backdrop / Cancel; focus restore; Escape priority with the sidebar open
and with focus mode on; conflict resolution still working; and the staleness case
reproduced deliberately.

## Piece 2 — `js/transfer.js` and the import/export flow

A pure module — no DOM, no IndexedDB — and therefore covered by `node --test`.

- `serializeDoc(doc)` — keeps `schemaVersion`, `title`, `mode`, `ui`,
  `categories`, `items` (including `checked`, `qty`, `unit`, `order`, `parentId`
  and `categoryId`). Drops `sync`, `listId`, `origin` and `dirty`. Adds
  `app: "shopping-spa"` and `exportedAt`. Dropping `sync` also avoids leaking a
  Drive file id into a file that gets shared.
- `parseImport(text)` — validates shape and `schemaVersion` before mutating
  anything; regenerates **every** category and item id; remaps `parentId` and
  `categoryId` through that map; guarantees `c_root` exists and reparents orphans
  to it; coerces types (`checked` to boolean, `qty` to number or null, labels
  trimmed, empty labels dropped); throws readable messages.
- `replaceDocContents(target, imported)` — see below.

### Export

`serializeDoc` -> `Blob` -> hidden `<a download>` named
`<slug-of-title>-YYYY-MM-DD.json` -> `URL.revokeObjectURL`. The button lives in
the list header beside Share.

### Import

The entry point is the sidebar, beside `+ New`, because import creates lists. The
existing sidebar `Import` button (import a shared list from a Drive link) is
renamed `+ Shared` to end the name collision.

1. File picker -> `file.text()` -> `parseImport`; failures go to `showAlert`.
2. `showChoice` showing the imported counts, offering **Replace "&lt;open
   list&gt;"** and **Create a new list**. Replace is rendered only when a list is
   open and its `origin` is `my`; otherwise a muted line explains why. A
   checkbox, shown only when the file contains ticked items, offers "Start with
   all items unchecked".
3. Replace -> a second `showConfirm` (danger) naming both sides and their counts.
4. Both paths then mirror `createList()`: `ensureShoppingFolder()`,
   `ensureMyListFile()`, persist, `loadAll`, select, render.
5. The file input is reset after each pick, so the same file can be imported
   twice.

### Replace must tombstone, not truncate

`mergeEntities` in `model.js` is a **union by id, newest `updatedAt` wins**. It
has no concept of "absent locally means deleted" — that is what `deletedAt`
tombstones are for. If a replace simply emptied the arrays while keeping the
list's `driveFileId`, the next sync — or the 10-second poller, with no user
action at all — would union the remote copy back in and **resurrect every
replaced item**.

So `replaceDocContents`:

1. Sets `deletedAt` and bumps `updatedAt` on every live category and item of the
   target, leaving `c_root` alive as the anchor.
2. Appends the imported entities, which already carry fresh ids from
   `parseImport` and therefore cannot collide with the tombstones.
3. Adopts `imported.title`; leaves `listId`, `origin` and `sync` untouched.
4. Calls `markDirty`.

Accepted consequences: tombstones accumulate and are never collected — already
true of `deleteItem` and `deleteCategory`, so this is existing behaviour rather
than a new leak; and a replace propagates to everyone synced to that Drive file,
which is the intent, but is irreversible.

### Tests (`node --test`, no dependencies)

Round-trip fidelity including `checked`; id regeneration (export, then import
twice, yields three independent lists); `sync` and `driveFileId` stripped; orphan
categories reparented to `c_root`; malformed and wrong-version input rejected
with a readable error; `replaceDocContents` tombstoning rather than truncating.
