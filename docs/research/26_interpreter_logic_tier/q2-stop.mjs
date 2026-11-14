// Research 26, Q2: can the host stop content that runs inside the interpreter?
//
//   cpu       the content loops for ever on one operation (worker-runtime.mjs, OPS); the host page then has the view call
//             Worker.terminate() (and removes the frame 6 s later), or removes the frame alone. The CPU of the browser's
//             whole process tree is read from /proc in 100 ms windows (research 24, M4); "idle" is the first window after
//             which every window is under 0.3 cores. With the interpreter's interrupt handler wired (it calls a
//             JavaScript function of the worker every time QuickJS polls for an interrupt) and not wired.
//   watchdog  no terminate(): the interrupt handler returns true once a deadline has passed; how long after the
//             deadline control comes back (3 runs), and each operation's own duration (3 runs, unwired).
//
//   INTERP_DIR=… bun docs/research/26_interpreter_logic_tier/q2-stop.mjs <engine> [cpu|watchdog] [op …]
import { cpuWindows, emit, engineArgs, idleFrom, launch, loadavg, runJob, sleep } from './lib.mjs';
import { startServer } from './server.mjs';

const OPS = ['loop', 'regex', 'sortArray', 'sortTyped', 'stringify', 'parse', 'repeat', 'join', 'bigintToString'];
const args = process.argv.slice(2);
const parts = args.filter((a) => a === 'cpu' || a === 'watchdog');
const onlyOps = args.filter((a) => OPS.includes(a));
const ops = onlyOps.length ? onlyOps : OPS;
const WINDOW = 100;

async function cpuCase(browser, pid, origin, { op, wired, how }) {
    const page = await browser.newPage();
    const load = loadavg();
    const { event } = await runJob(page, origin, { bundle: 'worker-wasm.min.js', job: { name: 'stop', op, wired }, until: 'spinning', timeoutMs: 90000 });
    if (event.type !== 'spinning') { await page.close(); return { op, wired, how, error: JSON.stringify(event).slice(0, 300) }; }
    await sleep(500);
    const [whileLooping] = await cpuWindows(pid, 1000, 1000);
    let afterStop;
    let afterRemoval = [];
    if (how === 'terminate') {
        await page.evaluate(() => window.view('terminate'));
        afterStop = await cpuWindows(pid, WINDOW, 6000);
        await page.evaluate(() => window.frame.remove());
        afterRemoval = await cpuWindows(pid, WINDOW, 3000);
    } else {
        await page.evaluate(() => window.frame.remove());
        afterStop = await cpuWindows(pid, WINDOW, 9000);
    }
    const ended = await page.evaluate(() => window.events.filter((e) => e.type === 'done').map((e) => e.ended ?? e.error));
    await page.close();
    await sleep(800);
    const [afterPageClose] = await cpuWindows(pid, 1000, 1000);
    const idleMs = idleFrom(afterStop, WINDOW);
    return {
        op, wired, how, whileLooping, idleMsAfterStop: idleMs,
        idleAfterRemoval: how === 'terminate' && idleMs === null ? idleFrom(afterRemoval, WINDOW) : undefined,
        afterStop: afterStop.join(' '), afterRemoval: afterRemoval.join(' '), afterPageClose, contentEnded: ended, load,
    };
}

const server = await startServer();
for (const engine of engineArgs(args)) {
    const { browser, pid, version, close } = await launch(engine);
    try {
        if (!parts.length || parts.includes('watchdog')) {
            for (const op of ops) {
                const page = await browser.newPage();
                const load = loadavg();
                const { event } = await runJob(page, server.origin, { bundle: 'worker-wasm.min.js', job: { name: 'watchdog', op, deadlineMs: 1000, reps: 3 }, timeoutMs: 180000 });
                emit('q2.watchdog', { engine, version, ...event, type: undefined, load, date: new Date().toISOString() });
                await page.close();
            }
        }
        if (!parts.length || parts.includes('cpu')) {
            const cases = [];
            for (const op of ops) for (const wired of [false, true]) cases.push({ op, wired, how: 'terminate' });
            for (const op of ops.filter((o) => ['loop', 'sortTyped', 'bigintToString'].includes(o))) for (const wired of [false, true]) cases.push({ op, wired, how: 'remove' });
            for (const c of cases) emit('q2.cpu', { engine, version, ...(await cpuCase(browser, pid, server.origin, c)), date: new Date().toISOString() });
        }
    } finally {
        await close();
    }
}
await server.close();
