// A recording HTTP server for the header-less served-document probes (research 27), adapted from research 20's.
// Differences from research 20's server:
// - a route's response carries exactly the headers the route names, and nothing else of the server's own (node:http adds
//   only Date, Connection, Keep-Alive and Content-Length); the default is `Content-Type: text/html; charset=utf-8`
//   alone, which is what a header-less static host sends;
// - `srv.down = true` makes every request fail at the network level (the socket is destroyed), for the offline case;
// - the server is its own forward proxy: a request in absolute form (`GET http://app.insecure.test:PORT/x`) is answered
//   from the same routes, so a browser launched with `proxy: { server: srv.ip }` reaches it under any host name, which
//   is how a host page on a URL that is not potentially trustworthy is made on loopback;
// - reports keep the query of the report URL (`/__report?from=host`), which names the policy that sent them.
// One listener answers on every loopback name: `http://localhost:PORT` and `http://127.0.0.1:PORT` are two origins (two
// sites); a second server on another port of `localhost` is a same-site, cross-origin origin.
// Nothing here goes through Playwright's request routing (it breaks Service Worker registration on Firefox and WebKit).
import http from 'node:http';

export const HTML = { 'content-type': 'text/html; charset=utf-8' };

export function startServer(port = 0) {
    const routes = new Map();
    const requests = [];
    const reports = [];
    const state = { down: false };
    const server = http.createServer((req, res) => {
        if (state.down) { req.socket.destroy(); return; }
        const url = new URL(req.url || '/', 'http://x');
        const entry = {
            path: url.pathname,
            query: url.search,
            host: req.headers.host,
            proxied: /^https?:/.test(req.url || ''),
            dest: req.headers['sec-fetch-dest'],
            site: req.headers['sec-fetch-site'],
            referer: req.headers.referer,
            cacheControl: req.headers['cache-control'],
            ifNoneMatch: req.headers['if-none-match'],
        };
        requests.push(entry);
        if (url.pathname === '/__report') {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                let body = Buffer.concat(chunks).toString('utf8');
                try { body = JSON.parse(body); } catch { /* keep the text */ }
                reports.push({ from: url.searchParams.get('from'), host: req.headers.host, ct: req.headers['content-type'], body });
                res.writeHead(204).end();
            });
            return;
        }
        const r = routes.get(url.pathname);
        if (!r) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
        const out = typeof r === 'function' ? r(req, url) : r;
        res.writeHead(out.status ?? 200, out.headers ?? HTML);
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
                get down() { return state.down; },
                set down(v) { state.down = v; },
                route(path, def) { routes.set(path, def); },
                reset() { requests.length = 0; reports.length = 0; },
                close() { return new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }); },
            });
        });
    });
}
