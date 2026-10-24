import type { Page } from '@playwright/test';
import { test, expect, type SandboxDriver } from '../../../test/e2e/fixture';
import { inView, waitInView } from '../../../test/e2e/strict-view';
import { busyOf, idleBaseline, ticks } from '../../../test/e2e/host-share';

/*
 * Research 23: what strict mode's pointer input costs, measured on the shipped code (no rewriting). On demand:
 *   WEB_SANDBOX_MEASURE=1 bunx playwright test docs/research/23_view_input/measure.spec.ts --project=chromium --workers=1
 * Each test prints one `MEASURED {json}` line and attaches it as an annotation.
 *   1. latency: a 60 Hz drag over the view, each move answered by the worker with set({ css: { transform } }); from the
 *      move's timeStamp in the view to the first task after the frame callback that applied the answer (the view's flush
 *      runs in one while frames run): the end of the rendering update that showed it, on the view's own clock. The guest
 *      writes the move's `time` into a custom property beside the transform, and the view is observed from outside
 *      (DevTools: a MutationObserver on the element);
 *   2. the host page's busy share during that drag: no subscription, a subscription that only receives, and one that
 *      answers each move (the idle baseline of test/e2e/host-share.ts);
 *   3. a burst of moves as fast as the driver sends them: how many reach the view, how many the guest receives, and the
 *      host page's busy share.
 */
test.skip(!process.env.WEB_SANDBOX_MEASURE, 'a measurement, run on demand (WEB_SANDBOX_MEASURE=1)');
test.describe.configure({ mode: 'serial' });

const MARKUP = '<div id="pad" style="position:absolute;inset:0;touch-action:none;user-select:none"></div><div id="box" style="position:absolute;left:0;top:0;width:40px;height:40px;background:red;pointer-events:none"></div><p id="ready" style="position:absolute;left:0;bottom:0;margin:0">ready</p>';
const ENTRIES: Record<string, string> = {
    none: '',
    forward: `sandboxView.on('pointermove', 'pad', () => { received++; });`,
    respond: `sandboxView.on('pointermove', 'pad', (d) => { received++; sandboxView.set('box', { css: { transform: 'translate(' + d.pointer.x + 'px, ' + d.pointer.y + 'px)', '--t': String(d.time) } }); });`,
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const pct = (values: number[], p: number) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! * 10) / 10;
};

async function mount(sandbox: SandboxDriver, page: Page, browserName: string, entry: string) {
    await sandbox.registerFiles({ 'main.js': `let received = 0; bridge.expose('received', () => received); sandboxView.render(${JSON.stringify(MARKUP)}); ${entry}` });
    expect(await sandbox.mount({ mode: 'strict', entry: 'main.js' })).toBe('ready');
    await waitInView(page, browserName, `!!document.getElementById('ready')`);
    // the view, observed from outside: when each answer was applied, and when the frame that showed it had rendered
    await inView(page, browserName, `(() => {
        const box = document.getElementById('box');
        globalThis.__m = { painted: {}, raw: 0 };
        addEventListener('pointermove', () => { globalThis.__m.raw++; }, true);
        new MutationObserver(() => {
            const t = box.style.getPropertyValue('--t').trim();
            if (!t || globalThis.__m.painted[t]) return;
            // the view applies an answer in a frame callback (its flush), so the first task after it runs once that frame has rendered
            setTimeout(() => { globalThis.__m.painted[t] = performance.now(); }, 0);
        }).observe(box, { attributes: true });
        return true;
    })()`);
}

/** Trusted moves at `hz` over the sandbox, on a circle. */
function startMoves(page: Page, box: { x: number; y: number }, hz: number) {
    let running = true;
    let sent = 0;
    const started = Date.now();
    const done = (async () => {
        let next = Date.now();
        while (running) {
            const a = sent / 20;
            await page.mouse.move(box.x + 200 + 120 * Math.cos(a), box.y + 150 + 100 * Math.sin(a));
            sent++;
            next += 1000 / hz;
            const wait = next - Date.now();
            if (wait > 0) await sleep(wait);
        }
        return { sent, ms: Date.now() - started };
    })();
    return { stop: async () => { running = false; return done; } };
}

test('latency and host cost of a 60 Hz drag answered with set({ css })', async ({ sandbox, page, browserName }) => {
    test.setTimeout(240000);
    await sandbox.open();
    const box = (await page.locator('web-sandbox').boundingBox())!;
    const idle = await idleBaseline(page);
    const results: Record<string, unknown> = { engine: browserName };
    for (const name of ['none', 'forward', 'respond']) {
        await mount(sandbox, page, browserName, ENTRIES[name]!);
        await page.mouse.move(box.x + 10, box.y + 10);
        await sleep(300);
        const before = await sandbox.call<number>('received');
        const moves = startMoves(page, box, 60);
        await sleep(500);
        const window = await ticks(page, 4000);
        const sent = await moves.stop();
        await sleep(500);
        const m = JSON.parse(await inView<string>(page, browserName, 'JSON.stringify(globalThis.__m)') as string) as { painted: Record<string, number>; raw: number };
        const latency = Object.entries(m.painted).map(([t, painted]) => painted - Number(t));
        results[name] = {
            movesPerSecond: Math.round(sent.sent / (sent.ms / 1000)),
            rawInView: m.raw,
            received: (await sandbox.call<number>('received')) - before,
            rendered: latency.length,
            hostBusyPercent: Math.round(busyOf(window.count, 4000, idle) * 100),
            hostLongestGapMs: window.longest,
            eventToRenderedMs: { p50: pct(latency, 0.5), p95: pct(latency, 0.95) },
        };
    }
    console.log(`MEASURED ${JSON.stringify(results)}`);
    test.info().annotations.push({ type: 'measured', description: JSON.stringify(results) });
});

test('a burst of moves as fast as the driver sends them: what reaches the view, what the guest receives, the host share', async ({ sandbox, page, browserName }) => {
    test.setTimeout(120000);
    await sandbox.open();
    const box = (await page.locator('web-sandbox').boundingBox())!;
    const idle = await idleBaseline(page);
    const results: Record<string, unknown> = { engine: browserName };
    for (const name of ['forward', 'respond']) {
        await mount(sandbox, page, browserName, ENTRIES[name]!);
        await page.mouse.move(box.x + 20, box.y + 20);
        await sleep(200);
        let running = true;
        const loop = (async () => { let k = 0; while (running) { k++; await page.mouse.move(box.x + 20 + (k % 2) * 360, box.y + 20 + (k % 2) * 260, { steps: 50 }); } })();
        await sleep(500);
        const rawBefore = await inView<number>(page, browserName, 'globalThis.__m.raw') as number;
        const receivedBefore = await sandbox.call<number>('received');
        const window = await ticks(page, 3000);
        const rawAfter = await inView<number>(page, browserName, 'globalThis.__m.raw') as number;
        const receivedAfter = await sandbox.call<number>('received');
        running = false;
        await loop;
        results[name] = {
            rawPerSecondInView: Math.round((rawAfter - rawBefore) / 3),
            receivedPerSecond: Math.round((receivedAfter - receivedBefore) / 3),
            hostBusyPercent: Math.round(busyOf(window.count, 3000, idle) * 100),
            hostLongestGapMs: window.longest,
        };
    }
    console.log(`MEASURED ${JSON.stringify(results)}`);
    test.info().annotations.push({ type: 'measured', description: JSON.stringify(results) });
});
