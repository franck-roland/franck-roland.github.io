export function uuid() {
  // RFC4122-ish, good enough for client IDs
  return crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(16).slice(2) + Date.now();
}

export function now() {
  return Date.now();
}

export function debounce(fn, ms=400){
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function escapeHtml(str){
  return String(str)
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#039;");
}

export function assert(cond, msg){
  if(!cond) throw new Error(msg || "Assertion failed");
}

export function extractDriveFileId(input){
  const s = String(input || "").trim();
  if(!s) return null;

  // If user pasted just an id
  if(/^[a-zA-Z0-9_-]{10,}$/.test(s) && !s.includes("/")) return s;

  try{
    const u = new URL(s);
    // Common patterns:
    // https://drive.google.com/file/d/<id>/view
    // https://drive.google.com/open?id=<id>
    // https://drive.google.com/uc?id=<id>&export=download
    const m = u.pathname.match(/\/file\/d\/([^/]+)/);
    if(m?.[1]) return m[1];
    const id = u.searchParams.get("id");
    if(id) return id;
  }catch(_e){}

  return null;
}