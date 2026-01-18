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