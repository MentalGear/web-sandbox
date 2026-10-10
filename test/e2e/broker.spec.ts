import { test, expect } from './fixture';

/**
 * β — the bidirectional RPC broker (backlog B1), exercised across BOTH real realms (iframe and
 * worker). Tests and comments describe the GUARANTEE each case proves, never an attack recipe.
 *
 * Guest methods are registered by running `bridge.expose(...)` inside the sandbox (via execute,
 * which needs scriptUnsafe); host methods are registered from the harness page with el.expose().
 * The one case proving the call path needs no eval (scriptUnsafe:false) lives at the bottom.
 */

const MODES = ['iframe', 'worker'] as const;

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
            expect(await sandbox.callOutcome('asyncFail')).toContain('async boom');
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

    test.describe(`broker errors (${mode}): failures reject the caller with a faithful message`, () => {
        test('a thrown Error rejects the caller with the same message', async ({ sandbox }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('explode', '() => { throw new Error("boom") }');
            expect(await sandbox.callOutcome('explode')).toContain('boom');
        });

        test('calling an unknown method rejects with an unknown-method message', async ({ sandbox }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            expect(await sandbox.callOutcome('notRegistered')).toContain('unknown method: notRegistered');
        });

        test('a handler throwing a non-Error still rejects and the broker keeps serving', async ({ sandbox }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('throwStr', '() => { throw "just a string" }');
            await sandbox.exposeGuest('stillWorks', '() => "ok"');
            expect(await sandbox.callOutcome('throwStr')).toContain('just a string');
            expect(await sandbox.call('stillWorks')).toBe('ok'); // dispatch loop survived the non-Error throw
        });
    });

    test.describe(`broker defensive guarantees (${mode}): only the allowlist is callable`, () => {
        const RESERVED = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__'];

        test('reserved and inherited names are rejected and invoke nothing (host to guest)', async ({ sandbox }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('real', '() => "real"'); // a real method so the registry is non-empty
            for (const name of RESERVED) {
                expect(await sandbox.callOutcome(name), name).toContain('unknown method');
            }
            // The guest's Object.prototype was never written through a reserved name (neutral sentinel).
            await sandbox.run(`console.log('GUEST_PROTO_CLEAN ' + (({}).__registryTouched === undefined) + ' ' + (Object.prototype.__registryTouched === undefined))`);
            expect(await sandbox.waitForLog(/GUEST_PROTO_CLEAN/)).toBe('GUEST_PROTO_CLEAN true true');
            // Lookup is allowlist-only, so the real method still resolves after all the reserved probes.
            expect(await sandbox.call('real')).toBe('real');
        });

        test('reserved and inherited names are rejected and invoke nothing (guest to host)', async ({ sandbox, page }) => {
            await sandbox.exposeHost('realHost', '() => "realHost"');
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.run(`
                const names = ['__proto__','constructor','prototype','toString','valueOf','hasOwnProperty','__defineGetter__'];
                Promise.all(names.map(n => bridge.call(n).then(() => 'RESOLVED', () => 'rejected')))
                    .then(rs => console.log('GUEST_RESULTS ' + rs.join(',')));
            `);
            const line = await sandbox.waitForLog('GUEST_RESULTS');
            expect(line).not.toContain('RESOLVED');
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

        test('a pending call rejects when the sandbox is re-initialized', async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('hang', '() => new Promise(() => {})'); // never settles on its own
            const outcome = await page.evaluate(() => {
                const el = document.querySelector('web-sandbox') as any;
                const p = el.call('hang').then(() => 'RESOLVED', (e: any) => 'REJECTED:' + e.message);
                el.load('<p>reinit</p>'); // re-init tears the environment down: the in-flight call must reject
                return p;
            });
            expect(outcome).toContain('REJECTED');
        });

        test('a pending call rejects when the sandbox terminates on a second frame load', async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('hang', '() => new Promise(() => {})');
            const outcome = await page.evaluate(() => new Promise<string>(resolve => {
                const s = document.querySelector('web-sandbox') as any;
                const p = s.call('hang').then(() => 'RESOLVED', (e: any) => 'REJECTED:' + e.message);
                s.addEventListener('terminated', async () => resolve(await p), { once: true });
                // A second load trips the one-shot invariant (research 14.2) and terminates the sandbox.
                (s.shadowRoot.querySelector('iframe') as HTMLIFrameElement).srcdoc = '<p>second document</p>';
            }));
            expect(outcome).toContain('REJECTED');
        });

        test('calls made after terminate reject promptly', async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            const terminated = await page.evaluate(() => new Promise<string>(resolve => {
                const s = document.querySelector('web-sandbox') as any;
                s.addEventListener('terminated', () => resolve('terminated'), { once: true });
                (s.shadowRoot.querySelector('iframe') as HTMLIFrameElement).srcdoc = '<p>second document</p>';
                setTimeout(() => resolve('nothing'), 3000);
            }));
            expect(terminated).toBe('terminated');
            const outcome = await sandbox.callOutcome('anything');
            expect(outcome).toContain('REJECTED');
            expect(outcome).toContain('terminated');
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
            expect(await sandbox.callOutcome('guestId', 'a')).toContain('unknown method');
            await sandbox.exposeGuest('guestId', '(x) => "guest2:" + x');
            expect(await sandbox.call('guestId', 'a')).toBe('guest2:a');
        });
    });

    test.describe(`broker transferability (${mode}): a call with a non-transferable value fails only itself, promptly`, () => {
        // Each call below gets a long explicit timeout, so a stalled call would surface as an
        // "RPC timeout" rejection; asserting the message proves it failed promptly instead.

        test('a guest handler returning a non-transferable value rejects the host call promptly, not by timeout', async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('giveFn', '() => () => 1');
            const outcome = await page.evaluate(() => (document.querySelector('web-sandbox') as any)
                .callWithTimeout(5000, 'giveFn')
                .then(() => 'RESOLVED', (e: any) => 'REJECTED:' + e.message));
            expect(outcome).toContain('not transferable');
            expect(outcome).not.toContain('timeout');
        });

        test('a host handler returning a non-transferable value rejects the guest call promptly, not by timeout', async ({ sandbox }) => {
            await sandbox.exposeHost('giveFn', '() => () => 1');
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.run(`bridge.callWithTimeout(5000, 'giveFn').then(
                () => console.log('RESULT_OUTCOME RESOLVED'),
                e => console.log('RESULT_OUTCOME REJECTED:' + e.message))`);
            const line = await sandbox.waitForLog('RESULT_OUTCOME', 8000);
            expect(line).toContain('not transferable');
            expect(line).not.toContain('timeout');
        });

        test('a host call with a non-transferable argument rejects promptly and the next call still works', async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.exposeGuest('echo', '(x) => x');
            const outcome = await page.evaluate(async () => {
                const el = document.querySelector('web-sandbox') as any;
                const bad = await el.callWithTimeout(5000, 'echo', () => 1).then(() => 'RESOLVED', (e: any) => 'REJECTED:' + e.message);
                const next = await el.call('echo', 5);
                return { bad, next };
            });
            expect(outcome.bad).toContain('arguments are not transferable');
            expect(outcome.next).toBe(5);
        });

        test('a guest call with a non-transferable argument rejects promptly and the next call still works', async ({ sandbox }) => {
            await sandbox.exposeHost('echo', '(x) => x');
            expect(await sandbox.mount({ mode })).toBe('ready');
            await sandbox.run(`
                bridge.callWithTimeout(5000, 'echo', () => 1)
                    .then(() => 'RESOLVED', e => 'REJECTED:' + e.message)
                    .then(bad => bridge.call('echo', 5).then(next => console.log('ARG_OUTCOME ' + bad + ' | next=' + next)));
            `);
            const line = await sandbox.waitForLog('ARG_OUTCOME', 8000);
            expect(line).toContain('arguments are not transferable');
            expect(line).toContain('next=5');
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
                s.execute(`bridge.expose('add', (a, b) => a + b)`);
                const bad = s.callWithTimeout(5000, 'add', () => 1).then(() => 'RESOLVED', (e: any) => 'REJECTED:' + e.message);
                const good = s.callWithTimeout(5000, 'add', 2, 3).then((v: unknown) => 'VALUE:' + v, (e: any) => 'REJECTED:' + e.message);
                return { ready: await ready, bad: await bad, good: await good };
            }, mode);
            expect(outcome).toEqual({ ready: 'ready', bad: expect.stringContaining('arguments are not transferable'), good: 'VALUE:5' });
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
    test('a non-transferable call from guest markup rejects at once and a valid call queued after it still resolves', async ({ sandbox }) => {
        await sandbox.exposeHost('echo', '(x) => x');
        // Both calls run at parse time, before INIT_PORT. The outcome is logged from the valid call's
        // .then, which only runs once the port (and with it the console relay) is up.
        expect(await sandbox.mount({
            mode: 'iframe',
            html: `<script>
                let bad = 'still pending';
                bridge.call('echo', () => 1).catch(e => { bad = e.message; });
                bridge.call('echo', 7).then(v => console.log('GUEST_QUEUED value=' + v + ' | ' + bad));
            </script>`,
        })).toBe('ready');
        const line = await sandbox.waitForLog('GUEST_QUEUED', 8000);
        expect(line).toContain('value=7');
        expect(line).toContain('arguments are not transferable');
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
