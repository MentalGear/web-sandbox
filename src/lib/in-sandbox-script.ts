import type { createBroker } from './rpc';

/**
 * This function is stringified and injected into the sandbox (iframe or worker).
 * It handles the initial handshake, relays console output, keeps the EXECUTE escape hatch,
 * and installs the β RPC bridge.
 *
 * The RPC broker is injected the same way this function is — createBroker is stringified and
 * passed in — so the guest runs the exact same dispatcher as the host (see rpc.ts). It is
 * published as `globalThis.bridge`: a descriptive name chosen to be very unlikely to clash with
 * guest identifiers (unlike `rpc`, `broker` or `channel`). Guest code calls `bridge.expose(name, fn)`
 * to publish a method and `bridge.call(method, ...args)` to invoke a host method.
 */
export function inSandboxScript(
    scriptUnsafe: boolean,
    mode: 'iframe' | 'worker',
    sandboxConsole: Console,
    createBrokerFn?: typeof createBroker,
) {
    // The port does not exist until INIT_PORT, but guest content scripts parse BEFORE that and may
    // call bridge.expose()/bridge.call() straight away. So the bridge is created now with a send that
    // buffers frames until the port arrives — mirroring how the host queues calls made before ready.
    let port: any = null;
    const outbox: any[] = [];
    const send = (frame: any) => {
        if (port) {
            port.postMessage(frame);
            return;
        }
        outbox.push(frame);
    };
    // CSP violation reports (backlog S5, src/lib/violation.ts). Installed here, in the bootstrap, so it is
    // in place before any guest code runs: a capture listener on the global object is the first listener on
    // the event's path, so guest code cannot stop it from seeing a violation by registering first. Guest
    // code can still suppress its own reports later (it can reach the port), which is why a report is
    // evidence of an attempt and silence proves nothing. Forwarded as a first-class VIOLATION frame, not
    // through the broker, so it can never collide with an exposed method name. Reports raised before
    // INIT_PORT wait in the outbox like bridge frames. Synthetic events (isTrusted false) are not reports.
    // At most VIOLATION_LIMIT per environment (the host caps at the same number, VIOLATION_EVENT_LIMIT,
    // and is the authoritative bound); declared here because this function is stringified.
    const VIOLATION_LIMIT = 100;
    let violationsSent = 0;
    globalThis.addEventListener('securitypolicyviolation', (event: any) => {
        if (!event.isTrusted || violationsSent >= VIOLATION_LIMIT) return;
        violationsSent++;
        send({
            type: 'VIOLATION',
            directive: event.effectiveDirective || event.violatedDirective,
            blockedURI: event.blockedURI,
            sourceFile: event.sourceFile,
            lineNumber: event.lineNumber,
            columnNumber: event.columnNumber,
        });
    }, true);

    const bridge = createBrokerFn ? createBrokerFn(send) : null;
    if (bridge) (globalThis as any).bridge = bridge;

    globalThis.addEventListener('message', (event: any) => {
        if (event.data?.type !== 'INIT_PORT') return;
        port = event.ports[0];

        port.onmessage = (ev: any) => {
            const data = ev.data;
            // The host's liveness watchdog (backlog S6, src/lib/watchdog.ts). Answered here, before the
            // broker, so it is not a callable method: it can never collide with a name the guest exposes,
            // and guest code cannot unexpose or replace it. Answering at all is the signal — a blocked
            // event loop cannot run this handler.
            if (data?.type === 'PING') {
                if (typeof data.n === 'number') port.postMessage({ type: 'PONG', n: data.n });
                return;
            }
            if (data?.type === 'EXECUTE') {
                try {
                    // try ensures the code execution itself doesn't crash the port logic
                    if (!scriptUnsafe) throw new Error("Execution blocked: scriptUnsafe is false");
                    const func = new Function(data.code);
                    func();
                } catch (e: any) {
                    port.postMessage({ type: 'LOG', level: 'error', args: [e.message] });
                }
                return;
            }
            // RPC frames (RPC_REQ / RPC_RES) and anything else go to the broker, which validates every
            // frame defensively and never throws back out at the message handler.
            if (bridge) bridge.handleMessage(data);
        };

        (['log', 'error', 'warn'] as const).forEach(level => {
            const original = sandboxConsole[level];
            sandboxConsole[level] = (...args: any[]) => {
                port.postMessage({ type: 'LOG', level, args });
                // Log to the actual browser console for easier debugging
                if (original) {
                    original.apply(sandboxConsole, args);
                }
            };
        });

        // Flush anything the guest queued before the port existed, then announce readiness. A frame that
        // cannot be posted is skipped rather than thrown: a throw would escape this listener and take the
        // frames behind it and the ready message down with it.
        let skipped = 0;
        for (const frame of outbox) {
            try {
                port.postMessage(frame);
            } catch {
                skipped++;
            }
        }
        outbox.length = 0;
        if (skipped > 0) sandboxConsole.warn(`[bridge] skipped ${skipped} queued bridge frame(s) that could not be posted (not transferable).`);

        port.postMessage({ type: 'LOG', level: 'info', args: [`${mode} Ready`] });
    }, { once: true });
}
