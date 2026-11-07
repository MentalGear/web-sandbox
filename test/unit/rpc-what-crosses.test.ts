import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { runInNewContext } from 'node:vm';
import { defineWebSandbox } from '@src/host';
import { createBroker, type RpcFrame, type RpcSend } from '@src/lib/rpc';
import { createSizeOf } from '@src/lib/structured-size';
import { fileError } from '@src/lib/files';
import { isMinted, markMinted } from '@src/lib/minted-errors';

/**
 * What crosses a call is what the value and the API show (class P, research 18), at the broker (rpc.ts, createBroker):
 * - a typed array or a DataView carries its own bytes only, never the rest of its buffer (BD5:LIM-1);
 * - a host handler's failure carries the embedder's own words only, never an engine's text, which quotes the data it was
 *   handling; a result that cannot be copied is refused with the library's own text (BD5:LIM-2, BD5:DOC-1);
 * - a method removed with the element's unexpose() is refused as one never exposed (BD5:DOC-3).
 * test/unit/structural.test.ts holds the property test over the posted snapshot and the source scans of the broker.
 */

const SECRET = 'HOSTSECRET42';

/** A broker whose posts are recorded as posted (the frame object itself and its transfer list), never answered. */
function recordingBroker(options: Record<string, unknown> = {}) {
    const posts: { frame: any; transfer?: Transferable[] }[] = [];
    const send: RpcSend = (frame, transfer) => { posts.push({ frame, transfer }); };
    const broker = createBroker(send, { timeoutMs: 0, sizeOf: createSizeOf(), ...options });
    return { broker, posts };
}

/** Answers one request on `broker` (made with the host's options unless given) and returns the frame it posted. */
async function answer(fn: (...args: any[]) => unknown, args: unknown[] = [], options: Record<string, unknown> = { transferResults: true }) {
    const { broker, posts } = recordingBroker(options);
    broker.expose('m', fn);
    const replies: { frame: any; transfer?: Transferable[] }[] = [];
    broker.handleMessage({ type: 'RPC_REQ', id: 1, method: 'm', args }, (frame: RpcFrame, transfer?: Transferable[]) => { replies.push({ frame, transfer }); });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(posts).toEqual([]);
    expect(replies).toHaveLength(1);
    return replies[0]!;
}

const tag = (value: unknown) => Object.prototype.toString.call(value);
const bytesOf = (view: ArrayBufferView) => [...new Uint8Array(view.buffer, view.byteOffset, view.byteLength)];

/** A 64-byte buffer: "PUB", then a secret the view never shows. */
function hostBuffer() {
    const buffer = new Uint8Array(64);
    buffer.set(new TextEncoder().encode(`PUB${SECRET}-token=abc123`));
    return buffer;
}

describe('a typed array or DataView crosses with its own bytes only (BD5:LIM-1)', () => {
    it('a result that is a partial view: a fresh buffer of exactly its bytes, transferred; the host buffer is untouched', async () => {
        const buffer = hostBuffer();
        const { frame, transfer } = await answer(() => buffer.subarray(0, 3));
        expect(frame.ok).toBe(true);
        const view = frame.value as Uint8Array;
        expect([tag(view), view.byteOffset, view.byteLength, view.buffer.byteLength]).toEqual(['[object Uint8Array]', 0, 3, 3]);
        expect(new TextDecoder().decode(view)).toBe('PUB');
        expect(transfer).toEqual([view.buffer]);
        expect(new TextDecoder().decode(buffer.subarray(3, 15))).toBe(SECRET);
    });

    it('call() arguments: a partial view at any depth, as a Map key or value, or a Set member', () => {
        const buffer = hostBuffer();
        const { broker, posts } = recordingBroker();
        const view = buffer.subarray(1, 4);
        void broker.call('m', view, { a: [{ v: view }] }, new Map([[view, buffer.subarray(5, 7)]]), new Set([buffer.subarray(9, 10)]));
        const [first, nested, map, set] = posts[0]!.frame.args as [Uint8Array, any, Map<Uint8Array, Uint8Array>, Set<Uint8Array>];
        const [key, value] = [...map][0]!;
        const [member] = [...set];
        for (const crossed of [first, nested.a[0].v, key!, value!, member!]) expect(crossed.buffer.byteLength).toBe(crossed.byteLength);
        expect([first, nested.a[0].v, key].every(crossed => crossed === first)).toBe(true); // one view object, one copy
        expect([bytesOf(first), bytesOf(value!), bytesOf(member!)]).toEqual([bytesOf(buffer.subarray(1, 4)), bytesOf(buffer.subarray(5, 7)), bytesOf(buffer.subarray(9, 10))]);
    });

    it('every typed array kind and DataView, at odd offsets, crosses as the same kind with the same bytes', async () => {
        const source = new Uint8Array(256).map((_, i) => (i * 37 + 11) & 255).buffer;
        const kinds = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array];
        const views = [...kinds.map(Kind => new Kind(source, 8 * Kind.BYTES_PER_ELEMENT, 3)), new DataView(source, 3, 5)];
        const { frame } = await answer(() => views);
        const crossed = frame.value as ArrayBufferView[];
        expect(crossed.map(tag)).toEqual(views.map(tag));
        for (let i = 0; i < views.length; i++) {
            expect([crossed[i]!.byteOffset, crossed[i]!.buffer.byteLength]).toEqual([0, views[i]!.byteLength]);
            expect(bytesOf(crossed[i]!)).toEqual(bytesOf(views[i]!));
        }
    });

    it('two views of one buffer arrive with a buffer each; a view of its whole buffer crosses with that buffer, uncopied', async () => {
        const buffer = hostBuffer();
        const whole = new Uint8Array(16);
        const { frame, transfer } = await answer(() => [buffer.subarray(0, 3), buffer.subarray(3, 6), whole, whole]);
        const [a, b, c, d] = frame.value as Uint8Array[];
        expect(a!.buffer).not.toBe(b!.buffer);
        expect([a!.buffer.byteLength, b!.buffer.byteLength, c!.buffer.byteLength]).toEqual([3, 3, 16]);
        expect(c).toBe(d); // the snapshot's one view, posted as it is
        expect(transfer).toHaveLength(3);
    });

    it('the copies count in the byte budget: two views of 20 MiB each of one 32 MiB buffer are over it (each would cross whole before)', async () => {
        const buffer = new Uint8Array(32 * 1024 * 1024);
        const { broker, posts } = recordingBroker();
        const refused = await broker.call('m', buffer.subarray(0, 20 * 1024 * 1024), buffer.subarray(1, 20 * 1024 * 1024 + 1)).catch((error: any) => [error.code, error.message]);
        expect(refused).toEqual(['ARGS_NOT_TRANSFERABLE', 'RPC arguments are larger than the RPC byte budget (34603008)']);
        expect(posts).toEqual([]);
        const { frame } = await answer(() => [buffer.subarray(0, 20 * 1024 * 1024), buffer.subarray(1, 20 * 1024 * 1024 + 1)]);
        expect([frame.code, frame.error]).toEqual(['RESULT_NOT_TRANSFERABLE', 'result is larger than the RPC byte budget (34603008)']);
    });

    it('a view of a SharedArrayBuffer is not copied into a plain one: the measure refuses it, as any SharedArrayBuffer', async () => {
        const shared = new Uint8Array(new SharedArrayBuffer(8), 0, 2);
        const { broker } = recordingBroker();
        const refused = await broker.call('m', shared).catch((error: any) => [error.code, error.message]);
        expect(refused).toEqual(['ARGS_NOT_TRANSFERABLE', 'RPC arguments hold an unsupported value: SharedArrayBuffer']);
    });

    it("the copy uses the intrinsics captured when the broker was made, never the realm's slice, set or species", async () => {
        const { broker, posts } = recordingBroker();
        const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
        const saved = { set: typedArrayPrototype.set, slice: typedArrayPrototype.slice, bufferSlice: ArrayBuffer.prototype.slice, mapSet: Map.prototype.set, setAdd: Set.prototype.add };
        const buffer = hostBuffer();
        const map = new Map([[1, buffer.subarray(3, 5)]]);
        try {
            typedArrayPrototype.set = () => { throw new Error('patched set'); };
            typedArrayPrototype.slice = () => { throw new Error('patched slice'); };
            ArrayBuffer.prototype.slice = () => { throw new Error('patched slice'); };
            Map.prototype.set = function () { throw new Error('patched Map set'); };
            Set.prototype.add = function () { throw new Error('patched Set add'); };
            void broker.call('m', buffer.subarray(0, 3), map);
        } finally {
            Object.assign(typedArrayPrototype, { set: saved.set, slice: saved.slice });
            ArrayBuffer.prototype.slice = saved.bufferSlice;
            Map.prototype.set = saved.mapSet;
            Set.prototype.add = saved.setAdd;
        }
        const [view, crossed] = posts[0]!.frame.args as [Uint8Array, Map<number, Uint8Array>];
        expect([new TextDecoder().decode(view), view.buffer.byteLength, crossed.get(1)!.buffer.byteLength]).toEqual(['PUB', 3, 2]);
    });
});

describe("a host handler's failure carries the embedder's words only (BD5:LIM-2, BD5:DOC-1)", () => {
    const withheld: [string, string, string][] = [];
    const HOST = { transferResults: true, markMinted, isMinted, reportWithheld: (method: string, refusal: string, text: string) => { withheld.push([method, refusal, text]); } };
    beforeEach(() => { withheld.length = 0; });

    class StoreError extends Error {}
    // Each throw of a kind other than a string or a plain Error of this realm, and the name the guest receives.
    const THROWS: [string, () => unknown, string][] = [
        ['JSON.parse', () => JSON.parse(SECRET), 'SyntaxError'],
        ['BigInt', () => BigInt(SECRET), 'SyntaxError'],
        ['a property of null', () => (null as any)[SECRET], 'TypeError'],
        ['new URL', () => new URL(SECRET), 'TypeError'],
        ['new RegExp', () => new RegExp(`${SECRET}(`), 'SyntaxError'],
        ['new TextDecoder', () => new TextDecoder(SECRET), 'RangeError'],
        ['decodeURIComponent', () => decodeURIComponent(`%${SECRET}`), 'URIError'],
        ['a DOMException', () => { throw new DOMException(`no ${SECRET}`, 'NotFoundError'); }, 'NotFoundError'],
        ['an AggregateError', () => { throw new AggregateError([], SECRET); }, 'AggregateError'],
        ['a subclass of Error', () => { throw new StoreError(SECRET); }, 'Error'],
        ['an Error of another realm', () => { throw runInNewContext(`new Error(${JSON.stringify(SECRET)})`); }, 'Error'],
        ['an object with a message', () => { throw { message: SECRET }; }, 'Error'],
        ['a number', () => { throw 42; }, 'number'],
        ['a Proxy whose prototype cannot be read', () => { throw new Proxy(new Error(SECRET), { getPrototypeOf() { throw new Error(SECRET); } }); }, 'Error'],
        ['an error whose name is not an identifier', () => { const error = new TypeError(SECRET); error.name = `${SECRET} name`; throw error; }, 'Error'],
        ['an error named with 64 letters and digits (the longest name kept)', () => { const error = new TypeError(SECRET); error.name = `N${'7'.repeat(63)}`; throw error; }, `N${'7'.repeat(63)}`],
        ['an error named with 65', () => { const error = new TypeError(SECRET); error.name = 'N'.repeat(65); throw error; }, 'Error'],
        ['a rejection with a TypeError', () => Promise.reject(new TypeError(SECRET)), 'TypeError'],
    ];

    it.each(THROWS)('%s: the guest receives "the method failed (<name>)", and the host its text, once', async (_label, fn, name) => {
        const { frame } = await answer(fn, [], HOST);
        expect([frame.ok, frame.code, frame.error]).toEqual([false, 'HANDLER_ERROR', `the method failed (${name})`]);
        expect(withheld).toHaveLength(1);
        expect(withheld[0]!.slice(0, 2)).toEqual(['m', `the method failed (${name})`]);
    });

    it('the engine texts that quote the data reach the host, and only the host', async () => {
        for (const [, fn] of THROWS.slice(0, 3)) await answer(fn, [], HOST);
        expect(withheld.map(([, , text]) => text.includes(SECRET))).toEqual([true, true, true]);
    });

    it("a thrown string and a plain Error's message cross as they are, withholding nothing; a library code still crosses", async () => {
        expect((await answer(() => { throw 'stored text'; }, [], HOST)).frame.error).toBe('stored text');
        expect((await answer(() => { throw new Error('save: too long'); }, [], HOST)).frame.error).toBe('save: too long');
        expect((await answer(() => Promise.reject(new Error('later')), [], HOST)).frame.error).toBe('later');
        const { broker } = recordingBroker(HOST);
        broker.exposeReserved('sandbox:write', () => { throw fileError('FILES_QUOTA_EXCEEDED', 'the quota is spent'); });
        const replies: any[] = [];
        broker.handleMessage({ type: 'RPC_REQ', id: 2, method: 'sandbox:write', args: [] }, (frame: RpcFrame) => { replies.push(frame); });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect([replies[0].code, replies[0].error]).toEqual(['FILES_QUOTA_EXCEEDED', '[Sandbox] the quota is spent']);
        expect(withheld).toEqual([]);
    });

    // BD6:LIM-1: the refusal of this side's own call() holds the library's text, so a method that lets it propagate to the guest
    // hands the guest that text; the clone's error, which quotes the data it was handling, is the refusal's cause and the console's.
    const UNCLONEABLE: [string, () => unknown][] = [
        ['a function whose source holds the secret', () => ({ save() { return `${SECRET}-inline-token`; } })],
        ['a symbol described by the secret', () => Symbol(SECRET)],
        ['a getter whose JSON.parse error quotes the secret', () => ({ get x() { return JSON.parse(SECRET); } })],
        ['a getter that reads a property of null named by the secret', () => ({ get x() { return (null as any)[SECRET]; } })],
    ];
    const NOT_TRANSFERABLE = 'RPC arguments are not transferable: they hold a value structured clone cannot carry';

    it.each(UNCLONEABLE)("a method that lets the refusal of its own call() with %s propagate: the guest receives the library's text, never the engine's", async (_label, make) => {
        const { broker } = recordingBroker(HOST);
        broker.expose('m', () => broker.call('apply', make()));
        const replies: any[] = [];
        broker.handleMessage({ type: 'RPC_REQ', id: 1, method: 'm', args: [] }, (frame: RpcFrame) => { replies.push(frame); });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(replies).toHaveLength(1);
        expect([replies[0].ok, replies[0].code, replies[0].error]).toEqual([false, 'HANDLER_ERROR', NOT_TRANSFERABLE]);
        expect(JSON.stringify(replies[0])).not.toContain(SECRET);
        expect(withheld).toHaveLength(1);
        expect(withheld[0]!.slice(0, 2)).toEqual(['apply', NOT_TRANSFERABLE]);
    });

    it("the refusal of call() keeps the engine's error as its cause, host side, and the code the caller branches on", async () => {
        const { broker } = recordingBroker(HOST);
        const refusal: any = await broker.call('apply', Symbol(SECRET)).catch((error: any) => error);
        expect([refusal.code, refusal.message, refusal.cause instanceof Error]).toEqual(['ARGS_NOT_TRANSFERABLE', NOT_TRANSFERABLE, true]);
        expect(Object.keys(refusal)).toEqual(['code']);
        expect(isMinted(refusal)).toBe(true);
    });

    it("a send that throws is refused 'RPC call could not be sent' with the transport's error as the cause", async () => {
        const broker = createBroker(() => { throw new Error(SECRET); }, { timeoutMs: 0, sizeOf: createSizeOf(), ...HOST });
        const refusal: any = await broker.call('apply').catch((error: any) => error);
        expect([refusal.code, refusal.message, refusal.cause.message]).toEqual(['SEND_FAILED', 'RPC call could not be sent', SECRET]);
        expect(withheld).toEqual([['apply', 'RPC call could not be sent', SECRET]]);
    });

    it('an error the library made crosses as its fixed message whatever its prototype; its cause is not read', async () => {
        class Refusal extends Error {}
        const minted = markMinted(new Refusal('fixed library text'));
        Object.defineProperty(minted, 'cause', { get() { throw new Error(SECRET); } });
        expect((await answer(() => { throw minted; }, [], HOST)).frame.error).toBe('fixed library text');
        expect((await answer(() => { throw new Refusal('not registered'); }, [], HOST)).frame.error).toBe('the method failed (Error)');
    });

    it("the guest's broker (no reportWithheld) forwards its handlers' texts as they are: the host receives them as guest data", async () => {
        const { frame } = await answer(() => JSON.parse(SECRET), [], {});
        expect(frame.error).toContain(SECRET);
    });

    it('a result that cannot be cloned is refused with the library\'s text, never the clone\'s, which quotes the function\'s source', async () => {
        const { frame } = await answer(() => ({ user: 'a', refresh() { return 'HOSTSECRET42-in-source'; } }), [], HOST);
        expect([frame.code, frame.error]).toEqual(['RESULT_NOT_TRANSFERABLE', 'result is not transferable: it holds a value structured clone cannot carry']);
        expect(withheld).toHaveLength(1);
        expect(withheld[0]![2]).toContain('HOSTSECRET42-in-source'); // V8 quotes the source; the host's console gets it
        const guest = await answer(() => () => SECRET, [], {});
        expect(guest.frame.error).toBe('result is not transferable: it holds a value structured clone cannot carry');
    });
});

describe('the element: what a guest learns of a failed host method, and unexpose() (BD5:LIM-2, BD5:DOC-3)', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        vi.spyOn(window, 'postMessage').mockImplementation(() => {});
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.restoreAllMocks();
        document.body.replaceChildren();
    });

    // An element with a port of its environment, and the guest's requests delivered on it (as relay-and-rpc-budgets'
    // hostWithPort): every answer the element posts back is recorded.
    function element() {
        defineWebSandbox();
        const el = document.createElement('web-sandbox') as any;
        document.body.appendChild(el);
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'] });
        const { port1 } = new MessageChannel();
        el._port = port1;
        let id = 0;
        // Delivers one request and resolves with its answer, when it comes.
        const call = (method: string, ...args: unknown[]): Promise<any> => new Promise(resolve => {
            el._onGuestMessage(port1, (reply: any) => resolve(reply.ok ? { ok: reply.value } : { code: reply.code, error: reply.error }), { type: 'RPC_REQ', id: ++id, method, args }, null);
        });
        return { el, call, done: () => port1.close() };
    }

    it('a handler that throws an engine error answers its name only, and writes the engine text to the console, once per call', async () => {
        const { el, call, done } = element();
        el.expose('parse', (text: string) => JSON.parse(text));
        warn.mockClear();
        expect(await call('parse', `{"note": ${SECRET}}`)).toEqual({ code: 'HANDLER_ERROR', error: 'the method failed (SyntaxError)' });
        expect(warn).toHaveBeenCalledTimes(1);
        const [line, text] = warn.mock.calls[0]!;
        expect(line).toBe('[Sandbox] "parse" failed, and the other side received "the method failed (SyntaxError)" in place of its error, which was:');
        expect(text).toMatch(/^SyntaxError: /);
        done();
    });

    it('after unexpose(name) a call is refused exactly as a call to a name never exposed; other methods still answer', async () => {
        const { el, call, done } = element();
        el.expose('save', () => 'saved');
        el.expose('load', () => 'loaded');
        expect(await call('save')).toEqual({ ok: 'saved' });
        el.unexpose('save');
        const removed = await call('save');
        const fresh = element();
        expect(removed).toEqual(await fresh.call('save'));
        expect(removed).toEqual({ code: 'UNKNOWN_METHOD', error: 'unknown method: save' });
        expect(await call('load')).toEqual({ ok: 'loaded' });
        fresh.done();
        done();
    });

    it('unexpose() removes every host method, a list removes those it names, and a name not exposed is ignored', async () => {
        const { el, call, done } = element();
        for (const name of ['a', 'b', 'c']) el.expose(name, () => name);
        el.unexpose(['a', 'missing']);
        expect([await call('a'), await call('b')]).toEqual([{ code: 'UNKNOWN_METHOD', error: 'unknown method: a' }, { ok: 'b' }]);
        el.unexpose();
        expect((await call('b')).code).toBe('UNKNOWN_METHOD');
        expect((await call('c')).code).toBe('UNKNOWN_METHOD');
        el.expose('b', () => 'again');
        expect(await call('b')).toEqual({ ok: 'again' });
        done();
    });

    it('a call that already arrived runs to completion and is answered; the next one is refused', async () => {
        const { el, call, done } = element();
        let finish!: (value: string) => void;
        el.expose('slow', () => new Promise<string>(resolve => { finish = resolve; }));
        const first = call('slow');
        await new Promise(resolve => setTimeout(resolve, 0));
        el.unexpose('slow');
        finish('done');
        expect(await first).toEqual({ ok: 'done' });
        expect((await call('slow')).code).toBe('UNKNOWN_METHOD');
        done();
    });

    it("reserved names are never removed: naming one is refused with a warning, as expose() refuses it; unexpose() leaves the library's methods", async () => {
        const { el, call, done } = element();
        warn.mockClear();
        el.unexpose('sandbox:write');
        expect(warn.mock.calls.map((args: unknown[]) => args[0])).toEqual(['[Sandbox] unexpose(): names starting with "sandbox:" are reserved for the library; "sandbox:write" was not removed.']);
        el.unexpose();
        expect((await call('sandbox:write', {})).code).toBe('FILES_NOT_ALLOWED'); // guest writes are off: the library's answer, not UNKNOWN_METHOD
        done();
    });

    it('names that are not a string or a list of strings throw a TypeError, and nothing is removed', async () => {
        const { el, call, done } = element();
        el.expose('a', () => 'a');
        expect(() => el.unexpose(42)).toThrow(TypeError);
        expect(() => el.unexpose(['a', 1])).toThrow(TypeError);
        expect(() => el.unexpose(null)).toThrow(TypeError);
        expect(await call('a')).toEqual({ ok: 'a' });
        done();
    });
});
