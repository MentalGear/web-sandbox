// The recorder of research 33: one listener that is the browser's HTTP proxy, serves the fixture's pages, and records
// every connection the browser opens to it, from its first byte.
//
// - Every TCP connection is recorded when it is accepted (`tcp`), whatever follows: a preconnect that sends nothing is
//   still a row.
// - `CONNECT host:port` is recorded (`connect`) and answered `200`; the tunnel's first bytes are parsed as a TLS
//   ClientHello (`tls`: SNI and ALPN). The tunnel is then terminated with a self-signed certificate (the browser context
//   ignores certificate errors), so the HTTP request inside it is recorded too (`http`: method, path, and the headers
//   that say why it was made: `Sec-Purpose`, `Purpose`, `Sec-Fetch-*`, `Referer`).
// - A request in absolute form (`GET http://…`) is recorded the same way; a plain-HTTP preconnect would be a `tcp` row.
// - The fixture's pages live on `app.test` (any port): a request for that host is answered from the routes and recorded
//   as `page`. Every other host is the listed site: it gets a small HTML page with `Connection: close`, so no socket is
//   reused across cases.
// Nothing goes through Playwright's request routing; the browser reaches this listener only as its proxy.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

const PAGE_HOST = 'app.test';

/** A self-signed certificate for app.test and *.listed.example, made once per run with openssl. */
function certificate() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'r33-cert-'));
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=listed.example',
        '-addext', 'subjectAltName=DNS:app.test,DNS:listed.example,DNS:*.listed.example'], { stdio: 'ignore' });
    return { key: readFileSync(key), cert: readFileSync(cert) };
}

/** SNI and ALPN of a TLS ClientHello, or null when the bytes are not one. */
export function parseClientHello(buf) {
    if (buf.length < 6 || buf[0] !== 0x16 || buf[5] !== 0x01) return null;
    let p = 5 + 4 + 2 + 32;
    const out = { sni: null, alpn: [] };
    if (p >= buf.length) return out;
    p += 1 + buf[p];
    p += 2 + buf.readUInt16BE(p);
    p += 1 + buf[p];
    if (p + 2 > buf.length) return out;
    const end = Math.min(buf.length, p + 2 + buf.readUInt16BE(p));
    p += 2;
    while (p + 4 <= end) {
        const type = buf.readUInt16BE(p);
        const len = buf.readUInt16BE(p + 2);
        const body = buf.subarray(p + 4, p + 4 + len);
        if (type === 0 && body.length > 5) out.sni = body.subarray(5, 5 + body.readUInt16BE(3)).toString('latin1');
        if (type === 16 && body.length > 2) {
            let q = 2;
            while (q < body.length) { const l = body[q]; out.alpn.push(body.subarray(q + 1, q + 1 + l).toString('latin1')); q += 1 + l; }
        }
        p += 4 + len;
    }
    return out;
}

const WHY = ['sec-purpose', 'purpose', 'x-moz', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user', 'referer', 'ping-from', 'ping-to', 'content-type'];

export function startRecorder() {
    const events = [];
    const routes = new Map();
    let nextConn = 0;
    const keyPair = certificate();
    const record = (e) => { events.push({ t: Date.now(), ...e }); };

    const app = http.createServer((req, res) => {
        const tunnel = req.socket.r33 ?? {};
        const host = (req.headers.host ?? tunnel.target ?? '').replace(/:\d+$/, '');
        const url = new URL(req.url, `https://${req.headers.host ?? 'x'}`);
        const why = {};
        for (const h of WHY) if (req.headers[h] !== undefined) why[h] = String(req.headers[h]).slice(0, 200);
        if (host === PAGE_HOST) {
            record({ kind: 'page', conn: tunnel.conn, method: req.method, path: url.pathname, query: url.search, ...why });
            const route = routes.get(url.pathname);
            if (!route) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
            const out = route(url, req);
            res.writeHead(out.status ?? 200, out.headers ?? { 'content-type': 'text/html; charset=utf-8' });
            res.end(out.body ?? '');
            return;
        }
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            record({ kind: 'http', conn: tunnel.conn, host, method: req.method, path: url.pathname, query: url.search, body: Buffer.concat(chunks).toString('utf8').slice(0, 200), ...why });
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close', 'cache-control': 'no-store' });
            res.end('<!doctype html><title>listed</title><p>listed</p>');
        });
    });

    /** Reads until the first bytes of a connection are complete enough to classify. */
    const first = (socket, cb) => {
        let buf = Buffer.alloc(0);
        const onData = (c) => {
            buf = Buffer.concat([buf, c]);
            const isTls = buf[0] === 0x16;
            const ready = isTls ? buf.length >= 5 && buf.length >= 5 + buf.readUInt16BE(3) : buf.includes('\r\n\r\n');
            if (!ready && buf.length < 65536) return;
            socket.off('data', onData);
            socket.pause();
            cb(buf);
        };
        socket.on('data', onData);
    };

    // TLS (and plain HTTP) is answered by inner listeners: the connection's bytes, its first ones included, are piped to
    // one, and the inner connection is joined to the outer one by its port.
    const inner = new Map();
    const join = (s) => { s.r33 = inner.get(s.remotePort) ?? {}; s.on('error', () => {}); app.emit('connection', s); };
    const tlsServer = tls.createServer({ ...keyPair, ALPNProtocols: ['http/1.1'] }, join);
    tlsServer.on('tlsClientError', () => {});
    const plainServer = net.createServer(join);
    const pipeTo = (server, socket, buf, info) => {
        const up = net.connect(server.address().port, '127.0.0.1', () => {
            inner.set(up.localPort, info);
            up.write(buf);
            socket.pipe(up);
            up.pipe(socket);
            socket.resume();
        });
        up.on('error', () => socket.destroy());
        socket.on('close', () => up.destroy());
        up.on('close', () => socket.destroy());
    };
    const tlsInto = (socket, buf, conn, target) => {
        const hello = parseClientHello(buf);
        record({ kind: 'tls', conn, target, sni: hello?.sni ?? null, alpn: hello?.alpn ?? null });
        pipeTo(tlsServer, socket, buf, { conn, target });
    };

    const proxy = net.createServer((socket) => {
        const conn = ++nextConn;
        record({ kind: 'tcp', conn });
        socket.on('error', () => {});
        socket.on('close', () => record({ kind: 'close', conn }));
        first(socket, (buf) => {
            const head = buf.toString('latin1', 0, Math.min(buf.length, 2048));
            const m = /^CONNECT ([^\s]+) HTTP/.exec(head);
            if (m) {
                const target = m[1];
                record({ kind: 'connect', conn, target });
                socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                socket.resume();
                first(socket, (b2) => {
                    if (b2[0] === 0x16) { tlsInto(socket, b2, conn, target); return; }
                    record({ kind: 'tunnel-bytes', conn, target, first: b2.toString('latin1', 0, 80) });
                    socket.destroy();
                });
                return;
            }
            if (buf[0] === 0x16) { tlsInto(socket, buf, conn, null); return; }
            pipeTo(plainServer, socket, buf, { conn });
        });
    });

    const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', r));
    return Promise.all([listen(tlsServer), listen(plainServer)]).then(() => new Promise((resolve) => {
        proxy.listen(0, '127.0.0.1', () => {
            const port = proxy.address().port;
            resolve({
                port,
                proxy: `http://127.0.0.1:${port}`,
                pageOrigin: `https://${PAGE_HOST}:${port}`,
                events,
                route(p, fn) { routes.set(p, fn); },
                since(t) { return events.filter((e) => e.t >= t); },
                close() { return new Promise((r) => { tlsServer.close(); plainServer.close(); proxy.close(() => r()); }); },
            });
        });
    }));
}
