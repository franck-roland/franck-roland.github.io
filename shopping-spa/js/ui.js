import { buildTree, flattenTree, buildItemsOutline, ORPHAN_SECTION_ID } from "./tree.js";
import { escapeHtml, debounce } from "./util.js";
import {
  addItem, deleteItem, toggleItemChecked, updateItem,
  upsertCategory, deleteCategory,
  setMode, setHideChecked, markDirty, moveCategory, reorderCategory
} from "./model.js";
import { buildConflictSummary } from "./conflictDiff.js";
import { isFocusWanted, toggleFocus, applyFocus } from "./focus.js";
import { showAlert, showChoice, showConfirm, showPrompt } from "./modal.js";

const collapsedCategoryIds = new Set(); // session-only (you can persist later)

// Folding a branch in the tree hides *navigation*; folding a section in the
// items panel hides *content*. Sharing one set would mean collapsing a tree
// branch silently emptied your shopping list, so they stay separate.
const collapsedSectionIds = new Set();

// render() rebuilds the items panel wholesale, so an open add row cannot live
// in the DOM — it would be destroyed by the re-render its own save triggers.
let addDraft = null;   // { categoryId, text } | null

/** The conflict dialog's body: an explanation plus the diff summary. */
function buildConflictBody(summary){
  const body = document.createElement("div");

  const intro = document.createElement("div");
  intro.className = "muted small";
  intro.textContent = "Choose how to resolve differences between your local changes and the remote version on Drive.";

  const box = document.createElement("div");
  box.className = "diffbox";
  const title = document.createElement("div");
  title.className = "diff-title";
  title.textContent = "Summary";
  const pre = document.createElement("pre");
  pre.className = "diff-pre";
  pre.textContent = summary;
  box.append(title, pre);

  body.append(intro, box);
  return body;
}

export function createUI({ getState, setState, persistActiveDoc, onSync, onImport, onExport, onShare, onImportFile, onResolveConflict }){
  const els = {

    tabMy: document.getElementById("tabMy"),
    tabShared: document.getElementById("tabShared"),
    btnNewList: document.getElementById("btnNewList"),
    btnImportShared: document.getElementById("btnImportShared"),
    btnImportFile: document.getElementById("btnImportFile"),

    listsContainer: document.getElementById("listsContainer"),
    emptyState: document.getElementById("emptyState"),
    listView: document.getElementById("listView"),

    listTitle: document.getElementById("listTitle"),
    modeEdit: document.getElementById("modeEdit"),
    modeShop: document.getElementById("modeShop"),
    toggleHideChecked: document.getElementById("toggleHideChecked"),

    btnAddCategory: document.getElementById("btnAddCategory"),
    categoryTree: document.getElementById("categoryTree"),

    itemsTitle: document.getElementById("itemsTitle"),
    itemsCount: document.getElementById("itemsCount"),
    newItemInput: document.getElementById("newItemInput"),
    btnQuickAdd: document.getElementById("btnQuickAdd"),
    btnAddItem: document.getElementById("btnAddItem"),
    itemsContainer: document.getElementById("itemsContainer"),

    btnDeleteList: document.getElementById("btnDeleteList"),
    btnShare: document.getElementById("btnShare"),
    btnExport: document.getElementById("btnExport"),
    btnFocus: document.getElementById("btnFocus"),
    driveInfo: document.getElementById("driveInfo"),

    // conflict UX
    conflictBanner: document.getElementById("conflictBanner"),
    conflictSubtitle: document.getElementById("conflictSubtitle"),
    btnResolveConflict: document.getElementById("btnResolveConflict"),
    btnDismissConflict: document.getElementById("btnDismissConflict"),
  };

  // Dialogs are async, unlike the native prompt/confirm they replaced. The 10s
  // poller in app.js can swap state.activeDoc for a freshly loaded object while
  // a dialog is open; a handler still holding the old reference would mutate a
  // detached doc, and persistActiveDoc() would then write the *new* one — the
  // change would be silently lost. So re-read the doc after every await.
  function liveDoc(listId){
    const doc = getState().activeDoc;
    if(!doc || doc.listId !== listId) return null;
    return doc;
  }

  let dragCategoryId = null;

  function clearDropTargets(){
    document.querySelectorAll(".node").forEach(el => {
      el.classList.remove("drop-target", "drop-before", "drop-after");
    });
  }

  // ---- Category overflow menu --------------------------------------------
  // The popover lives on <body>, positioned against the button's rect: inside
  // the row it would be clipped by the panel's scrolling and would sit inside
  // the row's own drag handlers.

  let openMenu = null;   // { el, btn } | null

  function closeMenu(){
    if(!openMenu) return;
    const { el, btn } = openMenu;
    openMenu = null;
    el.remove();
    btn?.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onMenuKey, true);
  }

  function onMenuKey(e){
    if(e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    const btn = openMenu?.btn;
    closeMenu();
    btn?.focus();
  }

  function openCategoryMenu(btn, categoryId){
    closeMenu();

    const el = document.createElement("div");
    el.className = "menu";
    el.setAttribute("role", "menu");

    const entries = [{ act: "add", label: "Add subcategory" }];
    if(categoryId !== "c_root"){
      entries.push({ act: "rename", label: "Rename" });
      entries.push({ act: "del", label: "Delete", danger: true });
    }

    for(const entry of entries){
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.textContent = entry.label;
      if(entry.danger) b.className = "danger";
      b.addEventListener("click", async () => {
        closeMenu();
        await handleCategoryAction(categoryId, entry.act);
      });
      el.appendChild(b);
    }

    document.body.appendChild(el);

    const r = btn.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = el;
    el.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    el.style.top  = `${r.bottom + h + 8 > window.innerHeight ? r.top - h - 6 : r.bottom + 6}px`;

    btn.setAttribute("aria-expanded", "true");
    openMenu = { el, btn };
    document.addEventListener("keydown", onMenuKey, true);
    el.querySelector("button")?.focus();
  }

  document.addEventListener("click", (e) => {
    if(!openMenu) return;
    if(openMenu.el.contains(e.target) || e.target === openMenu.btn) return;
    closeMenu();
  });
  window.addEventListener("scroll", closeMenu, true);
  
  const debouncedSaveTitle = debounce(async () => {
    const st = getState();
    if(!st.activeDoc) return;
    st.activeDoc.title = els.listTitle.value.trim() || "Untitled";
    markDirty(st.activeDoc);
    await persistActiveDoc();
    render();
  }, 450);

  function bind(){
    els.listTitle.addEventListener("input", debouncedSaveTitle);

    els.btnFocus.addEventListener("click", () => {
      toggleFocus();
      render();
    });

    els.modeEdit.addEventListener("click", async () => {
      const st = getState();
      if(!st.activeDoc) return;
      setMode(st.activeDoc, "edit");
      await persistActiveDoc();
      render();
    });

    els.modeShop.addEventListener("click", async () => {
      const st = getState();
      if(!st.activeDoc) return;
      setMode(st.activeDoc, "shopping");
      await persistActiveDoc();
      render();
    });

    els.toggleHideChecked.addEventListener("change", async () => {
      const st = getState();
      if(!st.activeDoc) return;
      setHideChecked(st.activeDoc, els.toggleHideChecked.checked);
      await persistActiveDoc();
      render();
    });

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

    els.btnQuickAdd.addEventListener("click", async () => {
      await quickAddItem();
    });

    els.newItemInput.addEventListener("keydown", async (e) => {
      if(e.key === "Enter"){
        e.preventDefault();
        await quickAddItem();
      }
    });

    els.btnAddItem.addEventListener("click", async () => {
      await quickAddItem();
    });

    els.btnExport.addEventListener("click", () => {
      const st = getState();
      if(!st.activeDoc) return;
      onExport?.();
    });

    els.btnShare.addEventListener("click", async () => {
      const st = getState();
      if(!st.activeDoc) return;
      await onShare?.();
    });

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

    // Conflict banner actions
    els.btnResolveConflict.addEventListener("click", async () => {
      const st = getState();
      if(!st.conflict.pending || !st.conflict.remoteDoc || !st.activeDoc) return;

      const strategy = await showChoice({
        title: "Resolve conflict",
        body: buildConflictBody(buildConflictSummary(st.activeDoc, st.conflict.remoteDoc)),
        // .modal-footer is right-aligned, so the last button sits rightmost:
        // Auto-merge stays the primary action closest to the thumb.
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

    els.btnDismissConflict.addEventListener("click", () => {
      // Dismiss banner but keep pending conflict (user can Sync to see it again)
      els.conflictBanner.classList.add("hidden");
    });

    els.tabMy.addEventListener("click", () => {
        const st = getState();
        st.activeTab = "my";
        setState(st);
        render();
      });

      els.tabShared.addEventListener("click", () => {
        const st = getState();
        st.activeTab = "shared";
        setState(st);
        render();
      });

      els.btnNewList.addEventListener("click", async () => {
        const st = getState();
        await st.actions.createList();
        render();
      });

      els.btnImportShared.addEventListener("click", async () => {
        const st = getState();
        await st.actions.importShared();
        render();
      });

      els.btnImportFile.addEventListener("click", () => {
        // Opens the file picker; app.js re-renders once the file is handled.
        onImportFile?.();
      });

  }

  async function quickAddItem(){
    const st = getState();
    if(!st.activeDoc) return;

    const label = els.newItemInput.value.trim();
    if(!label) return;

    const categoryId = st.selectedCategoryId || "c_root";
    addItem(st.activeDoc, { label, categoryId });
    els.newItemInput.value = "";
    await persistActiveDoc();
    render();
  }

  function renderLists(){

    const st = getState();
    els.listsContainer.innerHTML = "";

    const tab = st.activeTab || "my";
    const filtered = st.lists.filter(d => (d.origin || "my") === tab);

    const sorted = [...filtered].sort((a,b) => (b.updatedAt||0) - (a.updatedAt||0));

    for(const doc of sorted){
      const card = document.createElement("div");
      card.className = "list-card" + (st.activeListId === doc.listId ? " active" : "");
      card.innerHTML = `
        <div class="name">${escapeHtml(doc.title || "Untitled")}</div>
        <div class="meta">
          ${doc.mode === "edit" ? "✏️ Edit" : "🛒 Shopping"} •
          ${doc.items.filter(i => !i.deletedAt).length} items
          ${doc.dirty ? " • <span style='color:var(--primary)'>unsynced</span>" : ""}
          ${doc.sync?.driveFileId ? " • <span class='muted'>Drive</span>" : ""}
        </div>
      `;
      card.addEventListener("click", async () => {
        await st.actions.selectList(doc.listId);
        render();
      });
      els.listsContainer.appendChild(card);
    }
  }

  function renderCategoryTree(){
    const st = getState();
    const doc = st.activeDoc;
    if(!doc) return;

    const root = buildTree(doc.categories);
    if(!root){
      els.categoryTree.innerHTML = "<div class='muted small'>No categories</div>";
      return;
    }

    // Flatten once
    const flat = flattenTree(root);

    // Build quick lookup maps
    const childrenCountById = new Map();
    const parentById = new Map();

    for(const { node } of flat){
      parentById.set(node.id, node.parentId);
      childrenCountById.set(node.id, (node.children || []).length);
    }

    // Helper: a node is visible if none of its ancestors are collapsed
    const isVisible = (nodeId) => {
      let cur = parentById.get(nodeId);
      while(cur){
        if(collapsedCategoryIds.has(cur)) return false;
        cur = parentById.get(cur);
      }
      return true;
    };

    els.categoryTree.innerHTML = "";

    for(const { node, depth } of flat){
      if(node.deletedAt) continue;
      if(!isVisible(node.id)) continue;

      const canCollapse = (childrenCountById.get(node.id) || 0) > 0;
      const isCollapsed = collapsedCategoryIds.has(node.id);

      const row = document.createElement("div");
      row.className = "node";

      row.innerHTML = `
      <div class="left">
        <div class="indent" style="margin-left:${depth*14}px"></div>

        ${canCollapse
          ? `<span class="twisty" data-twisty="1" title="${isCollapsed ? "Expand" : "Collapse"}">
              ${isCollapsed ? "▶" : "▼"}
            </span>`
          : `<span style="width:22px; display:inline-block;"></span>`
      }

        ${node.id !== "c_root"
          ? `<span class="handle" title="Drag to move" draggable="true" data-handle="1">⋮⋮</span>`
          : `<span style="width:34px; display:inline-block;"></span>`
      }

        <div class="name">${escapeHtml(node.name)}</div>
      </div>

      <div class="actions">
        <button class="iconbtn menubtn" type="button" data-menu="1"
                aria-haspopup="menu" aria-expanded="false"
                title="Category actions" aria-label="Actions for ${escapeHtml(node.name)}">⋯</button>
      </div>
    `;

      // Selected highlight
      if(st.selectedCategoryId === node.id){
        row.style.outline = "2px solid rgba(59,130,246,.45)";
      }

      // Collapse/expand
      const twisty = row.querySelector("[data-twisty='1']");
      if(twisty){
        twisty.addEventListener("click", (e) => {
          e.stopPropagation();
          if(collapsedCategoryIds.has(node.id)) collapsedCategoryIds.delete(node.id);
          else collapsedCategoryIds.add(node.id);
          render();
        });
      }

      // Row click selects category
      row.addEventListener("click", () => {
        st.selectedCategoryId = node.id;
        setState(st);
        render();
      });

      // Overflow menu. The four inline buttons it replaces took half the row
      // and wrapped, which is what truncated the names.
      const menuBtn = row.querySelector("[data-menu='1']");
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if(openMenu && openMenu.btn === menuBtn){ closeMenu(); return; }
        openCategoryMenu(menuBtn, node.id);
      });

      // Drag & drop (keeps your previous logic)
      const handle = row.querySelector("[data-handle='1']");
      if(handle){
        handle.addEventListener("dragstart", (e) => {
          dragCategoryId = node.id;
          row.classList.add("dragging");
          clearDropTargets();
          e.dataTransfer.setData("text/plain", node.id);
          e.dataTransfer.effectAllowed = "move";
        });
        handle.addEventListener("dragend", () => {
          dragCategoryId = null;
          row.classList.remove("dragging");
          clearDropTargets();
        });
      }

      row.addEventListener("dragover", (e) => {
        if(!dragCategoryId) return;
        if(node.id === dragCategoryId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";

        // Determine drop position based on mouse Y position
        const rect = row.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const height = rect.height;

        // Clear all drop target classes
        row.classList.remove("drop-target", "drop-before", "drop-after");

        // Check if source and target are siblings
        const st2 = getState();
        const doc2 = st2.activeDoc;
        if(!doc2) return;

        const dragCat = doc2.categories.find(c => c.id === dragCategoryId && !c.deletedAt);
        const targetCat = doc2.categories.find(c => c.id === node.id && !c.deletedAt);

        if(dragCat && targetCat && dragCat.parentId === targetCat.parentId){
          // Siblings - show before/after indicators
          if(y < height * 0.33){
            row.classList.add("drop-before");
          }else if(y > height * 0.67){
            row.classList.add("drop-after");
          }else{
            row.classList.add("drop-target");
          }
        }else{
          // Different levels - nest as child
          row.classList.add("drop-target");
        }
      });

      row.addEventListener("dragleave", () => {
        row.classList.remove("drop-target", "drop-before", "drop-after");
      });

      row.addEventListener("drop", async (e) => {
        if(!dragCategoryId) return;
        e.preventDefault();

        const st2 = getState();
        const doc2 = st2.activeDoc;
        if(!doc2) return;

        const fromId = e.dataTransfer.getData("text/plain") || dragCategoryId;

        // Determine drop position
        const rect = row.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const height = rect.height;

        const dragCat = doc2.categories.find(c => c.id === fromId && !c.deletedAt);
        const targetCat = doc2.categories.find(c => c.id === node.id && !c.deletedAt);

        row.classList.remove("drop-target", "drop-before", "drop-after");

        try{
          if(dragCat && targetCat && dragCat.parentId === targetCat.parentId){
            // Siblings - reorder
            if(y < height * 0.33){
              reorderCategory(doc2, fromId, node.id, "before");
            }else if(y > height * 0.67){
              reorderCategory(doc2, fromId, node.id, "after");
            }else{
              // Middle - nest as child
              moveCategory(doc2, fromId, node.id);
            }
          }else{
            // Different levels - nest as child
            moveCategory(doc2, fromId, node.id);
          }
          await persistActiveDoc();
          render();
        }catch(err){
          await showAlert(err.message, { title: "Cannot move category" });
        }
      });

      els.categoryTree.appendChild(row);
    }
  }

  async function handleCategoryAction(categoryId, act){
    const st = getState();
    const doc = st.activeDoc;
    if(!doc) return;

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

      const name = await showPrompt("New name?", {
        title: "Rename category", value: c.name, confirmLabel: "Rename"
      });
      if(!name) return;

      // The poller may have deleted this category remotely while the dialog
      // was open, so look it up again on the live doc.
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

    render();
  }

  /** Indentation step, capped so a deep tree cannot run off a phone screen. */
  function depthClass(depth){
    return ` d${Math.min(depth, 4)}`;
  }

  function renderItems(){
    const st = getState();
    const doc = st.activeDoc;
    if(!doc) return;

    const wanted = st.selectedCategoryId || "c_root";
    const scope = doc.categories.find(c => c.id === wanted && !c.deletedAt);
    const scopeId = scope ? wanted : "c_root";
    const scopeName = scope ? scope.name : "All";

    const { rows, total } = buildItemsOutline(doc, scopeId, {
      mode: doc.mode,
      hideChecked: doc.ui.hideChecked,
      collapsed: collapsedSectionIds
    });

    els.itemsTitle.textContent = scopeId === "c_root" ? "Items" : `Items — ${scopeName}`;
    els.itemsCount.textContent = String(total);

    els.itemsContainer.classList.add("outline");
    els.itemsContainer.innerHTML = "";

    for(const row of rows){
      if(row.kind === "item"){
        els.itemsContainer.appendChild(buildItemRow(doc, row));
        continue;
      }

      els.itemsContainer.appendChild(buildSectionRow(row));

      if(addDraft && addDraft.categoryId === row.id && !row.collapsed){
        els.itemsContainer.appendChild(buildAddRow(doc, row));
      }
    }

    if(total === 0){
      const empty = document.createElement("div");
      empty.className = "items-empty muted small";
      empty.textContent = doc.ui.hideChecked
        ? "Everything here is checked off."
        : `Nothing in “${scopeName}” yet.`;
      els.itemsContainer.appendChild(empty);
    }

    // The open add row is module state, so restore focus and caret after the
    // re-render that its own save just triggered.
    if(addDraft){
      const input = els.itemsContainer.querySelector("[data-add-input='1']");
      if(input){
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
  }

  function buildSectionRow(row){
    const el = document.createElement("div");
    el.className = "sec" + depthClass(row.depth)
      + (row.depth === 0 ? " sec-root" : "")
      + (row.empty ? " sec-empty" : "")
      + (row.orphan ? " sec-orphan" : "");
    el.dataset.section = row.id;
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-expanded", row.collapsed ? "false" : "true");

    const twisty = document.createElement("span");
    twisty.className = "twisty";
    twisty.setAttribute("aria-hidden", "true");
    twisty.textContent = row.collapsed ? "▶" : "▼";

    const name = document.createElement("span");
    name.className = "sec-name";
    name.textContent = row.name;

    const rule = document.createElement("span");
    rule.className = "sec-rule";

    const count = document.createElement("span");
    count.className = "sec-count";
    count.textContent = String(row.count);

    el.append(twisty, name, rule, count);

    // "Uncategorized" is a synthetic section, not a real category — there is
    // nothing to add an item to.
    if(row.id !== ORPHAN_SECTION_ID){
      const add = document.createElement("button");
      add.type = "button";
      add.className = "iconbtn sec-add";
      add.textContent = "➕";
      add.title = `Add an item to ${row.name}`;
      add.setAttribute("aria-label", `Add an item to ${row.name}`);
      add.addEventListener("click", (e) => {
        e.stopPropagation();
        collapsedSectionIds.delete(row.id);   // or the new item lands out of sight
        addDraft = { categoryId: row.id, text: "" };
        render();
      });
      el.appendChild(add);
    }

    // A header folds and nothing else. The panel's scope *is* the selection,
    // so selecting from here would re-scope and collapse the very outline you
    // clicked inside.
    const toggle = () => {
      if(collapsedSectionIds.has(row.id)) collapsedSectionIds.delete(row.id);
      else collapsedSectionIds.add(row.id);
      render();
    };

    el.addEventListener("click", toggle);
    el.addEventListener("keydown", (e) => {
      if(e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggle();
    });

    return el;
  }

  function buildItemRow(doc, row){
    const it = row.item;

    const el = document.createElement("div");
    el.className = "item" + depthClass(row.depth) + (it.checked ? " checked" : "");
    el.innerHTML = `
      <div class="item-left">
        <input type="checkbox" ${it.checked ? "checked" : ""} />
        <div class="label">${escapeHtml(it.label)}</div>
      </div>
      <div class="row gap">
        ${doc.mode === "edit" ? `<button class="btn btn-small" data-act="edit">Edit</button>` : ""}
        ${doc.mode === "edit" ? `<button class="btn btn-small btn-danger" data-act="del">Delete</button>` : ""}
      </div>
    `;

    const checkbox = el.querySelector("input[type=checkbox]");
    checkbox.addEventListener("change", async () => {
      toggleItemChecked(doc, it.id);
      await persistActiveDoc();
      render();
    });

    const editBtn = el.querySelector("button[data-act=edit]");
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

    const delBtn = el.querySelector("button[data-act=del]");
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

    return el;
  }

  /**
   * The inline row under a section header. Enter files the item and leaves the
   * row open, cleared — building a list means typing several items into one
   * aisle without reaching for the mouse between each.
   */
  function buildAddRow(doc, row){
    const el = document.createElement("div");
    el.className = "inline-add" + depthClass(row.depth + 1);

    const input = document.createElement("input");
    input.className = "input";
    input.dataset.addInput = "1";
    input.value = addDraft.text;
    input.placeholder = `New item in ${row.name}…`;
    input.setAttribute("aria-label", `New item in ${row.name}`);

    const hint = document.createElement("span");
    hint.className = "inline-add-hint";
    hint.textContent = "↵ add · esc close";

    input.addEventListener("input", () => { addDraft.text = input.value; });

    input.addEventListener("keydown", async (e) => {
      if(e.key === "Escape"){
        e.preventDefault();
        addDraft = null;
        render();
        return;
      }
      if(e.key !== "Enter") return;

      e.preventDefault();
      const label = input.value.trim();
      if(!label) return;

      const listId = doc.listId;
      addItem(doc, { label, categoryId: row.id });
      addDraft.text = "";
      await persistActiveDoc();

      // The poller can swap the active doc while an add row is open.
      if(!liveDoc(listId)){ addDraft = null; }
      render();
    });

    el.append(input, hint);
    return el;
  }

  function renderConflict(){
    const st = getState();
    if(st.conflict.pending){
      els.conflictBanner.classList.remove("hidden");
      els.conflictSubtitle.textContent = "Remote changes detected while you edited locally. Click Resolve to choose.";
    }else{
      els.conflictBanner.classList.add("hidden");
    }
  }

  function renderFocusButton(){
    const on = isFocusWanted();
    els.btnFocus.setAttribute("aria-pressed", on ? "true" : "false");
    els.btnFocus.title = on ? "Exit focus mode (Esc)" : "Focus mode \u2014 hide the app chrome";
    els.btnFocus.querySelector(".focus-icon").textContent = on ? "\u2921" : "\u2922";
    els.btnFocus.querySelector(".focus-label").textContent = on ? "Exit focus" : "Focus";
  }

  function renderHeader(){
    const st = getState();
    const doc = st.activeDoc;

    if(!doc){
      els.emptyState.classList.remove("hidden");
      els.listView.classList.add("hidden");
      applyFocus(false);
      return;
    }

    applyFocus(true);
    renderFocusButton();

    const footerbar = document.querySelector(".footerbar");
    if(footerbar){
      footerbar.classList.toggle("hidden", doc.mode === "shopping");
    }
    
    els.emptyState.classList.add("hidden");
    els.listView.classList.remove("hidden");

    els.listTitle.value = doc.title || "";
    els.toggleHideChecked.checked = !!doc.ui.hideChecked;

    els.modeEdit.classList.toggle("active", doc.mode === "edit");
    els.modeShop.classList.toggle("active", doc.mode === "shopping");

    const signedIn = st.auth.isSignedIn;
    els.btnShare.disabled = !signedIn;

    els.driveInfo.textContent = signedIn
      ? (doc.sync.driveFileId ? `Drive file: ${doc.sync.driveFileId} • ${doc.dirty ? "Unsynced" : "Synced"}` : "Not yet created on Drive")
      : "Sign in to enable Drive sync & sharing";
  }

  function renderTabButtons(){
    const st = getState();
    const tab = st.activeTab || "my";
    els.tabMy.classList.toggle("active", tab === "my");
    els.tabShared.classList.toggle("active", tab === "shared");

    // My tab creates lists (from scratch or from a file); Shared adopts one
    // from a Drive link.
    els.btnNewList.style.display = (tab === "my") ? "" : "none";
    els.btnImportFile.style.display = (tab === "my") ? "" : "none";
    els.btnImportShared.style.display = (tab === "shared") ? "" : "none";
  }

  function render(){
    renderTabButtons();
    renderLists();
    renderHeader();
    renderConflict();

    const st = getState();
    if(!st.activeDoc) return;

    renderCategoryTree();
    renderItems();
  }

  bind();
  return { render };
}