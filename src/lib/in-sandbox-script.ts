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
    // Opt-in features; the host passes this literal only when one is on, so the bootstrap text of a sandbox
    // without them is unchanged.
    features?: { autoResize?: boolean },
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
    // No WebRTC in the guest's realm (backlog S13). ICE traffic to STUN/TURN servers is governed by no CSP
    // directive (connect-src does not apply; `webrtc 'block'` and the local-network-access permission
    // policy changed nothing in any engine measured), so the only lever is the constructor itself, removed
    // here before any guest code runs. It cannot be fetched back: these are the only WebRTC interfaces
    // that construct anything network-capable, and the guest has no other same-origin realm to take
    // them from, since every frame it creates gets a fresh opaque origin (the sandbox flags without
    // allow-same-origin) and workers have no RTCPeerConnection. A frame the guest creates is a realm of
    // its own, though, and keeps the constructor: the residual stated in backlog S13.
    const PEER_CONNECTION_CONSTRUCTORS = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection'];
    for (const name of PEER_CONNECTION_CONSTRUCTORS) {
        if (name in globalThis) Reflect.deleteProperty(globalThis, name);
    }

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

    // Content auto-sizing (backlog B6, src/lib/auto-resize.ts), opt-in and iframe mode only: a worker has no
    // document. A ResizeObserver on the root element reports the content height as a RESIZE frame, outside
    // the broker like VIOLATION. Its callbacks run at most once per rendering update, after layout, so the
    // guest measures once per frame and sends only a changed height. The measure is the root element's
    // box, which follows content in normal flow both ways (it shrinks too, unlike the root's scrollHeight,
    // which never reads less than the viewport); when content overflows the viewport, scrollHeight, so
    // overflow the root's box does not contain still grows the frame. The body is observed as well once it
    // exists, for guests whose root is pinned to the viewport (html { height: 100% }). The host validates,
    // clamps and rate-limits every report: guest code can reach the port and post its own.
    if (features?.autoResize === true && mode === 'iframe' && typeof ResizeObserver === 'function') {
        let lastHeight = -1;
        const measure = () => {
            const root = document.documentElement;
            if (!root) return;
            const box = Math.ceil(root.getBoundingClientRect().height);
            const height = root.scrollHeight > root.clientHeight ? Math.max(box, root.scrollHeight) : box;
            if (height === lastHeight) return;
            lastHeight = height;
            send({ type: 'RESIZE', height });
        };
        const resizeObserver = new ResizeObserver(measure);
        resizeObserver.observe(document.documentElement);
        document.addEventListener('DOMContentLoaded', () => {
            if (document.body) resizeObserver.observe(document.body);
        });
    }

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
