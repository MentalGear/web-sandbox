// Q6's view: C's bootstrap runs canaries on command, one load per kind of the list below, each to a fixed URL, and reports
// every securitypolicyviolation it and its worker see, with its arrival time. Also the host page that frames F as the
// design does (closed shadow root, sandbox="allow-scripts allow-forms", referrerpolicy="no-referrer") and drives C.
//
// The browser code is written as functions here and embedded in C's script by their text (Function.prototype.toString),
// so it holds no closure: what C runs is exactly the text the <meta> pins by hash.
import { servedFile } from './fixture.mjs';

/**
 * The canaries. `realm`: C (the view) or W (its blob: worker). `dir`: the directive the load is checked against.
 * `kind`: 'refused' (a fixed URL the <meta> refuses, in http: and https:), 'admitted' (a load the <meta> admits: research
 * 31 Q3's canaries), 'refused-local' (a refused load with a URL the realm mints or a fixed string: Q3's refused canaries
 * and the data: worker).
 */
export const CANARIES = [
    { key: 'img', realm: 'C', dir: 'img-src', kind: 'refused' },
    { key: 'style', realm: 'C', dir: 'style-src', kind: 'refused' },
    { key: 'fetch', realm: 'C', dir: 'connect-src', kind: 'refused' },
    { key: 'script', realm: 'C', dir: 'script-src', kind: 'refused' },
    { key: 'font-api', realm: 'C', dir: 'font-src', kind: 'refused' },
    { key: 'font-css', realm: 'C', dir: 'font-src', kind: 'refused' },
    { key: 'audio', realm: 'C', dir: 'media-src', kind: 'refused' },
    { key: 'video-source', realm: 'C', dir: 'media-src', kind: 'refused' },
    { key: 'frame', realm: 'C', dir: 'frame-src', kind: 'refused' },
    { key: 'object', realm: 'C', dir: 'object-src', kind: 'refused' },
    { key: 'form-submit', realm: 'C', dir: 'form-action', kind: 'refused' },
    { key: 'worker', realm: 'C', dir: 'worker-src', kind: 'refused' },
    { key: 'worker-data', realm: 'C', dir: 'worker-src', kind: 'refused-local' },
    { key: 'manifest', realm: 'C', dir: 'manifest-src', kind: 'refused' },
    { key: 'img-blob', realm: 'C', dir: 'img-src', kind: 'admitted' },
    { key: 'style-blob', realm: 'C', dir: 'style-src', kind: 'admitted' },
    { key: 'font-blob', realm: 'C', dir: 'font-src', kind: 'admitted' },
    { key: 'audio-blob', realm: 'C', dir: 'media-src', kind: 'admitted' },
    { key: 'worker-blob', realm: 'C', dir: 'worker-src', kind: 'admitted' },
    { key: 'fetch-blob', realm: 'C', dir: 'connect-src', kind: 'refused-local' },
    { key: 'eval', realm: 'C', dir: 'script-src', kind: 'refused-local' },
    { key: 'w-fetch', realm: 'W', dir: 'connect-src', kind: 'refused' },
    { key: 'w-import-scripts', realm: 'W', dir: 'script-src', kind: 'refused' },
    { key: 'w-import', realm: 'W', dir: 'script-src', kind: 'refused' },
    { key: 'w-worker', realm: 'W', dir: 'worker-src', kind: 'refused' },
    { key: 'w-worker-data', realm: 'W', dir: 'worker-src', kind: 'refused-local' },
    { key: 'w-font-api', realm: 'W', dir: 'font-src', kind: 'refused' },
    { key: 'w-fetch-blob', realm: 'W', dir: 'connect-src', kind: 'refused-local' },
    { key: 'w-eval', realm: 'W', dir: 'script-src', kind: 'refused-local' },
];

/** A refused canary's URL: one host per kind, so an event or a report reduced to the origin still names its canary. */
export const canaryUrl = (key, scheme) => `${scheme}://${key}.canary.invalid/ws-canary/${key}`;
/** A guest's URL for the same kind: a marker in the path, and leak.invalid as its host. */
export const guestUrl = (key, scheme) => `${scheme}://leak.invalid/GUEST-SECRET-${key}`;

/** (Exported for Q8.) What each kind does, in C or in the worker: `(url, track) => Promise<outcome>`; `track(el)` keeps an element to remove. */
export function kinds() {
    const isDoc = typeof document !== 'undefined';
    const mint = (parts, type) => URL.createObjectURL(new Blob(parts, { type }));
    const el = (tag, props, parent) => { const e = document.createElement(tag); Object.assign(e, props); (parent || document.body).append(e); return e; };
    const events = (e, names) => new Promise((r) => { for (const n of names) e.addEventListener(n, () => r(n), { once: true }); });
    const workerKind = (u) => new Promise((r) => { try { const w = new Worker(u); w.onerror = () => r('error event'); w.onmessage = () => r('ran'); setTimeout(() => r('constructed, no event'), 600); } catch (x) { r('throws ' + x.name); } });
    const font = (u, n) => new FontFace(n, 'url(' + u + ')').load().then(() => 'loaded', (x) => 'error ' + x.name);
    const C = isDoc ? {
        img: (u) => new Promise((r) => { const i = new Image(); i.onload = () => r('loaded'); i.onerror = () => r('error'); i.src = u; }),
        style: (u, track) => { const l = track(el('link', { rel: 'stylesheet' }, document.head)); const p = events(l, ['load', 'error']); l.href = u; return p; },
        fetch: (u) => fetch(u).then(() => 'fetched', (x) => 'refused ' + x.name),
        script: (u, track) => { const s = document.createElement('script'); const p = events(s, ['load', 'error']); s.src = u; track(s); document.head.append(s); return p; },
        'font-api': (u) => font(u, 'wsapi' + Math.random().toString(36).slice(2, 6)),
        'font-css': (u, track) => {
            const fam = 'wscss' + Math.random().toString(36).slice(2, 6);
            const l = track(el('link', { rel: 'stylesheet' }, document.head));
            const p = events(l, ['load', 'error']).then((x) => (x === 'load' ? document.fonts.load('10px ' + fam).then((f) => 'sheet loaded, fonts ' + f.length, (y) => 'sheet loaded, ' + y.name) : 'sheet ' + x));
            l.href = mint(['@font-face { font-family: ' + fam + '; src: url(' + u + ') }'], 'text/css');
            return p;
        },
        audio: (u, track) => { const a = track(el('audio', { preload: 'auto' })); const p = events(a, ['loadedmetadata', 'error']); a.src = u; return p; },
        'video-source': (u, track) => { const v = document.createElement('video'); v.preload = 'auto'; const s = document.createElement('source'); const p = events(s, ['error']); s.src = u; v.append(s); track(v); document.body.append(v); return Promise.race([p, events(v, ['loadedmetadata'])]); },
        frame: (u, track) => { const f = track(el('iframe', {})); const seen = []; f.addEventListener('load', () => seen.push('load')); f.addEventListener('error', () => seen.push('error')); f.src = u; return new Promise((r) => setTimeout(() => r(seen.join('+') || 'no event'), 400)); },
        object: (u, track) => { const o = document.createElement('object'); const seen = []; o.addEventListener('load', () => seen.push('load')); o.addEventListener('error', () => seen.push('error')); o.data = u; track(o); document.body.append(o); return new Promise((r) => setTimeout(() => r(seen.join('+') || 'no event'), 400)); },
        'form-submit': (u, track) => { const f = track(el('form', { action: u, method: 'get' })); const i = document.createElement('input'); i.name = 'q'; i.value = 'ws-canary'; f.append(i); try { f.submit(); return 'submitted'; } catch (x) { return 'throws ' + x.name; } },
        worker: workerKind,
        'worker-data': () => workerKind('data:text/javascript,postMessage(1)'),
        manifest: (u, track) => { const l = track(el('link', { rel: 'manifest' }, document.head)); l.href = u; return new Promise((r) => setTimeout(() => r('linked'), 300)); },
        'img-blob': () => C.img(mint([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))], 'image/png')),
        'style-blob': (u, track) => C.style(mint(['#ws6 { color: rgb(1, 2, 3) }'], 'text/css'), track),
        'font-blob': () => font(mint(['wOF2'], 'font/woff2'), 'wsblob'),
        'audio-blob': (u, track) => C.audio(mint(['RIFF'], 'audio/wav'), track),
        'worker-blob': () => workerKind(mint(['postMessage(1)'], 'text/javascript')),
        'fetch-blob': () => C.fetch(mint(['x'], 'text/plain')),
        eval: () => { try { (0, eval)('1'); return 'ran'; } catch (x) { return 'refused'; } },
    } : {};
    const W = isDoc ? {} : {
        'w-fetch': (u) => fetch(u).then(() => 'fetched', (x) => 'refused ' + x.name),
        'w-import-scripts': (u) => { try { importScripts(u); return 'loaded'; } catch (x) { return 'throws ' + x.name; } },
        'w-import': (u) => import(u).then(() => 'loaded', (x) => 'refused ' + x.name),
        'w-worker': (u) => (typeof Worker === 'undefined' ? 'no Worker in a worker' : workerKind(u)),
        'w-worker-data': () => (typeof Worker === 'undefined' ? 'no Worker in a worker' : workerKind('data:text/javascript,postMessage(1)')),
        'w-font-api': (u) => (typeof FontFace === 'undefined' ? 'no FontFace in a worker' : font(u, 'wsw')),
        'w-fetch-blob': () => W['w-fetch'](mint(['x'], 'text/plain')),
        'w-eval': () => { try { (0, eval)('1'); return 'ran'; } catch (x) { return 'refused'; } },
    };
    return { ...C, ...W };
}

/** Runs jobs ([key, url]) at once, waits `wait` ms from the start, and returns the outcomes with their settling times. */
function runner() {
    const EP = () => performance.timeOrigin + performance.now();
    return async (K, jobs, wait, ev) => {
        const t0 = EP();
        const from = ev.length;
        const out = {};
        const settled = {};
        const tracked = [];
        const track = (e) => { tracked.push(e); return e; };
        const pend = jobs.map(([key, url]) => Promise.race([Promise.resolve().then(() => K[key](url, track)), new Promise((r) => setTimeout(() => r('no outcome in ' + wait + ' ms'), wait))])
            .then((v) => v, (x) => 'throws ' + (x && x.name)).then((v) => { out[key + (url ? ' ' + url.split(':')[0] : '')] = v; settled[key + (url ? ' ' + url.split(':')[0] : '')] = Math.round(EP() - t0); }));
        await Promise.all(pend);
        await new Promise((r) => setTimeout(r, Math.max(0, wait - (EP() - t0))));
        return { t0, out, settled, tracked, events: ev.slice(from).map((e) => ({ ...e, dt: +(e.ep - t0).toFixed(1) })) };
    };
}

/** C's bootstrap: listens first, starts its worker on demand, and answers commands from parent.parent only. */
function cMain() {
    const EP = () => performance.timeOrigin + performance.now();
    const VIOL = (e) => ({ realm: 'C', dir: e.effectiveDirective, viol: e.violatedDirective, disp: e.disposition, blocked: String(e.blockedURI).slice(0, 80), policy: e.originalPolicy, sample: String(e.sample || '').slice(0, 40), ep: EP() });
    const ev = [];
    // every event is also posted to the host page as it arrives, so the events before a navigation of C are kept
    document.addEventListener('securitypolicyviolation', (e) => { const v = VIOL(e); ev.push(v); parent.parent.postMessage({ q6: 'event', v }, '*'); });
    const K = (__KINDS__)();
    const run = (__RUNNER__)();
    let worker = null;
    const W_SRC = __W_SRC__;
    const startWorker = () => new Promise((res) => {
        try { worker = new Worker(URL.createObjectURL(new Blob([W_SRC], { type: 'text/javascript' }))); } catch (x) { res('throws ' + x.name); return; }
        worker.onmessage = (m) => { if (m.data === 'up') res('yes'); };
        worker.onerror = () => res('error event');
        setTimeout(() => res('no answer'), 2000);
    });
    const inWorker = (jobs, wait) => new Promise((res) => { worker.onmessage = (m) => res(m.data); worker.postMessage({ jobs, wait }); setTimeout(() => res({ error: 'no answer' }), wait + 3000); });
    let form = null;
    addEventListener('message', async (e) => {
        if (e.source !== parent.parent) return;
        const d = e.data || {};
        const reply = (x) => parent.parent.postMessage({ q6: d.id, ...x }, '*');
        if (d.cmd === 'run') {
            const wantW = d.wjobs && d.wjobs.length;
            const wStart = wantW && !worker ? startWorker() : null;
            const pc = run(K, d.jobs || [], d.wait, ev);
            const pw = wantW ? (async () => { const s = await wStart; if (worker && (s === 'yes' || s === null)) return inWorker(d.wjobs, d.wait); return { started: s }; })() : null;
            const rc = await pc;
            const lengthBefore = window.length;
            const loadsSeen = rc.tracked.filter((x) => x.tagName === 'IFRAME' || x.tagName === 'OBJECT').map((x) => x.tagName.toLowerCase());
            for (const x of rc.tracked) x.remove();
            const rw = pw ? await pw : null;
            const W = rw && rw.events ? { ...rw, started: 'yes', events: rw.events.map((x) => ({ ...x, dt: +(x.ep - rc.t0).toFixed(1) })) } : rw;
            reply({ out: rc.out, settled: rc.settled, events: rc.events, W, side: { lengthWithCanaries: lengthBefore, lengthAfterRemoval: window.length, nested: loadsSeen, left: document.querySelectorAll('iframe, object, audio, video, form, link, script[src]').length } });
            return;
        }
        if (d.cmd === 'form-setup') {
            // a form with a submit button, for a real click from outside
            form = document.createElement('form'); form.action = d.url; form.method = 'get';
            const i = document.createElement('input'); i.name = 'q'; i.value = 'ws-canary';
            const b = document.createElement('button'); b.type = 'submit'; b.id = 'ws-go'; b.textContent = 'go'; b.style.cssText = 'display:block;width:120px;height:40px';
            form.append(i, b); document.body.append(form);
            reply({ mark: ev.length, t0: EP() });
            return;
        }
        if (d.cmd === 'collect') {
            if (form) { form.remove(); form = null; }
            reply({ events: ev.slice(d.mark).map((x) => ({ ...x, dt: +(x.ep - d.t0).toFixed(1) })) });
        }
    });
    parent.parent.postMessage({ q6: 'ready' }, '*');
}

/** The worker's source: listens first, says 'up', then runs the jobs it is sent. */
function wMain() {
    const EP = () => performance.timeOrigin + performance.now();
    const ev = [];
    self.addEventListener('securitypolicyviolation', (e) => ev.push({ realm: 'W', dir: e.effectiveDirective, viol: e.violatedDirective, disp: e.disposition, blocked: String(e.blockedURI).slice(0, 80), policy: e.originalPolicy, sample: String(e.sample || '').slice(0, 40), ep: EP() }));
    const K = (__KINDS__)();
    const run = (__RUNNER__)();
    self.onmessage = async (m) => {
        const r = await run(K, m.data.jobs, m.data.wait, ev);
        postMessage({ out: r.out, settled: r.settled, events: r.events });
    };
    postMessage('up');
}

const fill = (f) => `(${f.toString()})`.replace('__KINDS__', kinds.toString()).replace('__RUNNER__', runner.toString());

/** C's bootstrap text. */
export function q6Script() {
    const w = `${fill(wMain)}();`;
    return `${fill(cMain).replace('__W_SRC__', JSON.stringify(w))}();`;
}

/** F with Q6's view: the design's <meta> (or none, `meta: false`, the positive control). */
export const q6File = (opts = {}) => servedFile({ ...opts, script: q6Script() });

/** The host page: `open6(url)` frames F as the design does and resolves when C is ready; `send6(cmd)` asks C. */
export function q6Host() {
    return `<!doctype html><html><head><meta charset="utf-8"><title>host</title></head><body><script>
customElements.define('web-sandbox-probe', class extends HTMLElement {});
window.cur = null;
window.open6 = (url, opts = {}) => new Promise((resolve) => {
  if (window.cur) window.cur.el.remove();
  const el = document.createElement('web-sandbox-probe');
  const root = el.attachShadow({ mode: 'closed' });
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts allow-forms');
  f.setAttribute('referrerpolicy', opts.referrerpolicy ?? 'no-referrer');
  f.style.cssText = 'border:0;width:320px;height:170px';
  const S = window.cur = { el, f, loads: [], stream: [], replies: new Map(), t0: performance.now() };
  f.addEventListener('load', () => S.loads.push(Math.round(performance.now() - S.t0)));
  const on = (e) => {
    let c; try { c = f.contentWindow[0]; } catch (x) { return; }
    if (!e.data || e.source !== c || !('q6' in e.data)) return;
    if (e.data.q6 === 'event') { S.stream.push(e.data.v); return; }
    if (e.data.q6 === 'ready') { S.ready = Math.round(performance.now() - S.t0); resolve({ ready: S.ready }); return; }
    const r = S.replies.get(e.data.q6); if (r) r(e.data);
  };
  addEventListener('message', on);
  S.off = () => removeEventListener('message', on);
  root.append(f); f.src = url; document.body.append(el);
  setTimeout(() => resolve({ ready: null }), opts.timeout ?? 5000);
});
let n = 0;
window.send6 = (cmd, timeout = 6000) => new Promise((resolve) => {
  const S = window.cur; const id = ++n;
  S.replies.set(id, resolve);
  try { S.f.contentWindow[0].postMessage({ ...cmd, id }, '*'); } catch (x) { resolve({ error: 'post throws ' + x.name }); return; }
  setTimeout(() => resolve({ error: 'no reply in ' + timeout + ' ms' }), timeout);
});
window.stream6 = () => window.cur.stream.slice();
window.state6 = () => { const S = window.cur; const r = { loads: S.loads.slice() }; try { r.fLength = S.f.contentWindow.length; } catch (x) { r.fLength = 'throws ' + x.name; } try { r.cLength = S.f.contentWindow[0] ? S.f.contentWindow[0].length : 'no C'; } catch (x) { r.cLength = 'throws ' + x.name; } return r; };
</script></body></html>`;
}
