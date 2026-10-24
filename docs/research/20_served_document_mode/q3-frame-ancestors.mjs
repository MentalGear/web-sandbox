// Q3. `frame.html` sent with `Content-Security-Policy: sandbox allow-scripts; frame-ancestors 'self'; report-uri /__report`:
// is it allowed when embedded by the same-origin host page, when the embedding chain includes a sandboxed (opaque-origin)
// ancestor of each kind, and refused when framed cross-site? The violation reports are recorded.
//
//   bun docs/research/20_served_document_mode/q3-frame-ancestors.mjs [chromium] [firefox] [webkit]
//
// `http://localhost:PORT` is the host origin and `http://127.0.0.1:PORT` the other site, served by the same process
// (server.mjs). A scenario passes when the served document ran and posted to `top`; a refused one never posts.
import { ENGINES, engineArgs, emit, sleep } from './lib.mjs';
import { startServer } from './server.mjs';

// The proposed header's frame-ancestors; ?fa= picks another source list for the variants of Q3b.
const FRAME_CSP = (fa, host) => {
    const src = { self: "'self'", origin: `http://${host}`, hostport: host, star: '*' }[fa];
    return `sandbox allow-scripts;${src ? ` frame-ancestors ${src};` : ''} report-uri /__report`;
};

// frame.html: reports where it is; with ?embed=URL it embeds that URL (a served frame inside a served frame).
const FRAME = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
const q = new URLSearchParams(location.search);
const r = { kind: 'frame', id: q.get('id'), origin: String(self.origin), ancestorOrigins: location.ancestorOrigins ? [...location.ancestorOrigins] : 'unsupported', referrer: document.referrer, baseURI: document.baseURI };
try { r.parentAccess = String(parent.document.title).slice(0, 10); } catch (e) { r.parentAccess = e.name; }
top.postMessage(r, '*');
if (q.get('embed')) { const f = document.createElement('iframe'); f.src = q.get('embed'); document.body.appendChild(f); }
<\/script></body></html>`;

// embedder.html?target=URL: an ordinary page (no CSP) with one iframe to the target. Its own opacity comes from whoever frames it.
const EMBEDDER = `<!doctype html><html><body><script>
const f = document.createElement('iframe'); f.src = new URLSearchParams(location.search).get('target'); document.body.appendChild(f);
<\/script></body></html>`;

const HOST = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
window.msgs = [];
addEventListener('message', (e) => msgs.push(e.data));
window.scenario = async (spec) => {
  window.msgs.length = 0;
  const f = document.createElement('iframe');
  if (spec.sandbox) f.setAttribute('sandbox', 'allow-scripts');
  if (spec.lib) { f.setAttribute('credentialless', ''); f.setAttribute('referrerpolicy', 'no-referrer'); }
  let loads = 0; f.addEventListener('load', () => loads++);
  if (spec.blobHtml) f.src = URL.createObjectURL(new Blob([spec.blobHtml], { type: 'text/html' }));
  else if (spec.srcdoc) f.srcdoc = spec.srcdoc;
  else f.src = spec.src;
  document.body.appendChild(f);
  await new Promise((r) => setTimeout(r, 2000));
  f.remove();
  return { loads, msgs: window.msgs.slice() };
};
<\/script></body></html>`;

async function runEngine(name) {
    const srv = await startServer();
    const L = srv.local, I = srv.ip;
    srv.route('/frame.html', (req, url) => ({ headers: { 'content-security-policy': FRAME_CSP(url.searchParams.get('fa') || 'self', req.headers.host) }, body: FRAME }));
    srv.route('/embedder.html', { body: EMBEDDER });
    srv.route('/embedder-sb.html', { headers: { 'content-security-policy': 'sandbox allow-scripts' }, body: EMBEDDER }); // opaque by header
    srv.route('/host.html', { body: HOST });
    srv.route('/host-sb.html', { headers: { 'content-security-policy': 'sandbox allow-scripts' }, body: HOST }); // opaque top-level page
    let FA = 'self';
    const F = (origin, id, extra = '') => `${origin}/frame.html?id=${id}${extra}${FA === 'self' ? '' : `&fa=${FA}`}`;
    const hostLocal = () => [
        ['S1 host -> iframe[sandbox attr] frame', { sandbox: true, src: F(L, 'S1') }],
        ['S1L host -> iframe[sandbox credentialless referrerpolicy=no-referrer] frame (the library\'s wrapper attributes)', { sandbox: true, lib: true, src: F(L, 'S1L') }],
        ['S2 host -> iframe[no attr] frame (header sandbox only)', { sandbox: false, src: F(L, 'S2') }],
        ['S3 host -> iframe[sandbox] embedder.html (same-origin URL, opaque) -> frame', { sandbox: true, src: `${L}/embedder.html?target=${encodeURIComponent(F(L, 'S3'))}` }],
        ['S4 host -> iframe[sandbox srcdoc] (about:srcdoc, opaque) -> frame', { sandbox: true, srcdoc: `<iframe src="${F(L, 'S4')}"></iframe>` }],
        ['S5 host -> iframe[sandbox data:] (opaque) -> frame', { sandbox: true, src: 'data:text/html,' + encodeURIComponent(`<iframe src="${F(L, 'S5')}"></iframe>`) }],
        ['S6 host -> iframe[sandbox blob:] (opaque) -> frame', { sandbox: true, blobHtml: `<iframe src="${F(L, 'S6')}"></iframe>` }],
        ['S7 host -> frame[sandbox] -> frame (a served frame inside a served frame)', { sandbox: true, src: F(L, 'S7a', `&embed=${encodeURIComponent(F(L, 'S7b'))}`) }],
        ['S8 host -> iframe[no attr] embedder-sb.html (opaque by header) -> frame', { sandbox: false, src: `${L}/embedder-sb.html?target=${encodeURIComponent(F(L, 'S8'))}` }],
        ['S9 host(localhost) -> embedder.html on 127.0.0.1 -> frame on localhost (cross-site middle)', { sandbox: false, src: `${I}/embedder.html?target=${encodeURIComponent(F(L, 'S9'))}` }],
        ['S10 host(localhost) -> frame on 127.0.0.1 (cross-site, frame served by the other origin)', { sandbox: true, src: F(I, 'S10') }],
    ];
    const browser = await ENGINES[name].launch();
    const run = async (label, url, specs) => {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const failed = [], cons = [];
        page.on('requestfailed', (r) => { if (r.url().includes('/frame.html')) failed.push(r.failure()?.errorText); });
        page.on('console', (m) => cons.push(m.text().slice(0, 200)));
        await page.goto(url);
        for (const [title, spec] of specs) {
            srv.reports.length = 0; failed.length = 0; cons.length = 0; srv.requests.length = 0;
            const r = await page.evaluate((s) => window.scenario(s), spec);
            await sleep(800);
            emit('q3', {
                engine: name, top: label, scenario: title,
                outcome: r.msgs.length ? 'ALLOWED' : 'REFUSED',
                msgs: r.msgs.map((m) => `${m.id}: origin=${m.origin} ancestorOrigins=${JSON.stringify(m.ancestorOrigins)} parentAccess=${m.parentAccess}`),
                loadEvents: r.loads,
                // what a server sees of each frame.html request: Sec-Fetch-Site / -Dest, and the Origin header if any
                frameRequests: srv.requests.filter((q) => q.path === '/frame.html').map((q) => `${q.id ?? ''}site=${q.site} dest=${q.dest} origin=${q.origin ?? '-'}`),
                reports: srv.reports.map((x) => { const b = x.body['csp-report'] || x.body; return typeof b === 'string' ? b.slice(0, 200) : { blocked: b['blocked-uri'], directive: b['violated-directive'] || b['effective-directive'], doc: b['document-uri'], disposition: b.disposition, original: String(b['original-policy'] || '').slice(0, 80) }; }),
                requestFailed: [...failed],
                console: cons.filter((c) => /frame-ancestors|ancestor|Refused|blocked|violat/i.test(c)).slice(0, 2),
            });
        }
        await ctx.close();
    };
    await run('http://localhost (host origin)', `${L}/host.html`, hostLocal());
    // the host on the other site embeds the localhost frame: cross-site framing
    await run('http://127.0.0.1 (other site)', `${I}/host.html`, [
        ['X1 other-site host -> iframe[sandbox attr] frame on localhost', { sandbox: true, src: F(L, 'X1') }],
        ['X2 other-site host -> iframe[no attr] frame on localhost', { sandbox: false, src: F(L, 'X2') }],
    ]);
    // the host page is itself opaque (served with a sandbox header), same URL origin as the frame
    await run('http://localhost/host-sb.html (top-level page sandboxed by header)', `${L}/host-sb.html`, [
        ['T1 opaque top -> iframe[sandbox attr] frame', { sandbox: true, src: F(L, 'T1') }],
    ]);
    // Q3b: which frame-ancestors source list admits an opaque ancestor and still refuses another site? The same chains,
    // with the list varied: an explicit origin, host:port without a scheme, `*`, and none (the sandbox directive alone).
    for (FA of ['origin', 'hostport', 'star', 'none']) {
        const pick = hostLocal().filter(([t]) => /^(S1|S3|S4|S5|S6|S7|S9|S10) /.test(t));
        await run(`http://localhost (host origin), frame-ancestors variant: ${FA}`, `${L}/host.html`, pick);
        await run(`http://127.0.0.1 (other site), frame-ancestors variant: ${FA}`, `${I}/host.html`, [[`X1 other-site host -> iframe[sandbox attr] frame on localhost`, { sandbox: true, src: F(L, 'X1') }]]);
    }
    await browser.close();
    await srv.close();
}

for (const name of engineArgs()) {
    try { await runEngine(name); } catch (e) { emit('q3.error', { engine: name, error: String(e).slice(0, 400) }); }
}
