# Modal Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every native `alert`/`confirm`/`prompt` in `shopping-spa` with a reusable, promise-based modal layer, and fold the hardcoded conflict modal into it.

**Architecture:** One new dependency-free ES module, `js/modal.js`, exporting `showModal` plus four thin helpers. Each call builds its own overlay and removes it on close; a module-level stack allows one modal over another. A single capture-phase `keydown` listener owns Escape while any modal is open, so the existing bubble-phase handler in `app.js` (sidebar → focus mode) is never reached. Styling reuses the `.modal*` and `.btn*` classes already in `styles.css`.

**Tech Stack:** Vanilla ES modules, no build step, no runtime dependencies. Verification uses Playwright installed **outside** the repo, in `$CLAUDE_JOB_DIR/tmp`.

**Spec:** `docs/superpowers/specs/2026-09-12-modal-layer-and-list-transfer-design.md`

## Global Constraints

- **Zero runtime dependencies, zero build step.** The site is served statically from GitHub Pages. Do not add `package.json`, `node_modules`, or a bundler to the repository. Test tooling lives in `$CLAUDE_JOB_DIR/tmp` and is never committed.
- **No native dialogs.** After this plan, `grep -rn "\balert(\|\bconfirm(\|\bprompt(" js/ index.html` must return exactly one line: the native fallback inside the `boot().catch()` handler in `app.js`.
- **Every helper resolves `null` on dismissal** (Escape, backdrop click, Cancel, or the header ✕). This matches the existing `if(!name) return;` guards, so migrations stay one-line.
- **Re-read state after every await.** See Task 3; this is the single most important correctness rule in the plan.
- **Reuse existing CSS classes** — `.btn`, `.btn-primary`, `.btn-danger`, `.btn-ghost`, `.iconbtn`, `.input`, `.row`, `.gap`, `.muted`, `.small`. Add new classes only where listed in Task 1.
- All files are under `shopping-spa/`.

---

### Task 1: The modal module and its styles

**Files:**
- Create: `shopping-spa/js/modal.js`
- Modify: `shopping-spa/styles.css` (append after the existing `.modal-footer` rule, currently line 366)
- Verify: harness page + Playwright script in `$CLAUDE_JOB_DIR/tmp` (not committed)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `showModal({ title, body, buttons, size }) -> Promise<any|null>`
  - `showAlert(message, { title } = {}) -> Promise<void>`
  - `showConfirm(message, { title, confirmLabel, danger } = {}) -> Promise<boolean>`
  - `showPrompt(message, { title, value, placeholder, confirmLabel } = {}) -> Promise<string|null>`
  - `showChoice({ title, body, buttons }) -> Promise<any|null>`
  - `body` accepts a string (rendered as text) or a DOM `Node` (appended as-is).
  - `buttons` is `[{ label, value, kind }]` with `kind` in `primary | danger | ghost | ""`.

- [ ] **Step 1: Write `shopping-spa/js/modal.js`**

```js
// Promise-based modal dialogs.
//
// Replaces native alert/confirm/prompt: those cannot be styled, look foreign
// inside the app, read badly on a phone, and OK/Cancel cannot express a
// three-way choice such as "Replace / Create new / Cancel".
//
// Every helper resolves to null when the user dismisses the dialog (Escape,
// backdrop, Cancel, or the header close button), which is exactly what the
// existing `if(!value) return;` call sites expect.

const stack = [];

// Capture phase, so this runs before the bubble-phase keydown handler in
// app.js that closes the sidebar and leaves focus mode. While a modal is open
// that handler must not see Escape at all.
document.addEventListener("keydown", (e) => {
  if(!stack.length) return;
  const top = stack[stack.length - 1];

  if(e.key === "Escape"){
    e.preventDefault();
    e.stopPropagation();
    top.close(null);
    return;
  }

  if(e.key === "Tab"){
    trapTab(e, top.modal);
  }
}, true);

const FOCUSABLE = [
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[href]",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

function focusables(root){
  return Array.from(root.querySelectorAll(FOCUSABLE));
}

function trapTab(e, modal){
  const list = focusables(modal);
  if(!list.length) return;

  const first = list[0];
  const last = list[list.length - 1];

  if(e.shiftKey && document.activeElement === first){
    e.preventDefault();
    last.focus();
  }else if(!e.shiftKey && document.activeElement === last){
    e.preventDefault();
    first.focus();
  }
}

let seq = 0;

/**
 * Opens a modal and resolves with the chosen button's `value`, or null if the
 * user dismissed it.
 *
 * @param {object}        opts
 * @param {string}        opts.title
 * @param {string|Node}   opts.body    text, or a node to adopt
 * @param {Array}         opts.buttons [{ label, value, kind }]
 * @param {string}        opts.size    "" | "sm"
 * @returns {Promise<any|null>}
 */
export function showModal({ title = "", body = "", buttons = [], size = "" } = {}){
  return new Promise(resolve => {
    const previouslyFocused = document.activeElement;
    const titleId = `modalTitle_${++seq}`;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const modal = document.createElement("div");
    modal.className = size ? `modal modal-${size}` : "modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", titleId);

    const header = document.createElement("div");
    header.className = "modal-header";
    const titleEl = document.createElement("div");
    titleEl.className = "modal-title";
    titleEl.id = titleId;
    titleEl.textContent = title;
    const closeBtn = document.createElement("button");
    closeBtn.className = "iconbtn";
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "✕";
    header.append(titleEl, closeBtn);

    const bodyEl = document.createElement("div");
    bodyEl.className = "modal-body";
    if(body instanceof Node){
      bodyEl.appendChild(body);
    }else if(body !== "" && body != null){
      const msg = document.createElement("div");
      msg.className = "modal-message";
      msg.textContent = String(body);
      bodyEl.appendChild(msg);
    }

    const footer = document.createElement("div");
    footer.className = "modal-footer row gap";

    modal.append(header, bodyEl, footer);
    overlay.appendChild(modal);

    const entry = { modal, close };
    let settled = false;

    function close(value){
      if(settled) return;
      settled = true;

      const i = stack.indexOf(entry);
      if(i !== -1) stack.splice(i, 1);

      overlay.remove();
      if(!stack.length) document.body.classList.remove("modal-open");

      // Restore focus only if nothing else claimed it in the meantime.
      if(previouslyFocused && typeof previouslyFocused.focus === "function"){
        previouslyFocused.focus();
      }
      resolve(value);
    }

    for(const b of buttons){
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = b.kind ? `btn btn-${b.kind}` : "btn";
      btn.textContent = b.label;
      btn.addEventListener("click", () => close(b.value));
      footer.appendChild(btn);
    }

    closeBtn.addEventListener("click", () => close(null));
    overlay.addEventListener("click", (e) => {
      if(e.target === overlay) close(null);
    });

    document.body.appendChild(overlay);
    document.body.classList.add("modal-open");
    stack.push(entry);

    // An input is what the user came to fill in; otherwise aim at the primary
    // action, falling back to whatever is focusable.
    const input = modal.querySelector("input, textarea, select");
    const primary = modal.querySelector(".btn-primary, .btn-danger");
    (input || primary || focusables(modal)[0] || modal).focus();
    if(input && typeof input.select === "function") input.select();
  });
}

/** Message with a single acknowledgement. */
export function showAlert(message, { title = "Notice" } = {}){
  return showModal({
    title,
    body: message,
    size: "sm",
    buttons: [{ label: "OK", value: true, kind: "primary" }]
  }).then(() => undefined);
}

/** Yes/no. Resolves false on dismissal. */
export function showConfirm(message, { title = "Are you sure?", confirmLabel = "OK", danger = false } = {}){
  return showModal({
    title,
    body: message,
    size: "sm",
    buttons: [
      { label: "Cancel", value: false, kind: "ghost" },
      { label: confirmLabel, value: true, kind: danger ? "danger" : "primary" }
    ]
  }).then(v => v === true);
}

/** Single-line text input. Resolves null on dismissal or empty input. */
export function showPrompt(message, { title = "", value = "", placeholder = "", confirmLabel = "OK" } = {}){
  const wrap = document.createElement("div");

  if(message){
    const label = document.createElement("label");
    label.className = "modal-message";
    label.textContent = message;
    label.setAttribute("for", `modalInput_${seq + 1}`);
    wrap.appendChild(label);
  }

  const input = document.createElement("input");
  input.className = "input";
  input.type = "text";
  input.id = `modalInput_${seq + 1}`;
  input.value = value ?? "";
  input.placeholder = placeholder;
  wrap.appendChild(input);

  const p = showModal({
    title: title || message || "",
    body: wrap,
    size: "sm",
    buttons: [
      { label: "Cancel", value: null, kind: "ghost" },
      { label: confirmLabel, value: "__ok__", kind: "primary" }
    ]
  });

  // Enter submits. The modal is already open by the time this runs.
  input.addEventListener("keydown", (e) => {
    if(e.key !== "Enter") return;
    e.preventDefault();
    const ok = input.closest(".modal").querySelector(".btn-primary");
    ok?.click();
  });

  return p.then(res => {
    if(res !== "__ok__") return null;
    const out = input.value.trim();
    return out === "" ? null : out;
  });
}

/** N-way choice. Resolves the chosen button's value, or null. */
export function showChoice({ title = "", body = "", buttons = [] } = {}){
  return showModal({ title, body, buttons });
}
```

- [ ] **Step 2: Append the styles to `shopping-spa/styles.css`**

Append immediately after the existing `.modal-footer` rule:

```css
/* Modal layer (js/modal.js) */
.modal{
  display:flex;
  flex-direction:column;
  max-height:85vh;
}
.modal-sm{ width:min(440px, 100%); }
.modal-body{ overflow-y:auto; }
.modal-message{ line-height:1.45; white-space:pre-wrap; }
.modal-footer .btn{ flex:0 0 auto; }
body.modal-open{ overflow:hidden; }

@media (max-width: 520px){
  .modal-footer{ flex-direction:column-reverse; align-items:stretch; }
  .modal-footer .btn{ width:100%; }
}
```

`.modal` already sets `width:min(720px,100%)`, `border-radius`, `background` and `overflow:hidden`; `.modal-sm` narrows it for one-line confirms. `.modal-footer` already has `justify-content:flex-end` and `flex-wrap:wrap`, and `.row`/`.gap` supply the flex row.

- [ ] **Step 3: Build the verification harness (outside the repo)**

```bash
mkdir -p "$CLAUDE_JOB_DIR/tmp/modalcheck"
cd "$CLAUDE_JOB_DIR/tmp/modalcheck"
npm init -y >/dev/null
npm install playwright >/dev/null
```

Create `$CLAUDE_JOB_DIR/tmp/modalcheck/harness.html` — copied into `shopping-spa/` only at run time, never committed:

```html
<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="./styles.css">
<body>
<script type="module">
  import { showAlert, showConfirm, showPrompt, showChoice } from "./js/modal.js";
  window.showAlert = showAlert;
  window.showConfirm = showConfirm;
  window.showPrompt = showPrompt;
  window.showChoice = showChoice;
  window.__ready = true;

  // Mirrors app.js: a bubble-phase Escape handler that must NOT fire
  // while a modal is open.
  window.__appEscapeFired = 0;
  document.addEventListener("keydown", (e) => {
    if(e.key === "Escape") window.__appEscapeFired++;
  });
</script>
<button id="opener">opener</button>
</body>
```

- [ ] **Step 4: Write the Playwright checks**

Create `$CLAUDE_JOB_DIR/tmp/modalcheck/check.mjs`:

```js
import { chromium } from "playwright";
import assert from "node:assert/strict";

const URL = process.env.HARNESS_URL;
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", e => { console.error("PAGE ERROR:", e.message); process.exitCode = 1; });
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
  const p = page.evaluate(() => window.showAlert("<img src=x onerror=alert(1)>", { title: "<b>t</b>" }));
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
```

- [ ] **Step 5: Run the checks and confirm every line reports PASS**

```bash
cp "$CLAUDE_JOB_DIR/tmp/modalcheck/harness.html" shopping-spa/__harness.html
npx --prefix "$CLAUDE_JOB_DIR/tmp/modalcheck" \
  node "$CLAUDE_JOB_DIR/tmp/modalcheck/check.mjs"   # serve shopping-spa/ first; see note
rm shopping-spa/__harness.html
```

Serve over HTTP rather than `file://`, because ES module imports are blocked on `file://`:

```bash
node --run-nothing 2>/dev/null; python3 -m http.server 8765 --directory shopping-spa &
HARNESS_URL=http://localhost:8765/__harness.html node "$CLAUDE_JOB_DIR/tmp/modalcheck/check.mjs"
```

Expected: eleven `PASS` lines, no `FAIL`, no `PAGE ERROR`, exit code 0. **Delete `shopping-spa/__harness.html` before committing** and confirm with `git status --short`.

- [ ] **Step 6: Commit**

```bash
git add shopping-spa/js/modal.js shopping-spa/styles.css
git commit -m "Add promise-based modal layer"
```

---

### Task 2: Migrate the six `app.js` call sites

**Files:**
- Modify: `shopping-spa/js/app.js`

**Interfaces:**
- Consumes: `showAlert`, `showPrompt` from Task 1.
- Produces: nothing new.

`app.js` handlers hold no long-lived reference to `state.activeDoc` across these awaits — `createList` builds a fresh doc, and the rest act on `state` directly — so the staleness guard from Task 3 is not needed here.

- [ ] **Step 1: Add the import at the top of `js/app.js`**

```js
import { showAlert, showPrompt } from "./modal.js";
```

- [ ] **Step 2: Replace the five in-app sites**

`createList()`:

```js
  const title = await showPrompt("List title?", { title: "New list", value: "New list" });
  if(title === null) return;
```

`importShared()` — note the button label, since this dialog takes a URL rather than a name:

```js
  if(!state.auth.isSignedIn){
    await showAlert("Sign in first.");
    return;
  }

  const input = await showPrompt("Paste a Google Drive share link or fileId:", {
    title: "Import a shared list",
    placeholder: "https://drive.google.com/file/d/…",
    confirmLabel: "Import"
  });
  if(input === null) return;
  const fileId = extractDriveFileId(input);
  if(!fileId){
    await showAlert("Could not extract a Drive fileId.", { title: "Import failed" });
    return;
  }
```

The sign-in failure handler:

```js
    }catch(e){
      await showAlert("Sign-in failed: " + e.message, { title: "Sign-in failed" });
    }
```

- [ ] **Step 3: Replace the fatal handler, keeping a native fallback**

This is the one permitted native call: if `boot()` failed, the DOM may not be usable.

```js
boot().catch(async e => {
  console.error(e);
  try{
    await showAlert(e.message, { title: "Fatal error" });
  }catch(_){
    // The page is too broken to render a dialog; fall back to the browser's.
    alert("Fatal error: " + e.message);
  }
});
```

- [ ] **Step 4: Verify no native dialogs remain in `app.js` except the fallback**

Run: `grep -n "\balert(\|\bconfirm(\|\bprompt(" js/app.js`
Expected: exactly one line — the `alert(` inside the `catch` of the fatal handler.

- [ ] **Step 5: Confirm the app still boots**

Serve `shopping-spa/` and load it; the auth gate must render with no console errors. (Sign-in cannot be exercised headlessly; the gate rendering proves the module graph loads.)

Run: `HARNESS_URL=http://localhost:8765/index.html node "$CLAUDE_JOB_DIR/tmp/modalcheck/boot.mjs"` where `boot.mjs` loads the page, fails on any `pageerror`, and asserts `#authGate` is visible.

- [ ] **Step 6: Commit**

```bash
git add shopping-spa/js/app.js
git commit -m "Use modal dialogs in app.js"
```

---

### Task 3: Migrate the eight `ui.js` call sites, with the staleness guard

**Files:**
- Modify: `shopping-spa/js/ui.js`

**Interfaces:**
- Consumes: `showAlert`, `showConfirm`, `showPrompt` from Task 1.
- Produces: nothing new.

**Why this task is delicate.** `confirm()` and `prompt()` are synchronous; `await showConfirm()` is not. The 10-second poller in `app.js` calls `loadAll()`, which reassigns `state.activeDoc` to a freshly deserialised object. `renderItems()` and `renderCategoryTree()` capture `doc` and `it` in their handler closures at render time. Without a guard: the user opens a confirm, the poller fires, the user confirms, and the handler mutates a detached object while `persistActiveDoc()` writes the *new* one — the change is silently lost.

The rule: **after every await, re-read `getState().activeDoc` and bail if the list changed.**

- [ ] **Step 1: Add the import at the top of `js/ui.js`**

```js
import { showAlert, showConfirm, showPrompt } from "./modal.js";
```

- [ ] **Step 2: Add the guard helper, just below the `els` object**

```js
  // Dialogs are async, unlike the native prompt/confirm they replaced. The
  // 10s poller in app.js can swap state.activeDoc for a freshly loaded object
  // while a dialog is open; a handler still holding the old reference would
  // mutate a detached doc and lose the change. Re-read after every await.
  function liveDoc(listId){
    const st = getState();
    const doc = st.activeDoc;
    if(!doc || doc.listId !== listId) return null;
    return doc;
  }
```

- [ ] **Step 3: Migrate `btnAddCategory` (was `ui.js:120`)**

```js
    els.btnAddCategory.addEventListener("click", async () => {
      const st = getState();
      if(!st.activeDoc) return;
      const listId = st.activeDoc.listId;
      const parentId = st.selectedCategoryId || "c_root";

      const name = await showPrompt("Category name?", { title: "New category", confirmLabel: "Add" });
      if(!name) return;

      const doc = liveDoc(listId);
      if(!doc){ render(); return; }

      upsertCategory(doc, { name, parentId });
      await persistActiveDoc();
      render();
    });
```

`showPrompt` already trims and returns `null` for an empty result, so the previous `name.trim()` is gone.

- [ ] **Step 4: Migrate `btnDeleteList` (was `ui.js:145`)**

```js
    els.btnDeleteList.addEventListener("click", async () => {
      const st = getState();
      if(!st.activeDoc) return;
      const listId = st.activeDoc.listId;

      const ok = await showConfirm(`Delete list "${st.activeDoc.title}"?`, {
        title: "Delete list", confirmLabel: "Delete", danger: true
      });
      if(!ok) return;
      if(!liveDoc(listId)){ render(); return; }

      await st.actions.deleteList(listId);
      render();
    });
```

- [ ] **Step 5: Migrate the drag-and-drop error (was `ui.js:466`)**

```js
        }catch(err){
          await showAlert(err.message, { title: "Cannot move category" });
        }
```

- [ ] **Step 6: Migrate the three `handleCategoryAction` branches (was `ui.js:485`, `496`, `503`)**

```js
    if(act === "add"){
      const listId = doc.listId;
      const name = await showPrompt("Subcategory name?", { title: "New subcategory", confirmLabel: "Add" });
      if(!name) return;

      const live = liveDoc(listId);
      if(!live){ render(); return; }

      upsertCategory(live, { name, parentId: categoryId });
      st.selectedCategoryId = categoryId;
      setState(st);
      await persistActiveDoc();
    }

    if(act === "rename"){
      const listId = doc.listId;
      const c = doc.categories.find(x => x.id === categoryId && !x.deletedAt);
      if(!c) return;

      const name = await showPrompt("New name?", { title: "Rename category", value: c.name, confirmLabel: "Rename" });
      if(!name) return;

      const live = liveDoc(listId);
      if(!live){ render(); return; }
      const target = live.categories.find(x => x.id === categoryId && !x.deletedAt);
      if(!target){ render(); return; }

      upsertCategory(live, { id: target.id, name, parentId: target.parentId });
      await persistActiveDoc();
    }

    if(act === "del"){
      const listId = doc.listId;
      const ok = await showConfirm(
        "Delete this category and all subcategories? Items will be moved to root.",
        { title: "Delete category", confirmLabel: "Delete", danger: true }
      );
      if(!ok) return;

      const live = liveDoc(listId);
      if(!live){ render(); return; }

      deleteCategory(live, categoryId);
      if(st.selectedCategoryId === categoryId) st.selectedCategoryId = "c_root";
      setState(st);
      await persistActiveDoc();
    }
```

Each branch re-looks-up the entity on the live doc, because the poller may have deleted it remotely.

- [ ] **Step 7: Migrate the item edit and delete handlers (was `ui.js:578`, `589`)**

```js
      const editBtn = row.querySelector("button[data-act=edit]");
      if(editBtn){
        editBtn.addEventListener("click", async () => {
          const listId = doc.listId;
          const newLabel = await showPrompt("Item label:", {
            title: "Rename item", value: it.label, confirmLabel: "Save"
          });
          if(!newLabel) return;

          const live = liveDoc(listId);
          if(!live){ render(); return; }
          if(!live.items.some(x => x.id === it.id && !x.deletedAt)){ render(); return; }

          updateItem(live, it.id, { label: newLabel });
          await persistActiveDoc();
          render();
        });
      }

      const delBtn = row.querySelector("button[data-act=del]");
      if(delBtn){
        delBtn.addEventListener("click", async () => {
          const listId = doc.listId;
          const ok = await showConfirm(`Delete "${it.label}"?`, {
            title: "Delete item", confirmLabel: "Delete", danger: true
          });
          if(!ok) return;

          const live = liveDoc(listId);
          if(!live){ render(); return; }

          deleteItem(live, it.id);
          await persistActiveDoc();
          render();
        });
      }
```

- [ ] **Step 8: Verify no native dialogs remain in `ui.js`**

Run: `grep -n "\balert(\|\bconfirm(\|\bprompt(" js/ui.js`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add shopping-spa/js/ui.js
git commit -m "Use modal dialogs in ui.js and guard against stale docs"
```

---

### Task 4: Fold the conflict modal into the layer

**Files:**
- Modify: `shopping-spa/index.html` (remove the `#modalOverlay` block, currently lines 135-159)
- Modify: `shopping-spa/js/ui.js` (remove `openModal`/`closeModal` and the six modal element refs; rewrite the resolve handler)

**Interfaces:**
- Consumes: `showChoice` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Delete the modal markup from `index.html`**

Remove the whole `<div id="modalOverlay" class="modal-overlay hidden"> … </div>` block. Nothing else references those ids after this task.

- [ ] **Step 2: Drop the stale element references from the `els` object in `ui.js`**

Remove the `// modal` group: `modalOverlay`, `btnModalClose`, `conflictDiff`, `btnConflictMerge`, `btnConflictMine`, `btnConflictRemote`.

- [ ] **Step 3: Delete `openModal` and `closeModal` and the six listeners that used them**

That is the `els.btnModalClose` listener, the `els.modalOverlay` backdrop listener, and the three `btnConflict*` listeners.

- [ ] **Step 4: Rewrite the resolve handler using `showChoice`**

```js
    els.btnResolveConflict.addEventListener("click", async () => {
      const st = getState();
      if(!st.conflict.pending || !st.conflict.remoteDoc || !st.activeDoc) return;

      const body = document.createElement("div");

      const intro = document.createElement("div");
      intro.className = "muted small";
      intro.textContent = "Choose how to resolve differences between your local changes and the remote version on Drive.";

      const box = document.createElement("div");
      box.className = "diffbox";
      const dTitle = document.createElement("div");
      dTitle.className = "diff-title";
      dTitle.textContent = "Summary";
      const pre = document.createElement("pre");
      pre.className = "diff-pre";
      pre.textContent = buildConflictSummary(st.activeDoc, st.conflict.remoteDoc);
      box.append(dTitle, pre);

      body.append(intro, box);

      const strategy = await showChoice({
        title: "Resolve conflict",
        body,
        buttons: [
          { label: "Keep remote", value: "remote" },
          { label: "Keep mine", value: "mine" },
          { label: "Auto-merge", value: "merge", kind: "primary" }
        ]
      });
      if(!strategy) return;

      await onResolveConflict(strategy);
      render();
    });
```

Button order is reversed relative to the old footer because `.modal-footer` is right-aligned (`justify-content:flex-end`), which puts the last child rightmost; Auto-merge stays the rightmost, primary action.

- [ ] **Step 5: Verify the ids are gone and nothing still references them**

Run: `grep -n "modalOverlay\|btnModalClose\|conflictDiff\|btnConflictMerge\|btnConflictMine\|btnConflictRemote\|openModal\|closeModal" index.html js/*.js`
Expected: no output.

- [ ] **Step 6: Confirm the app still boots cleanly**

Re-run the boot check from Task 2, Step 5. Expected: auth gate visible, no console errors.

- [ ] **Step 7: Commit**

```bash
git add shopping-spa/index.html shopping-spa/js/ui.js
git commit -m "Rebuild the conflict dialog on the modal layer"
```

---

### Task 5: Final sweep

**Files:** none modified unless the sweep finds something.

- [ ] **Step 1: Assert the global constraint holds**

Run: `grep -rn "\balert(\|\bconfirm(\|\bprompt(" js/ index.html`
Expected: exactly one line — the native fallback in the `boot().catch()` handler.

- [ ] **Step 2: Re-run the full Task 1 Playwright suite against the final tree**

Expected: eleven `PASS` lines, exit code 0.

- [ ] **Step 3: Confirm no test scaffolding leaked into the repo**

Run: `git status --short`
Expected: clean. In particular no `__harness.html`, `package.json`, `package-lock.json` or `node_modules/`.

- [ ] **Step 4: Confirm the diff touches only what the plan named**

Run: `git diff --stat production...HEAD`
Expected: `docs/superpowers/specs/…`, `docs/superpowers/plans/…`, `shopping-spa/js/modal.js`, `shopping-spa/js/app.js`, `shopping-spa/js/ui.js`, `shopping-spa/index.html`, `shopping-spa/styles.css` — and nothing else.

- [ ] **Step 5: Push the branch**

```bash
git push -u origin worktree-modal-layer
```

Do **not** push to `production`; that branch is what GitHub Pages serves.

---

## Self-Review

**Spec coverage.** API (Task 1) ✓; stack, focus restore, Tab trap, ARIA, scroll lock (Task 1) ✓; capture-phase Escape priority (Task 1, asserted in the Playwright suite) ✓; all 14 call sites (Task 2: 6, Task 3: 8) ✓; `app.js:414` native fallback (Task 2, Step 3) ✓; staleness hazard (Task 3, guard helper applied in all six mutating handlers) ✓; CSS additions incl. `max-height:85vh` and the size variant (Task 1, Step 2) ✓; conflict modal refactor and markup removal (Task 4) ✓; manual-verification stance upgraded to real browser assertions, keeping the repo dependency-free (Task 1, Steps 3-5) ✓.

**Placeholders.** None: every code step carries the code, every verification step carries its command and expected output.

**Type consistency.** `showPrompt` returns `string|null` and trims — so no call site calls `.trim()`, and `if(!name) return;` is preserved everywhere. `showConfirm` returns `boolean` (never `null`), so call sites use `if(!ok) return;`. `showChoice` returns the button `value` or `null`, matching the `"merge" | "mine" | "remote"` strings `onResolveConflict` already expects. `liveDoc(listId)` returns `doc|null` and is used identically in all six mutating handlers.

**One deviation from the spec, deliberate.** The spec settled on a manual verification checklist, on the grounds that a DOM test harness was disproportionate for a zero-dependency site. Playwright's browsers turned out to be already cached on this machine, so Task 1 asserts the behaviour in a real browser instead — with the tooling installed outside the repository, so the committed site stays dependency-free. Strictly better, and it costs the repo nothing.
