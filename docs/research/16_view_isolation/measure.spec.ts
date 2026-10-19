import type { Page } from '@playwright/test';
import { test, expect, type SandboxDriver } from '../../../test/e2e/fixture';
import { inView, waitInView } from '../../../test/e2e/strict-view';
import { busyOf, ticks as hostTicks } from '../../../test/e2e/host-share';

/**
 * Research 16: what the view's time budget costs to measure (README.md, "What measuring the budget costs"). On demand
 * only, not part of the e2e suite:
 *
 *   WEB_SANDBOX_MEASURE=1 bunx playwright test docs/research/16_view_isolation --workers=1
 *
 * Each scenario reads, on the host page, over WINDOW_MS:
 *   - ticks of a 10 ms interval (busy % = 1 − ticks / ideal ticks; the page without a sandbox sets each engine's floor);
 *   - the host page's animation frames per second;
 * and, in the view, how many animation-frame callbacks it requested, how many flushes it ran, and the time per flush of
 * each part of the budget's accounting.
 *
 * The view's source is rewritten in flight (page.route on the dev server's module), before the bootstrap's text and
 * hash are made from it, so the view still runs under its policy:
 *   - always: requestAnimationFrame counted in the view (and the time its frame callbacks take), flushes counted;
 *   - accounting on: the time the forced layout (`layout`), the charges (`charge`) and the meter's request
 *     (`measureRendering`) take, summed per part;
 *   - accounting stubbed: the meter and the forced layout do nothing (the flush's own two performance.now() reads stay).
 * performance.now() is coarsened in the sandboxed view, so the per-flush times are averages over many flushes.
 */

test.skip(!process.env.WEB_SANDBOX_MEASURE, 'a measurement, run on demand (WEB_SANDBOX_MEASURE=1)');
test.describe.configure({ mode: 'serial' });

const WINDOW_MS = 4000;

// `const name = (parameter) => {` becomes a wrapper that adds the body's time to g.__spent[key].
function timed(source: string, name: string, key: string): string {
    const pattern = new RegExp(`const ${name} = \\((\\w*)\\) => \\{`);
    return source.replace(pattern, (_whole, parameter: string) =>
        `const ${name} = (${parameter}) => { const s = performance.now(); try { return ${name}Body(${parameter}); } finally { g.__spent.${key} += performance.now() - s; } }; const ${name}Body = (${parameter}) => {`);
}

async function rewriteView(page: Page, stub: boolean) {
    await page.route('**/src/lib/in-sandbox-view.ts**', async (route) => {
        const response = await route.fetch();
        let source = await response.text();
        const counter = '{ const raf = requestAnimationFrame; let calls = 0; g.__viewFrameRequests = () => calls;'
            + ' g.__spent = { frameCallbacks: 0, layout: 0, charge: 0, meter: 0, flushes: 0 };'
            + ' g.requestAnimationFrame = (callback) => { calls++; return raf((stamp) => { const s = performance.now(); callback(stamp); g.__spent.frameCallbacks += performance.now() - s; }); }; }';
        source = source.replace(/(const runs = \(g\.__sandboxViewRuns \|\| 0\) \+ 1;)/, `${counter}\n$1`);
        source = source.replace(/const flush = \((\w*)\) => \{/, 'const flush = ($1) => { g.__spent.flushes++;');
        if (stub) {
            // this build's meter and forced layout, or the earlier build's (a frame callback per flush charging its age)
            const stubbed = source
                .replace(/const measureRendering = \((\w*)\) => \{/, 'const measureRendering = ($1) => { return;')
                .replace(/const layout = \(\) => \{/, 'const layout = () => { return;')
                .replace(/requestAnimationFrame\(\(\) => \{\s*const rendering = [\s\S]*?\}\);/, '');
            expect(stubbed).not.toBe(source);
            source = stubbed;
        } else {
            source = timed(source, 'layout', 'layout');
            source = timed(source, 'charge', 'charge');
            source = timed(source, 'measureRendering', 'meter');
        }
        await route.fulfill({ response, body: source });
    });
}

/** Host ticks of a 10 ms interval and host animation frames over WINDOW_MS (test/e2e/host-share.ts). */
const sample = async (page: Page) => {
    const window = await hostTicks(page, WINDOW_MS, { frames: true });
    return { ticks: window.count, frames: window.frames };
};

type Spent = { frameCallbacks: number; layout: number; charge: number; meter: number; flushes: number; requests: number };
const viewSpent = async (page: Page, browserName: string): Promise<Spent | null> => {
    const value = await inView<string>(page, browserName, 'globalThis.__spent ? JSON.stringify({ ...__spent, requests: __viewFrameRequests() }) : ""');
    return typeof value === 'string' && value.startsWith('{') ? JSON.parse(value) : null; // no view: 'no-context'
};

async function measure(sandbox: SandboxDriver, page: Page, browserName: string, label: string) {
    const before = await viewSpent(page, browserName);
    const { ticks, frames } = await sample(page);
    const after = await viewSpent(page, browserName);
    const delta = (key: keyof Spent) => (before && after ? after[key] - before[key] : 0);
    const flushes = delta('flushes');
    const perFlush = (key: keyof Spent) => Math.round((delta(key) / flushes) * 1000); // µs
    const result = {
        engine: browserName,
        scenario: label,
        // against the ideal, WINDOW_MS / 10 ticks: the page without a sandbox is each engine's floor (see above)
        busyPercent: Math.max(0, Math.round(busyOf(ticks, WINDOW_MS, { count: WINDOW_MS / 10, ms: WINDOW_MS }) * 100)),
        fps: Math.round((frames / WINDOW_MS) * 1000),
        viewFrameRequestsPerSecond: before && after ? Math.round((delta('requests') / WINDOW_MS) * 1000) : null,
        flushesPerSecond: Math.round((flushes / WINDOW_MS) * 1000),
        microsecondsPerFlush: flushes > 0
            ? { frameCallbacks: perFlush('frameCallbacks'), forcedLayout: perFlush('layout'), charges: perFlush('charge'), meterRequest: perFlush('meter') }
            : null,
    };
    console.log(`MEASURED ${JSON.stringify(result)}`);
    return result;
}

const IDLE = `sandboxView.render('<p id="a">0</p>');`;
// small text() updates as fast as the view takes them: one in flight, the next on its acknowledgement
const TEXT_LOOP = `${IDLE}
    let n = 0; const next = () => { sandboxView.text('a', String(++n)); setTimeout(next, 0); }; next();`;
const ANIMATED = `sandboxView.render('<style>@keyframes spin { to { transform: rotate(1turn) } } .s { display: inline-block; animation: spin 1s linear infinite }</style>'
    + '<span class="s">x</span>'.repeat(20) + '<p id="a">0</p>');`;

for (const stub of [false, true]) {
    test(`idle, text() loop and an animated idle view (accounting ${stub ? 'stubbed' : 'on'})`, async ({ sandbox, page, browserName }) => {
        test.setTimeout(120000);
        await rewriteView(page, stub);
        await sandbox.open();
        const suffix = stub ? ', accounting stubbed' : '';
        if (!stub) {
            await page.evaluate(() => { (window as any).parked = document.querySelector('web-sandbox')!; (window as any).parked.remove(); });
            await measure(sandbox, page, browserName, 'no sandbox');
            await page.evaluate(() => document.body.appendChild((window as any).parked));
        }

        await sandbox.registerFiles({ 'main.js': IDLE });
        expect(await sandbox.mount({ mode: 'strict', entry: 'main.js' })).toBe('ready');
        await waitInView(page, browserName, `document.getElementById('a')`);
        await page.waitForTimeout(500);
        await measure(sandbox, page, browserName, `idle strict view${suffix}`);

        // the entry starts the loop itself (execute() would need scriptUnsafe)
        await sandbox.registerFiles({ 'main.js': TEXT_LOOP });
        expect(await sandbox.mount({ mode: 'strict', entry: 'main.js' })).toBe('ready');
        await page.waitForTimeout(1000);
        await measure(sandbox, page, browserName, `text() loop${suffix}`);

        await sandbox.registerFiles({ 'main.js': ANIMATED });
        expect(await sandbox.mount({ mode: 'strict', entry: 'main.js' })).toBe('ready');
        await page.waitForTimeout(1000);
        await measure(sandbox, page, browserName, `animated idle view (20 elements, allowAnimations default)${suffix}`);
    });
}
