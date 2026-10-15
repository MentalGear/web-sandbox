import { defineConfig } from 'vite';
import { join } from 'path';

// The e2e server (playwright.config.ts sets WEB_SANDBOX_E2E): no HMR websocket. Through it the dev server
// reloads every connected page whenever a file in its module graph is written (src/**, dist/index.js once
// package.spec.ts has loaded it, a tsconfig), whenever its dependency optimiser re-runs, and whenever the
// socket drops (the client polls and calls location.reload()). In a test that reload is the host page
// navigating mid-test: "Execution context was destroyed" from whatever page.evaluate was pending
// (reproduced: `bun run build:lib` during strict-render-flood.spec.ts's 3 s flood). Without the socket the
// client only logs that it could not connect, and nothing ever reloads a page under test.
const e2e = !!process.env.WEB_SANDBOX_E2E;

export default defineConfig({
  root: '.',
  resolve: {
    alias: {
      '@src': join(__dirname, 'src'),
    }
  },
  server: {
    // host: 'localhost',
    port: 4444,
    // open: '/playground/index.html',
    strictPort: true,
    ...(e2e ? { ws: false as const } : {}),
    fs: {
      allow: ['.'] // Allow serving files from the project root (for /src)
    }
  },
  build: {
    outDir: 'dist-playground',
    emptyOutDir: true,
    rollupOptions: {
      input: 'playground/index.html',
    },
  },
  plugins: [{
    name: 'dev-server',
    configureServer(server) {
      // What playwright.config.ts waits for: answers only on a server started without HMR, so a dev server
      // already running on 4444 (`bun run dev`, with HMR) is never reused for a test run.
      if (e2e) server.middlewares.use('/__e2e', (_req, res) => { res.setHeader('cache-control', 'no-store'); res.end('ok'); });
      // Test endpoint (fetch bridge specs, backlog B5): answers with the request's method and headers, so a
      // spec can see what reached the harness origin, outside the browser. Same origin as the harness, so a
      // credentialed request here carries the harness's cookies in every engine.
      server.middlewares.use('/__echo', (req, res) => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify({ method: req.method, headers: req.headers }));
      });
      // Test endpoint (host-policy.spec.ts, review round 1 R3-1): the e2e harness served with the policy headers a
      // spec names, `?csp=<Content-Security-Policy>` and `&coep=<Cross-Origin-Embedder-Policy>`, so a spec can mount
      // the sandbox on a host page whose own policy the sandbox's frames inherit. The page's one script is external
      // (host-policy-harness.ts), so a host policy without 'unsafe-inline' still runs it.
      server.middlewares.use('/__host-policy', (req, res) => {
        const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
        const csp = query.get('csp');
        const coep = query.get('coep');
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        if (csp) res.setHeader('content-security-policy', csp);
        if (coep) res.setHeader('cross-origin-embedder-policy', coep);
        res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>host policy harness</title>'
          + '<script type="module" src="/test/e2e/host-policy-harness.ts"></script></head>'
          + '<body></body></html>');
      });
      server.httpServer?.once('listening', () => {
        const { port, host } = server.config.server;
        const protocol = server.config.server.https ? 'https' : 'http';
        const playgroundUrl = `${protocol}://${host || "localhost"}:${port}/playground/index.html`;

        setTimeout(() => {
          server.config.logger.info(`\n  \x1b[32m➜\x1b[0m  \x1b[1mPlayground\x1b[0m: \x1b[36m${playgroundUrl}\x1b[0m`);
        }, 100);
      });
    }
  }],

});