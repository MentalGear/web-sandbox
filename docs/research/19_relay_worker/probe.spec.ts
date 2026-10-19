import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, chromium, firefox, webkit, type Page } from '@playwright/test';
import { CANARY_PORT, payload, wrapperDocument, type Opts } from './harness';

/**
 * Research 19: probes for a trusted relay worker (backlog S66; research 18, design 7), measured before building. No
 * library runtime code: harness.ts builds the strict topology with the library's own document builders and policy, and
 * spawns the guest either from the view (today) or from a relay worker the view spawns (proposed).
 *
 * Run: bunx playwright test -c docs/research/19_relay_worker (its own config and server). Skipped under the root config.
 * Every measured value is printed as a `MEASURED <project> <name> <json>` line; the README's tables are made from them.
 */

const log = (project: string, name: string, value: unknown) => console.log(`MEASURED ${project} ${name} ${JSON.stringify(value)}`);

test.beforeEach(({}, testInfo) => {
    test.skip(!testInfo.config.metadata?.relayProbes, 'design probe: run with -c docs/research/19_relay_worker (its own config and server)');
});

// ---- helpers -----------------------------------------------------------------------------------------------------------

async function open(page: Page, coep?: string) {
    await page.goto(`/host.html${coep ? `?coep=${coep}` : ''}`);
}

/** Mounts one environment and posts INIT_VIEW; returns its index. */
async function start(page: Page, opts: Opts, connect: string[] = [], connectBlob = false): Promise<number> {
    const index = await page.evaluate((srcdoc) => (window as any).mount(srcdoc), wrapperDocument(connect, connectBlob));
    await page.evaluate(([i, p]) => (window as any).init(i, p), [index, payload(opts)] as const);
    return index;
}

const waitFor = (page: Page, index: number, type: string, timeout = 10000) =>
    page.evaluate(([i, t, ms]) => (window as any).waitFor(i, t, ms), [index, type, timeout] as const);

/** The first of `types` to arrive on env `index`, as { type, data }, or 'timeout'. */
const firstOf = (page: Page, index: number, types: string[], timeout = 8000) => page.evaluate(([i, list, ms]) => new Promise((resolve) => {
    const env = (window as any).envs[i];
    const started = performance.now();
    const look = () => {
        const found = env.inbox.find((m: any) => m.data && list.includes(m.data.type));
        if (found) return resolve(found.data);
        if (performance.now() - started > ms) return resolve('timeout');
        setTimeout(look, 20);
    };
    look();
}), [index, types, timeout] as const);

const toLogic = (page: Page, index: number, data: unknown) => page.evaluate(([i, d]) => (window as any).toLogic(i, d), [index, data] as const);
const ping = (page: Page, index: number, timeout = 5000) => page.evaluate(([i, t]) => (window as any).ping(i, t), [index, timeout] as const);

const OUTCOMES = ['GUEST_READY', 'SPAWN_FAILED', 'VIEW_SAW_ERROR', 'RELAY_GUEST_ERROR'];

// ---- Q1: nested workers ----------------------------------------------------------------------------------------------------

test.describe('Q1 nested workers', () => {
    for (const coep of [undefined, 'require-corp']) {
        const label = coep ? 'COEP require-corp' : 'no COEP';
        test(`host page controls (${label}): a worker's own blob: worker, from a blob: and from a same-origin script`, async ({ page }, testInfo) => {
            await open(page, coep);
            const result = await page.evaluate(() => new Promise((resolve) => {
                const out: Record<string, string> = {};
                const done = () => { if (Object.keys(out).length === 3) resolve(out); };
                const watch = (name: string, make: () => Worker) => {
                    try {
                        const worker = make();
                        worker.onmessage = (e) => { out[name] = typeof e.data === 'string' ? e.data : JSON.stringify(e.data); done(); };
                        worker.onerror = (e) => { out[name] = `error event: ${e.message}`; done(); };
                    } catch (e: any) { out[name] = `threw ${e.name}`; done(); }
                    setTimeout(() => { out[name] ??= 'nothing in 5 s'; done(); }, 5000);
                };
                const NESTED = `try { const n = new Worker(URL.createObjectURL(new Blob(['postMessage("nested ran")'], { type: 'text/javascript' }))); n.onmessage = (e) => postMessage({ nested: e.data }); n.onerror = (e) => postMessage({ nested: 'error event: ' + e.message }); } catch (e) { postMessage({ nested: 'threw ' + e.name }); }`;
                watch('blob worker', () => new Worker(URL.createObjectURL(new Blob(['postMessage("ran")'], { type: 'text/javascript' }))));
                watch('blob worker → nested blob worker', () => new Worker(URL.createObjectURL(new Blob([NESTED], { type: 'text/javascript' }))));
                watch('same-origin script worker → nested blob worker', () => new Worker(`/host-worker.js${location.search}`));
            }));
            log(testInfo.project.name, `Q1 host page ${label}`, result);
        });

        for (const layout of ['direct', 'relay'] as const) {
            test(`in the view (${label}), ${layout}: does the guest worker start`, async ({ page }, testInfo) => {
                await open(page, coep);
                const index = await start(page, { layout, relayCancels: true, viewCancels: true });
                const outcome = await firstOf(page, index, OUTCOMES);
                log(testInfo.project.name, `Q1 view ${label} ${layout}`, outcome);
                if (!coep || testInfo.project.name !== 'webkit') {
                    expect(outcome).toMatchObject({ type: 'GUEST_READY' });
                    expect((outcome as any).href).toMatch(/^blob:null\//);
                    return;
                }
                // WebKit under COEP: the view's own worker (the guest today, the relay proposed) gets an error event with no
                // message and never runs, exactly as it does today (host-policy.spec.ts); nesting comes too late to matter.
                expect(outcome).toMatchObject({ type: 'VIEW_SAW_ERROR', first: { hasError: false } });
            });
        }
    }

    test('the nested guest inherits the view policy: eval, Function, importScripts, fetch; positive controls with connect-src', async ({ page }, testInfo) => {
        await open(page);
        const results: Record<string, unknown> = {};
        for (const layout of ['direct', 'relay'] as const) {
            for (const connect of [[], [`http://localhost:${CANARY_PORT}`]]) {
                const id = `${testInfo.project.name}-${layout}-${connect.length}-${Date.now()}`;
                const canary = `http://localhost:${CANARY_PORT}/canary?id=${id}`;
                const index = await start(page, { layout, canary, relayCancels: true, viewCancels: true }, connect, connect.length > 0);
                expect(await waitFor(page, index, 'GUEST_READY')).not.toBe('timeout');
                await toLogic(page, index, { type: 'START', scenario: 'policy' });
                const policy = await waitFor(page, index, 'POLICY');
                const hits = Number(await (await fetch(`http://localhost:${CANARY_PORT}/hits?id=${id}`)).text());
                results[`${layout}${connect.length ? ' +connect-src' : ''}`] = { ...(policy as any).out, canaryHits: hits };
            }
        }
        log(testInfo.project.name, 'Q1 inherited policy', results);
        for (const layout of ['direct', 'relay']) {
            expect(results[layout]).toMatchObject({ eval: 'EvalError', Function: 'EvalError', importScripts: 'NetworkError', fetch: 'TypeError', blobFetch: 'TypeError', canaryHits: 0, origin: 'null' });
            // WebKit upgrades the loopback's http: (upgrade-insecure-requests, research 16), so its control is the blob: fetch
            const admitted = testInfo.project.name === 'webkit' ? { fetch: 'TypeError', blobFetch: 'ok', canaryHits: 0 } : { fetch: 'ok', blobFetch: 'ok', canaryHits: 1 };
            expect(results[`${layout} +connect-src`]).toMatchObject(admitted);
        }
    });
});

// ---- Q2, Q3: where the costs of a flood land ------------------------------------------------------------------------------

const ask = (page: Page, index: number, data: unknown, replyType: string, timeout = 5000) =>
    page.evaluate(([i, d, r, t]) => (window as any).ask(i, d, r, t), [index, data, replyType, timeout] as const) as Promise<any>;
const viewStats = (page: Page, index: number) => ask(page, index, { type: 'STATS' }, 'VIEW_STATS', 8000);

// 2 s windows, the flood stopping 100 ms after its window: the floods grow the browser by about 1 GB a second
const WINDOW_MS = 2000;
const FLOOD_MS = 2600;

type Variant = { name: string; opts: Opts };

/** A browser whose processes pass this much (PSS) is stopped: the VM's memory is shared with other work. */
const MEMORY_GUARD_KIB = 4 << 20;

/** One flood measured in a Playwright page (host.html's measureFlood), under the same memory guard. */
async function floodInPage(page: Page, scenario: string, variant: Variant) {
    const relay = variant.opts.layout === 'relay';
    await open(page);
    const index = await start(page, { ...variant.opts, relayTicks: relay, floodMs: FLOOD_MS });
    let peakPssKiB = 0;
    let stopped = false;
    const guard = setInterval(() => {
        const { pssKiB } = processTreeMemory();
        peakPssKiB = Math.max(peakPssKiB, pssKiB);
        if (pssKiB > MEMORY_GUARD_KIB && !stopped) { stopped = true; void page.close(); }
    }, 250);
    try {
        const result = await page.evaluate(([i, s, w, r]) => (window as any).measureFlood(i, s, w, r), [index, scenario, WINDOW_MS, relay] as const);
        return { ...result, peakPssMiB: peakPssKiB >> 10 };
    } catch (error) {
        return { error: stopped ? `stopped: the browser's processes passed ${MEMORY_GUARD_KIB >> 20} GiB` : String(error).slice(0, 200), peakPssMiB: peakPssKiB >> 10 };
    } finally {
        clearInterval(guard);
    }
}

// The standalone control: the same measurement in a browser started on host.html?auto=<id> alone, without Playwright (or
// any DevTools client) attached. Firefox's Juggler forwards every worker console message, whole, to the driver: under
// Playwright the 16 Mi-character floods measure Playwright's own forwarding as well, and the driver fell 1 GB behind.
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../out/relay-probe'); // gitignored
function launcher(project: string, profile: string, url: string): [string, string[]] {
    const chromiumPath = chromium.executablePath();
    if (project === 'firefox') return [firefox.executablePath(), ['-headless', '-no-remote', '-profile', profile, url]];
    if (project === 'webkit') return [path.join(path.dirname(webkit.executablePath()), 'pw_run.sh'), ['--headless', `--user-data-dir=${profile}`, url]];
    if (project === 'chromium-desktop') return [chromiumPath, ['--headless=new', '--no-sandbox', '--no-first-run', `--user-data-dir=${profile}`, url]];
    const shell = chromiumPath.replace(/chromium-(\d+)/, 'chromium_headless_shell-$1').replace(/chrome-linux(64)?\/chrome$/, 'chrome-headless-shell-linux$1/chrome-headless-shell');
    return [shell, ['--headless', '--no-sandbox', '--no-first-run', `--user-data-dir=${profile}`, url]];
}

async function floodStandalone(project: string, scenario: string, variant: Variant, baseURL: string) {
    const relay = variant.opts.layout === 'relay';
    const id = `${project}-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const job = { wrapper: wrapperDocument(), payload: payload({ ...variant.opts, relayTicks: relay, floodMs: FLOOD_MS }), scenario, windowMs: WINDOW_MS };
    await fetch(`${baseURL}/job?id=${id}`, { method: 'POST', body: JSON.stringify(job) });
    mkdirSync(OUT, { recursive: true });
    const profile = mkdtempSync(path.join(OUT, `${project}-`));
    const [command, args] = launcher(project, profile, `${baseURL}/host.html?auto=${id}`);
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    let peakPssKiB = 0;
    try {
        for (const started = Date.now(); Date.now() - started < 60000;) {
            await new Promise((r) => setTimeout(r, 250));
            const { pssKiB } = processTreeMemory(child.pid!);
            peakPssKiB = Math.max(peakPssKiB, pssKiB);
            // the machine is shared: a browser past the guard is stopped, and that is the result
            if (pssKiB > MEMORY_GUARD_KIB) return { error: `stopped: the browser's processes passed ${MEMORY_GUARD_KIB >> 20} GiB after ${((Date.now() - started) / 1000).toFixed(1)} s`, peakPssMiB: peakPssKiB >> 10 };
            const response = await fetch(`${baseURL}/result?id=${id}`);
            if (response.status === 200) return { ...(await response.json()), peakPssMiB: peakPssKiB >> 10 };
        }
        return { error: 'no result in 60 s', peakPssMiB: peakPssKiB >> 10 };
    } finally {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
        await new Promise((r) => setTimeout(r, 500));
        rmSync(profile, { recursive: true, force: true });
    }
}

const ERROR_VARIANTS: Variant[] = [
    { name: 'direct, guest cancels (today)', opts: { layout: 'direct', guestCancels: true, viewCancels: true } },
    { name: 'direct, nothing cancelled in the guest, view cancels', opts: { layout: 'direct', guestCancels: false, viewCancels: true } },
    { name: 'relay, nothing cancelled in the guest, relay cancels', opts: { layout: 'relay', guestCancels: false, relayCancels: true, viewCancels: true, onGuestMessage: 'bounded' } },
    { name: 'relay, guest cancels too', opts: { layout: 'relay', guestCancels: true, relayCancels: true, viewCancels: true, onGuestMessage: 'bounded' } },
];
const POST_VARIANTS: Variant[] = [
    { name: 'direct, to the view (round 4 M-1 before its fix)', opts: { layout: 'direct', guestCancels: true, viewCancels: true } },
    { name: 'relay, measured, bounded notices forwarded', opts: { layout: 'relay', guestCancels: true, relayCancels: true, onGuestMessage: 'bounded' } },
    { name: 'relay, a listener that forwards nothing', opts: { layout: 'relay', guestCancels: true, relayCancels: true, onGuestMessage: 'nothing' } },
    { name: 'relay, no message listener', opts: { layout: 'relay', guestCancels: true, relayCancels: true, onGuestMessage: 'none' } },
    { name: 'relay, forwarded whole (control)', opts: { layout: 'relay', guestCancels: true, relayCancels: true, onGuestMessage: 'all' } },
];

const FLOODS: [string, Variant][] = [];
for (const scenario of ['rejections', 'errors']) for (const variant of ERROR_VARIANTS) FLOODS.push([scenario, variant]);
for (const variant of POST_VARIANTS) FLOODS.push(['posts', variant]);

test.describe('Q2 floods: host-page busy, direct against relay, standalone (no Playwright attached)', () => {
    for (const [scenario, variant] of FLOODS) {
        test(`${scenario}: ${variant.name}`, async ({ baseURL }, testInfo) => {
            const result = await floodStandalone(testInfo.project.name, scenario, variant, baseURL!);
            log(testInfo.project.name, `Q2 standalone ${scenario} | ${variant.name}`, result);
            expect(result.error ?? 'measured').toMatch(/^(measured|stopped)/); // a stop by the memory guard is a result too
        });
    }
});

// What Firefox's rejection cost depends on: the same floods with a one-character Error, and with the 16 Mi-character
// string itself as the reason (no Error object), direct and nested.
test.describe('Q2 controls: what the rejection cost scales with, standalone', () => {
    for (const scenario of ['rejectionsSmall', 'rejectionsString']) {
        for (const variant of [ERROR_VARIANTS[0]!, ERROR_VARIANTS[2]!]) {
            test(`${scenario}: ${variant.name}`, async ({ baseURL }, testInfo) => {
                const result = await floodStandalone(testInfo.project.name, scenario, variant, baseURL!);
                log(testInfo.project.name, `Q2 standalone ${scenario} | ${variant.name}`, result);
                expect(result.error ?? 'measured').toMatch(/^(measured|stopped)/);
            });
        }
    }
});

// Uncaught errors nobody cancels: today's view cancels at its Worker object; what if no one does, and what does a relay that
// does not cancel pass on (an uncancelled error of a nested worker is reported again in its parent, here the relay).
const UNCANCELLED: Variant[] = [
    { name: 'direct, cancelled nowhere', opts: { layout: 'direct', guestCancels: false, viewCancels: false } },
    { name: 'relay, cancelled nowhere', opts: { layout: 'relay', guestCancels: false, relayCancels: false, viewCancels: false, onGuestMessage: 'bounded' } },
    { name: 'relay, the view cancels what the relay passes on', opts: { layout: 'relay', guestCancels: false, relayCancels: false, viewCancels: true, onGuestMessage: 'bounded' } },
];
test.describe('Q2 errors nobody cancels, standalone', () => {
    for (const variant of UNCANCELLED) {
        test(`errors: ${variant.name}`, async ({ baseURL }, testInfo) => {
            const result = await floodStandalone(testInfo.project.name, 'errors', variant, baseURL!);
            log(testInfo.project.name, `Q2 standalone errors | ${variant.name}`, result);
            expect(result.error ?? 'measured').toMatch(/^(measured|stopped)/);
        });
    }
});

// Under Playwright too, for comparison, except the 16 Mi-character floods in Firefox (see above: they hang the driver).
test.describe('Q2 floods under Playwright', () => {
    for (const [scenario, variant] of FLOODS) {
        test(`${scenario}: ${variant.name}`, async ({ page }, testInfo) => {
            test.skip(testInfo.project.name === 'firefox' && scenario !== 'posts', 'Juggler forwards each 16 Mi-character console message to the driver, which falls behind and hangs');
            const result = await floodInPage(page, scenario, variant);
            log(testInfo.project.name, `Q2 playwright ${scenario} | ${variant.name}`, result);
        });
    }
});

// ---- Q4: overheads -------------------------------------------------------------------------------------------------------

const percentile = (values: number[], p: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    return +sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!.toFixed(3);
};
const summary = (values: number[]) => ({ n: values.length, mean: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(3), p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99), max: +Math.max(...values).toFixed(3) });

/**
 * RSS and PSS (KiB) summed over the descendants of `root` (and `root` itself): by default this test worker's, which are
 * the browser Playwright launched and its processes.
 */
function processTreeMemory(root = process.pid): { processes: number; rssKiB: number; pssKiB: number } {
    const parents = new Map<number, number>();
    for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
            const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            parents.set(Number(entry), Number(fields[1]));
        } catch { /* gone */ }
    }
    const isDescendant = (pid: number) => {
        if (pid === root) return true;
        for (let p = parents.get(pid); p !== undefined && p > 1; p = parents.get(p)) if (p === root) return true;
        return false;
    };
    let processes = 0, rssKiB = 0, pssKiB = 0;
    for (const pid of parents.keys()) {
        if (!isDescendant(pid)) continue;
        try {
            const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
            rssKiB += Number(/^Rss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0);
            pssKiB += Number(/^Pss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0);
            processes++;
        } catch { /* gone */ }
    }
    return { processes, rssKiB, pssKiB };
}

const SANDBOXES = 20;

test.describe('Q4 overheads', () => {
    test(`memory: ${SANDBOXES} idle sandboxes, direct against relay, each against a fresh page's baseline`, async ({ context }, testInfo) => {
        test.setTimeout(240000);
        const rows: Record<string, number[]> = { direct: [], relay: [] };
        for (const layout of ['direct', 'relay', 'direct', 'relay', 'direct', 'relay', 'direct', 'relay', 'direct', 'relay'] as const) {
            const page = await context.newPage();
            await open(page);
            await page.waitForTimeout(1500);
            const base = processTreeMemory();
            for (let i = 0; i < SANDBOXES; i++) {
                const index = await start(page, { layout, guestCancels: true, viewCancels: true, relayCancels: true, onGuestMessage: 'bounded' });
                expect(await waitFor(page, index, 'GUEST_READY')).not.toBe('timeout');
            }
            await page.waitForTimeout(2500);
            const loaded = processTreeMemory();
            rows[layout]!.push((loaded.pssKiB - base.pssKiB) / SANDBOXES);
            log(testInfo.project.name, `Q4 memory sample ${layout}`, { base, loaded, perSandboxPssKiB: Math.round((loaded.pssKiB - base.pssKiB) / SANDBOXES), perSandboxRssKiB: Math.round((loaded.rssKiB - base.rssKiB) / SANDBOXES) });
            await page.close();
        }
        const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
        log(testInfo.project.name, 'Q4 memory per sandbox (PSS KiB, median of 5)', { direct: Math.round(median(rows.direct!)), relay: Math.round(median(rows.relay!)), extraForRelay: Math.round(median(rows.relay!) - median(rows.direct!)) });
    });

    test('RPC round trips: 1000 sequential calls after 200 to warm up', async ({ page }, testInfo) => {
        await open(page);
        const result: Record<string, unknown> = {};
        for (const layout of ['direct', 'relay'] as const) {
            const index = await start(page, { layout, guestCancels: true, viewCancels: true, relayCancels: true, onGuestMessage: 'bounded' });
            expect(await waitFor(page, index, 'GUEST_READY')).not.toBe('timeout');
            await page.evaluate((i) => (window as any).rpcBench(i, 200), index);
            const times = await page.evaluate((i) => (window as any).rpcBench(i, 1000), index) as number[];
            result[layout] = summary(times);
        }
        log(testInfo.project.name, 'Q4 RPC round trip ms', result);
    });

    test('time to ready: frame inserted → the guest\'s first message on the host, 20 mounts each, interleaved', async ({ page }, testInfo) => {
        await open(page);
        const wrapper = wrapperDocument();
        const runs: Record<string, { fromInsert: number[]; fromInit: number[] }> = { direct: { fromInsert: [], fromInit: [] }, relay: { fromInsert: [], fromInit: [] } };
        for (let round = 0; round < 21; round++) {
            for (const layout of ['direct', 'relay'] as const) {
                const times = await page.evaluate(async ([w, p]) => {
                    const host = window as any;
                    const inserted = performance.now();
                    const index = await host.mount(w);
                    const initAt = performance.now();
                    host.init(index, p);
                    const ready = await host.waitFor(index, 'GUEST_READY', 10000);
                    const now = performance.now();
                    host.removeFrame(index);
                    return ready === 'timeout' ? null : { fromInsert: now - inserted, fromInit: now - initAt };
                }, [wrapper, payload({ layout, guestCancels: true, viewCancels: true, relayCancels: true, onGuestMessage: 'bounded' })] as const);
                expect(times).not.toBeNull();
                if (round === 0) continue; // the first of each warms the caches
                runs[layout]!.fromInsert.push(times!.fromInsert);
                runs[layout]!.fromInit.push(times!.fromInit);
            }
        }
        log(testInfo.project.name, 'Q4 time to ready ms', {
            direct: { fromInsert: summary(runs.direct!.fromInsert), fromInit: summary(runs.direct!.fromInit) },
            relay: { fromInsert: summary(runs.relay!.fromInsert), fromInit: summary(runs.relay!.fromInit) },
        });
    });
});

// ---- Q5: error muting -----------------------------------------------------------------------------------------------------

test.describe('Q5 error muting after the guest\'s blob: URL is revoked', () => {
    for (const layout of ['direct', 'relay'] as const) {
        for (const revoke of [false, true]) {
            test(`${layout}, ${revoke ? 'revoked after the guest started' : 'not revoked'}: what the guest and its Worker object see of a later uncaught error`, async ({ page }, testInfo) => {
                await open(page);
                const index = await start(page, { layout, guestCancels: false, viewCancels: true, relayCancels: true, onGuestMessage: 'bounded', reportGuestErrors: true });
                expect(await waitFor(page, index, 'GUEST_READY')).not.toBe('timeout');
                if (revoke) {
                    // the guest's URL is minted by whoever spawned it: the view (direct) or the relay
                    const reply = layout === 'relay'
                        ? await ask(page, index, { type: 'TO_WORKER', data: { type: 'REVOKE' } }, 'REVOKED')
                        : await ask(page, index, { type: 'REVOKE' }, 'REVOKED');
                    expect(reply).not.toBe('timeout');
                }
                await toLogic(page, index, { type: 'START', scenario: 'lateThrow' });
                const inGuest = await waitFor(page, index, 'GUEST_SAW_ERROR', 5000);
                const onWorkerObject = layout === 'relay' ? await waitFor(page, index, 'RELAY_GUEST_ERROR', 5000) : await waitFor(page, index, 'VIEW_SAW_ERROR', 5000);
                await page.waitForTimeout(300);
                const view = await viewStats(page, index);
                const result = {
                    inGuest: inGuest === 'timeout' ? 'nothing' : { message: (inGuest as any).message, hasError: (inGuest as any).hasError },
                    onWorkerObject: onWorkerObject === 'timeout' ? 'nothing' : layout === 'relay' ? (onWorkerObject as any).message : (onWorkerObject as any).first.message,
                    reachedTheView: view.stats.errors,
                };
                log(testInfo.project.name, `Q5 ${layout} ${revoke ? 'revoked' : 'not revoked'}`, result);
            });
        }
    }
});

// ---- Q6: termination, the watchdog and the execution timeout --------------------------------------------------------------

const beats = (page: Page, index: number) => page.evaluate((i) => (window as any).envs[i].beats, index) as Promise<number>;

test.describe('Q6 termination', () => {
    const HOW = ['the view terminates its worker', 'the frame is removed', 'the relay terminates the guest'] as const;
    for (const layout of ['direct', 'relay'] as const) {
        for (const scenario of ['heartbeat', 'busy'] as const) {
            for (const how of HOW) {
                if (how === 'the relay terminates the guest' && layout === 'direct') continue;
                test(`${layout}, a ${scenario === 'busy' ? 'guest in an endless loop' : 'guest on timers'}: ${how}; does the guest stop`, async ({ page }, testInfo) => {
                    await open(page);
                    const index = await start(page, { layout, guestCancels: true, viewCancels: true, relayCancels: true, onGuestMessage: 'bounded' });
                    expect(await waitFor(page, index, 'GUEST_READY')).not.toBe('timeout');
                    await toLogic(page, index, { type: 'START', scenario });
                    await page.waitForTimeout(600);
                    const running = await beats(page, index);
                    expect(running).toBeGreaterThan(5);
                    const result = await page.evaluate(async ([i, action]) => {
                        const host = window as any;
                        const since = performance.now();
                        let acknowledged: unknown = true;
                        if (action === 'the frame is removed') host.removeFrame(i);
                        else if (action === 'the relay terminates the guest') acknowledged = await host.ask(i, { type: 'TO_WORKER', data: { type: 'TERMINATE_GUEST' } }, 'GUEST_TERMINATED', 5000);
                        else acknowledged = await host.ask(i, { type: 'TERMINATE' }, 'TERMINATED', 5000);
                        const acknowledgedMs = Math.round(performance.now() - since);
                        return { acknowledged: acknowledged !== 'timeout', acknowledgedMs, ...(await host.beatsStop(i, since)) };
                    }, [index, how] as const);
                    log(testInfo.project.name, `Q6 ${layout} ${scenario} | ${how}`, { beatsBefore: running, ...result });
                    // a beat already in flight may still arrive; the guest has stopped when they stop
                    expect(result).toMatchObject({ acknowledged: true, gaveUp: false });
                });
            }
        }

        test(`${layout}: the watchdog (a ping every 250 ms, 1 s to answer) finds an endless loop, and terminating ends it`, async ({ page }, testInfo) => {
            await open(page);
            const index = await start(page, { layout, guestCancels: true, viewCancels: true, relayCancels: true, onGuestMessage: 'bounded' });
            expect(await waitFor(page, index, 'GUEST_READY')).not.toBe('timeout');
            const healthy: number[] = [];
            for (let i = 0; i < 10; i++) healthy.push(await ping(page, index, 1000) as number);
            const result = await page.evaluate((i) => new Promise((resolve) => {
                const host = window as any;
                const env = host.envs[i];
                const started = performance.now();
                host.toLogic(i, { type: 'START', scenario: 'busy' });
                const round = async () => {
                    const answer = await host.ping(i, 1000);
                    if (answer !== 'timeout') { setTimeout(round, 250); return; }
                    const detected = performance.now() - started;
                    const since = performance.now();
                    const reply = await host.ask(i, { type: 'TERMINATE' }, 'TERMINATED', 5000);
                    const terminated = performance.now() - started;
                    const stop = await host.beatsStop(i, since);
                    resolve({ detectedMs: Math.round(detected), terminatedMs: Math.round(terminated), acknowledged: reply !== 'timeout', guestLastBeatAfterTerminateMs: stop.lastBeatMs, gaveUp: stop.gaveUp });
                };
                round();
            }), index);
            log(testInfo.project.name, `Q6 watchdog ${layout}`, { healthyPingMs: summary(healthy), ...(result as object) });
            expect(result).toMatchObject({ acknowledged: true, gaveUp: false });
        });
    }
});
