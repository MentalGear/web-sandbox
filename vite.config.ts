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
            res.setHeader('Access-Control-Allow-Origin', '*');
            
            // If it's a TS file, we should ideally let Vite transform it.
            // For now, ensure we aren't serving raw TS if the browser expects JS.
            if (filePath.endsWith('.ts')) {
              res.setHeader('Content-Type', 'application/javascript');
              // Note: In a production-like research tool, you'd use server.transformRequest(url)
            }

            const content = fs.readFileSync(filePath);
            if (filePath.endsWith('.html')) res.setHeader('Content-Type', 'text/html');
            return res.end(content);
          }
        }

        // 2. Explicit Route for Virtual Files Demo
        if (url.pathname === '/virtual-files') {
          // Rewrite the URL so Vite handles the file from the 'playground' root
          // This ensures plugins, aliases, and HMR work correctly.
          req.url = '/virtual-files-demo.html';
          return next();
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