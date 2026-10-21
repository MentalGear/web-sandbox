// The host page's Service Worker, for test/e2e/fetch-bridge-isolation.spec.ts (BD1:ISO-1): an ordinary cache-first worker
// (the shape of Workbox's CacheFirst runtime caching) for the paths that spec names: a request is answered from the
// cache when it holds the URL, else from the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
    if (!event.request.url.includes('/iso-')) return;
    event.respondWith(caches.match(event.request.url).then((cached) => cached || fetch(event.request)));
});
