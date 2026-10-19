// Server for the relay-worker probes (research 19), run with bun. Two listeners on loopback:
//   RELAY_PROBE_PORT (5050): host.html (?coep=require-corp adds Cross-Origin-Embedder-Policy), host-worker.js (a
//     same-origin worker script for the COEP control), and the standalone control's job and result store;
//   RELAY_PROBE_CANARY_PORT (5051): /canary records every request that arrives (a fetch the policy must refuse), /hits
//     says how many arrived for an id.
// No dependency on the e2e harness or the 4444 vite server.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.RELAY_PROBE_PORT || 5050);
const CANARY_PORT = Number(process.env.RELAY_PROBE_CANARY_PORT || 5051);

// A worker script for the COEP control: it spawns a nested worker from a blob: URL it mints and reports what happened.
const HOST_WORKER = `
try {
  const nested = new Worker(URL.createObjectURL(new Blob(['postMessage("nested ran")'], { type: 'text/javascript' })));
  nested.onmessage = (e) => postMessage({ nested: e.data });
  nested.onerror = (e) => postMessage({ nested: 'error event: ' + e.message });
} catch (e) { postMessage({ nested: 'threw ' + e.name }); }
`;

const jobs = new Map();
const results = new Map();
const hits = new Map();

const body = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
});

http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const coep = url.searchParams.get('coep');
    const headers = { 'cache-control': 'no-store' };
    if (coep) headers['cross-origin-embedder-policy'] = coep;
    if (url.pathname === '/host.html') {
        // no CSP on the host page: the library's host page is the embedder's, unconstrained
        res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
        res.end(readFileSync(path.join(dir, 'host.html')));
        return;
    }
    if (url.pathname === '/host-worker.js') {
        res.writeHead(200, { ...headers, 'content-type': 'text/javascript', 'cross-origin-resource-policy': 'same-origin' });
        res.end(HOST_WORKER);
        return;
    }
    const id = url.searchParams.get('id') || '';
    if (url.pathname === '/job' && req.method === 'POST') {
        jobs.set(id, await body(req));
        res.writeHead(204).end();
        return;
    }
    if (url.pathname === '/job') {
        res.writeHead(jobs.has(id) ? 200 : 404, { 'content-type': 'application/json' });
        res.end(jobs.get(id) || '{}');
        return;
    }
    if (url.pathname === '/result' && req.method === 'POST') {
        results.set(id, await body(req));
        res.writeHead(204).end();
        return;
    }
    if (url.pathname === '/result') {
        res.writeHead(results.has(id) ? 200 : 404, { 'content-type': 'application/json' });
        res.end(results.get(id) || '{}');
        return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
}).listen(PORT, '127.0.0.1', () => console.log(`relay probes on http://localhost:${PORT}`));

http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const id = url.searchParams.get('id') || '';
    if (url.pathname === '/canary') {
        hits.set(id, (hits.get(id) || 0) + 1);
        res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' }).end('hit');
        return;
    }
    if (url.pathname === '/hits') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(String(hits.get(id) || 0));
        return;
    }
    res.writeHead(404).end();
}).listen(CANARY_PORT, '127.0.0.1');
