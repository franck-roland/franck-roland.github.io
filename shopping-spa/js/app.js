import { DB } from "./db.js";
import { createNewListDoc, normalizeDoc } from "./model.js";
import { createUI } from "./ui.js";
import { DriveAuth } from "./driveAuth.js";
import { DriveSync } from "./driveSync.js";
import { extractDriveFileId } from "./util.js";
import { isFocusWanted, setFocusWanted } from "./focus.js";
import { showAlert, showChoice, showConfirm, showPrompt } from "./modal.js";
import { serializeDoc, parseImport, replaceDocContents, exportFilename } from "./transfer.js";

const els = {
  btnSignIn: document.getElementById("btnSignIn"),
  btnSignOut: document.getElementById("btnSignOut"),
  btnSync: document.getElementById("btnSync"),
  syncStatus: document.getElementById("syncStatus"),

  authGate: document.getElementById("authGate"),
  btnSignInGate: document.getElementById("btnSignInGate"),
  authGateStatus: document.getElementById("authGateStatus"),
  
  btnToggleSidebar: document.getElementById("btnToggleSidebar"),
  sidebar: document.querySelector(".sidebar"),
  sidebarBackdrop: document.getElementById("sidebarBackdrop"),
  importFileInput: document.getElementById("importFileInput"),
};

let state = {
  lists: [],
  activeListId: null,
  activeDoc: null,
  selectedCategoryId: "c_root",

  // Tabs: "my" or "shared"
  activeTab: "my",

  auth: { isSignedIn: false },
  shoppingFolderId: null,

  conflict: { pending:false, remoteDoc:null },

  actions: null
};

function setState(next){ state = next; }
function getState(){ return state; }

async function loadAll(){
  const lists = (await DB.getAllLists()).map(normalizeDoc);
  state.lists = lists;

  // Keep active doc
  if(state.activeListId){
    state.activeDoc = lists.find(l => l.listId === state.activeListId) || null;
  }else{
    // pick first in current tab
    const first = lists.find(l => (l.origin||"my") === (state.activeTab||"my")) || lists[0] || null;
    state.activeListId = first?.listId || null;
    state.activeDoc = first;
  }
}

async function persistDoc(doc){
  await DB.putList(doc);
}

async function persistActiveDoc(){
  if(!state.activeDoc) return;
  await persistDoc(state.activeDoc);
  await loadAll();
}

function setSyncStatus(text){
  els.syncStatus.textContent = text;
}

function showAuthGate(show, msg=""){
  els.authGate.classList.toggle("show", !!show);
  els.authGateStatus.textContent = msg || "";
}

function refreshAuthUI(){
  const signedIn = DriveAuth.isSignedIn();
  state.auth.isSignedIn = signedIn;

  // Top bar buttons still exist, but sign-in is mandatory so gate overrides
  els.btnSignIn.disabled = signedIn;
  els.btnSignOut.disabled = !signedIn;
  els.btnSync.disabled = !signedIn || !state.activeDoc;

  if(!signedIn){
    showAuthGate(true, "Please sign in to load your lists from Drive.");
    setSyncStatus("Not signed in");
  }else{
    showAuthGate(false);
    setSyncStatus("Signed in");
  }
}

async function selectList(listId){
  state.activeListId = listId;
  state.activeDoc = await DB.getList(listId);
  state.activeDoc = state.activeDoc ? normalizeDoc(state.activeDoc) : null;
  state.selectedCategoryId = "c_root";
  state.conflict = { pending:false, remoteDoc:null };
  setState(state);
}

async function createList(){
  // Only in "my" tab
  if(!state.auth.isSignedIn) return;

  const title = await showPrompt("List title?", { title: "New list", value: "New list", confirmLabel: "Create" });
  if(title === null) return;

  // showPrompt already trims and returns null for an empty value.
  let doc = createNewListDoc(title);
  doc.origin = "my";

  // Ensure file exists in .shopping on creation (so it's properly organized)
  setSyncStatus("Creating list on Drive…");
  const folderId = state.shoppingFolderId || await DriveSync.ensureShoppingFolder();
  state.shoppingFolderId = folderId;

  doc = await DriveSync.ensureMyListFile(doc, folderId);
  await persistDoc(doc);

  await loadAll();
  state.activeTab = "my";
  state.activeListId = doc.listId;
  state.activeDoc = doc;
  setState(state);
  setSyncStatus("Ready ✅");
}

async function importShared(){
  if(!state.auth.isSignedIn){
    await showAlert("Sign in first.", { title: "Not signed in" });
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
    await showAlert("Could not extract a Drive fileId from that link.", { title: "Import failed" });
    return;
  }

  setSyncStatus("Importing shared list…");
  const doc = await DriveSync.importSharedByFileId(fileId);

  // Ensure listId exists
  doc.listId ||= ("import_" + fileId);
  doc.origin = "shared";
  await persistDoc(doc);

  await loadAll();
  state.activeTab = "shared";
  state.activeListId = doc.listId;
  state.activeDoc = doc;
  setState(state);
  setSyncStatus("Imported ✅");
}

function exportActiveList(){
  if(!state.activeDoc) return;

  const blob = new Blob([JSON.stringify(serializeDoc(state.activeDoc), null, 2)],
    { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = exportFilename(state.activeDoc);
  document.body.appendChild(a);
  a.click();
  a.remove();

  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  setSyncStatus("Exported ✅");
}

/** The import dialog's body: what is in the file, and the reset-checked option. */
function buildImportBody(imported, target){
  const wrap = document.createElement("div");

  const counts = document.createElement("div");
  const cats = imported.categories.filter(c => c.id !== "c_root").length;
  counts.textContent =
    `"${imported.title}" — ${imported.items.length} item(s), ${cats} categor${cats === 1 ? "y" : "ies"}.`;
  wrap.appendChild(counts);

  if(!target){
    const why = document.createElement("div");
    why.className = "muted small";
    why.textContent = state.activeDoc
      ? "A shared list cannot be replaced: it lives in someone else's Drive."
      : "Open one of your lists first if you want to replace it instead.";
    wrap.appendChild(why);
  }

  if(imported.items.some(i => i.checked)){
    const label = document.createElement("label");
    label.className = "checkbox";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = "importResetChecked";
    const span = document.createElement("span");
    span.textContent = "Start with all items unchecked";
    label.append(cb, span);
    wrap.appendChild(label);
  }

  return wrap;
}

async function importFromFile(file){
  let imported;
  try{
    imported = parseImport(await file.text());
  }catch(e){
    await showAlert(e.message, { title: "Import failed" });
    return;
  }

  // Only a list of mine can be replaced: a shared one points at someone else's
  // Drive file, and replacing it would push over their data.
  const target = (state.activeDoc && (state.activeDoc.origin || "my") === "my")
    ? state.activeDoc
    : null;

  const buttons = [{ label: "Cancel", value: null, kind: "ghost" }];
  if(target){
    const live = target.items.filter(i => !i.deletedAt).length;
    buttons.push({ label: `Replace "${target.title}" (${live})`, value: "replace", kind: "danger" });
  }
  buttons.push({ label: "Create a new list", value: "new", kind: "primary" });

  const body = buildImportBody(imported, target);
  const choice = await showChoice({ title: "Import list", body, buttons });
  if(!choice) return;

  // Read the checkbox before the dialog's node goes away.
  if(body.querySelector("#importResetChecked")?.checked){
    for(const i of imported.items) i.checked = false;
  }

  if(choice === "replace"){
    await replaceActiveList(target, imported);
  }else{
    await createListFromImport(imported);
  }
}

async function replaceActiveList(target, imported){
  const live = target.items.filter(i => !i.deletedAt).length;
  const ok = await showConfirm(
    `Replace the contents of "${target.title}" (${live} item(s)) with "${imported.title}" ` +
    `(${imported.items.length} item(s))?\n\n` +
    `This cannot be undone, and it reaches every device synced to this list.`,
    { title: "Replace list", confirmLabel: "Replace", danger: true }
  );
  if(!ok) return;

  // The poller may have swapped the active doc while the dialogs were open.
  const listId = target.listId;
  const current = state.lists.find(l => l.listId === listId) || state.activeDoc;
  if(!current || current.listId !== listId){
    await showAlert("That list is no longer open. Nothing was changed.", { title: "Import cancelled" });
    return;
  }

  setSyncStatus("Replacing list…");
  replaceDocContents(current, imported);
  state.activeDoc = current;
  await persistDoc(current);
  await loadAll();
  setState(state);
  setSyncStatus("Replaced ✅");
}

async function createListFromImport(doc){
  setSyncStatus("Creating list on Drive…");

  const folderId = state.shoppingFolderId || await DriveSync.ensureShoppingFolder();
  state.shoppingFolderId = folderId;

  const created = await DriveSync.ensureMyListFile(doc, folderId);
  await persistDoc(created);

  await loadAll();
  state.activeTab = "my";
  state.activeListId = created.listId;
  state.activeDoc = created;
  setState(state);
  setSyncStatus("Imported ✅");
}

async function initialSyncFromDrive(){
  // Called right after sign-in, mandatory:
  setSyncStatus("Loading lists from Drive…");

  const folderId = await DriveSync.ensureShoppingFolder();
  state.shoppingFolderId = folderId;

  const files = await DriveSync.listFolderListFiles(folderId);

  // Pull each file content and store/update local
  for(const f of files){
    try{
      const remoteDoc = await DriveSync.pullFileToDoc(f.id);
      remoteDoc.origin = "my";
      remoteDoc.sync.driveFolderId = folderId;
      // Try to preserve existing local changes (merge if needed)
      const local = await DB.getList(remoteDoc.listId);
      const merged = local ? normalizeDoc(local) : null;

      // If local exists and dirty, keep it dirty; but since this is initial sync,
      // we prefer remote as baseline and let normal sync handle conflicts later.
      await DB.putList(remoteDoc);
    }catch(e){
      console.warn("Failed pulling", f.id, e);
    }
  }

  await loadAll();
  setSyncStatus(`Loaded ${files.length} list(s) ✅`);
}

async function syncActive(){
  if(!state.activeDoc) return;
  if(!state.auth.isSignedIn) return;

  setSyncStatus("Syncing…");
  try{
    // Ensure correct folder for "my" lists
    if((state.activeDoc.origin || "my") === "my"){
      const folderId = state.shoppingFolderId || await DriveSync.ensureShoppingFolder();
      state.shoppingFolderId = folderId;
      if(!state.activeDoc.sync?.driveFileId){
        state.activeDoc = await DriveSync.ensureMyListFile(state.activeDoc, folderId);
      }
    }

    const res = await DriveSync.syncDetectConflict(state.activeDoc);
    if(res.status === "conflict"){
      state.conflict.pending = true;
      state.conflict.remoteDoc = res.remote;
      await persistActiveDoc();
      setSyncStatus("Conflict detected ⚠️");
      return;
    }

    state.activeDoc = res.doc;
    await persistDoc(res.doc);
    await loadAll();
    state.conflict = { pending:false, remoteDoc:null };
    setSyncStatus("Synced ✅");
  }catch(e){
    console.error(e);
    setSyncStatus("Sync failed: " + e.message);
  }
}

async function resolveConflict(strategy){
  if(!state.conflict.pending || !state.conflict.remoteDoc || !state.activeDoc) return;
  setSyncStatus("Resolving…");
  try{
    const resolved = await DriveSync.resolveConflict(state.activeDoc, state.conflict.remoteDoc, strategy);
    state.activeDoc = resolved;
    state.conflict = { pending:false, remoteDoc:null };
    await persistDoc(resolved);
    await loadAll();
    setSyncStatus("Resolved ✅");
  }catch(e){
    console.error(e);
    setSyncStatus("Resolve failed: " + e.message);
  }
}

async function deleteList(listId){
  if(!listId) return;

  // Optional: if it's a "my" list and you want to also delete from Drive,
  // you can add Drive deletion later. For now we delete locally only.
  await DB.deleteList(listId);
  await loadAll();

  // Pick a new active list in the current tab
  const tab = state.activeTab || "my";
  const next = state.lists.find(l => (l.origin || "my") === tab) || state.lists[0] || null;

  state.activeListId = next?.listId || null;
  state.activeDoc = next;
  state.selectedCategoryId = "c_root";
  state.conflict = { pending:false, remoteDoc:null };

  setState(state);
}

function startPolling(ui){
  setInterval(async () => {
    if(!state.auth.isSignedIn) return;
    if(!state.activeDoc) return;
    if(state.conflict.pending) return;
    if(!state.activeDoc.sync?.driveFileId) return;

    try{
      const res = await DriveSync.syncDetectConflict(state.activeDoc);
      if(res.status === "conflict"){
        state.conflict.pending = true;
        state.conflict.remoteDoc = res.remote;
        await persistActiveDoc();
        setSyncStatus("Conflict detected ⚠️");
        ui.render();
        return;
      }

      if(res.status !== "pulled_only" && res.status !== "merged_pushed") return;

      state.activeDoc = res.doc;
      await persistDoc(res.doc);
      await loadAll();
      ui.render();
    }catch(_e){
      // silent (offline/token issues)
    }
  }, 10_000);
}

async function boot(){
  await DriveAuth.init();
  await loadAll();

  state.actions = {
    selectList,
    createList,
    deleteList,
    importShared,
    persistActiveDoc,
    syncActive,
    resolveConflict
  };

  const ui = createUI({
    getState,
    setState,
    persistActiveDoc,
    onSync: syncActive,
    onImport: importShared,
    onExport: exportActiveList,
    onImportFile: () => els.importFileInput?.click(),
    onResolveConflict: resolveConflict
  });

  els.importFileInput?.addEventListener("change", async () => {
    const file = els.importFileInput.files?.[0];
    // Reset first, so picking the same file again still fires a change event.
    els.importFileInput.value = "";
    if(!file) return;

    try{
      await importFromFile(file);
    }catch(e){
      console.error(e);
      await showAlert(e.message, { title: "Import failed" });
    }
    ui.render();
  });

  // Top bar still works, but gate is mandatory anyway
  els.btnSignIn.addEventListener("click", async () => {
    try{
      await DriveAuth.signInInteractive();
      refreshAuthUI();
      await initialSyncFromDrive();
      ui.render();
    }catch(e){
      await showAlert(e.message, { title: "Sign-in failed" });
    }
  });

  els.btnSignOut.addEventListener("click", async () => {
    await DriveAuth.signOut();
    refreshAuthUI();
    ui.render();
  });

  els.btnSync.addEventListener("click", async () => {
    await syncActive();
    ui.render();
  });

  // Mandatory gate sign-in
  els.btnSignInGate.addEventListener("click", async () => {
    try{
      await DriveAuth.signInInteractive();
      refreshAuthUI();
      await initialSyncFromDrive();
      ui.render();
    }catch(e){
      showAuthGate(true, "Sign-in failed: " + e.message);
    }
  });

  refreshAuthUI();

  // If already signed in (token present), run initial sync immediately
  if(state.auth.isSignedIn){
    await initialSyncFromDrive();
  }

  ui.render();
  
  function closeSidebar(){
    els.sidebar?.classList.remove("open");
    els.sidebarBackdrop?.classList.remove("show");
  }
  function toggleSidebar(){
    const isOpen = els.sidebar?.classList.contains("open");
    if(isOpen) closeSidebar();
    else{
      els.sidebar?.classList.add("open");
      els.sidebarBackdrop?.classList.add("show");
    }
  }

  els.btnToggleSidebar?.addEventListener("click", toggleSidebar);
  els.sidebarBackdrop?.addEventListener("click", closeSidebar);

  // ESC closes the sidebar first, then leaves focus mode
  document.addEventListener("keydown", (e) => {
    if(e.key !== "Escape") return;
    if(els.sidebar?.classList.contains("open")){
      closeSidebar();
      return;
    }
    if(isFocusWanted()){
      setFocusWanted(false);
      ui.render();
    }
  });

  // Close sidebar when resizing to desktop view
  let resizeTimeout;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if(window.innerWidth > 980){
        closeSidebar();
      }
    }, 100);
  });

  // Optional: close sidebar when selecting a list (mobile UX)
  const origSelect = state.actions.selectList;
  state.actions.selectList = async (listId) => {
    await origSelect(listId);
    closeSidebar();
    refreshAuthUI();
    ui.render();
  };
  
  startPolling(ui);
}

boot().catch(async e => {
  console.error(e);
  try{
    await showAlert(e.message, { title: "Fatal error" });
  }catch(_){
    // The page is too broken to render a dialog; fall back to the browser's.
    alert("Fatal error: " + e.message);
  }
});