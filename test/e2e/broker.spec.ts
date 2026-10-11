import { test, expect, type CallOutcome } from './fixture';

/**
 * β — the bidirectional RPC broker (backlog B1), exercised across BOTH real realms (iframe and
 * worker). Tests and comments describe the GUARANTEE each case proves, never an attack recipe.
 *
 * Guest methods are registered by running `bridge.expose(...)` inside the sandbox (via execute,
 * which needs scriptUnsafe); host methods are registered from the harness page with el.expose().
 * The one case proving the call path needs no eval (scriptUnsafe:false) lives at the bottom.
 */

const MODES = ['iframe', 'worker'] as const;

// The host's own refusal texts (src/host.ts). A guest can produce the very same text; the code tells them apart.
const TERMINATION_TEXT = '[Sandbox] call() rejected: the sandbox was terminated. Call setConfig() or load() to start a new one.';
const RESET_TEXT = '[Sandbox] call() rejected: the sandbox was reset or terminated.';

// Refusal tests assert the exact code (backlog B7), never only that a call rejected or a message substring.
// Either way the error is a plain Error whose only own enumerable property is `code`.
function refused(code: string, message: string | RegExp): CallOutcome {
    return { status: 'rejected', isError: true, code, keys: ['code'], message: typeof message === 'string' ? message : expect.stringMatching(message) };
}
// A call refused with a code the other side reported (UNKNOWN_METHOD, HANDLER_ERROR, RESULT_NOT_TRANSFERABLE):
// the message is that side's text, verbatim.
const reported = refused;
// A call refused by the calling side itself, from its own state.
const localRefusal = refused;

// Trips the one-shot frame invariant (research 14.2) and resolves once the sandbox has terminated.
const TERMINATE_BY_SECOND_LOAD = () => new Promise<string>(resolve => {
    const s = document.querySelector('web-sandbox') as any;
    s.addEventListener('terminated', () => resolve('terminated'), { once: true });
    (s.shadowRoot.querySelector('iframe') as HTMLIFrameElement).srcdoc = '<p>second document</p>';
    setTimeout(() => resolve('nothing'), 3000);
});

for (const mode of MODES) {
    test.describe(`broker correctness (${mode}): a call resolves with its own handler result`, () => {
        test('host calls a guest method and receives its return value', async ({ sandbox }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('sum', '(a, b) => a + b');
            expect(await sandbox.call('sum', 1, 2)).toBe(3);
        });

        test('guest calls a host method and receives its return value', async ({ sandbox }) => {
            await sandbox.exposeHost('ping', '() => "pong"');
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.run(`bridge.call('ping').then(v => console.log('GUEST_GOT ' + v))`);
            expect(await sandbox.waitForLog('GUEST_GOT pong')).toContain('pong');
        });

        test('return values of every JSON-ish type round-trip, undefined included', async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('echo', '(x) => x');
            const report = await page.evaluate(async () => {
                const el = document.querySelector('web-sandbox') as any;
                const out: Record<string, unknown> = {};
                out.number = await el.call('echo', 42);
                out.string = await el.call('echo', 'hi');
                out.bool = await el.call('echo', true);
                out.nul = await el.call('echo', null);
                out.obj = await el.call('echo', { a: 1, b: 'x' });
                out.arr = await el.call('echo', [1, 2, 3]);
                out.nested = await el.call('echo', { a: [{ b: 2 }] });
                out.undef = await el.call('echo', undefined);
                return {
                    number: out.number === 42,
                    string: out.string === 'hi',
                    bool: out.bool === true,
                    nul: out.nul === null,
                    obj: JSON.stringify(out.obj) === JSON.stringify({ a: 1, b: 'x' }),
                    arr: JSON.stringify(out.arr) === JSON.stringify([1, 2, 3]),
                    nested: JSON.stringify(out.nested) === JSON.stringify({ a: [{ b: 2 }] }),
                    undefIsUndefined: out.undef === undefined,
                };
            });
            expect(report).toEqual({
                number: true, string: true, bool: true, nul: true,
                obj: true, arr: true, nested: true, undefIsUndefined: true,
            });
        });

        test('zero-arg and many-arg calls both work', async ({ sandbox }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('none', '() => "none"');
            await sandbox.exposeGuest('sumAll', '(...xs) => xs.reduce((s, n) => s + n, 0)');
            expect(await sandbox.call('none')).toBe('none');
            expect(await sandbox.call('sumAll', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10)).toBe(55);
        });

        test('async handlers deliver resolved values and propagate rejections', async ({ sandbox }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('asyncOk', '(x) => Promise.resolve(x * 2)');
            await sandbox.exposeGuest('asyncFail', '() => Promise.reject(new Error("async boom"))');
            expect(await sandbox.call('asyncOk', 21)).toBe(42);
            expect(await sandbox.callOutcome('asyncFail')).toEqual(reported('HANDLER_ERROR', 'async boom'));
        });

        test('concurrent calls resolving out of order each receive their own result', async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('after', '(ms, tag) => new Promise(r => setTimeout(() => r(tag), ms))');
            // A is slowest, B fastest: correlation (not arrival order) must put each tag back with its caller.
            const settled = await page.evaluate(async () => {
                const el = document.querySelector('web-sandbox') as any;
                return Promise.all([el.call('after', 60, 'A'), el.call('after', 10, 'B'), el.call('after', 30, 'C')]);
            });
            expect(settled).toEqual(['A', 'B', 'C']);
        });

        test('host and guest call each other at the same time and both resolve', async ({ sandbox, page }) => {
            await sandbox.exposeHost('hostAdd', '(a, b) => a + b');
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('guestMul', '(a, b) => a * b');
            const hostToGuest = await page.evaluate(async () => {
                const el = document.querySelector('web-sandbox') as any;
                el.execute(`bridge.call('hostAdd', 20, 22).then(v => console.log('GUEST_TO_HOST ' + v))`);
                return el.call('guestMul', 6, 7); // host -> guest, concurrently
            });
            expect(hostToGuest).toBe(42);
            expect(await sandbox.waitForLog('GUEST_TO_HOST 42')).toContain('42');
        });
    });

    test.describe(`broker errors (${mode}): failures reject the caller with the other side's code and a faithful message`, () => {
        test('a thrown Error rejects the caller with HANDLER_ERROR and the same message', async ({ sandbox }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('explode', '() => { throw new Error("boom") }');
            expect(await sandbox.callOutcome('explode')).toEqual(reported('HANDLER_ERROR', 'boom'));
        });

        test('a host call to an unknown guest method is refused with UNKNOWN_METHOD', async ({ sandbox }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            expect(await sandbox.callOutcome('notRegistered')).toEqual(reported('UNKNOWN_METHOD', 'unknown method: notRegistered'));
        });

        test('a guest call to an unknown host method is refused with UNKNOWN_METHOD, as seen by the guest', async ({ sandbox }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            expect(await sandbox.guestOutcome(`bridge.call('notOnHost')`)).toEqual(reported('UNKNOWN_METHOD', 'unknown method: notOnHost'));
        });

        test('a handler throwing a non-Error still rejects with HANDLER_ERROR and the broker keeps serving', async ({ sandbox }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('throwStr', '() => { throw "just a string" }');
            await sandbox.exposeGuest('stillWorks', '() => "ok"');
            expect(await sandbox.callOutcome('throwStr')).toEqual(reported('HANDLER_ERROR', 'just a string'));
            expect(await sandbox.call('stillWorks')).toBe('ok'); // dispatch loop survived the non-Error throw
        });

        test('a host call with a non-string method name is refused with INVALID_CALL', async ({ sandbox }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            expect(await sandbox.callOutcome(123)).toEqual(localRefusal('INVALID_CALL', 'RPC method name must be a string'));
        });
    });

    test.describe(`broker refusal codes (${mode}): a refusal's code is set only by the side that refuses`, () => {
        test('a guest handler cannot make the host see a termination: the same text arrives as HANDLER_ERROR', async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            const text = JSON.stringify(TERMINATION_TEXT);
            // Each handler reproduces the host's termination refusal as closely as guest code can: same text,
            // and a code of its choosing on the thrown value.
            await sandbox.exposeGuest('impersonateThrow', `() => { const e = new Error(${text}); e.code = 'TERMINATED'; throw e; }`);
            await sandbox.exposeGuest('impersonateReject', `() => { const e = new Error(${text}); e.code = 'TERMINATED'; return Promise.reject(e); }`);
            await sandbox.exposeGuest('impersonatePlain', `() => { throw { message: ${text}, code: 'TERMINATED' }; }`);
            for (const method of ['impersonateThrow', 'impersonateReject', 'impersonatePlain']) {
                expect(await sandbox.callOutcome(method), method).toEqual(reported('HANDLER_ERROR', TERMINATION_TEXT));
            }
            // The real thing, for contrast: the same text, but the code only the host can set.
            expect(await page.evaluate(TERMINATE_BY_SECOND_LOAD)).toBe('terminated');
            expect(await sandbox.callOutcome('impersonateThrow')).toEqual(localRefusal('TERMINATED', TERMINATION_TEXT));
        });

        test('a host call that is never answered is refused with TIMEOUT', async ({ sandbox }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('hang', '() => new Promise(() => {})');
            expect(await sandbox.callWithTimeoutOutcome(200, 'hang')).toEqual(localRefusal('TIMEOUT', 'RPC timeout after 200ms: hang'));
        });

        test('a guest call that is never answered is refused with TIMEOUT, as seen by the guest', async ({ sandbox }) => {
            await sandbox.exposeHost('hostHang', '() => new Promise(() => {})');
            expect(await sandbox.mount({ mode })).toBe('ready');
            expect(await sandbox.guestOutcome(`bridge.callWithTimeout(200, 'hostHang')`)).toEqual(localRefusal('TIMEOUT', 'RPC timeout after 200ms: hostHang'));
        });
    });

    test.describe(`broker defensive guarantees (${mode}): only the allowlist is callable`, () => {
        const RESERVED = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__'];

        test('reserved and inherited names are rejected and invoke nothing (host to guest)', async ({ sandbox }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('real', '() => "real"'); // a real method so the registry is non-empty
            for (const name of RESERVED) {
                expect(await sandbox.callOutcome(name), name).toEqual(reported('UNKNOWN_METHOD', `unknown method: ${name}`));
            }
            // The guest's Object.prototype was never written through a reserved name (neutral sentinel).
            await sandbox.run(`console.log('GUEST_PROTO_CLEAN ' + (({}).__registryTouched === undefined) + ' ' + (Object.prototype.__registryTouched === undefined))`);
            expect(await sandbox.waitForLog(/GUEST_PROTO_CLEAN/)).toBe('GUEST_PROTO_CLEAN true true');
            // Lookup is allowlist-only, so the real method still resolves after all the reserved probes.
            expect(await sandbox.call('real')).toBe('real');
        });

        test('reserved and inherited names are rejected and invoke nothing (guest to host)', async ({ sandbox, page }) => {
            await sandbox.exposeHost('realHost', '() => { window.__realHostRuns = (window.__realHostRuns || 0) + 1; return "realHost"; }');
            expect(await sandbox.mount({ mode })).toBe('ready');
            // Asserted from inside the guest, the refused side: every probe is refused with the host's UNKNOWN_METHOD.
            const outcome = await sandbox.guestOutcome(`Promise.all(${JSON.stringify(RESERVED)}.map(n => bridge.call(n).then(
                () => 'RESOLVED',
                e => ({ code: e.code, keys: Object.keys(e), message: e.message }))))`);
            expect(outcome).toEqual({
                status: 'resolved',
                value: RESERVED.map(name => ({ code: 'UNKNOWN_METHOD', keys: ['code'], message: `unknown method: ${name}` })),
            });
            // No host handler ran for any probe.
            expect(await page.evaluate(() => (window as any).__realHostRuns ?? 0)).toBe(0);
            // The host's Object.prototype was never written through a reserved name.
            const clean = await page.evaluate(() => ({} as any).__registryTouched === undefined && (Object.prototype as any).__registryTouched === undefined);
            expect(clean).toBe(true);
            // The real host method still resolves (allowlist intact).
            await sandbox.run(`bridge.call('realHost').then(v => console.log('HOST_REAL ' + v))`);
            expect(await sandbox.waitForLog('HOST_REAL realHost')).toContain('realHost');
        });
    });

    test.describe(`broker lifecycle (${mode}): calls never hang`, () => {
        test('a call queued before the port is ready still resolves', async ({ sandbox, page }) => {
            void sandbox; // the fixture loads the harness; this case drives setConfig() directly, not mount()
            const result = await page.evaluate(async (mode) => {
                const s = document.querySelector('web-sandbox') as any;
                s.setConfig({ capabilities: ['allow-scripts'], scriptUnsafe: true, mode });
                // Issued BEFORE the port exists: expose (queued execute) and call (queued RPC) must survive the wait.
                s.execute(`bridge.expose('add', (a, b) => a + b)`);
                const pending = s.call('add', 2, 3);
                return pending;
            }, mode);
            expect(result).toBe(5);
        });

        test('a pending call is refused with TERMINATED when the sandbox is re-initialized', async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('hang', '() => new Promise(() => {})'); // never settles on its own
            const outcome = await page.evaluate(() => {
                const el = document.querySelector('web-sandbox') as any;
                const p = el.call('hang').then(
                    () => ({ status: 'resolved' }),
                    (e: any) => ({ status: 'rejected', isError: e instanceof Error, message: e.message, code: e.code, keys: Object.keys(e) }));
                el.load('<p>reinit</p>'); // re-init tears the environment down: the in-flight call must reject
                return p;
            });
            expect(outcome).toEqual(localRefusal('TERMINATED', RESET_TEXT));
        });

        test('a pending call is refused with TERMINATED when the sandbox terminates on a second frame load', async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('hang', '() => new Promise(() => {})');
            const outcome = await page.evaluate(() => new Promise<unknown>(resolve => {
                const s = document.querySelector('web-sandbox') as any;
                const p = s.call('hang').then(
                    () => ({ status: 'resolved' }),
                    (e: any) => ({ status: 'rejected', isError: e instanceof Error, message: e.message, code: e.code, keys: Object.keys(e) }));
                s.addEventListener('terminated', async () => resolve(await p), { once: true });
                // A second load trips the one-shot invariant (research 14.2) and terminates the sandbox.
                (s.shadowRoot.querySelector('iframe') as HTMLIFrameElement).srcdoc = '<p>second document</p>';
            }));
            expect(outcome).toEqual(localRefusal('TERMINATED', RESET_TEXT));
        });

        test('calls made after terminate are refused promptly with TERMINATED', async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            expect(await page.evaluate(TERMINATE_BY_SECOND_LOAD)).toBe('terminated');
            expect(await sandbox.callOutcome('anything')).toEqual(localRefusal('TERMINATED', TERMINATION_TEXT));
            expect(await sandbox.callWithTimeoutOutcome(5000, 'anything')).toEqual(localRefusal('TERMINATED', TERMINATION_TEXT));
        });

        test('host methods persist across frame recreation; guest methods are per-frame', async ({ sandbox }) => {
            await sandbox.exposeHost('hostId', '(x) => "host:" + x');
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('guestId', '(x) => "guest:" + x');
            expect(await sandbox.call('guestId', 'a')).toBe('guest:a');
            await sandbox.run(`bridge.call('hostId', 'a').then(v => console.log('H1 ' + v))`);
            expect(await sandbox.waitForLog('H1 host:a')).toContain('host:a');

            expect(await sandbox.load('<p>reinit</p>')).toBe('ready'); // new frame, new guest broker

            // Host method persisted on the element.
            await sandbox.run(`bridge.call('hostId', 'b').then(v => console.log('H2 ' + v))`);
            expect(await sandbox.waitForLog('H2 host:b')).toContain('host:b');
            // Guest method is gone until re-exposed in the new frame.
            expect(await sandbox.callOutcome('guestId', 'a')).toEqual(reported('UNKNOWN_METHOD', 'unknown method: guestId'));
            await sandbox.exposeGuest('guestId', '(x) => "guest2:" + x');
            expect(await sandbox.call('guestId', 'a')).toBe('guest2:a');
        });
    });

    test.describe(`broker transferability (${mode}): a call with a non-transferable value fails only itself, promptly`, () => {
        // Each call below gets a long explicit timeout, so a stalled call would surface as a TIMEOUT
        // refusal; asserting the code proves it failed promptly, for the stated reason, instead.

        test('a guest handler returning a non-transferable value refuses the host call with RESULT_NOT_TRANSFERABLE', async ({ sandbox }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('giveFn', '() => () => 1');
            expect(await sandbox.callWithTimeoutOutcome(5000, 'giveFn')).toEqual(reported('RESULT_NOT_TRANSFERABLE', /^result is not transferable: /));
        });

        test('a host handler returning a non-transferable value refuses the guest call with RESULT_NOT_TRANSFERABLE, as seen by the guest', async ({ sandbox }) => {
            await sandbox.exposeHost('giveFn', '() => () => 1');
            expect(await sandbox.mount({ mode })).toBe('ready');
            expect(await sandbox.guestOutcome(`bridge.callWithTimeout(5000, 'giveFn')`)).toEqual(reported('RESULT_NOT_TRANSFERABLE', /^result is not transferable: /));
        });

        test('a host call with a non-transferable argument is refused with ARGS_NOT_TRANSFERABLE, runs no guest handler, and the next call still works', async ({ sandbox }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('echo', '(x) => { globalThis.__echoRuns = (globalThis.__echoRuns || 0) + 1; return x; }');
            await sandbox.exposeGuest('echoRuns', '() => globalThis.__echoRuns || 0');
            // The function is built in the page: a Playwright argument cannot carry one.
            const bad = await sandbox.page.evaluate(() => (document.querySelector('web-sandbox') as any)
                .callWithTimeout(5000, 'echo', () => 1)
                .then(() => ({ status: 'resolved' }), (e: any) => ({ status: 'rejected', isError: e instanceof Error, message: e.message, code: e.code, keys: Object.keys(e) })));
            expect(bad).toEqual(localRefusal('ARGS_NOT_TRANSFERABLE', /^RPC arguments are not transferable: /));
            expect(await sandbox.call('echoRuns')).toBe(0); // the guest handler never ran
            expect(await sandbox.call('echo', 5)).toBe(5);
            expect(await sandbox.call('echoRuns')).toBe(1);
        });

        test('a guest call with a non-transferable argument is refused with ARGS_NOT_TRANSFERABLE, runs no host handler, and the next call still works', async ({ sandbox, page }) => {
            await sandbox.exposeHost('echo', '(x) => { window.__hostEchoRuns = (window.__hostEchoRuns || 0) + 1; return x; }');
            expect(await sandbox.mount({ mode })).toBe('ready');
            expect(await sandbox.guestOutcome(`bridge.callWithTimeout(5000, 'echo', () => 1)`)).toEqual(localRefusal('ARGS_NOT_TRANSFERABLE', /^RPC arguments are not transferable: /));
            expect(await page.evaluate(() => (window as any).__hostEchoRuns ?? 0)).toBe(0); // the host handler never ran
            expect(await sandbox.guestOutcome(`bridge.call('echo', 5)`)).toEqual({ status: 'resolved', value: 5 });
            expect(await page.evaluate(() => (window as any).__hostEchoRuns ?? 0)).toBe(1);
        });

        test('a non-transferable call queued before ready does not block ready, and a valid call queued after it resolves', async ({ sandbox, page }) => {
            void sandbox; // the fixture loads the harness; this case drives setConfig() directly, not mount()
            const outcome = await page.evaluate(async (mode) => {
                const s = document.querySelector('web-sandbox') as any;
                const ready = new Promise<string>(resolve => {
                    s.addEventListener('ready', () => resolve('ready'), { once: true });
                    setTimeout(() => resolve('no ready event'), 5000);
                });
                s.setConfig({ capabilities: ['allow-scripts'], scriptUnsafe: true, mode });
                // All three are issued before the port exists.
                s.execute(`bridge.expose('add', (a, b) => { globalThis.__addRuns = (globalThis.__addRuns || 0) + 1; return a + b; })`);
                s.execute(`bridge.expose('addRuns', () => globalThis.__addRuns || 0)`);
                const bad = s.callWithTimeout(5000, 'add', () => 1).then(() => 'RESOLVED', (e: any) => 'REJECTED:' + e.code);
                const good = s.callWithTimeout(5000, 'add', 2, 3).then((v: unknown) => 'VALUE:' + v, (e: any) => 'REJECTED:' + e.code);
                return { ready: await ready, bad: await bad, good: await good, addRuns: await s.call('addRuns') };
            }, mode);
            // The refused call ran no handler: 'add' ran once, for the valid call.
            expect(outcome).toEqual({ ready: 'ready', bad: 'REJECTED:ARGS_NOT_TRANSFERABLE', good: 'VALUE:5', addRuns: 1 });
        });

        test('an unpostable answer produced after a re-init is dropped with the old port: the next frame still becomes ready', async ({ sandbox, page }) => {
            const warnings: string[] = [];
            page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });
            // The host handler re-initializes the sandbox, then returns a value structured clone cannot carry.
            // Its answer goes back on the port the request arrived on, which the re-init closed, so it is dropped
            // there — it is never queued for the next frame, so there is nothing to skip at flush time either.
            await sandbox.exposeHost('reloadThenGiveFn', `() => { document.querySelector('web-sandbox').load('<p>next frame</p>'); return () => 1; }`);
            expect(await sandbox.mount({ mode })).toBe('ready');
            const outcome = await page.evaluate(() => new Promise<string>(resolve => {
                const s = document.querySelector('web-sandbox') as any;
                s.addEventListener('ready', () => resolve('ready'), { once: true });
                setTimeout(() => resolve('no ready event'), 5000);
                s.execute(`bridge.call('reloadThenGiveFn')`);
            }));
            expect(outcome).toBe('ready');
            expect(warnings.filter(w => w.includes('could not be posted'))).toEqual([]);
            // The next frame serves calls normally.
            await sandbox.exposeGuest('sum', '(a, b) => a + b');
            expect(await sandbox.call('sum', 2, 3)).toBe(5);
        });
    });

    test.describe(`broker generation isolation (${mode}): a response is delivered only to the frame generation that asked for it`, () => {
        // Guest ids restart at 1 in every frame, so a late answer to the previous frame's first call carries
        // the very id of the next frame's first call. Each case keeps the next frame's first call (id 1)
        // pending exactly when that late answer is produced: a leak would settle it with 'STALE'.

        test('a host answer produced after a re-init is never delivered to the next frame (new port already up)', async ({ sandbox, page }) => {
            // Parks its answer until released, and flags that the request reached the host.
            await sandbox.exposeHost('stale', `() => new Promise(resolve => {
                window.__staleAsked = true;
                window.__releaseStale = () => resolve('STALE answer meant for the previous frame');
            })`);
            // The next frame's first call releases the parked answer while it is itself still pending.
            await sandbox.exposeHost('whoami', `() => {
                window.__releaseStale();
                return new Promise(resolve => setTimeout(() => resolve('fresh answer for the next frame'), 50));
            }`);
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.run(`bridge.call('stale')`); // the previous frame's first call: id 1
            await page.waitForFunction(() => (window as any).__staleAsked === true);

            expect(await sandbox.load('<p>next frame</p>')).toBe('ready');
            await sandbox.run(`bridge.call('whoami').then(v => console.log('NEXT_FRAME_GOT ' + v))`); // the next frame's first call: id 1
            expect(await sandbox.waitForLog('NEXT_FRAME_GOT')).toBe('NEXT_FRAME_GOT fresh answer for the next frame');
        });

        test('a host answer produced after a re-init is never delivered to the next frame (no port yet)', async ({ sandbox }) => {
            await sandbox.exposeHost('whoami', `() => 'fresh answer for the next frame'`);
            // Re-initializes, queues the next frame's first call, then answers while no port exists at all
            // (between the teardown and the next setupChannel).
            await sandbox.exposeHost('reloadThenAnswer', `() => {
                const el = document.querySelector('web-sandbox');
                el.load('<p>next frame</p>');
                el.execute("bridge.call('whoami').then(v => console.log('NEXT_FRAME_GOT ' + v))");
                return 'STALE answer meant for the previous frame';
            }`);
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.run(`bridge.call('reloadThenAnswer')`); // the previous frame's first call: id 1
            expect(await sandbox.waitForLog('NEXT_FRAME_GOT', 8000)).toBe('NEXT_FRAME_GOT fresh answer for the next frame');
        });
    });
}

test.describe('broker transferability (iframe): calls made by guest markup before the port exists', () => {
    // iframe only: a worker guest has no markup, so none of its code can run before the port arrives.
    test('a non-transferable call from guest markup is refused with ARGS_NOT_TRANSFERABLE and a valid call queued after it still resolves', async ({ sandbox, page }) => {
        await sandbox.exposeHost('echo', '(x) => { window.__hostEchoRuns = (window.__hostEchoRuns || 0) + 1; return x; }');
        // Both calls run at parse time, before INIT_PORT. The outcome is logged from the valid call's
        // .then, which only runs once the port (and with it the console relay) is up.
        expect(await sandbox.mount({
            mode: 'iframe',
            html: `<script>
                let bad = 'still pending';
                bridge.call('echo', () => 1).catch(e => { bad = e.code; });
                bridge.call('echo', 7).then(v => console.log('GUEST_QUEUED value=' + v + ' | ' + bad));
            </script>`,
        })).toBe('ready');
        const line = await sandbox.waitForLog('GUEST_QUEUED', 8000);
        expect(line).toBe('GUEST_QUEUED value=7 | ARGS_NOT_TRANSFERABLE');
        expect(await page.evaluate(() => (window as any).__hostEchoRuns)).toBe(1); // only the valid call ran the handler
    });
});

test.describe('broker without scriptUnsafe (iframe): the call path needs no eval', () => {
    test('host to guest call works with scriptUnsafe:false', async ({ sandbox }) => {
        // The guest registers its method from an inline <script> in its markup — allowed by
        // script-src 'unsafe-inline', NOT eval — so the whole call path runs with scriptUnsafe:false.
        expect(await sandbox.mount({
            mode: 'iframe',
            scriptUnsafe: false,
            html: `<script>bridge.expose('sum', (a, b) => a + b)</script>`,
        })).toBe('ready');
        expect(await sandbox.call('sum', 4, 5)).toBe(9);
    });
});
