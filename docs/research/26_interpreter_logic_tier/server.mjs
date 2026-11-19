// Research 26: the probe's server, a real node:http server on loopback (no Playwright routing), as research 20 and 24.
//
//   /host?h=<host policy>&v=<view policy>   the host page, its Content-Security-Policy a response header
//   /host.js                                 the host page's script ('self'): makes the sandboxed srcdoc view
//   /build/<file>                            the worker bundles and quickjs.wasm, from INTERP_DIR/build (build.mjs);
//                                            /build/native.js, a native worker that only reports it started
//   /extra/cost.js                           what the cost job appends to the worker: the benchmarks and app.js, natively
//   /__report (POST), /__reports (GET)       CSP reports the host page's policy sends, recorded
//
// The view is built as sealed mode builds it: an `iframe[sandbox="allow-scripts"]` whose srcdoc carries the library's own
// sealed view policy (sealedViewPolicy, read from src/, nothing of it changed) as a <meta>, admitting one inline script
// by its hash; that script makes a `blob:` worker from the source the host page hands it.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealedViewPolicy } from '../../../src/lib/csp/csp-generator.ts';
import { BENCH } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');
const BUILD = path.join(process.env.INTERP_DIR ?? '', 'build');
const sha = (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
const WUE = "'wasm-unsafe-eval'";

/** The view's one script (admitted by its hash): makes the worker from the source the host page posts, relays. */
export const VIEW_SCRIPT = `
const up = (data) => parent.postMessage(data, '*');
let worker = null;
addEventListener('securitypolicyviolation', (e) => up({ type: 'view-violation', directive: e.violatedDirective, blocked: e.blockedURI, sample: e.sample }));
addEventListener('message', (e) => {
  if (e.source !== parent) return;
  const m = e.data;
  if (m.cmd === 'start') {
    const t0 = performance.now();
    worker = new Worker(URL.createObjectURL(new Blob([m.source], { type: 'text/javascript' })));
    worker.onmessage = (ev) => { const d = ev.data; if (d && d.type === 'worker-started') d.spawnMs = Math.round((performance.now() - t0) * 100) / 100; up(d); };
    worker.onerror = (ev) => up({ type: 'worker-error', message: String(ev.message) });
    worker.postMessage(m.init);
  } else if (m.cmd === 'terminate') {
    worker.terminate();
    up({ type: 'terminated' });
  } else if (m.cmd === 'eval') {
    try { up({ type: 'view-eval', result: 'ran ' + eval('1') }); } catch (err) { up({ type: 'view-eval', result: 'refused ' + err.name }); }
  }
});
up({ type: 'view-ready' });
`;
export const VIEW_HASH = sha(VIEW_SCRIPT);

const SEALED = sealedViewPolicy({ fileKinds: new Set(), bootstrapHash: VIEW_HASH });
export const VIEW_POLICIES = {
    sealed: SEALED,
    'sealed-wue': SEALED.replace(`script-src ${VIEW_HASH}`, `script-src ${VIEW_HASH} ${WUE}`),
};
export const HOST_POLICIES = {
    none: null,
    nokw: `script-src 'self' ${VIEW_HASH}; worker-src blob:`,
    kw: `script-src 'self' ${VIEW_HASH} ${WUE}; worker-src blob:`,
    report: `script-src 'self' ${VIEW_HASH} ${WUE} 'report-sample'; worker-src blob:; report-uri /__report`,
    'report-nokw': `script-src 'self' ${VIEW_HASH} 'report-sample'; worker-src blob:; report-uri /__report`,
};

const viewDocument = (v) => `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${VIEW_POLICIES[v]}"><script>${VIEW_SCRIPT}</script>`;

const hostScript = (v) => `
window.events = [];
const frame = document.createElement('iframe');
frame.sandbox = 'allow-scripts';
frame.srcdoc = ${JSON.stringify(viewDocument(v))};
window.frame = frame;
addEventListener('message', (e) => { if (e.source === frame.contentWindow) window.events.push(e.data); });
addEventListener('securitypolicyviolation', (e) => window.events.push({ type: 'host-violation', directive: e.violatedDirective, blocked: e.blockedURI, sample: e.sample }));
document.body.append(frame);
window.waitFor = (type, ms) => new Promise((resolve) => {
  const t0 = performance.now();
  const check = () => {
    const found = window.events.find((x) => x && x.type === type);
    if (found) return resolve(found);
    if (performance.now() - t0 > ms) return resolve({ type: 'timeout', waitedFor: type, recent: window.events.slice(-6) });
    setTimeout(check, 25);
  };
  check();
});
window.startJob = async ({ bundle, wasm, job, extra }) => {
  let source = await (await fetch('/build/' + bundle)).text();
  if (extra) source += '\\n' + await (await fetch('/extra/' + extra)).text();
  const bytes = wasm ? await (await fetch('/build/quickjs.wasm')).arrayBuffer() : null;
  await window.waitFor('view-ready', 10000);
  frame.contentWindow.postMessage({ cmd: 'start', source, init: { wasm: bytes, job } }, '*');
};
window.view = (cmd) => frame.contentWindow.postMessage({ cmd }, '*');
`;

const costExtra = () => {
    const app = readFileSync(path.join(ROOT, 'examples/sealed-app/app.js'), 'utf8');
    const natives = Object.entries(BENCH).map(([name, source]) => `${name}: ${source}`).join(',\n');
    return `self.NATIVE = {\n${natives}\n};\nself.APP_NATIVE = function (sandboxView, bridge, sandboxFiles) {\n${app}\n};\n`;
};

export const APP_SOURCE = () => readFileSync(path.join(ROOT, 'examples/sealed-app/app.js'), 'utf8');

export function startServer() {
    const reports = [];
    const requests = [];
    const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        requests.push(url.pathname);
        if (url.pathname === '/host') {
            const h = url.searchParams.get('h') ?? 'none';
            const v = url.searchParams.get('v') ?? 'sealed';
            const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
            if (HOST_POLICIES[h]) headers['content-security-policy'] = HOST_POLICIES[h];
            res.writeHead(200, headers).end(`<!doctype html><meta charset="utf-8"><title>host</title><body><script src="/host.js?v=${v}"></script>`);
        } else if (url.pathname === '/host.js') {
            res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }).end(hostScript(url.searchParams.get('v') ?? 'sealed'));
        } else if (url.pathname === '/build/native.js') {
            res.writeHead(200, { 'content-type': 'text/javascript' }).end("self.postMessage({ type: 'worker-started' }); self.postMessage({ type: 'done' });");
        } else if (url.pathname.startsWith('/build/')) {
            const file = path.basename(url.pathname);
            const type = file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
            try { res.writeHead(200, { 'content-type': type }).end(readFileSync(path.join(BUILD, file))); } catch { res.writeHead(404).end(); }
        } else if (url.pathname === '/extra/cost.js') {
            res.writeHead(200, { 'content-type': 'text/javascript' }).end(costExtra());
        } else if (url.pathname === '/__report' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => { reports.push(body); res.writeHead(204).end(); });
        } else if (url.pathname === '/__reports') {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reports));
        } else {
            res.writeHead(404).end('no');
        }
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
        const origin = `http://localhost:${server.address().port}`;
        resolve({ origin, reports, requests, close: () => new Promise((r) => server.close(r)) });
    }));
}
