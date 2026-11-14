// Q1. A served file with no response headers, its policy in a <meta> tag, under a host page with a strict policy.
//
//   bun docs/research/27_served_document_headerless/q1-meta-policy.mjs [chromium|firefox|webkit] [part ...]
//   parts: inherit (Q1a), framesrc (Q1c), ignored (Q1b); default: all three
//
// inherit: host page (header HOST_CSP below) -> iframe[sandbox="allow-scripts"] src=/frame.html (only Content-Type on the
// response; the policy is the first element of <head>) -> a srcdoc child and a blob: worker in each document. Control:
// the same content as today's srcdoc frame of the host page. Two host policies (worker-src 'none' and worker-src blob:,
// so the control's worker runs and shows what it inherits) and two <meta> policies: M-open admits every action of the
// probe except a canary fetch to the host origin (what the host policy binds shows); M-closed refuses every action (the
// positive control that the probe sees a refusal in the served topology, and that the <meta> binds the child and the
// worker).
// framesrc: what the host page's policy must admit for the served frame to load, and what the host sees if it does not.
// ignored: a <meta> with `sandbox`, `frame-ancestors 'none'` and `report-uri`, opened top-level and framed cross-site.
import { ENGINES, collectConsole, emit, emitRun, engineArgs, sha, sleep } from './lib.mjs';
import { HTML, startServer } from './server.mjs';
import { SVG, TEXT, hostPage, probeDocument, servedFile, slimReport } from './probe-doc.mjs';

const N = 'n0nce';
const hostCsp = ({ worker = "'none'", frame = "frame-src 'self'" } = {}) => [
    "default-src 'none'", `script-src 'nonce-${N}' 'report-sample'`, "style-src 'self' 'report-sample'", "img-src 'none'",
    "connect-src 'none'", frame, `worker-src ${worker}`, "base-uri 'none'", "require-trusted-types-for 'script'",
    "trusted-types host probe 'allow-duplicates'", 'report-uri /__report?from=host',
].filter(Boolean).join('; ');

const args = process.argv.slice(2);
const named = args.filter((a) => ['inherit', 'framesrc', 'ignored'].includes(a));
const PARTS = named.length ? named : ['inherit', 'framesrc', 'ignored'];
let part;

async function runEngine(name) {
    const srv = await startServer();
    const L = srv.local, I = srv.ip;
    srv.route('/i.svg', SVG);
    srv.route('/c', TEXT);
    const M_OPEN = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src ${I}; connect-src ${I}; worker-src blob:; base-uri ${I}; report-uri /__report?from=meta`;
    const open = servedFile({ ip: I, local: L, meta: M_OPEN });
    const hashes = servedFile({ ip: I, local: L, meta: 'X' }).scripts.map(sha).join(' '); // the scripts do not depend on the meta
    const M_CLOSED = `default-src 'none'; script-src ${hashes}; worker-src blob:; base-uri 'none'; require-trusted-types-for 'script'; trusted-types probe 'allow-duplicates'; report-uri /__report?from=meta`;
    const closed = servedFile({ ip: I, local: L, meta: M_CLOSED });
    const FILES = { open: open.html, closed: closed.html };
    let served = 'open';
    srv.route('/frame.html', () => ({ headers: HTML, body: FILES[served] }));
    let csp = hostCsp();
    srv.route('/host.html', () => ({ headers: { ...HTML, 'content-security-policy': csp }, body: hostPage(N) }));

    const browser = await ENGINES[name].launch();
    emitRun('q1', name, browser);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const consoleLines = collectConsole(page);

    const collect = async (label, make, wait = 4000) => {
        await page.goto(`${L}/host.html`);
        srv.reset();
        consoleLines.length = 0;
        const hostOwn = await page.evaluate((u) => window.hostFetch(u), `${I}/c?k=host`);
        await page.evaluate(make);
        await sleep(wait);
        const st = await page.evaluate(() => ({ results: window.results, loads: window.loads, hostViol: window.hostViol }));
        await sleep(500);
        emit('q1', {
            engine: name, part, case: label, hostOwnFetch: hostOwn,
            docs: st.results.filter((m) => m && m.probe).map((m) => m.probe),
            frameLoadEvents: st.loads, hostViolations: st.hostViol,
            reports: srv.reports.map(slimReport),
            frameRequested: srv.requests.filter((r) => r.path === '/frame.html').length,
            console: [...new Set(consoleLines)],
        });
    };

    if (part === 'inherit') {
        for (const worker of ["'none'", 'blob:']) {
            csp = hostCsp({ worker });
            const today = probeDocument({ cfg: { kind: 'srcdoc (today)', ip: I, local: L }, nonce: N });
            await collect(`host worker-src ${worker}; today: srcdoc frame`, `window.mk('srcdoc', { sandbox: 'allow-scripts' }, ${JSON.stringify(today.html)})`);
            for (const m of ['open', 'closed']) {
                served = m;
                await collect(`host worker-src ${worker}; served frame, meta M-${m}`, `window.mk('served', { sandbox: 'allow-scripts', src: '/frame.html' })`);
            }
        }
    }
    if (part === 'framesrc') {
        served = 'open';
        const variants = {
            "frame-src 'self' (control)": "frame-src 'self'",
            "no frame-src, no child-src (default-src 'none' governs)": '',
            "child-src 'self' only": "child-src 'self'",
            "frame-src 'none'": "frame-src 'none'",
            'frame-src blob: data: (no self)': 'frame-src blob: data:',
        };
        for (const [label, frame] of Object.entries(variants)) {
            csp = hostCsp({ frame });
            await collect(label, `window.mk('served', { sandbox: 'allow-scripts', src: '/frame.html' })`);
        }
    }
    if (part === 'ignored') {
        const META = `sandbox allow-scripts; frame-ancestors 'none'; img-src 'none'; report-uri /__report?from=meta`;
        const body = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${META}"><meta charset="utf-8"></head><body><script>
window.R = { origin: String(self.origin), top: window.top === window, viol: [] };
document.addEventListener('securitypolicyviolation', (e) => R.viol.push(e.effectiveDirective || e.violatedDirective));
const i = new Image(); i.onload = () => { R.img = 'loaded'; }; i.onerror = () => { R.img = 'refused'; };
i.src = '${I}/i.svg?k=ignored';
setTimeout(() => { if (window.top !== window) parent.postMessage({ probe: R }, '*'); }, 800);
</script></body></html>`;
        srv.route('/ignored.html', { headers: HTML, body });
        srv.route('/embedder.html', { headers: HTML, body: `<!doctype html><html><body><script>window.results = []; addEventListener('message', (e) => results.push(e.data));</script><iframe src="${L}/ignored.html"></iframe></body></html>` });
        srv.reset(); consoleLines.length = 0;
        await page.goto(`${L}/ignored.html`);
        await sleep(1500);
        const top = await page.evaluate(() => window.R);
        emit('q1', { engine: name, part, case: 'top-level navigation to the file', doc: top, reports: srv.reports.map(slimReport), console: [...new Set(consoleLines)] });
        srv.reset(); consoleLines.length = 0;
        await page.goto(`${I}/embedder.html`);
        await sleep(2000);
        const framed = await page.evaluate(() => window.results);
        emit('q1', { engine: name, part, case: 'framed by a cross-site page without the sandbox attribute', docs: framed, reports: srv.reports.map(slimReport), console: [...new Set(consoleLines)] });
    }
    await browser.close();
    await srv.close();
}

for (const name of engineArgs(args)) {
    for (part of PARTS) {
        try { await runEngine(name); } catch (e) { emit('q1.error', { engine: name, part, error: String(e).slice(0, 400) }); }
    }
}
