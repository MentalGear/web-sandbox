// The served file of docs/design/03-served-document.md (research 31's fixture: its <meta>, guard, gates and policy check)
// with the view speaking first, plus what research 34 adds to measure host pages that are not on http(s):
//
// - a diagnostic script in F, before the guard (so it runs even where the guard stops F), that posts F's own origin,
//   URL, secure-context bit, whether `chrome` exists, and what the guard decides, to F's parent. It is the only script
//   of F's that is not the design's, and its hash joins the <meta>'s `script-src`;
// - a reach probe in C and in its worker, run on a command after start-up: fetch, XHR, <img>, <script> and
//   importScripts() of absolute URLs the driver names (siblings of the host page on its own scheme, and http ones);
// - a host page with no inline script (an extension page refuses inline script), host.js, which runs the start-up
//   order of 03 ("the view speaks first"), the check of the file (fetch and XHR of F, and its digest with
//   crypto.subtle), and the same reach probe as a positive control in the host page and in a blob: worker of its own;
// - library pages: today's default build (dist/index.js) as a module script, and the same bundled as a classic script
//   (what an embedder's bundler emits), each starting one sealed app and calling it.
//
// The worker here runs the gates and the check but not the allowlist step (research 31's `allowlist`), so its reach
// probe measures what the browser lets the realm do; the library's prelude then deletes fetch, XMLHttpRequest and
// importScripts (worker-globals.ts), which this probe does not model.
import { createHash } from 'node:crypto';
import { esc, sha } from '../28_served_topology/lib.mjs';
import { CHECK, GATES, GUARD, VERDICT, cDocument, metaPolicy } from '../31_served_startup/fixture.mjs';

export const VIEW_FLAGS = 'allow-scripts allow-forms allow-orientation-lock';
export const F_FLAGS = 'allow-scripts allow-forms';
const HOLE = '__C_HASH__';

const VIOL = `(e) => ({ dir: e.effectiveDirective || e.violatedDirective, disp: e.disposition, blocked: String(e.blockedURI).slice(0, 60), policy: e.originalPolicy })`;

// F's diagnostic: what F is, and what the guard decides, before the guard runs
export const DIAG = `try { parent.postMessage({ ws34F: { origin: String(self.origin), href: location.href.slice(0, 120), secure: self.isSecureContext, top: top === self, chrome: typeof chrome, runtime: typeof chrome !== 'undefined' && chrome.runtime ? String(chrome.runtime.id) : null, guardPasses: self.origin === 'null' && top !== self } }, '*'); } catch (e) {}`;

// The reach probe: one async function for a document or a worker. Each target is { name, url, kind } with kind 'txt',
// 'png' or 'js'; secret.js sets self.__ws34secret.
export const REACH = `async (targets) => {
  const isDoc = typeof document !== 'undefined';
  const within = (p, ms = 2500) => Promise.race([p, new Promise((r) => setTimeout(() => r('no answer in ' + ms + ' ms'), ms))]);
  const out = {};
  for (const t of targets) {
    const r = {};
    r.fetch = await within(Promise.resolve().then(() => fetch(t.url)).then(async (res) => 'read ' + res.status + ' ' + (t.kind === 'png' ? (await res.arrayBuffer()).byteLength + ' bytes' : (await res.text()).slice(0, 24)), (e) => 'refused ' + (e && e.name)));
    r.xhr = await within(new Promise((res) => { try { const x = new XMLHttpRequest(); x.open('GET', t.url); x.onload = () => res('read ' + x.status + ' ' + String(x.responseText).slice(0, 24)); x.onerror = () => res('error'); x.send(); } catch (e) { res('throws ' + e.name); } }));
    if (t.kind === 'png' && isDoc) r.img = await within(new Promise((res) => { const i = new Image(); i.onload = () => res('loaded ' + i.naturalWidth + 'x' + i.naturalHeight); i.onerror = () => res('error'); i.src = t.url; }));
    if (t.kind === 'js' && isDoc) r.script = await within(new Promise((res) => { self.__ws34secret = undefined; const s = document.createElement('script'); s.src = t.url; s.onload = () => res(self.__ws34secret ? 'ran ' + self.__ws34secret : 'loaded, did not run'); s.onerror = () => res('error'); document.head.append(s); }));
    if (t.kind === 'js' && !isDoc) r.importScripts = (() => { try { self.__ws34secret = undefined; importScripts(t.url); return self.__ws34secret ? 'ran ' + self.__ws34secret : 'loaded, did not run'; } catch (e) { return 'refused ' + e.name; } })();
    out[t.name] = r;
  }
  return out;
}`;

const ENV = `() => ({ origin: String(self.origin), href: String(location.href).slice(0, 80), secure: self.isSecureContext, subtle: typeof (self.crypto && crypto.subtle), chrome: typeof chrome, runtime: typeof chrome !== 'undefined' && chrome.runtime ? String(chrome.runtime.id) : null, baseURI: typeof document !== 'undefined' ? document.baseURI.slice(0, 80) : null })`;

function workerSource() {
    return `const ev = []; self.addEventListener('securitypolicyviolation', (e) => ev.push((${VIOL})(e)));
self.onmessage = async (m) => {
  const d = m.data || {};
  if (d.cmd === 'reach') { postMessage({ reach: await (${REACH})(d.targets), env: (${ENV})() }); return; }
  const g = await (${GATES})('W');
  const loads = await (${CHECK})(ev);
  const check = (${VERDICT})(d.expected, ev, loads);
  postMessage({ gates: g, check, env: (${ENV})(), events: ev.slice(0, 30).map((e) => ({ ...e, policy: e.policy === d.expected ? '(the meta, exact)' : String(e.policy).slice(0, 140) })) });
};`;
}

/** C's bootstrap, the view speaking first (research 31's cScriptFirst), with the reach command. */
export function cScript({ diag = true } = {}) {
    const template = metaPolicy(HOLE, scriptsOf(diag));
    return `(() => {
const SELF = document.currentScript.textContent;
const ev = []; document.addEventListener('securitypolicyviolation', (e) => ev.push((${VIOL})(e)));
let portEvent = null;
let onPort = null;
addEventListener('message', (e) => {
  if (portEvent) return;
  if (e.source !== parent.parent || !e.ports[0] || e.data !== 'ws-port') return;
  portEvent = e;
  if (onPort) onPort(e);
}, false);
(async () => {
  let hash = 'no digest';
  try { const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SELF))); hash = "'sha256-" + btoa(String.fromCharCode(...digest)) + "'"; } catch (x) { hash = 'digest throws ' + x.name; }
  const expected = ${JSON.stringify(template)}.replace(${JSON.stringify(HOLE)}, hash);
  let worker = null;
  const pendingW = new Promise((res) => {
    try { worker = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerSource())}], { type: 'text/javascript' }))); }
    catch (x) { res({ started: 'throws ' + x.name }); return; }
    worker.onmessage = (m) => res({ started: 'yes', ...m.data });
    worker.onerror = () => res({ started: 'error event (not started)' });
    worker.postMessage({ expected });
    setTimeout(() => res({ started: 'no answer in 4 s' }), 4000);
  });
  let g = {};
  try { g = await (${GATES})('C'); } catch (x) { g = { threw: 'broken: ' + x.name }; }
  const loads = await (${CHECK})(ev);
  const W = await pendingW;
  const extra = W.started === 'yes' ? [] : ['worker: ' + W.started];
  const check = (${VERDICT})(expected, ev, loads, extra);
  const verdicts = { C: { gates: g, check }, W: { started: W.started, gates: W.gates, check: W.check } };
  parent.parent.postMessage({ version: '1', verdicts, env: { C: (${ENV})(), W: W.env || null, hash } }, '*');
  onPort = (e) => {
    const port = e.ports[0];
    port.postMessage({ hello: 'port received', events: { C: ev.slice(0, 30).map((v) => ({ ...v, policy: v.policy === expected ? '(the meta, exact)' : String(v.policy).slice(0, 140) })), W: W.events || [] }, loads });
    port.onmessage = async (m) => {
      const d = m.data || {};
      if (d.cmd !== 'reach') return;
      const inC = await (${REACH})(d.targets);
      const inW = await new Promise((res) => { if (!worker) { res('no worker'); return; } worker.onmessage = (x) => res(x.data); worker.postMessage({ cmd: 'reach', targets: d.targets }); setTimeout(() => res('no answer'), 30000); });
      port.postMessage({ reach: { C: inC, W: inW } });
    };
  };
  if (portEvent) onPort(portEvent);
})();
})();`;
}

const scriptsOf = (diag) => (diag ? (d) => ({ 'script-src': `${d['script-src']} ${sha(DIAG)}` }) : null);

/** F: the <meta> (unless `meta` is false), the diagnostic, the guard, and C in the static markup. */
export function servedFile({ meta = true, diag = true } = {}) {
    const script = cScript({ diag });
    const cHash = sha(script);
    const policy = metaPolicy(cHash, scriptsOf(diag));
    const head = `${meta ? `<meta http-equiv="Content-Security-Policy" content="${esc(policy)}">` : ''}<meta charset="utf-8">${diag ? `<script>${DIAG}</script>` : ''}<script>${GUARD}</script>`;
    const html = `<!doctype html><html><head>${head}</head><body><iframe sandbox="${VIEW_FLAGS}" srcdoc="${esc(cDocument(script))}"></iframe></body></html>`;
    return { html, policy, cHash };
}

export const hex = (s) => createHash('sha256').update(s).digest('hex');

/** host.js: the host page's only script. `expected` maps a file name to the hex digest of its bytes. */
export function hostScript(expected) {
    return `// research 34's host page (generated by fixture.mjs): the start-up order of 03, the check of the file, the controls
const EXPECTED = ${JSON.stringify(expected)};
const REACH = ${REACH};
const ENV = ${ENV};
const WORKER_SRC = ${JSON.stringify(`self.onmessage = async (m) => postMessage({ reach: await (${REACH})(m.data), env: (${ENV})() });`)};
const fDiags = [];
addEventListener('message', (e) => { if (e.data && e.data.ws34F) fDiags.push(e.data.ws34F); });
customElements.define('ws34-probe', class extends HTMLElement {});
const within = (p, ms, late) => Promise.race([p, new Promise((r) => setTimeout(() => r(late), ms))]);

// The start-up order: the frame of F in a closed shadow root; the host page takes the announcement only from
// frame.contentWindow[0], then posts the port to event.source and, on it, the reach command.
window.ws34start = (url, opts = {}) => new Promise((resolve) => {
  const R = { url, loads: [], announce: null, others: 0, hello: null, reach: null, fDiag: null, hostViolations: [] };
  const t0 = performance.now();
  const el = document.createElement('ws34-probe');
  const root = el.attachShadow({ mode: 'closed' });
  const f = document.createElement('iframe');
  const attrs = 'attrs' in opts ? opts.attrs : '${F_FLAGS}';
  if (attrs !== null) f.setAttribute('sandbox', attrs);
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.style.cssText = 'border:0;width:320px;height:120px';
  const fromBefore = fDiags.length;
  const onViolation = (e) => R.hostViolations.push({ dir: e.effectiveDirective, blocked: String(e.blockedURI).slice(0, 60) });
  document.addEventListener('securitypolicyviolation', onViolation);
  let ended = false;
  const end = (why) => {
    if (ended) return; ended = true;
    R.end = why; R.ms = Math.round(performance.now() - t0);
    R.fDiag = fDiags.slice(fromBefore)[0] || null;
    removeEventListener('message', onMessage);
    document.removeEventListener('securitypolicyviolation', onViolation);
    setTimeout(() => el.remove(), 50);
    resolve(R);
  };
  const ch = new MessageChannel();
  ch.port1.onmessage = (m) => {
    const d = m.data || {};
    if (d.hello) { R.hello = d; ch.port1.postMessage({ cmd: 'reach', targets: opts.targets || [] }); return; }
    if (d.reach) { R.reach = d.reach; end('reach answered'); }
  };
  const onMessage = (e) => {
    if (R.announce || !e.data || !e.data.verdicts) return;
    let isView = false;
    try { isView = e.source === f.contentWindow[0]; } catch (x) { isView = false; }
    if (!isView) { R.others++; return; }
    R.announce = e.data; R.announceMs = Math.round(performance.now() - t0);
    e.source.postMessage('ws-port', '*', [ch.port2]);
  };
  addEventListener('message', onMessage);
  f.addEventListener('load', () => { let n = null; try { n = f.contentWindow.length; } catch (x) { n = 'throws ' + x.name; } R.loads.push(n); try { const d = f.contentDocument; R.fDom = d ? 'readable: ' + d.querySelectorAll('iframe').length + ' frame(s)' : 'null'; } catch (x) { R.fDom = 'throws ' + x.name; } });
  root.append(f);
  f.src = url;
  document.body.append(el);
  setTimeout(() => end(R.announce ? 'announced, no reach answer' : 'no announcement'), opts.timeout ?? 10000);
});

// The check of the file: the host page reads documentUrl's bytes and compares their digest.
window.ws34check = async (url, name) => {
  const out = { url, subtle: typeof (self.crypto && crypto.subtle) };
  const digest = async (buf) => { try { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join(''); } catch (e) { return 'digest throws ' + e.name; } };
  out.fetch = await within((async () => {
    try { const r = await fetch(url, { cache: 'no-store', credentials: 'omit' }); const buf = await r.arrayBuffer(); const d = await digest(buf); return { status: r.status, type: r.headers.get('content-type'), bytes: buf.byteLength, digest: d === EXPECTED[name] ? 'matches' : d }; }
    catch (e) { return { throws: e.name, message: String(e.message).slice(0, 80) }; }
  })(), 5000, 'no answer');
  out.xhr = await within(new Promise((res) => {
    try { const x = new XMLHttpRequest(); x.open('GET', url); x.responseType = 'arraybuffer'; x.onload = async () => { const d = await digest(x.response); res({ status: x.status, type: x.getResponseHeader('content-type'), bytes: x.response ? x.response.byteLength : null, digest: d === EXPECTED[name] ? 'matches' : d }); }; x.onerror = () => res({ error: 'error event' }); x.send(); }
    catch (e) { res({ throws: e.name }); }
  }), 5000, 'no answer');
  return out;
};

// The positive control: the same reach probe in the host page and in a blob: worker of the host page's.
window.ws34controls = async (targets) => {
  const page = await REACH(targets);
  const worker = await within(new Promise((res) => {
    let w; try { w = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }))); } catch (e) { res('throws ' + e.name); return; }
    w.onmessage = (m) => res(m.data); w.onerror = () => res('error event (not started)'); w.postMessage(targets);
  }), 30000, 'no answer');
  return { env: ENV(), page, worker };
};
window.ws34env = ENV;
window.ws34ready = true;
`;
}

export const HOST_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>research 34 host</title><script src="host.js"></script></head><body></body></html>';

// The library baseline: one sealed app, started and called. `lib` is the library's exports.
const LIB_RUN_BODY = `
  const out = { env: { origin: String(self.origin), href: location.href.slice(0, 80), secure: self.isSecureContext } };
  try {
    if (document.readyState === 'loading') await new Promise((r) => addEventListener('DOMContentLoaded', r));
    lib.defineWebSandbox();
    const el = document.createElement('web-sandbox');
    const settled = new Promise((res) => { el.addEventListener('ready', () => res('ready')); el.addEventListener('terminated', (e) => res('terminated: ' + e.detail.reason)); });
    el.start({ html: '<p id="t">before</p>', entry: 'app.js', files: { 'app.js': "bridge.expose('ping', () => { sandboxView.text('t', 'rendered'); return 'pong; worker origin ' + self.origin + '; fetch ' + typeof fetch + ', XMLHttpRequest ' + typeof XMLHttpRequest + ', importScripts ' + typeof importScripts; });" } }, {});
    document.body.append(el);
    out.state = await Promise.race([settled, new Promise((r) => setTimeout(() => r('neither ready nor terminated in 12 s: ' + el.state), 12000))]);
    if (out.state === 'ready') out.call = await Promise.race([el.call('ping').then((v) => 'answered: ' + v, (e) => 'rejected: ' + (e && (e.code || e.message))), new Promise((r) => setTimeout(() => r('no answer in 5 s'), 5000))]);
  } catch (e) { out.threw = e.name + ': ' + String(e.message).slice(0, 160); }
  window.libResult = out;`;

export const LIB_MODULE_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>library (module)</title><script src="lib-errors.js"></script><script type="module" src="lib-run.mjs"></script></head><body></body></html>';
export const LIB_CLASSIC_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>library (classic)</title><script src="lib-errors.js"></script><script src="lib/ws-iife.js"></script><script src="lib-run-classic.js"></script></head><body></body></html>';
// records what stopped a page's scripts from loading at all (a module refused on file:, a refused script)
export const LIB_ERRORS_JS = `window.libErrors = []; addEventListener('error', (e) => libErrors.push(e.message || ('load error: ' + (e.target && (e.target.src || e.target.tagName)))), true); document.addEventListener('securitypolicyviolation', (e) => libErrors.push('csp ' + e.effectiveDirective + ' ' + String(e.blockedURI).slice(0, 60)));`;
export const LIB_RUN_MJS = `import * as lib from './lib/index.js';\n(async () => {${LIB_RUN_BODY}\n})();\n`;
export const LIB_RUN_CLASSIC_JS = `(async () => {\n  const lib = window.WS34LIB;${LIB_RUN_BODY}\n})();\n`;
export const LIB_IIFE_ENTRY = `import { defineWebSandbox } from './index.js';\nwindow.WS34LIB = { defineWebSandbox };\n`;

/** A 1x1 PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
