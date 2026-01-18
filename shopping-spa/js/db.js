const DB_NAME = "shopping_spa_db";
const DB_VERSION = 1;

const STORES = {
  lists: "lists",     // list metadata + document
  settings: "settings" // global settings
};

function openDb(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(STORES.lists)){
        const s = db.createObjectStore(STORES.lists, { keyPath: "listId" });
        s.createIndex("updatedAt", "updatedAt", { unique:false });
      }
      if(!db.objectStoreNames.contains(STORES.settings)){
        db.createObjectStore(STORES.settings, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

async function tx(storeName, mode, fn){
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const res = fn(store);
    t.oncomplete = () => resolve(res);
    t.onerror = () => reject(t.error);
  });
}

export const DB = {
  async getAllLists(){
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORES.lists, "readonly");
      const store = t.objectStore(STORES.lists);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async getList(listId){
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORES.lists, "readonly");
      const store = t.objectStore(STORES.lists);
      const req = store.get(listId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async putList(doc){
    await tx(STORES.lists, "readwrite", store => store.put(doc));
    return doc;
  },

  async deleteList(listId){
    await tx(STORES.lists, "readwrite", store => store.delete(listId));
  },

  async getSetting(key){
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORES.settings, "readonly");
      const store = t.objectStore(STORES.settings);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
  },

  async setSetting(key, value){
    await tx(STORES.settings, "readwrite", store => store.put({ key, value }));
  }
};