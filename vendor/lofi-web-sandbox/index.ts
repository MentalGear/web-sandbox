import { serve } from "bun";
import { join } from "path";

const ROOT = process.cwd();

serve({
  port: 4444,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/') return new Response(Bun.file(join(ROOT, 'playground/security.html')));

    // Serve src
    if (url.pathname.startsWith('/src/')) {
        return new Response(Bun.file(join(ROOT, url.pathname)));
    }

    // Serve VFS SW (mock vfs.localhost on same port for simplicity in test,
    // real impl needs separate domain)
    if (url.pathname === '/vfs-sw.js') {
        return new Response(Bun.file(join(ROOT, 'src/vfs-sw.js')), {
            headers: { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/' }
        });
    }

    return new Response("Not Found", { status: 404 });
  }
});
console.log("Lofi Server on 4444");
