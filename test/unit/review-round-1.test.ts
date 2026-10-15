import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { inSandboxScript } from '@src/lib/in-sandbox-script';
import { createBroker, RPC_MAX_BYTES, RPC_MAX_INBOUND_BYTES } from '@src/lib/rpc';
import { createSizeOf } from '@src/lib/structured-size';
import { LOG_BYTES_PER_SECOND, LOG_DROPPED_ARGUMENT, LOG_EVENTS_PER_SECOND, LOG_MAX_ARGS, LOG_MAX_BYTES, LOG_MAX_STRING, toLogDetail } from '@src/lib/sandbox-log';

/**
 * Fresh review round 1 (docs/security/REVIEW-ROUND-1-2026-10-15.md): the findings library logic decides, each
 * reproduced here first. The bootstrap runs against stand-in ports whose postMessage structured-clones the frame, as
 * a browser's does, so a frame clone refuses throws DataCloneError here too.
 */

class FakeEvent {
    stopImmediatePropagation() {}
}
class FakeMessageEvent extends FakeEvent {
    readonly isTrusted = true;
    constructor(private readonly init: { data?: unknown; ports?: unknown[] }) { super(); }
    get data() { return this.init.data; }
    get ports() { return this.init.ports ?? []; }
}
class ClonePort {
    frames: any[] = [];
    private handler: ((event: unknown) => void) | null = null;
    postMessage(frame: unknown) { this.frames.push(structuredClone(frame)); }
    get onmessage() { return this.handler; }
    set onmessage(handler) { this.handler = handler; }
    deliver(data: unknown) { this.handler!(new FakeMessageEvent({ data })); }
}
class FakeMessageChannel {
    static next: ClonePort | null = null;
    readonly port1: ClonePort;
    readonly port2 = new ClonePort();
    constructor() {
        this.port1 = FakeMessageChannel.next ?? new ClonePort();
        FakeMessageChannel.next = null;
    }
}
const PLATFORM = { MessagePort: ClonePort, MessageEvent: FakeMessageEvent, Event: FakeEvent, MessageChannel: FakeMessageChannel };
const originals: Record<string, unknown> = {};
const originalAddEventListener = globalThis.addEventListener;
let listeners: Record<string, (event: unknown) => void> = {};

beforeEach(() => {
    for (const [name, value] of Object.entries(PLATFORM)) {
        originals[name] = (globalThis as any)[name];
        (globalThis as any)[name] = value;
    }
    listeners = {};
    (globalThis as any).addEventListener = (type: string, listener: (event: unknown) => void) => { listeners[type] = listener; };
    vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
    globalThis.addEventListener = originalAddEventListener;
    for (const name of Object.keys(PLATFORM)) (globalThis as any)[name] = originals[name];
    delete (globalThis as any).bridge;
    vi.restoreAllMocks();
});

const silentConsole = () => ({ log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {}, dir() {}, dirxml() {}, table() {}, group() {}, groupCollapsed() {}, assert() {} }) as unknown as Console;

/** The bootstrap as the host builds it (strict mode's comms: externalPort), attached to a cloning port. */
function strictComms(console = silentConsole()) {
    const comms = inSandboxScript(false, 'strict', console, createBroker, { externalPort: true }, createSizeOf);
    const port = new ClonePort();
    comms.attach(port as any);
    port.frames.length = 0;
    const lines = () => port.frames.filter(frame => frame.type === 'LOG');
    return { comms, port, console, lines };
}

/** The bootstrap in cooperative mode: it makes its own channel and attaches port1 at once. */
function cooperativeComms(console = silentConsole()) {
    const port = new ClonePort();
    FakeMessageChannel.next = port;
    inSandboxScript(false, 'cooperative', console, createBroker, undefined, createSizeOf);
    port.frames.length = 0;
    return { port, console, lines: () => port.frames.filter(frame => frame.type === 'LOG') };
}

describe('R4-1: the console relay never throws; what clone refuses crosses as its kind', () => {
    for (const [mode, start] of [['strict', strictComms], ['cooperative', cooperativeComms]] as const) {
        // DOM nodes, Events and Responses are the browser's to refuse (jsdom's clone as plain objects): e2e,
        // review-round-1.spec.ts, on all three engines
        it(`${mode}: functions, Symbols, Proxies, WeakMaps, Promises and objects holding them`, () => {
            const { console, lines } = start();
            const values: unknown[] = [() => 1, Symbol('s'), new Proxy({}, {}), new WeakMap(), Promise.resolve(1), { f() {} }, 'kept', 7];
            for (const value of values) expect(() => console.log('value:', value)).not.toThrow();
            expect(() => console.log(...values)).not.toThrow();
            const relayed = lines();
            expect(relayed).toHaveLength(values.length + 1);
            // a Proxy, by the tag its target answers
            expect(relayed.at(-1)!.args).toEqual(['[function]', 'Symbol(s)', '[object Object]', '[object WeakMap]', '[object Promise]', '[object Object]', 'kept', 7]);
        });
    }

    it('a line with a throwing getter, or a revoked Proxy, still relays a line', () => {
        const { console, lines } = strictComms();
        const revocable = Proxy.revocable({}, {});
        revocable.revoke();
        expect(() => console.log({ get boom() { throw new Error('getter'); } }, revocable.proxy)).not.toThrow();
        expect(lines()).toHaveLength(1);
    });
});

describe('R4-2, R4-6, R4-7: uncaught errors and rejections are log lines; errors and the other console methods relay', () => {
    const trusted = (fields: Record<string, unknown>) => ({ isTrusted: true, ...fields });

    it('cooperative (and worker) mode: an uncaught error is one "Uncaught …" line, whatever the engine puts first; a muted one says what the browser gave; a synthetic one is not relayed', () => {
        const { lines } = cooperativeComms();
        listeners['error']!(trusted({ error: new TypeError('chromium'), message: 'Uncaught TypeError: chromium' }));
        listeners['error']!(trusted({ error: new Error('firefox'), message: 'Error: firefox' }));
        listeners['error']!(trusted({ error: null, message: 'Script error.' }));
        listeners['error']!(trusted({ error: 'a string', message: 'Uncaught a string' }));
        listeners['error']!({ isTrusted: false, error: new Error('forged'), message: 'forged' }); // engines report errors trusted: a forged one is not relayed
        expect(lines().map(line => [line.level, line.args[0]])).toEqual([
            ['error', 'Uncaught TypeError: chromium'],
            ['error', 'Uncaught Error: firefox'],
            ['error', 'Uncaught Script error.'],
            ['error', 'Uncaught a string'],
        ]);
    });

    it('every mode: an unhandled rejection is one "Uncaught (in promise) …" line; strict mode leaves the error event to its prelude', () => {
        for (const start of [cooperativeComms, strictComms]) {
            listeners = {};
            const { lines } = start();
            listeners['unhandledrejection']!(trusted({ reason: new RangeError('no') }));
            listeners['unhandledrejection']!(trusted({ reason: 42 }));
            listeners['unhandledrejection']!(trusted({ reason: { get message() { throw new Error('x'); } } }));
            expect(lines().map(line => line.args[0])).toEqual(['Uncaught (in promise) RangeError: no', 'Uncaught (in promise) 42', 'Uncaught (in promise) [object Object]']);
        }
        listeners = {};
        strictComms();
        expect(listeners['error']).toBeUndefined();
    });

    it('an Error argument crosses as { name, message, stack }; debug, trace, assert, dir, dirxml, table, group and groupCollapsed relay; a passing assert and groupEnd do not', () => {
        const browser = silentConsole() as any;
        browser.groupEnd = () => {};
        const { console, lines } = strictComms(browser);
        const error = new SyntaxError('bad');
        console.error('failed:', error);
        const c = console as any;
        c.debug('d');
        c.trace('t');
        c.assert(false, 'a', 1);
        c.assert(true, 'never');
        c.assert(false);
        c.dir({ x: 1 });
        c.dirxml('x');
        c.table([[1]]);
        c.group('g');
        c.groupCollapsed('gc');
        c.groupEnd();
        const [first, ...rest] = lines();
        expect(first.args[1]).toEqual({ name: 'SyntaxError', message: 'bad', stack: String(error.stack) });
        expect(rest.map(line => [line.level, ...line.args])).toEqual([
            ['log', 'd'], ['log', 'console.trace()', 't'], ['error', 'Assertion failed:', 'a', 1], ['error', 'Assertion failed:', 'console.assert'],
            ['log', { x: 1 }], ['log', 'x'], ['log', [[1]]], ['log', 'g'], ['log', 'gc'],
        ]);
    });
});

describe('R3-3: one byte budget per log line, and per second', () => {
    it(`a 64 MiB typed array and an object of 100 000 keys cross as strings saying so; the line stays within LOG_MAX_BYTES (${LOG_MAX_BYTES})`, () => {
        const { console, lines } = strictComms();
        const wide: Record<string, number> = {};
        for (let i = 0; i < 100000; i++) wide['k' + i] = i;
        console.log('big', new Uint8Array(64 * 1024 * 1024), wide, { small: 1 });
        const [line] = lines();
        expect(line.args[0]).toBe('big');
        expect(line.args[1]).toMatch(/^\[\[object Uint8Array\]: past the log line's byte budget/);
        expect(line.args[2]).toMatch(/^\[\[object Object\]: past the log line's byte budget/);
        expect(line.args[3]).toEqual({ small: 1 });
        expect(createSizeOf()(line.args, Infinity)).toBeLessThanOrEqual(LOG_MAX_BYTES);
    });

    it(`at most ${LOG_EVENTS_PER_SECOND} lines and ${LOG_BYTES_PER_SECOND} bytes leave per second, with one warning; strings are cut at LOG_MAX_STRING and arguments at LOG_MAX_ARGS`, () => {
        let now = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const { console, lines } = strictComms();
        const big = 'x'.repeat(LOG_MAX_STRING + 100);
        for (let i = 0; i < 2000; i++) console.log(big, big, big, big);
        const sent = lines();
        const bytes = sent.reduce((sum, line) => sum + createSizeOf()(line.args, Infinity), 0);
        expect(bytes).toBeLessThanOrEqual(LOG_BYTES_PER_SECOND + 1024);
        expect(sent.filter(line => /lines past that are dropped/.test(line.args[0]))).toHaveLength(1);
        expect(sent[0].args[0]).toHaveLength(LOG_MAX_STRING);
        // a positive control: the budget refills with time
        now += 1000;
        console.log('later');
        expect(lines().at(-1)!.args).toEqual(['later']);
        for (let i = 0; i < 3000; i++) console.log(i);
        expect(lines().length - sent.length - 1).toBeLessThanOrEqual(LOG_EVENTS_PER_SECOND);
        console.log(...new Array(LOG_MAX_ARGS + 10).fill(1));
    });

    it('the bootstrap mirrors the budgets (declared inside the stringified function)', () => {
        // a transpiler may print 1000 as 1e3
        const declares = (text: string, name: string, value: number) => new RegExp(`\\b${name} = (${value}|${value.toExponential().replace('e+', 'e')})\\b`).test(text);
        const text = inSandboxScript.toString();
        expect(declares(text, 'LOG_MAX_ARGS', LOG_MAX_ARGS)).toBe(true);
        expect(declares(text, 'LOG_MAX_STRING', LOG_MAX_STRING)).toBe(true);
        expect(declares(text, 'LOG_MAX_BYTES', LOG_MAX_BYTES)).toBe(true);
        expect(declares(text, 'LOG_LINES_PER_SECOND', LOG_EVENTS_PER_SECOND)).toBe(true);
        expect(declares(text, 'LOG_BYTES_PER_SECOND', LOG_BYTES_PER_SECOND)).toBe(true);
        expect(declares(createBroker.toString(), 'MAX_BYTES', RPC_MAX_BYTES)).toBe(true);
        expect(declares(createBroker.toString(), 'MAX_INBOUND_BYTES', RPC_MAX_INBOUND_BYTES)).toBe(true);
    });

    it('the host measures again on receipt: an argument past the budget is dropped, said once per line', () => {
        const onDropped = vi.fn();
        const detail = toLogDetail({ level: 'log', args: ['a', new Uint8Array(LOG_MAX_BYTES), 'b'] }, 'guest', onDropped);
        expect(detail.args).toEqual(['a', LOG_DROPPED_ARGUMENT, 'b']);
        expect(onDropped).toHaveBeenCalledTimes(1);
        const within = toLogDetail({ level: 'log', args: [new Uint8Array(1024)] }, 'guest', onDropped);
        expect((within.args[0] as Uint8Array).length).toBe(1024);
        expect(onDropped).toHaveBeenCalledTimes(1);
    });
});

describe('R3-3: one byte budget per RPC message, and per channel in flight', () => {
    const MiB = 1024 * 1024;
    const broker = (send = vi.fn()) => ({ send, b: createBroker(send, { sizeOf: createSizeOf(), timeoutMs: 0 }) });

    it(`a call past RPC_MAX_BYTES (${RPC_MAX_BYTES}) is refused before anything is sent; one within it is sent`, async () => {
        const { send, b } = broker();
        await expect(b.call('m', new Uint8Array(RPC_MAX_BYTES))).rejects.toMatchObject({ code: 'ARGS_NOT_TRANSFERABLE' });
        expect(send).not.toHaveBeenCalled();
        void b.call('m', new Uint8Array(32 * MiB));
        expect(send).toHaveBeenCalledTimes(1);
    });

    it(`inbound: a request past the budget does not run, and running calls hold at most RPC_MAX_INBOUND_BYTES (${RPC_MAX_INBOUND_BYTES}): BUSY`, async () => {
        const { b } = broker();
        const method = vi.fn(() => new Promise(() => {})); // never settles: its arguments stay held
        b.expose('m', method);
        const answers: any[] = [];
        const reply = (frame: unknown) => answers.push(frame);
        b.handleMessage({ type: 'RPC_REQ', id: 1, method: 'm', args: [new Uint8Array(RPC_MAX_BYTES)] }, reply);
        for (let id = 2; id <= 4; id++) b.handleMessage({ type: 'RPC_REQ', id, method: 'm', args: [new Uint8Array(30 * MiB)] }, reply);
        await Promise.resolve();
        await Promise.resolve();
        expect(method).toHaveBeenCalledTimes(2);
        expect(answers.map(a => [a.id, a.code])).toEqual([[1, 'BUSY'], [4, 'BUSY']]);
    });

    it('a result past the budget is answered RESULT_NOT_TRANSFERABLE; a response past it is not handed over', async () => {
        const { b } = broker();
        b.expose('big', () => new Uint8Array(RPC_MAX_BYTES));
        const answers: any[] = [];
        b.handleMessage({ type: 'RPC_REQ', id: 1, method: 'big', args: [] }, (frame) => answers.push(frame));
        await vi.waitFor(() => expect(answers).toHaveLength(1));
        expect(answers[0]).toMatchObject({ ok: false, code: 'RESULT_NOT_TRANSFERABLE' });

        const { send, b: caller } = broker();
        const pending = caller.call('m');
        const id = send.mock.calls[0]![0].id;
        caller.handleMessage({ type: 'RPC_RES', id, ok: true, value: new Uint8Array(RPC_MAX_BYTES) });
        await expect(pending).rejects.toMatchObject({ code: 'RESULT_NOT_TRANSFERABLE' });
    });

    it("both brokers the library makes measure: the guest's bridge refuses a call past the budget", async () => {
        strictComms();
        await expect((globalThis as any).bridge.call('m', new Uint8Array(RPC_MAX_BYTES))).rejects.toMatchObject({ code: 'ARGS_NOT_TRANSFERABLE' });
    });

    it("both brokers the library makes measure: the element's call() refuses a call past the budget", async () => {
        const { defineWebSandbox } = await import('@src/host');
        defineWebSandbox();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = document.createElement('web-sandbox') as any;
        document.body.appendChild(el);
        el.setConfig({ mode: 'cooperative' });
        await expect(el.callWithTimeout(0, 'm', new Uint8Array(RPC_MAX_BYTES))).rejects.toMatchObject({ code: 'ARGS_NOT_TRANSFERABLE' });
        el.remove();
    });
});

describe('structured-size: a bounded measure', () => {
    const sizeOf = createSizeOf();
    it('counts what clone copies: strings, keys, buffers (a view counts its whole buffer), Maps and Sets; each object once', () => {
        expect(sizeOf('abcd', Infinity)).toBe(16);
        expect(sizeOf(new ArrayBuffer(1000), Infinity)).toBe(1016);
        expect(sizeOf(new Uint8Array(new ArrayBuffer(1000), 0, 10), Infinity)).toBe(1016);
        expect(sizeOf(new Map([['a', 1]]), Infinity)).toBeGreaterThan(16);
        const shared = { s: 'x'.repeat(100) };
        expect(sizeOf([shared, shared], Infinity)).toBeLessThan(2 * sizeOf(shared, Infinity) + 64);
        const cyclic: any = {};
        cyclic.self = cyclic;
        expect(Number.isFinite(sizeOf(cyclic, Infinity))).toBe(true);
    });

    it('stops past the limit, and measures a value it cannot read as Infinity', () => {
        const wide: Record<string, number> = {};
        for (let i = 0; i < 100000; i++) wide['k' + i] = i;
        expect(sizeOf(wide, 1000)).toBeGreaterThan(1000);
        expect(sizeOf(wide, 1000)).toBeLessThan(2000);
        expect(sizeOf({ get x() { throw new Error('no'); } }, Infinity)).toBe(Infinity);
    });

    it('keeps measuring the same after guest code replaces what it uses (primitives captured when made)', () => {
        const measure = createSizeOf();
        const keys = Object.keys;
        try {
            (Object as any).keys = () => [];
            expect(measure({ a: 'x'.repeat(100) }, Infinity)).toBeGreaterThan(200);
        } finally {
            Object.keys = keys;
        }
    });
});

describe('R3-1: the Trusted Types policy blesses only the sandbox\'s own documents', () => {
    afterEach(() => { delete (globalThis as any).trustedTypes; vi.resetModules(); });

    const install = (refuse = false) => {
        const created: { name: string; rules: any }[] = [];
        (globalThis as any).trustedTypes = {
            createPolicy(name: string, rules: any) {
                if (refuse) throw new TypeError('refused by trusted-types');
                created.push({ name, rules });
                return { createHTML: (input: string) => ({ trusted: rules.createHTML(input) }) };
            },
        };
        return created;
    };
    // an HTML sink as Chromium enforces it: a string throws a TypeError, a trusted value is taken
    const sink = () => ({ value: null as unknown, set srcdoc(v: unknown) { if (typeof v === 'string') throw new TypeError('requires TrustedHTML'); this.value = v; } });

    it('a string is assigned as it is where the page takes it; no policy is created', async () => {
        const created = install();
        const { setWrapperSrcdoc } = await import('@src/lib/trusted-types');
        const plain = { srcdoc: '' } as any;
        setWrapperSrcdoc(plain, '<!DOCTYPE html>x');
        expect(plain.srcdoc).toBe('<!DOCTYPE html>x');
        expect(created).toEqual([]);
    });

    it("where the page requires Trusted HTML: one policy, 'web-sandbox', that blesses a wrapper document and markup being parsed inert, nothing else", async () => {
        const created = install();
        const { setWrapperSrcdoc, parseInert, TRUSTED_TYPES_POLICY } = await import('@src/lib/trusted-types');
        const { buildWrapperDocument } = await import('@src/lib/frame-documents');
        const frame = sink();
        const wrapper = buildWrapperDocument('<p>guest</p>', 'allow-scripts');
        setWrapperSrcdoc(frame as any, wrapper);
        expect(frame.value).toEqual({ trusted: wrapper });
        expect(created.map(p => p.name)).toEqual([TRUSTED_TYPES_POLICY]);
        const rules = created[0]!.rules;
        expect(() => rules.createHTML('<img src=x onerror=alert(1)>')).toThrow(TypeError);
        expect(() => setWrapperSrcdoc(sink() as any, '<p>not a wrapper</p>')).toThrow(TypeError);
        // parseInert: jsdom's DOMParser takes strings, so the policy is not needed there; its rule admits markup only while parsing
        expect(parseInert('<p id="a">x</p>').getElementById('a')!.textContent).toBe('x');
        expect(() => rules.createHTML('<p>after</p>')).toThrow(TypeError);
        setWrapperSrcdoc(sink() as any, wrapper);
        expect(created).toHaveLength(1); // created once per page
    });

    it("a trusted-types directive that does not name the policy: TrustedTypesRefusal (the element's reason names the policy)", async () => {
        install(true);
        const { setWrapperSrcdoc, TrustedTypesRefusal } = await import('@src/lib/trusted-types');
        const { buildWrapperDocument } = await import('@src/lib/frame-documents');
        expect(() => setWrapperSrcdoc(sink() as any, buildWrapperDocument('', ''))).toThrow(TrustedTypesRefusal);
    });
});
