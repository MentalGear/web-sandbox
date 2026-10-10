import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBroker } from './rpc';

// A pair of brokers wired straight into each other: a call on one is served by the other.
// Timeouts are disabled here so no real timer lingers; timeout behaviour has its own suite.
// (No structured clone happens on this path — clone fidelity is covered by the e2e specs,
// which run across real iframe/worker realms.)
function wirePair() {
    let a: any, b: any;
    a = createBroker((frame) => b.handleMessage(frame), { timeoutMs: 0 });
    b = createBroker((frame) => a.handleMessage(frame), { timeoutMs: 0 });
    return { a, b };
}

describe('correlation and round-trip (guarantee: a call resolves with its own handler result)', () => {
    it('resolves a call with the handler return value', async () => {
        const { a, b } = wirePair();
        b.expose('sum', (x: number, y: number) => x + y);
        expect(await a.call('sum', 2, 3)).toBe(5);
    });

    it('awaits an async handler and delivers its resolved value', async () => {
        const { a, b } = wirePair();
        b.expose('slow', async (x: number) => x * 2);
        expect(await a.call('slow', 21)).toBe(42);
    });

    it('rejects the caller when the handler returns a rejected promise', async () => {
        const { a, b } = wirePair();
        b.expose('bad', () => Promise.reject(new Error('nope')));
        await expect(a.call('bad')).rejects.toThrow('nope');
    });

    it('correlates several concurrent calls that settle out of order', async () => {
        const { a, b } = wirePair();
        b.expose('echoAfter', (ms: number, tag: string) => new Promise(r => setTimeout(() => r(tag), ms)));
        // B finishes first, then C, then A — each caller must still get its own tag back.
        const settled = await Promise.all([
            a.call('echoAfter', 30, 'A'),
            a.call('echoAfter', 5, 'B'),
            a.call('echoAfter', 15, 'C'),
        ]);
        expect(settled).toEqual(['A', 'B', 'C']);
    });

    it('handles zero args and many args', async () => {
        const { a, b } = wirePair();
        b.expose('none', () => 'none');
        b.expose('sumAll', (...xs: number[]) => xs.reduce((s, n) => s + n, 0));
        expect(await a.call('none')).toBe('none');
        expect(await a.call('sumAll', 1, 2, 3, 4, 5)).toBe(15);
    });

    it('resolves bidirectional calls happening at once', async () => {
        const { a, b } = wirePair();
        a.expose('aMethod', (x: number) => x + 1);
        b.expose('bMethod', (x: number) => x * 10);
        const settled = await Promise.all([a.call('bMethod', 5), b.call('aMethod', 5)]);
        expect(settled).toEqual([50, 6]);
    });
});

describe('error handling (guarantee: failures reject the caller with a faithful message)', () => {
    it('rejects with a thrown Error message', async () => {
        const { a, b } = wirePair();
        b.expose('boom', () => { throw new Error('kaboom'); });
        await expect(a.call('boom')).rejects.toThrow('kaboom');
    });

    it('rejects an unknown method with a clear message', async () => {
        const { a } = wirePair();
        await expect(a.call('ghost')).rejects.toThrow('unknown method: ghost');
    });

    it('rejects a thrown string and keeps serving later calls', async () => {
        const { a, b } = wirePair();
        b.expose('throwStr', () => { throw 'stringy'; });
        b.expose('good', () => 'ok');
        await expect(a.call('throwStr')).rejects.toThrow('stringy');
        expect(await a.call('good')).toBe('ok'); // the dispatch loop survived the non-Error throw
    });

    it('rejects a thrown plain object with a sensible message', async () => {
        const { a, b } = wirePair();
        b.expose('throwObj', () => { throw { code: 1 }; });
        await expect(a.call('throwObj')).rejects.toThrow('[object Object]');
    });

    it('rejects a thrown undefined', async () => {
        const { a, b } = wirePair();
        b.expose('throwUndef', () => { throw undefined; });
        await expect(a.call('throwUndef')).rejects.toThrow('undefined');
    });
});

describe('defensive guarantees (guarantee: only the allowlist is callable, nothing inherited)', () => {
    const RESERVED = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__'];

    it('rejects reserved/inherited names, invokes nothing, and never mutates Object.prototype', () => {
        const sent: any[] = [];
        const responder = createBroker((f) => sent.push(f), { timeoutMs: 0 });
        const real = vi.fn(() => 'real');
        responder.expose('real', real);

        for (const name of RESERVED) {
            sent.length = 0;
            // An unknown name is answered synchronously (no handler runs), so `sent` is ready at once.
            responder.handleMessage({ type: 'RPC_REQ', id: 1, method: name, args: [] });
            expect(sent, name).toHaveLength(1);
            expect(sent[0], name).toMatchObject({ type: 'RPC_RES', id: 1, ok: false });
            expect(sent[0].error, name).toContain('unknown method');
        }

        expect(real).not.toHaveBeenCalled();
        // A neutral sentinel proves no reserved name wrote through to the prototype chain.
        expect(({} as any).__registryTouched).toBeUndefined();
        expect((Object.prototype as any).__registryTouched).toBeUndefined();
    });

    it('still serves a real method after reserved-name probes (allowlist intact)', async () => {
        const { a, b } = wirePair();
        b.expose('real', () => 'real');
        for (const name of RESERVED) {
            await expect(a.call(name)).rejects.toThrow('unknown method');
        }
        expect(await a.call('real')).toBe('real');
    });

    const MALFORMED: Array<[string, unknown]> = [
        ['null', null],
        ['undefined', undefined],
        ['a number', 42],
        ['a string', 'nope'],
        ['no type', { id: 1, method: 'm', args: [] }],
        ['non-string type', { type: 7 }],
        ['req without id', { type: 'RPC_REQ', method: 'm', args: [] }],
        ['req with object id', { type: 'RPC_REQ', id: {}, method: 'm', args: [] }],
        ['req with non-string method', { type: 'RPC_REQ', id: 1, method: 5, args: [] }],
        ['req with non-array args', { type: 'RPC_REQ', id: 1, method: 'm', args: 'x' }],
        ['res with unknown id', { type: 'RPC_RES', id: 999, ok: true, value: 1 }],
    ];
    it.each(MALFORMED)('ignores a malformed frame (%s) without throwing or responding', (_label, frame) => {
        const sent: any[] = [];
        const b = createBroker((f) => sent.push(f), { timeoutMs: 0 });
        expect(() => b.handleMessage(frame as any)).not.toThrow();
        expect(sent).toEqual([]);
    });

    it('rejects a non-string method name on the call path', async () => {
        const b = createBroker(() => {}, { timeoutMs: 0 });
        await expect(b.call(123 as any)).rejects.toThrow('must be a string');
    });

    it('only calls explicitly exposed methods', async () => {
        const { a, b } = wirePair();
        b.expose('allowed', () => 'yes');
        expect(await a.call('allowed')).toBe('yes');
        await expect(a.call('toString')).rejects.toThrow('unknown method');
    });
});

describe('response correlation edge cases (guarantee: stale/duplicate responses cannot cross calls)', () => {
    it('ignores a response with an unknown id', () => {
        const sent: any[] = [];
        const b = createBroker((f) => sent.push(f), { timeoutMs: 0 });
        expect(() => b.handleMessage({ type: 'RPC_RES', id: 123, ok: true, value: 1 })).not.toThrow();
    });

    it('ignores a duplicate response and never leaks it into another pending call', async () => {
        const frames: any[] = [];
        const broker = createBroker((f) => frames.push(f), { timeoutMs: 0 });
        const p1 = broker.call('m1');
        const p2 = broker.call('m2');
        const id1 = frames[0].id;
        const id2 = frames[1].id;

        let p2settled = false;
        p2.then(() => { p2settled = true; }, () => { p2settled = true; });

        broker.handleMessage({ type: 'RPC_RES', id: id1, ok: true, value: 'first' });
        broker.handleMessage({ type: 'RPC_RES', id: id1, ok: true, value: 'DUPLICATE' }); // must be ignored
        expect(await p1).toBe('first');

        await Promise.resolve();
        expect(p2settled).toBe(false); // the duplicate did not settle a different call

        broker.handleMessage({ type: 'RPC_RES', id: id2, ok: true, value: 'second' });
        expect(await p2).toBe('second');
    });
});

describe('timeouts (guarantee: a call that is never answered rejects rather than hanging)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('rejects a never-answered call after the default timeout', async () => {
        const b = createBroker(() => {}); // send goes nowhere, so no response ever arrives
        const p = b.call('silent');
        const rejected = expect(p).rejects.toThrow(/timeout/i);
        await vi.advanceTimersByTimeAsync(30_000);
        await rejected;
    });

    it('honors a per-call timeout override', async () => {
        const b = createBroker(() => {});
        const p = b.callWithTimeout(50, 'silent');
        const rejected = expect(p).rejects.toThrow(/timeout after 50ms/);
        await vi.advanceTimersByTimeAsync(50);
        await rejected;
    });

    it('does not time out a call answered before its deadline', async () => {
        let other: any;
        const one = createBroker((f) => other.handleMessage(f), { timeoutMs: 1000 });
        other = createBroker((f) => one.handleMessage(f), { timeoutMs: 1000 });
        other.expose('ping', () => 'pong');
        // The answer rides microtasks, not timers, so it resolves without advancing the clock.
        expect(await one.call('ping')).toBe('pong');
    });
});

describe('lifecycle (guarantee: teardown settles pending calls; re-expose replaces)', () => {
    it('rejectAllPending rejects every in-flight call with the given reason', async () => {
        const b = createBroker(() => {}, { timeoutMs: 0 });
        const p1 = b.call('a');
        const p2 = b.call('b');
        b.rejectAllPending(new Error('torn down'));
        await expect(p1).rejects.toThrow('torn down');
        await expect(p2).rejects.toThrow('torn down');
    });

    it('re-exposing a name replaces the previous handler (last registration wins)', async () => {
        const { a, b } = wirePair();
        b.expose('m', () => 'first');
        b.expose('m', () => 'second');
        expect(await a.call('m')).toBe('second');
    });

    it('ignores a non-function handler passed to expose', async () => {
        const { a, b } = wirePair();
        (b.expose as any)('bad', 123);
        await expect(a.call('bad')).rejects.toThrow('unknown method');
    });
});

describe('non-transferable values (guarantee: a call with a non-transferable value fails only itself, promptly)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    // Like wirePair, but every frame goes through structured clone, exactly as postMessage clones it.
    function wireClonedPair(timeoutMs: number) {
        let a: any, b: any;
        a = createBroker((frame) => b.handleMessage(structuredClone(frame)), { timeoutMs });
        b = createBroker((frame) => a.handleMessage(structuredClone(frame)), { timeoutMs });
        return { a, b };
    }

    const NON_TRANSFERABLE: Array<[string, () => unknown]> = [
        ['a function', () => () => 1],
        ['a symbol', () => Symbol('s')],
    ];
    it.each(NON_TRANSFERABLE)('a handler returning %s rejects the caller promptly with a not-transferable message', async (_label, make) => {
        const { a, b } = wireClonedPair(10_000);
        b.expose('give', () => make());

        const settled = vi.fn();
        a.callWithTimeout(10_000, 'give').then(settled, (e: Error) => settled(e.message));
        // Lets the answer ride its microtasks; a stalled call would only settle once the clock reached 10s.
        await vi.advanceTimersByTimeAsync(1);

        expect(settled).toHaveBeenCalledTimes(1);
        const message = settled.mock.calls[0]?.[0];
        expect(message).toContain('not transferable');
        expect(message).not.toContain('timeout');
    });

    it('a call with a non-transferable argument rejects at once, sending nothing and arming no timer', async () => {
        const sent: unknown[] = [];
        const b = createBroker((frame) => sent.push(structuredClone(frame)), { timeoutMs: 10_000 });
        await expect(b.call('echo', () => 1)).rejects.toThrow('arguments are not transferable');
        expect(sent).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a normal call after a non-transferable argument still works (no leaked pending state)', async () => {
        const { a, b } = wireClonedPair(10_000);
        b.expose('echo', (x: unknown) => x);
        await expect(a.call('echo', Symbol('s'))).rejects.toThrow('arguments are not transferable');
        expect(await a.call('echo', 7)).toBe(7);
        expect(vi.getTimerCount()).toBe(0); // the good call's timer was cleared when it settled
    });

    it('a send that throws rejects the call and leaves no pending entry or timer behind', async () => {
        let failNextSend = true;
        let other: any;
        const one = createBroker((frame) => {
            if (failNextSend) {
                failNextSend = false;
                throw new Error('port unavailable');
            }
            other.handleMessage(frame);
        }, { timeoutMs: 10_000 });
        other = createBroker((frame) => one.handleMessage(frame), { timeoutMs: 0 });
        other.expose('ping', () => 'pong');

        await expect(one.call('ping')).rejects.toThrow('port unavailable');
        expect(vi.getTimerCount()).toBe(0); // the failed call left no timer armed
        expect(await one.call('ping')).toBe('pong'); // and the broker carries on
    });
});

describe('reply routing (guarantee: a response goes back only on the channel its request arrived on)', () => {
    it('routes every response kind through reply when one is given, never through send', async () => {
        const send = vi.fn();
        const replies: any[] = [];
        // reply clones like postMessage does, so a non-transferable result really fails to post
        const reply = (frame: unknown) => { replies.push(structuredClone(frame)); };
        const broker = createBroker(send, { timeoutMs: 0 });
        broker.expose('ok', () => 'value');
        broker.expose('throws', () => { throw new Error('boom'); });
        broker.expose('giveFn', () => () => 1);

        broker.handleMessage({ type: 'RPC_REQ', id: 1, method: 'ok', args: [] }, reply);
        broker.handleMessage({ type: 'RPC_REQ', id: 2, method: 'throws', args: [] }, reply);
        broker.handleMessage({ type: 'RPC_REQ', id: 3, method: 'missing', args: [] }, reply);
        broker.handleMessage({ type: 'RPC_REQ', id: 4, method: 'giveFn', args: [] }, reply);
        await new Promise(resolve => setTimeout(resolve, 0)); // handlers settle on microtasks

        expect(send).not.toHaveBeenCalled();
        expect(replies).toHaveLength(4);
        const byId = new Map(replies.map(frame => [frame.id, frame]));
        expect(byId.get(1)).toEqual({ type: 'RPC_RES', id: 1, ok: true, value: 'value' });          // success
        expect(byId.get(2)).toEqual({ type: 'RPC_RES', id: 2, ok: false, error: 'boom' });          // handler error
        expect(byId.get(3)).toEqual({ type: 'RPC_RES', id: 3, ok: false, error: 'unknown method: missing' });
        expect(byId.get(4)).toMatchObject({ type: 'RPC_RES', id: 4, ok: false });                   // not transferable
        expect(byId.get(4).error).toContain('result is not transferable');
    });

    it('falls back to send when no reply is given (the guest has a single port per frame)', async () => {
        const sent: unknown[] = [];
        const broker = createBroker((frame) => sent.push(frame), { timeoutMs: 0 });
        broker.expose('ok', () => 'value');
        broker.handleMessage({ type: 'RPC_REQ', id: 1, method: 'ok', args: [] });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(sent).toEqual([{ type: 'RPC_RES', id: 1, ok: true, value: 'value' }]);
    });
});
