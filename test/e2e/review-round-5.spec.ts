import { deflateSync } from 'node:zlib';
import { test, expect, type SandboxDriver } from './fixture';
import { waitInView } from './strict-view';
import type { Page } from '@playwright/test';

/**
 * Review round 5: the findings where the browser decides, on Chromium, Firefox and WebKit. Each names its class
 * (docs/research/18_finding_classes/README.md), and each test failed at 60814b5 (the measurements say so where they are
 * the evidence). The library's own logic is unit-tested in test/unit/review-round-5.test.ts; the egress table's
 * enumeration of every engine's surfaces is test/e2e/egress.spec.ts.
 *   N-1  unhandled rejections in a loop kept Firefox's host page 99% busy (E-cpu)
 *   L-1  a call made while loading that timed out before `ready` still ran (L)
 *   N-4  a removal of a file the host unregistered after the build left the view showing it (D)
 */

// Ticks of a 10 ms interval on the host page over `ms`: what the host page's thread had left.
const countTicks = (page: Page, ms: number) => page.evaluate((duration) => new Promise<number>(resolve => {
    let count = 0;
    const timer = setInterval(() => count++, 10);
    setTimeout(() => { clearInterval(timer); resolve(count); }, duration);
}), ms);

async function mountMode(sandbox: SandboxDriver, mode: 'worker' | 'strict') {
    if (mode === 'worker') {
        expect(await sandbox.mount({ mode: 'worker', scriptUnsafe: true })).toBe('ready');
        return;
    }
    await sandbox.registerFiles({ 'main.js': 'void 0' });
    expect(await sandbox.mount({ mode: 'strict', entry: 'main.js', scriptUnsafe: true })).toBe('ready');
}

// The 'terminated' reasons of the harness's sandbox from now on.
const recordTerminations = (page: Page) => page.evaluate(() => {
    (window as any).terminations = [];
    document.querySelector('web-sandbox')!.addEventListener('terminated', (e) => (window as any).terminations.push((e as CustomEvent).detail.reason));
});
const terminations = (page: Page) => page.evaluate(() => [...(window as any).terminations] as string[]);

const UNCAUGHT_REASON = /uncaught errors or unhandled rejections/;

// A function that runs its argument on every timer tick for 5 s, then stops: long enough to measure, short enough that
// a flood the sandbox does not end cannot run the test's browser out of memory (Firefox's console kept about 7 GB in 25 s
// at 60814b5, past this machine's memory limit).
const FOR_5_SECONDS = `((tick) => { const end = performance.now() + 5000; const timer = setInterval(() => { if (performance.now() > end) clearInterval(timer); else tick(); }, 0); })`;

test.describe('L-1 (L): queued calls are posted only when the build is ready', () => {
    // The owner's repro: a call made at once after setConfig() with a large view. When its timeout falls between the
    // wrapper's load and the view's check-in (the window the large view widens), the call timed out and still ran at
    // 60814b5: strict mode had flushed the queue at the load. The window's place differs per run and engine, so the call
    // is made with several timeouts, one build each, and every call that timed out before its build's `ready` is checked;
    // a call that timed out after `ready` had been posted, and may run (it was no longer queued).
    test("strict mode, the owner's repro: a call that times out before `ready` never runs, at any timeout", async ({ sandbox, page, browserName }) => {
        test.setTimeout(90000);
        await sandbox.registerFiles({ 'main.js': `bridge.expose('m', (text) => console.log('L1 ' + text));` });
        const cases: { timeout: number; outcome: string; beforeReady: boolean }[] = [];
        for (const timeout of [5, 20, 40, 60, 80, 100, 130, 160, 200, 300]) {
            cases.push(await page.evaluate(async (timeout) => {
                const el = document.querySelector('web-sandbox') as any;
                const html = '<p>' + 'x'.repeat(880000) + '</p><p>' + timeout + '</p>';
                let readyAt = Infinity;
                const ready = new Promise(resolve => el.addEventListener('ready', () => { readyAt = performance.now(); resolve(null); }, { once: true }));
                el.setConfig({ entry: 'main.js', html });
                let settledAt = 0;
                const outcome = await el.callWithTimeout(timeout, 'm', 'ran ' + timeout).then(() => 'resolved', (e: any) => e.code).finally(() => { settledAt = performance.now(); });
                await ready;
                await el.callWithTimeout(5000, 'm', 'ready ' + timeout); // the positive control; the guest has run what it was sent
                return { timeout, outcome, beforeReady: settledAt < readyAt };
            }, timeout));
        }
        await page.waitForTimeout(300);
        const lines = new Set((await sandbox.logs()).filter(line => line.startsWith('L1 ')));
        const timedOutBeforeReady = cases.filter(entry => entry.outcome === 'TIMEOUT' && entry.beforeReady);
        console.log(`MEASURED ${browserName} L-1: ${timedOutBeforeReady.length} of ${cases.length} calls timed out before ready; ran anyway: ${JSON.stringify(timedOutBeforeReady.filter(entry => lines.has('L1 ran ' + entry.timeout)).map(entry => entry.timeout))}`);
        expect(timedOutBeforeReady.length, 'at least one call timed out before ready').toBeGreaterThan(0);
        for (const entry of timedOutBeforeReady) expect(lines.has('L1 ran ' + entry.timeout), `the call with timeout ${entry.timeout} ran`).toBe(false);
        for (const entry of cases) expect(lines.has('L1 ready ' + entry.timeout), 'the call after ready ran').toBe(true);
    });
});

