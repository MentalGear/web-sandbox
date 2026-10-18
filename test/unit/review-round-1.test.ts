import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { inSandboxScript } from '@src/lib/in-sandbox-script';
import { defineWebSandbox } from '@src/host';
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
        expect(line.args[1]).toMatch(/^\[Uint8Array: past the log line's byte budget/);
        expect(line.args[2]).toMatch(/^\[Object: past the log line's byte budget/);
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

    it(`inbound: a request past the budget does not run (ARGS_NOT_TRANSFERABLE), and running calls hold at most RPC_MAX_INBOUND_BYTES (${RPC_MAX_INBOUND_BYTES}): BUSY`, async () => {
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
        expect(answers.map(a => [a.id, a.code])).toEqual([[1, 'ARGS_NOT_TRANSFERABLE'], [4, 'BUSY']]); // review round 4, C-5
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

describe("R3-1: the wrapper style's hash, as docs/API.md lists it for a host page's style-src", () => {
    it('is the hash of WRAPPER_STYLE (constant), and the host-policy spec allows the same', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { scriptHashSource } = await import('@src/lib/csp/script-hash');
        const { WRAPPER_STYLE } = await import('@src/lib/frame-documents');
        const hash = scriptHashSource(WRAPPER_STYLE);
        expect(readFileSync(join(__dirname, '../../docs/API.md'), 'utf8')).toContain(hash);
        expect(readFileSync(join(__dirname, '../e2e/host-policy.spec.ts'), 'utf8')).toContain(hash);
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

// ---- low findings -------------------------------------------------------------------------------------------------

const mountElement = async (config?: Record<string, unknown>) => {
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    if (config) el.setConfig(config);
    return el;
};
const task = () => new Promise(resolve => setTimeout(resolve, 0));

describe('R1-3: a value that should be dropped never refuses the whole config', () => {
    it.each([
        ['capabilities: 5', { capabilities: 5 }, 'must be a list'],
        ['capabilities: {}', { capabilities: {} }, 'must be a list'],
        ['unsafeCapabilities that is not a list', { unsafeCapabilities: 'allow-popups' }, 'must be a list'],
        ['a BigInt and a cyclic entry in fetchBridge.allow', (() => { const cyclic: any = {}; cyclic.self = cyclic; return { fetchBridge: { allow: [1n, cyclic, 'https://api.example'] } }; })(), 'a value of type bigint'],
        ['fetchBridge.methods that is not a list', { fetchBridge: { allow: [], methods: 'GET' } }, 'fetchBridge.methods must be a list'],
        ['html that is not a string', { html: 5 }, '"html" must be a string'],
    ])('%s: dropped with a warning, the rest applied, the sandbox builds', async (_, config, warning) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mountElement({ mode: 'cooperative', capabilities: ['allow-scripts'], ...config });
        expect(el.state).toBe('loading');
        expect(warn.mock.calls.some(call => String(call[0]).includes(warning))).toBe(true);
        el.remove();
    });
});

describe('R1-4: an origin is printable ASCII as written, before anything is folded', () => {
    it('U+212A KELVIN SIGN (which lowercases to "k") and U+0130 are refused; the ASCII name is accepted (positive control)', async () => {
        const { parseOrigin } = await import('@src/lib/origin');
        const rules = { anyHost: ['https:'], loopbackOnly: [] };
        expect(parseOrigin('https://Ka.example', rules)).toBeNull();
        expect(parseOrigin('https://İ.example', rules)).toBeNull();
        expect(parseOrigin('https://ka.example', rules)).toBe('https://ka.example');
    });
});

describe('R3-5: fetchBridge.allow naming the host page or a private host is honoured, with a warning; a non-list is dropped', () => {
    it('warns once each, and keeps them; an allow that is not a list admits nothing, with a warning', async () => {
        const { toFetchPolicy } = await import('@src/lib/fetch-bridge');
        const warnings: string[] = [];
        const policy = toFetchPolicy({ allow: ['http://localhost:4444', 'https://10.0.0.1', 'https://api.example'] }, (m) => warnings.push(m), 'http://localhost:4444')!;
        expect(policy.allow).toEqual(['http://localhost:4444', 'https://10.0.0.1', 'https://api.example']);
        expect(warnings).toEqual([
            "[Sandbox] fetchBridge.allow lists the host page's own origin (http://localhost:4444): the guest can send requests to it through the bridge (without credentials).",
            '[Sandbox] fetchBridge.allow lists https://10.0.0.1, a loopback, private or link-local host: the guest can reach it through the bridge.',
        ]);
        warnings.length = 0;
        expect(toFetchPolicy({ allow: 'https://api.example' }, (m) => warnings.push(m))!.allow).toEqual([]);
        expect(warnings).toEqual(['[Sandbox] fetchBridge.allow must be a list; "https://api.example" was dropped.']);
    });
});

describe("R3-2: a build's 'terminated' comes in a task: a listener added right after the call hears it", () => {
    it('setConfig() of an unknown mode, reset() of it, a strict entry that is not registered: state at once, the event after', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mountElement();
        for (const act of [() => el.setConfig({ mode: 'Strict' }), () => el.reset(), () => el.setConfig({ entry: 'missing.js' })]) {
            act();
            expect(el.state).toBe('terminated');
            const reasons: string[] = [];
            el.addEventListener('terminated', (e: CustomEvent) => reasons.push(e.detail.reason), { once: true });
            await task();
            expect(reasons).toHaveLength(1);
        }
    });

    it('an answer that is no longer the state is never dispatched: a usable config set right after a refused one', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mountElement();
        const reasons: string[] = [];
        el.addEventListener('terminated', (e: CustomEvent) => reasons.push(e.detail.reason));
        el.setConfig({ mode: 'Strict' });
        el.setConfig({ mode: 'cooperative' });
        await task();
        expect([el.state, reasons]).toEqual(['loading', []]);
    });
});

describe('R3-7: setConfig() of the configuration the environment stands on is no change', () => {
    it('no rebuild for the same config (the same frame stays); a changed config, load() in between, or a terminated sandbox rebuild', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const config = { mode: 'cooperative', capabilities: ['allow-scripts'], origins: { images: ['https://a.example'] } };
        const el = await mountElement(config);
        const frame = () => el.shadowRoot.querySelector('iframe');
        const first = frame();
        el.setConfig(structuredClone(config));
        expect(frame()).toBe(first);
        el.setConfig({ ...config, html: '<p>other</p>' });
        expect(frame()).not.toBe(first);
        const second = frame();
        el.load('<p>loaded</p>');
        el.setConfig({ ...config, html: '<p>other</p>' });
        expect(frame()).not.toBe(second);
        el.terminate();
        el.setConfig({ ...config, html: '<p>other</p>' });
        expect(el.state).toBe('loading');
    });
});

describe("R3-8: auto-sizing gives the embedder's inline height back", () => {
    it('the inline height before the first report returns when a build turns auto-sizing off', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mountElement({ mode: 'cooperative', capabilities: ['allow-scripts'], autoResize: true });
        el.style.height = '123px';
        el._startAutoResize(); // what 'ready' does (no frame loads in jsdom)
        el._resizer.report({ type: 'RESIZE', height: 40 });
        await vi.waitFor(() => expect(el.style.height).toBe('40px'));
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'] });
        expect(el.style.height).toBe('123px');
    });
});

describe('R3-9: expose() with a handler that is not a function, or a name that is not a string, throws a TypeError', () => {
    it('throws; a function under a string name is exposed (positive control)', async () => {
        const el = await mountElement({ mode: 'cooperative' });
        expect(() => el.expose('m', 42)).toThrow(TypeError);
        expect(() => el.expose(7, () => 1)).toThrow(TypeError);
        expect(() => el.expose('m', () => 1)).not.toThrow();
    });
});

describe("R3-4: cooperative mode without allow-scripts says once what has no effect", () => {
    it('scripts in html, the watchdog, autoResize, the fetch bridge, guest writes, execute() and exposed methods are named, once', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mountElement();
        el.expose('m', () => 1);
        const config = { mode: 'cooperative', html: '<script>x()</script>', watchdogTimeout: 1000, autoResize: true, fetchBridge: { allow: [] }, guestWrites: true, scriptUnsafe: true };
        el.setConfig(config);
        el.reset();
        const said = warn.mock.calls.map(call => String(call[0])).filter(message => message.includes('without "allow-scripts"'));
        expect(said).toHaveLength(1);
        for (const name of ['scripts and handlers in html', 'watchdogTimeout', 'autoResize', 'fetchBridge', 'guestWrites', 'execute()', 'expose()']) expect(said[0]).toContain(name);
        warn.mockClear();
        el.setConfig({ ...config, capabilities: ['allow-scripts'] }); // positive control: nothing to say
        expect(warn.mock.calls.filter(call => String(call[0]).includes('without "allow-scripts"'))).toEqual([]);
    });
});

describe('R2-5: worker mode removes WebAssembly unless scriptUnsafe, as strict mode does', () => {
    it("the worker's source removes it after the globals allowlist, before the comms script; with scriptUnsafe it is kept", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const scriptUnsafe of [false, true]) {
            const el = await mountElement({ mode: 'worker', scriptUnsafe });
            const source = el._getWorkerBootstrapScript([]);
            const removal = source.indexOf('function removeWebAssembly');
            expect(removal >= 0, String(scriptUnsafe)).toBe(!scriptUnsafe);
            if (!scriptUnsafe) {
                // the allowlist runs first, as the argument of the function the rest runs in (review round 4, M-1), whose
                // first statement is the removal
                expect(source.indexOf('(function (g, postToFrame) {(function removeWebAssembly')).toBeGreaterThan(0);
                expect(source.indexOf('keepOnlyWorkerGlobals')).toBeGreaterThan(source.lastIndexOf('})(this, ('));
                expect(removal).toBeLessThan(source.indexOf('function inSandboxScript'));
            }
            el.remove();
        }
    });
});

describe('R3-6, R4-12: the types narrow each mode, and type the element and its events', () => {
    it('compiles only what each mode can use (checked by bun run typecheck)', async () => {
        type Config = import('@src/host').SandboxConfig;
        // @ts-expect-error cooperative mode has no entry
        const cooperativeEntry: Config = { mode: 'cooperative', entry: 'main.js' };
        // @ts-expect-error cooperative mode has no workerExecutionTimeout
        const cooperativeTimeout: Config = { mode: 'cooperative', workerExecutionTimeout: 100 };
        // @ts-expect-error worker mode has no html
        const workerHtml: Config = { mode: 'worker', html: '<p>' };
        // @ts-expect-error worker mode has no autoResize
        const workerResize: Config = { mode: 'worker', autoResize: true };
        // @ts-expect-error strict mode has no unsafeCapabilities
        const strictUnsafe: Config = { unsafeCapabilities: ['allow-popups'] };
        const fine: Config[] = [{ entry: 'main.js', workerExecutionTimeout: 100 }, { mode: 'cooperative', html: '<p>', autoResize: true }, { mode: 'worker', workerExecutionTimeout: 100 }];
        const el = document.createElement('web-sandbox'); // HTMLElementTagNameMap: a WebSandbox
        el.addEventListener('terminated', (event) => { const reason: string = event.detail.reason; void reason; });
        el.addEventListener('sandbox-log', (event) => { const source: 'guest' | 'host' = event.detail.source; void source; });
        // @ts-expect-error the detail of 'terminated' has no code
        el.addEventListener('terminated', (event) => event.detail.code);
        expect([cooperativeEntry, cooperativeTimeout, workerHtml, workerResize, strictUnsafe, fine].length).toBe(6);
    });
});

describe('R2-4: the strict worker mints URLs only for the types the view shows', () => {
    it('url() of an SVG is NOT_FOUND there, its bytes stay readable; a PNG gets its URL (positive control); without the list every file does', async () => {
        const { inSandboxFiles } = await import('@src/lib/in-sandbox-files');
        const { VIEW_FILE_TYPES } = await import('@src/lib/in-sandbox-view');
        const created = vi.fn(() => 'blob:minted');
        const original = URL.createObjectURL;
        (URL as any).createObjectURL = created;
        try {
            const entries: any = [['i.svg', 'image/svg+xml', btoa('<svg/>')], ['p.png', 'image/png', btoa('png')]];
            const files = inSandboxFiles(entries, null, VIEW_FILE_TYPES);
            expect(() => files.url('i.svg')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
            expect(files.list()).toEqual(['i.svg', 'p.png']); // still the worker's to read() and text()
            expect(files.url('p.png')).toBe('blob:minted');
            expect(created).toHaveBeenCalledTimes(1);
            expect(inSandboxFiles(entries).url('i.svg')).toBe('blob:minted');
        } finally {
            (URL as any).createObjectURL = original;
        }
    });
});
