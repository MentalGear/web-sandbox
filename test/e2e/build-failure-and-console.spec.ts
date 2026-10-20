import { test, expect } from './fixture';

/**
 * The build's failures and the console (BL:B8 and the follow-up of AR), in real browsers:
 *   - every build failure is a termination: a config the build cannot use ends the sandbox with a reason, the
 *     state and the event agree, and a usable config starts it again;
 *   - backlog B8: console.info is relayed like log, warn and error; execute() and call() follow one rule while
 *     the element is not in the document.
 * The workerExecutionTimeout budget (B8) is asserted in test/e2e/worker-timeout.spec.ts. Evidence: the element's
 * state and events and its 'sandbox-log' details, read on the host page.
 */

test('an origins kind given a string instead of a list: setConfig() does not throw, the sandbox terminates with the reason and no frame; a usable config starts it again', async ({ sandbox, page }) => {
    const outcome = await page.evaluate(() => new Promise<unknown>(resolve => {
        const s = document.querySelector('web-sandbox') as any;
        let thrown: unknown = null;
        s.addEventListener('terminated', (e: CustomEvent) => resolve({ reason: e.detail.reason, state: s.state, frames: s.shadowRoot.querySelectorAll('iframe').length, thrown }), { once: true });
        try {
            s.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], origins: { images: "x; script-src *" } });
        } catch (error) {
            thrown = String(error);
        }
    }));
    expect(outcome).toEqual({ reason: 'the configuration could not be used (TypeError)', state: 'terminated', frames: 0, thrown: null });
    expect(await sandbox.mount()).toBe('ready');
});

for (const mode of ['cooperative', 'worker', 'strict'] as const) {
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
}

test('not in the document: call() rejects at once with TERMINATED and execute() runs nothing, also after insertion; once inserted both work (positive control)', async ({ sandbox, page }) => {
    const report = await page.evaluate(async () => {
        const s = document.createElement('web-sandbox') as any;
        s.id = 'detached';
        s.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], scriptUnsafe: true });
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
