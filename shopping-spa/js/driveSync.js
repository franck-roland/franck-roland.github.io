import { CONFIG } from "./config.js";
import { DriveApi } from "./driveApi.js";
import { mergeDocs, normalizeDoc, markClean, markDirty } from "./model.js";
import { now } from "./util.js";

export const DriveSync = {
  async ensureAppFolder(){
    const q = [
      `mimeType = 'application/vnd.google-apps.folder'`,
      `name = '${CONFIG.APP_FOLDER_NAME.replaceAll("'","\\'")}'`,
      `trashed = false`
    ].join(" and ");

    const r = await DriveApi.listFiles(q, "files(id,name)");
    if(r.files?.length) return r.files[0].id;

    const folder = await DriveApi.createFolder(CONFIG.APP_FOLDER_NAME);
    return folder.id;
  },

  async ensureListFile(doc){
    doc = normalizeDoc(doc);
    if(doc.sync.driveFileId) return doc;

    const folderId = await DriveSync.ensureAppFolder();
    doc.sync.driveFolderId = folderId;

    const name = `${CONFIG.FILE_NAME_PREFIX}${doc.listId}.json`;

    const created = await DriveApi.createJsonFile({
      name,
      parents: [folderId],
      appProperties: {
        [CONFIG.APP_PROPERTY_KEY]: CONFIG.APP_PROPERTY_VALUE,
        listId: doc.listId
      },
      json: doc
    });

    doc.sync.driveFileId = created.id;
    doc.sync.driveModifiedTime = created.modifiedTime || null;
    doc.sync.lastPushedAt = now();
    markDirty(doc);
    return doc;
  },

  // --- IMPORT: open any Drive JSON file by id (shared link)
  async importByFileId(fileId){
    const remote = await DriveApi.getFileContent(fileId);
    const doc = normalizeDoc(remote);

    // Force collaboration on the same file
    doc.sync.driveFileId = fileId;

    // Best-effort: keep it in app folder later if you want; not required for collaboration.
    doc.sync.lastPulledAt = now();
    doc.sync.lastPushedAt = doc.sync.lastPushedAt || null;
    doc.sync.driveModifiedTime = doc.sync.driveModifiedTime || null;

    // Imported doc may not be marked dirty; but local is now a working copy
    doc.dirty = false;
    return doc;
  },

  async pullRemote(doc){
    doc = normalizeDoc(doc);
    if(!doc.sync.driveFileId) return { remote: null, doc };

    const remote = normalizeDoc(await DriveApi.getFileContent(doc.sync.driveFileId));
    return { remote, doc };
  },

  async pushOverwriteRemote(doc){
    doc = normalizeDoc(doc);
    doc = await DriveSync.ensureListFile(doc);

    const updated = await DriveApi.updateFileJson(doc.sync.driveFileId, doc);
    doc.sync.driveModifiedTime = updated.modifiedTime || doc.sync.driveModifiedTime;
    doc.sync.lastPushedAt = now();
    markClean(doc);
    return doc;
  },

  /**
   * Conflict-aware sync:
   * - Pull remote
   * - If BOTH changed: report conflict and let caller decide
   * - Else auto-merge and push when needed
   */
  async syncDetectConflict(doc){
    doc = normalizeDoc(doc);
    doc = await DriveSync.ensureListFile(doc);

    const { remote } = await DriveSync.pullRemote(doc);
    if(!remote){
      // nothing to pull; just push if dirty
      if(doc.dirty) return { status: "pushed", doc: await DriveSync.pushOverwriteRemote(doc), remote: null };
      return { status: "noop", doc, remote: null };
    }

    const remoteUpdatedAt = remote.updatedAt || 0;
    const localUpdatedAt = doc.updatedAt || 0;

    // Heuristic: if remote is newer than our last pull, and we are dirty, conflict
    const lastPulledAt = doc.sync.lastPulledAt || 0;
    const remoteChangedSincePull = remoteUpdatedAt > lastPulledAt;
    const localHasChanges = !!doc.dirty;

    if(remoteChangedSincePull && localHasChanges){
      return { status: "conflict", doc, remote };
    }

    // Otherwise, merge (remote into local) then push if needed
    let merged = mergeDocs(doc, remote);
    merged.sync = { ...doc.sync, ...merged.sync };
    merged.sync.lastPulledAt = now();

    // If remote was newer and we merged, we should push only if our merged differs materially
    // Simplest: if dirty OR localUpdatedAt >= remoteUpdatedAt.
    if(merged.dirty){
      merged = await DriveSync.pushOverwriteRemote(merged);
      return { status: "merged_pushed", doc: merged, remote };
    }

    return { status: "pulled_only", doc: merged, remote };
  },

  /**
   * Apply conflict resolution:
   * - "merge": auto merge, then push
   * - "mine": keep local doc, overwrite remote
   * - "remote": discard local, keep remote
   */
  async resolveConflict(doc, remote, strategy){
    doc = normalizeDoc(doc);
    remote = normalizeDoc(remote);

    if(strategy === "remote"){
      // keep remote locally
      const kept = normalizeDoc(remote);
      kept.sync = { ...doc.sync, ...kept.sync };
      kept.sync.lastPulledAt = now();
      kept.dirty = false;
      return kept;
    }

    if(strategy === "mine"){
      // overwrite remote with local
      doc.sync.lastPulledAt = now();
      return await DriveSync.pushOverwriteRemote(doc);
    }

    // "merge"
    let merged = mergeDocs(doc, remote);
    merged.sync = { ...doc.sync, ...merged.sync };
    merged.sync.lastPulledAt = now();
    merged.dirty = true;
    merged = await DriveSync.pushOverwriteRemote(merged);
    return merged;
  },

  async share(doc, role="writer"){
    doc = await DriveSync.ensureListFile(doc);
    await DriveApi.createAnyoneWithLinkPermission(doc.sync.driveFileId, role);
    const links = await DriveApi.getShareLink(doc.sync.driveFileId);
    return links.webViewLink || links.webContentLink || null;
  }
};