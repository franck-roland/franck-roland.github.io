import { CONFIG } from "./config.js";
import { DriveApi } from "./driveApi.js";
import { mergeDocs, normalizeDoc, markClean, markDirty } from "./model.js";
import { now } from "./util.js";

export const DriveSync = {
  async ensureAppFolder(){
    // Find existing folder
    const q = [
      `mimeType = 'application/vnd.google-apps.folder'`,
      `name = '${CONFIG.APP_FOLDER_NAME.replaceAll("'","\\'")}'`,
      `trashed = false`
    ].join(" and ");

    const r = await DriveApi.listFiles(q, "files(id,name)");
    if(r.files?.length) return r.files[0].id;

    // Create it
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
    markDirty(doc); // metadata changed
    return doc;
  },

  async pull(doc){
    doc = normalizeDoc(doc);
    if(!doc.sync.driveFileId) return doc;

    const remote = await DriveApi.getFileContent(doc.sync.driveFileId);
    const merged = mergeDocs(doc, remote);

    merged.sync = { ...doc.sync, ...merged.sync };
    merged.sync.lastPulledAt = now();
    merged.dirty = true; // merged state should be pushed again if it changed
    return merged;
  },

  async push(doc){
    doc = await DriveSync.ensureListFile(doc);

    // Upload content
    const updated = await DriveApi.updateFileJson(doc.sync.driveFileId, doc);
    doc.sync.driveModifiedTime = updated.modifiedTime || doc.sync.driveModifiedTime;
    doc.sync.lastPushedAt = now();
    markClean(doc);
    return doc;
  },

  async sync(doc){
    // Pull then push (simple)
    doc = await DriveSync.ensureListFile(doc);
    doc = await DriveSync.pull(doc);
    doc = await DriveSync.push(doc);
    return doc;
  },

  async share(doc, role="reader"){
    doc = await DriveSync.ensureListFile(doc);
    await DriveApi.createAnyoneWithLinkPermission(doc.sync.driveFileId, role);
    const links = await DriveApi.getShareLink(doc.sync.driveFileId);
    return links.webViewLink || links.webContentLink || null;
  }
};