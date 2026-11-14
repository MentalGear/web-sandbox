// Research 26, Q3: memory. The interpreter's own limit (JS_SetMemoryLimit) and a maximum on the WebAssembly memory (the
// glue imports its memory, so the worker passes one it made with a `maximum`). The content allocates past it: what does
// the content see (a catchable error), the interpreter (still usable?), the worker (an abort?), and the host page (its
// longest stall while it happens, through test/e2e/host-share.ts, and whether it still answers)?
//   INTERP_DIR=… bun docs/research/26_interpreter_logic_tier/q3-memory.mjs <engine>
import { lag, startLag } from '../../../test/e2e/host-share.ts';
import { emit, engineArgs, launch, loadavg, runJob } from './lib.mjs';
import { startServer } from './server.mjs';

const CASES = [
    { limitMiB: 64, wasmMaxMiB: 0, content: 'small' },
    { limitMiB: 64, wasmMaxMiB: 0, content: 'arrays' },
    { limitMiB: 64, wasmMaxMiB: 0, content: 'string' },
    { limitMiB: 64, wasmMaxMiB: 0, content: 'uncaught' },
    { limitMiB: 0, wasmMaxMiB: 64, content: 'arrays' },
    { limitMiB: 0, wasmMaxMiB: 64, content: 'string' },
    { limitMiB: 64, wasmMaxMiB: 128, content: 'arrays' },
    { limitMiB: 0, wasmMaxMiB: 0, content: 'arrays' },
];

const server = await startServer();
for (const engine of engineArgs()) {
    const { browser, version, close } = await launch(engine);
    try {
        for (const c of CASES) {
            const page = await browser.newPage();
            const load = loadavg();
            const { event, events } = await runJob(page, server.origin, { job: { name: 'memory', ...c }, timeoutMs: 120000, onPage: startLag });
            const hostStallMs = await lag(page).catch((e) => `host page did not answer: ${e.message}`);
            const hostAlive = await page.evaluate(() => 1 + 1).then((v) => v === 2, () => false);
            emit('q3', { engine, version, ...c, ...event, type: event.type === 'done' ? undefined : event.type, workerErrors: events.filter((e) => e.type === 'worker-error').map((e) => e.message), hostStallMs, hostAlive, load, date: new Date().toISOString() });
            await page.close();
        }
    } finally {
        await close();
    }
}
await server.close();
