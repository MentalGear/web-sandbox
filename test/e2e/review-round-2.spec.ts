import { test, expect, type MountConfig } from './fixture';

/**
 * Review round 2 (reviewer C): the findings where the browser decides, on Chromium, Firefox and WebKit. Each test failed
 * at 31b8f0d. The host page's own policy (C-5, C-6) is in host-policy.spec.ts, the package's hash (C-8) in package.spec.ts.
 */

const MODES: Record<string, MountConfig> = {
    cooperative: { mode: 'cooperative' },
    worker: { mode: 'worker' },
    strict: { mode: 'strict', scriptUnsafe: true },
};

// RPC_MAX_BYTES is 33 MiB: 18 million UTF-16 code units are past it.
const PAST_BUDGET = 18_000_000;
// (A RegExp is measured by its source too, unit-tested: WebKit refuses a pattern this long before it is ever returned.)

test.describe('C-3: what a call answers is measured as it is posted, by an allow-list', () => {
    for (const [mode, config] of Object.entries(MODES)) {
        test(`${mode} mode: a guest method answering a large Error or ImageData is refused RESULT_NOT_TRANSFERABLE (each measured ~16 bytes before); a small answer resolves`, async ({ sandbox }) => {
            expect(await sandbox.mount(config)).toBe('ready');
            await sandbox.exposeGuest('bigError', `() => new Error('x'.repeat(${PAST_BUDGET}))`);
            await sandbox.exposeGuest('bigImage', `() => new ImageData(3000, 3000)`); // 36 MB of pixels
            await sandbox.exposeGuest('twoFaced', `() => { let reads = 0; return { get x() { return ++reads === 1 ? 'small' : 'x'.repeat(${PAST_BUDGET}); } }; }`);
            await sandbox.exposeGuest('small', `() => ({ list: [1, 'two', 3n], when: new Date(0), re: /a/g })`);
            const outcomes = await sandbox.page.evaluate(async (names) => {
                const el = document.querySelector('web-sandbox') as any;
                const results: Record<string, unknown> = {};
                for (const name of names) {
                    results[name] = await el.callWithTimeout(20000, name).then(
                        (value: any) => (name === 'twoFaced' ? `resolved ${String(value?.x).length}` : name === 'small' ? `resolved ${value.list.length} ${value.re.source}` : 'resolved'),
                        (error: any) => error.code,
                    );
                }
                return results;
            }, ['bigError', 'bigImage', 'twoFaced', 'small']);
            expect(outcomes).toEqual({
                bigError: 'RESULT_NOT_TRANSFERABLE',
                bigImage: 'RESULT_NOT_TRANSFERABLE',
                twoFaced: 'resolved 5', // the snapshot measured is the one posted: the getter is read once
                small: 'resolved 3 a',
            });
        });
    }
});
