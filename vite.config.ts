import { defineConfig } from 'vite';
import { join } from 'path';
import fs from 'fs';

export default defineConfig({
  root: 'playground',
  server: {
    port: 4444,
    strictPort: true,
    fs: {
      allow: ['..'] // Allow serving files from the project root (for /src)
    }
  },
  build: {
    outDir: '../dist-playground',
    emptyOutDir: true,
  },
  plugins: [{
    name: 'lofi-research-logic',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const host = req.headers.host || '';
        const url = new URL(req.url || '/', `http://${host}`);

        // 1. Handle Virtual Files Domain (subdomain routing)
        if (host.startsWith('virtual-files.')) {
          const path = url.pathname === '/' ? '/hub.html' : url.pathname;
          const filePath = join(__dirname, 'src/virtual-files', path);
          
          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath);
            res.setHeader('Access-Control-Allow-Origin', '*');
            if (filePath.endsWith('.html')) res.setHeader('Content-Type', 'text/html');
            if (filePath.endsWith('.ts')) res.setHeader('Content-Type', 'application/javascript');
            return res.end(content);
          }
        }

        // 2. Explicit Route for Virtual Files Demo
        if (url.pathname === '/virtual-files') {
          const content = fs.readFileSync(join(__dirname, 'playground/virtual-files-demo.html'));
          res.setHeader('Content-Type', 'text/html');
          return res.end(content);
        }

        next();
      });
    }
  }],
  resolve: {
    alias: {
      '@src': join(__dirname, 'src'),
    }
  }
});