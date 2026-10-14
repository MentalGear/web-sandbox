import type { createBroker } from './rpc';

/**
 * The type of the one message the guest frame posts to the host page in iframe mode, carrying its port (the
 * announcement, broad review 2026-10-14 CB1); the worker-mode frame posts the same one. host.ts accepts exactly one
 * per environment. The stringified functions spell the literal out (they close over nothing); a unit test keeps
 * them equal to this constant.
 */
export const ANNOUNCEMENT_TYPE = 'SANDBOX_PORT';

/**
 * This function is stringified and injected into the sandbox (iframe or worker).
 * It makes (iframe mode) or receives (worker mode) the guest's end of the channel, relays console output, keeps the
 * EXECUTE escape hatch, and installs the β RPC bridge.
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
    // The announcement (broad review 2026-10-14, CB1), the first statement, before anything else in the guest
    // document can run: in iframe mode the bootstrap makes the channel itself, keeps port1 in this closure and
    // posts port2 to the host page (parent.parent: the guest's parent is the wrapper). The host takes exactly one
    // announcement per environment, from this frame's window, and ends the environment on a second one (a guest
    // that reloads or rewrites itself runs a bootstrap again). Before, the host posted its port INTO the guest
    // frame after the wrapper loaded, and a capture listener here took it; document.open() erases every listener
    // of the window, so guest code that called it before the wrapper's load received the host's port in a
    // listener of its own (and could answer the watchdog from a nested worker). Now no listener in the guest realm
    // ever carries a port of ours: the guest's end never leaves this closure, and the host's end never enters
    // the guest. Worker mode: the frame (worker-bootstrap.ts) announces the same way and hands port1 to the worker,
    // whose one INIT_PORT listener below takes it (a worker has no document to open, and no guest code runs in it
    // before the port is there).
    const announced = mode === 'iframe' ? new MessageChannel() : null;
    if (announced) parent.parent.postMessage({ type: 'SANDBOX_PORT' }, '*', [announced.port2]);

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
    const stopImmediate = Event.prototype.stopImmediatePropagation;
    const PromiseConstructor = Promise;
    const rejected = Promise.reject;
    // What execute() compiles with (focused review 2026-10-14, F2): captured now, so guest code that replaces
    // globalThis.Function (or Reflect) later cannot choose what an EXECUTE frame runs, or when.
    const FunctionConstructor = Function;
    const construct = Reflect.construct;
    const append = (list: unknown[], value: unknown) => defineOwn(list, list.length, { value, writable: true, enumerable: true, configurable: true });

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

    // Hardening of the guest realm against platform gaps CSP does not cover (broad review 2026-10-14), each made
    // here, before guest code, with primitives captured above, and each limited to this realm: a frame or a worker
    // the guest creates is a realm of its own and keeps the platform's behaviour (the residual of backlog S13).
    //
    // PD2, keepalive. Firefox sends `fetch(url, { keepalive: true })` without checking connect-src (measured on a
    // plain page with a header policy too: a platform bug). The guest's fetch builds the Request first with the
    // captured constructor, exactly as fetch() itself would, reads `keepalive` from that Request (so a getter on
    // the init, or a Request made with keepalive, cannot answer twice), refuses a keepalive request, and hands
    // only that Request to the platform's fetch. Writable, so guest code can still wrap fetch; not configurable,
    // so the guard stays underneath any wrapper. Every engine, every mode: the rule is the same everywhere.
    const nativeFetch = g.fetch;
    const RequestConstructor = g.Request;
    let keepaliveOf: (() => unknown) | undefined;
    for (let proto = typeof RequestConstructor === 'function' ? RequestConstructor.prototype : null; proto && !keepaliveOf; proto = Object.getPrototypeOf(proto)) {
        keepaliveOf = Object.getOwnPropertyDescriptor(proto, 'keepalive')?.get; // own on Request.prototype in every engine measured
    }
    if (typeof nativeFetch === 'function' && keepaliveOf) {
        const TypeErrorConstructor = TypeError;
        const guardedFetch = function fetch(input: unknown, init?: unknown) {
            let request;
            try {
                request = construct(RequestConstructor, init === undefined ? [input] : [input, init]);
            } catch (error) {
                return apply(rejected, PromiseConstructor, [error]);
            }
            if (apply(keepaliveOf, request, []) === true) {
                return apply(rejected, PromiseConstructor, [construct(TypeErrorConstructor, ['fetch() with keepalive is not available in the sandbox'])]);
            }
            return apply(nativeFetch, g, [request]);
        };
        defineOwn(g, 'fetch', { value: guardedFetch, writable: true, enumerable: true, configurable: false });
    }
    if (mode === 'iframe') {
        // PD4, history traversal. history.back(), forward() and go() traverse the whole tab's session history, so a
        // guest's history.back() navigated the HOST page in Firefox and WebKit; the Navigation API's back(),
        // forward() and traverseTo() reach the same history where it exists. In the guest realm they do nothing
        // (the Navigation API's resolve nothing and reject as when there is no entry to go to): not configurable,
        // so guest code cannot put them back, and no other same-origin realm holds the originals.
        const nothing = function () {};
        for (const name of ['back', 'forward', 'go']) {
            if (typeof History === 'function') defineOwn(History.prototype, name, { value: nothing, writable: false, enumerable: true, configurable: false });
        }
        const NavigationConstructor = g.Navigation;
        if (typeof NavigationConstructor === 'function') {
            const DOMExceptionConstructor = DOMException;
            const catchOf = Promise.prototype.catch;
            const refused = function () {
                const result = apply(rejected, PromiseConstructor, [construct(DOMExceptionConstructor, ['history traversal is not available in the sandbox', 'InvalidStateError'])]);
                apply(catchOf, result, [nothing]); // handled here: a guest that ignores it sees no unhandled rejection
                return { committed: result, finished: result };
            };
            for (const name of ['back', 'forward', 'traverseTo']) {
                defineOwn(NavigationConstructor.prototype, name, { value: refused, writable: false, enumerable: true, configurable: false });
            }
        }
        // PD6, window.name. A frame's name is a target the host page's links, forms and window.open() look up, so a
        // guest that named itself received the host's navigations and window.open() handles meant for a window of
        // the host's own. Here window.name reads '' and ignores writes. The platform's accessor is an own property of
        // the window and nothing else holds it, so once it is replaced no guest code can reach it: redefining or
        // deleting this one leaves the frame's name as it is (left configurable, as the platform's was). A frame the
        // guest creates can still be named (`<iframe name>`): host pages should not use named targets (README).
        defineOwn(g, 'name', { get: function () { return ''; }, set: nothing, enumerable: true, configurable: true });
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
    const handleBridgeMessage = bridge ? bridge.handleMessage : null;
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

    // Console output (every level a 'sandbox-log' detail can carry, sandbox-log.ts, info included: backlog B8), relayed
    // from now on, before any guest code runs. Lines logged before the port is attached wait in the outbox like bridge
    // frames, in order with them, and are flushed on attach: a strict entry runs its top level before the view hands
    // the worker its ports, so its synchronous lines were lost when the relay was installed only on attach (independent
    // verification 2026-10-14). At most LOG_BUFFER_LIMIT lines wait (the host dispatches LOG_EVENTS_PER_SECOND, the
    // same number, in any second anyway); past that they are counted, and one warning says how many were dropped.
    const LOG_BUFFER_LIMIT = 1000;
    let logsBuffered = 0;
    let logsDropped = 0;
    const levels = ['log', 'info', 'warn', 'error'] as const;
    for (let i = 0; i < levels.length; i++) {
        const level = levels[i]!;
        const original = sandboxConsole[level];
        sandboxConsole[level] = (...args: any[]) => {
            if (port) post({ type: 'LOG', level, args });
            else if (logsBuffered < LOG_BUFFER_LIMIT) {
                logsBuffered++;
                append(outbox, { type: 'LOG', level, args });
            } else logsDropped++;
            // Log to the actual browser console for easier debugging
            if (original) {
                apply(original, sandboxConsole, args);
            }
        };
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
                // Compiled with the Function captured above and called through the captured apply: what runs is the
                // embedder's code, now. Nothing is reported back: workerExecutionTimeout is the host's ping at the
                // deadline, answered above only by a free event loop (host.ts, _armExecutionBudget). No global is
                // looked up on this path (broad review 2026-10-14, CB2): the code must already be a string (the host
                // sends one; execute() refuses anything else), and nothing converts it, so guest code that replaced
                // String, Error or any other global cannot change what runs.
                if (!scriptUnsafe) {
                    post({ type: 'LOG', level: 'error', args: ['Execution blocked: scriptUnsafe is false'] });
                    return;
                }
                const code = data.code;
                if (typeof code !== 'string') return;
                try {
                    apply(construct(FunctionConstructor, [code]) as () => void, undefined, []);
                } catch (e: any) {
                    try {
                        post({ type: 'LOG', level: 'error', args: [e.message] });
                    } catch {
                        // a thrown value whose message cannot be read or cloned: no line
                    }
                }
                return;
            }
            // RPC frames (RPC_REQ / RPC_RES) and anything else go to the broker, which validates every
            // frame defensively and never throws back out at the message handler. Its handleMessage was taken when
            // the broker was made: guest code can replace bridge.handleMessage, never what this calls.
            if (handleBridgeMessage) handleBridgeMessage(data);
        }]);

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
        if (logsDropped > 0) post({ type: 'LOG', level: 'warn', args: [`[Sandbox] ${logsDropped} console line(s) logged before the sandbox was connected were dropped: at most ${LOG_BUFFER_LIMIT} are kept until then.`] });

        post({ type: 'LOG', level: 'info', args: [`${mode} Ready`] });
    };

    // Iframe mode: the bootstrap's own end of the channel it announced, attached now, before any guest code runs.
    if (announced) {
        attach(announced.port1);
        return { attach, writeFiles };
    }

    // Worker mode: the one INIT_PORT (review B1), the port1 the frame made and announced (worker-bootstrap.ts): a
    // trusted message with exactly one port. In a dedicated worker only the frame that made it can post to it, and
    // no guest code runs here before the port is attached (guest code arrives only as EXECUTE frames on it). A
    // capture listener that stops the event; anything else is ignored and the listener stays. It never throws.
    // Strict mode (externalPort): the strict prelude hands the logic port to attach() itself.
    const onInit = (event: MessageEvent) => {
        if (port || event.isTrusted !== true) return; // isTrusted is an own, unforgeable property
        let data, ports;
        try {
            data = apply(dataOf, event, []);
            ports = apply(portsOf, event, []);
        } catch {
            return;
        }
        if (!data || data.type !== 'INIT_PORT' || !ports || ports.length !== 1) return;
        apply(stopImmediate, event, []);
        try {
            attach(ports[0]);
        } catch {
            port = null; // not a port after all: keep listening for the frame's
        }
    };
    if (!features?.externalPort) g.addEventListener('message', onInit, true);
    return { attach, writeFiles };
}
