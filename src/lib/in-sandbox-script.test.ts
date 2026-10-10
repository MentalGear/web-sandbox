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
});