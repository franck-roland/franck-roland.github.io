import { DB } from "./db.js";
import { createNewListDoc, normalizeDoc } from "./model.js";
import { createUI } from "./ui.js";
import { DriveAuth } from "./driveAuth.js";
import { DriveSync } from "./driveSync.js";
import { extractDriveFileId } from "./util.js";

const els = {
  btnSignIn: document.getElementById("btnSignIn"),
  btnSignOut: document.getElementById("btnSignOut"),
  btnNewList: document.getElementById("btnNewList"),
  btnImport: document.getElementById("btnImport"),
  btnSync: document.getElementById("btnSync"),
  syncStatus: document.getElementById("syncStatus"),
};

let state = {
  lists: [],
  activeListId: null,
  activeDoc: null,
  selectedCategoryId: "c_root",
  auth: { isSignedIn: false },

  // conflict state
  conflict: {
    pending: false,
    remoteDoc: null,
    summary: ""
  },

  actions: null
};

function setState(next){ state = next; }
function getState(){ return state; }

async function loadAll(){
  const lists = (await DB.getAllLists()).map(normalizeDoc);
  state.lists = lists;
  if(!state.activeListId && lists.length){
    state.activeListId = lists[0].listId;
    state.activeDoc = lists[0];
  }else if(state.activeListId){
    state.activeDoc = lists.find(l => l.listId === state.activeListId) || null;
  }
}

async function persistActiveDoc(){
  if(!state.activeDoc) return;
  await DB.putList(state.activeDoc);
  state.lists = (await DB.getAllLists()).map(normalizeDoc);
}

function setSyncStatus(text){
  els.syncStatus.textContent = text;
}

async function selectList(listId){
  state.activeListId = listId;
  state.activeDoc = await DB.getList(listId);
  state.activeDoc = state.activeDoc ? normalizeDoc(state.activeDoc) : null;
  state.selectedCategoryId = "c_root";
  state.conflict = { pending:false, remoteDoc:null, summary:"" };
  setState(state);
}

async function createList(){
  const title = prompt("List title?", "New list");
  if(title === null) return;

  const doc = createNewListDoc(title.trim() || "New list");
  await DB.putList(doc);

  await loadAll();
  state.activeListId = doc.listId;
  state.activeDoc = doc;
  state.selectedCategoryId = "c_root";
  state.conflict = { pending:false, remoteDoc:null, summary:"" };
  setState(state);
}

async function deleteList(listId){
  await DB.deleteList(listId);
  await loadAll();

  if(state.activeListId === listId){
    const next = state.lists[0] || null;
    state.activeListId = next ? next.listId : null;
    state.activeDoc = next;
  }
  state.conflict = { pending:false, remoteDoc:null, summary:"" };
  setState(state);
}

async function syncNow(){
  if(!state.activeDoc) return;
  setSyncStatus("Syncing…");

  try{
    const res = await DriveSync.syncDetectConflict(state.activeDoc);

    if(res.status === "conflict"){
      // Keep local doc, store remote for resolution
      state.conflict.pending = true;
      state.conflict.remoteDoc = res.remote;
      await persistActiveDoc();
      setSyncStatus("Conflict detected ⚠️");
      return;
    }

    state.activeDoc = res.doc;
    await DB.putList(res.doc);
    await loadAll();
    state.conflict = { pending:false, remoteDoc:null, summary:"" };
    setSyncStatus("Synced ✅");
  }catch(e){
    console.error(e);
    setSyncStatus("Sync failed: " + e.message);
  }
}

async function importShared(){
  if(!DriveAuth.isSignedIn()){
    alert("Sign in first to import from Drive.");
    return;
  }

  const input = prompt("Paste a Google Drive share link or fileId:");
  if(input === null) return;

  const fileId = extractDriveFileId(input);
  if(!fileId){
    alert("Could not extract a Drive fileId from what you pasted.");
    return;
  }

  setSyncStatus("Importing…");
  try{
    const doc = await DriveSync.importByFileId(fileId);

    // If doc.listId collides locally, we still want a single entry representing that file.
    // We'll key by listId, but collaboration should be anchored to driveFileId.
    // If listId missing, create one.
    if(!doc.listId){
      doc.listId = "import_" + fileId;
    }

    // Ensure local storage has it
    await DB.putList(doc);
    await loadAll();
    state.activeListId = doc.listId;
    state.activeDoc = doc;
    state.selectedCategoryId = "c_root";
    state.conflict = { pending:false, remoteDoc:null, summary:"" };
    setState(state);

    setSyncStatus("Imported ✅");
  }catch(e){
    console.error(e);
    setSyncStatus("Import failed: " + e.message);
    alert("Import failed: " + e.message);
  }
}

async function resolveConflict(strategy){
  if(!state.activeDoc || !state.conflict.pending || !state.conflict.remoteDoc) return;

  setSyncStatus("Resolving…");
  try{
    const resolved = await DriveSync.resolveConflict(state.activeDoc, state.conflict.remoteDoc, strategy);
    state.activeDoc = resolved;
    state.conflict = { pending:false, remoteDoc:null, summary:"" };

    await DB.putList(resolved);
    await loadAll();
    setSyncStatus("Resolved ✅");
  }catch(e){
    console.error(e);
    setSyncStatus("Resolve failed: " + e.message);
  }
}

function refreshAuthUI(){
  const signedIn = DriveAuth.isSignedIn();
  state.auth.isSignedIn = signedIn;
  els.btnSignIn.disabled = signedIn;
  els.btnSignOut.disabled = !signedIn;
  els.btnSync.disabled = !signedIn || !state.activeDoc;
  setSyncStatus(signedIn ? "Signed in" : "Not signed in");
}

function startCollabPolling(ui){
  // Poll Drive for remote changes for the active list.
  // If conflict arises, we stop auto-sync until user resolves.
  setInterval(async () => {
    if(!state.auth.isSignedIn) return;
    if(!state.activeDoc) return;
    if(state.conflict.pending) return;

    // Only poll if file exists on Drive (collab list or already created)
    if(!state.activeDoc.sync?.driveFileId) return;

    // Lightweight: detect & sync; if no changes, cheap.
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

      if(res.status !== "noop"){
        state.activeDoc = res.doc;
        await DB.putList(res.doc);
        await loadAll();
        setSyncStatus("Up to date ✅");
        ui.render();
      }
    }catch(e){
      // Silent failures (offline, token expired, etc.)
      // UI already has Sync now button.
    }
  }, 10_000); // every 10s (tweak as you like)
}

async function boot(){
  await DriveAuth.init();
  await loadAll();

  state.actions = {
    selectList,
    createList,
    deleteList,
    persistActiveDoc,
    syncNow,
    importShared,
    resolveConflict
  };

  const ui = createUI({
    getState,
    setState,
    persistActiveDoc,
    onSync: syncNow,
    onImport: importShared,
    onResolveConflict: resolveConflict
  });

  els.btnNewList.addEventListener("click", async () => {
    await createList();
    refreshAuthUI();
    ui.render();
  });

  els.btnImport.addEventListener("click", async () => {
    await importShared();
    refreshAuthUI();
    ui.render();
  });

  els.btnSignIn.addEventListener("click", async () => {
    try{
      await DriveAuth.signInInteractive();
      refreshAuthUI();
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
    await syncNow();
    ui.render();
  });

  refreshAuthUI();
  ui.render();

  // keep sync button correct when switching lists
  const origSelect = selectList;
  state.actions.selectList = async (listId) => {
    await origSelect(listId);
    refreshAuthUI();
    ui.render();
  };

  startCollabPolling(ui);
}

boot().catch(e => {
  console.error(e);
  alert("Fatal error: " + e.message);
});