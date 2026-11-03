// Service worker for the electrician app (/tech). Registered with scope /tech only.
// Pages: network first, falling back to the last copy so the app opens with poor signal.
// Never touches /api (job data, photos, payments always go to the network).
const CACHE = "ps-tech-v1";
const SHELL = ["/tech", "/assets/pwa/icon-192.png", "/assets/pwa/tech.webmanifest"];

self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  if (req.mode === "navigate" || url.pathname.startsWith("/assets/pwa/")) {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match("/tech"))));
  }
});
