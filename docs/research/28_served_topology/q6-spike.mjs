// Q6. Feasibility spike: the library's own default build runs examples/sealed-app with its wrapper served as a file
// (research 28's static topology: F is the wrapper document, C the view in F's markup, W the view's worker), with no
// edit to src/.
//
//   bun docs/research/28_served_topology/q6-spike.mjs <engine> [path/to/index.js]   # default: dist/index.js
//
// How: the host page installs one shim before it imports the bundle. When the library assigns an iframe's `srcdoc` (its
// one sink for the wrapper, setLibrarySrcdoc), the shim stores that exact document on the server (a synchronous POST)
// and sets the iframe's `src` to the stored file's URL instead, on the host's origin, sent with Content-Type only. So
// the document the browser loads is byte for byte the library's wrapper (its WRAPPER_CSP <meta>, its <base>, the view as a
// srcdoc child with the per-build policy and the hashed bootstrap), but it is a served document: it starts a policy
// container of its own instead of inheriting the host page's. The host page carries a strict policy that does not admit
// the view's bootstrap hash, its inline styles or blob: (with the srcdoc wrapper this policy is inherited and ends the
// build); the control mounts the same app with no shim. examples/sealed-app/host.js mounts the app; the spike then
// calls `load` with two todos, types a third into the view and presses Enter, and reads what the host's store holds.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINES, emit, emitRun, sleep } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const EXAMPLE = path.join(ROOT, 'examples/sealed-app');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };

// The shim: the library's wrapper srcdoc becomes a served file.
const SHIM = `
const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc');
window.served = [];
Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', { configurable: true, get() { return desc.get.call(this); }, set(v) {
  if (!window.SERVE) return desc.set.call(this, v);
  const x = new XMLHttpRequest(); x.open('POST', '/__stash', false); x.send(String(v));
  window.served.push(x.responseText);
  this.setAttribute('src', '/stash/' + x.responseText);
} });`;
const HOST = (serve, nonce) => `<!doctype html><html><head><meta charset="utf-8"><title>spike host</title></head><body><div id="apps"></div>
<script nonce="${nonce}">window.SERVE = ${serve}; ${SHIM}</script>
<script nonce="${nonce}" type="module">
import { defineWebSandbox } from '/lib/index.js';
defineWebSandbox();
import { mountTodoApp } from '/examples/sealed-app/host.js';
window.events = [];
const data = new Map();
window.store = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), data };
try {
  window.app = await mountTodoApp(document.getElementById('apps'), { bundle: '/bundle', appId: 'todo-app', store: window.store });
  for (const t of ['violation', 'sandbox-terminated', 'sandbox-log']) window.app.sandbox.addEventListener(t, (e) => window.events.push({ t, d: JSON.stringify(e.detail).slice(0, 200) }));
  window.mounted = 'mounted';
} catch (e) { window.mounted = 'failed: ' + String(e && e.message || e).slice(0, 300); }
</script></body></html>`;
// The host page's policy: strict, as a production page's might be: no 'unsafe-inline', no blob:, no hash of the library's.
const HOST_CSP = (nonce) => `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; img-src 'self'; frame-src 'self'; worker-src 'none'; base-uri 'none'`;

function startServer(bundlePath) {
    const stash = new Map();
    const requests = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        requests.push(url.pathname);
        if (req.method === 'POST' && url.pathname === '/__stash') {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => { const id = String(stash.size + 1); stash.set(id, Buffer.concat(chunks).toString('utf8')); res.writeHead(200, { 'content-type': 'text/plain' }).end(id); });
            return;
        }
        const send = (type, body, extra = {}) => res.writeHead(200, { 'content-type': type, ...extra }).end(body);
        if (url.pathname.startsWith('/stash/')) return send(TYPES['.html'], stash.get(url.pathname.slice(7)) ?? '');
        if (url.pathname === '/host.html' || url.pathname === '/control.html') {
            const nonce = 'sp1ke';
            return send(TYPES['.html'], HOST(url.pathname === '/host.html', nonce), url.searchParams.has('strict') ? { 'content-security-policy': HOST_CSP(nonce) } : {});
        }
        if (url.pathname === '/lib/index.js') return send(TYPES['.js'], readFileSync(bundlePath));
        if (url.pathname.startsWith('/examples/sealed-app/') || url.pathname.startsWith('/bundle/')) {
            const name = path.basename(url.pathname);
            return send(TYPES[path.extname(name)], readFileSync(path.join(EXAMPLE, name)));
        }
        res.writeHead(404).end();
    });
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ port: server.address().port, stash, requests, close: () => { server.closeAllConnections?.(); server.close(); } })));
}

async function runEngine(name, bundlePath) {
    const srv = await startServer(bundlePath);
    const browser = await ENGINES[name].launch();
    emitRun('q6', name, browser);
    const bytes = readFileSync(bundlePath);
    emit('q6.bundle', { path: path.relative(ROOT, bundlePath), bytes: bytes.length, sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex').slice(0, 16) });
    for (const [label, file] of [['served wrapper (shim), strict host policy', '/host.html?strict'], ['served wrapper (shim), no host policy', '/host.html'], ['control: srcdoc wrapper (no shim), strict host policy', '/control.html?strict'], ['control: srcdoc wrapper (no shim), no host policy', '/control.html']]) {
        const page = await (await browser.newContext()).newPage();
        const consoleLines = [];
        page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(m.text().slice(0, 200)); });
        await page.goto(`http://localhost:${srv.port}${file}`);
        let mounted;
        for (let i = 0; i < 100 && !mounted; i++) { await sleep(100); mounted = await page.evaluate(() => window.mounted).catch(() => undefined); }
        const out = { engine: name, case: label, mounted: mounted ?? 'no answer in 10 s' };
        if (mounted === 'mounted') {
            await page.evaluate(() => window.app.sandbox.call('load', [{ text: 'one', done: false }, { text: 'two', done: true }]));
            await sleep(500);
            const view = page.frames().find((f) => f.parentFrame() && f.parentFrame() !== page.mainFrame());
            out.wrapperUrl = page.frames().find((f) => f.parentFrame() === page.mainFrame())?.url().slice(0, 60);
            out.viewUrl = view?.url();
            out.viewEnv = view ? await view.evaluate(() => ({ origin: String(self.origin), base: document.baseURI })).catch((e) => String(e).slice(0, 80)) : 'no view';
            out.listText = view ? await view.evaluate(() => document.querySelector('#list')?.innerText ?? 'no #list').catch((e) => String(e).slice(0, 80)) : 'no view';
            if (view) {
                try {
                    await view.locator('#new').fill('three');
                    await view.locator('#new').press('Enter');
                    await sleep(800);
                } catch (e) { out.typing = String(e).slice(0, 120); }
            }
            out.stored = await page.evaluate(() => window.store.getItem('todos:todo-app'));
            out.events = await page.evaluate(() => window.events);
        }
        out.servedDocuments = await page.evaluate(() => (window.served || []).length);
        out.console = [...new Set(consoleLines)].slice(0, 8);
        emit('q6', out);
        await page.context().close();
    }
    await browser.close();
    srv.close();
}

const args = process.argv.slice(2);
const bundle = args.find((a) => a.endsWith('.js')) ?? path.join(ROOT, 'dist/index.js');
for (const name of args.filter((a) => a in ENGINES)) {
    try { await runEngine(name, bundle); } catch (e) { emit('q6.error', { engine: name, error: String(e).slice(0, 400) }); }
}
process.exit(0);
