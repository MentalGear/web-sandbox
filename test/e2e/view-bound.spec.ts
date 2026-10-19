import { test, expect, type SandboxDriver } from './fixture';
import { waitInView } from './strict-view';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { VIEW_MAX_DISTINCT_URLS, VIEW_MAX_OPERATION_MS, VIEW_MAX_URLS, VIEW_URLS_PER_SECOND } from '@src/lib/in-sandbox-view';
import { best, busyShare, IDLE_MS, IDLE_WINDOWS, LOAD_SHARE, LOADED_MS, MARGIN, SOAK, ticks, TIME_SHARE, WARMUP_MS } from './host-share';

/**
 * The view's cost bound, executable (backlog S68; docs/API.md, "The view's cost to the host page"). On every engine the
 * suite runs (Playwright's Chromium is the headless shell, so all three share the host page's thread with the view):
 *
 *   (a) under each canonical flood, the host page's busy share stays within the long-run bound: the view's time budget
 *       (VIEW_APPLY_MS_PER_SECOND, 20%) plus, for floods that load, the browser's own work on loads at
 *       VIEW_URLS_PER_SECOND, plus the measure's margin (below);
 *   (b) an operation past VIEW_MAX_OPERATION_MS ends the sandbox, and no operation follows it.
 *
 * Measured as the other availability tests are: ticks of a 10 ms interval on the host page, against the page's own idle
 * baseline, the best of N windows on both sides (./host-share.ts, which also holds the bound's terms and the margin).
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
    globalThis.flood = () => {
        let n = 0;
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
            const { idle, loaded, busy, meanBusy } = await busyShare(page, () => sandbox.run('flood()'));
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
        const idle = await best(page, IDLE_WINDOWS, IDLE_MS);
        await sandbox.run('flood()');
        await page.waitForTimeout(WARMUP_MS);
        // the windows span the flood up to the cap: (cap / per render) renders, `every` ms apart
        const span = (VIEW_MAX_DISTINCT_URLS / VIEW_MAX_URLS - 1) * every - WARMUP_MS;
        const windows = Math.max(1, Math.floor(span / (2 * every)));
        let loaded = { count: 0, mean: 0, longest: 0 };
        const shares: number[] = [];
        for (let i = 0; i < windows; i++) {
            const window = await ticks(page, 2 * every);
            shares.push(Math.round((1 - window.count / (idle.count * (2 * every) / IDLE_MS)) * 100));
            if (window.count > loaded.count) loaded = { ...window, mean: 0 };
        }
        const line = await sandbox.waitForLog(`[Sandbox] sandboxView.render: the view refused a render: the view would load more than ${VIEW_MAX_DISTINCT_URLS} distinct URLs in this environment; nothing of it was applied.`, 90000);
        const busy = 1 - loaded.count / (idle.count * (2 * every) / IDLE_MS);
        console.log(`MEASURED ${browserName} view-bound (a) distinct URLs to the cap: idle ${idle.count} ticks per ${IDLE_MS} ms; windows of ${2 * every} ms busy ${shares.join('%, ')}% (best ${Math.round(busy * 100)}%, its longest gap ${loaded.longest} ms); ${requested.size} distinct URLs requested; bound ${Math.round((TIME_SHARE + LOAD_SHARE) * 100)}% + ${Math.round(MARGIN * 100)} points`);
        expect(line).toBeTruthy();
        expect(requested.size).toBe(VIEW_MAX_DISTINCT_URLS);
        expect(busy).toBeLessThanOrEqual(TIME_SHARE + LOAD_SHARE + MARGIN);
    });
});

// One operation's own cost, measured on a page of its own: the markup set, its layout forced and its rendering update
// waited for (as the view's meter measures an operation).
const operationCost = async (page: Page, html: string) => {
    const other = await page.context().newPage();
    try {
        await other.setContent('<!DOCTYPE html><html><head></head><body><div id="a"></div></body></html>');
        return await other.evaluate(async (markup) => {
            const a = document.getElementById('a')!;
            const start = performance.now();
            a.innerHTML = markup;
            document.elementFromPoint(0, 0);
            const flushed = performance.now() - start;
            await new Promise(resolve => requestAnimationFrame(() => resolve(0)));
            const frame = performance.now();
            await new Promise(resolve => setTimeout(resolve, 0));
            return Math.round(flushed + performance.now() - frame);
        }, html);
    } finally {
        await other.close();
    }
};

// An operation whose cost grows faster than its size on every engine: elements matched by a rule whose :has() looks at
// all their later siblings (test/e2e/view-round-5.spec.ts, M-2).
const heavy = (n: number) => `<style>i:has(~ b){color:red}</style><div>${'<i>x</i>'.repeat(n)}<b>y</b></div>`;

test.describe('(b) the single-operation bound', () => {
    test(`an operation past VIEW_MAX_OPERATION_MS (${VIEW_MAX_OPERATION_MS} ms) ends the sandbox, and none runs after it`, async ({ sandbox, page, browserName }) => {
        test.setTimeout(180000);
        let n = 24000;
        let cost = await operationCost(page, heavy(n));
        if (cost < 1.5 * VIEW_MAX_OPERATION_MS) cost = await operationCost(page, heavy(n = 30000));
        console.log(`MEASURED ${browserName} view-bound (b) calibration: ${n} elements under :has() ${cost} ms`);
        test.skip(cost < 1.5 * VIEW_MAX_OPERATION_MS, `the heaviest operation of the family takes ${cost} ms here`);
        await mountEntry(sandbox, `sandboxView.render('<div id="a"></div><div id="b"></div>');
            globalThis.go = () => { const html = ${JSON.stringify(heavy(1))}.replace('<i>x</i>', '<i>x</i>'.repeat(${n})); sandboxView.render(html, 'a'); sandboxView.render(html, 'b'); };`);
        const reasons: string[] = [];
        await page.exposeFunction('__terminated', (reason: string) => reasons.push(reason));
        await page.evaluate(() => {
            document.querySelector('web-sandbox')!.addEventListener('terminated', (e: any) => (window as any).__terminated(e.detail.reason));
            // every stall of the host page's thread past 500 ms, from a 10 ms timer
            (window as any).__stalls = [];
            let last = performance.now();
            const tick = () => { const now = performance.now(); if (now - last > 500) (window as any).__stalls.push(Math.round(now - last)); last = now; setTimeout(tick, 10); };
            tick();
        });
        // two operations queued, each past the limit: the first ends the sandbox, the second never runs
        await sandbox.run('go()');
        await expect.poll(() => sandbox.state(), { timeout: 3 * cost + 30000 }).toBe('terminated');
        await page.waitForTimeout(Math.max(3000, 2 * cost));
        const stalls = await page.evaluate(() => (window as any).__stalls as number[]);
        console.log(`MEASURED ${browserName} view-bound (b): the host page's stalls past 500 ms: ${stalls.join(', ')} ms (the operation ${cost} ms on a page of its own)`);
        expect(reasons).toEqual([`the view spent more than ${VIEW_MAX_OPERATION_MS} ms on one operation`]);
        // one operation's stall, not two: what one operation costs before the view can observe it is the bound's second
        // term, and the sandbox ends before the next one
        expect(stalls.filter(stall => stall > VIEW_MAX_OPERATION_MS / 2).length).toBeLessThanOrEqual(1);
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
        const idle = await best(page, IDLE_WINDOWS, IDLE_MS);
        await sandbox.run('flood()');
        const loaded = await ticks(page, 3000);
        console.log(`MEASURED ${browserName} view-bound (d) image decodes: idle ${idle.count} ticks per ${IDLE_MS} ms; the 3 s after the render ${loaded.count} ticks (${Math.round((1 - loaded.count / (idle.count * 3000 / IDLE_MS)) * 100)}% busy), longest gap ${loaded.longest} ms`);
    });

    test('relayout after a font swap: one @font-face (font-display: swap) over 15 000 paragraphs, arriving after 1.5 s', async ({ sandbox, page, browserName }) => {
        test.setTimeout(120000);
        const body = font();
        await page.route(A_EXAMPLE, async route => { await new Promise(r => setTimeout(r, 1500)); await route.fulfill({ body, contentType: 'font/ttf' }); });
        await mountEntry(sandbox, `sandboxView.render('<div id="b"></div>');
            globalThis.flood = () => sandboxView.render('<style>@font-face{font-family:g;src:url(https://a.example/f.ttf);font-display:swap}p{font-family:g,serif}</style>' + ${TEXT}.repeat(15000), 'b');`,
            { origins: { fonts: ['https://a.example'] } });
        await page.waitForTimeout(500);
        const idle = await best(page, IDLE_WINDOWS, IDLE_MS);
        await sandbox.run('flood()');
        await waitInView(page, browserName, `document.querySelectorAll('#b p').length === 15000`, 30000); // the render itself, measured by the meter
        const loaded = await ticks(page, 3000);
        console.log(`MEASURED ${browserName} view-bound (d) font swap: idle ${idle.count} ticks per ${IDLE_MS} ms; the 3 s around the font's arrival ${loaded.count} ticks (${Math.round((1 - loaded.count / (idle.count * 3000 / IDLE_MS)) * 100)}% busy), longest gap ${loaded.longest} ms`);
    });
});
