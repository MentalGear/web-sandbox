import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { ANNOUNCEMENT_TYPE, inSandboxScript } from "./in-sandbox-script";
import { createBroker, MAX_INBOUND_IN_FLIGHT } from "./rpc";
import { workerBootstrap } from "./worker-bootstrap";
import { bootstrapListeners } from "./egress";

// The bootstrap captures MessagePort.prototype.postMessage and its onmessage setter, and the MessageEvent
// getters, before any guest code runs, and only ever calls those (AR:B2). The tests run it against
// stand-ins installed as the platform's: a port records what was posted through its prototype method in
// `posted`, and its handler is reached through `onmessage`; an event exposes data, ports and source through
// prototype getters, with an own isTrusted, as a browser's MessageEvent does.
class FakeEvent {
    stopped = false;
    stopImmediatePropagation() { this.stopped = true; }
}
class FakeMessageEvent extends FakeEvent {
    readonly isTrusted: boolean;
    constructor(private readonly init: { data?: unknown; ports?: unknown[]; source?: unknown; isTrusted?: boolean }) {
        super();
        this.isTrusted = init.isTrusted ?? true;
    }
    get data() { return this.init.data; }
    get ports() { return this.init.ports ?? []; }
    get source() { return this.init.source ?? null; }
}
class FakePort {
    posted = vi.fn();
    private handler: ((event: unknown) => void) | null = null;
    postMessage(frame: unknown) { this.posted(frame); }
    get onmessage() { return this.handler; }
    set onmessage(handler) { this.handler = handler; }
    /** Delivers `data` to the handler the bootstrap set, as a MessageEvent would. */
    deliver(data: unknown) { this.handler!(new FakeMessageEvent({ data })); }
}
// Cooperative mode makes its own channel (BR:CB1): port1 stays with the bootstrap, port2 is announced to the host.
// A test that wants to watch the bootstrap's end sets `next` to its FakePort first.
class FakeMessageChannel {
    static next: FakePort | null = null;
    readonly port1: FakePort;
    readonly port2 = new FakePort();
    constructor() {
        this.port1 = FakeMessageChannel.next ?? new FakePort();
        FakeMessageChannel.next = null;
    }
}
const PLATFORM = { MessagePort: FakePort, MessageEvent: FakeMessageEvent, Event: FakeEvent, MessageChannel: FakeMessageChannel };
const originals: Record<string, unknown> = {};

/** The host's INIT_PORT as the guest frame receives it: trusted, from parent.parent (jsdom: the window), one port. */
const initPort = (port: unknown, overrides: Record<string, unknown> = {}) =>
    new FakeMessageEvent({ data: { type: 'INIT_PORT' }, ports: [port], source: window, ...overrides });

describe("inSandboxScript", () => {
    const originalAddEventListener = globalThis.addEventListener;

    // parent.parent is the host page; in jsdom it is this window. What the bootstrap announces lands here.
    let announcements: { data: unknown; target: unknown; transfer: unknown }[] = [];
    beforeEach(() => {
        for (const [name, value] of Object.entries(PLATFORM)) {
            originals[name] = (globalThis as any)[name];
            (globalThis as any)[name] = value;
        }
        announcements = [];
        vi.spyOn(window, 'postMessage').mockImplementation(((data: unknown, target: unknown, transfer: unknown) => { announcements.push({ data, target, transfer }); }) as any);
        FakeMessageChannel.next = null;
    });

    afterEach(() => {
        globalThis.addEventListener = originalAddEventListener;
        for (const name of Object.keys(PLATFORM)) (globalThis as any)[name] = originals[name];
        delete (globalThis as any).bridge;
        vi.restoreAllMocks();
    });

    const createMockPort = () => new FakePort();

    const createMockConsole = () => {
        const log = vi.fn();
        const warn = vi.fn();
        const error = vi.fn();
        return { log, warn, error, _log: log, _warn: warn, _error: error } as any;
    };

    it("cooperative mode (broad review CB1): announces port2 of its own channel to parent.parent, once, keeps port1, and listens for no port at all", () => {
        const port = createMockPort();
        FakeMessageChannel.next = port;
        const sandboxConsole = createMockConsole();
        const listeners: Record<string, Function> = {};
        (globalThis as any).addEventListener = (type: string, cb: Function) => {
            listeners[type] = cb;
        };

        inSandboxScript(true, 'cooperative', sandboxConsole);

        expect(ANNOUNCEMENT_TYPE).toBe('SANDBOX_PORT');
        // the stringified functions spell the literal out: both carry this constant
        for (const fn of [inSandboxScript, workerBootstrap]) expect(fn.toString()).toMatch(new RegExp(`type: ["']${ANNOUNCEMENT_TYPE}["']`));
        expect(announcements).toHaveLength(1);
        expect(announcements[0]!.data).toEqual({ type: ANNOUNCEMENT_TYPE });
        expect(announcements[0]!.target).toBe('*');
        const [handed] = announcements[0]!.transfer as FakePort[];
        expect(handed).toBeInstanceOf(FakePort);
        expect(handed).not.toBe(port); // the other end: the bootstrap's own stays here
        expect(listeners['message']).toBeUndefined(); // nothing in the guest realm ever listens for a port
        expect(port.posted).toHaveBeenCalledWith({
            type: 'LOG',
            level: 'info',
            args: ['cooperative Ready'],
            own: true, // the relay's own line (R2:M-1)
        });
        expect(typeof port.onmessage).toBe('function');
    });

    it("externalPort (strict mode): adds no message listener of its own and takes the logic port through attach(), once", () => {
        const sandboxConsole = createMockConsole();
        const listeners: Record<string, Function> = {};
        (globalThis as any).addEventListener = (type: string, cb: Function) => { listeners[type] = cb; };
        const comms = inSandboxScript(false, 'strict', sandboxConsole, createBroker, { externalPort: true });
        expect(listeners['message']).toBeUndefined();
        const port = createMockPort();
        const other = createMockPort();
        comms.attach(port as any);
        comms.attach(other as any);
        expect(port.posted).toHaveBeenCalledWith({ type: 'LOG', level: 'info', args: ['strict Ready'], own: true });
        expect(other.posted).not.toHaveBeenCalled();
        port.deliver({ type: 'PING', n: 1 });
        expect(port.posted).toHaveBeenCalledWith({ type: 'PONG', n: 1 });
    });

    it("console lines logged before the port is attached (a strict entry's top level) are relayed on attach, in order, before the ready line; past 1000 they are counted and one warning says so (independent verification 2026-10-14)", () => {
        let now = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const sandboxConsole = createMockConsole();
        (globalThis as any).addEventListener = () => {};
        const comms = inSandboxScript(false, 'strict', sandboxConsole, createBroker, { externalPort: true });
        sandboxConsole.log('first');
        sandboxConsole.warn('second');
        for (let i = 0; i < 1100; i++) sandboxConsole.log('flood', i);
        const port = createMockPort();
        comms.attach(port as any);
        const frames = port.posted.mock.calls.map(call => call[0]).filter((frame: any) => frame.type === 'LOG');
        expect(frames.slice(0, 2)).toEqual([{ type: 'LOG', level: 'log', args: ['first'] }, { type: 'LOG', level: 'warn', args: ['second'] }]);
        expect(frames).toHaveLength(1000 + 2);
        expect(frames.at(-2)).toEqual({ type: 'LOG', level: 'warn', args: ['[Sandbox] 102 console line(s) logged before the sandbox was connected were dropped (102 past 1000 lines): at most 1000 lines and 4194304 bytes are kept until then.'], own: true });
        expect(frames.at(-1)).toEqual({ type: 'LOG', level: 'info', args: ['strict Ready'], own: true });
        // the flushed lines filled this second's window (R2:M-2): a line right after waits for the next one
        sandboxConsole.log('after');
        expect(port.posted.mock.calls.at(-1)![0]).toMatchObject({ type: 'LOG', level: 'warn', own: true, args: [expect.stringContaining('lines past that are dropped')] });
        now += 1000;
        sandboxConsole.log('after');
        expect(port.posted.mock.calls.at(-1)![0]).toEqual({ type: 'LOG', level: 'log', args: ['after'] });
    });

    it("C3, the outbox: frames queued before the port is attached (a strict entry's bridge calls and console lines) never reach a setter on Array.prototype, and all arrive on attach", () => {
        const sandboxConsole = { log() {}, info() {}, warn() {}, error() {} } as unknown as Console; // no mock: it records calls in arrays
        (globalThis as any).addEventListener = () => {};
        const comms = inSandboxScript(false, 'strict', sandboxConsole, createBroker, { externalPort: true });
        const seen = new Map<number, unknown>(); // a Map: recording must not write an array index itself
        // guest code (the entry's top level) poisons every index the outbox could be written at by assignment
        for (const index of ['0', '1', '2', '3']) {
            Object.defineProperty(Array.prototype, index, { configurable: true, set(value) { seen.set(seen.size, value); }, get() { return undefined; } });
        }
        try {
            (globalThis as any).bridge.call('hostMethod', 1).catch(() => {});
            sandboxConsole.log('queued line');
            (globalThis as any).bridge.expose('guestMethod', () => 1);
        } finally {
            for (const index of ['0', '1', '2', '3']) delete (Array.prototype as any)[index];
        }
        expect([...seen.values()]).toEqual([]);
        const port = createMockPort();
        comms.attach(port as any);
        const types = port.posted.mock.calls.map(call => (call[0] as any).type);
        expect(types).toContain('RPC_REQ');
        expect(port.posted.mock.calls.map(call => call[0])).toContainEqual({ type: 'LOG', level: 'log', args: ['queued line'] });
    });

    it("should block execution when scriptUnsafe is false", () => {
        const port = createMockPort();
        const sandboxConsole = createMockConsole();
        const listeners: Record<string, Function> = {};
        (globalThis as any).addEventListener = (type: string, cb: Function) => {
            listeners[type] = cb;
        };

        inSandboxScript(false, 'worker', sandboxConsole);

        // Handshake
        listeners['message']?.(initPort(port));

        // Attempt execution
        port.deliver({ type: 'EXECUTE', code: '1 + 1' });

        expect(port.posted).toHaveBeenCalledWith(expect.objectContaining({
            type: 'LOG',
            level: 'error',
            args: ['Execution blocked: scriptUnsafe is false']
        }));
    });

    it("should intercept console logs and pipe them to the port", () => {
        const port = createMockPort();
        const sandboxConsole = createMockConsole();
        const listeners: Record<string, Function> = {};
        (globalThis as any).addEventListener = (type: string, cb: Function) => {
            listeners[type] = cb;
        };

        FakeMessageChannel.next = port;
        inSandboxScript(true, 'cooperative', sandboxConsole);

        sandboxConsole.log("hello", { a: 1 });

        expect(port.posted).toHaveBeenCalledWith({
            type: 'LOG',
            level: 'log',
            args: ["hello", { a: 1 }]
        });

        // In cooperative mode, original console should also be called
        expect((sandboxConsole as any)._log).toHaveBeenCalled();
    });

    it("should catch and report runtime errors in executed code", () => {
        const port = createMockPort();
        const sandboxConsole = createMockConsole();
        const listeners: Record<string, Function> = {};
        (globalThis as any).addEventListener = (type: string, cb: Function) => {
            listeners[type] = cb;
        };

        inSandboxScript(true, 'worker', sandboxConsole);
        listeners['message']?.(initPort(port));

        // Execute code that throws
        port.deliver({ type: 'EXECUTE', code: 'throw new Error("Boom")' });

        expect(port.posted).toHaveBeenCalledWith({
            type: 'LOG',
            level: 'error',
            args: ["Boom"]
        });
    });

    it("runs executed code with the Function captured before guest code, and reports nothing back (focused review F2: no EXECUTED frame; a free loop answers the host's ping)", () => {
        const port = createMockPort();
        const sandboxConsole = createMockConsole();
        const listeners: Record<string, Function> = {};
        (globalThis as any).addEventListener = (type: string, cb: Function) => {
            listeners[type] = cb;
        };
        inSandboxScript(true, 'worker', sandboxConsole);
        listeners['message']?.(initPort(port));
        port.posted.mockClear();
        const original = globalThis.Function;
        const replacement = vi.fn(() => () => {});
        try {
            (globalThis as any).Function = replacement; // guest code replacing Function after the bootstrap ran
            port.deliver({ type: 'EXECUTE', code: 'globalThis.__ranByCaptured = (globalThis.__ranByCaptured || 0) + 1', n: 1 });
            port.deliver({ type: 'EXECUTE', code: 'throw new Error("Boom")' });
            port.deliver({ type: 'EXECUTE', code: 'throw { get message() { return () => {}; } }' }); // a message that cannot be cloned
        } finally {
            (globalThis as any).Function = original;
        }
        expect(replacement).not.toHaveBeenCalled();
        expect((globalThis as any).__ranByCaptured).toBe(1);
        delete (globalThis as any).__ranByCaptured;
        const frames = port.posted.mock.calls.map(call => call[0]);
        expect(frames.filter((f: any) => f.type === 'EXECUTED')).toEqual([]);
        expect(frames.filter((f: any) => f.type === 'LOG' && typeof f.args[0] === 'string').map((f: any) => f.args[0])).toEqual(['Boom', '[object Object]']); // a thrown value whose message is not a string: named by its kind (R1:R4-7)
        port.deliver({ type: 'PING', n: -3 }); // a probe's ping: answered like any ping
        expect(port.posted.mock.calls.at(-1)![0]).toEqual({ type: 'PONG', n: -3 });
    });

    it("relays console.info as level 'info', like log, warn and error (backlog B8)", () => {
        const port = createMockPort();
        const sandboxConsole = { ...createMockConsole(), info: vi.fn() };
        const listeners: Record<string, Function> = {};
        (globalThis as any).addEventListener = (type: string, cb: Function) => {
            listeners[type] = cb;
        };
        FakeMessageChannel.next = port;
        inSandboxScript(true, 'cooperative', sandboxConsole);
        for (const level of ['log', 'info', 'warn', 'error'] as const) sandboxConsole[level](`via ${level}`);
        const relayed = port.posted.mock.calls.map(call => call[0]).filter((f: any) => f.type === 'LOG' && String(f.args[0]).startsWith('via '));
        expect(relayed.map((f: any) => [f.level, f.args[0]])).toEqual([['log', 'via log'], ['info', 'via info'], ['warn', 'via warn'], ['error', 'via error']]);
    });

    it("skips a queued bridge frame that cannot be posted, still posting later frames and the ready message", () => {
        const posted: any[] = [];
        const port = createMockPort();
        port.posted.mockImplementation((frame: any) => {
            // stands in for a DataCloneError: just this one frame cannot be posted
            if (frame?.method === 'unpostable') throw new Error('could not be cloned');
            posted.push(frame);
        });
        const sandboxConsole = createMockConsole();
        const listeners: Record<string, Function> = {};
        (globalThis as any).addEventListener = (type: string, cb: Function) => {
            listeners[type] = cb;
        };

        // timeouts off: the queued calls never get an answer from the mock port
        inSandboxScript(true, 'worker', sandboxConsole, (send) => createBroker(send, { timeoutMs: 0 }));
        const bridge = (globalThis as any).bridge;
        bridge.call('unpostable'); // queued before the port exists...
        bridge.call('later');      // ...and so is this one, behind it

        expect(() => listeners['message']?.(initPort(port))).not.toThrow();

        const calls = posted.filter(frame => frame.type === 'RPC_REQ');
        expect(calls.map(frame => frame.method)).toEqual(['later']);
        expect(posted).toContainEqual({ type: 'LOG', level: 'info', args: ['worker Ready'], own: true });
        const warnings = posted.filter(frame => frame.type === 'LOG' && frame.level === 'warn');
        expect(warnings).toHaveLength(1);
        expect(String(warnings[0].args[0])).toContain('could not be posted');
    });

    it("answers the host's watchdog PING with a PONG carrying the same n, outside the broker", () => {
        const port = createMockPort();
        const sandboxConsole = createMockConsole();
        const listeners: Record<string, Function> = {};
        (globalThis as any).addEventListener = (type: string, cb: Function) => {
            listeners[type] = cb;
        };

        FakeMessageChannel.next = port;
        inSandboxScript(true, 'cooperative', sandboxConsole, createBroker);
        const bridge = (globalThis as any).bridge;
        const guestPing = vi.fn(() => 'guest method');
        bridge.expose('PING', guestPing); // a guest method of the same name is never reached by the watchdog
        port.posted.mockClear();

        port.deliver({ type: 'PING', n: 7 });

        expect(port.posted).toHaveBeenCalledTimes(1);
        expect(port.posted).toHaveBeenCalledWith({ type: 'PONG', n: 7 });
        expect(guestPing).not.toHaveBeenCalled();
    });

    it("ignores a malformed PING without answering or throwing", () => {
        const port = createMockPort();
        const sandboxConsole = createMockConsole();
        const listeners: Record<string, Function> = {};
        (globalThis as any).addEventListener = (type: string, cb: Function) => {
            listeners[type] = cb;
        };

        inSandboxScript(true, 'worker', sandboxConsole, createBroker);
        listeners['message']?.(initPort(port));
        port.posted.mockClear();

        for (const n of [undefined, '1', null, {}]) {
            expect(() => port.deliver({ type: 'PING', n })).not.toThrow();
        }
        expect(port.posted).not.toHaveBeenCalled();
    });

    describe("the one INIT_PORT of a worker (review B1)", () => {
        const start = () => {
            const registered: { type: string; cb: Function; options: unknown }[] = [];
            (globalThis as any).addEventListener = (type: string, cb: Function, options?: unknown) => { registered.push({ type, cb, options }); };
            // the worker's postMessage, which the globals allowlist hands the bootstrap (R4:M-1): here the window's
            inSandboxScript(false, 'worker', createMockConsole(), createBroker, undefined, undefined, (message: unknown) => window.postMessage(message));
            return registered.find(r => r.type === 'message')!;
        };

        it("is a capture listener; ignores, without throwing, an untrusted message, one without exactly one port, and any other type; then accepts the frame's, once", () => {
            const listener = start();
            expect(listener.options).toBe(true);
            const port = createMockPort();
            const forgeries = [
                initPort(createMockPort(), { isTrusted: false, source: null }),
                new FakeMessageEvent({ data: { type: 'INIT_PORT' }, ports: [], source: null }),
                new FakeMessageEvent({ data: { type: 'INIT_PORT' }, ports: [createMockPort(), createMockPort()], source: null }),
                new FakeMessageEvent({ data: { type: 'OTHER' }, ports: [createMockPort()], source: null }),
                new FakeMessageEvent({ data: null, ports: [createMockPort()], source: null }),
            ];
            for (const forged of forgeries) {
                expect(() => listener.cb(forged)).not.toThrow();
                expect(forged.stopped).toBe(false);
            }
            // something that is not a port at all (a browser never delivers one): no throw, and still listening
            expect(() => listener.cb(initPort({ notAPort: true }, { source: null }))).not.toThrow();
            const genuine = initPort(port, { source: null });
            listener.cb(genuine);
            expect(genuine.stopped).toBe(true);
            expect(port.posted).toHaveBeenCalledWith({ type: 'LOG', level: 'info', args: ['worker Ready'], own: true });
            // and only once: a later INIT_PORT, even a valid-looking one, changes nothing
            const late = createMockPort();
            listener.cb(initPort(late, { source: null }));
            expect(late.posted).not.toHaveBeenCalled();
            // a worker announces nothing: its frame does (worker-bootstrap.ts), once the worker told it, once, that it
            // runs (R2:C-5), through the postMessage it was handed (in jsdom, the window's)
            expect(announcements).toEqual([{ data: { type: 'WORKER_STARTED' }, target: undefined, transfer: undefined }]);
        });
    });

    describe("the port never reaches guest code (review B2)", () => {
        it("patched MessagePort and MessageEvent prototypes and Reflect.apply, installed after the bootstrap, never see the port; frames still flow", () => {
            const listeners: Record<string, Function> = {};
            (globalThis as any).addEventListener = (type: string, cb: Function) => { listeners[type] = cb; };
            const sandboxConsole = createMockConsole();
            const port = createMockPort();
            FakeMessageChannel.next = port;
            inSandboxScript(true, 'cooperative', sandboxConsole, createBroker);

            // guest code, after the bootstrap (which attached its own port before any guest code ran)
            const seen: unknown[] = [];
            const keep = (value: unknown) => { if (value instanceof FakePort) seen.push(value); };
            const originalPost = FakePort.prototype.postMessage;
            const onmessage = Object.getOwnPropertyDescriptor(FakePort.prototype, 'onmessage')!;
            const getters = ['data', 'ports', 'source'].map(name => [name, Object.getOwnPropertyDescriptor(FakeMessageEvent.prototype, name)!] as const);
            const originalStop = FakeEvent.prototype.stopImmediatePropagation;
            const reflectApply = Reflect.apply;
            try {
                FakePort.prototype.postMessage = function (this: FakePort, frame: unknown) { keep(this); return originalPost.call(this, frame); };
                Object.defineProperty(FakePort.prototype, 'onmessage', { configurable: true, get() { keep(this); return onmessage.get!.call(this); }, set(v) { keep(this); onmessage.set!.call(this, v); } });
                for (const [name, descriptor] of getters) {
                    Object.defineProperty(FakeMessageEvent.prototype, name, { configurable: true, get() { const value = descriptor.get!.call(this); keep(value); if (Array.isArray(value)) value.forEach(keep); return value; } });
                }
                FakeEvent.prototype.stopImmediatePropagation = function (this: FakeEvent) { keep((this as any).ports?.[0]); return originalStop.call(this); };
                Reflect.apply = function (f: Function, self: unknown, args: ArrayLike<unknown>) { keep(self); for (let i = 0; i < args.length; i++) keep(args[i]); return reflectApply(f, self, args); } as typeof Reflect.apply;

                sandboxConsole.log('a line');
                onmessage.get!.call(port)(new FakeMessageEvent({ data: { type: 'PING', n: 1 } }));
                (globalThis as any).bridge.call('hostMethod').catch(() => {});

                expect(seen).toEqual([]);
                const types = port.posted.mock.calls.map(c => (c[0] as any).type);
                expect(types).toEqual(['LOG', 'LOG', 'PONG', 'RPC_REQ']); // Ready, the line, the answer, the call
            } finally {
                FakePort.prototype.postMessage = originalPost;
                Object.defineProperty(FakePort.prototype, 'onmessage', onmessage);
                for (const [name, descriptor] of getters) Object.defineProperty(FakeMessageEvent.prototype, name, descriptor);
                FakeEvent.prototype.stopImmediatePropagation = originalStop;
                Reflect.apply = reflectApply;
            }
        });
    });

    describe("CSP violation forwarding (backlog S5)", () => {
        // Records every listener with its options, so a test can check how it was registered.
        const install = () => {
            const registered: { type: string; cb: Function; options: unknown }[] = [];
            (globalThis as any).addEventListener = (type: string, cb: Function, options?: unknown) => {
                registered.push({ type, cb, options });
            };
            // the listeners the host hands it: the egress table's rows for worker mode (egress.ts)
            inSandboxScript(false, 'worker', createMockConsole(), createBroker, { listeners: bootstrapListeners('worker') });
            const listener = (type: string) => registered.find(r => r.type === type)!;
            return { registered, listener };
        };
        const violation = (overrides: Record<string, unknown> = {}) => ({
            isTrusted: true, effectiveDirective: 'img-src', violatedDirective: 'img-src', blockedURI: 'https://attacker.test/x',
            sourceFile: 'about:srcdoc', lineNumber: 3, columnNumber: 7, ...overrides,
        });
        const violationFrames = (port: FakePort) => port.posted.mock.calls.map(c => c[0] as any).filter(f => f?.type === 'VIOLATION');

        it("is a capture listener on the global object, registered while the bootstrap runs (before any guest code)", () => {
            const { registered } = install();
            const entry = registered.find(r => r.type === 'securitypolicyviolation');
            expect(entry).toBeDefined();
            expect(entry!.options).toBe(true);
            // one of the table's listeners, all registered while the bootstrap runs, before any guest code (test/unit/egress.test.ts)
            expect(registered.map(r => r.type)).toEqual([...bootstrapListeners('worker').map(row => row.type), 'message']);
        });

        it("forwards a report raised before INIT_PORT once the port arrives, and later ones at once, as VIOLATION frames", () => {
            const { listener } = install();
            listener('securitypolicyviolation').cb(violation());
            const port = createMockPort();
            listener('message').cb(initPort(port));
            listener('securitypolicyviolation').cb(violation({ effectiveDirective: '', violatedDirective: 'connect-src', blockedURI: 'wss://a.test/' }));

            expect(violationFrames(port)).toEqual([
                { type: 'VIOLATION', directive: 'img-src', blockedURI: 'https://attacker.test/x', sourceFile: 'about:srcdoc', lineNumber: 3, columnNumber: 7 },
                { type: 'VIOLATION', directive: 'connect-src', blockedURI: 'wss://a.test/', sourceFile: 'about:srcdoc', lineNumber: 3, columnNumber: 7 },
            ]);
        });

        it("ignores synthetic events (dispatched by script, isTrusted false)", () => {
            const { listener } = install();
            const port = createMockPort();
            listener('message').cb(initPort(port));
            listener('securitypolicyviolation').cb(violation({ isTrusted: false }));
            expect(violationFrames(port)).toEqual([]);
        });

        it("forwards at most 100 reports per environment", () => {
            const { listener } = install();
            const port = createMockPort();
            listener('message').cb(initPort(port));
            for (let i = 0; i < 250; i++) listener('securitypolicyviolation').cb(violation({ lineNumber: i + 1 }));
            expect(violationFrames(port)).toHaveLength(100);
        });
    });

    describe("content auto-sizing (backlog B6)", () => {
        // A stand-in ResizeObserver: records what is observed, and lets the test deliver a callback.
        const installObserver = () => {
            const observers: { callback: Function; targets: unknown[] }[] = [];
            (globalThis as any).ResizeObserver = class {
                targets: unknown[] = [];
                constructor(callback: Function) { observers.push({ callback, targets: this.targets }); }
                observe(target: unknown) { this.targets.push(target); }
            };
            return observers;
        };
        afterEach(() => { delete (globalThis as any).ResizeObserver; });

        const start = (mode: 'cooperative' | 'worker', autoResize: boolean | undefined) => {
            const listeners: Record<string, Function> = {};
            (globalThis as any).addEventListener = (type: string, cb: Function) => { listeners[type] = cb; };
            const port = createMockPort();
            FakeMessageChannel.next = port;
            inSandboxScript(false, mode, createMockConsole(), createBroker, autoResize === undefined ? undefined : { autoResize: autoResize as any });
            listeners['message']?.(initPort(port, { source: null })); // worker mode: the frame's INIT_PORT
            return port;
        };
        const resizeFrames = (port: FakePort) => port.posted.mock.calls.map(c => c[0] as any).filter(f => f?.type === 'RESIZE');

        // The bootstrap measures through Element.prototype's own methods and getters, captured before any guest code
        // runs (R2:C-1), so the stand-ins are installed there, before it starts.
        it("observes the root element and reports a changed height as a RESIZE frame, outside the broker", () => {
            const observers = installObserver();
            const box = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ height: 120.4 } as DOMRect);
            const port = start('cooperative', true);
            expect(observers).toHaveLength(1);
            expect(observers[0]!.targets).toEqual([document.documentElement]);

            observers[0]!.callback();
            observers[0]!.callback(); // unchanged: nothing sent
            box.mockReturnValue({ height: 40 } as DOMRect);
            observers[0]!.callback();
            expect(resizeFrames(port)).toEqual([{ type: 'RESIZE', height: 121 }, { type: 'RESIZE', height: 40 }]);
        });

        it("reports the scroll height when content overflows the viewport", () => {
            const observers = installObserver();
            vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ height: 100 } as DOMRect);
            vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(900);
            vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(300);
            const port = start('cooperative', true);
            observers[0]!.callback();
            expect(resizeFrames(port)).toEqual([{ type: 'RESIZE', height: 900 }]);
        });

        it("installs nothing when off, when not literally true, or in worker mode", () => {
            for (const [mode, autoResize] of [['cooperative', false], ['cooperative', undefined], ['cooperative', 'true'], ['worker', true]] as const) {
                const observers = installObserver();
                start(mode, autoResize as any);
                expect(observers, `${mode} ${String(autoResize)}`).toEqual([]);
            }
        });
    });

    describe("sandboxFetch, the fetch bridge's guest side (backlog B5)", () => {
        afterEach(() => { delete (globalThis as any).sandboxFetch; });

        const start = (features?: any) => {
            const listeners: Record<string, Function> = {};
            (globalThis as any).addEventListener = (type: string, cb: Function) => { listeners[type] = cb; };
            const port = createMockPort();
            FakeMessageChannel.next = port;
            inSandboxScript(false, 'cooperative', createMockConsole(), createBroker, features);
            const requests = () => port.posted.mock.calls.map(c => c[0] as any).filter(f => f?.type === 'RPC_REQ');
            const answer = (frame: Record<string, unknown>) => port.deliver({ type: 'RPC_RES', id: requests().at(-1).id, ...frame });
            return { requests, answer };
        };

        it("exists in every environment (review round 1, R4-8: the host refuses it while the bridge is off), as a separate global: fetch is not the bridge", () => {
            const { requests } = start();
            expect(typeof (globalThis as any).sandboxFetch).toBe('function');
            void (globalThis as any).sandboxFetch('https://api.example/').catch(() => {});
            expect(requests()[0].method).toBe('sandbox:fetch'); // the host decides: FETCH_NOT_ALLOWED (host.ts, _handleFetch)
            start({ fetchBridge: { timeoutMs: 1000 } });
            expect(typeof (globalThis as any).sandboxFetch).toBe('function');
            expect(globalThis.fetch).not.toBe((globalThis as any).sandboxFetch);
        });

        it("sends only url, method, headers and body to the reserved method, and turns the answer into a Response", async () => {
            const { requests, answer } = start({ fetchBridge: { timeoutMs: 1000 } });
            const pending = (globalThis as any).sandboxFetch(new URL('https://api.example/x'), {
                method: 'post', headers: { 'X-A': 'b' }, body: new Uint16Array([1]), credentials: 'include', redirect: 'follow', signal: new AbortController().signal,
            });
            const [request] = requests();
            expect(request.method).toBe('sandbox:fetch');
            expect(Object.keys(request.args[0]).sort()).toEqual(['body', 'headers', 'method', 'url']);
            expect(request.args[0]).toMatchObject({ url: 'https://api.example/x', method: 'post', headers: [['x-a', 'b']] });
            // the view's bytes, as a Uint8Array (realm-neutral check: the frame is structured-cloned)
            expect(Object.prototype.toString.call(request.args[0].body)).toBe('[object Uint8Array]');
            expect([...request.args[0].body]).toEqual([1, 0]);

            answer({ ok: true, value: { url: 'https://api.example/x', status: 201, statusText: 'Created', headers: [['x-r', '1']], body: new TextEncoder().encode('done') } });
            const response = await pending;
            expect(response).toBeInstanceOf(Response);
            expect([response.status, response.statusText, response.url, response.headers.get('x-r'), await response.text()]).toEqual([201, 'Created', 'https://api.example/x', '1', 'done']);
        });

        it("rejects with the host's library code, and refuses an unsupported body itself", async () => {
            const { requests, answer } = start({ fetchBridge: { timeoutMs: 1000 } });
            const pending = (globalThis as any).sandboxFetch('https://api.example/');
            answer({ ok: false, error: 'refused', code: 'FETCH_NOT_ALLOWED' });
            await expect(pending).rejects.toMatchObject({ code: 'FETCH_NOT_ALLOWED' });

            const before = requests().length;
            await expect((globalThis as any).sandboxFetch('https://api.example/', { method: 'POST', body: { a: 1 } })).rejects.toBeInstanceOf(TypeError);
            expect(requests()).toHaveLength(before);
        });
    });

    describe("guest writes: the captured sandbox:write call (backlog C5)", () => {
        const start = (features?: any) => {
            const listeners: Record<string, Function> = {};
            (globalThis as any).addEventListener = (type: string, cb: Function) => { listeners[type] = cb; };
            const port = createMockPort();
            FakeMessageChannel.next = port;
            const comms = inSandboxScript(false, 'cooperative', createMockConsole(), createBroker, features);
            const requests = () => port.posted.mock.calls.map(c => c[0] as any).filter(f => f?.type === 'RPC_REQ');
            const answer = (frame: Record<string, unknown>) => port.deliver({ type: 'RPC_RES', id: requests().at(-1).id, ...frame });
            return { comms, port, requests, answer };
        };

        it("is null unless the host turned guest writes on (only a literal true), and never a global", () => {
            for (const features of [undefined, {}, { guestWrites: 'yes' }, { guestWrites: 1 }, { fetchBridge: { timeoutMs: 1 } }]) {
                expect(start(features).comms.writeFiles, JSON.stringify(features)).toBeNull();
            }
            const { comms } = start({ guestWrites: true });
            expect(typeof comms.writeFiles).toBe('function');
            expect(Object.keys(globalThis).filter(name => /write/i.test(name))).toEqual([]);
        });

        it("calls the reserved method with the request, and resolves or rejects with the host's answer and library code", async () => {
            const { comms, requests, answer } = start({ guestWrites: true });
            const pending = comms.writeFiles!({ change: 'remove', path: 'a.txt' });
            expect(requests().map(r => [r.method, r.args])).toEqual([['sandbox:write', [{ change: 'remove', path: 'a.txt' }]]]);
            answer({ ok: true, value: { path: 'a.txt', change: 'remove' } });
            await expect(pending).resolves.toEqual({ path: 'a.txt', change: 'remove' });
            const refused = comms.writeFiles!({ change: 'write', path: '../x', entry: 'x' });
            answer({ ok: false, error: 'refused', code: 'INVALID_PATH' });
            await expect(refused).rejects.toMatchObject({ code: 'INVALID_PATH' });
        });

        it("guest code replacing bridge.callWithTimeout, bridge.call and the port's prototype afterwards changes nothing on this path", async () => {
            const { comms, port, requests, answer } = start({ guestWrites: true });
            const bridge = (globalThis as any).bridge;
            const forged = vi.fn(() => Promise.resolve('forged'));
            bridge.callWithTimeout = forged;
            bridge.call = forged;
            const patched = vi.fn();
            const original = FakePort.prototype.postMessage;
            FakePort.prototype.postMessage = patched;
            try {
                const pending = comms.writeFiles!({ change: 'write', path: 'a.txt', entry: 'x' });
                expect(forged).not.toHaveBeenCalled();
                expect(patched).not.toHaveBeenCalled();
                expect(requests().at(-1)).toMatchObject({ method: 'sandbox:write' });
                answer({ ok: true, value: { path: 'a.txt', change: 'write', type: 'text/plain', size: 1 } });
                await expect(pending).resolves.toMatchObject({ change: 'write' });
            } finally {
                FakePort.prototype.postMessage = original;
            }
            expect(port.posted).toHaveBeenCalled();
        });
    });

    describe("no WebRTC in the guest realm (backlog S13)", () => {
        const NAMES = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection'];
        afterEach(() => { for (const name of NAMES) delete (globalThis as any)[name]; });

        it("removes every peer-connection constructor from the global object while the bootstrap runs, and nothing else", () => {
            class FakePeerConnection {}
            for (const name of NAMES) Object.defineProperty(globalThis, name, { value: FakePeerConnection, writable: true, configurable: true });
            (globalThis as any).RTCSessionDescription = class {};
            (globalThis as any).addEventListener = () => {};

            inSandboxScript(false, 'cooperative', createMockConsole(), createBroker);

            for (const name of NAMES) expect(name in globalThis, name).toBe(false);
            expect(typeof (globalThis as any).RTCSessionDescription).toBe('function');
            delete (globalThis as any).RTCSessionDescription;
        });

        it("runs where none exists (workers have no RTCPeerConnection)", () => {
            (globalThis as any).addEventListener = () => {};
            expect(() => inSandboxScript(false, 'worker', createMockConsole(), createBroker)).not.toThrow();
            for (const name of NAMES) expect(name in globalThis).toBe(false);
        });
    });

    // The startup gate (backlog S46, cooperative mode). `ready` comes when the bootstrap checks in, so the host's calls and
    // execute() can arrive while the guest document is still being parsed: they wait in one queue until it is parsed.
    describe("the startup gate (backlog S46): calls and execute() wait until the guest document is parsed", () => {
        let readyState = 'loading';
        let original: PropertyDescriptor | undefined;
        afterEach(() => {
            if (original) Object.defineProperty(Document.prototype, 'readyState', original);
            delete (document as any).readyState;
            delete (globalThis as any).__order;
        });

        // Runs the bootstrap against a document whose readyState the test sets, and records the DOMContentLoaded
        // listeners it registers through EventTarget.prototype.addEventListener (fired by the test as the platform would).
        const start = (mode: 'cooperative' | 'worker' = 'cooperative', scriptUnsafe = true) => {
            readyState = 'loading';
            original = Object.getOwnPropertyDescriptor(Document.prototype, 'readyState');
            Object.defineProperty(Document.prototype, 'readyState', { configurable: true, get: () => readyState });
            const add = vi.spyOn(EventTarget.prototype, 'addEventListener');
            const listeners: Record<string, Function> = {};
            (globalThis as any).addEventListener = (type: string, cb: Function) => { listeners[type] = cb; };
            const port = createMockPort();
            FakeMessageChannel.next = port;
            inSandboxScript(scriptUnsafe, mode, createMockConsole(), (send, options) => createBroker(send, { ...options, timeoutMs: 0 }));
            if (mode === 'worker') listeners['message']?.(initPort(port));
            port.posted.mockClear();
            const parsedListeners = () => {
                const found = new Set<Function>();
                for (const [type, listener] of add.mock.calls) if (type === 'DOMContentLoaded') found.add(listener as Function);
                return [...found];
            };
            const fireParsed = (isTrusted = true) => { for (const listener of parsedListeners()) listener.call(window, { type: 'DOMContentLoaded', isTrusted }); };
            const posted = () => port.posted.mock.calls.map(call => call[0] as any);
            const answers = () => posted().filter(frame => frame.type === 'RPC_RES');
            (globalThis as any).__order = [];
            (globalThis as any).bridge.expose('note', (tag: string) => { (globalThis as any).__order.push(tag); return [...(globalThis as any).__order]; });
            return { port, fireParsed, parsedListeners, posted, answers };
        };
        const tick = () => new Promise(resolve => setTimeout(resolve, 0));
        const order = () => (globalThis as any).__order;
        const execute = (tag: string) => ({ type: 'EXECUTE', code: `__order.push(${JSON.stringify(tag)})` });
        const request = (id: number, tag: string) => ({ type: 'RPC_REQ', id, method: 'note', args: [tag] });

        it("while the document is loading, EXECUTE and RPC_REQ wait in one queue; PING is answered and the guest's own call settles at once; a trusted DOMContentLoaded runs the queue in arrival order, each frame as if it had just arrived", async () => {
            const { port, fireParsed, posted, answers } = start();
            const own = (globalThis as any).bridge.call('hostMethod'); // the guest's own call: its answer never waits
            const ownId = posted().at(-1).id;
            port.posted.mockClear();
            port.deliver(execute('exec1'));
            port.deliver(request(1, 'call1'));
            port.deliver(execute('exec2'));
            port.deliver(request(2, 'call2'));
            port.deliver({ type: 'PING', n: 4 });
            port.deliver({ type: 'RPC_RES', id: ownId, ok: true, value: 'host answer' });
            await expect(own).resolves.toBe('host answer');
            await tick();
            expect(order()).toEqual([]);
            expect(posted()).toEqual([{ type: 'PONG', n: 4 }]);

            readyState = 'interactive';
            fireParsed();
            await tick();
            expect(order()).toEqual(['exec1', 'call1', 'exec2', 'call2']); // a call's method runs before the next frame, as on arrival
            expect(answers().map(frame => [frame.id, frame.value])).toEqual([[1, ['exec1', 'call1']], [2, ['exec1', 'call1', 'exec2', 'call2']]]);

            port.deliver(request(3, 'call3')); // parsed: handled on arrival (positive control)
            await tick();
            expect(order().at(-1)).toBe('call3');
        });

        it("'interactive' alone does not open it (deferred and module scripts run before DOMContentLoaded); 'complete' does, checked when the next frame arrives, so a listener document.open() erased is not needed", async () => {
            const { port, posted } = start();
            port.deliver(execute('held'));
            readyState = 'interactive';
            port.deliver({ type: 'PING', n: 1 });
            await tick();
            expect(order()).toEqual([]);
            readyState = 'complete'; // no DOMContentLoaded fired here: the arrival of any frame drains the queue first
            port.deliver({ type: 'PING', n: 2 });
            await tick();
            expect(order()).toEqual(['held']);
            expect(posted()).toEqual([{ type: 'PONG', n: 1 }, { type: 'PONG', n: 2 }]);
        });

        it("each held frame registers the DOMContentLoaded listener again (a no-op while it is registered): after document.open() erased it, the reopened document's own DOMContentLoaded still drains the queue", async () => {
            const { port, fireParsed, parsedListeners } = start();
            expect(parsedListeners()).toHaveLength(1); // registered while the bootstrap runs, before guest code
            port.deliver(execute('first'));
            port.deliver(execute('second'));
            expect(parsedListeners()).toHaveLength(1); // the same function each time
            readyState = 'interactive';
            fireParsed();
            await tick();
            expect(order()).toEqual(['first', 'second']);
        });

        it("reads readyState through the getter captured before guest code: a replaced Document.prototype.readyState, an own document.readyState and a synthetic DOMContentLoaded leave it closed; the platform's own opens it (positive control)", async () => {
            const { port, fireParsed } = start();
            Object.defineProperty(Document.prototype, 'readyState', { configurable: true, get: () => 'complete' }); // guest code
            Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
            port.deliver(execute('held'));
            fireParsed(false); // dispatched by guest code: isTrusted is false
            port.deliver({ type: 'PING', n: 1 });
            await tick();
            expect(order()).toEqual([]);
            readyState = 'interactive'; // what the captured getter reads
            fireParsed();
            await tick();
            expect(order()).toEqual(['held']);
        });

        it("closes again while the guest has reopened its document (document.open(): readyState 'loading'), and opens when it is parsed", async () => {
            const { port, fireParsed } = start();
            readyState = 'interactive';
            fireParsed();
            port.deliver(execute('before'));
            readyState = 'loading';
            port.deliver(execute('reopened'));
            await tick();
            expect(order()).toEqual(['before']);
            readyState = 'complete';
            port.deliver({ type: 'PING', n: 1 });
            await tick();
            expect(order()).toEqual(['before', 'reopened']);
        });

        it("a held frame that runs guest code which reopens the document stops the drain there; the rest waits, in order", async () => {
            const { port, fireParsed } = start();
            (globalThis as any).__reopen = () => { readyState = 'loading'; };
            try {
                port.deliver(execute('one'));
                port.deliver({ type: 'EXECUTE', code: '__order.push("reopens"); __reopen()' });
                port.deliver(execute('three'));
                readyState = 'interactive';
                fireParsed();
                await tick();
                expect(order()).toEqual(['one', 'reopens']);
                readyState = 'interactive';
                fireParsed();
                await tick();
                expect(order()).toEqual(['one', 'reopens', 'three']);
            } finally {
                delete (globalThis as any).__reopen;
            }
        });

        it("a DOMContentLoaded listener run again while the queue drains (guest code calling it) never runs a frame twice or out of order", async () => {
            const { port, fireParsed } = start();
            (globalThis as any).__fire = () => fireParsed();
            try {
                port.deliver({ type: 'EXECUTE', code: '__order.push("one"); __fire()' });
                port.deliver(request(1, 'two'));
                port.deliver(execute('three'));
                readyState = 'interactive';
                fireParsed();
                await tick();
                expect(order()).toEqual(['one', 'two', 'three']);
            } finally {
                delete (globalThis as any).__fire;
            }
        });

        it(`holds at most MAX_INBOUND_IN_FLIGHT (${MAX_INBOUND_IN_FLIGHT}) frames: past that a call is answered BUSY at once and an execute() is dropped with one log line each; room again once drained`, async () => {
            const { port, fireParsed, posted, answers } = start();
            for (let i = 0; i < MAX_INBOUND_IN_FLIGHT - 1; i++) port.deliver(request(i + 1, `call${i + 1}`));
            port.deliver(execute('last held'));
            port.deliver(request(1000, 'over'));
            port.deliver(request(1001, 'over'));
            port.deliver(execute('over'));
            port.deliver({ type: 'RPC_REQ', method: 'note', args: ['no id'] }); // malformed: dropped, as the broker drops it
            const busy = { ok: false, error: `too many calls waiting for the guest document to be parsed (${MAX_INBOUND_IN_FLIGHT})`, code: 'BUSY' };
            expect(posted()).toEqual([
                { type: 'RPC_RES', id: 1000, ...busy },
                { type: 'RPC_RES', id: 1001, ...busy },
                { type: 'LOG', level: 'error', args: [`[Sandbox] execute() was dropped: ${MAX_INBOUND_IN_FLIGHT} calls and executions are already waiting for the guest document to be parsed.`] },
            ]);
            readyState = 'interactive';
            fireParsed();
            await tick();
            expect(order()).toHaveLength(MAX_INBOUND_IN_FLIGHT);
            expect(order().at(-1)).toBe('last held');
            expect(answers().filter(frame => frame.ok)).toHaveLength(MAX_INBOUND_IN_FLIGHT - 1);
            readyState = 'loading';
            port.deliver(execute('room again'));
            readyState = 'complete';
            port.deliver({ type: 'PING', n: 1 });
            await tick();
            expect(order().at(-1)).toBe('room again');
        });

        it("the bootstrap's bound is MAX_INBOUND_IN_FLIGHT (declared inside the stringified function)", () => {
            expect(inSandboxScript.toString()).toContain(`MAX_HELD = ${MAX_INBOUND_IN_FLIGHT}`);
        });

        it("a held execute() is still refused when scriptUnsafe is false, when it runs", async () => {
            const { port, fireParsed, posted } = start('cooperative', false);
            port.deliver(execute('never'));
            expect(posted()).toEqual([]);
            readyState = 'interactive';
            fireParsed();
            await tick();
            expect(order()).toEqual([]);
            expect(posted()).toEqual([{ type: 'LOG', level: 'error', args: ['Execution blocked: scriptUnsafe is false'] }]);
        });

        it("worker mode has no gate: the worker has no document, and guest code arrives only as EXECUTE frames", async () => {
            const { port } = start('worker');
            port.deliver(execute('at once'));
            port.deliver(request(1, 'call'));
            await tick();
            expect(order()).toEqual(['at once', 'call']);
        });
    });
});