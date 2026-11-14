// Q3. A policy added from outside: the embedder's server sends its own site-wide CSP header (with a report-uri) with the
// static file. Can the served document detect, from inside, that a policy other than its own <meta> applies, and fail
// closed?
//
//   bun docs/research/27_served_document_headerless/q3-outside-policy.mjs [chromium|firefox|webkit]
//
// The served file carries a <meta> policy shaped like sealed mode's view policy (sealedViewPolicy: hash-only scripts,
// style-src 'unsafe-inline' blob:, img-src blob:, connect-src 'none', worker-src blob:, base-uri about:, the rest 'none').
// Its one script, the detector, runs canaries and then reads what happened:
// - canaries the <meta> refuses (an http: image, a data: image, a fetch, a font, a media load, a frame, an inline
//   script, eval, a <base>): the <meta> raises one securitypolicyviolation each; a second event, or an event whose
//   `originalPolicy` is not the <meta>'s text, is another policy;
// - canaries the <meta> admits (a blob: image, a style attribute set from script, a <style> element, a string to
//   innerHTML (a Trusted Types sink), a blob: worker): any refusal is another policy;
// - the same fetch canary from the srcdoc child and from the worker, to see whether the outside policy binds them.
// The outside policy is one of OUTSIDE below, as an enforced header or as Content-Security-Policy-Report-Only.
// The host page has no policy of its own here.
import { ENGINES, emit, emitRun, engineArgs, esc, sha, sleep } from './lib.mjs';
import { HTML, startServer } from './server.mjs';
import { SVG } from './probe-doc.mjs';

const CANARY = 'http://canary.invalid';
const VIOL = `(e) => ({ dir: e.effectiveDirective || e.violatedDirective, disp: e.disposition, blocked: String(e.blockedURI).slice(0, 40), policy: e.originalPolicy })`;
const CHILD_SCRIPT = `(() => { const v = []; document.addEventListener('securitypolicyviolation', (e) => v.push((${VIOL})(e)));
fetch('${CANARY}/child').catch(() => {}); setTimeout(() => top.postMessage({ child: v }, '*'), 600); })();`;
const WORKER = `const v = []; self.addEventListener('securitypolicyviolation', (e) => v.push((${VIOL})(e)));
fetch('${CANARY}/worker').catch(() => {}); setTimeout(() => postMessage(v), 500);`;
const DETECTOR = `(() => {
const meta = document.querySelector('meta[http-equiv]').content;
const norm = (p) => p.split(';').map((d) => d.trim().replace(/\\s+/g, ' ')).filter((d) => d && !/^report-(uri|to)\\b/.test(d)).sort().join('; ');
const mine = norm(meta);
const ev = []; document.addEventListener('securitypolicyviolation', (e) => ev.push((${VIOL})(e)));
const R = { refusedAllowed: [], attempts: {} };
const t = (k, f) => { try { R.attempts[k] = f() ?? 'done'; } catch (e) { R.attempts[k] = 'throws ' + e.name; } };
const pend = [];
const img = (k, src) => pend.push(new Promise((res) => { const i = new Image(); i.onload = () => { R.attempts[k] = 'loaded'; res(); }; i.onerror = () => { R.attempts[k] = 'refused'; res(); }; i.src = src; }));
// the <meta> refuses these
img('img-http', '${CANARY}/i.svg');
img('img-data', 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>'));
pend.push(fetch('${CANARY}/c').then(() => { R.attempts.fetch = 'ok'; }, () => { R.attempts.fetch = 'refused'; }));
t('font', () => { const f = new FontFace('x', 'url(${CANARY}/f.woff)'); pend.push(f.load().then(() => 'ok', () => 'refused')); });
t('media', () => { const a = new Audio(); a.src = '${CANARY}/a.mp3'; });
t('frame', () => { const f = document.createElement('iframe'); f.src = '${CANARY}/frame'; document.body.append(f); });
t('inline-script', () => { const s = document.createElement('script'); s.textContent = 'window.inlineRan = 1'; document.head.append(s); });
t('eval', () => String((0, eval)('1')));
t('base', () => { const b = document.createElement('base'); b.href = '${CANARY}/'; document.head.append(b); return document.baseURI.startsWith('${CANARY}') ? 'applied' : 'refused'; });
// the <meta> admits these
img('img-blob', URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'], { type: 'image/svg+xml' })));
t('style-attr', () => { const p = document.createElement('p'); p.setAttribute('style', 'color: rgb(7, 8, 9)'); document.body.append(p); return getComputedStyle(p).color === 'rgb(7, 8, 9)' ? 'applied' : 'refused'; });
t('style-elem', () => { const s = document.createElement('style'); s.textContent = '#q { color: rgb(9, 8, 7) }'; document.head.append(s); const p = document.createElement('p'); p.id = 'q'; document.body.append(p); return getComputedStyle(p).color === 'rgb(9, 8, 7)' ? 'applied' : 'refused'; });
t('tt-sink', () => { document.createElement('div').innerHTML = '<i>x</i>'; return 'accepted'; });
pend.push(new Promise((res) => {
  try {
    const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(WORKER)}], { type: 'text/javascript' })));
    w.onmessage = (e) => { R.worker = e.data.map((v) => ({ ...v, mine: norm(v.policy) === mine })); res(); };
    w.onerror = () => { R.attempts.worker = 'refused'; res(); };
  } catch (e) { R.attempts.worker = 'throws ' + e.name; res(); }
  setTimeout(res, 2000);
}));
Promise.all(pend).then(() => setTimeout(() => {
  for (const k of ['img-blob', 'style-attr', 'style-elem', 'tt-sink']) if (R.attempts[k] !== 'loaded' && R.attempts[k] !== 'applied' && R.attempts[k] !== 'accepted') R.refusedAllowed.push(k);
  if (R.attempts.worker) R.refusedAllowed.push('worker');
  R.events = ev.map((v) => ({ dir: v.dir, disp: v.disp, blocked: v.blocked, mine: norm(v.policy) === mine, policy: norm(v.policy) === mine ? '(the meta)' : v.policy.slice(0, 90) }));
  R.foreign = R.events.filter((v) => !v.mine).length;
  R.detected = R.foreign > 0 || R.refusedAllowed.length > 0 || (R.worker || []).some((v) => !v.mine);
  top.postMessage({ detector: R }, '*');
}, 300));
})();`;

const OUTSIDE = {
    'none (control)': null,
    'typical site policy, enforced': ['content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; report-uri /__report?from=site"],
    'typical site policy, report-only': ['content-security-policy-report-only', "default-src 'self'; report-uri /__report?from=site"],
    "script-src 'self' (no 'unsafe-inline')": ['content-security-policy', "script-src 'self'; report-uri /__report?from=site"],
    "require-trusted-types-for 'script'": ['content-security-policy', "require-trusted-types-for 'script'; report-uri /__report?from=site"],
    'permissive (refuses nothing the canaries do)': ['content-security-policy', "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; base-uri *; report-uri /__report?from=site"],
    "frame-ancestors 'self' only": ['content-security-policy', "frame-ancestors 'self'; report-uri /__report?from=site"],
    'upgrade-insecure-requests only': ['content-security-policy', 'upgrade-insecure-requests'],
    "object-src 'none'; form-action 'self' (directives no canary covers)": ['content-security-policy', "object-src 'none'; form-action 'self'; report-uri /__report?from=site"],
    'sandbox allow-scripts allow-same-origin (header sandbox)': ['content-security-policy', 'sandbox allow-scripts allow-same-origin'],
};

async function runEngine(name) {
    const srv = await startServer();
    const L = srv.local;
    srv.route('/i.svg', SVG);
    const child = `<script>${CHILD_SCRIPT}</script>`;
    const META = `default-src 'none'; script-src ${sha(DETECTOR)} ${sha(CHILD_SCRIPT)}; script-src-attr 'none'; style-src 'unsafe-inline' blob:; img-src blob:; font-src 'none'; media-src 'none'; connect-src 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri about:; form-action 'none'; manifest-src 'none'`;
    const FILE = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${META}"><meta charset="utf-8"></head><body><iframe sandbox="allow-scripts" srcdoc="${esc(child)}"></iframe><script>${DETECTOR}</script></body></html>`;
    let outside = null;
    srv.route('/frame.html', () => ({ headers: outside ? { ...HTML, [outside[0]]: outside[1] } : HTML, body: FILE }));
    srv.route('/host.html', { headers: HTML, body: `<!doctype html><html><head><meta charset="utf-8"></head><body><script>window.results = []; addEventListener('message', (e) => results.push(e.data));
window.mk = () => { const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.src = '/frame.html'; document.body.append(f); };</script></body></html>` });

    const browser = await ENGINES[name].launch();
    emitRun('q3', name, browser);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    for (const [label, o] of Object.entries(OUTSIDE)) {
        outside = o;
        await page.goto(`${L}/host.html`);
        srv.reset();
        await page.evaluate(() => window.mk());
        await sleep(3500);
        const res = await page.evaluate(() => window.results);
        const det = res.find((m) => m && m.detector)?.detector ?? null;
        const ch = res.find((m) => m && m.child)?.child ?? null;
        emit('q3', {
            engine: name, case: label, header: o,
            detector: det ?? 'no message: the detector did not run',
            child: ch ? ch.map((v) => ({ dir: v.dir, disp: v.disp, policy: v.policy.slice(0, 60) })) : 'no message',
            siteReports: srv.reports.filter((r) => r.from === 'site').map((r) => { const b = r.body['csp-report'] || r.body; return `${b['effective-directive'] || b['violated-directive']} ${String(b['blocked-uri']).slice(0, 40)}`; }),
        });
    }
    await browser.close();
    await srv.close();
}

for (const name of engineArgs()) {
    try { await runEngine(name); } catch (e) { emit('q3.error', { engine: name, error: String(e).slice(0, 400) }); }
}
