// Q5 (side measurement). What the served frame and its srcdoc child see and inherit: document.baseURI, origin,
// document.referrer, location.ancestorOrigins, the Referer header of the frame's request, and whether the host's CSP
// (`base-uri 'none'`, `img-src 'none'`) binds the srcdoc child. Re-confirms class-review 3.1 on this server.
//
//   bun docs/research/20_served_document_mode/q5-side.mjs [chromium] [firefox] [webkit]
//
// Host: http://localhost:PORT/app/secret-path?token=HOSTSECRET#frag with
//   Content-Security-Policy: default-src 'self' 'unsafe-inline' data: blob:; img-src 'none'; base-uri 'none'
// Every frame is sandbox="allow-scripts" and carries <base href="about:blank"> and an image from the other loopback
// origin (http://127.0.0.1:PORT/i.svg). The served frame is sent with one of three headers (V1-V3 below).
import { createHash } from 'node:crypto';
import { ENGINES, engineArgs, emit, sleep } from './lib.mjs';
import { startServer } from './server.mjs';

const HOST_CSP = "default-src 'self' 'unsafe-inline' data: blob:; img-src 'none'; base-uri 'none'";
const sha = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

// The probe a document runs: its own view of the inherited context, plus an image from the other origin.
const probe = (kind, imgUrl) => `
const r = { kind: ${JSON.stringify(kind)}, origin: String(self.origin), base: document.baseURI, referrer: document.referrer,
  ancestorOrigins: location.ancestorOrigins ? [...location.ancestorOrigins] : 'unsupported', viol: [] };
document.addEventListener('securitypolicyviolation', (e) => r.viol.push(e.violatedDirective + (e.blockedURI ? '' : '')));
let sent = false; const done = () => { if (sent) return; sent = true; setTimeout(() => top.postMessage(r, '*'), 150); };
const img = new Image(); img.onload = () => { r.img = 'load'; done(); }; img.onerror = () => { r.img = 'error'; done(); };
img.src = ${JSON.stringify(imgUrl)} + '?k=${kind}';
setTimeout(done, 1500);`;

async function runEngine(name) {
    const srv = await startServer();
    const L = srv.local, I = srv.ip;
    const IMG = `${I}/i.svg`;
    srv.route('/i.svg', { headers: { 'content-type': 'image/svg+xml' }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });

    const frameScript = probe('served', IMG);
    const childScript = probe('served>srcdoc', IMG);
    const child = `<base href="about:blank"><script>${childScript}<\/script>`;
    const frameBody = `<!doctype html><html><head><meta charset="utf-8"><base href="about:blank"><script>${frameScript}<\/script></head><body><iframe sandbox="allow-scripts" srcdoc="${esc(child)}"></iframe></body></html>`;
    // the same document without any <base>, for the base URL the child inherits from a served frame
    const childNoBaseDoc = `<script>${probe('served>srcdoc', IMG)}<\/script>`;
    const frameNoBaseBody = `<!doctype html><html><head><meta charset="utf-8"><script>${frameScript}<\/script></head><body><iframe sandbox="allow-scripts" srcdoc="${esc(childNoBaseDoc)}"></iframe></body></html>`;

    const HASHES = [sha(frameScript), sha(childScript)];
    const HEADERS = {
        // no fetch directives: only what the sandbox and framing need
        'V1-no-fetch-directives': `sandbox allow-scripts; frame-ancestors 'self'`,
        // 4.A.4 literally: the frame bootstrap's hash only, frame-src 'none', base-uri 'self'
        'V2-proposed-4A4': `sandbox allow-scripts; default-src 'none'; script-src ${HASHES[0]}; frame-src 'none'; base-uri 'self'; frame-ancestors 'self'`,
        // V2 with the child's script hash admitted too, to see which of frame-src and script-src stops the child
        'V3-proposed+child-hash': `sandbox allow-scripts; default-src 'none'; script-src ${HASHES[0]} ${HASHES[1]}; frame-src 'none'; base-uri 'self'; frame-ancestors 'self'`,
        // img-src to the other origin, base-uri about: allowed, frame-src not set: the policy a library might send
        'V4-fetch-ceiling-open': `sandbox allow-scripts; script-src ${HASHES[0]} ${HASHES[1]}; img-src ${I}; base-uri about:; frame-ancestors 'self'`,
    };
    srv.route('/app/secret-path', {
        headers: { 'content-security-policy': HOST_CSP },
        body: `<!doctype html><html><head><meta charset="utf-8"><title>h</title></head><body><script>
window.results = []; addEventListener('message', (e) => results.push(e.data));
window.mk = (attrs) => { const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); for (const [k, v] of Object.entries(attrs)) f.setAttribute(k, v); document.body.appendChild(f); return f; };
window.clear = () => { results.length = 0; document.querySelectorAll('iframe').forEach((f) => f.remove()); };
<\/script></body></html>`,
    });
    let header = HEADERS['V1-no-fetch-directives'];
    let useBase = true;
    srv.route('/frame.html', () => ({ headers: { 'content-security-policy': header }, body: useBase ? frameBody : frameNoBaseBody }));
    // the child with a <meta> policy of its own, to see whether it narrows or relaxes the served header
    let childMeta = '';
    srv.route('/frame-meta.html', () => ({ headers: { 'content-security-policy': header }, body: `<!doctype html><html><head><meta charset="utf-8"><base href="about:blank"><script>${frameScript}<\/script></head><body><iframe sandbox="allow-scripts" srcdoc="${esc(childMeta + child)}"></iframe></body></html>` }));

    const browser = await ENGINES[name].launch();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${L}/app/secret-path?token=HOSTSECRET#frag`);
    const slim = (m) => ({ kind: m.kind, origin: m.origin, base: m.base.slice(0, 80), referrer: m.referrer.slice(0, 80), ancestorOrigins: m.ancestorOrigins, img: m.img, viol: m.viol });
    const collect = async (label, fn) => {
        await page.evaluate(() => window.clear());
        srv.requests.length = 0;
        await page.evaluate(fn);
        await sleep(2400);
        const msgs = await page.evaluate(() => window.results);
        const frameReq = srv.requests.find((r) => r.path === '/frame.html');
        const imgReqs = srv.requests.filter((r) => r.path === '/i.svg').map((r) => r.query);
        emit('q5', { engine: name, case: label, msgs: msgs.map(slim), frameRequestReferer: frameReq ? frameReq.referer ?? null : 'n/a', imageRequests: imgReqs });
    };

    // today: a srcdoc frame under the host's policy
    const srcdoc = `<base href="about:blank"><script>${probe('srcdoc (today)', IMG)}<\/script>`;
    await collect('today: srcdoc frame, default referrer policy', `window.mk({ srcdoc: ${JSON.stringify(srcdoc)} })`);
    await collect('today: srcdoc frame, iframe referrerpolicy=no-referrer', `window.mk({ srcdoc: ${JSON.stringify(srcdoc)}, referrerpolicy: 'no-referrer' })`);

    for (const [hname, h] of Object.entries(HEADERS)) {
        header = h;
        for (const rp of ['', 'no-referrer']) {
            await collect(`served ${hname}${rp ? ', iframe referrerpolicy=no-referrer' : ', default referrer policy'}`, `window.mk(${JSON.stringify(rp ? { src: '/frame.html', referrerpolicy: rp } : { src: '/frame.html' })})`);
        }
    }
    header = HEADERS['V1-no-fetch-directives'];
    useBase = false;
    await collect('served V1, no <base> in either document', `window.mk({ src: '/frame.html' })`);
    // a <meta> in the child: narrows a permissive header, cannot relax a restrictive one
    childMeta = `<meta http-equiv="Content-Security-Policy" content="img-src 'none'">`;
    header = HEADERS['V1-no-fetch-directives'];
    await collect("V1 header, child <meta> img-src 'none'", `window.mk({ src: '/frame-meta.html', referrerpolicy: 'no-referrer' })`);
    childMeta = `<meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline'">`;
    header = HEADERS['V2-proposed-4A4'];
    await collect("V2 header (child script not admitted), child <meta> script-src 'unsafe-inline'", `window.mk({ src: '/frame-meta.html', referrerpolicy: 'no-referrer' })`);
    header = HEADERS['V3-proposed+child-hash'];
    await collect("V3 header (child script admitted), child <meta> script-src 'unsafe-inline' (control)", `window.mk({ src: '/frame-meta.html', referrerpolicy: 'no-referrer' })`);
    await browser.close();
    await srv.close();
}

for (const name of engineArgs()) {
    try { await runEngine(name); } catch (e) { emit('q5.error', { engine: name, error: String(e).slice(0, 400) }); }
}
