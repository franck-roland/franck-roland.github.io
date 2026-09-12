import { buildTree, flattenTree } from "./tree.js";
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

export function createUI({ getState, setState, persistActiveDoc, onSync, onImport, onResolveConflict }){
  const els = {

    tabMy: document.getElementById("tabMy"),
    tabShared: document.getElementById("tabShared"),
    btnNewList: document.getElementById("btnNewList"),
    btnImport: document.getElementById("btnImport"),

    listsContainer: document.getElementById("listsContainer"),
    emptyState: document.getElementById("emptyState"),
    listView: document.getElementById("listView"),

    listTitle: document.getElementById("listTitle"),
    modeEdit: document.getElementById("modeEdit"),
    modeShop: document.getElementById("modeShop"),
    toggleHideChecked: document.getElementById("toggleHideChecked"),

    btnAddCategory: document.getElementById("btnAddCategory"),
    categoryTree: document.getElementById("categoryTree"),

    itemCategorySelect: document.getElementById("itemCategorySelect"),
    newItemInput: document.getElementById("newItemInput"),
    btnQuickAdd: document.getElementById("btnQuickAdd"),
    btnAddItem: document.getElementById("btnAddItem"),
    itemsContainer: document.getElementById("itemsContainer"),

    btnDeleteList: document.getElementById("btnDeleteList"),
    btnShare: document.getElementById("btnShare"),
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

    els.itemCategorySelect.addEventListener("change", async () => {
      const st = getState();
      st.selectedCategoryId = els.itemCategorySelect.value || "c_root";
      setState(st);
      render();
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

      els.btnImport.addEventListener("click", async () => {
        const st = getState();
        await st.actions.importShared();
        render();
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
        <button class="iconbtn" data-act="select" title="Select">🎯</button>
        <button class="iconbtn" data-act="add" title="Add subcategory">➕</button>
        ${node.id !== "c_root" ? `<button class="iconbtn" data-act="rename" title="Rename">✏️</button>` : ""}
        ${node.id !== "c_root" ? `<button class="iconbtn" data-act="del" title="Delete">🗑️</button>` : ""}
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

      // Action buttons
      row.querySelectorAll("button[data-act]").forEach(btn => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const act = btn.getAttribute("data-act");
          await handleCategoryAction(node.id, act);
        });
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

    if(act === "select"){
      st.selectedCategoryId = categoryId;
      setState(st);
    }

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

  function renderCategorySelect(){
    const st = getState();
    const doc = st.activeDoc;
    if(!doc) return;

    const root = buildTree(doc.categories);
    const flat = flattenTree(root);

    els.itemCategorySelect.innerHTML = "";
    for(const { node, depth } of flat){
      const opt = document.createElement("option");
      opt.value = node.id;
      opt.textContent = `${"—".repeat(depth)} ${node.name}`;
      els.itemCategorySelect.appendChild(opt);
    }

    els.itemCategorySelect.value = st.selectedCategoryId || "c_root";
  }

  function renderItems(){
    const st = getState();
    const doc = st.activeDoc;
    if(!doc) return;

    const categoriesById = new Map(
      doc.categories.filter(c => !c.deletedAt).map(c => [c.id, c.name])
    );

    const selectedCat = st.selectedCategoryId || "c_root";

    const items = doc.items
      .filter(i => !i.deletedAt)
      .filter(i => (selectedCat ? (i.categoryId === selectedCat || selectedCat === "c_root") : true))
      .filter(i => (doc.ui.hideChecked ? !i.checked : true))
      .sort((a,b) => (a.checked === b.checked) ? (a.label||"").localeCompare(b.label||"") : (a.checked ? 1 : -1));

    els.itemsContainer.innerHTML = "";
    for(const it of items){
      const catName = categoriesById.get(it.categoryId) || "—";
      const row = document.createElement("div");
      row.className = "item" + (it.checked ? " checked" : "");
      row.innerHTML = `
        <div class="item-left">
          <input type="checkbox" ${it.checked ? "checked" : ""} />
          <div>
            <div class="label">${escapeHtml(it.label)}</div>
            <div class="cat">${escapeHtml(catName)}</div>
          </div>
        </div>
        <div class="row gap">
          ${doc.mode === "edit" ? `<button class="btn btn-small" data-act="edit">Edit</button>` : ""}
          ${doc.mode === "edit" ? `<button class="btn btn-small btn-danger" data-act="del">Delete</button>` : ""}
        </div>
      `;

      const checkbox = row.querySelector("input[type=checkbox]");
      checkbox.addEventListener("change", async () => {
        toggleItemChecked(doc, it.id);
        await persistActiveDoc();
        render();
      });

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

      els.itemsContainer.appendChild(row);
    }
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

    // In My tab: show New, hide Import; in Shared tab: show Import, hide New
    els.btnNewList.style.display = (tab === "my") ? "" : "none";
    els.btnImport.style.display = (tab === "shared") ? "" : "none";
  }

  function render(){
    renderTabButtons();
    renderLists();
    renderHeader();
    renderConflict();

    const st = getState();
    if(!st.activeDoc) return;

    renderCategoryTree();
    renderCategorySelect();
    renderItems();
  }

  bind();
  return { render };
}