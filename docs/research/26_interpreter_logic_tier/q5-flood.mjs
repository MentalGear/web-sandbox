// Research 26, Q5: research 19's rejection flood, inside the interpreter. Two unhandled rejections with a 16 Mi-character
// Error as the reason on every tick of a 0 ms interval: natively in the worker (research 19's flood, the control), and
// inside the interpreter, where the worker's own interval evaluates `tick()` and runs the interpreter's pending jobs
// ('interp' shares one 16 Mi string, as research 19 did; 'interp-fresh' makes a new one for every rejection). The host
// page's busy share is measured through test/e2e/host-share.ts (the best of N windows against the page's idle baseline).
//   INTERP_DIR=… bun docs/research/26_interpreter_logic_tier/q5-flood.mjs <engine> [runs] [native|interp|interp-fresh …]
import { busyShare, describeShare } from '../../../test/e2e/host-share.ts';
import { emit, engineArgs, launch, loadavg, waitForQuiet } from './lib.mjs';
import { startServer } from './server.mjs';

const runs = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 2);
const KINDS = ['native', 'interp', 'interp-fresh'];
const named = process.argv.slice(2).filter((a) => KINDS.includes(a));
const kinds = named.length ? named : KINDS;
const server = await startServer();
for (const engine of engineArgs()) {
    const { browser, version, close } = await launch(engine);
    try {
        for (let run = 0; run < runs; run++) {
            for (const kind of kinds) {
                await waitForQuiet(3, `${engine} ${kind}`);
                const load = loadavg();
                const page = await browser.newPage();
                await page.goto(`${server.origin}/host?v=sealed-wue`);
                await page.evaluate(() => window.waitFor('view-ready', 10000));
                const share = await busyShare(page, async () => {
                    await page.evaluate((k) => window.startJob({ bundle: 'worker-wasm.min.js', wasm: true, job: { name: 'flood', kind: k } }), kind);
                    await page.evaluate(() => window.waitFor('flooding', 20000));
                });
                const progress = await page.evaluate(() => window.events.find((e) => e.type === 'flood-progress') ?? null);
                const errors = await page.evaluate(() => window.events.filter((e) => e.type === 'worker-error' || (e.type === 'done' && e.error)));
                emit('q5', { engine, version, run, kind, busy: Math.round(share.busy * 100), meanBusy: Math.round(share.meanBusy * 100), share: describeShare(share), progress, errors, load, date: new Date().toISOString() });
                await page.close();
            }
        }
    } finally {
        await close();
    }
}
await server.close();
