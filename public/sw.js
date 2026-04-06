// Delt — Service Worker (PWA shell cache + offline fallback)
const CACHE_NAME = "delt-v2";
const OFFLINE_URL = "/offline.html";
const SHELL_URLS = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.json",
  "/offline.html",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET and API/WS requests
  if (event.request.method !== "GET") return;
  if (url.pathname.startsWith("/health") ||
      url.pathname.startsWith("/config") ||
      url.pathname.startsWith("/history") ||
      url.pathname.startsWith("/logs") ||
      url.pathname.startsWith("/integrations") ||
      url.pathname.startsWith("/mobile") ||
      url.pathname.startsWith("/memory") ||
      url.pathname.startsWith("/upload") ||
      url.pathname.startsWith("/oauth") ||
      url.pathname.startsWith("/setup") ||
      url.pathname.startsWith("/api")) {
    return;
  }

  // Navigation requests — network first, offline fallback
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(OFFLINE_URL))
    );
    return;
  }

  // Static assets — stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetched = fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});
