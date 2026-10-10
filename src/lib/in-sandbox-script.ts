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
    const bridge = createBrokerFn ? createBrokerFn(send) : null;
    if (bridge) (globalThis as any).bridge = bridge;

    globalThis.addEventListener('message', (event: any) => {
        if (event.data?.type !== 'INIT_PORT') return;
        port = event.ports[0];

        port.onmessage = (ev: any) => {
            const data = ev.data;
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
