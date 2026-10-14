import { test, expect } from './fixture';

/**
 * The opt-in liveness watchdog (backlog S6, default mode; ADR-003). With `watchdogTimeout` set, a guest
 * whose event loop stops answering is terminated within the budget, while the host page stays
 * responsive; a guest that keeps answering is never terminated; and the watchdog stops with the
 * environment it watches.
 *
 * Where it holds: the guest must run on a different thread or process from the host, so that its loop
 * cannot block the host's timers. Worker mode is that on every browser. Iframe mode is that only where
 * the browser runs the sandboxed frame out of process, which is browser policy rather than something the
 * page controls: it varies by browser and even by environment (Chromium ran the frame out of process in
 * one test environment and on the host's thread in CI). So the iframe-mode test measures it first and
 * asserts whichever contract applies. Same-thread is a platform limit; strict mode (S6, ADR-005) is the
 * answer to it: guest code runs only in a worker there, so the bound holds on every engine — asserted
 * below for a loop at the entry's top level and through execute(). Where the view shares the host's
 * thread (Firefox, WebKit), rendering is host-thread work; with one render in flight (A4) a looping worker
 * that rendered first is still stopped within the budget plus the measured stall of that one render.
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

// Measures whether the sandboxed frame runs on the host's thread in this run: a bounded guest busy loop
// either stalls a host round-trip for its length (same thread) or does not (own process). Bounded, so it
// can never hang the page, and shorter than the watchdog budget, so it never trips the watchdog.
async function frameSharesHostThread(sandbox: any, page: any): Promise<boolean> {
    await sandbox.run('{ const t = performance.now(); while (performance.now() - t < 600) {} }');
    await page.waitForTimeout(100); // the guest is now inside its loop
    const before = Date.now();
    await page.evaluate(() => 0);
    const stalled = Date.now() - before > 300;
    await page.waitForTimeout(700); // let the probe loop finish either way
    return stalled;
}

test('iframe mode: a guest stuck in a loop is stopped by the watchdog where the frame has its own thread, and never charged for host stalls where it shares the host thread', async ({ sandbox, page }, testInfo) => {
    expect(await sandbox.mount({ watchdogTimeout: BUDGET })).toBe('ready');

    if (!(await frameSharesHostThread(sandbox, page))) {
        testInfo.annotations.push({ type: 'process-model', description: 'sandboxed frame runs out of process: endless-loop bound asserted' });
        await expectWatchdogStopsLoop(sandbox, page);
        return;
    }

    // Same thread: no in-page mechanism can bound an endless guest loop here (it would hang the page,
    // watchdog included), so the contract to assert is the other half of the design: the time the host
    // itself was stalled is never counted against the guest. A guest loop longer than the budget stalls
    // host and watchdog alike; once it yields, the sandbox is still ready and answering.
    testInfo.annotations.push({ type: 'process-model', description: 'sandboxed frame shares the host thread: asserted that host stalls are not charged to the guest' });
    await page.evaluate(() => {
        const s = document.querySelector('web-sandbox') as any;
        (window as any).termination = null;
        s.addEventListener('terminated', (e: CustomEvent) => { (window as any).termination = e.detail.reason; }, { once: true });
    });
    await sandbox.run(`{ const t = performance.now(); while (performance.now() - t < ${BUDGET * 2}) {} }`);
    await page.waitForTimeout(BUDGET * 2 + BUDGET * 1.5); // the loop, then more than a full budget after it
    expect(await page.evaluate(() => (window as any).termination)).toBeNull();
    expect(await sandbox.state()).toBe('ready');
    await sandbox.exposeGuest('sum', '(a, b) => a + b');
    expect(await sandbox.call('sum', 1, 2)).toBe(3);
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

// ---- strict mode (ADR-005) ---------------------------------------------------------------------------------

// The host thread's largest stall while `during` runs: the biggest gap of a 10 ms interval timer, in the page.
const START_LAG = () => {
    const w = window as any;
    w.lag = { max: 0, last: performance.now() };
    clearInterval(w.lagTimer);
    w.lagTimer = setInterval(() => { const now = performance.now(); w.lag.max = Math.max(w.lag.max, now - w.lag.last - 10); w.lag.last = now; }, 10);
};
const LAG = () => Math.round((window as any).lag.max);

test('strict mode: an endless loop at the entry\'s top level is terminated within the budget on every engine; the host stays responsive; a fixed entry recovers on reset()', async ({ sandbox, page }) => {
    await sandbox.registerFiles({ 'main.js': 'while (true) {}' });
    await page.evaluate(() => {
        const s = document.querySelector('web-sandbox') as any;
        (window as any).termination = null;
        s.addEventListener('ready', () => { (window as any).readyAt = performance.now(); }, { once: true });
        s.addEventListener('terminated', (e: CustomEvent) => { (window as any).termination = { reason: e.detail.reason, elapsed: performance.now() - (window as any).readyAt }; }, { once: true });
    });
    await page.evaluate(START_LAG);
    expect(await sandbox.mount({ mode: 'strict', entry: 'main.js', watchdogTimeout: BUDGET })).toBe('ready');
    await page.waitForTimeout(300);
    const before = Date.now();
    expect(await page.evaluate(() => (window as any).termination)).toBeNull();
    expect(Date.now() - before).toBeLessThan(500); // the host is not blocked by the guest's loop

    await page.waitForFunction(() => (window as any).termination !== null, null, { timeout: DEADLINE + 2000 });
    const termination = await page.evaluate(() => (window as any).termination);
    expect(termination.reason).toBe(WATCHDOG_REASON);
    expect(termination.elapsed).toBeLessThan(DEADLINE);
    expect(await page.evaluate(LAG)).toBeLessThan(500);

    await sandbox.registerFiles({ 'main.js': 'bridge.expose("sum", (a, b) => a + b);' });
    expect(await sandbox.reset()).toBe('ready');
    expect(await sandbox.call('sum', 1, 2)).toBe(3);
});

test('strict mode: an endless loop through execute() is terminated within the budget on every engine, and reset() recovers', async ({ sandbox, page }) => {
    expect(await sandbox.mount({ mode: 'strict', watchdogTimeout: BUDGET })).toBe('ready');
    await expectWatchdogStopsLoop(sandbox, page);
});

test('strict mode: a worker that renders 256 Ki characters and then loops is terminated within the budget plus the measured stall of that one render; host round trips stay within one render\'s apply time', async ({ sandbox, page, browserName }) => {
    expect(await sandbox.mount({ mode: 'strict', watchdogTimeout: BUDGET })).toBe('ready');
    await page.evaluate(START_LAG);
    await page.evaluate(() => {
        const s = document.querySelector('web-sandbox') as any;
        (window as any).termination = null;
        const startedAt = performance.now();
        s.addEventListener('terminated', (e: CustomEvent) => {
            (window as any).termination = { reason: e.detail.reason, elapsed: performance.now() - startedAt };
        }, { once: true });
        s.execute(`sandboxView.render('<p>' + 'x'.repeat(${262144 - 8}) + '</p>'); while (true) {}`);
    });
    const roundTrips: number[] = [];
    while (await page.evaluate(() => (window as any).termination === null)) {
        const t = Date.now();
        await page.evaluate(() => 0);
        roundTrips.push(Date.now() - t);
        await page.waitForTimeout(50);
    }
    const termination = await page.evaluate(() => (window as any).termination);
    const stall = await page.evaluate(LAG);
    console.log(`MEASURED ${browserName} strict render-then-loop ${JSON.stringify({ stall, roundTripMax: Math.max(...roundTrips), elapsed: Math.round(termination.elapsed) })}`);
    expect(termination.reason).toBe(WATCHDOG_REASON);
    // the bound: 1.25 budgets after the last answer, plus slack, plus the host-thread stall the one render caused
    expect(termination.elapsed).toBeLessThan(DEADLINE + stall);
    // one render in flight bounds the host's stall to one apply: measured ≤ 10 ms (Chromium, out of process),
    // 30–60 ms (Firefox), 0.36–0.47 s (WebKit) for this render; the bounds leave room for a loaded machine. Chromium
    // can keep the view in the host's process too (broad review 2026-10-14), so its bound is Firefox's
    const bound = { chromium: 600, firefox: 600, webkit: 1500 }[browserName]!;
    expect(stall).toBeLessThan(bound);
    expect(Math.max(...roundTrips)).toBeLessThan(bound + 500);
});
