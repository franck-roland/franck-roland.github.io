/* Offline app shell.
 *
 * BUMP `VERSION` WHENEVER ANY PRECACHED FILE CHANGES. The cache is served
 * before the network, so a deploy without a bump keeps serving the old bundle
 * and looks like it did nothing at all.
 *
 * The precache list is written by hand because this repo has no build step and
 * keeping it that way is worth more than the maintenance. It must list every
 * runtime module — a missing one only fails once you are already offline.
 */
const VERSION = "v3";
const CACHE = `shopping-spa-${VERSION}`;

const PRECACHE = [
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./js/app.js",
  "./js/config.js",
  "./js/conflictDiff.js",
  "./js/connectivity.js",
  "./js/db.js",
  "./js/driveApi.js",
  "./js/driveAuth.js",
  "./js/driveSync.js",
  "./js/focus.js",
  "./js/modal.js",
  "./js/model.js",
  "./js/search.js",
  "./js/transfer.js",
  "./js/tree.js",
  "./js/ui.js",
  "./js/util.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try{
      await cache.addAll(PRECACHE);
    }catch(e){
      // addAll is all-or-nothing, so one stale path in the hand-maintained
      // list above rejects the install silently: the worker never activates
      // and you find out in a shop. Say so loudly, but still fail — a
      // half-populated cache that loads the page and then 404s a module
      // offline would be worse than no cache at all.
      console.error("Precache failed; offline mode is off.", e);
      throw e;
    }
    // Safe despite "new version goes live at the next launch": the app has no
    // lazy-loaded modules, so every file is already in the running page's
    // module graph. Swapping the cache underneath changes nothing until the
    // next navigation, which is exactly the intended behaviour.
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(n => n === CACHE ? null : caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if(req.method !== "GET") return;

  const url = new URL(req.url);
  // Drive and Google Identity are never cached and never intercepted: a stale
  // API response would be worse than no response, and an intercepted OAuth
  // flow would simply break.
  if(url.origin !== self.location.origin) return;

  // A navigation to any path in scope is the app itself.
  if(req.mode === "navigate"){
    event.respondWith((async () => {
      const cached = await caches.match("./index.html");
      return cached || fetch(req);
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if(cached) return cached;
    // Deliberately not cached: the cache stays exactly the precache set, so
    // what it holds is predictable and a bad response cannot poison it.
    return fetch(req);
  })());
});
