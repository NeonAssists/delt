// Delt — Service Worker (PWA offline fallback only)
// Strategy: ALWAYS use network. Cache is ONLY for offline fallback.
const CACHE_NAME = "delt-v8";
const OFFLINE_URL = "/offline.html";
const SHELL_URLS = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.json",
  "/offline.html",
];

// Listen for skip-waiting message from the page
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("install", (event) => {
  // Activate immediately — don't wait for old tabs to close
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS))
  );
});

self.addEventListener("activate", (event) => {
  // Take control of all pages immediately
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET and API/WS requests entirely
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

  // EVERYTHING is network-first. Cache is only for when you're offline.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Offline — try cache, or show offline page for navigation
        if (event.request.mode === "navigate") {
          return caches.match(OFFLINE_URL);
        }
        return caches.match(event.request);
      })
  );
});
