// Service Worker for VFS Domain
// Handles serving virtual files to cross-origin sandboxes

const CACHE_NAME = 'vfs-cache-v1';
let virtualFiles: Record<string, string> = {};

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    self.clients.claim();
});

self.addEventListener('message', (event) => {
    if (event.data.type === 'REGISTER_FILES') {
        const { sessionId, files } = event.data;
        // Store files prefixed with session ID
        // e.g. /uuid/main.js -> content
        Object.entries(files).forEach(([path, content]) => {
            const key = `/${sessionId}/${path.replace(/^\//, '')}`;
            virtualFiles[key] = content as string;
        });
    }
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const path = url.pathname;

    // Check Origin Access Control
    // We only serve if Origin is Opaque ("null") or explicitly allowed?
    // "srcdoc" sandboxes have origin "null".
    // We can't verify "null" maps to a specific user, but we can verify the Session ID in the URL.
    // Since Session IDs are UUIDs known only to the Host and the Sandbox (via base tag),
    // treating the capability URL as the secret is acceptable for this threat model.

    if (virtualFiles[path]) {
        event.respondWith(new Response(virtualFiles[path], {
            headers: {
                'Content-Type': 'text/javascript',
                'Access-Control-Allow-Origin': '*' // Needed for Opaque Origin to fetch
            }
        }));
        return;
    }

    // Fallback
    if (path === '/' || path === '/index.html') {
        event.respondWith(new Response('VFS Hub Active'));
    }
});
