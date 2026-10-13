import { describe, it, expect, vi, afterEach } from "vitest";
import { inSandboxScript } from "./in-sandbox-script";
import { createBroker } from "./rpc";

describe("inSandboxScript", () => {
    const originalAddEventListener = globalThis.addEventListener;

    afterEach(() => {
        globalThis.addEventListener = originalAddEventListener;
        delete (globalThis as any).bridge;
        vi.restoreAllMocks();
    });

    const createMockPort = () => ({
        postMessage: vi.fn(),
        onmessage: null as any,
    });

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
        listeners['message']?.({
            data: { type: 'INIT_PORT' },
            ports: [port]
        });

        expect(port.postMessage).toHaveBeenCalledWith({
            type: 'LOG',
            level: 'info',
            args: ['iframe Ready']
        });
        expect(port.onmessage).toBeDefined();
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
        listeners['message']?.({ data: { type: 'INIT_PORT' }, ports: [port] });

        // Attempt execution
        port.onmessage({ data: { type: 'EXECUTE', code: '1 + 1' } });

        expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
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
        listeners['message']?.({ data: { type: 'INIT_PORT' }, ports: [port] });

        sandboxConsole.log("hello", { a: 1 });

        expect(port.postMessage).toHaveBeenCalledWith({
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
        listeners['message']?.({ data: { type: 'INIT_PORT' }, ports: [port] });

        // Execute code that throws
        port.onmessage({ 
            data: { 
                type: 'EXECUTE', 
                code: 'throw new Error("Boom")' 
            } 
        });

        expect(port.postMessage).toHaveBeenCalledWith({
            type: 'LOG',
            level: 'error',
            args: ["Boom"]
        });
    });

    it("skips a queued bridge frame that cannot be posted, still posting later frames and the ready message", () => {
        const posted: any[] = [];
        const port = {
            postMessage: vi.fn((frame: any) => {
                // stands in for a DataCloneError: just this one frame cannot be posted
                if (frame?.method === 'unpostable') throw new Error('could not be cloned');
                posted.push(frame);
            }),
            onmessage: null as any,
        };
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

        expect(() => listeners['message']?.({ data: { type: 'INIT_PORT' }, ports: [port] })).not.toThrow();

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
        listeners['message']?.({ data: { type: 'INIT_PORT' }, ports: [port] });
        port.postMessage.mockClear();

        port.onmessage({ data: { type: 'PING', n: 7 } });

        expect(port.postMessage).toHaveBeenCalledTimes(1);
        expect(port.postMessage).toHaveBeenCalledWith({ type: 'PONG', n: 7 });
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
        listeners['message']?.({ data: { type: 'INIT_PORT' }, ports: [port] });
        port.postMessage.mockClear();

        for (const n of [undefined, '1', null, {}]) {
            expect(() => port.onmessage({ data: { type: 'PING', n } })).not.toThrow();
        }
        expect(port.postMessage).not.toHaveBeenCalled();
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
        const violationFrames = (port: { postMessage: { mock: { calls: unknown[][] } } }) =>
            port.postMessage.mock.calls.map(c => c[0] as any).filter(f => f?.type === 'VIOLATION');

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
            listener('message').cb({ data: { type: 'INIT_PORT' }, ports: [port] });
            listener('securitypolicyviolation').cb(violation({ effectiveDirective: '', violatedDirective: 'connect-src', blockedURI: 'wss://a.test/' }));

            expect(violationFrames(port)).toEqual([
                { type: 'VIOLATION', directive: 'img-src', blockedURI: 'https://attacker.test/x', sourceFile: 'about:srcdoc', lineNumber: 3, columnNumber: 7 },
                { type: 'VIOLATION', directive: 'connect-src', blockedURI: 'wss://a.test/', sourceFile: 'about:srcdoc', lineNumber: 3, columnNumber: 7 },
            ]);
        });

        it("ignores synthetic events (dispatched by script, isTrusted false)", () => {
            const { listener } = install();
            const port = createMockPort();
            listener('message').cb({ data: { type: 'INIT_PORT' }, ports: [port] });
            listener('securitypolicyviolation').cb(violation({ isTrusted: false }));
            expect(violationFrames(port)).toEqual([]);
        });

        it("forwards at most 100 reports per environment", () => {
            const { listener } = install();
            const port = createMockPort();
            listener('message').cb({ data: { type: 'INIT_PORT' }, ports: [port] });
            for (let i = 0; i < 250; i++) listener('securitypolicyviolation').cb(violation({ lineNumber: i + 1 }));
            expect(violationFrames(port)).toHaveLength(100);
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