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
    mode: 'iframe' | 'worker' | 'strict',
    sandboxConsole: Console,
    createBrokerFn?: typeof createBroker,
    // Opt-in features; the host passes this literal only when one is on, so the bootstrap text of a sandbox
    // without them is unchanged. `externalPort` (strict mode): no INIT_PORT listener of its own; the strict
    // worker prelude takes the ports from the one trusted INIT message and hands the logic port to attach().
    // `guestWrites`: the host records the guest's file writes (backlog C5); returned as `writeFiles` below.
    features?: { autoResize?: boolean; fetchBridge?: { timeoutMs: number }; externalPort?: boolean; guestWrites?: boolean },
): { attach(port: MessagePort): void; writeFiles: ((request: unknown) => Promise<unknown>) | null } {
    // The port never reaches guest code (review B2). Every operation on it, and on the events that carry it,
    // goes through a primitive captured here, before any guest code runs, and is called through the captured
    // Reflect.apply: patching MessagePort.prototype (postMessage, onmessage), MessageEvent.prototype (data,
    // ports, source), Event.prototype or Function.prototype afterwards changes nothing this script does, and
    // never hands a patched function the port as `this` or as an argument. (A guest that held the port could
    // hand it to a nested worker that answers the watchdog's pings while the guest loops.) The internal lists
    // are written with a captured defineProperty and read by index, so inherited setters or iterators on
    // Array.prototype see none of it either (review C3).
    const g = globalThis as any;
    const apply = Reflect.apply;
    const defineOwn = Reflect.defineProperty;
    const accessor = (proto: object, name: string) => Object.getOwnPropertyDescriptor(proto, name)!;
    const postOnPort = MessagePort.prototype.postMessage;
    const setOnMessage = accessor(MessagePort.prototype, 'onmessage').set!;
    const dataOf = accessor(MessageEvent.prototype, 'data').get!;
    const portsOf = accessor(MessageEvent.prototype, 'ports').get!;
    const sourceOf = accessor(MessageEvent.prototype, 'source').get!;
    const stopImmediate = Event.prototype.stopImmediatePropagation;
    const append = (list: unknown[], value: unknown) => defineOwn(list, list.length, { value, writable: true, enumerable: true, configurable: true });
    // Iframe mode: the host page, the only sender of INIT_PORT (review B1). The guest frame's parent is the
    // wrapper; the wrapper's parent is the host. Read now, before guest code could replace `parent`.
    const host = mode === 'iframe' ? parent.parent : null;

    // The port does not exist until INIT_PORT, but guest content scripts parse BEFORE that and may
    // call bridge.expose()/bridge.call() straight away. So the bridge is created now with a send that
    // buffers frames until the port arrives — mirroring how the host queues calls made before ready.
    let port: MessagePort | null = null;
    const outbox: unknown[] = [];
    const post = (frame: unknown) => apply(postOnPort, port, [frame]);
    const send = (frame: any) => {
        if (port) {
            post(frame);
            return;
        }
        append(outbox, frame);
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

    // The guest's broker accepts a library code (FETCH_*) in the refusal of a call to a reserved method, so
    // sandboxFetch() rejects with the host's code; the host's broker never accepts one (see rpc.ts).
    const bridge = createBrokerFn ? createBrokerFn(send, { acceptLibraryCodes: true }) : null;
    if (bridge) (globalThis as any).bridge = bridge;

    // The host-mediated fetch bridge (backlog B5, src/lib/fetch-bridge.ts, ADR-006), opt-in, both modes. A
    // separate global, never a replacement for fetch: guest code that wants it as fetch assigns it itself.
    // It sends only url, method, headers and body (string, ArrayBuffer or typed array) to the reserved
    // sandbox:fetch method; the host decides everything else and refuses with a FETCH_* code. The broker's
    // own timeout is a backstop a little past the host's, so the host's FETCH_TIMEOUT normally arrives first.
    // Whole responses only: the answer becomes a Response here, with its body in memory.
    if (bridge && features?.fetchBridge) {
        const callWithTimeout = bridge.callWithTimeout;
        const callTimeoutMs = features.fetchBridge.timeoutMs + 5000;
        const NULL_BODY_STATUSES = [101, 103, 204, 205, 304];
        const toBody = (body: any) => {
            if (body === undefined || body === null) return undefined;
            if (typeof body === 'string') return body;
            if (body instanceof ArrayBuffer) return body.slice(0);
            if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
            throw new TypeError('sandboxFetch: the body must be a string, an ArrayBuffer or a typed array');
        };
        (globalThis as any).sandboxFetch = (input: unknown, init?: any) => {
            let request;
            try {
                const options = init || {};
                const headers: [string, string][] = [];
                new Headers(options.headers).forEach((value, name) => headers.push([name, value]));
                request = { url: String(input), method: options.method === undefined ? 'GET' : String(options.method), headers, body: toBody(options.body) };
            } catch (error) {
                return Promise.reject(error);
            }
            return callWithTimeout(callTimeoutMs, 'sandbox:fetch', request).then((result: any) => {
                const status = result.status;
                const response = new Response(NULL_BODY_STATUSES.includes(status) ? null : result.body, { status, statusText: result.statusText, headers: result.headers });
                Object.defineProperty(response, 'url', { value: result.url });
                return response;
            });
        };
    }

    // Guest writes (backlog C5, src/lib/guest-writes.ts), opt-in, every mode: the one way to send a write or a
    // removal to the host, the reserved sandbox:write method. Like sandboxFetch, it calls the broker's
    // callWithTimeout captured here, before any guest code runs, so replacing bridge.callWithTimeout (or the port's
    // prototypes, see above) later changes nothing on this path. It is not a global: the bootstrap hands it to
    // inSandboxFiles, which builds sandboxFiles.write() and remove() on it (null when off: they refuse locally).
    // The host answers at once (it decides synchronously), so the broker's default 30 s timeout is only a backstop.
    let writeFiles: ((request: unknown) => Promise<unknown>) | null = null;
    if (bridge && features?.guestWrites === true) {
        const callWithTimeout = bridge.callWithTimeout;
        writeFiles = (request: unknown) => callWithTimeout(30000, 'sandbox:write', request);
    }

    const attach = (handedPort: MessagePort) => {
        if (port) return;
        port = handedPort;

        apply(setOnMessage, port, [(ev: MessageEvent) => {
            const data = apply(dataOf, ev, []);
            // The host's liveness watchdog (backlog S6, src/lib/watchdog.ts). Answered here, before the
            // broker, so it is not a callable method: it can never collide with a name the guest exposes,
            // and guest code cannot unexpose or replace it. Answering at all is the signal — a blocked
            // event loop cannot run this handler.
            if (data?.type === 'PING') {
                if (typeof data.n === 'number') post({ type: 'PONG', n: data.n });
                return;
            }
            if (data?.type === 'EXECUTE') {
                try {
                    // try ensures the code execution itself doesn't crash the port logic
                    if (!scriptUnsafe) throw new Error("Execution blocked: scriptUnsafe is false");
                    const func = new Function(data.code);
                    func();
                } catch (e: any) {
                    try {
                        post({ type: 'LOG', level: 'error', args: [e.message] });
                    } catch {
                        // a thrown value whose message cannot be cloned: no line, but the report below still goes
                    }
                }
                // The code returned (or threw): the host stops this execute()'s workerExecutionTimeout budget
                // (backlog B8). Posted with the captured primitives, like every frame of this script, so guest
                // code can neither post it early nor stop it.
                if (typeof data.n === 'number') post({ type: 'EXECUTED', n: data.n });
                return;
            }
            // RPC frames (RPC_REQ / RPC_RES) and anything else go to the broker, which validates every
            // frame defensively and never throws back out at the message handler.
            if (bridge) bridge.handleMessage(data);
        }]);

        // Every level a 'sandbox-log' detail can carry (sandbox-log.ts), info included (backlog B8).
        const levels = ['log', 'info', 'warn', 'error'] as const;
        for (let i = 0; i < levels.length; i++) {
            const level = levels[i]!;
            const original = sandboxConsole[level];
            sandboxConsole[level] = (...args: any[]) => {
                post({ type: 'LOG', level, args });
                // Log to the actual browser console for easier debugging
                if (original) {
                    apply(original, sandboxConsole, args);
                }
            };
        }

        // Flush anything the guest queued before the port existed, then announce readiness. A frame that
        // cannot be posted is skipped rather than thrown: a throw would escape this listener and take the
        // frames behind it and the ready message down with it.
        let skipped = 0;
        for (let i = 0; i < outbox.length; i++) {
            try {
                post(outbox[i]);
            } catch {
                skipped++;
            }
        }
        outbox.length = 0;
        if (skipped > 0) sandboxConsole.warn(`[bridge] skipped ${skipped} queued bridge frame(s) that could not be posted (not transferable).`);

        post({ type: 'LOG', level: 'info', args: [`${mode} Ready`] });
    };

    // The one INIT_PORT (review B1): a trusted message with exactly one port and, in iframe mode, from the host
    // page — so neither another frame on the host page nor guest code can hand the bridge a port of its own, or
    // a portless message that would leave the bridge dead. Anything else is ignored and the listener stays, so a
    // forgery cannot use up the one the host sends. A capture listener registered before guest code, which
    // stops the event there: no guest listener ever sees the host's port. It never throws.
    const onInit = (event: MessageEvent) => {
        if (port || event.isTrusted !== true) return; // isTrusted is an own, unforgeable property
        let data, ports, source;
        try {
            data = apply(dataOf, event, []);
            ports = apply(portsOf, event, []);
            source = apply(sourceOf, event, []);
        } catch {
            return;
        }
        if (!data || data.type !== 'INIT_PORT' || !ports || ports.length !== 1) return;
        if (mode === 'iframe' && source !== host) return;
        apply(stopImmediate, event, []);
        try {
            attach(ports[0]);
        } catch {
            port = null; // not a port after all: keep listening for the host's
        }
    };
    if (!features?.externalPort) g.addEventListener('message', onInit, true);
    return { attach, writeFiles };
}
