// Q4a, the policy half. Research 27 Q1 with the served file on another site than the host page: does the file's <meta>
// still start a policy of its own, with the host page's policy binding nothing in the file, its srcdoc child and their
// workers, when the file comes from http://127.0.0.1:P and the host page is http://localhost:P?
//
//   bun docs/research/28_served_topology/q4-policy.mjs <engine>
//
// Research 27's probe content is reused as it is (its probe-doc.mjs: the same markup and script in every document, each
// action one the host's policy refuses, each refusal told apart by a token in the policy that raised it). The host page's
// header is research 27's strict one, its framing directive naming the file's origin. M-open admits every action of the
// probe but the canary (a fetch to the host origin); M-closed refuses every action (the positive control). Today's
// srcdoc frame under the same host is the control that the host's policy is seen where it is inherited.
import { ENGINES, emit, emitRun, sha, sleep } from './lib.mjs';
import { HTML, startServer } from './server.mjs';
import { SVG, TEXT, hostPage, probeDocument, servedFile, slimReport } from '../27_served_document_headerless/probe-doc.mjs';

const N = 'n0nce';
const hostCsp = (I, worker) => [
    "default-src 'none'", `script-src 'nonce-${N}' 'report-sample'`, "style-src 'self' 'report-sample'", "img-src 'none'",
    "connect-src 'none'", `frame-src ${I}`, `worker-src ${worker}`, "base-uri 'none'", "require-trusted-types-for 'script'",
    "trusted-types host probe 'allow-duplicates'", 'report-uri /__report?from=host',
].join('; ');

async function runEngine(name) {
    const srv = await startServer();
    const L = srv.local, I = srv.ip;
    srv.route('/i.svg', SVG);
    srv.route('/c', TEXT);
    const M_OPEN = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src ${I}; connect-src ${I}; worker-src blob:; base-uri ${I}; report-uri /__report?from=meta`;
    const open = servedFile({ ip: I, local: L, meta: M_OPEN });
    const hashes = servedFile({ ip: I, local: L, meta: 'X' }).scripts.map(sha).join(' ');
    const M_CLOSED = `default-src 'none'; script-src ${hashes}; worker-src blob:; base-uri 'none'; require-trusted-types-for 'script'; trusted-types probe 'allow-duplicates'; report-uri /__report?from=meta`;
    const closed = servedFile({ ip: I, local: L, meta: M_CLOSED });
    const FILES = { open: open.html, closed: closed.html };
    let served = 'open';
    srv.route('/frame.html', () => ({ headers: HTML, body: FILES[served] }));
    let csp = hostCsp(I, "'none'");
    srv.route('/host.html', () => ({ headers: { ...HTML, 'content-security-policy': csp }, body: hostPage(N) }));

    const browser = await ENGINES[name].launch();
    emitRun('q4p', name, browser);
    const page = await (await browser.newContext()).newPage();
    const collect = async (label, make) => {
        await page.goto(`${L}/host.html`);
        srv.reset();
        const hostOwn = await page.evaluate((u) => window.hostFetch(u), `${I}/c?k=host`);
        await page.evaluate(make);
        await sleep(4000);
        const st = await page.evaluate(() => ({ results: window.results, loads: window.loads, hostViol: window.hostViol }));
        await sleep(500);
        emit('q4p', {
            engine: name, case: label, hostOwnFetch: hostOwn, docs: st.results.filter((m) => m && m.probe).map((m) => m.probe),
            frameLoadEvents: st.loads, hostViolations: st.hostViol, reports: srv.reports.map(slimReport),
            frameRequests: srv.requests.filter((r) => r.path === '/frame.html').map((r) => ({ host: r.host, site: r.site, referer: r.referer })),
        });
    };
    for (const worker of ["'none'", 'blob:']) {
        csp = hostCsp(I, worker);
        const today = probeDocument({ cfg: { kind: 'srcdoc (today)', ip: I, local: L }, nonce: N });
        await collect(`host worker-src ${worker}; today: srcdoc frame`, `window.mk('srcdoc', { sandbox: 'allow-scripts' }, ${JSON.stringify(today.html)})`);
        for (const m of ['open', 'closed']) {
            served = m;
            await collect(`host worker-src ${worker}; cross-site served frame, meta M-${m}`, `window.mk('served', { sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', src: '${I}/frame.html' })`);
        }
    }
    await browser.close();
    await srv.close();
}

for (const name of process.argv.slice(2).filter((a) => a in ENGINES)) {
    try { await runEngine(name); } catch (e) { emit('q4p.error', { engine: name, error: String(e).slice(0, 400) }); }
}
process.exit(0); // the servers' keep-alive sockets must not hold the run open after an error
