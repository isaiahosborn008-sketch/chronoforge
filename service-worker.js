/* ChronoForge service worker — caches the app shell so it works fully offline. */
const CACHE_NAME = "chronoforge-cache-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event)=>{
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())
  );
});

self.addEventListener("activate", (event)=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(
      keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))
    )).then(()=>self.clients.claim())
  );
});

// Network-first for Google Calendar API calls (need live data),
// cache-first for everything else (the app shell) so the app opens instantly offline.
self.addEventListener("fetch", (event)=>{
  const url = event.request.url;
  if(url.includes("googleapis.com") || url.includes("accounts.google.com")){
    event.respondWith(fetch(event.request).catch(()=>new Response(null,{status:503})));
    return;
  }
  event.respondWith(
    caches.match(event.request).then(cached=>{
      if(cached) return cached;
      return fetch(event.request).then(resp=>{
        const copy = resp.clone();
        caches.open(CACHE_NAME).then(cache=>cache.put(event.request, copy));
        return resp;
      }).catch(()=> cached);
    })
  );
});
