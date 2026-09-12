// Import and export of a single list as JSON.
//
// Pure: no DOM, no IndexedDB, no Drive. The file-picker and download plumbing
// lives in app.js; everything that decides what the data means lives here.

import { uuid, now } from "./util.js";
import { markDirty } from "./model.js";

const APP = "shopping-spa";
const SCHEMA_VERSION = 1;
const ROOT_ID = "c_root";

/**
 * The payload written to disk. Deliberately omits `sync` (which would leak a
 * Drive file id into a file meant to be shared, and would let an importer push
 * over the exporter's list), `listId`, `origin` and `dirty`.
 */
export function serializeDoc(doc){
  const live = e => !e.deletedAt;

  return {
    app: APP,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now(),
    title: doc.title || "",
    mode: doc.mode || "shopping",
    ui: { hideChecked: !!doc.ui?.hideChecked },
    categories: (doc.categories || []).filter(live).map(c => ({
      id: c.id,
      name: c.name,
      parentId: c.parentId,
      order: c.order ?? 0
    })),
    items: (doc.items || []).filter(live).map(i => ({
      id: i.id,
      label: i.label,
      qty: i.qty ?? null,
      unit: i.unit ?? null,
      categoryId: i.categoryId || ROOT_ID,
      checked: !!i.checked
    }))
  };
}

/** Longest slug we keep, so `<slug>-YYYY-MM-DD.json` stays comfortably short. */
const MAX_SLUG = 64;

/**
 * The name offered in the browser's download dialog, e.g.
 * `groceries-2026-09-12.json`.
 */
export function exportFilename(doc, date = new Date()){
  const slug = String(doc?.title ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")   // fold accents: "été" -> "ete"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/, "");

  const pad = n => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

  return `${slug || "list"}-${stamp}.json`;
}

/**
 * Parses an exported file into a brand-new list document.
 *
 * Every id is regenerated and the sync block is rebuilt empty, so an import can
 * never overwrite an existing list or inherit someone else's Drive file.
 *
 * @param {string}  text
 * @param {object}  [opts]
 * @param {boolean} [opts.resetChecked] start every item unticked
 * @returns {object} a list document ready for DB.putList
 * @throws {Error} with a message fit to show the user
 */
export function parseImport(text, { resetChecked = false } = {}){
  let raw;
  try{
    raw = JSON.parse(text);
  }catch(_e){
    throw new Error("This file is not a valid JSON file.");
  }

  if(!raw || typeof raw !== "object" || Array.isArray(raw)
     || !Array.isArray(raw.items) || !Array.isArray(raw.categories)){
    throw new Error("This file is not a shopping list export.");
  }

  if(Number(raw.schemaVersion) > SCHEMA_VERSION){
    throw new Error("This file was made by a newer version of the app. Update, then try again.");
  }

  const t = now();

  // Fresh ids for everything, so nothing can collide with an existing list.
  // The root keeps its well-known id: the whole app anchors on it.
  const catIdMap = new Map([[ROOT_ID, ROOT_ID]]);
  for(const c of raw.categories){
    if(!c?.id || c.id === ROOT_ID) continue;
    catIdMap.set(c.id, uuid());
  }

  const categories = [
    { id: ROOT_ID, name: "All", parentId: null, order: 0, updatedAt: t, deletedAt: null }
  ];

  for(const c of raw.categories){
    if(!c?.id || c.id === ROOT_ID) continue;

    const name = String(c.name ?? "").trim();
    if(!name) continue;

    // A parent that did not survive would make this category invisible, so
    // adopt it at the root instead of dropping it.
    const parent = catIdMap.get(c.parentId);
    categories.push({
      id: catIdMap.get(c.id),
      name,
      parentId: parent || ROOT_ID,
      order: Number.isFinite(Number(c.order)) ? Number(c.order) : 0,
      updatedAt: t,
      deletedAt: null
    });
  }

  const items = [];
  for(const i of raw.items){
    const label = String(i?.label ?? "").trim();
    if(!label) continue;

    const qty = i.qty === null || i.qty === undefined || i.qty === ""
      ? null
      : (Number.isFinite(Number(i.qty)) ? Number(i.qty) : null);

    items.push({
      id: uuid(),
      label,
      qty,
      unit: i.unit ? String(i.unit) : null,
      categoryId: catIdMap.get(i.categoryId) || ROOT_ID,
      checked: resetChecked ? false : !!i.checked,
      updatedAt: t,
      deletedAt: null
    });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    listId: uuid(),
    title: String(raw.title ?? "").trim() || "Imported list",
    mode: raw.mode === "edit" ? "edit" : "shopping",
    ui: { hideChecked: !!raw.ui?.hideChecked },
    categories,
    items,
    sync: {
      driveFileId: null,
      driveFolderId: null,
      driveModifiedTime: null,
      lastPulledAt: null,
      lastPushedAt: null
    },
    origin: "my",
    dirty: true,
    updatedAt: t
  };
}

/**
 * Replaces a list's contents in place, keeping its identity and Drive binding
 * so the change reaches everyone synced to that file.
 *
 * The old entities are **tombstoned, not removed**. mergeEntities in model.js
 * is a union by id with no notion of "absent means deleted": dropping them
 * would let the next sync — or the background poller, with no user action at
 * all — pull the remote copy back and resurrect everything.
 */
export function replaceDocContents(target, imported){
  const t = now();

  for(const c of target.categories){
    if(c.id === ROOT_ID || c.deletedAt) continue;
    c.deletedAt = t;
    c.updatedAt = t;
  }
  for(const i of target.items){
    if(i.deletedAt) continue;
    i.deletedAt = t;
    i.updatedAt = t;
  }

  // The imported entities already carry fresh ids, so they cannot collide with
  // the tombstones. Its root is skipped: the target already has one.
  for(const c of imported.categories){
    if(c.id === ROOT_ID) continue;
    target.categories.push({ ...c });
  }
  for(const i of imported.items){
    target.items.push({ ...i });
  }

  target.title = imported.title;
  target.mode = imported.mode;
  target.ui = { ...imported.ui };

  markDirty(target);
}
