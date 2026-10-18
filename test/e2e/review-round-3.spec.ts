import { test, expect, type MountConfig } from './fixture';

/**
 * Review round 3: the findings where the browser decides, on Chromium, Firefox and WebKit: what structured clone makes
 * of an error nested in a logged value (C-3), when a custom element's lifecycle callbacks run during a move (L-1), and
 * when structured clone runs an argument's getter (L-2). Each test failed at 16c545b. The library's own logic is
 * unit-tested in test/unit/review-round-3.test.ts.
 */

const MODES: Record<string, MountConfig> = {
    cooperative: { mode: 'cooperative' },
    worker: { mode: 'worker' },
    strict: { mode: 'strict', scriptUnsafe: true },
};

test.describe('C-3: an error nested in a logged value crosses as { name, message, stack }', () => {
    for (const [mode, config] of Object.entries(MODES)) {
        test(`${mode} mode: in an object, an array and Promise.allSettled results; no line says "byte budget"`, async ({ sandbox, page }) => {
            expect(await sandbox.mount(config)).toBe('ready');
            await page.evaluate(() => {
                (window as any).details = [];
                document.querySelector('web-sandbox')!.addEventListener('sandbox-log', (event: any) => {
                    if (event.detail.args[0] === 'NESTED') (window as any).details.push(event.detail.args);
                });
            });
            await sandbox.run(`Promise.allSettled([Promise.reject(new TypeError('t'))]).then(settled => console.log('NESTED', { error: new Error('boom') }, [new RangeError('r')], settled))`);
            const args = await page.waitForFunction(() => (window as any).details[0]).then(handle => handle.jsonValue());
            expect(args).toEqual([
                'NESTED',
                { error: { name: 'Error', message: 'boom', stack: expect.any(String) } },
                [{ name: 'RangeError', message: 'r', stack: expect.any(String) }],
                [{ status: 'rejected', reason: { name: 'TypeError', message: 't', stack: expect.any(String) } }],
            ]);
        });
    }
});

test.describe('L-1: moved from a terminated listener after a refused build, the element is terminated, not idle', () => {
    for (const [name, config] of [
        ["an old mode ('iframe')", { mode: 'iframe', capabilities: ['allow-scripts'] }],
        ['an unregistered entry', { mode: 'strict', entry: 'missing.js' }],
    ] as const) {
        test(name, async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode: 'cooperative' })).toBe('ready');
            const result = await page.evaluate(async (config) => {
                const el = document.querySelector('web-sandbox') as any;
                const slot = document.createElement('div');
                document.body.appendChild(slot);
                const events: string[] = [];
                el.addEventListener('ready', () => events.push('ready'));
                el.addEventListener('terminated', (event: CustomEvent) => {
                    events.push('terminated');
                    slot.appendChild(el);
                });
                el.setConfig(config);
                await new Promise(resolve => setTimeout(resolve, 300));
                const code = await el.call('anything').then(() => 'resolved', (error: any) => error.code);
                return { connected: el.isConnected, state: el.state, frames: el.shadowRoot.querySelectorAll('iframe').length, events, code };
            }, config as Record<string, unknown>);
            expect(result).toEqual({ connected: true, state: 'terminated', frames: 0, events: ['terminated'], code: 'TERMINATED' });
        });
    }
});

test.describe("L-2: a call whose argument's getter ends the environment settles", () => {
    for (const end of ['terminate', 'remove', 'reset']) {
        test(`${end}() in the getter: TERMINATED at once`, async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode: 'cooperative' })).toBe('ready');
            await sandbox.exposeGuest('echo', '(value) => value');
            const outcome = await page.evaluate(async (end) => {
                const el = document.querySelector('web-sandbox') as any;
                const call = el.callWithTimeout(0, 'echo', { get x() { el[end](); return 1; } });
                return Promise.race([
                    call.then(() => 'resolved', (error: any) => error.code),
                    new Promise(resolve => setTimeout(() => resolve('never settled'), 2000)),
                ]);
            }, end);
            expect(outcome).toBe('TERMINATED');
        });
    }
});

test.describe('M-2: callLimits, a lower budget than the default', () => {
    for (const [mode, config] of Object.entries(MODES)) {
        test(`${mode} mode: maxPerSecond 10: the guest's 11th call in one second is refused BUSY before it is sent; the host method ran 10 times`, async ({ sandbox, page }) => {
            expect(await sandbox.mount({ ...config, callLimits: { maxPerSecond: 10 } })).toBe('ready');
            await page.evaluate(() => {
                (window as any).hostRuns = 0;
                (document.querySelector('web-sandbox') as any).expose('count', () => ++(window as any).hostRuns);
            });
            const outcomes = await sandbox.inGuest(`
                const calls = [];
                for (let i = 0; i < 11; i++) calls.push(bridge.call('count').then(() => 'ok', (error) => error.code));
                return Promise.all(calls);
            `);
            expect(outcomes).toEqual([...Array(10).fill('ok'), 'BUSY']);
            expect(await page.evaluate(() => (window as any).hostRuns)).toBe(10);
        });
    }
});
