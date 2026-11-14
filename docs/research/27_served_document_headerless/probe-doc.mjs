// The probe content that Q1, Q3, Q4 and Q5 put in each document of a topology: the same markup and script in today's
// srcdoc frame, in the served frame and in the served frame's srcdoc child, and the same worker source in each one's
// blob: worker. Each action is one a host page's strict policy refuses; each result says whether it took effect.
//
// A document reports to `top` with postMessage ({ probe: R }), so no frame needs to be reached from outside.
// `R.viol` lists the securitypolicyviolation events the document saw, each with the policy that raised it, told apart by a
// token in the policy's text: `from=host` (the host page's header), `from=meta` (the served file's <meta>, whose
// report-uri the engines ignore, so the token is inert), `from=site` (an outside header, Q3).
import { esc } from './lib.mjs';

const CLS = `(p) => p.includes('from=host') ? 'host' : p.includes('from=meta') ? 'meta' : p.includes('from=site') ? 'site' : 'other:' + p.slice(0, 60)`;
const VIOL = `(e) => ({ dir: e.effectiveDirective || e.violatedDirective, blocked: String(e.blockedURI).slice(0, 60), sample: (e.sample || '').slice(0, 30), disp: e.disposition, policy: (${CLS})(e.originalPolicy || '') })`;

/** The worker: eval, a fetch the host's policy refuses (`fetch`), one the served <meta> refuses (`fetchCanary`), and permission states on request. */
export const WORKER_SRC = `self.onmessage = async (e) => {
  const C = e.data;
  const R = { origin: String(self.origin), secure: self.isSecureContext, coi: self.crossOriginIsolated, viol: [] };
  self.addEventListener('securitypolicyviolation', (v) => R.viol.push((${VIOL})(v)));
  try { R.eval = String((0, eval)('6*7')); } catch (x) { R.eval = x.name; }
  R.fetch = await fetch(C.ip + '/c?w=' + C.kind).then(() => 'ok', () => 'refused');
  R.fetchCanary = await fetch(C.local + '/c?wcanary=' + C.kind).then(() => 'ok', () => 'refused');
  if (C.perms) {
    R.perms = {};
    if (!self.navigator.permissions) R.perms = 'no navigator.permissions';
    else for (const n of C.perms) { try { R.perms[n] = (await navigator.permissions.query({ name: n })).state; } catch (x) { R.perms[n] = x.name; } }
  }
  setTimeout(() => postMessage(R), 150);
};`;

/** The document's script. `cfg`: { kind, ip, local, perms? }. */
export function docScript(cfg) {
    return `(() => {
const C = ${JSON.stringify(cfg)};
const R = { kind: C.kind, origin: String(self.origin), url: location.href.slice(0, 80), baseURI: document.baseURI.slice(0, 80), referrer: document.referrer,
  ancestorOrigins: location.ancestorOrigins ? [...location.ancestorOrigins] : 'unsupported', top: window.top === window, secure: self.isSecureContext,
  coi: self.crossOriginIsolated, tt: typeof trustedTypes, viol: [], act: {} };
document.addEventListener('securitypolicyviolation', (e) => R.viol.push((${VIOL})(e)));
const st = (id, want) => { const el = document.getElementById(id); return el ? (getComputedStyle(el).color === want ? 'applied' : 'refused') : 'absent'; };
R.act.styleAttr = st('sa', 'rgb(1, 2, 3)');
R.act.styleElement = st('sb', 'rgb(4, 5, 6)');
R.act.base = document.baseURI.startsWith(C.ip + '/based/') ? 'applied' : 'refused';
try { R.act.eval = String((0, eval)('6*7')); } catch (e) { R.act.eval = e.name; }
try { const d = document.createElement('div'); d.innerHTML = '<i>x</i>'; R.act.ttSink = 'accepted'; } catch (e) { R.act.ttSink = e.name; }
let tp = null;
try { if (self.trustedTypes) tp = trustedTypes.createPolicy('probe', { createHTML: (s) => s, createScriptURL: (s) => s }); } catch (e) { R.act.ttPolicy = e.name; }
const pend = [];
pend.push(new Promise((res) => { const i = new Image(); i.onload = () => { R.act.img = 'loaded'; res(); }; i.onerror = () => { R.act.img = 'refused'; res(); }; i.src = C.ip + '/i.svg?k=' + C.kind; }));
pend.push(fetch(C.ip + '/c?k=' + C.kind).then(() => { R.act.fetch = 'ok'; }, () => { R.act.fetch = 'refused'; }));
pend.push(fetch(C.local + '/c?canary=' + C.kind).then(() => { R.act.fetchCanary = 'ok'; }, () => { R.act.fetchCanary = 'refused'; }));
if (C.perms) pend.push((async () => {
  if (!navigator.permissions) { R.perms = 'no navigator.permissions'; return; }
  R.perms = {};
  for (const n of C.perms) { try { R.perms[n] = (await navigator.permissions.query({ name: n })).state; } catch (x) { R.perms[n] = x.name; } }
})());
pend.push(new Promise((res) => {
  const url = URL.createObjectURL(new Blob([${JSON.stringify(WORKER_SRC)}], { type: 'text/javascript' }));
  let w = null;
  try { w = new Worker(url); R.act.worker = 'created'; } catch (e) {
    R.act.worker = e.name;
    if (tp) { try { w = new Worker(tp.createScriptURL(url)); R.act.worker += ', then created with a policy'; } catch (e2) { R.act.worker += ', with a policy: ' + e2.name; } }
  }
  if (!w) { res(); return; }
  w.onmessage = (e) => { R.worker = e.data; res(); };
  w.onerror = () => { R.worker = 'error event (not started)'; res(); };
  w.postMessage({ ip: C.ip, local: C.local, kind: C.kind, perms: C.perms });
  setTimeout(res, 2500);
}));
Promise.all(pend).then(() => setTimeout(() => top.postMessage({ probe: R }, '*'), 200));
})();`;
}

/**
 * A probe document. `meta` is the <meta> policy (first element of <head>), `child` the srcdoc child's document (or none),
 * `nonce` the host policy's nonce (inert where no policy names it). Returns the HTML and the script (for its hash).
 */
export function probeDocument({ cfg, meta = '', child = '', nonce = 'n0nce', extraHead = '', base = true }) {
    const script = docScript(cfg);
    const metaTag = meta ? `<meta http-equiv="Content-Security-Policy" content="${esc(meta)}">` : '';
    const html = `<!doctype html><html><head>${metaTag}<meta charset="utf-8">${extraHead}${base ? `<base href="${cfg.ip}/based/">` : ''}<style>#sb { color: rgb(4, 5, 6) }</style></head>`
        + `<body><p id="sa" style="color: rgb(1, 2, 3)">a</p><p id="sb">b</p>`
        + (child ? `<iframe sandbox="allow-scripts" srcdoc="${esc(child)}"></iframe>` : '')
        + `<script nonce="${nonce}">${script}</script></body></html>`;
    return { html, script };
}

/** The served file and its srcdoc child, with the scripts' texts for hash-only policies. */
export function servedFile({ ip, local, meta = '', childMeta = '', perms, kind = 'served', base = true }) {
    const child = probeDocument({ cfg: { kind: `${kind}>srcdoc`, ip, local, perms }, meta: childMeta, base });
    const frame = probeDocument({ cfg: { kind, ip, local, perms }, meta, child: child.html, base });
    return { html: frame.html, scripts: [frame.script, child.script] };
}

/**
 * The host page's body: a Trusted Types policy of its own (its policy requires them), a listener that keeps every
 * message, every load event of a frame it makes and every securitypolicyviolation on its own document.
 * `mk(id, attrs, srcdoc)` makes an iframe; `hostFetch(url)` is the host's own request (the positive control).
 */
export function hostPage(nonce = 'n0nce') {
    return `<!doctype html><html><head><meta charset="utf-8"><title>host</title></head><body><script nonce="${nonce}">
const tp = self.trustedTypes ? trustedTypes.createPolicy('host', { createHTML: (s) => s, createScriptURL: (s) => s }) : null;
window.results = []; window.loads = []; window.hostViol = [];
addEventListener('message', (e) => results.push(e.data));
document.addEventListener('securitypolicyviolation', (e) => hostViol.push((${VIOL})(e)));
window.mk = (id, attrs, srcdoc) => {
  const f = document.createElement('iframe');
  for (const [k, v] of Object.entries(attrs)) f.setAttribute(k, v);
  if (srcdoc) f.srcdoc = tp ? tp.createHTML(srcdoc) : srcdoc;
  f.addEventListener('load', () => loads.push(id));
  document.body.appendChild(f);
};
window.clearAll = () => { results.length = 0; loads.length = 0; hostViol.length = 0; document.querySelectorAll('iframe').forEach((f) => f.remove()); };
window.hostFetch = (u) => fetch(u).then(() => 'ok', () => 'refused');
</script></body></html>`;
}

/** A CSP report body, short: which policy sent it (the report URL's `from`), the directive, the blocked URI, the document. */
export function slimReport(r) {
    const b = (r.body && r.body['csp-report']) || r.body || {};
    const s = (v) => (v == null ? v : String(v).slice(0, 60));
    return { from: r.from, dir: b['effective-directive'] || b['violated-directive'], blocked: s(b['blocked-uri']), doc: s(b['document-uri']), sample: s(b['script-sample']) };
}

export const SVG = { headers: { 'content-type': 'image/svg+xml' }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' };
export const TEXT = { headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }, body: 'ok' };
