// Shared helpers for the research 26 probes: engines, the browser's process tree, the load guard, small statistics, and
// one call that runs a job in the probe topology (host page -> sandboxed srcdoc view -> blob: worker -> interpreter).
import { readdirSync, readFileSync } from 'node:fs';
import { chromium, firefox, webkit } from 'playwright';

export const ENGINES = { chromium, firefox, webkit };

/** Engines named on the command line, or all three. */
export function engineArgs(argv = process.argv.slice(2)) {
    const named = argv.filter((a) => a in ENGINES);
    return named.length ? named : ['chromium', 'firefox', 'webkit'];
}

export function load1() {
    try { return Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]); } catch { return 0; }
}
export function loadavg() {
    try { return readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' '); } catch { return 'n/a'; }
}

/** Waits (up to 10 minutes) while the 1-minute load average is above `limit`. The machine is shared. */
export async function waitForQuiet(limit = 2, label = '') {
    for (let i = 0; i < 120 && load1() > limit; i++) {
        console.error(`load ${load1()} > ${limit}, waiting ${label}`);
        await sleep(5000);
    }
    return load1();
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const range = (xs) => `${Math.min(...xs)}–${Math.max(...xs)}`;

/** One JSON line per result, prefixed with a tag, so the README's tables can be rebuilt with grep. */
export function emit(tag, obj) { console.log(`${tag} ${JSON.stringify(obj)}`); }

/**
 * A browser launched as a server, so its process id is known (the CPU of its process tree is read from /proc), with the
 * proxy variables left out of its environment (they can fail WebKit's page loads: research 24).
 */
export async function launch(engine) {
    const env = { ...process.env };
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy']) delete env[name];
    const server = await ENGINES[engine].launchServer({ headless: true, env });
    const browser = await ENGINES[engine].connect(server.wsEndpoint());
    return { browser, pid: server.process().pid, version: browser.version(), close: async () => { await browser.close().catch(() => {}); await server.close().catch(() => {}); } };
}

/** utime + stime, in clock ticks (10 ms), of a process and everything below it (research 24, M4). */
export function treeTicks(root) {
    const parent = new Map();
    const ticks = new Map();
    for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
            const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
            const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            parent.set(+entry, +rest[1]);
            ticks.set(+entry, +rest[11] + +rest[12]);
        } catch { /* the process ended */ }
    }
    let sum = 0;
    for (const [pid, t] of ticks) {
        let p = pid;
        while (p && p !== root && p !== 1) p = parent.get(p);
        if (p === root) sum += t;
    }
    return sum;
}

/** Cores the tree kept busy, in consecutive windows of `windowMs` over `totalMs` ("1.00" is one core). */
export async function cpuWindows(pid, windowMs, totalMs) {
    const out = [];
    let before = treeTicks(pid);
    for (let elapsed = 0; elapsed < totalMs; elapsed += windowMs) {
        await sleep(windowMs);
        const after = treeTicks(pid);
        out.push(Number(((after - before) / (windowMs / 10)).toFixed(2)));
        before = after;
    }
    return out;
}

/** The time (ms) from the first window until every later window is under `threshold` cores; null if never. */
export function idleFrom(windows, windowMs, threshold = 0.3) {
    for (let i = 0; i < windows.length; i++) if (windows.slice(i).every((cores) => cores < threshold)) return i * windowMs;
    return null;
}

/** The benchmarks of Q4: the same source runs natively in the worker and inside the interpreter. */
export const BENCH = {
    loop: 'function () { let s = 0; for (let i = 0; i < 3e6; i++) s = (s + i * i) % 1000003; return s; }',
    render: "function () { const todos = []; for (let i = 0; i < 1000; i++) todos.push({ text: 'todo ' + i, done: i % 3 === 0 }); let total = 0; for (let r = 0; r < 100; r++) { const html = todos.map((todo, i) => `<li id=\"todo-${i}\"><input type=\"checkbox\" id=\"done-${i}\"${todo.done ? ' checked' : ''}> <span id=\"text-${i}\"></span></li>`).join(''); total += html.length; } return total; }",
    json: "function () { const todos = []; for (let i = 0; i < 1000; i++) todos.push({ text: 'todo ' + i, done: i % 3 === 0 }); let n = 0; for (let r = 0; r < 100; r++) n += JSON.parse(JSON.stringify(todos)).length; return n; }",
};

/**
 * Opens the host page with host policy `h` and view policy `v`, starts a worker from `bundle` with `job`, and waits for
 * an event of type `until` (or `timeoutMs`); `onPage(page)` runs once the host page is loaded, before the worker starts.
 * Returns the event and every event so far.
 */
export async function runJob(page, origin, { h = 'none', v = 'sealed', bundle = 'worker-wasm.min.js', job, extra = '', until = 'done', timeoutMs = 60000, onPage }) {
    await page.goto(`${origin}/host?h=${h}&v=${v}`);
    if (onPage) await onPage(page);
    await page.evaluate((args) => window.startJob(args), { bundle, wasm: bundle.startsWith('worker-wasm'), job, extra });
    const event = await page.evaluate(([type, ms]) => window.waitFor(type, ms), [until, timeoutMs]);
    const events = await page.evaluate(() => window.events.map((e) => (e.type === 'done' ? { type: 'done' } : e)));
    return { event, events };
}
