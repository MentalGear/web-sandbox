import { serve } from "bun";
import { join } from "path";

const ROOT = join(process.cwd(), 'vendor/lofi-web-sandbox');

serve({
  port: 4444,
  async fetch(req) {
    const url = new URL(req.url);
    const host = req.headers.get('host') || '';

    // Virtual Files Domain
    // Matches virtual-files.localhost or mocked in test via explicit mapping
    if (host.startsWith('virtual-files.')) {
        // Serve Hub and SW from src/virtual-files/
        const path = url.pathname === '/' ? '/hub.html' : url.pathname;
        const filePath = join(ROOT, 'src/virtual-files', path);
        const f = Bun.file(filePath);

        if (await f.exists()) {
             // TS Handling
             if (filePath.endsWith('.ts')) {
                const build = await Bun.build({ entrypoints: [filePath], target: "browser" });
                return new Response(build.outputs[0], {
                    headers: { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/' }
                });
             }
             return new Response(f, {
                 headers: { 'Content-Type': f.type, 'Service-Worker-Allowed': '/' }
             });
        }
        return new Response("VF Not Found: " + path, { status: 404 });
    }

    // Host Domain (localhost:4444)
    // ... existing logic ...

    // Helper to serve with CORS
    const serveFile = async (path) => {
        const f = Bun.file(path);
        if (await f.exists()) {
            return new Response(f, {
                headers: {
                    'Content-Type': f.type,
                    'Access-Control-Allow-Origin': '*' // Allow fetching from sandbox
                }
            });
        }
        return new Response("Not Found", { status: 404 });
    }

    if (url.pathname === '/') return serveFile(join(ROOT, 'playground/security.html'));

    if (url.pathname.startsWith('/src/')) {
        const filePath = join(ROOT, url.pathname);
        if (filePath.endsWith('.ts')) {
            const build = await Bun.build({
                entrypoints: [filePath],
                target: "browser",
            });
            return new Response(build.outputs[0], {
                headers: { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*' }
            });
        }
        return serveFile(filePath);
    }

    // Mock VFS (Legacy) - Keeping for old tests or replacing?
    // Let's keep it for vfs.spec.ts unless we update that too.
    if (url.pathname.startsWith('/vfs/')) {
        return new Response('console.log("VFS Loaded"); window.parent.postMessage({type:"LOG", args:["VFS Loaded"]}, "*");', {
            headers: { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*' }
        });
    }

    return new Response("Not Found: " + url.pathname, { status: 404 });
  }
});
console.log("Lofi Server on 4444");
