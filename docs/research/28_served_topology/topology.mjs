// The trampoline topology of research 28, as plain HTML: the served file F, the view C it creates as a sandboxed srcdoc
// child, and the logic worker W, created either by C (W_C) or by F (W_F). No library code.
//
//   host page -> iframe[sandbox="allow-scripts"][referrerpolicy="no-referrer"] src=F
//     F: a static file, Content-Type only, a <meta> policy with no 'unsafe-inline' (its script and C's by hash); its one
//        script is constant. On a message { init: <worker source> } from anyone, it creates C with the attribute
//        sandbox="allow-scripts" and a constant srcdoc, hands C one end of a MessageChannel and the worker source, and
//        starts W_F from a blob: URL it mints itself (the comparison).
//     C: its constant bootstrap answers only its parent's first message: runs the checks, mints a blob: URL of the worker
//        source and starts W_C from it, and reports both over the port.
//     W: the worker source is whatever the poster sent; here it runs the checks.
//
// Every realm runs the same checks (CHECKS): what of the authority of its origin it can reach. F keeps every result in
// `window.R`, which Playwright reads from outside; nothing is posted to F's parent or opener.
import { esc, sha } from './lib.mjs';

/** The checks, as one async function's source, for a document or a worker. `C`: { kind, L, I, tag }. */
export const CHECKS = `async (C) => {
  const kind = C.kind;
  const R = { kind, origin: String(self.origin), secure: self.isSecureContext, coi: self.crossOriginIsolated };
  const within = (p) => Promise.race([Promise.resolve().then(p), new Promise((r) => setTimeout(() => r('no answer in 2 s'), 2000))]);
  const t = async (f) => { try { return await within(f); } catch (e) { return 'throws ' + (e && e.name); } };
  const isDoc = typeof document !== 'undefined';
  const q = (name) => C.tag + '&' + name + '=' + encodeURIComponent(kind);
  if (isDoc) {
    R.cookieRead = await t(() => { const c = document.cookie; const seen = c.split('; ').filter((x) => /^host/.test(x)).map((x) => x.split('=')[0]); return seen.length ? 'reads ' + seen.join(',') : 'reads, no host cookie'; });
    R.cookieWrite = await t(() => { document.cookie = 'probe=' + kind + '; path=/'; return document.cookie.includes('probe=') ? 'written' : 'not kept'; });
    R.localStorage = await t(() => localStorage.getItem('hostkey') ?? 'accessible, no host key');
    R.sessionStorage = await t(() => (sessionStorage.length, 'accessible'));
    R.parentDocument = await t(() => (parent === self ? 'is self' : (parent.document.title, 'readable')));
    R.topDocument = await t(() => (top === self ? 'is self' : (top.document.title, 'readable')));
    R.openerDocument = await t(() => (!opener ? 'no opener' : (opener.document.title, 'readable')));
  }
  R.indexedDB = await t(() => new Promise((res) => { const r = indexedDB.open('probe'); r.onsuccess = () => { r.result.close(); res('opened'); }; r.onerror = () => res('error ' + (r.error && r.error.name)); }));
  R.indexedDBHost = await t(async () => ((await indexedDB.databases()).some((d) => d.name === 'hostdb') ? 'lists hostdb' : 'no hostdb'));
  R.caches = await t(async () => ((await caches.has('hostcache')) ? 'has hostcache' : (await caches.open('probe'), 'opened, no hostcache')));
  R.storageEstimate = await t(async () => (await navigator.storage.estimate(), 'answers'));
  R.opfs = await t(async () => (await navigator.storage.getDirectory(), 'directory'));
  R.broadcast = await t(() => { const b = new BroadcastChannel('probe'); b.postMessage({ from: kind, tag: C.tag }); b.close(); return 'posted'; });
  R.serviceWorker = await t(async () => (!navigator.serviceWorker ? 'absent' : (await navigator.serviceWorker.getRegistrations()).length + ' registrations'));
  R.locks = await t(async () => (!navigator.locks ? 'absent' : ((await navigator.locks.query()), 'answers')));
  R.permission = await t(async () => (await navigator.permissions.query({ name: 'geolocation' })).state);
  R.fetch = await t(() => fetch(C.L + '/c?' + q('fetch')).then((r) => 'read ' + r.status, (e) => 'refused ' + e.name));
  R.xhr = await t(() => new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', C.L + '/c?' + q('xhr')); x.onload = () => res('read ' + x.status); x.onerror = () => res('error'); x.send(); }));
  R.noCors = await t(() => fetch(C.L + '/c?' + q('nocors'), { mode: 'no-cors', credentials: 'include' }).then(() => 'sent (opaque response)', (e) => 'refused ' + e.name));
  return R;
}`;

/** The worker source an embedder posts: it runs the checks and answers. */
export const WORKER_SRC = `self.onmessage = async (e) => { postMessage(await (${CHECKS})(e.data)); };`;

/** C's bootstrap: constant. Answers its parent's first message only. */
export const C_SCRIPT = `addEventListener('message', async (e) => {
  if (e.source !== parent || !e.data || !e.ports[0]) return;
  const port = e.ports[0];
  const cfg = e.data.cfg;
  if (typeof e.data.show === 'string') document.body.textContent = e.data.show;
  port.postMessage({ who: 'C', r: await (${CHECKS})({ ...cfg, kind: 'C' }) });
  try {
    const w = new Worker(URL.createObjectURL(new Blob([e.data.src], { type: 'text/javascript' })));
    w.onmessage = (m) => port.postMessage({ who: 'WC', r: m.data });
    w.onerror = () => port.postMessage({ who: 'WC', r: 'error event (not started)' });
    w.postMessage({ ...cfg, kind: 'WC' });
  } catch (x) { port.postMessage({ who: 'WC', r: 'throws ' + x.name }); }
});`;
export const C_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${C_SCRIPT}</script></body></html>`;

/** F's script: constant. `cfg` is fixed into the file (the server's origins and the request tag). */
export function fScript(cfg) {
    return `(() => {
  const cfg = ${JSON.stringify(cfg)};
  const R = window.R = { started: true };
  (${CHECKS})({ ...cfg, kind: 'F' }).then((r) => { R.F = r; });
  let done = false;
  addEventListener('message', (e) => {
    if (done || !e.data || typeof e.data.init !== 'string') return;
    done = true;
    const c = document.createElement('iframe');
    c.setAttribute('sandbox', 'allow-scripts');
    c.srcdoc = ${JSON.stringify(C_HTML).replaceAll('</', '<\\/')};
    const ch = new MessageChannel();
    ch.port1.onmessage = (m) => { R[m.data.who] = m.data.r; };
    c.addEventListener('load', () => c.contentWindow.postMessage({ src: e.data.init, cfg, show: e.data.show }, '*', [ch.port2]), { once: true });
    document.body.append(c);
    try {
      const w = new Worker(URL.createObjectURL(new Blob([e.data.init], { type: 'text/javascript' })));
      w.onmessage = (m) => { R.WF = m.data; };
      w.onerror = () => { R.WF = 'error event (not started)'; };
      w.postMessage({ ...cfg, kind: 'WF' });
    } catch (x) { R.WF = 'throws ' + x.name; }
  });
})();`;
}

/**
 * F, the served file. `connect` is the policy's connect-src: "'none'" (the file's own policy) or an origin (the control
 * in which requests are admitted, so what reaches the server shows which credentials they carry).
 */
export function servedFile(cfg, connect = "'none'") {
    const script = fScript(cfg);
    const policy = `default-src 'none'; script-src ${sha(script)} ${sha(C_SCRIPT)}; script-src-attr 'none'; connect-src ${connect}; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
    return { policy, html: `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${esc(policy)}"><meta charset="utf-8"><title>F</title></head><body><script>${script}</script></body></html>` };
}

/** The page that seeds an origin with data the checks look for, and keeps a BroadcastChannel listener open. */
export const SEED = `<!doctype html><html><head><meta charset="utf-8"><title>seed</title></head><body><script>
window.bc = [];
const b = new BroadcastChannel('probe');
b.onmessage = (e) => window.bc.push(e.data);
window.seed = async () => {
  document.cookie = 'hostlax=1; path=/; SameSite=Lax';
  document.cookie = 'hostdefault=1; path=/';
  document.cookie = 'hostnone=1; path=/; SameSite=None; Secure';
  localStorage.setItem('hostkey', 'host value');
  await new Promise((r) => { const q = indexedDB.open('hostdb'); q.onsuccess = () => { q.result.close(); r(); }; q.onerror = r; });
  try { await caches.open('hostcache'); } catch {}
  try { await navigator.serviceWorker.register('/sw.js', { scope: '/swscope/' }); } catch {}
  return { cookie: document.cookie, origin: self.origin };
};
</script></body></html>`;
export const SW = { headers: { 'content-type': 'text/javascript' }, body: 'self.addEventListener("install", () => self.skipWaiting());' };

/** A hostile page: frames F with the attributes given, or opens it, and can post to it. */
export const EMBED = (target, attrs) => `<!doctype html><html><head><meta charset="utf-8"><title>embedder</title></head><body><iframe ${attrs} src="${target}"></iframe></body></html>`;
export const OPENER = `<!doctype html><html><head><meta charset="utf-8"><title>opener</title></head><body></body></html>`;
export const SANDBOXED_OPENER = `<!doctype html><html><head><meta charset="utf-8"><title>opener</title></head><body><iframe sandbox="allow-scripts allow-popups" srcdoc="${esc('<script>window.go = (u) => { window.w = window.open(u); };</script>')}"></iframe></body></html>`;

// The static variant (this note's addition to the brief's design): C is an element of F's own markup, as today's wrapper
// holds the view, so F runs no script at all. Whoever holds C's window (the embedder: `frames[0].frames[0]`) posts it the
// worker source, the config and a port; C keeps its results in its own `window.R`, which Playwright reads.

/** C's bootstrap in the static file: answers the first message that brings a worker source. */
export const C_STATIC_SCRIPT = `addEventListener('message', async (e) => {
  if (window.R || !e.data || typeof e.data.init !== 'string') return;
  const R = window.R = { started: true };
  const cfg = e.data.cfg;
  if (typeof e.data.show === 'string') document.body.textContent = e.data.show;
  R.C = await (${CHECKS})({ ...cfg, kind: 'C' });
  try {
    const w = new Worker(URL.createObjectURL(new Blob([e.data.init], { type: 'text/javascript' })));
    w.onmessage = (m) => { R.WC = m.data; };
    w.onerror = () => { R.WC = 'error event (not started)'; };
    w.postMessage({ ...cfg, kind: 'WC' });
  } catch (x) { R.WC = 'throws ' + x.name; }
});`;

/** The guard of the guarded static file: before the parser reaches C, it stops the document unless it is opaque and framed. */
export const GUARD = `window.G = self.origin === 'null' && top !== self ? 'run' : 'stopped'; if (window.G === 'stopped') window.stop();`;

/** F as a static document: no script (or only the guard), C in its markup. */
export function staticFile(connect = "'none'", guarded = false) {
    const child = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${C_STATIC_SCRIPT}</script></body></html>`;
    const policy = `default-src 'none'; script-src ${guarded ? sha(GUARD) + ' ' : ''}${sha(C_STATIC_SCRIPT)}; script-src-attr 'none'; connect-src ${connect}; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
    return { policy, html: `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${esc(policy)}"><meta charset="utf-8"><title>F</title>${guarded ? `<script>${GUARD}</script>` : ''}</head><body><iframe sandbox="allow-scripts" srcdoc="${esc(child)}"></iframe></body></html>` };
}
