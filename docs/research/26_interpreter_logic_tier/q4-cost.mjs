// Research 26, Q4: cost. Startup (cold: from the bytes to a context that has evaluated something; warm: a new instance
// from the compiled module, and a new context in a live runtime), the time to a worker's first message (a native worker
// and the interpreter's bundle), and speed: the same function source natively in the worker and inside the interpreter
// (lib.mjs, BENCH), and one "user adds a todo" turn of examples/sealed-app/app.js with stubbed host functions.
// Each run is a fresh page and worker; the load guard waits for a 1-minute load average under 2 (up to 10 minutes).
//   INTERP_DIR=… bun docs/research/26_interpreter_logic_tier/q4-cost.mjs <engine> [runs]
import { BENCH, emit, engineArgs, launch, loadavg, runJob, waitForQuiet } from './lib.mjs';
import { APP_SOURCE, startServer } from './server.mjs';

const runs = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 5);
const server = await startServer();
for (const engine of engineArgs()) {
    const { browser, version, close } = await launch(engine);
    try {
        for (let run = 0; run < runs; run++) {
            await waitForQuiet(2, `${engine} run ${run}`);
            const page = await browser.newPage();
            const native = await runJob(page, server.origin, { bundle: 'native.js', job: { name: 'none' } });
            const nativeSpawnMs = native.events.find((e) => e.type === 'worker-started')?.spawnMs;
            for (const bundle of ['worker-wasm.min.js', 'worker-asmjs.min.js']) {
                const load = loadavg();
                const v = bundle.startsWith('worker-wasm') ? 'sealed-wue' : 'sealed';
                const { event, events } = await runJob(page, server.origin, { v, bundle, extra: 'cost.js', job: { name: 'cost', bench: BENCH, app: APP_SOURCE(), turns: 100 }, timeoutMs: 180000 });
                const spawnMs = events.find((e) => e.type === 'worker-started')?.spawnMs;
                emit('q4', { engine, version, run, bundle, nativeSpawnMs, spawnMs, ...event, type: undefined, load, date: new Date().toISOString() });
            }
            await page.close();
        }
    } finally {
        await close();
    }
}
await server.close();
