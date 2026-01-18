import { CONFIG } from "./config.js";
import { DriveApi } from "./driveApi.js";
import { normalizeDoc, mergeDocs, markClean } from "./model.js";
import { now } from "./util.js";

export const DriveSync = {
  async ensureShoppingFolder(){
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

  async listFolderListFiles(folderId){
    // Only JSON files marked by appProperties (robust discovery)
    const q = [
      `'${folderId}' in parents`,
      `trashed = false`,
      `mimeType = '${CONFIG.FILE_MIME}'`,
      `appProperties has { key='${CONFIG.APP_PROPERTY_KEY}' and value='${CONFIG.APP_PROPERTY_VALUE}' }`
    ].join(" and ");

    const r = await DriveApi.listFiles(q, "files(id,name,modifiedTime,parents,appProperties)");
    return r.files || [];
  },

  async pullFileToDoc(fileId){
    const remoteDoc = normalizeDoc(await DriveApi.getFileContent(fileId));
    remoteDoc.sync ??= {};
    remoteDoc.sync.driveFileId = fileId;
    remoteDoc.sync.lastPulledAt = now();
    remoteDoc.dirty = false;
    return remoteDoc;
  },

  async ensureMyListFile(doc, folderId){
    doc = normalizeDoc(doc);
    if(doc.sync?.driveFileId) return doc;

    const name = `list_${doc.listId}.json`;
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
    doc.sync.driveFolderId = folderId;
    doc.sync.lastPushedAt = now();
    doc.sync.lastPulledAt = now();
    doc.origin = "my";
    doc.dirty = false;
    return doc;
  },

  async syncDetectConflict(doc){
    doc = normalizeDoc(doc);
    if(!doc.sync?.driveFileId) throw new Error("Doc has no driveFileId yet");

    const remote = normalizeDoc(await DriveApi.getFileContent(doc.sync.driveFileId));

    const remoteUpdatedAt = remote.updatedAt || 0;
    const lastPulledAt = doc.sync.lastPulledAt || 0;
    const remoteChangedSincePull = remoteUpdatedAt > lastPulledAt;
    const localHasChanges = !!doc.dirty;

    if(remoteChangedSincePull && localHasChanges){
      return { status: "conflict", doc, remote };
    }

    // merge then push if needed
    let merged = mergeDocs(doc, remote);
    merged.sync = { ...doc.sync, ...merged.sync };
    merged.sync.lastPulledAt = now();

    if(merged.dirty){
      merged = await DriveApi.updateFileJson(merged.sync.driveFileId, merged).then(() => {
        merged.sync.lastPushedAt = now();
        markClean(merged);
        return merged;
      });
      return { status: "merged_pushed", doc: merged, remote };
    }

    return { status: "pulled_only", doc: merged, remote };
  },

  async pushOverwrite(doc){
    doc = normalizeDoc(doc);
    if(!doc.sync?.driveFileId) throw new Error("Doc has no driveFileId yet");

    await DriveApi.updateFileJson(doc.sync.driveFileId, doc);
    doc.sync.lastPushedAt = now();
    markClean(doc);
    return doc;
  },

  async resolveConflict(doc, remote, strategy){
    doc = normalizeDoc(doc);
    remote = normalizeDoc(remote);

    if(strategy === "remote"){
      const kept = normalizeDoc(remote);
      kept.sync = { ...doc.sync, ...kept.sync };
      kept.sync.lastPulledAt = now();
      kept.dirty = false;
      return kept;
    }

    if(strategy === "mine"){
      doc.sync.lastPulledAt = now();
      return await DriveSync.pushOverwrite(doc);
    }

    // merge
    let merged = mergeDocs(doc, remote);
    merged.sync = { ...doc.sync, ...merged.sync };
    merged.sync.lastPulledAt = now();
    merged.dirty = true;
    return await DriveSync.pushOverwrite(merged);
  },

  async share(doc, role="writer"){
    doc = normalizeDoc(doc);
    if(!doc.sync?.driveFileId) throw new Error("Doc has no driveFileId yet");

    await DriveApi.createAnyoneWithLinkPermission(doc.sync.driveFileId, role);
    const links = await DriveApi.getShareLink(doc.sync.driveFileId);
    return links.webViewLink || links.webContentLink || null;
  },

  async importSharedByFileId(fileId){
    const doc = await DriveSync.pullFileToDoc(fileId);

    // Mark as shared (not necessarily in .shopping folder)
    doc.origin = "shared";
    doc.sync.driveFolderId = null;
    doc.dirty = false;
    return doc;
  }
};