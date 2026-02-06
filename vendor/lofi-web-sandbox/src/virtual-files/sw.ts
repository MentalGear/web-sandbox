const CACHE_NAME = 'vfs-v1';
// In-memory cache for simplicity (production should use IDB)
const fileCache = new Map<string, string>();

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    self.clients.claim();
});

self.addEventListener('message', (event) => {
    if (event.data.type === 'PUT_FILES') {
        const { sessionId, files } = event.data;
        for (const [path, content] of Object.entries(files)) {
            // Key: /sessionId/path
            const key = `/${sessionId}/${path.replace(/^\//, '')}`;
            fileCache.set(key, content as string);
        }
    }
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Virtual Files
    // Format: /sessionId/file.js
    if (fileCache.has(url.pathname)) {
        const content = fileCache.get(url.pathname);
        const headers = {
            'Content-Type': 'text/javascript', // Auto-detect in prod
            'Access-Control-Allow-Origin': '*' // Crucial for Opaque Origin access
        };

        event.respondWith(new Response(content, { headers }));
        return;
    }

    // Fallback for Hub
    if (url.pathname === '/' || url.pathname === '/hub.html') {
        return; // Network
    }

    // 404
    // event.respondWith(new Response('Not Found in VFS', { status: 404 }));
});
