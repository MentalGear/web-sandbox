// Q3b. Which documents' violations reach a report-uri, per engine: F (the served file), C (its srcdoc child) and C's
// blob: worker, under Content-Security-Policy-Report-Only: default-src 'self' on F, with C and F each opaque or not, and
// the blocked URL a blob:, a data: or an http: URL. Q3 found that WebKit raises the events in C and the worker but sends
// reports from F only; this isolates what decides it.
//
//   bun docs/research/31_served_startup/q3-report-sources.mjs <engine>
//
// No <meta> here: only the outside report-only policy applies, so every canary runs and is reported (or not).
import { ENGINES, emit, emitRun, esc, sleep } from '../28_served_topology/lib.mjs';
import { HTML, startServer } from './server.mjs';

const W_SRC = `const ev = []; self.addEventListener('securitypolicyviolation', (e) => ev.push(e.effectiveDirective + ' ' + String(e.blockedURI).slice(0, 30)));
fetch('http://canary.invalid/w-fetch').catch(() => {}); try { eval('1'); } catch {} setTimeout(() => postMessage(ev), 400);`;
const C_SRC = `const ev = []; document.addEventListener('securitypolicyviolation', (e) => ev.push(e.effectiveDirective + ' ' + String(e.blockedURI).slice(0, 30)));
const img = (u) => { const i = new Image(); i.src = u; };
img(URL.createObjectURL(new Blob(['x'], { type: 'image/png' })));
img('data:image/png;base64,AAAA');
img('http://canary.invalid/c-img');
fetch('http://canary.invalid/c-fetch').catch(() => {});
try { eval('1'); } catch {}
const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(W_SRC)}], { type: 'text/javascript' })));
w.onmessage = (m) => { window.R = { origin: String(self.origin), C: ev, W: m.data }; };
setTimeout(() => { window.R = window.R || { origin: String(self.origin), C: ev, W: 'no answer' }; }, 1500);`;
const fileWith = (cAttr) => `<!doctype html><html><head><meta charset="utf-8"></head><body><script>window.F = String(self.origin)</script><iframe ${cAttr === null ? '' : `sandbox="${cAttr}"`} srcdoc="${esc(`<script>${C_SRC}</script>`)}"></iframe></body></html>`;

const VARIANTS = [
    ['F opaque (framed allow-scripts), C sandbox allow-scripts (the design)', 'allow-scripts', 'allow-scripts'],
    ['F opaque, C sandbox allow-scripts allow-same-origin (C shares F\'s opaque origin)', 'allow-scripts', 'allow-scripts allow-same-origin'],
    ['F not opaque (no sandbox), C sandbox allow-scripts', null, 'allow-scripts'],
    ['F not opaque, C sandbox allow-scripts allow-same-origin (C has the real origin)', null, 'allow-scripts allow-same-origin'],
    ['F not opaque, C with no sandbox attribute', null, null],
];

async function runEngine(name) {
    const srv = await startServer();
    VARIANTS.forEach(([, , cAttr], i) => srv.route(`/v${i}.html`, { headers: { ...HTML, 'content-security-policy-report-only': `default-src 'self'; report-uri /__report?from=${i}` }, body: fileWith(cAttr) }));
    srv.route('/host.html', { headers: HTML, body: '<!doctype html><meta charset="utf-8"><body></body>' });
    const browser = await ENGINES[name].launch();
    emitRun('q3b', name, browser);
    const page = await (await browser.newContext()).newPage();
    for (let i = 0; i < VARIANTS.length; i++) {
        const [label, fAttr] = VARIANTS[i];
        await page.goto(`${srv.local}/host.html`);
        await page.evaluate(([u, a]) => { const f = document.createElement('iframe'); if (a) f.setAttribute('sandbox', a); f.src = u; document.body.append(f); }, [`/v${i}.html`, fAttr]);
        await sleep(2500);
        const c = page.frames().find((f) => f.url() === 'about:srcdoc');
        const seen = c ? await c.evaluate(() => window.R).catch((e) => String(e).slice(0, 80)) : 'no C';
        await sleep(1500);
        const reps = srv.reports.filter((r) => r.from === String(i)).map((r) => { const b = r.body['csp-report'] || {}; const d = b['document-uri'] || ''; return `${d.startsWith('about') ? 'C' : d.startsWith('blob') ? 'W' : 'F'}:${b['effective-directive'] || b['violated-directive']} ${String(b['blocked-uri']).slice(0, 30)}`; });
        emit('q3b', { engine: name, case: label, eventsSeen: seen, reports: reps.length, fromC: reps.filter((r) => r.startsWith('C:')), fromW: reps.filter((r) => r.startsWith('W:')), fromF: reps.filter((r) => r.startsWith('F:')) });
    }
    await browser.close();
}

for (const name of process.argv.slice(2).filter((a) => a in ENGINES)) {
    try { await runEngine(name); } catch (e) { emit('q3b.error', { engine: name, error: String(e).slice(0, 400) }); }
}
process.exit(0);
