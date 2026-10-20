import { test, expect, type SandboxDriver } from './fixture';
import { waitInView } from './strict-view';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { VIEW_APPLY_MS_PER_SECOND, VIEW_MAX_DISTINCT_URLS, VIEW_MAX_OPERATION_MS, VIEW_MAX_URLS, VIEW_OVERRUN_WINDOW_MS, VIEW_URLS_PER_SECOND } from '@src/lib/in-sandbox-view';
import { busyOf, idleBaseline, interleavedShare, IDLE_MS, LOAD_SHARE, LOADED_MS, MARGIN, operationCost, SOAK, stalls, startLag, ticks, TIME_SHARE, WARMUP_MS } from './host-share';

/**
 * The view's cost bound, executable (backlog S68; docs/API.md, "The view's cost to the host page"). On every engine the
 * suite runs (Playwright's Chromium is the headless shell, so all three share the host page's thread with the view):
 *
 *   (a) under each canonical flood, the host page's busy share stays within the long-run bound: the view's time budget
 *       (VIEW_APPLY_MS_PER_SECOND, 20%) plus, for floods that load, the browser's own work on loads at
 *       VIEW_URLS_PER_SECOND, plus the measure's margin (below);
 *   (b) an operation past VIEW_MAX_OPERATION_MS is an overrun: charged in full, and survived; the second within
 *       VIEW_OVERRUN_WINDOW_MS ends the sandbox, and no operation follows it (backlog S72, class P).
 *
 * Measured as the other availability tests are: ticks of a 10 ms interval on the host page, against the page's own idle
 * baseline, the best of N windows on both sides, each loaded window between two baselines taken with the flood paused
 * (./host-share.ts, interleavedShare; it also holds the bound's terms and the margin).
 *
 * What the doc lists as outside the bound (allowAnimations: true, relayout after decodes and font swaps, the documented
 * single-operation stalls, memory, :hover restyles, Firefox's cost of unhandled rejections) is not asserted here.
 *
 * WEB_SANDBOX_SOAK=1 runs the same floods over windows four times as long, with more of them.
 */

async function mountEntry(sandbox: SandboxDriver, source: string, config: Record<string, unknown> = {}) {
    await sandbox.registerFiles({ 'main.js': source });
    expect(await sandbox.mount({ mode: 'strict', entry: 'main.js', scriptUnsafe: true, ...config })).toBe('ready');
}

// A one-pixel PNG, for the origin the view's policy admits (served by the test, never by a network).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const A_EXAMPLE = /^https?:\/\/a\.example(:\d+)?\//;
const ADMITTED = { origins: { images: ['https://a.example'] } };

/**
 * A flood: `setup` renders once; `step(n)` is the n-th operation, made every 5 ms (faster than the view takes them: the
 * worker keeps the latest operation per target, so the view always has the next one) until `stop` is set.
 */
const flood = (setup: string, step: string) => `
    ${setup}
    let n = 0; // across pauses: a resumed flood's URLs stay new
    globalThis.flood = () => {
        globalThis.stop = false;
        const next = () => { if (globalThis.stop) return; (${step})(n++); setTimeout(next, 5); };
        next();
    };`;

interface Scenario { name: string; source: string; loads: boolean; config?: Record<string, unknown>; ready?: string }

const SCENARIOS: Scenario[] = [
    {
        // three targets, so that every render is applied (four would hold more than VIEW_MAX_CHARACTERS)
        name: 'renders: 261 000 characters of text, replacing one of three targets',
        source: flood(`sandboxView.render('<div id="t0"></div><div id="t1"></div><div id="t2"></div>'); const text = ['x'.repeat(261000), 'y'.repeat(261000)];`,
            `(n) => sandboxView.render(text[n % 2], 't' + (n % 3))`),
        loads: false,
    },
    {
        name: 'element flood: 37 449 empty elements re-rendered',
        source: flood(`sandboxView.render('<div id="a"></div>'); const html = '<i></i>'.repeat(37449);`, `() => sandboxView.render(html, 'a')`),
        loads: false,
    },
    {
        name: 'set loop: a 65 536-character textarea value',
        source: flood(`sandboxView.render('<textarea id="t"></textarea>'); const v = ['x'.repeat(65536), 'y'.repeat(65536)];`,
            `(n) => sandboxView.set('t', { value: v[n % 2] })`),
        loads: false,
    },
    {
        name: 'class toggles: one rule over 5 000 elements',
        source: flood(`sandboxView.render('<style id="s"></style><div>' + '<i class="c">x</i>'.repeat(5000) + '</div>'); const rules = ['.c{color:red}', '.c{color:blue}'];`,
            `(n) => sandboxView.text('s', rules[n % 2])`),
        loads: false,
    },
    {
        name: '<img> flood from a refused source: 6 500 per render (dropped by the renderer)',
        source: flood(`sandboxView.render('<div id="a"></div>');`,
            `(n) => { let h = ''; for (let i = 0; i < 6500; i++) h += '<img alt="" src="https://r.example/' + n + '_' + i + '.png">'; sandboxView.render(h, 'a'); }`),
        loads: true,
    },
    {
        name: `<img> flood from an admitted origin: ${VIEW_MAX_URLS} per render, the same URLs`,
        source: flood(`sandboxView.render('<div id="a"></div>'); let h = ''; for (let i = 0; i < ${VIEW_MAX_URLS}; i++) h += '<img width="1" height="1" src="https://a.example/' + i + '.png">';`,
            `(n) => sandboxView.render(h + (n % 2 ? '<b></b>' : ''), 'a')`),
        loads: true,
        config: ADMITTED,
    },
    {
        name: 'CSS backgrounds from an admitted origin: 500 new per render',
        source: flood(`sandboxView.render('<div id="a"></div>');`,
            `(n) => { let h = ''; for (let i = 0; i < 500; i++) h += '<i style="display:block;width:1px;height:1px;background:url(https://a.example/c' + n + '_' + i + '.png)"></i>'; sandboxView.render(h, 'a'); }`),
        loads: true,
        config: ADMITTED,
    },
    {
        name: 'CSS backgrounds from a refused source: 500 new per render',
        source: flood(`sandboxView.render('<div id="a"></div>');`,
            `(n) => { let h = ''; for (let i = 0; i < 500; i++) h += '<i style="display:block;width:1px;height:1px;background:url(https://r.example/c' + n + '_' + i + '.png)"></i>'; sandboxView.render(h, 'a'); }`),
        loads: true,
    },
];

test.describe.configure({ mode: 'serial' });

test.describe("(a) the long-run bound: under each canonical flood the host page's busy share stays within it", () => {
    for (const scenario of SCENARIOS) {
        test(scenario.name, async ({ sandbox, page, browserName }) => {
            test.setTimeout(SOAK ? 240000 : 60000);
            await page.route(A_EXAMPLE, route => route.fulfill({ body: PNG, contentType: 'image/png' }));
            await mountEntry(sandbox, scenario.source, scenario.config);
            await page.waitForTimeout(300);
            // each loaded window between two idle baselines, the flood paused for them (./host-share.ts)
            const { idle, loaded, busy, meanBusy } = await interleavedShare(page, { resume: () => sandbox.run('flood()'), pause: () => sandbox.run('globalThis.stop = true') });
            const bound = TIME_SHARE + (scenario.loads ? LOAD_SHARE : 0);
            console.log(`MEASURED ${browserName} view-bound (a) ${scenario.name}: idle ${idle.count} ticks per ${IDLE_MS} ms (longest gap ${idle.longest} ms), loaded ${loaded.count} per ${LOADED_MS} ms (longest gap ${loaded.longest} ms): ${Math.round(busy * 100)}% busy (mean of the windows ${Math.round(meanBusy * 100)}%); bound ${Math.round(bound * 100)}% + ${Math.round(MARGIN * 100)} points`);
            await sandbox.run('globalThis.stop = true');
            expect(await sandbox.state()).toBe('ready');
            expect(busy).toBeLessThanOrEqual(bound + MARGIN);
        });
    }

    test(`distinct URLs to the cap: renders of ${VIEW_MAX_URLS} new images until ${VIEW_MAX_DISTINCT_URLS}, then refused`, async ({ sandbox, page, browserName }) => {
        test.setTimeout(180000);
        const requested = new Set<string>();
        await page.route(A_EXAMPLE, route => { requested.add(route.request().url()); return route.fulfill({ body: PNG, contentType: 'image/png' }); });
        // as fast as the load budget repays a render of VIEW_MAX_URLS (5 s at 200 per second); a faster guest's renders
        // would be replaced in the worker before they reach the view, and load nothing
        const every = Math.ceil((VIEW_MAX_URLS / VIEW_URLS_PER_SECOND) * 1000) + 200;
        await mountEntry(sandbox, `
            sandboxView.render('<div id="a"></div>');
            globalThis.flood = () => {
                let n = 0;
                const step = () => {
                    let html = '';
                    for (let i = 0; i < ${VIEW_MAX_URLS}; i++) html += '<img width="1" height="1" src="https://a.example/d' + n + '_' + i + '.png">';
                    n++;
                    sandboxView.render(html, 'a');
                    if (n < ${VIEW_MAX_DISTINCT_URLS / VIEW_MAX_URLS + 2}) setTimeout(step, ${every});
                };
                step();
            };`, ADMITTED);
        await page.waitForTimeout(300);
        const idle = await idleBaseline(page);
        await sandbox.run('flood()');
        await page.waitForTimeout(WARMUP_MS);
        // the windows span the flood up to the cap: (cap / per render) renders, `every` ms apart
        const span = (VIEW_MAX_DISTINCT_URLS / VIEW_MAX_URLS - 1) * every - WARMUP_MS;
        const windows = Math.max(1, Math.floor(span / (2 * every)));
        let loaded = { count: 0, mean: 0, longest: 0 };
        const shares: number[] = [];
        for (let i = 0; i < windows; i++) {
            const window = await ticks(page, 2 * every);
            shares.push(Math.round(busyOf(window.count, 2 * every, idle) * 100));
            if (window.count > loaded.count) loaded = { ...window, mean: 0 };
        }
        const line = await sandbox.waitForLog(`[Sandbox] sandboxView.render: the view refused a render: the view would load more than ${VIEW_MAX_DISTINCT_URLS} distinct URLs in this environment; nothing of it was applied.`, 90000);
        const busy = busyOf(loaded.count, 2 * every, idle);
        console.log(`MEASURED ${browserName} view-bound (a) distinct URLs to the cap: idle ${idle.count} ticks per ${IDLE_MS} ms; windows of ${2 * every} ms busy ${shares.join('%, ')}% (best ${Math.round(busy * 100)}%, its longest gap ${loaded.longest} ms); ${requested.size} distinct URLs requested; bound ${Math.round((TIME_SHARE + LOAD_SHARE) * 100)}% + ${Math.round(MARGIN * 100)} points`);
        expect(line).toBeTruthy();
        expect(requested.size).toBe(VIEW_MAX_DISTINCT_URLS);
        expect(busy).toBeLessThanOrEqual(TIME_SHARE + LOAD_SHARE + MARGIN);
    });
});

// One operation's own cost, on a page of its own: operationCost() (./host-share.ts).

// An operation whose cost grows faster than its size on every engine: elements matched by a rule whose :has() looks at
// all their later siblings (test/e2e/strict-view-budget.spec.ts, R5:M-2).
const heavy = (n: number) => `<style>i:has(~ b){color:red}</style><div>${'<i>x</i>'.repeat(n)}<b>y</b></div>`;

// The words of the repeated-overrun rule (backlog S72), as host.ts has them (test/unit/strict-view-budget.test.ts keeps them
// equal to the constants).
const MINUTES = VIEW_OVERRUN_WINDOW_MS / 60000;
const OVERRUN_REASON = `the view spent more than ${VIEW_MAX_OPERATION_MS} ms on one operation twice within ${MINUTES} minutes`;
const FIRST_OVERRUN_LINE = `[Sandbox] the view spent more than ${VIEW_MAX_OPERATION_MS} ms on one operation; a second such operation within ${MINUTES} minutes ends the sandbox.`;
// The least debt one overrun leaves: past VIEW_MAX_OPERATION_MS, less the second the budget holds, repaid at its rate.
const LEAST_DEBT_MS = ((VIEW_MAX_OPERATION_MS - VIEW_APPLY_MS_PER_SECOND) / VIEW_APPLY_MS_PER_SECOND) * 1000;

test.describe('(b) the single-operation bound: the repeated-overrun rule (class P, backlog S72)', () => {
    test(`an operation past VIEW_MAX_OPERATION_MS (${VIEW_MAX_OPERATION_MS} ms) is survived and charged in full; the second, once the debt is repaid and within VIEW_OVERRUN_WINDOW_MS, ends the sandbox, and none runs after it`, async ({ sandbox, page, browserName }) => {
        test.setTimeout(300000);
        let n = 24000;
        let cost = await operationCost(page, heavy(n));
        if (cost < 1.5 * VIEW_MAX_OPERATION_MS) cost = await operationCost(page, heavy(n = 30000));
        console.log(`MEASURED ${browserName} view-bound (b) calibration: ${n} elements under :has() ${cost} ms`);
        test.skip(cost < 1.5 * VIEW_MAX_OPERATION_MS, `the heaviest operation of the family takes ${cost} ms here`);
        // Every operation replaces one target, so that the view holds n elements at most (two targets of 30 000 would be
        // past VIEW_MAX_ELEMENTS, and refused unmeasured). The worker keeps the latest operation per target until the
        // one in flight is acknowledged, so the third is queued 100 ms after the second: it waits in the worker, behind it.
        await mountEntry(sandbox, `sandboxView.render('<div id="a"></div>');
            const html = (text) => '<style>i:has(~ b){color:red}</style><div>' + ('<i>' + text + '</i>').repeat(${n}) + '<b>y</b></div>'; // heavy(n)
            globalThis.go = () => sandboxView.render(html('x'), 'a');
            globalThis.again = () => { sandboxView.render(html('y'), 'a'); setTimeout(() => sandboxView.render(html('z'), 'a'), 100); };`);
        const reasons: string[] = [];
        await page.exposeFunction('__terminated', (reason: string) => reasons.push(reason));
        await page.evaluate(() => {
            document.querySelector('web-sandbox')!.addEventListener('terminated', (e: any) => (window as any).__terminated(e.detail.reason));
        });
        // every stall of the host page's thread past 500 ms: where it ended, and how long it was (./host-share.ts)
        await startLag(page, { recordOver: 500 });
        // three operations, each past the limit: the first is an overrun, said once, and the sandbox stands
        await sandbox.run('go()');
        await sandbox.waitForLog(FIRST_OVERRUN_LINE, 3 * cost + 30000);
        expect(await sandbox.state()).toBe('ready');
        // the second, made at once, runs only when the first's debt is repaid (five times what it was charged), and
        // ends the sandbox; the third, behind it, never runs
        await sandbox.run('again()');
        await expect.poll(() => sandbox.state(), { timeout: 8 * cost + 60000 }).toBe('terminated');
        await page.waitForTimeout(Math.max(3000, 2 * cost));
        const stalled = await stalls(page);
        console.log(`MEASURED ${browserName} view-bound (b): the host page's stalls past 500 ms: ${stalled.map(stall => `${stall.ms} ms ending at ${stall.end}`).join(', ')} (the operation ${cost} ms on a page of its own)`);
        expect(reasons).toEqual([OVERRUN_REASON]);
        expect((await sandbox.logs()).filter(line => line === FIRST_OVERRUN_LINE)).toHaveLength(1);
        // two operations' stalls at most, not three: what one operation costs before the view can observe it is the
        // bound's second term, the debt holds the second back for at least LEAST_DEBT_MS, and the sandbox ends before
        // the third
        const long = stalled.filter(stall => stall.ms > VIEW_MAX_OPERATION_MS / 2);
        expect(long.length).toBeLessThanOrEqual(2);
        if (long.length === 2) expect(long[1]!.end - long[1]!.ms - long[0]!.end).toBeGreaterThan(0.9 * LEAST_DEBT_MS);
    });
});

// (d), measured and not asserted (WEB_SANDBOX_SOAK=1): the browser work after an operation that the view's meter does
// not see, because it happens after the frame the meter measured. The doc gives these numbers as the magnitude of the
// items outside the bound.
test.describe('(d) outside the bound, measured only', () => {
    test.skip(!SOAK, 'a measurement, run on demand (WEB_SANDBOX_SOAK=1)');
    // any TrueType font of the machine's (a Linux one here)
    const font = () => readFileSync(process.env.WEB_SANDBOX_SOAK_FONT || '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf');
    // 15 000 paragraphs in one render: within VIEW_RENDER_MAX_LENGTH (17 characters each)
    const TEXT = `'<p>' + 'w '.repeat(5) + '</p>'`;

    test('relayout after image decodes: 1000 images without dimensions above 15 000 paragraphs, arriving over 2 s', async ({ sandbox, page, browserName }) => {
        test.setTimeout(120000);
        await page.route(A_EXAMPLE, async route => { await new Promise(r => setTimeout(r, Math.random() * 2000)); await route.fulfill({ body: PNG, contentType: 'image/png' }); });
        await mountEntry(sandbox, `sandboxView.render('<div id="a"></div><div id="b"></div>'); sandboxView.render(${TEXT}.repeat(15000), 'b');
            globalThis.flood = () => { let h = ''; for (let i = 0; i < 1000; i++) h += '<img src="https://a.example/i' + i + '.png">'; sandboxView.render(h, 'a'); };`, ADMITTED);
        await waitInView(page, browserName, `document.querySelectorAll('#b p').length === 15000`, 30000);
        const idle = await idleBaseline(page);
        await sandbox.run('flood()');
        const loaded = await ticks(page, 3000);
        console.log(`MEASURED ${browserName} view-bound (d) image decodes: idle ${idle.count} ticks per ${IDLE_MS} ms; the 3 s after the render ${loaded.count} ticks (${Math.round(busyOf(loaded.count, 3000, idle) * 100)}% busy), longest gap ${loaded.longest} ms`);
    });

    test('relayout after a font swap: one @font-face (font-display: swap) over 15 000 paragraphs, arriving after 1.5 s', async ({ sandbox, page, browserName }) => {
        test.setTimeout(120000);
        const body = font();
        await page.route(A_EXAMPLE, async route => { await new Promise(r => setTimeout(r, 1500)); await route.fulfill({ body, contentType: 'font/ttf' }); });
        await mountEntry(sandbox, `sandboxView.render('<div id="b"></div>');
            globalThis.flood = () => sandboxView.render('<style>@font-face{font-family:g;src:url(https://a.example/f.ttf);font-display:swap}p{font-family:g,serif}</style>' + ${TEXT}.repeat(15000), 'b');`,
            { origins: { fonts: ['https://a.example'] } });
        await page.waitForTimeout(500);
        const idle = await idleBaseline(page);
        await sandbox.run('flood()');
        await waitInView(page, browserName, `document.querySelectorAll('#b p').length === 15000`, 30000); // the render itself, measured by the meter
        const loaded = await ticks(page, 3000);
        console.log(`MEASURED ${browserName} view-bound (d) font swap: idle ${idle.count} ticks per ${IDLE_MS} ms; the 3 s around the font's arrival ${loaded.count} ticks (${Math.round(busyOf(loaded.count, 3000, idle) * 100)}% busy), longest gap ${loaded.longest} ms`);
    });
});
