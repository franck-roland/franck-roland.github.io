import { uuid, now } from "./util.js";

export function createNewListDoc(title="New list"){
  const listId = uuid();
  const rootId = "c_root";

  return {
    schemaVersion: 1,
    listId,
    title,
    mode: "shopping", // "edit" | "shopping"
    ui: { hideChecked: false },

    categories: [
      { id: rootId, name: "All", parentId: null, updatedAt: now(), deletedAt: null }
    ],
    items: [],

    sync: {
      driveFileId: null,
      driveFolderId: null,
      driveModifiedTime: null,
      lastPulledAt: null,
      lastPushedAt: null
    },

    dirty: true,
    updatedAt: now()
  };
}

export function normalizeDoc(doc){
  // Ensure fields exist for forward-compat
  doc.schemaVersion ??= 1;
  doc.ui ??= { hideChecked:false };
  doc.mode ??= "shopping";
  doc.categories ??= [];
  doc.items ??= [];
  doc.sync ??= { driveFileId:null, driveFolderId:null, driveModifiedTime:null, lastPulledAt:null, lastPushedAt:null };
  doc.dirty ??= false;
  doc.updatedAt ??= now();
  return doc;
}

export function upsertCategory(doc, { id=null, name, parentId }){
  const t = now();
  if(!id){
    id = uuid();
    doc.categories.push({ id, name, parentId, updatedAt:t, deletedAt:null });
  }else{
    const c = doc.categories.find(x => x.id === id);
    if(!c) throw new Error("Category not found");
    c.name = name ?? c.name;
    c.parentId = parentId ?? c.parentId;
    c.updatedAt = t;
  }
  markDirty(doc);
  return id;
}

export function deleteCategory(doc, categoryId){
  // Soft delete category and all descendants; also detach items to uncategorized (root)
  const t = now();
  const toDelete = new Set([categoryId]);
  let changed = true;
  while(changed){
    changed = false;
    for(const c of doc.categories){
      if(c.deletedAt) continue;
      if(c.parentId && toDelete.has(c.parentId) && !toDelete.has(c.id)){
        toDelete.add(c.id);
        changed = true;
      }
    }
  }

  for(const c of doc.categories){
    if(toDelete.has(c.id)){
      c.deletedAt = t;
      c.updatedAt = t;
    }
  }

  const rootId = "c_root";
  for(const it of doc.items){
    if(it.deletedAt) continue;
    if(it.categoryId && toDelete.has(it.categoryId)){
      it.categoryId = rootId;
      it.updatedAt = t;
    }
  }

  markDirty(doc);
}

export function addItem(doc, { label, categoryId="c_root", qty=null, unit=null }){
  const t = now();
  const item = {
    id: uuid(),
    label: String(label || "").trim(),
    qty,
    unit,
    categoryId,
    checked: false,
    updatedAt: t,
    deletedAt: null
  };
  if(!item.label) return null;
  doc.items.push(item);
  markDirty(doc);
  return item.id;
}

export function updateItem(doc, itemId, patch){
  const it = doc.items.find(x => x.id === itemId);
  if(!it) throw new Error("Item not found");
  Object.assign(it, patch);
  it.updatedAt = now();
  markDirty(doc);
}

export function deleteItem(doc, itemId){
  const it = doc.items.find(x => x.id === itemId);
  if(!it) return;
  const t = now();
  it.deletedAt = t;
  it.updatedAt = t;
  markDirty(doc);
}

export function toggleItemChecked(doc, itemId){
  const it = doc.items.find(x => x.id === itemId);
  if(!it || it.deletedAt) return;
  it.checked = !it.checked;
  it.updatedAt = now();
  markDirty(doc);
}

export function setMode(doc, mode){
  if(mode !== "edit" && mode !== "shopping") return;
  doc.mode = mode;
  markDirty(doc);
}

export function setHideChecked(doc, hide){
  doc.ui.hideChecked = !!hide;
  markDirty(doc);
}

export function markDirty(doc){
  doc.dirty = true;
  doc.updatedAt = now();
}

export function markClean(doc){
  doc.dirty = false;
  doc.updatedAt = now();
}

/**
 * Merge two docs (local + remote) with per-entity updatedAt and tombstones.
 * - Keeps newest updatedAt per id
 * - Propagates deletions via deletedAt
 */
export function mergeDocs(localDoc, remoteDoc){
  localDoc = normalizeDoc(structuredClone(localDoc));
  remoteDoc = normalizeDoc(structuredClone(remoteDoc));

  const merged = structuredClone(localDoc);

  // Title / mode / ui: last-write-wins by updatedAt
  if((remoteDoc.updatedAt || 0) > (localDoc.updatedAt || 0)){
    merged.title = remoteDoc.title;
    merged.mode = remoteDoc.mode;
    merged.ui = remoteDoc.ui;
  }

  merged.categories = mergeEntities(localDoc.categories, remoteDoc.categories);
  merged.items = mergeEntities(localDoc.items, remoteDoc.items);

  // Keep sync metadata from local, but driveModifiedTime can be remote-fresher
  merged.sync = { ...localDoc.sync };
  merged.updatedAt = Math.max(localDoc.updatedAt||0, remoteDoc.updatedAt||0);

  // If either side dirty, stay dirty
  merged.dirty = !!(localDoc.dirty || remoteDoc.dirty);

  return merged;
}

function mergeEntities(a, b){
  const map = new Map();

  for(const e of (a||[])){
    map.set(e.id, structuredClone(e));
  }
  for(const e of (b||[])){
    const cur = map.get(e.id);
    if(!cur){
      map.set(e.id, structuredClone(e));
      continue;
    }
    const ea = cur.updatedAt || 0;
    const eb = e.updatedAt || 0;
    if(eb > ea){
      map.set(e.id, structuredClone(e));
    }
  }
  // Stable-ish order: by name/label then updatedAt (optional). Keep insertion order for now.
  return Array.from(map.values());
}