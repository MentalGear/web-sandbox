// Q2. The gates in C and the worker, with F static (its only script the guard): does each still trip under the mutant
// that provokes it, which mutants pass every gate, and what does the policy check (I18) add? Every mutant is a file the
// browser could be made to see by a bug or a setting (a weakened <meta>, none, F framed with other flags, the worker's
// allowlist step skipped), or a file without the guard (what F's realm loses now that it has no gate).
//
//   bun docs/research/31_served_startup/q2-gates.mjs <engine>
//
// The host page runs the start-up order of fixture.mjs and records C's and the worker's verdicts. "gates" are research 28
// Q7's canaries without the frame canary; "policy" is the check of I18 (a violation whose originalPolicy is not the
// file's <meta> text, a report disposition, an event twice, an admitted load refused or a refused one admitted).
import { ENGINES, emit, emitRun, sleep } from '../28_served_topology/lib.mjs';
import { HTML, startServer } from './server.mjs';
import { hostPage, servedFile } from './fixture.mjs';

const SB = 'allow-scripts allow-forms';
const MUTANTS = [
    ['correct file (positive control)', {}, SB],
    ['no <meta> policy', { meta: false }, SB],
    ["script-src + 'unsafe-eval'", { weaken: (d) => ({ 'script-src': `${d['script-src']} 'unsafe-eval'` }) }, SB],
    ['connect-src * data: blob:', { weaken: { 'connect-src': '* data: blob:' } }, SB],
    ['img-src * data: blob:', { weaken: { 'img-src': '* data: blob:' } }, SB],
    ["style-src 'unsafe-inline' blob: (no hash)", { weaken: { 'style-src': "'unsafe-inline' blob:" } }, SB],
    ['base-uri *', { weaken: { 'base-uri': '*' } }, SB],
    ['frame-src * data:', { weaken: { 'frame-src': '* data:' } }, SB],
    ['worker-src * data: blob:', { weaken: { 'worker-src': '* data: blob:' } }, SB],
    ['default-src *', { weaken: { 'default-src': '*' } }, SB],
    ['font-src * data: blob:', { weaken: { 'font-src': '* data: blob:' } }, SB],
    ['media-src * data: blob:', { weaken: { 'media-src': '* data: blob:' } }, SB],
    ["object-src *; form-action *; manifest-src * (no canary of their own)", { weaken: { 'object-src': '*', 'form-action': '*', 'manifest-src': '*' } }, SB],
    ['F framed without sandbox', {}, null],
    ['F framed sandbox="allow-scripts allow-forms allow-same-origin"', {}, `${SB} allow-same-origin`],
    ['no guard, F framed without sandbox', { guard: false }, null],
    ['no guard, F framed sandbox="allow-scripts allow-forms allow-same-origin"', { guard: false }, `${SB} allow-same-origin`],
    ["C's attribute + allow-same-origin, F framed as designed", { cAttr: 'allow-scripts allow-forms allow-orientation-lock allow-same-origin' }, SB],
    ["C's attribute + allow-same-origin, no guard, F framed without sandbox", { guard: false, cAttr: 'allow-scripts allow-forms allow-orientation-lock allow-same-origin' }, null],
    ["the worker's allowlist step skipped", { c: { allowlist: false } }, SB],
];

async function runEngine(name) {
    const srv = await startServer();
    const L = srv.local;
    const REF = servedFile();
    srv.route('/host.html', { headers: HTML, body: hostPage(REF.cHash) });
    const files = MUTANTS.map(([label, opts, attrs], i) => {
        const f = servedFile(opts);
        srv.route(`/m${i}.html`, { headers: HTML, body: f.html });
        return { label, attrs, path: `/m${i}.html`, hash: f.cHash };
    });
    const browser = await ENGINES[name].launch();
    emitRun('q2', name, browser);
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${L}/host.html`);
    for (const { label, attrs, path, hash } of files) {
        const r = await page.evaluate(([u, a, h]) => window.start(u, { attrs: a, expectHash: h, timeout: 5000 }), [path, attrs, hash]);
        const refused = r.decision && r.decision.refused ? r.decision.refused : [];
        const v = r.verdict;
        emit('q2.mutant', {
            engine: name, case: label, end: r.end, hello: r.hello, loadsLength: r.loads.map((l) => l.length),
            gatesTripped: refused.filter((x) => !/policy|started|hash/.test(x)),
            policyTripped: refused.filter((x) => /policy|started/.test(x)),
            C: v && { gates: v.C.gates, check: v.C.check, loads: v.C.loads }, W: v && { started: v.W.started, gates: v.W.gates, check: v.W.check, loads: v.W.loads },
            foreignTexts: v ? [...new Set([...(v.C.events || []), ...((v.W && v.W.events) || [])].map((e) => e.policy).filter((p) => p !== '(the meta, exact)').map((p) => p.slice(0, 120)))] : [],
        });
        await sleep(150);
    }
    await browser.close();
}

for (const name of process.argv.slice(2).filter((a) => a in ENGINES)) {
    try { await runEngine(name); } catch (e) { emit('q2.error', { engine: name, error: String(e).slice(0, 400) }); }
}
process.exit(0);
