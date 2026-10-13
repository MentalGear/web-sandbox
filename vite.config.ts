import { defineConfig } from 'vite';
import { join } from 'path';

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
      // Test endpoint (fetch bridge specs, backlog B5): answers with the request's method and headers, so a
      // spec can see what reached the harness origin, outside the browser. Same origin as the harness, so a
      // credentialed request here carries the harness's cookies in every engine.
      server.middlewares.use('/__echo', (req, res) => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify({ method: req.method, headers: req.headers }));
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