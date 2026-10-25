import { test, expect, type Browser, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * Research 24: WebAssembly in a sealed (no-network) strict view, and whether ending the sandbox ends a looping worker.
 * Platform behaviour only: no library code runs. On demand:
 *   WEB_SANDBOX_MEASURE=1 bunx playwright test docs/research/24_sealed_mode/measure.spec.ts --project=chromium --workers=1
 * (then firefox, webkit; one engine at a time; check `cut -d' ' -f1 /proc/loadavg` is under 6 first). Each test prints
 * `MEASURED {json}` lines and attaches them as annotations; README.md holds the tables made from them.
 *
 * The page is built as the strict view is: a host page (served by this file, so its policy is a real response header)
 * puts a `sandbox="allow-scripts"` `srcdoc` frame in the page (an opaque origin) whose own <meta> policy admits one inline
 * script by its hash and `worker-src blob:`, and that script makes a `blob:` worker.
 *   M1  the view's `script-src` with and without `'wasm-unsafe-eval'`, the host page with no policy: which WebAssembly
 *       paths compile and which instantiate;
 *   M2  the host page's inherited `script-src`;
 *   M3  timers, shared memory and memory in the worker;
 *   M4  the browser's CPU after the frame is removed (and after `Worker.terminate()`), with a JS loop, a pure WebAssembly
 *       loop and a WebAssembly loop that calls a JS import each turn in the worker. The CPU is the browser's whole process
 *       tree, read from /proc in one-second windows ("1.00" is one core), so M4 skips where there is no /proc.
 * The assertions are the facts that are the same on every engine; what differs per engine is only recorded, so this file
 * branches on no engine.
 */
test.skip(!process.env.WEB_SANDBOX_MEASURE, 'a measurement, run on demand (WEB_SANDBOX_MEASURE=1)');
test.describe.configure({ mode: 'serial' });

/** A module with `add(i32, i32) -> i32`. */
const ADD = [0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11];
/** A module that defines and exports a shared memory. */
const SHARED_MEMORY = [0, 97, 115, 109, 1, 0, 0, 0, 5, 4, 1, 3, 1, 1, 7, 5, 1, 1, 109, 2, 0];
/** `spin()`: `loop br 0 end`, no import. */
const SPIN = [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 8, 1, 4, 115, 112, 105, 110, 0, 0, 10, 9, 1, 7, 0, 3, 64, 12, 0, 11, 11];
/** `spin()`: the same loop, calling the import `e.f` each turn. */
const SPIN_IMPORT = [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 2, 7, 1, 1, 101, 1, 102, 0, 0, 3, 2, 1, 0, 7, 8, 1, 4, 115, 112, 105, 110, 0, 1, 10, 11, 1, 9, 0, 3, 64, 16, 0, 12, 0, 11, 11];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
const record = (label: string, value: unknown) => {
    const line = JSON.stringify({ [label]: value });
    console.log(`MEASURED ${line}`);
    test.info().annotations.push({ type: 'measured', description: line });
};

// ---- M1 to M3: one worker runs every path and reports what each did -------------------------------------------------

const workerCode = (full: boolean) => `
const ADD = new Uint8Array(${JSON.stringify(ADD)});
const SHM = new Uint8Array(${JSON.stringify(SHARED_MEMORY)});
const out = {};
const violations = [];
self.addEventListener('securitypolicyviolation', e => violations.push(e.violatedDirective + ' ' + e.blockedURI));
const t = async (k, f) => { try { out[k] = 'ok ' + String(await f()); } catch (e) { out[k] = 'ERR ' + (e && e.name) + ': ' + String(e && e.message).slice(0, 90); } };
const kind = v => Object.prototype.toString.call(v);
const wasm = bytes => new Response(bytes, { headers: { 'content-type': 'application/wasm' } });
(async () => {
  let mod = null;
  await t('Module', () => { mod = new WebAssembly.Module(ADD); return 'compiled'; });
  await t('compile', async () => { await WebAssembly.compile(ADD); return 'compiled'; });
  await t('compileStreaming', async () => { await WebAssembly.compileStreaming(wasm(ADD)); return 'compiled'; });
  await t('validate', () => WebAssembly.validate(ADD));
  await t('Instance(Module)', () => new WebAssembly.Instance(mod).exports.add(2, 3));
  await t('instantiate(Module)', async () => (await WebAssembly.instantiate(mod)).exports.add(2, 3));
  await t('instantiate(bytes)', async () => (await WebAssembly.instantiate(ADD)).instance.exports.add(2, 3));
  await t('instantiateStreaming', async () => (await WebAssembly.instantiateStreaming(wasm(ADD))).instance.exports.add(2, 3));
  await t('eval', () => eval('1+1'));
  await t('Function', () => new Function('return 2')());
  out.crossOriginIsolated = String(self.crossOriginIsolated);
  out.SharedArrayBuffer = typeof SharedArrayBuffer;
  const shared = () => new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  await t('sharedMemory', () => kind(shared().buffer));
  await t('moduleSharedMemory', async () => kind((await WebAssembly.instantiate(SHM)).instance.exports.m.buffer));
  await t('postMessage(MessageChannel)', async () => { const c = new MessageChannel(); const p = new Promise(r => { c.port2.onmessage = e => r(kind(e.data)); c.port2.onmessageerror = () => r('messageerror'); }); c.port1.postMessage(shared().buffer); return await p; });
  await t('structuredClone', () => kind(structuredClone(shared().buffer)));
  await t('postMessage(parent)', () => { postMessage({ probe: shared().buffer }); return 'posted'; });
  if (${full}) {
    await t('memory1GiB', () => new WebAssembly.Memory({ initial: 16384 }).buffer.byteLength);
    await t('memory4GiB', () => new WebAssembly.Memory({ initial: 65536 }).buffer.byteLength);
    await t('arrayBuffer1GiB', () => new ArrayBuffer(2 ** 30).byteLength);
    let min = Infinity, last = performance.now(); const end = last + 50;
    while (true) { const n = performance.now(); if (n !== last) { min = Math.min(min, n - last); last = n; } if (n > end) break; }
    out.performanceNowStepMs = Number(min.toFixed(4));
  }
  await new Promise(r => setTimeout(r, 100));
  out.workerViolations = violations.join(' | ') || 'none';
  postMessage(out);
})();
`;

/** The view's one inline script (hashed): makes the worker, relays what it reports to the host page. */
const viewScript = (full: boolean) => `
  const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerCode(full))}], { type: 'text/javascript' })));
  w.onmessage = e => {
    if (e.data && e.data.probe) { parent.postMessage({ note: 'the view received a ' + Object.prototype.toString.call(e.data.probe) }, '*'); return; }
    setTimeout(() => parent.postMessage({ worker: e.data, origin: self.origin }, '*'), 50);
  };
  w.onmessageerror = () => parent.postMessage({ note: 'the view got a messageerror' }, '*');
  w.onerror = e => parent.postMessage({ error: 'worker error' }, '*');
`;

interface Config {
    name: string;
    /** The view's `script-src` extra sources. */
    view: string;
    /** The host page's `Content-Security-Policy` header, from the view script's hash, or none. */
    host: ((hash: string) => string) | null;
    /** Whether a WebAssembly module is expected to run (compile, instantiate and call), on every engine. */
    runs: boolean;
    full?: boolean;
}
const WUE = "'wasm-unsafe-eval'";
const CONFIGS: Config[] = [
    { name: 'view hash only, host none', view: '', host: null, runs: false },
    { name: 'view hash + wasm-unsafe-eval, host none', view: WUE, host: null, runs: true, full: true },
    { name: 'view hash + wasm-unsafe-eval, host script-src without it', view: WUE, host: h => `script-src 'self' ${h}; worker-src blob:`, runs: false },
    { name: 'view hash + wasm-unsafe-eval, host script-src with it', view: WUE, host: h => `script-src 'self' ${h} ${WUE}; worker-src blob:`, runs: true },
    { name: 'view hash + wasm-unsafe-eval, host img-src only', view: WUE, host: () => "img-src 'self'", runs: true },
];

let server: Server;
let origin = '';

test.beforeAll(async () => {
    server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const config = CONFIGS[Number(url.searchParams.get('c'))];
        const full = !!config?.full;
        const script = viewScript(full);
        const hash = sha(script);
        if (url.pathname === '/host' && config) {
            const headers: Record<string, string> = { 'content-type': 'text/html' };
            if (config.host) headers['content-security-policy'] = config.host(hash);
            res.writeHead(200, headers).end(`<!doctype html><body><script src="/host.js?c=${url.searchParams.get('c')}"></script>`);
        } else if (url.pathname === '/host.js' && config) {
            const view = `<!doctype html><meta http-equiv="Content-Security-Policy" content="script-src ${hash} ${config.view}; worker-src blob:"><script>${script}</script>`;
            res.writeHead(200, { 'content-type': 'text/javascript' }).end(`window.notes = [];
                window.result = new Promise(r => addEventListener('message', e => { if (e.data && e.data.note) window.notes.push(e.data.note); else r(e.data); }));
                const f = document.createElement('iframe'); f.sandbox = 'allow-scripts'; f.srcdoc = ${JSON.stringify(view)}; document.body.append(f); window.f = f;`);
        } else if (url.pathname === '/loop' || url.pathname === '/loop.js') {
            const loop = loopPage(url.searchParams.get('k') ?? 'js');
            if (url.pathname === '/loop') res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><body><script src="/loop.js?k=${url.searchParams.get('k')}"></script>`);
            else res.writeHead(200, { 'content-type': 'text/javascript' }).end(`window.events = [];
                addEventListener('message', e => window.events.push(e.data));
                const f = document.createElement('iframe'); f.sandbox = 'allow-scripts'; f.srcdoc = ${JSON.stringify(loop)}; document.body.append(f); window.f = f;`);
        } else res.writeHead(404).end('no');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => { server.close(); });

async function run(page: Page, index: number) {
    await page.goto(`${origin}/host?c=${index}`);
    const result = await Promise.race([page.evaluate(() => (window as any).result), sleep(10000).then(() => ({ error: 'timeout' }))]) as { worker?: Record<string, string>; error?: string };
    const notes = await page.evaluate(() => (window as any).notes as string[]);
    return { ...result, notes };
}

const PATHS = ['Instance(Module)', 'instantiate(Module)', 'instantiate(bytes)', 'instantiateStreaming'];

CONFIGS.forEach((config, index) => {
    test(`M1 to M3: ${config.name}`, async ({ page }) => {
        test.setTimeout(60000);
        const result = await run(page, index);
        record(config.name, { ...result.worker, notes: result.notes });
        const worker = result.worker!;
        expect(result.error, 'the worker reported').toBeUndefined();
        expect(worker, 'the worker reported').toBeTruthy();
        // the same on every engine: WebAssembly runs exactly when every policy in the list admits it
        for (const path of PATHS) {
            if (config.runs) expect(worker[path], path).toBe('ok 5');
            else expect(worker[path], path).toMatch(/^ERR/);
        }
        if (config.runs) {
            expect(worker.compile).toBe('ok compiled');
            expect(worker.compileStreaming).toBe('ok compiled');
        }
        // eval and new Function stay refused, with the keyword
        expect(worker.eval).toMatch(/^ERR EvalError/);
        expect(worker.Function).toMatch(/^ERR EvalError/);
        // not cross-origin isolated: no SharedArrayBuffer global; shared memory still makes one, and none can leave the thread
        expect(worker.crossOriginIsolated).toBe('false');
        expect(worker.SharedArrayBuffer).toBe('undefined');
        expect(worker.sharedMemory).toBe('ok [object SharedArrayBuffer]');
        expect(worker['postMessage(MessageChannel)']).not.toBe('ok [object SharedArrayBuffer]');
        expect(result.notes.join(' ')).not.toContain('SharedArrayBuffer');
        if (config.runs) expect(worker.moduleSharedMemory).toBe('ok [object SharedArrayBuffer]');
        if (config.full) {
            expect(worker.memory4GiB).toBe('ok 4294967296');
            expect(Number(worker.performanceNowStepMs)).toBeGreaterThanOrEqual(0.1);
        }
    });
});

// ---- M4: does ending the sandbox stop a looping worker? ---------------------------------------------------------------

type Loop = 'js' | 'wasm' | 'wasm-import';
const workerFor = (kind: Loop) => kind === 'wasm-import'
    ? `let n = 0; const m = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(SPIN_IMPORT)})), { e: { f: () => { n++; } } }); postMessage('spinning'); m.exports.spin();`
    : kind === 'wasm'
        ? `const m = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(SPIN)}))); postMessage('spinning'); m.exports.spin();`
        : `postMessage('spinning'); for (;;) {}`;
function loopPage(kind: string) {
    const script = `const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerFor(kind as Loop))}], { type: 'text/javascript' })));
        w.onmessage = e => parent.postMessage(e.data, '*');
        addEventListener('message', e => { if (e.data === 'terminate') { w.terminate(); parent.postMessage('terminated', '*'); } });`;
    return `<!doctype html><meta http-equiv="Content-Security-Policy" content="script-src ${sha(script)} ${WUE}; worker-src blob:"><script>${script}</script>`;
}

/** utime + stime, in clock ticks, of a process and everything below it. */
function treeTicks(root: number): number {
    const parent = new Map<number, number>(), ticks = new Map<number, number>();
    for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
            const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
            const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            parent.set(+entry, +rest[1]!); ticks.set(+entry, +rest[11]! + +rest[12]!);
        } catch { /* the process ended */ }
    }
    let sum = 0;
    for (const [pid, t] of ticks) {
        let p: number | undefined = pid;
        while (p && p !== root && p !== 1) p = parent.get(p);
        if (p === root) sum += t;
    }
    return sum;
}
/** Cores the tree kept busy over `ms` (the clock tick is 10 ms). */
async function busy(pid: number, ms: number) {
    const before = treeTicks(pid);
    await sleep(ms);
    return Number(((treeTicks(pid) - before) / (ms / 10)).toFixed(2));
}

const SAMPLES = 12;
async function measureLoop(page: Page, browser: Browser, pid: number, kind: Loop, terminate: boolean) {
    const loadAtStart = readFileSync('/proc/loadavg', 'utf8').split(' ')[0];
    await page.goto(`${origin}/loop?k=${kind}`);
    const started = await page.waitForFunction(() => (window as any).events?.includes('spinning'), undefined, { timeout: 8000 })
        .then(() => 'spinning', () => 'timeout');
    await sleep(500);
    const whileLooping = await busy(pid, 1500);
    if (terminate) {
        await page.evaluate(() => (window as any).f.contentWindow.postMessage('terminate', '*'));
        await sleep(300);
    }
    await page.evaluate(() => (window as any).f.remove());
    const afterRemoval: number[] = [];
    for (let i = 0; i < SAMPLES; i++) afterRemoval.push(await busy(pid, 1000));
    const frameGone = await page.evaluate(() => !document.querySelector('iframe'));
    await page.close();
    await sleep(1000);
    const afterPageClose = await busy(pid, 1000);
    // seconds until the tree is idle for good, counted from the removal (null: never, in the window)
    const idleFrom = afterRemoval.findIndex((_, i) => afterRemoval.slice(i).every(cores => cores < 0.2));
    return { loop: kind, terminateFirst: terminate, started, whileLooping, frameGone, afterRemoval: afterRemoval.join(' '), secondsUntilIdle: idleFrom < 0 ? null : idleFrom, afterPageClose, version: browser.version(), loadAtStart };
}

const CASES: { kind: Loop; terminate: boolean }[] = [
    { kind: 'js', terminate: false },
    { kind: 'wasm', terminate: false },
    { kind: 'wasm-import', terminate: false },
    { kind: 'wasm', terminate: true },
];

CASES.forEach(({ kind, terminate }) => {
    test(`M4: a ${kind} loop${terminate ? ', Worker.terminate() first' : ''}, then the frame is removed`, async ({ page: fixturePage }) => {
        test.skip(!existsSync('/proc/self/stat'), 'reads the CPU of the browser\'s process tree from /proc');
        test.setTimeout(90000);
        // the browser is launched here, not by the runner, because the runner does not give its pid
        const type = fixturePage.context().browser()!.browserType();
        const launched = await type.launchServer();
        const browser = await type.connect(launched.wsEndpoint());
        try {
            const result = await measureLoop(await browser.newPage(), browser, launched.process().pid!, kind, terminate);
            record(`M4 ${kind}${terminate ? ' terminate' : ''}`, result);
            expect(result.started).toBe('spinning');
            expect(result.whileLooping, 'the loop keeps a core busy').toBeGreaterThan(0.5);
            expect(result.frameGone).toBe(true);
            // the same on every engine: a loop that is JS, or calls a JS import each turn, ends with the frame. A pure
            // WebAssembly loop is recorded only (README.md, "The WebKit residual").
            if (kind !== 'wasm') expect(result.secondsUntilIdle, `idle after removal (cores a second: ${result.afterRemoval})`).not.toBeNull();
        } finally {
            await browser.close();
            await launched.close();
        }
    });
});
