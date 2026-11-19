// Q7. Start-up gates: before the served file F says it is ready (before any guest content exists in F, its view C or the
// worker W), each realm runs a fixed list of canaries that confirm the browser enforces what the design assumes, and F
// ends with the names of the gates that did not hold. Does each canary (a) show the guarantee when it holds, (b) show it
// by a thrown error or a result, not by a securitypolicyviolation event, (c) touch no network and carry nothing of the
// guest's if the guarantee is broken? Which gate does each mutant trip? What does the list cost at start-up, and what does
// an outside report-only policy on the file receive from it?
//
//   bun docs/research/28_served_topology/q7-gates.mjs <engine> [runs]     # default 12 timing runs per variant
//
// The canaries (GATES below; every URL is data:, blob: or a name under .invalid, which is never requested):
//   opaque        self.origin === 'null'                                          F, C, W
//   framed        top !== self                                                    F
//   stringCode    new Function('') throws                                         F, C, W   (script-src without 'unsafe-eval')
//   connect       fetch(<a blob: URL minted here>) rejects                         F, C, W   (connect-src 'none')
//   image         a data: image fires error, not load                              F, C      (img-src without data:)
//   style         a <style> element whose text is not the hashed one does not apply  F, C      (style-src without 'unsafe-inline')
//   base          a <base href="http://gate.invalid/"> leaves document.baseURI     F, C      (base-uri 'none')
//   frame         a data: iframe whose script posts back does not post within 800 ms  F, C   (frame-src 'none'; blind while script-src holds, see the README)
//   cookie        writing a cookie of a fixed name throws, or it is not kept          F, C      (sandbox without allow-same-origin)
//   storage       localStorage (documents) / indexedDB.open (worker) throws         F, C, W
//   parent        parent.document throws                                           F, C
//   names         after the worker's allowlist step, fetch, XMLHttpRequest, WebSocket, EventSource, importScripts are gone  W
// Variants: the correct file framed sandbox="allow-scripts"; mutants (no <meta>; one directive weakened at a time; framed
// without sandbox; allow-same-origin; the worker's allowlist step skipped); the correct file under an outside
// report-only header (what reaches its report-uri); and a file with the same flow and no canaries (the cost).
import { ENGINES, emit, emitRun, esc, load1, median, range, sha, sleep } from './lib.mjs';
import { HTML, startServer } from './server.mjs';
import { slimReport } from '../27_served_document_headerless/probe-doc.mjs';

const STILL = '#still { color: rgb(7, 8, 9) }';
// one async function, for a document or a worker; returns { [gate]: 'held' | 'broken: …' }
const GATES = `async (where, noFrame) => {
  const g = {};
  const isDoc = typeof document !== 'undefined';
  const within = (p, ms, late) => Promise.race([p, new Promise((r) => setTimeout(() => r(late), ms))]);
  const throwsHeld = (f) => { try { f(); return 'broken: did not throw'; } catch (e) { return 'held'; } };
  g.opaque = String(self.origin) === 'null' ? 'held' : 'broken: ' + self.origin;
  if (where === 'F') g.framed = top !== self ? 'held' : 'broken: top-level';
  g.stringCode = throwsHeld(() => new Function(''));
  const blob = URL.createObjectURL(new Blob(['x'], { type: 'text/plain' }));
  g.connect = await within(fetch(blob).then(() => 'broken: fetched', () => 'held'), 2000, 'broken: no answer');
  if (isDoc) {
    g.image = await within(new Promise((r) => { const i = new Image(); i.onload = () => r('broken: loaded'); i.onerror = () => r('held'); i.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'); }), 2000, 'broken: no answer');
    const p = document.createElement('p'); p.id = 'gstyle'; document.body.append(p);
    const s = document.createElement('style'); s.textContent = '#gstyle { color: rgb(9, 9, 9) }'; document.head.append(s);
    let c = ''; for (let i = 0; i < 50 && (c = getComputedStyle(p).color) === ''; i++) await new Promise((r) => setTimeout(r, 20));
    g.style = c === '' ? 'broken: unmeasured' : c === 'rgb(9, 9, 9)' ? 'broken: applied' : 'held';
    g.styleSheetNull = s.sheet === null ? 'null' : 'a sheet';
    s.remove(); p.remove();
    const before = document.baseURI;
    const b = document.createElement('base'); b.href = 'http://gate.invalid/'; document.head.append(b);
    g.base = document.baseURI === before ? 'held' : 'broken: ' + document.baseURI.slice(0, 30);
    b.remove();
    if (!noFrame) g.frame = await new Promise((r) => {
      const f = document.createElement('iframe');
      const on = (e) => { if (e.data === 'gate-frame') { removeEventListener('message', on); f.remove(); r('broken: the data: frame ran'); } };
      addEventListener('message', on);
      f.src = 'data:text/html,' + encodeURIComponent('<script>parent.postMessage("gate-frame", "*")<\\/script>');
      document.body.append(f);
      setTimeout(() => { removeEventListener('message', on); f.remove(); r('held'); }, 800);
    });
    // WebKit's opaque srcdoc does not throw: it reads '' and keeps nothing; so a write of a fixed name, then a read
    g.cookie = (() => { try { document.cookie = 'wsgate=1; path=/; max-age=5'; return document.cookie.includes('wsgate=1') ? 'broken: kept' : 'held'; } catch (e) { return 'held'; } })();
    g.storage = throwsHeld(() => localStorage.length);
    g.parent = throwsHeld(() => parent.document.title);
  } else {
    g.storage = throwsHeld(() => indexedDB.open('gate'));
  }
  return g;
}`;
const failed = (g) => Object.entries(g).filter(([k, v]) => typeof v === 'string' && v.startsWith('broken')).map(([k]) => k);

// W: the gates on the policy first (they use fetch), then the allowlist step, then the names gate
const W_SRC = (gates, allowlist, noFrame = false) => `self.onmessage = async () => {
  const g = ${gates ? `await (${GATES})('W')` : '{}'};
  ${allowlist ? "for (const n of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']) { try { delete self[n]; } catch {} try { if (n in self) Object.defineProperty(self, n, { value: undefined, configurable: true }); } catch {} }" : ''}
  ${gates ? "const left = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts'].filter((n) => typeof self[n] !== 'undefined'); g.names = left.length ? 'broken: ' + left.join(',') : 'held';" : ''}
  postMessage(g);
};`;
const C_SCRIPT = (gates, allowlist, noFrame = false) => `addEventListener('message', async (e) => {
  if (e.source !== parent || !e.ports[0]) return;
  const port = e.ports[0];
  const g = ${gates ? `await (${GATES})('C', ${noFrame})` : '{}'};
  const bad = Object.entries(g).filter(([k, v]) => v.startsWith('broken')).map(([k]) => k);
  if (bad.length) { port.postMessage({ C: g }); return; }
  const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(W_SRC(gates, allowlist))}], { type: 'text/javascript' })));
  w.onmessage = (m) => port.postMessage({ C: g, W: m.data });
  w.onerror = () => port.postMessage({ C: g, W: { started: 'broken: the worker did not start' } });
  w.postMessage(1);
}, { once: true });`;
const F_SCRIPT = (gates, allowlist, noFrame = false) => {
    const child = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${C_SCRIPT(gates, allowlist, noFrame)}</script></body></html>`;
    return `(async () => {
  const t0 = performance.now();
  const done = (msg) => { window.R = msg; parent.postMessage({ gate: msg.failed.length ? 'refused' : 'passed', failed: msg.failed, ms: performance.now() - t0 }, '*'); };
  const bad = (g) => Object.entries(g || {}).filter(([k, v]) => typeof v === 'string' && v.startsWith('broken')).map(([k]) => k);
  const gF = ${gates ? `await (${GATES})('F', ${noFrame})` : '{}'};
  if (bad(gF).length) { done({ F: gF, failed: bad(gF).map((k) => 'F.' + k) }); return; }
  const c = document.createElement('iframe');
  c.setAttribute('sandbox', 'allow-scripts');
  c.srcdoc = ${JSON.stringify(child).replaceAll('</', '<\\/')};
  const ch = new MessageChannel();
  ch.port1.onmessage = (m) => done({ F: gF, C: m.data.C, W: m.data.W, failed: [...bad(gF).map((k) => 'F.' + k), ...bad(m.data.C).map((k) => 'C.' + k), ...bad(m.data.W).map((k) => 'W.' + k)] });
  c.addEventListener('load', () => c.contentWindow.postMessage('go', '*', [ch.port2]), { once: true });
  document.body.append(c);
})();`;
};

function policyFor(fs, cs, weaken) {
    const d = {
        'default-src': "'none'", 'script-src': `${sha(fs)} ${sha(cs)}`, 'script-src-attr': "'none'", 'style-src': `${sha(STILL)} blob:`,
        'img-src': 'blob:', 'font-src': 'blob:', 'media-src': 'blob:', 'connect-src': "'none'", 'worker-src': 'blob:',
        'frame-src': "'none'", 'object-src': "'none'", 'base-uri': "'none'", 'form-action': "'none'",
    };
    if (weaken) Object.assign(d, weaken);
    return Object.entries(d).map(([k, v]) => `${k} ${v}`).join('; ');
}
function file({ gates = true, allowlist = true, meta = true, weaken = null, noFrame = false } = {}) {
    const fs = F_SCRIPT(gates, allowlist, noFrame);
    const cs = C_SCRIPT(gates, allowlist, noFrame);
    const policy = policyFor(fs, cs, weaken);
    return `<!doctype html><html><head>${meta ? `<meta http-equiv="Content-Security-Policy" content="${esc(policy)}">` : ''}<meta charset="utf-8"></head><body><script>${fs}</script></body></html>`;
}

const HOST = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
window.open_ = (src, attrs) => new Promise((res) => {
  const f = document.createElement('iframe');
  for (const [k, v] of Object.entries(attrs)) f.setAttribute(k, v);
  f.style.cssText = 'width:300px;height:150px';
  const t0 = performance.now();
  const on = (e) => { if (e.source === f.contentWindow && e.data && e.data.gate) { removeEventListener('message', on); res({ ...e.data, hostMs: performance.now() - t0 }); setTimeout(() => f.remove(), 50); } };
  addEventListener('message', on);
  f.src = src;
  document.body.append(f);
  setTimeout(() => { removeEventListener('message', on); res({ gate: 'no answer in 10 s' }); f.remove(); }, 10000);
});
<\/script></body></html>`;

const MUTANTS = [
    ['correct file, sandbox="allow-scripts"', {}, { sandbox: 'allow-scripts' }],
    ['no <meta> policy', { meta: false }, { sandbox: 'allow-scripts' }],
    ["script-src + 'unsafe-eval'", { weaken: { 'script-src': 'HASHES', } , unsafeEval: true }, { sandbox: 'allow-scripts' }],
    ['connect-src *  (and data: blob:)', { weaken: { 'connect-src': '* data: blob:' } }, { sandbox: 'allow-scripts' }],
    ['img-src * data:', { weaken: { 'img-src': '* data: blob:' } }, { sandbox: 'allow-scripts' }],
    ["style-src 'unsafe-inline' (no hash)", { weaken: { 'style-src': "'unsafe-inline' blob:" } }, { sandbox: 'allow-scripts' }],
    ['base-uri *', { weaken: { 'base-uri': '*' } }, { sandbox: 'allow-scripts' }],
    ['frame-src * data:', { weaken: { 'frame-src': '* data:' } }, { sandbox: 'allow-scripts' }],
    ['worker-src * data: (no canary of its own)', { weaken: { 'worker-src': '* data: blob:' } }, { sandbox: 'allow-scripts' }],
    ['default-src * (no fallback is read: every directive is listed)', { weaken: { 'default-src': '*' } }, { sandbox: 'allow-scripts' }],
    ['F framed without sandbox', {}, {}],
    ['F framed sandbox="allow-scripts allow-same-origin"', {}, { sandbox: 'allow-scripts allow-same-origin' }],
    ["the worker's allowlist step skipped", { allowlist: false }, { sandbox: 'allow-scripts' }],
];

async function runEngine(name, runs) {
    const srv = await startServer();
    const L = srv.local;
    srv.route('/host.html', { headers: HTML, body: HOST });
    let i = 0;
    const routes = [];
    for (const [label, opts, attrs] of MUTANTS) {
        let body;
        if (opts.unsafeEval) {
            const fs = F_SCRIPT(true, true), cs = C_SCRIPT(true, true);
            body = file({ weaken: { 'script-src': `${sha(fs)} ${sha(cs)} 'unsafe-eval'` } });
        } else body = file(opts);
        srv.route(`/m${i}.html`, { headers: HTML, body });
        routes.push([label, `/m${i++}.html`, attrs]);
    }
    srv.route('/ro.html', { headers: { ...HTML, 'content-security-policy-report-only': "default-src 'none'; report-uri /__report?from=site" }, body: file() });
    srv.route('/nogates.html', { headers: HTML, body: file({ gates: false }) });
    srv.route('/noframe.html', { headers: HTML, body: file({ noFrame: true }) });

    const browser = await ENGINES[name].launch();
    emitRun('q7', name, browser);
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${L}/host.html`);
    const readR = async () => { const f = page.frames().find((fr) => fr !== page.mainFrame()); return f ? f.evaluate(() => window.R).catch(() => null) : null; };
    for (const [label, path, attrs] of routes) {
        srv.reset();
        const p = page.evaluate(([s, a]) => window.open_(s, a), [path, attrs]);
        let R = null;
        for (let k = 0; k < 60 && !R; k++) { await sleep(100); R = await readR(); }
        const answer = await p;
        emit('q7.mutant', { engine: name, case: label, answer: { gate: answer.gate, failed: answer.failed }, gates: R, requests: srv.requests.filter((r) => !/^\/(m\d+|host)\.html$/.test(r.path)).map((r) => r.path) });
        await sleep(200);
    }
    srv.reset();
    const ro = await page.evaluate(() => window.open_('/ro.html', { sandbox: 'allow-scripts' }));
    await sleep(1500);
    emit('q7.reportOnly', { engine: name, answer: ro, reports: srv.reports.map(slimReport), requests: srv.requests.filter((r) => r.path !== '/ro.html' && r.path !== '/__report').map((r) => r.path) });

    const PATHS = { gates: '/m0.html', 'gates without the frame canary': '/noframe.html', nogates: '/nogates.html' };
    const rows = { gates: [], 'gates without the frame canary': [], nogates: [] };
    const loads = [];
    for (const v of Object.keys(PATHS)) await page.evaluate((s) => window.open_(s, { sandbox: 'allow-scripts' }), PATHS[v]);
    for (let k = 0; k < runs; k++) {
        const order = Object.keys(PATHS);
        for (const v of k % 2 ? order.reverse() : order) {
            loads.push(load1());
            const r = await page.evaluate((s) => window.open_(s, { sandbox: 'allow-scripts' }), PATHS[v]);
            rows[v].push(r);
            await sleep(100);
        }
    }
    for (const [v, rs] of Object.entries(rows)) {
        const ok = rs.filter((r) => typeof r.hostMs === 'number');
        emit('q7.cost', { engine: name, variant: v, runs: ok.length, gate: [...new Set(rs.map((r) => r.gate))], hostMs: { median: +median(ok.map((r) => r.hostMs)).toFixed(1), range: range(ok.map((r) => Math.round(r.hostMs))) }, inFMs: { median: +median(ok.map((r) => r.ms)).toFixed(1), range: range(ok.map((r) => Math.round(r.ms))) }, load1: range(loads) });
    }
    await browser.close();
}

const args = process.argv.slice(2);
const runs = Number(args.find((a) => /^\d+$/.test(a)) ?? 12);
for (const name of args.filter((a) => a in ENGINES)) {
    try { await runEngine(name, runs); } catch (e) { emit('q7.error', { engine: name, error: String(e).slice(0, 400) }); }
}
process.exit(0); // the servers' keep-alive sockets must not hold the run open after an error
