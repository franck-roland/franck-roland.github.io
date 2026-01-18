import { DB } from "./db.js";
import { createNewListDoc, normalizeDoc } from "./model.js";
import { createUI } from "./ui.js";
import { DriveAuth } from "./driveAuth.js";
import { DriveSync } from "./driveSync.js";
import { extractDriveFileId } from "./util.js";

const els = {
  btnSignIn: document.getElementById("btnSignIn"),
  btnSignOut: document.getElementById("btnSignOut"),
  btnSync: document.getElementById("btnSync"),
  syncStatus: document.getElementById("syncStatus"),

  authGate: document.getElementById("authGate"),
  btnSignInGate: document.getElementById("btnSignInGate"),
  authGateStatus: document.getElementById("authGateStatus"),
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

  const title = prompt("List title?", "New list");
  if(title === null) return;

  let doc = createNewListDoc(title.trim() || "New list");
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
    alert("Sign in first.");
    return;
  }

  const input = prompt("Paste a Google Drive share link or fileId:");
  if(input === null) return;
  const fileId = extractDriveFileId(input);
  if(!fileId){
    alert("Could not extract a Drive fileId.");
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
    onResolveConflict: resolveConflict
  });

  // Top bar still works, but gate is mandatory anyway
  els.btnSignIn.addEventListener("click", async () => {
    try{
      await DriveAuth.signInInteractive();
      refreshAuthUI();
      await initialSyncFromDrive();
      ui.render();
    }catch(e){
      alert("Sign-in failed: " + e.message);
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
  startPolling(ui);
}

boot().catch(e => {
  console.error(e);
  alert("Fatal error: " + e.message);
});