// A static server for research 34's site/ on loopback: `/app/…` is site/app/ with no headers but the content type (a
// header-less static host), and `/cors/app/…` the same with `Access-Control-Allow-Origin: *` (a server that lets the
// host page read the file). `http://localhost:PORT` and `http://127.0.0.1:PORT` are two sites.
import { readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.txt': 'text/plain', '.json': 'application/json' };

export function startStatic(siteDir) {
    const requests = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://x');
        requests.push({ path: url.pathname, origin: req.headers.origin, dest: req.headers['sec-fetch-dest'], site: req.headers['sec-fetch-site'] });
        const cors = url.pathname.startsWith('/cors/');
        const rel = decodeURIComponent(cors ? url.pathname.slice('/cors'.length) : url.pathname);
        const file = path.join(siteDir, path.normalize(rel));
        if (!file.startsWith(siteDir) || !statSync(file, { throwIfNoEntry: false })?.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
        const headers = { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' };
        if (cors) headers['access-control-allow-origin'] = '*';
        res.writeHead(200, headers).end(readFileSync(file));
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        resolve({ port, local: `http://localhost:${port}`, ip: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
    }));
}
