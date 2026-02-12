const CACHE_NAME = 'virtual-files-cache-v1';
const fileCache = new Map<string, string>();

const ACCESS_DENIED_HTML = `
<!DOCTYPE html>
<html style="background:#1a1a1a;color:#fff;font-family:system-ui,sans-serif;height:100%;display:flex;align-items:center;justify-content:center">
<head><title>Access Denied</title></head>
<body style="text-align:center">
    <h1 style="color:#ff5555">⚠️ Untrusted Content</h1>
    <p>This resource is part of a secure sandbox virtual file system.</p>
    <p>It is not permitted to be accessed directly from the browser context.</p>
</body>
</html>
`;

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
            const key = `/${sessionId}/${path.replace(/^\//, '')}`;
            fileCache.set(key, content as string);
        }
    }
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Check if file exists
    if (fileCache.has(url.pathname)) {
        // Access Control Logic
        // In Local-First architecture with Opaque Origins, the Origin header might be "null".
        // "srcdoc" sandboxes have origin "null".
        // We cannot rely solely on Origin validation for security if "null" is sent by other restricted frames.
        // However, the PATH contains the Session ID (UUID).
        // Since the Session ID is a capability token known only to the Host and the specific Sandbox instance,
        // possession of the URL implies access rights (Capability-based security).
        // BUT, if a user clicks a link, they have the URL.

        // Distinction: Navigation vs Subresource
        // event.request.mode === 'navigate' means the user typed it or clicked a link.
        // We want to BLOCK navigation (Top-level) to these files.
        // We only want to allow 'no-cors' (script/img) or 'cors' (fetch) from the sandbox.

        if (event.request.mode === 'navigate') {
             return event.respondWith(new Response(ACCESS_DENIED_HTML, {
                 headers: { 'Content-Type': 'text/html' }
             }));
        }

        const content = fileCache.get(url.pathname);
        const headers = {
            'Content-Type': 'text/javascript', // TODO: Proper MIME
            // TODO: Access-Control-Allow-Origin: null - if it works - is properbly better as sandbox iframe's have origin null
            'Access-Control-Allow-Origin': '*' // Needed for Opaque Origin to fetch
        };

        event.respondWith(new Response(content, { headers }));
        return;
    }

    if (url.pathname === '/' || url.pathname === '/hub.html') {
        return;
    }
});
