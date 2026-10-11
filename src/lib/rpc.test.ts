import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBroker, type RpcErrorCode, type RpcPeerCode } from './rpc';

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

// Like wirePair, but every frame goes through structured clone, exactly as postMessage clones it.
function wireClonedPair(timeoutMs: number) {
    let a: any, b: any;
    a = createBroker((frame) => b.handleMessage(structuredClone(frame)), { timeoutMs });
    b = createBroker((frame) => a.handleMessage(structuredClone(frame)), { timeoutMs });
    return { a, b };
}

// Settles a call that must be refused and returns what its caller can branch on. Refusal tests assert
// the exact code (and peerCode), never only that the call rejected or that its message contains a word.
async function refusal(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (error: any) {
        return { isError: error instanceof Error, code: error?.code, peerCode: error?.peerCode, message: error?.message };
    }
    throw new Error('expected the call to be refused, but it resolved');
}

// A broker whose outbound frames are captured, so a test can answer its calls with any frame it likes:
// the test plays the other side, and the broker under test is the refused side.
function capturedBroker(timeoutMs = 0) {
    const frames: any[] = [];
    const broker = createBroker((frame) => frames.push(frame), { timeoutMs });
    // Issues one call and returns a function that answers it with `response` (id filled in).
    function callAnsweredWith(response: Record<string, unknown>) {
        const promise = broker.call('anything');
        const id = frames[frames.length - 1].id;
        broker.handleMessage({ type: 'RPC_RES', id, ...response });
        return promise;
    }
    return { broker, frames, callAnsweredWith };
}

// The texts the host uses for its own termination refusals (src/host.ts). A peer can send these verbatim.
const TERMINATION_TEXT = '[Sandbox] call() rejected: the sandbox was terminated. Call setConfig() or load() to start a new one.';
const RESET_TEXT = '[Sandbox] call() rejected: the sandbox was reset or terminated.';

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

describe('refusal codes are wire protocol (guarantee: the set of code strings is closed and fixed)', () => {
    // Changing any of these strings breaks callers that branch on them, and the wire between two
    // differently built sides. Both lists are checked against the exported types at compile time too.
    const ERROR_CODES = ['TIMEOUT', 'TERMINATED', 'NOT_TRANSFERABLE', 'SEND_FAILED', 'INVALID_CALL', 'PEER_ERROR'] as const;
    const PEER_CODES = ['UNKNOWN_METHOD', 'HANDLER_ERROR', 'RESULT_NOT_TRANSFERABLE'] as const;
    // Fails to type-check if a code is added to, or removed from, the exported unions without updating the pins.
    const errorCodesExhaustive: [Exclude<RpcErrorCode, typeof ERROR_CODES[number]>] extends [never] ? true : false = true;
    const peerCodesExhaustive: [Exclude<RpcPeerCode, typeof PEER_CODES[number]>] extends [never] ? true : false = true;

    it('every refusal path yields exactly the pinned code strings, as own properties of a plain Error', async () => {
        expect(errorCodesExhaustive && peerCodesExhaustive).toBe(true);
        const { a, b } = wireClonedPair(0);
        b.expose('throws', () => { throw new Error('boom'); });
        b.expose('giveFn', () => () => 1);
        const hung = createBroker(() => {}, { timeoutMs: 0 });
        const failingSend = createBroker(() => { throw new Error('port unavailable'); }, { timeoutMs: 0 });

        const errors: any[] = [];
        const collect = (p: Promise<unknown>) => p.then(() => { throw new Error('resolved'); }, (e) => { errors.push(e); });
        await collect(createBroker(() => {}, { timeoutMs: 1 }).call('silent'));          // TIMEOUT
        const pendingAtTeardown = collect(hung.call('never'));
        hung.rejectAllPending(RESET_TEXT);
        await pendingAtTeardown;                                                         // TERMINATED
        await collect(Promise.reject(hung.terminationError(TERMINATION_TEXT)));          // TERMINATED
        await collect(a.call('echo', () => 1));                                          // NOT_TRANSFERABLE
        await collect(failingSend.call('ping'));                                         // SEND_FAILED
        await collect(a.call(123 as any));                                               // INVALID_CALL
        await collect(a.call('ghost'));                                                  // PEER_ERROR / UNKNOWN_METHOD
        await collect(a.call('throws'));                                                 // PEER_ERROR / HANDLER_ERROR
        await collect(a.call('giveFn'));                                                 // PEER_ERROR / RESULT_NOT_TRANSFERABLE

        expect(errors.map(e => e.code)).toEqual([
            'TIMEOUT', 'TERMINATED', 'TERMINATED', 'NOT_TRANSFERABLE', 'SEND_FAILED', 'INVALID_CALL',
            'PEER_ERROR', 'PEER_ERROR', 'PEER_ERROR',
        ]);
        expect(errors.map(e => e.peerCode)).toEqual([
            undefined, undefined, undefined, undefined, undefined, undefined,
            'UNKNOWN_METHOD', 'HANDLER_ERROR', 'RESULT_NOT_TRANSFERABLE',
        ]);
        expect(new Set(errors.map(e => e.code))).toEqual(new Set(ERROR_CODES));
        expect(new Set(errors.map(e => e.peerCode).filter(Boolean))).toEqual(new Set(PEER_CODES));
        for (const error of errors) {
            // A plain Error, not a subclass: the broker is stringified into the guest and must close over nothing.
            expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
            expect(Object.hasOwn(error, 'code')).toBe(true);
        }
    });

    it('the responder puts exactly the pinned peer code on the wire for each failure', async () => {
        const replies: any[] = [];
        // reply clones like postMessage does, so a non-transferable result really fails to post
        const responder = createBroker(() => {}, { timeoutMs: 0 });
        const reply = (frame: unknown) => { replies.push(structuredClone(frame)); };
        responder.expose('throws', () => { throw new Error('boom'); });
        responder.expose('rejects', () => Promise.reject(new Error('async boom')));
        responder.expose('giveFn', () => () => 1);

        responder.handleMessage({ type: 'RPC_REQ', id: 1, method: 'missing', args: [] }, reply);
        responder.handleMessage({ type: 'RPC_REQ', id: 2, method: 'throws', args: [] }, reply);
        responder.handleMessage({ type: 'RPC_REQ', id: 3, method: 'rejects', args: [] }, reply);
        responder.handleMessage({ type: 'RPC_REQ', id: 4, method: 'giveFn', args: [] }, reply);
        await new Promise(resolve => setTimeout(resolve, 0)); // handlers settle on microtasks

        const codeById = Object.fromEntries(replies.map(frame => [frame.id, frame.code]));
        expect(codeById).toEqual({ 1: 'UNKNOWN_METHOD', 2: 'HANDLER_ERROR', 3: 'HANDLER_ERROR', 4: 'RESULT_NOT_TRANSFERABLE' });
    });
});

describe('peer failures (guarantee: a failure the other side reports rejects with PEER_ERROR and its text verbatim)', () => {
    it('a thrown Error rejects with PEER_ERROR / HANDLER_ERROR and the original message', async () => {
        const { a, b } = wirePair();
        b.expose('boom', () => { throw new Error('kaboom'); });
        expect(await refusal(a.call('boom'))).toEqual({ isError: true, code: 'PEER_ERROR', peerCode: 'HANDLER_ERROR', message: 'kaboom' });
    });

    it('a rejected promise rejects with PEER_ERROR / HANDLER_ERROR and the original message', async () => {
        const { a, b } = wirePair();
        b.expose('bad', () => Promise.reject(new Error('nope')));
        expect(await refusal(a.call('bad'))).toEqual({ isError: true, code: 'PEER_ERROR', peerCode: 'HANDLER_ERROR', message: 'nope' });
    });

    it('a thrown string rejects with PEER_ERROR / HANDLER_ERROR, and the broker keeps serving', async () => {
        const { a, b } = wirePair();
        b.expose('throwStr', () => { throw 'stringy'; });
        b.expose('good', () => 'ok');
        expect(await refusal(a.call('throwStr'))).toEqual({ isError: true, code: 'PEER_ERROR', peerCode: 'HANDLER_ERROR', message: 'stringy' });
        expect(await a.call('good')).toBe('ok'); // the dispatch loop survived the non-Error throw
    });

    it('a thrown plain object rejects with PEER_ERROR / HANDLER_ERROR and a sensible message', async () => {
        const { a, b } = wirePair();
        b.expose('throwObj', () => { throw { code: 'TIMEOUT' }; });
        expect(await refusal(a.call('throwObj'))).toEqual({ isError: true, code: 'PEER_ERROR', peerCode: 'HANDLER_ERROR', message: '[object Object]' });
    });

    it('a thrown undefined rejects with PEER_ERROR / HANDLER_ERROR', async () => {
        const { a, b } = wirePair();
        b.expose('throwUndef', () => { throw undefined; });
        expect(await refusal(a.call('throwUndef'))).toEqual({ isError: true, code: 'PEER_ERROR', peerCode: 'HANDLER_ERROR', message: 'undefined' });
    });

    it('an unknown method rejects with PEER_ERROR / UNKNOWN_METHOD', async () => {
        const { a } = wirePair();
        expect(await refusal(a.call('ghost'))).toEqual({ isError: true, code: 'PEER_ERROR', peerCode: 'UNKNOWN_METHOD', message: 'unknown method: ghost' });
    });

    it('a handler whose result cannot be cloned rejects with PEER_ERROR / RESULT_NOT_TRANSFERABLE', async () => {
        const { a, b } = wireClonedPair(0);
        b.expose('giveFn', () => () => 1);
        const result = await refusal(a.call('giveFn'));
        expect(result).toMatchObject({ isError: true, code: 'PEER_ERROR', peerCode: 'RESULT_NOT_TRANSFERABLE' });
        expect(result.message).toMatch(/^result is not transferable: /);
    });
});

describe('forged refusals (guarantee: nothing the other side sends can produce a local refusal code)', () => {
    // The test plays the other side and answers with whatever it likes; the broker under test is the refused side.
    const LOCAL_CODES = ['TIMEOUT', 'TERMINATED', 'NOT_TRANSFERABLE', 'SEND_FAILED', 'INVALID_CALL'];

    it.each([...LOCAL_CODES, 'PEER_ERROR'])('a response claiming code %s rejects with PEER_ERROR / HANDLER_ERROR', async (forged) => {
        const { callAnsweredWith } = capturedBroker();
        expect(await refusal(callAnsweredWith({ ok: false, error: 'forged', code: forged })))
            .toEqual({ isError: true, code: 'PEER_ERROR', peerCode: 'HANDLER_ERROR', message: 'forged' });
    });

    const NOT_A_PEER_CODE: Array<[string, unknown]> = [
        ['an unknown string', 'SOMETHING_ELSE'],
        ['a lowercase peer code', 'unknown_method'],
        ['a number', 42],
        ['null', null],
        ['an object', { toString: () => 'UNKNOWN_METHOD' }],
        ['an array', ['UNKNOWN_METHOD']],
    ];
    it.each(NOT_A_PEER_CODE)('a response whose code is %s rejects with PEER_ERROR / HANDLER_ERROR', async (_label, forged) => {
        const { callAnsweredWith } = capturedBroker();
        expect(await refusal(callAnsweredWith({ ok: false, error: 'odd', code: forged })))
            .toEqual({ isError: true, code: 'PEER_ERROR', peerCode: 'HANDLER_ERROR', message: 'odd' });
    });

    it('a response with no code rejects with PEER_ERROR / HANDLER_ERROR', async () => {
        const { callAnsweredWith } = capturedBroker();
        expect(await refusal(callAnsweredWith({ ok: false, error: 'plain' })))
            .toEqual({ isError: true, code: 'PEER_ERROR', peerCode: 'HANDLER_ERROR', message: 'plain' });
    });

    it.each(['UNKNOWN_METHOD', 'HANDLER_ERROR', 'RESULT_NOT_TRANSFERABLE'])('a response with peer code %s keeps it as peerCode under PEER_ERROR', async (peerCode) => {
        const { callAnsweredWith } = capturedBroker();
        expect(await refusal(callAnsweredWith({ ok: false, error: 'reported', code: peerCode })))
            .toEqual({ isError: true, code: 'PEER_ERROR', peerCode, message: 'reported' });
    });

    it.each([TERMINATION_TEXT, RESET_TEXT])('a response carrying the exact termination text and code TERMINATED rejects with PEER_ERROR (%s)', async (text) => {
        const { callAnsweredWith } = capturedBroker();
        expect(await refusal(callAnsweredWith({ ok: false, error: text, code: 'TERMINATED' })))
            .toEqual({ isError: true, code: 'PEER_ERROR', peerCode: 'HANDLER_ERROR', message: text });
    });

    it('fields other than code are never read for the refusal reason (a forged peerCode or a non-string error)', async () => {
        const { callAnsweredWith } = capturedBroker();
        expect(await refusal(callAnsweredWith({ ok: false, error: 'x', peerCode: 'TERMINATED', code: 'UNKNOWN_METHOD' })))
            .toEqual({ isError: true, code: 'PEER_ERROR', peerCode: 'UNKNOWN_METHOD', message: 'x' });
        expect(await refusal(callAnsweredWith({ ok: false, error: { message: TERMINATION_TEXT, code: 'TERMINATED' } })))
            .toEqual({ isError: true, code: 'PEER_ERROR', peerCode: 'HANDLER_ERROR', message: 'RPC call failed' });
    });

    it('a handler that throws an Error carrying a local code and the termination text still rejects with PEER_ERROR / HANDLER_ERROR', async () => {
        const { a, b } = wireClonedPair(0);
        b.expose('impersonate', () => {
            const error: any = new Error(TERMINATION_TEXT);
            error.code = 'TERMINATED';
            error.peerCode = 'UNKNOWN_METHOD';
            throw error;
        });
        expect(await refusal(a.call('impersonate')))
            .toEqual({ isError: true, code: 'PEER_ERROR', peerCode: 'HANDLER_ERROR', message: TERMINATION_TEXT });
    });

    it('the responder never forwards a code its handler chose: the wire code is HANDLER_ERROR', async () => {
        const replies: any[] = [];
        const responder = createBroker(() => {}, { timeoutMs: 0 });
        responder.expose('impersonate', () => { const e: any = new Error('x'); e.code = 'TIMEOUT'; throw e; });
        responder.handleMessage({ type: 'RPC_REQ', id: 1, method: 'impersonate', args: [] }, (f) => replies.push(f));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(replies).toEqual([{ type: 'RPC_RES', id: 1, ok: false, error: 'x', code: 'HANDLER_ERROR' }]);
    });
});

describe('defensive guarantees (guarantee: only the allowlist is callable, nothing inherited)', () => {
    const RESERVED = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__'];

    it('answers reserved/inherited names with UNKNOWN_METHOD, invokes nothing, and never mutates Object.prototype', () => {
        const sent: any[] = [];
        const responder = createBroker((f) => sent.push(f), { timeoutMs: 0 });
        const real = vi.fn(() => 'real');
        responder.expose('real', real);

        for (const name of RESERVED) {
            sent.length = 0;
            // An unknown name is answered synchronously (no handler runs), so `sent` is ready at once.
            responder.handleMessage({ type: 'RPC_REQ', id: 1, method: name, args: [] });
            expect(sent, name).toEqual([{ type: 'RPC_RES', id: 1, ok: false, error: `unknown method: ${name}`, code: 'UNKNOWN_METHOD' }]);
        }

        expect(real).not.toHaveBeenCalled();
        // A neutral sentinel proves no reserved name wrote through to the prototype chain.
        expect(({} as any).__registryTouched).toBeUndefined();
        expect((Object.prototype as any).__registryTouched).toBeUndefined();
    });

    it('a caller probing reserved names is refused with PEER_ERROR / UNKNOWN_METHOD, and the real method still serves', async () => {
        const { a, b } = wirePair();
        const real = vi.fn(() => 'real');
        b.expose('real', real);
        for (const name of RESERVED) {
            expect(await refusal(a.call(name)), name).toEqual({ isError: true, code: 'PEER_ERROR', peerCode: 'UNKNOWN_METHOD', message: `unknown method: ${name}` });
        }
        expect(real).not.toHaveBeenCalled();
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

    it('a non-string method name is refused with INVALID_CALL, sending nothing', async () => {
        const send = vi.fn();
        const b = createBroker(send, { timeoutMs: 0 });
        expect(await refusal(b.call(123 as any)))
            .toEqual({ isError: true, code: 'INVALID_CALL', peerCode: undefined, message: 'RPC method name must be a string' });
        expect(send).not.toHaveBeenCalled();
    });

    it('only calls explicitly exposed methods', async () => {
        const { a, b } = wirePair();
        b.expose('allowed', () => 'yes');
        expect(await a.call('allowed')).toBe('yes');
        expect(await refusal(a.call('toString'))).toMatchObject({ code: 'PEER_ERROR', peerCode: 'UNKNOWN_METHOD' });
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

describe('timeouts (guarantee: a call that is never answered rejects with TIMEOUT rather than hanging)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('rejects a never-answered call with TIMEOUT after the default timeout', async () => {
        const b = createBroker(() => {}); // send goes nowhere, so no response ever arrives
        const outcome = refusal(b.call('silent'));
        await vi.advanceTimersByTimeAsync(29_999);
        await vi.advanceTimersByTimeAsync(1);
        expect(await outcome).toEqual({ isError: true, code: 'TIMEOUT', peerCode: undefined, message: 'RPC timeout after 30000ms: silent' });
    });

    it('honors a per-call timeout override', async () => {
        const b = createBroker(() => {});
        const outcome = refusal(b.callWithTimeout(50, 'silent'));
        await vi.advanceTimersByTimeAsync(50);
        expect(await outcome).toEqual({ isError: true, code: 'TIMEOUT', peerCode: undefined, message: 'RPC timeout after 50ms: silent' });
    });

    it('a late answer after the timeout is ignored: the call stays refused with TIMEOUT', async () => {
        const { broker, frames } = capturedBroker(50);
        const outcome = refusal(broker.call('slow'));
        await vi.advanceTimersByTimeAsync(50);
        broker.handleMessage({ type: 'RPC_RES', id: frames[0].id, ok: true, value: 'late' });
        expect(await outcome).toMatchObject({ code: 'TIMEOUT' });
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

describe('lifecycle (guarantee: teardown settles pending calls with TERMINATED; re-expose replaces)', () => {
    it('rejectAllPending rejects every in-flight call with TERMINATED and the given text', async () => {
        const b = createBroker(() => {}, { timeoutMs: 0 });
        const p1 = b.call('a');
        const p2 = b.call('b');
        b.rejectAllPending(RESET_TEXT);
        const expected = { isError: true, code: 'TERMINATED', peerCode: undefined, message: RESET_TEXT };
        expect(await refusal(p1)).toEqual(expected);
        expect(await refusal(p2)).toEqual(expected);
    });

    it('rejectAllPending gives each call its own Error, so one caller cannot alter what another sees', async () => {
        const b = createBroker(() => {}, { timeoutMs: 0 });
        const errors: any[] = [];
        const p1 = b.call('a').catch((e) => { errors.push(e); e.code = 'TAMPERED'; });
        const p2 = b.call('b').catch((e) => { errors.push(e); });
        b.rejectAllPending(RESET_TEXT);
        await Promise.all([p1, p2]);
        expect(errors[0]).not.toBe(errors[1]);
        expect(errors[1].code).toBe('TERMINATED');
    });

    it('rejectAllPending disarms the timers of the calls it settles, and a later answer for them is ignored', async () => {
        vi.useFakeTimers();
        try {
            const { broker, frames } = capturedBroker(10_000);
            const outcome = refusal(broker.call('a'));
            broker.rejectAllPending(RESET_TEXT);
            expect(vi.getTimerCount()).toBe(0);
            broker.handleMessage({ type: 'RPC_RES', id: frames[0].id, ok: true, value: 'late' });
            expect(await outcome).toMatchObject({ code: 'TERMINATED' });
        } finally {
            vi.useRealTimers();
        }
    });

    it('terminationError mints a TERMINATED refusal with the given text', () => {
        const b = createBroker(() => {}, { timeoutMs: 0 });
        const error = b.terminationError(TERMINATION_TEXT);
        expect(error).toBeInstanceOf(Error);
        expect({ code: error.code, peerCode: error.peerCode, message: error.message })
            .toEqual({ code: 'TERMINATED', peerCode: undefined, message: TERMINATION_TEXT });
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
        expect(await refusal(a.call('bad'))).toMatchObject({ code: 'PEER_ERROR', peerCode: 'UNKNOWN_METHOD' });
    });
});

describe('non-transferable values (guarantee: a call with a non-transferable value fails only itself, promptly)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const NON_TRANSFERABLE: Array<[string, () => unknown]> = [
        ['a function', () => () => 1],
        ['a symbol', () => Symbol('s')],
    ];
    it.each(NON_TRANSFERABLE)('a handler returning %s rejects the caller promptly with PEER_ERROR / RESULT_NOT_TRANSFERABLE', async (_label, make) => {
        const { a, b } = wireClonedPair(10_000);
        b.expose('give', () => make());

        const settled = vi.fn();
        a.callWithTimeout(10_000, 'give').then(settled, (e: any) => settled({ code: e.code, peerCode: e.peerCode }));
        // Lets the answer ride its microtasks; a stalled call would only settle once the clock reached 10s.
        await vi.advanceTimersByTimeAsync(1);

        expect(settled).toHaveBeenCalledTimes(1);
        expect(settled.mock.calls[0]?.[0]).toEqual({ code: 'PEER_ERROR', peerCode: 'RESULT_NOT_TRANSFERABLE' });
    });

    it('a call with a non-transferable argument is refused with NOT_TRANSFERABLE at once, sending nothing and arming no timer', async () => {
        const sent: unknown[] = [];
        const b = createBroker((frame) => sent.push(structuredClone(frame)), { timeoutMs: 10_000 });
        const result = await refusal(b.call('echo', () => 1));
        expect(result).toMatchObject({ isError: true, code: 'NOT_TRANSFERABLE', peerCode: undefined });
        expect(result.message).toMatch(/^RPC arguments are not transferable: /);
        expect(sent).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a non-transferable argument runs no handler, and a normal call after it still works (no leaked pending state)', async () => {
        const { a, b } = wireClonedPair(10_000);
        const echo = vi.fn((x: unknown) => x);
        b.expose('echo', echo);
        expect(await refusal(a.call('echo', Symbol('s')))).toMatchObject({ code: 'NOT_TRANSFERABLE' });
        expect(echo).not.toHaveBeenCalled();
        expect(await a.call('echo', 7)).toBe(7);
        expect(echo).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0); // the good call's timer was cleared when it settled
    });

    it('a send that throws is refused with SEND_FAILED and leaves no pending entry or timer behind', async () => {
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
        const ping = vi.fn(() => 'pong');
        other.expose('ping', ping);

        expect(await refusal(one.call('ping')))
            .toEqual({ isError: true, code: 'SEND_FAILED', peerCode: undefined, message: 'RPC call could not be sent: port unavailable' });
        expect(ping).not.toHaveBeenCalled();
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
        expect(byId.get(1)).toEqual({ type: 'RPC_RES', id: 1, ok: true, value: 'value' });                                  // success
        expect(byId.get(2)).toEqual({ type: 'RPC_RES', id: 2, ok: false, error: 'boom', code: 'HANDLER_ERROR' });           // handler error
        expect(byId.get(3)).toEqual({ type: 'RPC_RES', id: 3, ok: false, error: 'unknown method: missing', code: 'UNKNOWN_METHOD' });
        expect(byId.get(4)).toMatchObject({ type: 'RPC_RES', id: 4, ok: false, code: 'RESULT_NOT_TRANSFERABLE' });        // not transferable
        expect(byId.get(4).error).toMatch(/^result is not transferable: /);
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
