/* ChatWave service worker — PWA offline support.
   Static assets: cache-first. Pages: network-first with /offline fallback.
   API, Socket.IO, and media requests are never intercepted. */

const CACHE = "chatwave-v2";
const STATIC_ASSETS = [
  "/offline",
  "/static/css/style.css",
  "/static/js/common.js",
  "/static/js/call.js",
  "/static/js/home.js",
  "/static/js/chat.js",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
  "/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  // Never touch live traffic: API polling, signaling, uploads.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io/")) return;

  // Static assets: cache-first
  if (url.pathname.startsWith("/static/") || url.pathname === "/manifest.json") {
    event.respondWith(
      caches.match(event.request).then((hit) => hit || fetch(event.request).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return resp;
      }))
    );
    return;
  }

  // Pages: network-first, offline fallback
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request).then((hit) => hit || caches.match("/offline"))
    )
  );
});
