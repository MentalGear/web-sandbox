// Static server for the strict-mode probes (research 15). Serves this directory's host.html on
// localhost:4466 and nothing else; no dependency on the e2e harness or the 4444 vite server.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.STRICT_PROBE_PORT || 4466);
const FILES = { '/host.html': ['host.html', 'text/html; charset=utf-8'] };

http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const file = FILES[pathname];
    if (!file) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
    }
    // no CSP on the host page: the library's host page is the embedder's, unconstrained
    res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-store' });
    res.end(readFileSync(path.join(dir, file[0])));
}).listen(PORT, '127.0.0.1', () => console.log(`strict probes on http://localhost:${PORT}`));
