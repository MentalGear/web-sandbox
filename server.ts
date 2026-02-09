import { serve } from "bun";
import { join } from "path";

const ROOT = import.meta.dir;
const PORT = 4444;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
};


serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const host = req.headers.get('host') || '';

    // 1. Handle Virtual Files Domain (subdomain routing)
    if (host.startsWith('virtual-files.')) {
      const path = url.pathname === '/' ? '/hub.html' : url.pathname;
      const filePath = join(ROOT, 'src/virtual-files', path);

      if (filePath.endsWith('.ts')) {
        return transpileTS(filePath, { 'Service-Worker-Allowed': '/' });
      }
      return serveFile(filePath);
    }

    // 2. Explicit Routes
    if (url.pathname === '/') {
      return serveFile(join(ROOT, 'playground/index.html'), 'text/html');
    }

    if (url.pathname === '/virtual-files') {
      return serveFile(join(ROOT, 'playground/virtual-files-demo.html'), 'text/html');
    }

    // 3. Asset Resolution (Fallback to playground directory)
    let filePath = join(ROOT, url.pathname);
    const playgroundPath = join(ROOT, 'playground', url.pathname);

    if (!(await Bun.file(filePath).exists()) && (await Bun.file(playgroundPath).exists())) {
      filePath = playgroundPath;
    }

    // 4. Serve or Transpile
    if (filePath.endsWith('.ts')) {
      return transpileTS(filePath);
    }

    return serveFile(filePath);
  }
});

console.log(`Lofi Server running on http://localhost:${PORT}`);
console.log(`- Playground: http://localhost:${PORT}/`);
console.log(`- Virtual Files Demo: http://localhost:${PORT}/virtual-files`);

/**
 * Helper to serve static files with correct headers
 */
async function serveFile(path: string, contentType?: string) {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return new Response(`Not Found: ${path}`, { status: 404 });
  }

  return new Response(file, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': contentType || file.type,
    },
  });
}

/**
 * Transpiles TypeScript files on the fly for the browser
 */
async function transpileTS(path: string, extraHeaders: Record<string, string> = {}) {
  const build = await Bun.build({
    entrypoints: [path],
    target: "browser",
  });

  if (!build.success) {
    console.error("Build Failed:", build.logs);
    return new Response("Build Failed: " + build.logs.join('\n'), { status: 500 });
  }

  return new Response(build.outputs[0], {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/javascript',
      ...extraHeaders,
    },
  });
}
