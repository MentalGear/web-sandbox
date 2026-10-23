// Q1. Does the host page's controlling Service Worker see or substitute (a) the navigation of a sandboxed frame to a
// same-origin served document, (b) that frame's own subresource fetches, (c) the fetches of its srcdoc child?
//
//   bun docs/research/20_served_document_mode/q1-service-worker.mjs [chromium] [firefox] [webkit]
//
// The pages are served by a real local HTTP server (server.mjs) on http://localhost:PORT, a secure context, and no
// Playwright request routing is used (it blocks SW registration on Firefox and WebKit).
//
// The SW substitutes the answer for /nav-*.html, /sub.json, /sub.js and /img.svg (a marker 'SW' instead of 'network')
// and relays /frame*.html to the network unchanged; it reports every fetch event it receives for those paths to the host page. A fetch
// event that never arrives means the request did not reach the SW at all. Scenario ids travel in the query (?sc=...)
// so each SW event is attributed.
import { ENGINES, engineArgs, emit, sleep } from './lib.mjs';
import { startServer } from './server.mjs';

const SW = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
async function tell(msg) { for (const c of await clients.matchAll({ includeUncontrolled: true, type: 'window' })) c.postMessage(msg); }
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (!/^\\/(sub\\.|nav-|frame|img\\.)/.test(u.pathname)) return;
  tell({ sw: 'fetch', path: u.pathname, sc: u.searchParams.get('sc'), mode: e.request.mode, dest: e.request.destination, hasClientId: !!e.clientId, hasResultingClientId: !!e.resultingClientId });
  const H = { 'access-control-allow-origin': '*' };
  if (u.pathname.startsWith('/nav-')) return e.respondWith(new Response('<!doctype html><script>top.postMessage({ kind: "nav", by: "SW", origin: String(self.origin) }, "*")<\\/script>', { headers: { 'content-type': 'text/html' } }));
  if (u.pathname === '/sub.json') return e.respondWith(new Response('{"by":"SW"}', { headers: { ...H, 'content-type': 'application/json' } }));
  if (u.pathname === '/sub.js') return e.respondWith(new Response('window.__by = "SW"', { headers: { ...H, 'content-type': 'text/javascript' } }));
  if (u.pathname === '/img.svg') return e.respondWith(new Response('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>', { headers: { ...H, 'content-type': 'image/svg+xml' } }));
  // /frame*.html: the SW relays the navigation to the network unchanged. Firefox does not intercept the subresources of
  // a document whose navigation the SW saw but did not answer, so a SW that only observes would make the control void.
  if (u.pathname.startsWith('/frame') && e.request.mode === 'navigate') return e.respondWith(fetch(e.request));
});`;

// The code a document runs to fetch its three kinds of subresource and report who answered. ORIGIN and SC are literals.
const PROBE = (origin, sc, kind) => `
(async () => {
  const r = { kind: ${JSON.stringify(kind)}, sc: ${JSON.stringify(sc)}, origin: String(self.origin) };
  try { r.swApi = typeof navigator.serviceWorker; r.controller = !!navigator.serviceWorker.controller; } catch (e) { r.swApi = 'threw ' + e.name; }
  await new Promise((res) => setTimeout(res, 800)); // let the controller handshake finish (Firefox)
  const t = (p) => Promise.race([p, new Promise((res) => setTimeout(() => res('timeout'), 3000))]);
  r.fetchBy = await t(fetch(${JSON.stringify(origin)} + '/sub.json?sc=${sc}').then((x) => x.json()).then((j) => j.by, (e) => 'err ' + e.name));
  r.scriptBy = await t(new Promise((res) => { const s = document.createElement('script'); s.src = ${JSON.stringify(origin)} + '/sub.js?sc=${sc}'; s.onload = () => res(window.__by); s.onerror = () => res('err'); document.head.appendChild(s); }));
  r.imgBy = await t(new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth === 2 ? 'SW' : 'network'); i.onerror = () => res('err'); i.src = ${JSON.stringify(origin)} + '/img.svg?sc=${sc}'; }));
  top.postMessage(r, '*');
})();`;

const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

function frameDoc(origin, sc, withChild) {
    // the served frame: its own subresource probes (b), and a srcdoc child that runs the same probes (c)
    const child = withChild ? `<iframe sandbox="allow-scripts" srcdoc="${esc(`<script>${PROBE(origin, sc + '-child', 'frame-srcdoc-child')}<\/script>`)}"></iframe>` : '';
    return `<!doctype html><html><head><meta charset="utf-8"></head><body>${child}<script>${PROBE(origin, sc, 'frame')}<\/script></body></html>`;
}

const HOST = `<!doctype html><html><head><meta charset="utf-8"><title>host</title></head><body><script>
window.msgs = []; window.swLog = []; window.regErr = null;
addEventListener('message', (e) => msgs.push(e.data));
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => swLog.push(e.data));
window.register = async () => {
  try { const reg = await navigator.serviceWorker.register('/sw.js'); await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('ready timeout')), 8000))]); return { ok: true, state: (reg.active || reg.waiting || reg.installing)?.state }; }
  catch (e) { return { ok: false, err: e.name + ': ' + e.message }; }
};
window.scenario = async (sc, kind, src, srcdoc) => {
  const f = document.createElement('iframe');
  if (kind.startsWith('sandbox')) f.setAttribute('sandbox', 'allow-scripts');
  // the attributes the library puts on its wrapper iframe besides sandbox (frame-documents.ts, setWrapperFrameIsolation)
  if (kind === 'sandbox-lib') { f.setAttribute('credentialless', ''); f.setAttribute('referrerpolicy', 'no-referrer'); }
  if (srcdoc) f.srcdoc = srcdoc; else f.src = src;
  document.body.appendChild(f);
  await new Promise((r) => setTimeout(r, 4500));
  f.remove();
};
window.hostFetch = async (sc) => { const r = await fetch('/sub.json?sc=' + sc); return (await r.json()).by; };
<\/script></body></html>`;

async function runEngine(name) {
    const srv = await startServer();
    const O = srv.local;
    srv.route('/host.html', { body: HOST });
    srv.route('/sw.js', { headers: { 'content-type': 'text/javascript' }, body: SW });
    srv.route('/sub.json', { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: '{"by":"network"}' });
    srv.route('/sub.js', { headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' }, body: 'window.__by = "network"' });
    srv.route('/img.svg', { headers: { 'content-type': 'image/svg+xml', 'access-control-allow-origin': '*' }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
    const nav = '<!doctype html><script>top.postMessage({ kind: "nav", by: "network", origin: String(self.origin) }, "*")<\/script>';
    srv.route('/nav-target.html', { body: nav });
    srv.route('/nav-target-hdr.html', { headers: { 'content-security-policy': 'sandbox allow-scripts' }, body: nav });
    srv.route('/frame.html', (req, url) => ({ body: frameDoc(O, url.searchParams.get('sc') || 'x', true) }));
    srv.route('/frame-hdr.html', (req, url) => ({ headers: { 'content-security-policy': 'sandbox allow-scripts' }, body: frameDoc(O, url.searchParams.get('sc') || 'x', true) }));

    const browser = await ENGINES[name].launch();
    const ctx = await browser.newContext(); // no routing; service workers allowed (the default)
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)));
    await page.goto(`${O}/host.html`);
    const reg = await page.evaluate(() => window.register());
    emit('q1.register', { engine: name, ...reg });
    if (!reg.ok) {
        const swCount = (await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length).catch((e) => 'err ' + e.message)));
        emit('q1.register-detail', { engine: name, registrations: swCount, pageErrors: consoleErrors });
        await browser.close(); await srv.close();
        return;
    }
    await sleep(500);
    // The SW claims the registering page (clients.claim). A reload is only needed where it did not. Firefox under
    // Playwright controls the registering page but not a page loaded afterwards (reload, goto, link, location.href),
    // so the page is never reloaded there once it is controlled.
    let controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    if (!controlled) { await page.reload(); await sleep(500); controlled = await page.evaluate(() => !!navigator.serviceWorker.controller); }
    emit('q1.controlled', { engine: name, controlled });

    const hostFetch = await page.evaluate(() => window.hostFetch('ctl'));
    emit('q1.control-host-fetch', { engine: name, by: hostFetch });

    const scenarios = [
        // [id, frame kind, src, srcdoc]
        ['ctl-nav', 'plain', `/nav-target.html?sc=ctl-nav`],
        ['ctl-frame', 'plain', `/frame.html?sc=ctl-frame`],
        ['sb-nav-attr', 'sandbox', `/nav-target.html?sc=sb-nav-attr`],
        ['sb-nav-hdr', 'plain', `/nav-target-hdr.html?sc=sb-nav-hdr`],
        ['sb-frame-attr', 'sandbox', `/frame.html?sc=sb-frame-attr`],
        ['sb-nav-lib', 'sandbox-lib', `/nav-target.html?sc=sb-nav-lib`],
        ['sb-frame-lib', 'sandbox-lib', `/frame.html?sc=sb-frame-lib`],
        ['sb-frame-hdr', 'plain', `/frame-hdr.html?sc=sb-frame-hdr`],
        ['host-srcdoc', 'sandbox', null, `<script>${PROBE(O, 'host-srcdoc', 'srcdoc')}<\/script>`],
    ];
    for (const [sc, kind, src, srcdoc] of scenarios) {
        await page.evaluate(([a, b, c, d]) => { window.msgs.length = 0; window.swLog.length = 0; return window.scenario(a, b, c, d); }, [sc, kind, src, srcdoc]);
        const { msgs, swLog } = await page.evaluate(() => ({ msgs: window.msgs, swLog: window.swLog }));
        emit('q1.scenario', { engine: name, sc, msgs: msgs.map((m) => ({ kind: m.kind, by: m.by, fetchBy: m.fetchBy, scriptBy: m.scriptBy, imgBy: m.imgBy, origin: m.origin, swApi: m.swApi, controller: m.controller })), swEvents: swLog.filter((e) => e.sc && e.sc.startsWith(sc)).map((e) => `${e.path}[${e.sc}] ${e.mode}/${e.dest}${e.hasClientId ? ' clientId' : ''}${e.hasResultingClientId ? ' resultingClientId' : ''}`) });
    }
    await browser.close();
    await srv.close();
}

for (const name of engineArgs()) {
    try { await runEngine(name); } catch (e) { emit('q1.error', { engine: name, error: String(e).slice(0, 400) }); }
}
