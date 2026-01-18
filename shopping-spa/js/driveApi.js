import { DriveAuth } from "./driveAuth.js";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

async function authedFetch(url, options = {}){
  const token = await DriveAuth.ensureToken();
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token.access_token}`);

  return fetch(url, { ...options, headers });
}

export const DriveApi = {
  async listFiles(q, fields){
    const url = new URL(`${DRIVE_BASE}/files`);
    url.searchParams.set("q", q);
    url.searchParams.set("fields", fields || "files(id,name,modifiedTime,mimeType,appProperties,parents)");
    url.searchParams.set("spaces", "drive");
    const res = await authedFetch(url.toString());
    if(!res.ok) throw new Error(`Drive listFiles failed: ${res.status}`);
    return res.json();
  },

  async createFolder(name){
    const res = await authedFetch(`${DRIVE_BASE}/files`, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder"
      })
    });
    if(!res.ok) throw new Error(`Drive createFolder failed: ${res.status}`);
    return res.json();
  },

  async createJsonFile({ name, parents, appProperties, json }){
    const url = new URL(`${UPLOAD_BASE}/files`);
    url.searchParams.set("uploadType","media");

    // Create metadata first (multipart would be nicer, but keep simple)
    const metaRes = await authedFetch(`${DRIVE_BASE}/files`, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ name, parents, mimeType:"application/json", appProperties })
    });
    if(!metaRes.ok) throw new Error(`Drive create metadata failed: ${metaRes.status}`);
    const meta = await metaRes.json();

    const putRes = await authedFetch(`${UPLOAD_BASE}/files/${meta.id}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(json)
    });
    if(!putRes.ok) throw new Error(`Drive upload content failed: ${putRes.status}`);
    const updated = await putRes.json();

    return { ...meta, ...updated };
  },

  async getFileContent(fileId){
    const url = new URL(`${DRIVE_BASE}/files/${fileId}`);
    url.searchParams.set("alt","media");
    const res = await authedFetch(url.toString(), { method:"GET" });
    if(!res.ok) throw new Error(`Drive getFileContent failed: ${res.status}`);
    return res.json();
  },

  async updateFileJson(fileId, json){
    const url = `${UPLOAD_BASE}/files/${fileId}?uploadType=media`;
    const res = await authedFetch(url, {
      method:"PATCH",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(json)
    });
    if(!res.ok) throw new Error(`Drive updateFileJson failed: ${res.status}`);
    return res.json();
  },

  async updateFileMetadata(fileId, patch){
    const res = await authedFetch(`${DRIVE_BASE}/files/${fileId}`, {
      method:"PATCH",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(patch)
    });
    if(!res.ok) throw new Error(`Drive updateFileMetadata failed: ${res.status}`);
    return res.json();
  },

  async createAnyoneWithLinkPermission(fileId, role="reader"){
    const res = await authedFetch(`${DRIVE_BASE}/files/${fileId}/permissions`, {
      method:"POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({
        type: "anyone",
        role
      })
    });
    if(!res.ok) throw new Error(`Drive createPermission failed: ${res.status}`);
    return res.json();
  },

  async getShareLink(fileId){
    // Drive "webViewLink" requires fields
    const res = await authedFetch(`${DRIVE_BASE}/files/${fileId}?fields=id,name,webViewLink,webContentLink`, { method:"GET" });
    if(!res.ok) throw new Error(`Drive getShareLink failed: ${res.status}`);
    return res.json();
  }
};