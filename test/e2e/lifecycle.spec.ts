import { test, expect, type CallOutcome } from './fixture';

/**
 * The element's lifecycle (backlog B2, ADR-003): `state` follows idle → loading → ready and agrees
 * with the 'ready' and 'terminated' events when they fire; terminate() fires 'terminated' exactly once;
 * reset() builds a fresh environment from any state; removing the element tears it down without a
 * termination, and re-inserting it brings it back. Every pending call settles: never a hang.
 */

const MODES = ['cooperative', 'worker', 'strict'] as const;

const RESET_TEXT = '[Sandbox] call() rejected: the sandbox was reset or terminated.';
const TERMINATION_TEXT = '[Sandbox] call() rejected: the sandbox was terminated. Call reset(), setConfig() or load() to start a new one.';

function terminatedRefusal(message: string): CallOutcome {
    return { status: 'rejected', isError: true, code: 'TERMINATED', keys: ['code'], message };
}

for (const mode of MODES) {
    test.describe(`lifecycle (${mode})`, () => {
        test('state goes idle → loading → ready as the element is mounted, and reads ready when the event fires', async ({ sandbox, page }) => {
            void sandbox; // loads the harness; this case builds its own element
            const report = await page.evaluate(async (mode) => {
                const el = document.createElement('web-sandbox') as any;
                const seen: string[] = [el.state];
                el.setConfig({ capabilities: ['allow-scripts'], scriptUnsafe: true, mode }); // detached: config only
                seen.push(el.state);
                const framesWhileDetached = el.shadowRoot.querySelectorAll('iframe').length;
                const atReady = new Promise(resolve => el.addEventListener('ready', () => resolve(el.state), { once: true }));
                document.body.appendChild(el);
                seen.push(el.state);
                const stateInReadyListener = await atReady;
                seen.push(el.state);
                return { seen, framesWhileDetached, stateInReadyListener };
            }, mode);
            expect(report).toEqual({ seen: ['idle', 'idle', 'loading', 'ready'], framesWhileDetached: 0, stateInReadyListener: 'ready' });
        });

        test('terminate() fires terminated exactly once with its reason, settles pending calls and refuses later ones', async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('hang', '() => new Promise(() => {})'); // never settles on its own
            const report = await page.evaluate(async () => {
                const s = document.querySelector('web-sandbox') as any;
                const events: { reason: unknown; state: string }[] = [];
                s.addEventListener('terminated', (e: CustomEvent) => events.push({ reason: e.detail.reason, state: s.state }));
                const pending = settleOutcome(s.call('hang'));
                s.terminate('stopped by the test');
                s.terminate('a second time'); // already terminated: nothing happens
                await new Promise(r => setTimeout(r, 200));
                return {
                    events,
                    state: s.state,
                    pending: await pending,
                    later: await settleOutcome(s.call('anything')),
                    frames: s.shadowRoot.querySelectorAll('iframe').length,
                };
            });
            expect(report).toEqual({
                events: [{ reason: 'stopped by the test', state: 'terminated' }],
                state: 'terminated',
                pending: terminatedRefusal(RESET_TEXT),
                later: terminatedRefusal(TERMINATION_TEXT),
                frames: 0,
            });
        });

        test('terminate() without a reason still fires once, with a default reason', async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            const reasons = await page.evaluate(async () => {
                const s = document.querySelector('web-sandbox') as any;
                const seen: unknown[] = [];
                s.addEventListener('terminated', (e: CustomEvent) => seen.push(e.detail.reason));
                s.terminate();
                s.terminate();
                await new Promise(r => setTimeout(r, 100));
                return seen;
            });
            expect(reasons).toEqual(['terminated by the host']);
        });

        test('a frame-integrity termination reads terminated when the event fires, and a later terminate() adds no second event', async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            const report = await page.evaluate(() => new Promise<unknown>(resolve => {
                const s = document.querySelector('web-sandbox') as any;
                const events: { reason: unknown; state: string }[] = [];
                s.addEventListener('terminated', (e: CustomEvent) => {
                    events.push({ reason: e.detail.reason, state: s.state });
                    s.terminate('ignored: already terminated');
                    setTimeout(() => resolve(events), 200);
                });
                // A second load trips the one-shot invariant (research 14.2).
                (s.shadowRoot.querySelector('iframe') as HTMLIFrameElement).srcdoc = '<p>second document</p>';
            }));
            expect(report).toEqual([{ reason: 'the sandbox frame loaded a second time', state: 'terminated' }]);
        });

        test('reset() from ready gives a fresh document: guest globals and guest methods are gone, host methods persist, pending calls are refused', async ({ sandbox, page }) => {
            await sandbox.exposeHost('hostEcho', '(x) => "host:" + x');
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('hang', '() => new Promise(() => {})');
            await sandbox.run('globalThis.lifecycleMarker = "old"; console.log("MARKER " + typeof globalThis.lifecycleMarker)');
            expect(await sandbox.waitForLog('MARKER ')).toBe('MARKER string');
            const pending = await page.evaluate(() => {
                const s = document.querySelector('web-sandbox') as any;
                (s.shadowRoot.querySelector('iframe') as HTMLIFrameElement).dataset.generation = 'old';
                (window as any).pendingAcrossReset = settleOutcome(s.call('hang'));
                return true;
            });
            expect(pending).toBe(true);

            expect(await sandbox.reset()).toBe('ready');
            expect(await sandbox.state()).toBe('ready');

            expect(await page.evaluate(() => (window as any).pendingAcrossReset)).toEqual(terminatedRefusal(RESET_TEXT));
            const frames = await page.evaluate(() => {
                const list = (document.querySelector('web-sandbox') as any).shadowRoot.querySelectorAll('iframe');
                return { count: list.length, generation: list[0]?.dataset.generation ?? null };
            });
            expect(frames).toEqual({ count: 1, generation: null }); // a new frame element, not the old one reloaded

            await sandbox.clearLogs();
            await sandbox.run('console.log("MARKER " + typeof globalThis.lifecycleMarker)');
            expect(await sandbox.waitForLog('MARKER ')).toBe('MARKER undefined');
            expect(await sandbox.callOutcome('hang')).toEqual({ status: 'rejected', isError: true, code: 'UNKNOWN_METHOD', keys: ['code'], message: 'unknown method: hang' });
            await sandbox.run(`bridge.call('hostEcho', 'after-reset').then(v => console.log('HOST_REPLY ' + v))`);
            expect(await sandbox.waitForLog('HOST_REPLY')).toBe('HOST_REPLY host:after-reset');
        });

        test('reset() from terminated builds a working sandbox again', async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await page.evaluate(() => (document.querySelector('web-sandbox') as any).terminate('before reset'));
            expect(await sandbox.state()).toBe('terminated');

            expect(await sandbox.reset()).toBe('ready');
            expect(await sandbox.state()).toBe('ready');
            await sandbox.exposeGuest('sum', '(a, b) => a + b');
            expect(await sandbox.call('sum', 2, 3)).toBe(5);
        });

        test('removing the element refuses pending calls with TERMINATED and leaves it idle without a terminated event; re-inserting brings it back', async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('hang', '() => new Promise(() => {})');
            const report = await page.evaluate(async () => {
                const s = document.querySelector('web-sandbox') as any;
                let terminatedEvents = 0;
                s.addEventListener('terminated', () => terminatedEvents++);
                const pending = settleOutcome(s.call('hang'));
                s.remove();
                const whileRemoved = { state: s.state, pending: await pending, frames: s.shadowRoot.querySelectorAll('iframe').length };
                const atReady = new Promise(resolve => s.addEventListener('ready', () => resolve(s.state), { once: true }));
                document.body.appendChild(s);
                const stateOnInsert = s.state;
                const stateInReadyListener = await atReady;
                return { whileRemoved, stateOnInsert, stateInReadyListener, terminatedEvents };
            });
            expect(report).toEqual({
                whileRemoved: { state: 'idle', pending: terminatedRefusal(RESET_TEXT), frames: 0 },
                stateOnInsert: 'loading',
                stateInReadyListener: 'ready',
                terminatedEvents: 0,
            });

            // The config survived: the re-inserted sandbox runs guest code and answers calls.
            await sandbox.exposeGuest('sum', '(a, b) => a + b');
            expect(await sandbox.call('sum', 4, 5)).toBe(9);
        });
    });
}
