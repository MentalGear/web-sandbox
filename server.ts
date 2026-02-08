import { serve } from "bun";
import { join } from "path";

// Use import.meta.dir to handle execution from anywhere
const ROOT = import.meta.dir;

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

    // Virtual Files Domain
    if (host.startsWith('virtual-files.')) {
        const path = url.pathname === '/' ? '/hub.html' : url.pathname;
        const filePath = join(ROOT, 'src/virtual-files', path);

        if (filePath.endsWith('.ts')) {
             const build = await Bun.build({ entrypoints: [filePath], target: "browser" });
             return new Response(build.outputs[0], {
                 headers: { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/' }
             });
        }
        return serveFile(filePath);
    }

    // Host Routes
    // / -> security (Standard Playground)
    // /virtual-files -> vfs-demo (VFS Demo)

    if (url.pathname === '/') {
        return serveFile(join(ROOT, 'playground/index.html'), 'text/html');
    }

    // Backward compatibility for existing tests using /security
    if (url.pathname === '/security') {
        // We can serve index.html here too if tests are updated to use it,
        // OR keep serving the minimal security.html if we kept it.
        // I kept it in previous step but index.html is better.
        // Let's check if security.html still exists.
        // Tests rely on window.SandboxControl.
        // index.html has it too.
        return serveFile(join(ROOT, 'playground/index.html'), 'text/html');
    }

    if (url.pathname === '/virtual-files') {
        return serveFile(join(ROOT, 'playground/vfs-demo.html'), 'text/html');
    }

    // Serve Playground Assets (state.ts, etc)
    // Also handle relative imports from index.html (like state.ts)
    // If request is /state.ts, it maps to playground/state.ts
    // If request is /playground/state.ts, it maps to playground/state.ts

    let filePath = join(ROOT, url.pathname);

    // Check if it's a playground asset at root level (e.g. /state.ts)
    // Try playground path if root path doesn't exist
    const playgroundPath = join(ROOT, 'playground', url.pathname);
    if (!(await Bun.file(filePath).exists()) && await Bun.file(playgroundPath).exists()) {
        filePath = playgroundPath;
    }

    // TypeScript Transpilation
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
            console.error("Build Failed:", build.logs);
            return new Response("Build Failed: " + build.logs.join('\n'), { status: 500 });
        }
    }

    // Static Files
    if (await Bun.file(filePath).exists()) {
        return serveFile(filePath);
    }

    return new Response("Not Found: " + url.pathname, { status: 404 });
  }
});
console.log("Lofi Server running on http://localhost:4444");
console.log("- Playground: http://localhost:4444/");
console.log("- VFS Demo: http://localhost:4444/virtual-files");
