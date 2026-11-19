// Q1. The start-up order of 03 ("The start-up order"): the host page posts one message with one port to frames[0] of F at
// F's load; C checks its sender, runs its gates and the policy check, and answers with its hash and its verdicts; only
// then does the host page send content. Does the order work, what does it cost, and what does the host page see when
// documentUrl answers with something else?
//
//   bun docs/research/31_served_startup/q1-order.mjs <engine> [runs]     # default 24 timing runs per variant
//
// Cases: the correct file (positive control); a file of another version (its bootstrap's hash differs: negative control);
// a sibling frame of the host page posting the hello first (C must ignore it); the failure modes (404, an SPA fallback
// answering 200 with other HTML, with and without a frame of its own, X-Frame-Options: DENY, frame-ancestors 'none', a
// text/plain and an application/octet-stream type, a host page whose frame-src does not admit the file), each with what
// the host page reads from outside: the frame's load events, its window's length, its own violations, and a fetch of
// documentUrl. Then the cost: the full order against the same flow with no gates and no check, alternating.
import { ENGINES, emit, emitRun, load1, median, range, sleep } from '../28_served_topology/lib.mjs';
import { HTML, startServer } from './server.mjs';
import { hostPage, servedFile } from './fixture.mjs';

const SPA = '<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body><div id="root"></div><script>document.getElementById("root").textContent = "the app shell";</script></body></html>';
const SPA_FRAME = '<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body><div id="root">the app shell</div><iframe src="/widget.html"></iframe></body></html>';
const WIDGET = '<!doctype html><html><head><meta charset="utf-8"></head><body><script>window.got = []; addEventListener("message", (e) => { got.push({ data: e.data, ports: e.ports.length }); if (e.ports[0]) e.ports[0].postMessage({ widget: "answers on the port" }); });</script></body></html>';

async function runEngine(name, runs) {
    const srv = await startServer();
    const L = srv.local;
    const F = servedFile();
    const OLD = servedFile({ c: { version: '0' } });
    const BARE = servedFile({ c: { gates: false, check: false } });
    const host = hostPage(F.cHash);
    const route = (p, headers, body, status = 200) => srv.route(p, { status, headers, body });
    route('/host.html', HTML, host);
    route('/host-frame-src.html', { ...HTML, 'content-security-policy': "frame-src 'none'" }, host);
    route('/F.html', HTML, F.html);
    route('/old.html', HTML, OLD.html);
    route('/bare.html', HTML, BARE.html);
    route('/404.html', HTML, '<!doctype html><title>Not found</title><h1>404</h1>', 404);
    route('/spa.html', HTML, SPA);
    route('/spa-frame.html', HTML, SPA_FRAME);
    route('/widget.html', HTML, WIDGET);
    route('/xfo.html', { ...HTML, 'x-frame-options': 'DENY' }, F.html);
    route('/fa.html', { ...HTML, 'content-security-policy': "frame-ancestors 'none'" }, F.html);
    route('/plain.html', { 'content-type': 'text/plain; charset=utf-8' }, F.html);
    route('/octet.html', { 'content-type': 'application/octet-stream' }, F.html);

    const browser = await ENGINES[name].launch();
    emitRun('q1', name, browser);
    const ctx = await browser.newContext({ acceptDownloads: true });
    const downloads = [];
    ctx.on('page', (p) => p.on('download', (d) => downloads.push(d.url())));
    const page = await ctx.newPage();
    page.on('download', (d) => downloads.push(d.url()));
    await page.goto(`${L}/host.html`);

    const slim = (r) => ({
        end: r.end, decision: r.decision, hello: r.hello, loads: r.loads, timeline: r.timeline, hostViolations: r.hostViolations,
        verdict: r.verdict && { version: r.verdict.version, hashMatches: r.verdict.hash === F.cHash, ignored: r.verdict.ignored, phases: r.verdict.phases,
            C: r.verdict.C && { gates: r.verdict.C.gates, check: r.verdict.C.check }, W: r.verdict.W && { started: r.verdict.W.started, gates: r.verdict.W.gates, check: r.verdict.W.check } },
        acks: r.acks,
    });
    const CASES = [
        ['correct file (positive control)', '/F.html', 'host.html', {}],
        ['a file of another version (negative control)', '/old.html', 'host.html', {}],
        ['a sibling frame of the host page posts the hello first', '/F.html', 'host.html', { intruder: true }],
        ['404 with an HTML body', '/404.html', 'host.html', {}],
        ['missing path (the server\'s 404, text/plain)', '/nothing-here.html', 'host.html', {}],
        ['SPA fallback: 200 with other HTML', '/spa.html', 'host.html', {}],
        ['SPA fallback: 200 with other HTML that has a frame of its own', '/spa-frame.html', 'host.html', {}],
        ['X-Frame-Options: DENY', '/xfo.html', 'host.html', {}],
        ["Content-Security-Policy: frame-ancestors 'none'", '/fa.html', 'host.html', {}],
        ['Content-Type: text/plain', '/plain.html', 'host.html', {}],
        ['Content-Type: application/octet-stream', '/octet.html', 'host.html', {}],
        ["the host page's frame-src does not admit the file", '/F.html', 'host-frame-src.html', {}],
    ];
    for (const [label, path, hostPath, opts] of CASES) {
        if (!page.url().endsWith(hostPath)) await page.goto(`${L}/${hostPath}`);
        srv.reset();
        downloads.length = 0;
        const r = await page.evaluate(([u, o]) => window.start(u, { ...o, timeout: 4000, keep: true }), [path, opts]);
        const intruderGot = opts.intruder ? await page.evaluate(() => window.intruderGot()) : undefined;
        const widget = path === '/spa-frame.html' ? await page.frames().find((f) => f.url().endsWith('/widget.html'))?.evaluate(() => window.got).catch((e) => String(e).slice(0, 80)) : undefined;
        const fetched = await page.evaluate((u) => window.probe(u), path);
        emit('q1.case', { engine: name, case: label, path, host: hostPath, seen: slim(r), intruderGot, widget, fetchedByHost: fetched, downloads: downloads.slice(), requests: srv.requests.map((q) => `${q.path} ${q.dest ?? ''}`) });
        await page.goto(`${L}/${hostPath}`);
    }

    // the cost: full order vs. the same flow with no gates and no check, alternating, one fresh element per start
    await page.goto(`${L}/host.html`);
    const V = { 'gates and policy check (the design)': ['/F.html', F.cHash], 'no gates, no check (the same flow)': ['/bare.html', BARE.cHash] };
    const rows = Object.fromEntries(Object.keys(V).map((k) => [k, []]));
    const loads = [];
    for (const [p, h] of Object.values(V)) await page.evaluate(([u, x]) => window.start(u, { expectHash: x }), [p, h]); // warm-up, not counted
    for (let k = 0; k < runs; k++) {
        const order = Object.keys(V);
        for (const v of k % 2 ? order.reverse() : order) {
            loads.push(load1());
            const [p, h] = V[v];
            const r = await page.evaluate(([u, x]) => window.start(u, { expectHash: x }), [p, h]);
            rows[v].push(r);
            await sleep(100);
        }
    }
    for (const [v, rs] of Object.entries(rows)) {
        const ok = rs.filter((r) => r.end === 'content acknowledged');
        const col = (f) => { const xs = ok.map(f).filter((x) => typeof x === 'number'); return xs.length ? { median: +median(xs).toFixed(1), range: range(xs.map((x) => Math.round(x))) } : null; };
        emit('q1.cost', {
            engine: name, variant: v, runs: rs.length, acknowledged: ok.length, ends: [...new Set(rs.map((r) => r.end))],
            insertToLoad: col((r) => r.loads[0]?.t), insertToVerdict: col((r) => r.timeline.verdict), insertToContentAck: col((r) => r.timeline.content),
            inC: col((r) => r.verdict.ms), cGatesDone: col((r) => r.verdict.phases?.gates), cCheckDone: col((r) => r.verdict.phases?.check), workerDone: col((r) => r.verdict.phases?.worker),
            load1: range(loads),
        });
    }
    await browser.close();
}

const args = process.argv.slice(2);
const runs = Number(args.find((a) => /^\d+$/.test(a)) ?? 24);
for (const name of args.filter((a) => a in ENGINES)) {
    try { await runEngine(name, runs); } catch (e) { emit('q1.error', { engine: name, error: String(e).slice(0, 400) }); }
}
process.exit(0);
