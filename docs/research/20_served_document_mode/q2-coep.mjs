// Q2. Under a host page with COOP same-origin + COEP (require-corp, and separately credentialless): does the served
// sandboxed frame load, what headers does it need, is it (or its srcdoc child) crossOriginIsolated, and can the child
// create a SharedArrayBuffer?
//
//   bun docs/research/20_served_document_mode/q2-coep.mjs [chromium] [firefox] [webkit]
//
// The host page (http://localhost:PORT/host.html?coep=...) is served with the COOP + COEP headers. frame.html is served
// with the proposed `Content-Security-Policy: sandbox allow-scripts` and, per variant, a COEP and/or CORP header. The
// iframe carries sandbox="allow-scripts" (the library's attribute) and, per variant, allow="cross-origin-isolated". The
// served frame embeds two srcdoc children (sandbox="allow-scripts"), one with and one without that allow attribute.
import { ENGINES, engineArgs, emit, sleep } from './lib.mjs';
import { startServer } from './server.mjs';

const REPORT = `
const r = { kind: KIND, origin: String(self.origin), coi: self.crossOriginIsolated, sabType: typeof SharedArrayBuffer, sab: null };
try { new SharedArrayBuffer(8); r.sab = 'ok'; } catch (e) { r.sab = e.name; }
try { r.wasmShared = typeof WebAssembly.Memory === 'function' ? (new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }), 'ok') : 'n/a'; } catch (e) { r.wasmShared = e.name; }
top.postMessage(r, '*');`;
const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const childDoc = (kind) => `<script>${REPORT.replace('KIND', JSON.stringify(kind))}<\/script>`;

function frameBody() {
    const c = (kind, allow) => `<iframe sandbox="allow-scripts" ${allow ? 'allow="cross-origin-isolated"' : ''} srcdoc="${esc(childDoc(kind))}"></iframe>`;
    return `<!doctype html><html><head><meta charset="utf-8"></head><body>${c('child-noallow', false)}${c('child-allow', true)}<script>${REPORT.replace('KIND', '"frame"')}<\/script></body></html>`;
}

// The response headers of frame.html per variant, besides the sandbox CSP.
const VARIANTS = {
    'none': {},
    'corp:cross-origin': { 'cross-origin-resource-policy': 'cross-origin' },
    'corp:same-origin': { 'cross-origin-resource-policy': 'same-origin' },
    'coep': 'COEP', // the host's own COEP value
    'coep+corp:cross-origin': 'COEP+CORP',
    // the other COEP value than the host's, with CORP: does a require-corp host admit a credentialless frame, and the reverse?
    'other-coep+corp:cross-origin': 'OTHER+CORP',
};

const HOST = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
window.msgs = [];
addEventListener('message', (e) => msgs.push(e.data));
window.hostInfo = () => ({ coi: self.crossOriginIsolated, sabType: typeof SharedArrayBuffer });
window.scenario = async (variant, allow, srcdoc) => {
  window.msgs.length = 0;
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts');
  if (allow) f.setAttribute('allow', 'cross-origin-isolated');
  let loaded = 0; f.addEventListener('load', () => loaded++);
  if (srcdoc) f.srcdoc = srcdoc; else f.src = '/frame.html?v=' + encodeURIComponent(variant);
  document.body.appendChild(f);
  await new Promise((r) => setTimeout(r, 2200));
  f.remove();
  return { loaded, msgs: window.msgs.slice() };
};
<\/script></body></html>`;

async function runEngine(name) {
    const srv = await startServer();
    let coepMode = 'require-corp';
    srv.route('/host.html', (req, url) => {
        const m = url.searchParams.get('coep');
        const headers = {};
        if (m !== 'none') { headers['cross-origin-opener-policy'] = 'same-origin'; headers['cross-origin-embedder-policy'] = m; }
        return { headers, body: HOST };
    });
    srv.route('/frame.html', (req, url) => {
        const v = url.searchParams.get('v') || 'none';
        let extra = VARIANTS[v];
        if (extra === 'COEP') extra = { 'cross-origin-embedder-policy': coepMode };
        if (extra === 'COEP+CORP') extra = { 'cross-origin-embedder-policy': coepMode, 'cross-origin-resource-policy': 'cross-origin' };
        if (extra === 'OTHER+CORP') extra = { 'cross-origin-embedder-policy': coepMode === 'require-corp' ? 'credentialless' : 'require-corp', 'cross-origin-resource-policy': 'cross-origin' };
        return { headers: { 'content-security-policy': 'sandbox allow-scripts', ...extra }, body: frameBody() };
    });
    const browser = await ENGINES[name].launch();
    for (const mode of ['none', 'require-corp', 'credentialless']) {
        coepMode = mode;
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const failed = [];
        page.on('requestfailed', (r) => { if (r.url().includes('/frame.html')) failed.push(r.failure()?.errorText); });
        const consoleMsgs = [];
        page.on('console', (m) => { if (/COEP|embedder|cross-origin|Cross-Origin|blocked|Refused/i.test(m.text())) consoleMsgs.push(m.text().slice(0, 220)); });
        await page.goto(`${srv.local}/host.html?coep=${mode}`);
        emit('q2.host', { engine: name, coep: mode, ...(await page.evaluate(() => window.hostInfo())) });
        // baseline: today's srcdoc frame under the same host
        for (const allow of [false, true]) {
            const r = await page.evaluate(([a, d]) => window.scenario('', a, d), [allow, `<script>${REPORT.replace('KIND', '"srcdoc-today"')}<\/script>`]);
            emit('q2.srcdoc-today', { engine: name, coep: mode, hostAllow: allow, msgs: r.msgs.map(slim) });
        }
        for (const v of Object.keys(VARIANTS)) {
            if (mode === 'none' && v !== 'none') continue; // the host has no COEP: only the plain frame matters
            for (const allow of [false, true]) {
                failed.length = 0; consoleMsgs.length = 0;
                const r = await page.evaluate(([vv, a]) => window.scenario(vv, a, null), [v, allow]);
                emit('q2.served', { engine: name, coep: mode, frameHeaders: v, hostAllow: allow, loadEvents: r.loaded, msgs: r.msgs.map(slim), requestFailed: [...failed], console: consoleMsgs.slice(0, 2) });
            }
        }
        await ctx.close();
        await sleep(200);
    }
    await browser.close();
    await srv.close();
}
const slim = (m) => `${m.kind}: coi=${m.coi} SAB=${m.sabType}/${m.sab} wasmShared=${m.wasmShared}`;

for (const name of engineArgs()) {
    try { await runEngine(name); } catch (e) { emit('q2.error', { engine: name, error: String(e).slice(0, 400) }); }
}
