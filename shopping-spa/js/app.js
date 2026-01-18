import { DB } from "./db.js";
import { createNewListDoc, normalizeDoc } from "./model.js";
import { createUI } from "./ui.js";
import { DriveAuth } from "./driveAuth.js";
import { DriveSync } from "./driveSync.js";

const els = {
  btnSignIn: document.getElementById("btnSignIn"),
  btnSignOut: document.getElementById("btnSignOut"),
  btnNewList: document.getElementById("btnNewList"),
  btnSync: document.getElementById("btnSync"),
  syncStatus: document.getElementById("syncStatus"),
};

let state = {
  lists: [],
  activeListId: null,
  activeDoc: null,
  selectedCategoryId: "c_root",
  auth: {
    isSignedIn: false
  },
  actions: null
};

function setState(next){
  state = next;
}
function getState(){
  return state;
}

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
  // Refresh lists array snapshot
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
  setState(state);
}

async function createList(){
  const title = prompt("List title?", "New list");
  if(title === null) return;

  const doc = createNewListDoc(title.trim() || "New list");
  await DB.putList(doc);

  state.lists = (await DB.getAllLists()).map(normalizeDoc);
  state.activeListId = doc.listId;
  state.activeDoc = doc;
  state.selectedCategoryId = "c_root";
  setState(state);
}

async function deleteList(listId){
  await DB.deleteList(listId);
  state.lists = (await DB.getAllLists()).map(normalizeDoc);

  if(state.activeListId === listId){
    const next = state.lists[0] || null;
    state.activeListId = next ? next.listId : null;
    state.activeDoc = next;
  }
  setState(state);
}

async function syncNow(){
  if(!state.activeDoc) return;
  setSyncStatus("Syncing…");

  try{
    // sync active doc
    const synced = await DriveSync.sync(state.activeDoc);
    await DB.putList(synced);
    await loadAll();
    setSyncStatus("Synced ✅");
  }catch(e){
    console.error(e);
    setSyncStatus("Sync failed: " + e.message);
  }
}

async function shareActive(role){
  if(!state.activeDoc) return null;
  setSyncStatus("Sharing…");

  try{
    // Ensure synced before sharing to avoid sharing stale file
    const synced = await DriveSync.sync(state.activeDoc);
    const link = await DriveSync.share(synced, role);
    await DB.putList(synced);
    await loadAll();
    setSyncStatus("Shared ✅");
    return link;
  }catch(e){
    console.error(e);
    setSyncStatus("Share failed: " + e.message);
    return null;
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

async function boot(){
  await DriveAuth.init();
  await loadAll();

  state.actions = {
    selectList,
    createList,
    deleteList,
    persistActiveDoc
  };

  const ui = createUI({
    getState,
    setState,
    persistActiveDoc,
    onSync: syncNow,
    onShare: shareActive
  });

  // Top actions
  els.btnNewList.addEventListener("click", async () => {
    await createList();
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

  // If user switches list, update sync button state
  const origSelect = selectList;
  state.actions.selectList = async (listId) => {
    await origSelect(listId);
    refreshAuthUI();
    ui.render();
  };
}

boot().catch(e => {
  console.error(e);
  alert("Fatal error: " + e.message);
});