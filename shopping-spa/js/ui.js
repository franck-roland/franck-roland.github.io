import { buildTree, flattenTree } from "./tree.js";
import { escapeHtml, debounce } from "./util.js";
import {
  addItem, deleteItem, toggleItemChecked, updateItem,
  upsertCategory, deleteCategory,
  setMode, setHideChecked, markDirty
} from "./model.js";
import { buildConflictSummary } from "./conflictDiff.js";

export function createUI({ getState, setState, persistActiveDoc, onSync, onImport, onResolveConflict }){
  const els = {
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
    driveInfo: document.getElementById("driveInfo"),

    // conflict UX
    conflictBanner: document.getElementById("conflictBanner"),
    conflictSubtitle: document.getElementById("conflictSubtitle"),
    btnResolveConflict: document.getElementById("btnResolveConflict"),
    btnDismissConflict: document.getElementById("btnDismissConflict"),

    // modal
    modalOverlay: document.getElementById("modalOverlay"),
    btnModalClose: document.getElementById("btnModalClose"),
    conflictDiff: document.getElementById("conflictDiff"),
    btnConflictMerge: document.getElementById("btnConflictMerge"),
    btnConflictMine: document.getElementById("btnConflictMine"),
    btnConflictRemote: document.getElementById("btnConflictRemote"),
  };

  const debouncedSaveTitle = debounce(async () => {
    const st = getState();
    if(!st.activeDoc) return;
    st.activeDoc.title = els.listTitle.value.trim() || "Untitled";
    markDirty(st.activeDoc);
    await persistActiveDoc();
    render();
  }, 450);

  function openModal(){
    els.modalOverlay.classList.remove("hidden");
  }
  function closeModal(){
    els.modalOverlay.classList.add("hidden");
  }

  function bind(){
    els.listTitle.addEventListener("input", debouncedSaveTitle);

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
      const parentId = st.selectedCategoryId || "c_root";
      const name = prompt("Category name?");
      if(!name) return;
      upsertCategory(st.activeDoc, { name: name.trim(), parentId });
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
      if(!confirm(`Delete list "${st.activeDoc.title}"?`)) return;
      await st.actions.deleteList(st.activeDoc.listId);
      render();
    });

    // Conflict banner actions
    els.btnResolveConflict.addEventListener("click", () => {
      const st = getState();
      if(!st.conflict.pending || !st.conflict.remoteDoc || !st.activeDoc) return;
      const summary = buildConflictSummary(st.activeDoc, st.conflict.remoteDoc);
      els.conflictDiff.textContent = summary;
      openModal();
    });

    els.btnDismissConflict.addEventListener("click", () => {
      // Dismiss banner but keep pending conflict (user can Sync to see it again)
      els.conflictBanner.classList.add("hidden");
    });

    // Modal close
    els.btnModalClose.addEventListener("click", closeModal);
    els.modalOverlay.addEventListener("click", (e) => {
      if(e.target === els.modalOverlay) closeModal();
    });

    // Conflict resolution buttons
    els.btnConflictMerge.addEventListener("click", async () => {
      closeModal();
      await onResolveConflict("merge");
      render();
    });
    els.btnConflictMine.addEventListener("click", async () => {
      closeModal();
      await onResolveConflict("mine");
      render();
    });
    els.btnConflictRemote.addEventListener("click", async () => {
      closeModal();
      await onResolveConflict("remote");
      render();
    });

    els.itemCategorySelect.addEventListener("change", async () => {
      const st = getState();
      st.selectedCategoryId = els.itemCategorySelect.value || "c_root";
      setState(st);
      render();
    });
  }

  async function quickAddItem(){
    const st = getState();
    if(!st.activeDoc) return;

    const label = els.newItemInput.value.trim();
    if(!label) return;

    const categoryId = els.itemCategorySelect.value || "c_root";
    addItem(st.activeDoc, { label, categoryId });
    els.newItemInput.value = "";
    await persistActiveDoc();
    render();
  }

  function renderLists(){
    const st = getState();
    els.listsContainer.innerHTML = "";

    const sorted = [...st.lists].sort((a,b) => (b.updatedAt||0) - (a.updatedAt||0));
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
    const flat = flattenTree(root);

    els.categoryTree.innerHTML = "";
    for(const { node, depth } of flat){
      const row = document.createElement("div");
      row.className = "node";
      row.innerHTML = `
        <div class="left">
          <div class="indent" style="margin-left:${depth*14}px"></div>
          <div class="name">${escapeHtml(node.name)}</div>
        </div>
        <div class="actions">
          <button class="iconbtn" data-act="select" title="Select">🎯</button>
          <button class="iconbtn" data-act="add" title="Add subcategory">➕</button>
          ${node.id !== "c_root" ? `<button class="iconbtn" data-act="rename" title="Rename">✏️</button>` : ""}
          ${node.id !== "c_root" ? `<button class="iconbtn" data-act="del" title="Delete">🗑️</button>` : ""}
        </div>
      `;

      const buttons = row.querySelectorAll("button[data-act]");
      buttons.forEach(btn => btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const act = btn.getAttribute("data-act");
        await handleCategoryAction(node.id, act);
      }));

      row.addEventListener("click", async () => {
        st.selectedCategoryId = node.id;
        setState(st);
        render();
      });

      if(st.selectedCategoryId === node.id){
        row.style.outline = "2px solid rgba(59,130,246,.45)";
      }

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
      const name = prompt("Subcategory name?");
      if(!name) return;
      upsertCategory(doc, { name: name.trim(), parentId: categoryId });
      st.selectedCategoryId = categoryId;
      setState(st);
      await persistActiveDoc();
    }

    if(act === "rename"){
      const c = doc.categories.find(x => x.id === categoryId && !x.deletedAt);
      if(!c) return;
      const name = prompt("New name?", c.name);
      if(!name) return;
      upsertCategory(doc, { id: c.id, name: name.trim(), parentId: c.parentId });
      await persistActiveDoc();
    }

    if(act === "del"){
      if(!confirm("Delete this category and all subcategories? Items will be moved to root.")) return;
      deleteCategory(doc, categoryId);
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
          const newLabel = prompt("Item label:", it.label);
          if(!newLabel) return;
          updateItem(doc, it.id, { label: newLabel.trim() });
          await persistActiveDoc();
          render();
        });
      }

      const delBtn = row.querySelector("button[data-act=del]");
      if(delBtn){
        delBtn.addEventListener("click", async () => {
          if(!confirm("Delete item?")) return;
          deleteItem(doc, it.id);
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

  function renderHeader(){
    const st = getState();
    const doc = st.activeDoc;

    if(!doc){
      els.emptyState.classList.remove("hidden");
      els.listView.classList.add("hidden");
      return;
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

  function render(){
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