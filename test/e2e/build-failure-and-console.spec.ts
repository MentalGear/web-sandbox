import { test, expect, startAs, buildOfMode } from './fixture';
import { VIEW_MODES } from './view-modes';

// The build with the network modes (ADR-009): this file's tests mount them. A sealed test names the default build.
test.use({ build: 'network' });

/**
 * The build's failures and the console (BL:B8 and the follow-up of AR), in real browsers:
 *   - a config start() cannot use is refused with its reason, before anything is stored or built, and a usable config
 *     starts;
 *   - backlog B8: console.info is relayed like log, warn and error; execute() and call() follow one rule while
 *     the element is not in the document.
 * The workerExecutionTimeout budget (B8) is asserted in test/e2e/worker-timeout.spec.ts. Evidence: the element's
 * state and events and its 'sandbox-log' details, read on the host page.
 */

test('an origins kind given a string instead of a list: start() throws the reason and the element stays without an app; a usable config starts it', async ({ sandbox, page }) => {
    expect(await startAs(page, { mode: 'cooperative', capabilities: ['allow-scripts'], origins: { images: "x; script-src *" } })).toEqual({ refused: '[Sandbox] start(): origins.images must be a list of origins.' });
    expect(await page.evaluate(() => [document.querySelectorAll('web-sandbox').length, (document.querySelector('web-sandbox') as any).started])).toEqual([1, false]);
    expect(await sandbox.terminations()).toEqual([]);
    expect(await sandbox.mount()).toBe('ready');
});

for (const mode of ['cooperative', 'worker', ...VIEW_MODES] as const) {
    test.describe(`${mode} mode`, () => {
    test.use({ build: buildOfMode(mode) });
    test(`${mode} mode: console.info is relayed as level 'info' with source 'guest', like log, warn and error`, async ({ sandbox, page }) => {
        expect(await sandbox.mount({ mode })).toBe('ready');
        await page.evaluate(() => {
            (window as any).levels = [];
            document.querySelector('web-sandbox')!.addEventListener('sandbox-log', (e: Event) => {
                const detail = (e as CustomEvent).detail;
                if (String(detail.args[0]).startsWith('relay-')) (window as any).levels.push([detail.level, detail.source, detail.args[0]]);
            });
        });
        await sandbox.run(`console.log('relay-log'); console.info('relay-info'); console.warn('relay-warn'); console.error('relay-error');`);
        await sandbox.waitForLog('relay-error');
        expect(await page.evaluate(() => (window as any).levels)).toEqual([
            ['log', 'guest', 'relay-log'], ['info', 'guest', 'relay-info'], ['warn', 'guest', 'relay-warn'], ['error', 'guest', 'relay-error'],
        ]);
    });
    });
}

test('not in the document: call() rejects at once with TERMINATED and execute() runs nothing, also after insertion; once inserted both work (positive control)', async ({ sandbox, page }) => {
    const report = await page.evaluate(async () => {
        const s = document.createElement('web-sandbox') as any;
        s.id = 'detached';
        s.start({}, { mode: 'cooperative', capabilities: ['allow-scripts'], scriptUnsafe: true });
        const early = await Promise.race([
            s.call('anything').then(() => 'resolved', (e: any) => e.code),
            new Promise(resolve => setTimeout(() => resolve('still pending'), 200)),
        ]);
        s.execute('console.log("ran-while-detached")');
        const ready = new Promise(resolve => s.addEventListener('ready', resolve, { once: true }));
        document.body.appendChild(s);
        await ready;
        s.execute('console.log("ran-once-inserted")');
        return { early, state: s.state };
    });
    expect(report).toEqual({ early: 'TERMINATED', state: 'ready' });
    await sandbox.waitForLog('ran-once-inserted');
    await page.waitForTimeout(300);
    expect((await sandbox.logs()).filter(line => line.includes('ran-while-detached'))).toEqual([]);
});
