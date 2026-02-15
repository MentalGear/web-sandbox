import { describe, it, expect, vi, afterEach } from "vitest";
import { inSandboxScript } from "./in-sandbox-script";

describe("inSandboxScript", () => {
    const originalAddEventListener = globalThis.addEventListener;

    afterEach(() => {
        globalThis.addEventListener = originalAddEventListener;
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
});