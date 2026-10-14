import { test, expect } from './fixture';
import { inView, waitInView } from './strict-view';

/**
 * Strict mode's render flow control (ADR-005, amendment A4; research 15 P7). Firefox and WebKit run the
 * view on the host page's thread, so every render the view applies is host-thread work. Guarantees:
 *   1. one render in flight: sandboxView.render() keeps the latest html per target and posts the next only
 *      after the view acknowledged the last, so any number of calls costs the view a bounded number of
 *      applies — deterministic: 10 000 synchronous calls are applied as exactly two renders, the first
 *      and the last;
 *   2. under a sustained flood of maximal renders (256 Ki characters, as fast as the flow control allows)
 *      the host's largest stall is one apply, and the worker still answers calls: bounded per engine.
 * Measured (this machine, Playwright 1.58 builds), host lag max / call round trip max under a 3 s flood:
 *   Chromium ≤ 10 ms / ≤ 15 ms when it ran the view out of process; Firefox 50–95 ms / 70–150 ms;
 *   WebKit 110–470 ms / 130–390 ms. Chromium may also keep the view in the host page's process (broad review
 *   2026-10-14: no iframe target, both frames local): then 45–130 ms / 65–180 ms alone (the same at 12d7924 and
 *   after the allowlist renderer, measured side by side), up to 364 ms lag with a second worker loading the machine. Not bounded here, and stated in ADR-005: what one apply of
 *   pathological markup costs (20 000 nested elements: ≈ 0.7 s per apply in Firefox and WebKit).
 * Evidence: applies counted in the view by a MutationObserver installed from outside (DevTools, never
 * the library); host lag from a 10 ms interval in the host page; round trips through call().
 */

const COUNT_APPLIES = `(() => { globalThis.__applies = 0; new MutationObserver((records) => { globalThis.__applies += records.length; }).observe(document.body, { childList: true }); return true; })()`;

test('10 000 synchronous render() calls reach the view as exactly two applies, the first and the last', async ({ sandbox, page, browserName }) => {
    expect(await sandbox.mount({ mode: 'strict' })).toBe('ready');
    expect(await inView(page, browserName, COUNT_APPLIES)).toBe(true);
    await sandbox.run(`for (let i = 0; i < 10000; i++) sandboxView.render('<p id="n' + i + '">' + i + '</p>');`);
    await waitInView(page, browserName, `!!document.getElementById('n9999')`);
    await page.waitForTimeout(500); // anything else in flight would have been applied by now
    expect(await inView(page, browserName, '[globalThis.__applies, document.body.innerHTML]')).toEqual([2, '<p id="n9999">9999</p>']);
});

test('per target: the latest html for each element id, one render in flight across targets', async ({ sandbox, page, browserName }) => {
    expect(await sandbox.mount({ mode: 'strict', html: '<div id="a"></div><div id="b"></div>' })).toBe('ready');
    await waitInView(page, browserName, `!!document.getElementById('b')`);
    expect(await inView(page, browserName, COUNT_APPLIES.replace('{ childList: true }', '{ childList: true, subtree: true }'))).toBe(true);
    await sandbox.run(`for (let i = 0; i < 1000; i++) { sandboxView.render('<i>a' + i + '</i>', 'a'); sandboxView.render('<i>b' + i + '</i>', 'b'); }`);
    await waitInView(page, browserName, `document.getElementById('a').textContent === 'a999' && document.getElementById('b').textContent === 'b999'`);
    await page.waitForTimeout(500);
    // a0 went out at once; then a999 and b999 (coalesced while a0 was in flight), one after the other
    expect(await inView(page, browserName, 'globalThis.__applies')).toBe(3);
});

const FLOODS: Record<string, string> = {
    'one word': `'<p>' + 'x'.repeat(262144 - 40) + '</p>'`,
    markup: `'<p>The quick brown fox jumps over the lazy dog, again and again.</p>'.repeat(3700)`,
};
// generous bounds per engine (a loaded CI machine), several times the measured values above
const BOUNDS: Record<string, { lag: number; roundTrip: number }> = {
    chromium: { lag: 600, roundTrip: 1500 }, // as Firefox: the view can share the host's thread here too
    firefox: { lag: 600, roundTrip: 1500 },
    webkit: { lag: 1500, roundTrip: 2500 },
};

for (const [name, expression] of Object.entries(FLOODS)) {
    test(`a 3 s flood of maximal renders (${name}): the host's largest stall is one apply, calls keep being answered, the last render wins`, async ({ sandbox, page, browserName }) => {
        test.setTimeout(30000);
        await sandbox.registerFiles({ 'flood.js': `
            const html = ${expression};
            bridge.expose('ping', () => 'pong');
            bridge.expose('flood', (ms) => new Promise((resolve) => {
                let n = 0;
                const end = Date.now() + ms;
                const tick = () => {
                    sandboxView.render(html + '<i id="last-' + n + '"></i>');
                    n++;
                    if (Date.now() < end) setTimeout(tick, 0);
                    else resolve(n);
                };
                tick();
            }));` });
        expect(await sandbox.mount({ mode: 'strict', entry: 'flood.js' })).toBe('ready');
        await page.evaluate(() => {
            const w = window as any;
            w.lag = { max: 0, last: performance.now() };
            w.lagTimer = setInterval(() => { const now = performance.now(); w.lag.max = Math.max(w.lag.max, now - w.lag.last - 10); w.lag.last = now; }, 10);
        });
        const flood = page.evaluate(() => (document.querySelector('web-sandbox') as any).call('flood', 3000));
        const roundTrips: number[] = [];
        const started = Date.now();
        while (Date.now() - started < 3000) {
            const t = Date.now();
            expect(await sandbox.call('ping')).toBe('pong');
            roundTrips.push(Date.now() - t);
            await page.waitForTimeout(100);
        }
        const rendered = await flood as number;
        await waitInView(page, browserName, `!!document.getElementById('last-${rendered - 1}')`, 8000); // the last render wins
        const lag = await page.evaluate(() => Math.round((window as any).lag.max));
        console.log(`MEASURED ${browserName} flood ${name} ${JSON.stringify({ rendered, lag, roundTripMax: Math.max(...roundTrips) })}`);
        expect(rendered).toBeGreaterThan(10);
        expect(lag).toBeLessThan(BOUNDS[browserName]!.lag);
        expect(Math.max(...roundTrips)).toBeLessThan(BOUNDS[browserName]!.roundTrip);
    });
}
