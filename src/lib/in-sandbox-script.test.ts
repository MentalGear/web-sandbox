import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { inSandboxScript } from "./in-sandbox-script";
import { createBroker } from "./rpc";

// The bootstrap captures MessagePort.prototype.postMessage and its onmessage setter, and the MessageEvent
// getters, before any guest code runs, and only ever calls those (review B2). The tests run it against
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
const PLATFORM = { MessagePort: FakePort, MessageEvent: FakeMessageEvent, Event: FakeEvent };
const originals: Record<string, unknown> = {};

/** The host's INIT_PORT as the guest frame receives it: trusted, from parent.parent (jsdom: the window), one port. */
const initPort = (port: unknown, overrides: Record<string, unknown> = {}) =>
    new FakeMessageEvent({ data: { type: 'INIT_PORT' }, ports: [port], source: window, ...overrides });

describe("inSandboxScript", () => {
    const originalAddEventListener = globalThis.addEventListener;

    beforeEach(() => {
        for (const [name, value] of Object.entries(PLATFORM)) {
            originals[name] = (globalThis as any)[name];
            (globalThis as any)[name] = value;
        }
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

    it("should initialize and send ready message on INIT_PORT", () => {
        const port = createMockPort();
        const sandboxConsole = createMockConsole();
        
        // Simulate the environment
        const listeners: Record<string, Function> = {};
        (globalThis as any).addEventListener = (type: string, cb: Function) => {
            listeners[type] = cb;
        };

        inSandboxScript(true, 'iframe', sandboxConsole);

        // Trigger handshake
        listeners['message']?.(initPort(port));

        expect(port.posted).toHaveBeenCalledWith({
            type: 'LOG',
            level: 'info',
            args: ['iframe Ready']
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
        expect(port.posted).toHaveBeenCalledWith({ type: 'LOG', level: 'info', args: ['strict Ready'] });
        expect(other.posted).not.toHaveBeenCalled();
        port.deliver({ type: 'PING', n: 1 });
        expect(port.posted).toHaveBeenCalledWith({ type: 'PONG', n: 1 });
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

        inSandboxScript(true, 'iframe', sandboxConsole);
        listeners['message']?.(initPort(port));

        sandboxConsole.log("hello", { a: 1 });

        expect(port.posted).toHaveBeenCalledWith({
            type: 'LOG',
            level: 'log',
            args: ["hello", { a: 1 }]
        });

        // In iframe mode, original console should also be called
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

    it("reports EXECUTED with the host's number once executed code returned or threw, after what it logged (backlog B8)", () => {
        const port = createMockPort();
        const sandboxConsole = createMockConsole();
        const listeners: Record<string, Function> = {};
        (globalThis as any).addEventListener = (type: string, cb: Function) => {
            listeners[type] = cb;
        };
        inSandboxScript(true, 'worker', sandboxConsole);
        listeners['message']?.(initPort(port));
        port.posted.mockClear();

        port.deliver({ type: 'EXECUTE', code: 'console.log("ran")', n: 1 });
        port.deliver({ type: 'EXECUTE', code: 'throw new Error("Boom")', n: 2 });
        port.deliver({ type: 'EXECUTE', code: 'throw { get message() { return () => {}; } }', n: 3 }); // a message that cannot be cloned
        port.deliver({ type: 'EXECUTE', code: 'void 0' }); // no number: nothing to report
        const frames = port.posted.mock.calls.map(call => call[0]);
        expect(frames.filter((f: any) => f.type === 'EXECUTED')).toEqual([{ type: 'EXECUTED', n: 1 }, { type: 'EXECUTED', n: 2 }, { type: 'EXECUTED', n: 3 }]);
        expect(frames.findIndex((f: any) => f.type === 'LOG' && f.args[0] === 'ran')).toBeLessThan(frames.findIndex((f: any) => f.type === 'EXECUTED'));
    });

    it("relays console.info as level 'info', like log, warn and error (backlog B8)", () => {
        const port = createMockPort();
        const sandboxConsole = { ...createMockConsole(), info: vi.fn() };
        const listeners: Record<string, Function> = {};
        (globalThis as any).addEventListener = (type: string, cb: Function) => {
            listeners[type] = cb;
        };
        inSandboxScript(true, 'iframe', sandboxConsole);
        listeners['message']?.(initPort(port));
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
        inSandboxScript(true, 'iframe', sandboxConsole, (send) => createBroker(send, { timeoutMs: 0 }));
        const bridge = (globalThis as any).bridge;
        bridge.call('unpostable'); // queued before the port exists...
        bridge.call('later');      // ...and so is this one, behind it

        expect(() => listeners['message']?.(initPort(port))).not.toThrow();

        const calls = posted.filter(frame => frame.type === 'RPC_REQ');
        expect(calls.map(frame => frame.method)).toEqual(['later']);
        expect(posted).toContainEqual({ type: 'LOG', level: 'info', args: ['iframe Ready'] });
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

        inSandboxScript(true, 'iframe', sandboxConsole, createBroker);
        const bridge = (globalThis as any).bridge;
        const guestPing = vi.fn(() => 'guest method');
        bridge.expose('PING', guestPing); // a guest method of the same name is never reached by the watchdog
        listeners['message']?.(initPort(port));
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

    describe("the one INIT_PORT (review B1)", () => {
        const start = (mode: 'iframe' | 'worker') => {
            const registered: { type: string; cb: Function; options: unknown }[] = [];
            (globalThis as any).addEventListener = (type: string, cb: Function, options?: unknown) => { registered.push({ type, cb, options }); };
            inSandboxScript(false, mode, createMockConsole(), createBroker);
            return registered.find(r => r.type === 'message')!;
        };

        it("is a capture listener; ignores, without throwing, a message from another sender, an untrusted one, one without exactly one port, and any other type; then accepts the host's", () => {
            const listener = start('iframe');
            expect(listener.options).toBe(true);
            const port = createMockPort();
            const stranger = { postMessage() {} }; // another frame on the host page
            const forgeries = [
                initPort(createMockPort(), { source: stranger }),
                initPort(createMockPort(), { source: null }),
                initPort(createMockPort(), { isTrusted: false }),
                new FakeMessageEvent({ data: { type: 'INIT_PORT' }, ports: [], source: window }),
                new FakeMessageEvent({ data: { type: 'INIT_PORT' }, ports: [createMockPort(), createMockPort()], source: window }),
                new FakeMessageEvent({ data: { type: 'OTHER' }, ports: [createMockPort()], source: window }),
                new FakeMessageEvent({ data: null, ports: [createMockPort()], source: window }),
            ];
            for (const forged of forgeries) {
                expect(() => listener.cb(forged)).not.toThrow();
                expect(forged.stopped).toBe(false);
            }
            // something that is not a port at all (a browser never delivers one): no throw, and still listening
            expect(() => listener.cb(initPort({ notAPort: true }))).not.toThrow();
            const genuine = initPort(port);
            listener.cb(genuine);
            expect(genuine.stopped).toBe(true); // no guest listener sees the host's port
            expect(port.posted).toHaveBeenCalledWith({ type: 'LOG', level: 'info', args: ['iframe Ready'] });
            // and only once: a later INIT_PORT, even a valid-looking one, changes nothing
            const late = createMockPort();
            listener.cb(initPort(late));
            expect(late.posted).not.toHaveBeenCalled();
        });

        it("in a worker (no parent, source null) a trusted message with one port is the owner's", () => {
            const listener = start('worker');
            const port = createMockPort();
            listener.cb(initPort(createMockPort(), { isTrusted: false, source: null }));
            listener.cb(initPort(port, { source: null }));
            expect(port.posted).toHaveBeenCalledWith({ type: 'LOG', level: 'info', args: ['worker Ready'] });
        });
    });

    describe("the port never reaches guest code (review B2)", () => {
        it("patched MessagePort and MessageEvent prototypes and Reflect.apply, installed after the bootstrap, never see the port; frames still flow", () => {
            const listeners: Record<string, Function> = {};
            (globalThis as any).addEventListener = (type: string, cb: Function) => { listeners[type] = cb; };
            const sandboxConsole = createMockConsole();
            inSandboxScript(true, 'iframe', sandboxConsole, createBroker);

            // guest code, after the bootstrap and before INIT_PORT
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

                const port = createMockPort();
                listeners['message']!(initPort(port));
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
            inSandboxScript(false, 'iframe', createMockConsole(), createBroker);
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
            // the first listener the bootstrap registers: nothing of ours runs before it
            expect(registered[0]!.type).toBe('securitypolicyviolation');
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

        const start = (mode: 'iframe' | 'worker', autoResize: boolean | undefined) => {
            const listeners: Record<string, Function> = {};
            (globalThis as any).addEventListener = (type: string, cb: Function) => { listeners[type] = cb; };
            inSandboxScript(false, mode, createMockConsole(), createBroker, autoResize === undefined ? undefined : { autoResize: autoResize as any });
            const port = createMockPort();
            listeners['message']?.(initPort(port));
            return port;
        };
        const resizeFrames = (port: FakePort) => port.posted.mock.calls.map(c => c[0] as any).filter(f => f?.type === 'RESIZE');

        it("observes the root element and reports a changed height as a RESIZE frame, outside the broker", () => {
            const observers = installObserver();
            const port = start('iframe', true);
            expect(observers).toHaveLength(1);
            expect(observers[0]!.targets).toEqual([document.documentElement]);

            const box = vi.spyOn(document.documentElement, 'getBoundingClientRect').mockReturnValue({ height: 120.4 } as DOMRect);
            observers[0]!.callback();
            observers[0]!.callback(); // unchanged: nothing sent
            box.mockReturnValue({ height: 40 } as DOMRect);
            observers[0]!.callback();
            expect(resizeFrames(port)).toEqual([{ type: 'RESIZE', height: 121 }, { type: 'RESIZE', height: 40 }]);
        });

        it("reports the scroll height when content overflows the viewport", () => {
            const observers = installObserver();
            const port = start('iframe', true);
            vi.spyOn(document.documentElement, 'getBoundingClientRect').mockReturnValue({ height: 100 } as DOMRect);
            vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(900);
            vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(300);
            observers[0]!.callback();
            expect(resizeFrames(port)).toEqual([{ type: 'RESIZE', height: 900 }]);
        });

        it("installs nothing when off, when not literally true, or in worker mode", () => {
            for (const [mode, autoResize] of [['iframe', false], ['iframe', undefined], ['iframe', 'true'], ['worker', true]] as const) {
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
            inSandboxScript(false, 'iframe', createMockConsole(), createBroker, features);
            const port = createMockPort();
            listeners['message']?.(initPort(port));
            const requests = () => port.posted.mock.calls.map(c => c[0] as any).filter(f => f?.type === 'RPC_REQ');
            const answer = (frame: Record<string, unknown>) => port.deliver({ type: 'RPC_RES', id: requests().at(-1).id, ...frame });
            return { requests, answer };
        };

        it("exists only when the host turned the bridge on, as a separate global: fetch is untouched", () => {
            const originalFetch = globalThis.fetch;
            start();
            expect((globalThis as any).sandboxFetch).toBeUndefined();
            start({ fetchBridge: { timeoutMs: 1000 } });
            expect(typeof (globalThis as any).sandboxFetch).toBe('function');
            expect(globalThis.fetch).toBe(originalFetch);
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
            const comms = inSandboxScript(false, 'iframe', createMockConsole(), createBroker, features);
            const port = createMockPort();
            listeners['message']?.(initPort(port));
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

            inSandboxScript(false, 'iframe', createMockConsole(), createBroker);

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
});