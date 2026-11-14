// Research 26, Q1: does the interpreter load under the policies sealed mode has? The host page's script-src (a) absent,
// (b) without 'wasm-unsafe-eval', (c) with it; the view's own sealed policy with and without the keyword; the WebAssembly
// build and the pure-JavaScript (asm.js) build of the same interpreter.
//   INTERP_DIR=… bun docs/research/26_interpreter_logic_tier/q1-policy.mjs [chromium|firefox|webkit]
import { emit, engineArgs, launch, loadavg } from './lib.mjs';
import { runJob } from './lib.mjs';
import { startServer } from './server.mjs';

const server = await startServer();
for (const engine of engineArgs()) {
    const { browser, version, close } = await launch(engine);
    try {
        for (const bundle of ['worker-wasm.min.js', 'worker-asmjs.min.js']) {
            for (const h of ['none', 'nokw', 'kw']) {
                for (const v of ['sealed', 'sealed-wue']) {
                    const page = await browser.newPage();
                    const { event, events } = await runJob(page, server.origin, { h, v, bundle, job: { name: 'load' }, timeoutMs: 20000 });
                    const hostViolations = events.filter((e) => e.type === 'host-violation' || e.type === 'view-violation');
                    emit('q1', { engine, version, bundle, host: h, view: v, runs: event.result === 42, result: event.result ?? null, error: event.error ?? (event.type === 'timeout' ? 'timeout' : null), ms: event.ms, nativeEval: event.nativeEval, workerViolations: event.workerViolations, documentViolations: hostViolations.map((e) => `${e.type} ${e.directive} ${e.blocked}`), workerErrors: events.filter((e) => e.type === 'worker-error').map((e) => e.message), load: loadavg(), date: new Date().toISOString() });
                    await page.close();
                }
            }
        }
    } finally {
        await close();
    }
}
await server.close();
