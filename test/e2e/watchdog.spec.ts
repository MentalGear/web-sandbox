import { test, expect } from './fixture';

/**
 * The opt-in liveness watchdog (backlog S6, default mode; ADR-003). With `watchdogTimeout` set, a guest
 * whose event loop stops answering is terminated within the budget, while the host page stays
 * responsive; a guest that keeps answering is never terminated; and the watchdog stops with the
 * environment it watches.
 *
 * Where it holds: the guest must run on a different thread or process from the host, so that its loop
 * cannot block the host's timers. Worker mode is that on every browser. Iframe mode is that only where
 * the browser runs the sandboxed frame out of process. Measured: Chromium does (a separate CDP iframe
 * target; the host answered within milliseconds during a guest loop); WebKit runs it on the host's
 * thread (the host stalled for the length of the loop). Firefox is not measured yet. Same-thread is a
 * platform limit; strict mode (S6) is the open answer to it.
 */

const BUDGET = 1000;
// The watchdog stops a silent guest between one and 1.25 budgets after its last answer (src/lib/watchdog.ts);
// the rest is slack for message delivery and a loaded CI machine.
const DEADLINE = BUDGET * 1.25 + 1000;
const WATCHDOG_REASON = 'the guest stopped responding (watchdog)';

// Starts an endless loop in the guest and records, on the host, how the sandbox ends up terminated.
const START_LOOP_AND_WATCH = () => {
    const s = document.querySelector('web-sandbox') as any;
    (window as any).termination = null;
    const startedAt = performance.now();
    s.addEventListener('terminated', (e: CustomEvent) => {
        (window as any).termination = { reason: e.detail.reason, state: s.state, elapsed: performance.now() - startedAt };
    }, { once: true });
    s.execute('while (true) {}');
};

async function expectWatchdogStopsLoop(sandbox: any, page: any) {
    await page.evaluate(START_LOOP_AND_WATCH);
    await page.waitForTimeout(300); // the guest is now inside its loop

    // The host page is not blocked by the guest's loop.
    const before = Date.now();
    const stillRunning = await page.evaluate(() => (window as any).termination === null);
    expect(Date.now() - before).toBeLessThan(500);
    expect(stillRunning).toBe(true); // well inside the budget: not terminated yet

    await page.waitForFunction(() => (window as any).termination !== null, null, { timeout: DEADLINE + 2000 });
    const termination = await page.evaluate(() => (window as any).termination);
    expect(termination.reason).toBe(WATCHDOG_REASON);
    expect(termination.state).toBe('terminated');
    expect(termination.elapsed).toBeLessThan(DEADLINE);

    // Terminated like any other termination: calls are refused, and reset() recovers.
    expect((await sandbox.callOutcome('anything')).code).toBe('TERMINATED');
    expect(await sandbox.reset()).toBe('ready');
    await sandbox.exposeGuest('sum', '(a, b) => a + b');
    expect(await sandbox.call('sum', 1, 2)).toBe(3);
}

test('iframe mode: a guest stuck in an endless loop is terminated by the watchdog within the budget, and the host stays responsive', async ({ sandbox, page, browserName }) => {
    // Runs only where the frame is measured to be out of process (Chromium). WebKit runs it on the host's
    // thread, so a guest loop blocks the host page and its watchdog with it: a platform limit, not a gap
    // in the test. Firefox is unmeasured, so it is not claimed either way. On those browsers the watchdog
    // is still covered by the worker-mode loop test and the no-false-positive and stop tests below.
    test.skip(browserName !== 'chromium', 'iframe-mode loop bounding is only claimed where the frame is measured out of process (Chromium)');
    expect(await sandbox.mount({ watchdogTimeout: BUDGET })).toBe('ready');
    await expectWatchdogStopsLoop(sandbox, page);
});

test('worker mode: a worker stuck in an endless loop is terminated by the watchdog within the budget, and the host stays responsive', async ({ sandbox, page }) => {
    expect(await sandbox.mount({ mode: 'worker', watchdogTimeout: BUDGET })).toBe('ready');
    await expectWatchdogStopsLoop(sandbox, page);
});

for (const mode of ['iframe', 'worker'] as const) {
    test(`${mode} mode: a responsive guest is never terminated by the watchdog, across a reset, and guest methods named PING/PONG are unaffected`, async ({ sandbox, page }) => {
        const budget = 600;
        expect(await sandbox.mount({ mode, watchdogTimeout: budget })).toBe('ready');
        await page.evaluate(() => {
            const s = document.querySelector('web-sandbox') as any;
            (window as any).terminations = 0;
            s.addEventListener('terminated', () => (window as any).terminations++);
        });
        // The watchdog's frames travel outside the broker, so these names belong to the guest alone.
        await sandbox.exposeGuest('PING', '() => "guest-ping"');
        await sandbox.exposeGuest('PONG', '() => "guest-pong"');
        // Short bursts of synchronous work, well under the budget, are still answered in time.
        await sandbox.run('setInterval(() => { const t = Date.now(); while (Date.now() - t < 30) {} }, 100)');

        await page.waitForTimeout(budget * 2.5);
        expect(await sandbox.reset()).toBe('ready'); // the watchdog restarts with the fresh frame
        await sandbox.exposeGuest('PONG', '() => "guest-pong"');
        await page.waitForTimeout(budget * 2.5);

        expect(await page.evaluate(() => (window as any).terminations)).toBe(0);
        expect(await sandbox.state()).toBe('ready');
        expect(await sandbox.call('PONG')).toBe('guest-pong');
    });
}

test('the watchdog stops when the element is removed or terminated: it never terminates a removed element or the next environment', async ({ sandbox, page }) => {
    const budget = 300;
    expect(await sandbox.mount({ watchdogTimeout: budget })).toBe('ready');
    const report = await page.evaluate(async (budget) => {
        const s = document.querySelector('web-sandbox') as any;
        const reasons: unknown[] = [];
        s.addEventListener('terminated', (e: CustomEvent) => reasons.push(e.detail.reason));
        const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

        s.remove();
        await wait(budget * 4); // a watchdog left running would see no answers and terminate
        const afterRemoval = { state: s.state, reasons: [...reasons] };

        const whenReady = () => new Promise(r => s.addEventListener('ready', r, { once: true }));
        let ready = whenReady();
        document.body.appendChild(s);
        await ready;
        s.terminate('stopped by the test');
        ready = whenReady();
        s.reset();
        await ready;
        // A watchdog left over from the terminated frame would hear nothing on its closed port and
        // terminate the fresh sandbox; the fresh frame's own watchdog keeps hearing answers.
        await wait(budget * 4);
        return { afterRemoval, state: s.state, reasons };
    }, budget);
    expect(report).toEqual({
        afterRemoval: { state: 'idle', reasons: [] },
        state: 'ready',
        reasons: ['stopped by the test'],
    });
});
