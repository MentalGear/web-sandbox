// A small recording HTTP server for the served-document probes (research 20), on loopback, run with bun or node.
// Every probe registers its routes with `srv.route(path, { status, headers, body })` and reads `srv.requests`
// (what arrived: URL, Host, Origin, Sec-Fetch-*, Referer) and `srv.reports` (bodies posted to /__report).
// One listener answers on every loopback name: `http://localhost:PORT` and `http://127.0.0.1:PORT` are two origins
// (two sites) served by the same process, which is how the cross-origin cases are made.
// Nothing here goes through Playwright's request routing: Playwright's page.route / context.route breaks Service
// Worker registration on Firefox and WebKit.
import http from 'node:http';

export function startServer(port = 0) {
    const routes = new Map();
    const requests = [];
    const reports = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://x');
        const entry = {
            path: url.pathname,
            query: url.search,
            host: req.headers.host,
            origin: req.headers.origin,
            dest: req.headers['sec-fetch-dest'],
            mode: req.headers['sec-fetch-mode'],
            site: req.headers['sec-fetch-site'],
            referer: req.headers.referer,
        };
        requests.push(entry);
        if (url.pathname === '/__report') {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                let body = Buffer.concat(chunks).toString('utf8');
                try { body = JSON.parse(body); } catch { /* keep the text */ }
                reports.push({ host: req.headers.host, ct: req.headers['content-type'], body });
                res.writeHead(204).end();
            });
            return;
        }
        const r = routes.get(url.pathname);
        if (!r) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
        const out = typeof r === 'function' ? r(req, url) : r;
        res.writeHead(out.status ?? 200, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8', ...out.headers });
        res.end(out.body ?? '');
    });
    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
            const p = server.address().port;
            resolve({
                port: p,
                local: `http://localhost:${p}`,
                ip: `http://127.0.0.1:${p}`,
                requests,
                reports,
                route(path, def) { routes.set(path, def); },
                reset() { requests.length = 0; reports.length = 0; },
                close() { return new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }); },
            });
        });
    });
}

if (import.meta.main) {
    const srv = await startServer(Number(process.env.PORT || 0));
    console.log(`listening on ${srv.local} (no routes registered: this module is a library for the probes)`);
}
