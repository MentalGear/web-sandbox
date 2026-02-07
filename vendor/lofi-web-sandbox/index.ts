import { serve } from "bun";
import { join } from "path";

const ROOT = join(process.cwd(), 'vendor/lofi-web-sandbox');

serve({
  port: 4444,
  async fetch(req) {
    const url = new URL(req.url);
    const host = req.headers.get('host') || '';

    // Helper to serve files
    const serveFile = async (path, type) => {
        const f = Bun.file(path);
        if (await f.exists()) {
            return new Response(f, {
                headers: {
                    'Content-Type': type || f.type,
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }
        return new Response("Not Found: " + path, { status: 404 });
    };

    // Virtual Files Domain (Mock/Real)
    if (host.startsWith('virtual-files.')) {
        const path = url.pathname === '/' ? '/hub.html' : url.pathname;
        const filePath = join(ROOT, 'src/virtual-files', path);
        if (filePath.endsWith('.ts')) {
             const build = await Bun.build({ entrypoints: [filePath], target: "browser" });
             return new Response(build.outputs[0], { headers: { 'Content-Type': 'application/javascript' } });
        }
        return serveFile(filePath);
    }

    // Host Routes
    if (url.pathname === '/') {
        return serveFile(join(ROOT, 'playground/vfs-demo.html'), 'text/html');
    }

    if (url.pathname === '/security') {
        return serveFile(join(ROOT, 'playground/security.html'), 'text/html');
    }

    // Serve Playground Assets (including subfolders like /project/)
    // vfs-demo.html fetches './project/app.js' -> /project/app.js? No, relative to / -> /project/app.js
    if (url.pathname.startsWith('/project/')) {
        return serveFile(join(ROOT, 'playground', url.pathname));
    }

    // Serve Source (TS Transpilation)
    if (url.pathname.startsWith('/src/')) {
        const filePath = join(ROOT, url.pathname);
        if (filePath.endsWith('.ts')) {
            const build = await Bun.build({
                entrypoints: [filePath],
                target: "browser",
            });
            if (build.success) {
                return new Response(build.outputs[0], {
                    headers: { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*' }
                });
            } else {
                return new Response("Build Failed: " + build.logs.join('\n'), { status: 500 });
            }
        }
        return serveFile(filePath);
    }

    return new Response("Not Found: " + url.pathname, { status: 404 });
  }
});
console.log("Lofi Server running on http://localhost:4444");
console.log("- VFS Demo: http://localhost:4444/");
console.log("- Security Host: http://localhost:4444/security");
