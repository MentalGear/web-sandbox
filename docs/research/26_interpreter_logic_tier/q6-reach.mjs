// Research 26, Q6 and Q7: what content can reach from inside the interpreter, with no host function installed, and what
// it lacks of the sealed worker's allowlist; and the boundary a logic tier would add (what crosses when the content hands
// a host function a huge string, a cyclic object, getters, a Proxy).
//
// The host page's policy is `script-src 'self' <view hash> 'wasm-unsafe-eval' 'report-sample'; worker-src blob:;
// report-uri /__report`, so a refused eval anywhere below it is reported to this server. Steps, each on a fresh page:
//   1. reach:    the interpreter's globals, `eval`/`Function`/`import()` inside it; no native eval anywhere. Reports
//                and violation events are collected after it: none is expected.
//   2. control:  native eval in the worker (the load job) and in the view: refused, and reported where the engine
//                reports (the positive control that the report path works on this page).
//   3. boundary: worker-runtime.mjs, the boundary job.
//   INTERP_DIR=… bun docs/research/26_interpreter_logic_tier/q6-reach.mjs <engine>
import { STRICT_WORKER_GLOBALS, workerGlobalsFor } from '../../../src/lib/worker-globals.ts';
import { emit, engineArgs, launch, loadavg, runJob, sleep } from './lib.mjs';
import { startServer } from './server.mjs';

const SEALED_ALLOWLIST = workerGlobalsFor(STRICT_WORKER_GLOBALS, false);
const server = await startServer();
const violationsOf = (events) => events.filter((e) => e.type === 'host-violation' || e.type === 'view-violation').map((e) => `${e.type} ${e.directive} ${e.blocked} ${e.sample ?? ''}`);

for (const engine of engineArgs()) {
    const { browser, version, close } = await launch(engine);
    try {
        server.reports.length = 0;
        let page = await browser.newPage();
        const reach = await runJob(page, server.origin, { h: 'report', v: 'sealed-wue', job: { name: 'reach', allowlist: SEALED_ALLOWLIST, control: false } });
        await sleep(1500);
        emit('q6.reach', { engine, version, ...reach.event, type: undefined, documentViolations: violationsOf(reach.events), reports: server.reports.slice(), allowlistSize: SEALED_ALLOWLIST.length, load: loadavg(), date: new Date().toISOString() });
        await page.close();

        server.reports.length = 0;
        page = await browser.newPage();
        const control = await runJob(page, server.origin, { h: 'report', v: 'sealed-wue', job: { name: 'load' } });
        await page.evaluate(() => window.view('eval'));
        const viewEval = await page.evaluate(() => window.waitFor('view-eval', 5000));
        await sleep(1500);
        const events = await page.evaluate(() => window.events.filter((e) => e.type !== 'done'));
        emit('q6.control', { engine, version, workerNativeEval: control.event.nativeEval, workerViolations: control.event.workerViolations, viewEval: viewEval.result, documentViolations: violationsOf(events), reports: server.reports.map((r) => r.slice(0, 400)), load: loadavg() });
        await page.close();

        page = await browser.newPage();
        const boundary = await runJob(page, server.origin, { v: 'sealed-wue', job: { name: 'boundary' }, timeoutMs: 120000 });
        emit('q6.boundary', { engine, version, ...boundary.event, type: undefined, load: loadavg(), date: new Date().toISOString() });
        await page.close();
    } finally {
        await close();
    }
}
await server.close();
