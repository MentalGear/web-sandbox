import type { createBroker } from './rpc';
import type { createSizeOf } from './structured-size';

/**
 * The type of the one message the guest frame posts to the host page in cooperative mode, carrying its port (the
 * announcement, broad review 2026-10-14 CB1); the worker-mode frame posts the same one. host.ts accepts exactly one
 * per environment. The stringified functions spell the literal out (they close over nothing); a unit test keeps
 * them equal to this constant.
 */
export const ANNOUNCEMENT_TYPE = 'SANDBOX_PORT';

/**
 * This function is stringified and injected into the sandbox (iframe or worker).
 * It makes (cooperative mode) or receives (worker mode) the guest's end of the channel, relays console output, keeps the
 * EXECUTE escape hatch, and installs the β RPC bridge; in cooperative mode the host's calls and EXECUTE frames wait until
 * the guest document is parsed (the startup gate, below).
 *
 * The RPC broker is injected the same way this function is — createBroker is stringified and
 * passed in — so the guest runs the exact same dispatcher as the host (see rpc.ts). It is
 * published as `globalThis.bridge`: a descriptive name chosen to be very unlikely to clash with
 * guest identifiers (unlike `rpc`, `broker` or `channel`). Guest code calls `bridge.expose(name, fn)`
 * to publish a method and `bridge.call(method, ...args)` to invoke a host method.
 *
 * Everything this function will ever use is taken in one captured list near its top, before any guest code runs, and
 * nothing after that list reads a global, a property of the global object, or a prototype method or getter guest code
 * can replace: every call goes through a captured function and the captured Reflect.apply, no spread or iteration
 * (they consult Array.prototype[Symbol.iterator]), no instanceof (Symbol.hasInstance). Its closures run long after
 * guest code started (every console call, every frame), and each of them enforces something the host relies on: the
 * relay's budgets, the port's secrecy, the startup gate. Before (review round 2, C-1), the relay's token bucket called
 * Math.min when a line was logged, so a guest that set `Math.min = () => Infinity` lifted the per-second caps. A unit
 * test scans the text after the list (`CAPTURE_POINT`), so a regression fails CI.
 */
export function inSandboxScript(
    scriptUnsafe: boolean,
    mode: 'cooperative' | 'worker' | 'strict',
    sandboxConsole: Console,
    createBrokerFn?: typeof createBroker,
    // Opt-in features; the host passes this literal only when one is on, so the bootstrap text of a sandbox
    // without them is unchanged. `externalPort` (strict mode): no INIT_PORT listener of its own; the strict
    // worker prelude takes the ports from the one trusted INIT message and hands the logic port to attach().
    // `guestWrites`: the host records the guest's file writes (backlog C5); returned as `writeFiles` below.
    features?: { autoResize?: boolean; fetchBridge?: { timeoutMs: number }; externalPort?: boolean; guestWrites?: boolean },
    // The byte measure (structured-size.ts), stringified in like createBroker: the console relay's budget and the
    // broker's are measured with it, made before any guest code runs.
    createSizeOfFn?: typeof createSizeOf,
): { attach(port: MessagePort): void; writeFiles: ((request: unknown) => Promise<unknown>) | null; log(level: 'log' | 'info' | 'warn' | 'error', args: unknown[]): void } {
    // The announcement (broad review 2026-10-14, CB1), the first statement, before anything else in the guest
    // document can run: in cooperative mode the bootstrap makes the channel itself, keeps port1 in this closure and
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
    const announced = mode === 'cooperative' ? new MessageChannel() : null;
    if (announced) parent.parent.postMessage({ type: 'SANDBOX_PORT' }, '*', [announced.port2]);

    // ---- The captured list (review B2, C3; review round 2, C-1). The port never reaches guest code (review B2): every
    // operation on it, and on the events that carry it, goes through a primitive captured here and is called through the
    // captured Reflect.apply, so patching MessagePort.prototype (postMessage, onmessage), MessageEvent.prototype (data,
    // ports, source), Event.prototype or Function.prototype afterwards changes nothing this script does, and never hands
    // a patched function the port as `this` or as an argument. (A guest that held the port could hand it to a nested
    // worker that answers the watchdog's pings while the guest loops.) The internal lists are written with a captured
    // defineProperty, or have no prototype, and are read by index, so inherited setters or iterators on Array.prototype
    // see none of it either (review C3). The list only captures: anything that runs later is written below it.
    const g = globalThis as any;
    const apply = Reflect.apply;
    const construct = Reflect.construct;
    const defineOwn = Reflect.defineProperty;
    const deleteOwn = Reflect.deleteProperty;
    const getOwn = Object.getOwnPropertyDescriptor;
    const protoOf = Object.getPrototypeOf;
    const setPrototype = Object.setPrototypeOf;
    const postOnPort = MessagePort.prototype.postMessage;
    const setOnMessage = getOwn(MessagePort.prototype, 'onmessage')!.set!;
    const dataOf = getOwn(MessageEvent.prototype, 'data')!.get!;
    const portsOf = getOwn(MessageEvent.prototype, 'ports')!.get!;
    const stopImmediate = Event.prototype.stopImmediatePropagation;
    const listen = EventTarget.prototype.addEventListener;
    const addGlobalListener = g.addEventListener;
    const PromiseConstructor = Promise;
    const rejected = Promise.reject;
    const then = Promise.prototype.then;
    const promiseCatch = Promise.prototype.catch;
    const StringConstructor = String;
    const TypeErrorConstructor = TypeError;
    const DOMExceptionConstructor = typeof DOMException === 'function' ? DOMException : null;
    // What execute() compiles with (focused review 2026-10-14, F2): captured now, so guest code that replaces
    // globalThis.Function (or Reflect) later cannot choose what an EXECUTE frame runs, or when.
    const FunctionConstructor = Function;
    const clone = g.structuredClone;
    const toTag = Object.prototype.toString;
    const symbolText = Symbol.prototype.toString;
    const slice = String.prototype.slice;
    const startsWith = String.prototype.startsWith;
    const clock = g.performance;
    const nowOf = clock && typeof clock.now === 'function' ? clock.now : null;
    const DateConstructor = Date;
    const dateNow = Date.now;
    const queueMicrotaskFn = g.queueMicrotask;
    const postToFrame = mode === 'worker' && typeof g.postMessage === 'function' ? g.postMessage : null;
    // Bytes (the fetch bridge's request body): copied with set(), which consults no species constructor.
    const Uint8ArrayConstructor = Uint8Array;
    const typedArrayPrototype = protoOf(Uint8Array.prototype);
    const typedSet = typedArrayPrototype.set;
    const bufferBytes = getOwn(ArrayBuffer.prototype, 'byteLength')!.get!;
    const typedBuffer = getOwn(typedArrayPrototype, 'buffer')!.get!;
    const typedOffset = getOwn(typedArrayPrototype, 'byteOffset')!.get!;
    const typedLength = getOwn(typedArrayPrototype, 'byteLength')!.get!;
    const viewBuffer = getOwn(DataView.prototype, 'buffer')!.get!;
    const viewOffset = getOwn(DataView.prototype, 'byteOffset')!.get!;
    const viewLength = getOwn(DataView.prototype, 'byteLength')!.get!;
    const HeadersConstructor = g.Headers;
    const headersForEach = typeof HeadersConstructor === 'function' ? HeadersConstructor.prototype.forEach : null;
    const ResponseConstructor = g.Response;
    // PD2 (below): the platform's fetch and Request, and Request.prototype's keepalive getter.
    const nativeFetch = g.fetch;
    const RequestConstructor = g.Request;
    let keepaliveOf: (() => unknown) | undefined;
    for (let proto = typeof RequestConstructor === 'function' ? RequestConstructor.prototype : null; proto && !keepaliveOf; proto = protoOf(proto)) {
        keepaliveOf = getOwn(proto, 'keepalive')?.get; // own on Request.prototype in every engine measured
    }
    // PD4 (below): the traversal methods' owners.
    const historyPrototype = mode === 'cooperative' && typeof g.History === 'function' ? g.History.prototype : null;
    const navigationPrototype = mode === 'cooperative' && typeof g.Navigation === 'function' ? g.Navigation.prototype : null;
    // Auto-sizing (B6, below): the document and what is measured, through the prototypes' own getters.
    const doc: Document | null = mode === 'cooperative' ? document : null;
    const ResizeObserverConstructor = mode === 'cooperative' && typeof g.ResizeObserver === 'function' ? g.ResizeObserver : null;
    const observe = ResizeObserverConstructor ? ResizeObserverConstructor.prototype.observe : null;
    const rootOf = doc ? getOwn(Document.prototype, 'documentElement')!.get! : null;
    const bodyOf = doc ? getOwn(Document.prototype, 'body')!.get! : null;
    const boundingBox = doc ? Element.prototype.getBoundingClientRect : null;
    const scrollHeightOf = doc ? getOwn(Element.prototype, 'scrollHeight')!.get! : null;
    const clientHeightOf = doc ? getOwn(Element.prototype, 'clientHeight')!.get! : null;
    // The startup gate (below): the document's readyState getter, from its prototype chain.
    let readyStateOf: (() => unknown) | undefined;
    for (let proto = doc ? protoOf(doc) : null; proto && !readyStateOf; proto = protoOf(proto)) {
        readyStateOf = getOwn(proto, 'readyState')?.get; // on Document.prototype in every engine
    }
    const sizeOf = createSizeOfFn ? createSizeOfFn() : null;
    const CAPTURE_POINT = 'nothing below reads a global, or an intrinsic guest code can replace';

    // Lists of our own: an index written to them never reaches an inherited setter, and they are read by index only.
    const list = <T>(): T[] => setPrototype([], null);
    const append = (target: unknown[], value: unknown) => defineOwn(target, target.length, { value, writable: true, enumerable: true, configurable: true });
    const publish = (name: string, value: unknown) => defineOwn(g, name, { value, writable: true, enumerable: true, configurable: true });

    // The port does not exist until INIT_PORT, but guest content scripts parse BEFORE that and may
    // call bridge.expose()/bridge.call() straight away. So the bridge is created now with a send that
    // buffers frames until the port arrives — mirroring how the host queues calls made before ready.
    let port: MessagePort | null = null;
    const outbox: unknown[] = list();
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
    for (let i = 0; i < PEER_CONNECTION_CONSTRUCTORS.length; i++) {
        if (PEER_CONNECTION_CONSTRUCTORS[i]! in g) deleteOwn(g, PEER_CONNECTION_CONSTRUCTORS[i]!);
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
    if (typeof nativeFetch === 'function' && keepaliveOf) {
        const keepalive = keepaliveOf;
        const guardedFetch = function fetch(input: unknown, init?: unknown) {
            let request;
            try {
                request = construct(RequestConstructor, init === undefined ? [input] : [input, init]);
            } catch (error) {
                return apply(rejected, PromiseConstructor, [error]);
            }
            if (apply(keepalive, request, []) === true) {
                return apply(rejected, PromiseConstructor, [construct(TypeErrorConstructor, ['fetch() with keepalive is not available in the sandbox'])]);
            }
            return apply(nativeFetch, g, [request]);
        };
        defineOwn(g, 'fetch', { value: guardedFetch, writable: true, enumerable: true, configurable: false });
    }
    // PD4, history traversal (cooperative mode). history.back(), forward() and go() traverse the whole tab's session
    // history, so a guest's history.back() navigated the HOST page in Firefox and WebKit; the Navigation API's back(),
    // forward() and traverseTo() reach the same history where it exists. In the guest realm they do nothing
    // (the Navigation API's resolve nothing and reject as when there is no entry to go to): not configurable,
    // so guest code cannot put them back, and no other same-origin realm holds the originals.
    const nothing = function () {};
    if (historyPrototype) {
        const TRAVERSALS = ['back', 'forward', 'go'];
        for (let i = 0; i < TRAVERSALS.length; i++) defineOwn(historyPrototype, TRAVERSALS[i]!, { value: nothing, writable: false, enumerable: true, configurable: false });
    }
    if (navigationPrototype && DOMExceptionConstructor) {
        const refused = function () {
            const result = apply(rejected, PromiseConstructor, [construct(DOMExceptionConstructor, ['history traversal is not available in the sandbox', 'InvalidStateError'])]);
            apply(promiseCatch, result, [nothing]); // handled here: a guest that ignores it sees no unhandled rejection
            return { committed: result, finished: result };
        };
        const TRAVERSALS = ['back', 'forward', 'traverseTo'];
        for (let i = 0; i < TRAVERSALS.length; i++) defineOwn(navigationPrototype, TRAVERSALS[i]!, { value: refused, writable: false, enumerable: true, configurable: false });
    }
    // PD6, window.name (cooperative mode). A frame's name is a target the host page's links, forms and window.open()
    // look up, so a guest that named itself received the host's navigations and window.open() handles meant for a window
    // of the host's own. Here window.name reads '' and ignores writes. The platform's accessor is an own property of
    // the window and nothing else holds it, so once it is replaced no guest code can reach it: redefining or
    // deleting this one leaves the frame's name as it is (left configurable, as the platform's was). A frame the
    // guest creates can still be named (`<iframe name>`): host pages should not use named targets (README).
    if (mode === 'cooperative') defineOwn(g, 'name', { get: function () { return ''; }, set: nothing, enumerable: true, configurable: true });

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
    if (typeof addGlobalListener === 'function') {
        apply(addGlobalListener, g, ['securitypolicyviolation', (event: any) => {
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
        }, true]);
    }

    // Content auto-sizing (backlog B6, src/lib/auto-resize.ts), opt-in and cooperative mode only: a worker has no
    // document. A ResizeObserver on the root element reports the content height as a RESIZE frame, outside
    // the broker like VIOLATION. Its callbacks run at most once per rendering update, after layout, so the
    // guest measures once per frame and sends only a changed height. The measure is the root element's
    // box, which follows content in normal flow both ways (it shrinks too, unlike the root's scrollHeight,
    // which never reads less than the viewport); when content overflows the viewport, scrollHeight, so
    // overflow the root's box does not contain still grows the frame. The body is observed as well once it
    // exists, for guests whose root is pinned to the viewport (html { height: 100% }). The host validates,
    // clamps and rate-limits every report: guest code can reach the port and post its own.
    if (features?.autoResize === true && doc && ResizeObserverConstructor && observe && rootOf && bodyOf && boundingBox && scrollHeightOf && clientHeightOf) {
        let lastHeight = -1;
        const measure = () => {
            const root = apply(rootOf, doc, []);
            if (!root) return;
            const box = (apply(boundingBox, root, []) as DOMRect).height;
            const whole = box - (box % 1);
            const rounded = whole < box ? whole + 1 : whole; // Math.ceil, without Math
            const scrolled = apply(scrollHeightOf, root, []) as number;
            const height = scrolled > (apply(clientHeightOf, root, []) as number) && scrolled > rounded ? scrolled : rounded;
            if (height === lastHeight) return;
            lastHeight = height;
            send({ type: 'RESIZE', height });
        };
        const resizeObserver = construct(ResizeObserverConstructor, [measure]);
        apply(observe, resizeObserver, [apply(rootOf, doc, [])]);
        apply(listen, doc, ['DOMContentLoaded', () => {
            const body = apply(bodyOf, doc, []);
            if (body) apply(observe, resizeObserver, [body]);
        }]);
    }

    // The guest's broker accepts a library code (FETCH_*) in the refusal of a call to a reserved method, so
    // sandboxFetch() rejects with the host's code; the host's broker never accepts one (see rpc.ts).
    const bridge = createBrokerFn ? createBrokerFn(send, { acceptLibraryCodes: true, sizeOf: sizeOf ?? undefined }) : null;
    const handleBridgeMessage = bridge ? bridge.handleMessage : null;
    if (bridge) publish('bridge', bridge);

    // The host-mediated fetch bridge (backlog B5, src/lib/fetch-bridge.ts, ADR-006), opt-in, both modes. A
    // separate global, never a replacement for fetch: guest code that wants it as fetch assigns it itself.
    // It sends only url, method, headers and body (string, ArrayBuffer or typed array) to the reserved
    // sandbox:fetch method; the host decides everything else and refuses with a FETCH_* code. The broker's
    // own timeout is a backstop a little past the host's, so the host's FETCH_TIMEOUT normally arrives first.
    // Whole responses only: the answer becomes a Response here, with its body in memory.
    // Defined in every environment (review round 1, R4-8): without the bridge the host refuses every request with
    // FETCH_NOT_ALLOWED ("the fetch bridge is off"), as docs/API.md says, where the global used to be missing and a
    // call threw a ReferenceError. One path either way: the host decides.
    if (bridge) {
        const callWithTimeout = bridge.callWithTimeout;
        const callTimeoutMs = (features?.fetchBridge ? features.fetchBridge.timeoutMs : 10000) + 5000;
        const NULL_BODY_STATUSES = [101, 103, 204, 205, 304];
        const isNullBody = (status: unknown) => {
            for (let i = 0; i < NULL_BODY_STATUSES.length; i++) if (NULL_BODY_STATUSES[i] === status) return true;
            return false;
        };
        // A copy of the bytes an ArrayBuffer, a typed array or a DataView holds, or null for anything else.
        const VIEW_GETTERS = [[typedBuffer, typedOffset, typedLength], [viewBuffer, viewOffset, viewLength]];
        const bytesCopy = (value: unknown): Uint8Array | null => {
            let source: Uint8Array | null = null;
            try {
                source = construct(Uint8ArrayConstructor, [value, 0, apply(bufferBytes, value, [])]);
            } catch {
                for (let i = 0; i < VIEW_GETTERS.length && !source; i++) {
                    const getters = VIEW_GETTERS[i]!;
                    try {
                        source = construct(Uint8ArrayConstructor, [apply(getters[0]!, value, []), apply(getters[1]!, value, []), apply(getters[2]!, value, [])]);
                    } catch {
                        source = null;
                    }
                }
            }
            if (!source) return null;
            const copy = construct(Uint8ArrayConstructor, [apply(typedLength, source, [])]);
            apply(typedSet, copy, [source]);
            return copy;
        };
        const toBody = (body: any) => {
            if (body === undefined || body === null) return undefined;
            if (typeof body === 'string') return body;
            const bytes = bytesCopy(body);
            if (bytes) return bytes;
            throw construct(TypeErrorConstructor, ['sandboxFetch: the body must be a string, an ArrayBuffer or a typed array']);
        };
        publish('sandboxFetch', (input: unknown, init?: any) => {
            let request;
            try {
                const options = init || {};
                const headers: [string, string][] = list();
                if (HeadersConstructor && headersForEach) {
                    apply(headersForEach, construct(HeadersConstructor, [options.headers]), [(value: string, name: string) => append(headers, [name, value])]);
                }
                request = { url: StringConstructor(input), method: options.method === undefined ? 'GET' : StringConstructor(options.method), headers, body: toBody(options.body) };
            } catch (error) {
                return apply(rejected, PromiseConstructor, [error]);
            }
            return construct(PromiseConstructor, [(resolve: (value: unknown) => void, reject: (error: unknown) => void) => {
                apply(then, callWithTimeout(callTimeoutMs, 'sandbox:fetch', request), [(result: any) => {
                    try {
                        const status = result.status;
                        const response: object = construct(ResponseConstructor, [isNullBody(status) ? null : result.body, { status, statusText: result.statusText, headers: result.headers }]);
                        defineOwn(response, 'url', { value: result.url });
                        resolve(response);
                    } catch (error) {
                        reject(error);
                    }
                }, reject]);
            }]);
        });
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

    // ---- The console relay (review round 1: R4-1, R3-3, R4-2, R4-6, R4-7): the one chokepoint every guest log line
    // goes through, in every mode (cooperative, worker, and strict, whose prelude logs through `log` below). It never
    // throws, whatever the guest logs, and what it posts is bounded before it is posted:
    //   - at most LOG_MAX_ARGS arguments, strings cut at LOG_MAX_STRING (the host cuts again on receipt);
    //   - an Error or DOMException becomes { name, message, stack }, strings cut the same way;
    //   - a value structured clone refuses (a function, a Symbol, a DOM node, an Event, a Response, a Proxy, a WeakMap,
    //     a Promise) becomes a string that names its kind, instead of a DataCloneError thrown at the guest's console
    //     call (before, `console.log(() => {})` threw in cooperative mode and in the worker, and the line was lost);
    //   - all arguments of one line together measure at most LOG_MAX_BYTES (structured-size.ts, with primitives
    //     captured now): an argument past what is left of it becomes a string saying so, so
    //     `console.log(new Uint8Array(64 MiB))` crosses as a few bytes;
    //   - at most LOG_LINES_PER_SECOND lines and LOG_BYTES_PER_SECOND bytes leave in any one-second window (the host's
    //     own rule and constant, below): the host dispatches no more than that anyway, and a line dropped here is never cloned onto the host's thread,
    //     which is what a flood within the per-line caps cost (Firefox's host ran ~7 ticks per second). The first
    //     dropped line sends one warning, once per environment.
    // Each argument is cloned once here, with the captured structuredClone (review round 2, C-3), and the clone, the
    // snapshot, is what is measured and what the line carries: a getter cannot answer the measure one way and the post
    // another, and a line buffered before the port is attached holds its values as they were when logged, as postMessage
    // would, and is known to post. Mirrors of LOG_MAX_ARGS, LOG_MAX_STRING, LOG_EVENTS_PER_SECOND, LOG_MAX_BYTES and
    // LOG_BYTES_PER_SECOND (sandbox-log.ts; a test keeps them equal): declared here to survive stringification.
    const LOG_MAX_ARGS = 64;
    const LOG_MAX_STRING = 65536;
    const LOG_MAX_BYTES = 1048576;
    const LOG_LINES_PER_SECOND = 1000;
    const LOG_BYTES_PER_SECOND = 4194304;
    // At most LOG_BUFFER_LIMIT lines (and LOG_BYTES_PER_SECOND bytes) wait for the port (a strict entry's top level runs
    // before the view hands the worker its ports: independent verification 2026-10-14): one window's worth, so they fit
    // the host's window when they are flushed (M-2). Past either they are counted, and one warning on attach says how
    // many were dropped, and for which cap.
    const LOG_BUFFER_LIMIT = LOG_LINES_PER_SECOND;
    const now = (): number => (nowOf ? apply(nowOf, clock, []) : apply(dateNow, DateConstructor, []));
    const cut = (text: string) => (text.length > LOG_MAX_STRING ? apply(slice, text, [0, LOG_MAX_STRING]) as string : text);
    const tagOf = (value: unknown): string => {
        try {
            return apply(toTag, value, []) as string;
        } catch {
            return '[object]';
        }
    };
    // The string form of a value clone refuses: its kind, never its contents (a function's source, a node's markup).
    const describe = (value: unknown): string => {
        if (typeof value === 'symbol') {
            try {
                return cut(apply(symbolText, value, []) as string);
            } catch {
                return '[symbol]';
            }
        }
        if (typeof value === 'function') return '[function]';
        return tagOf(value);
    };
    const textOf = (value: unknown): string => (typeof value === 'string' ? cut(value) : '');
    const isErrorLike = (value: unknown) => {
        if (!value || typeof value !== 'object') return false;
        const tag = tagOf(value);
        return tag === '[object Error]' || tag === '[object DOMException]';
    };
    const errorForm = (value: any) => {
        const form = { name: '', message: '', stack: '' };
        try {
            form.name = textOf(value.name);
            form.message = textOf(value.message);
            form.stack = textOf(value.stack);
        } catch {
            // a getter that throws: what was read so far
        }
        return form;
    };
    // A thrown or rejected value as text: an error's "name: message", anything else by kind (a primitive as itself).
    const errorText = (value: unknown): string => {
        if (typeof value === 'string') return cut(value);
        if (isErrorLike(value)) {
            const form = errorForm(value);
            return form.name ? (form.message ? form.name + ': ' + form.message : form.name) : form.message;
        }
        if (value === null || (typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'symbol')) return '' + (value as string);
        return describe(value);
    };
    // "Uncaught …" once: Chromium's ErrorEvent message already starts with it, Firefox's and WebKit's do not.
    const uncaught = (text: string) => (apply(startsWith, text, ['Uncaught ']) ? text : 'Uncaught ' + text);
    // One argument's snapshot (C-3): its clone, or, for a value clone refuses deeper in (a function in an object, a
    // Proxy), its kind.
    const snapshot = (value: unknown): unknown => {
        try {
            return clone(value);
        } catch {
            return describe(value);
        }
    };

    // The line to post, its bytes, and whether it is smaller than what was logged (an argument, a string or a byte
    // budget cut). Its arguments are snapshots, strings, and primitives.
    const safeArgs = (args: unknown[]): { line: unknown[]; bytes: number; cut: boolean } => {
        let reduced = args.length > LOG_MAX_ARGS;
        const count = reduced ? LOG_MAX_ARGS : args.length;
        const out: unknown[] = list();
        let left = LOG_MAX_BYTES;
        for (let i = 0; i < count; i++) {
            let value = args[i];
            if (typeof value === 'string') {
                value = cut(value);
                if (value !== args[i]) reduced = true;
            } else if (typeof value === 'symbol' || typeof value === 'function') value = describe(value);
            else if (isErrorLike(value)) value = errorForm(value);
            else if (typeof value === 'object' && value !== null) value = snapshot(value);
            const bytes = sizeOf ? sizeOf(value, left) : 0;
            if (bytes > left) {
                reduced = true;
                value = '[' + (typeof value === 'object' && value !== null ? tagOf(value) : typeof value) + ': past the log line\'s byte budget (' + LOG_MAX_BYTES + ')]';
                left -= (value as string).length * 2 + 8;
            } else {
                left -= bytes;
            }
            out[out.length] = value;
        }
        return { line: out, bytes: LOG_MAX_BYTES - left + 16, cut: reduced };
    };

    // The per-second budgets: at most `limit` in any one-second window, the host's own rule for guest lines
    // (LOG_EVENTS_PER_SECOND, rate-limit.ts) with the same constant (review round 2, M-1): each admitted weight is kept
    // with its time until it leaves the window. A token bucket, as before, let a full bucket and its refill through in
    // one window, twice what the host dispatches, so the host dropped lines the guest had relayed, among them the
    // relay's own warning that it had started dropping. Inline arithmetic and lists of our own only (C-1: Math.min, which
    // the bucket called, is the guest's to replace). `admit(weight, true)` records a weight already spent (the lines
    // flushed on attach, below) whatever the window holds.
    const slidingWindow = (limit: number) => {
        const times: number[] = list();
        const weights: number[] = list();
        let head = 0; // entries before head have left the window
        let total = 0;
        return (weight: number, spent?: boolean): boolean => {
            const at = now();
            while (head < times.length && times[head]! <= at - 1000) {
                total -= weights[head]!;
                head++;
            }
            if (head > 64 && head * 2 > times.length) { // drop what left the window, now and then
                let kept = 0;
                for (let i = head; i < times.length; i++, kept++) {
                    times[kept] = times[i]!;
                    weights[kept] = weights[i]!;
                }
                times.length = kept;
                weights.length = kept;
                head = 0;
            }
            if (!spent && total + weight > limit) return false;
            if (weight > 0) {
                times[times.length] = at;
                weights[weights.length] = weight;
                total += weight;
            }
            return true;
        };
    };
    const lineBudget = slidingWindow(LOG_LINES_PER_SECOND);
    const byteBudget = slidingWindow(LOG_BYTES_PER_SECOND);
    let logsBuffered = 0;
    let droppedForLines = 0; // before the port: past LOG_BUFFER_LIMIT lines
    let droppedForBytes = 0; // before the port: past LOG_BYTES_PER_SECOND bytes
    let rateDropped = false; // past the per-second budgets: warned once per environment
    let bufferedBytes = 0;
    // The relay's own lines ('<mode> Ready' and its warnings, each at most once per environment) are marked `own`: the
    // host dispatches up to LOG_OWN_LINES of them per environment besides the guest's lines (sandbox-log.ts), so the
    // warning that lines were dropped arrives even when the lines before it filled the host's window (M-1, M-2). Only the
    // bootstrap posts on the port (guest code never holds it, review B2), so no guest line is ever marked.
    const ownLine = (level: 'warn', text: string) => {
        try {
            post({ type: 'LOG', level, args: [text], own: true });
        } catch {
            // nothing a guest logs can make the relay throw at its console call
        }
    };
    // Relays one line, and says what the browser's own console may be given: the line as logged when it was relayed
    // whole, else the bounded line; null when it was dropped. `level` null: a console call that relays nothing to the
    // host (count, time, …) but reaches the browser's console, bounded and budgeted the same way. The browser's console
    // is the other way a line reaches the host page's thread: Chromium and Firefox hand a worker's console arguments to
    // the page (measured: a worker logging 64 strings of 64 Ki characters in a loop cost Firefox's host page half its
    // ticks with only 21 lines relayed), so a dropped line goes nowhere and a cut one goes there cut.
    // Before the port is attached a line waits in the outbox: at most LOG_BUFFER_LIMIT lines and LOG_BYTES_PER_SECOND
    // bytes (they are flushed in one go on attach); once attached the per-second budgets apply.
    const relayLine = (level: 'log' | 'info' | 'warn' | 'error' | null, args: unknown[]): unknown[] | null => {
        if (port && !lineBudget(1)) return dropped();
        let line: unknown[];
        let bytes = 0;
        let reduced = true;
        try {
            const safe = safeArgs(args);
            line = safe.line;
            bytes = safe.bytes;
            reduced = safe.cut;
        } catch {
            line = list();
            line[0] = '[Sandbox] a console line could not be relayed';
            bytes = 128;
        }
        if (!port) {
            if (logsBuffered >= LOG_BUFFER_LIMIT) {
                droppedForLines++;
                return null;
            }
            if (bufferedBytes + bytes > LOG_BYTES_PER_SECOND) {
                droppedForBytes++;
                return null;
            }
            logsBuffered++;
            bufferedBytes += bytes;
            if (level !== null) append(outbox, { type: 'LOG', level, args: line });
            return reduced ? line : args;
        }
        if (!byteBudget(bytes)) return dropped();
        if (level !== null) {
            try {
                post({ type: 'LOG', level, args: line });
            } catch {
                // nothing a guest logs can make the relay throw at its console call
            }
        }
        return reduced ? line : args;
    };
    const dropped = (): null => {
        if (rateDropped) return null;
        rateDropped = true;
        ownLine('warn', `[Sandbox] the guest logged more than ${LOG_LINES_PER_SECOND} lines or ${LOG_BYTES_PER_SECOND} bytes in one second; lines past that are dropped in the sandbox.`);
        return null;
    };
    const log = (level: 'log' | 'info' | 'warn' | 'error', args: unknown[]) => {
        relayLine(level, args);
    };

    // Every console method that takes arguments (review round 2, C-2): each is a wrapper of ours, built here with index
    // loops only (no spread, no slice, no iterator: a patched Array.prototype[Symbol.iterator] made the old trace and
    // assert wrappers throw, and the catch then gave the browser's console the raw arguments). A wrapper relays its line
    // and hands the browser's console only what relayLine() allows; if anything throws, it hands it nothing: a line
    // that could not be relayed goes nowhere. log, info, warn and error relay at their level; debug, dir, dirxml, table,
    // group and groupCollapsed as 'log' lines; trace as a 'log' line that says so; a failed assert as an 'error' line
    // (a passing one does nothing, here and in the browser). count, countReset, time, timeLog, timeEnd, timeStamp,
    // profile and profileEnd relay nothing to the host, but take arguments to the browser's console: they are bounded
    // and budgeted like a line (before, they reached it unbounded, past every budget). groupEnd and clear take none.
    type Level = 'log' | 'info' | 'warn' | 'error';
    const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'dir', 'dirxml', 'table', 'group', 'groupCollapsed', 'trace', 'assert',
        'count', 'countReset', 'time', 'timeLog', 'timeEnd', 'timeStamp', 'profile', 'profileEnd'];
    const LEVELS: (Level | null)[] = ['log', 'info', 'warn', 'error', 'log', 'log', 'log', 'log', 'log', 'log', 'log', 'error',
        null, null, null, null, null, null, null, null];
    // What one console call relays and what the browser's console is given (null: nothing).
    const consoleCall = (name: string, level: Level | null, args: unknown[]): unknown[] | null => {
        if (name === 'assert' && args.length > 0 && args[0]) return null; // a passing assert: nothing, anywhere
        // The relayed line: our own words first (trace, assert), then the call's arguments (an assert's after its condition).
        const line: unknown[] = list();
        const from = name === 'assert' ? 1 : 0;
        if (name === 'trace') line[0] = 'console.trace()';
        if (name === 'assert') line[0] = 'Assertion failed:';
        const ours = line.length;
        for (let i = from; i < args.length; i++) line[line.length] = args[i];
        if (name === 'assert' && line.length === ours) line[line.length] = 'console.assert';
        const shown = relayLine(level, line);
        if (shown === null) return null;
        if (shown === line) return args; // relayed whole: the browser's console gets the call as it was made
        // cut: the bounded arguments, after our own words, behind a failed assert's condition
        const given: unknown[] = list();
        if (name === 'assert') given[0] = false;
        for (let i = ours; i < shown.length; i++) given[given.length] = shown[i];
        return given;
    };
    // The browser's own console is given a line only in cooperative mode, for debugging the guest document in its frame
    // (review round 2, M-5). In a worker (worker and strict mode) the relay is the only sink: Chromium keeps a worker's
    // console arguments in the page's memory (measured: +445 MiB in 90 s of lines within the 4 MiB/s budget), and the
    // host's 'sandbox-log' is the documented place to read them.
    const toBrowserConsole = mode === 'cooperative';
    for (let i = 0; i < CONSOLE_METHODS.length; i++) {
        const name = CONSOLE_METHODS[i]!;
        const level = LEVELS[i]!;
        const original = (sandboxConsole as any)[name];
        (sandboxConsole as any)[name] = (...args: any[]) => {
            let given: unknown[] | null = null;
            try {
                given = consoleCall(name, level, args);
            } catch {
                given = null; // a line that could not be relayed goes nowhere
            }
            if (given === null || !toBrowserConsole || typeof original !== 'function') return;
            try {
                apply(original, sandboxConsole, given); // for easier debugging: what relayLine() allows
            } catch {
                // the browser's console refused it: the relayed line stands
            }
        };
    }

    // Uncaught errors and unhandled rejections (R4-2, R4-6): relayed as 'error' lines, "Uncaught …" and
    // "Uncaught (in promise) …", from capture listeners on the global installed before any guest code runs, and left
    // to reach the browser's console as well. Errors in cooperative and worker mode, trusted ones only; in strict
    // mode the prelude owns the error event (an entry's own error ends the sandbox, in-sandbox-view.ts) and logs
    // later ones through `log`. Unhandled rejections in every mode, trusted or not: WebKit (every realm) and Firefox
    // (workers) dispatch the platform's own with isTrusted false (measured), and a forged one makes only a line the
    // guest could log itself. What the browser gives is all there is: WebKit mutes the errors of the guest
    // document's inline scripts and of a worker's blob: script ("Script error.", no error object; measured).
    if (typeof addGlobalListener === 'function') {
        if (mode !== 'strict') {
            apply(addGlobalListener, g, ['error', (event: any) => {
                if (event.isTrusted !== true) return;
                let text = '';
                try {
                    text = event.error !== null && event.error !== undefined ? errorText(event.error) : textOf(event.message);
                    if (!text) text = textOf(event.message) || 'an error';
                } catch {
                    text = 'an error';
                }
                log('error', [uncaught(text)]);
            }, true]);
        }
        apply(addGlobalListener, g, ['unhandledrejection', (event: any) => {
            let text = '';
            try {
                text = errorText(event.reason);
            } catch {
                text = 'a rejection';
            }
            log('error', ['Uncaught (in promise) ' + text]);
        }, true]);
    }

    // One frame from the host that runs guest code: an EXECUTE, or an RPC_REQ (the broker calls the exposed method).
    const run = (data: any) => {
        if (data?.type === 'EXECUTE') {
            // Compiled with the Function captured above and called through the captured apply: what runs is the
            // embedder's code, now. Nothing is reported back: workerExecutionTimeout is the host's ping at the
            // deadline, answered above only by a free event loop (host.ts, _armExecutionBudget). No global is
            // looked up on this path (broad review 2026-10-14, CB2): the code must already be a string (the host
            // sends one; execute() refuses anything else), and nothing converts it, so guest code that replaced
            // String, Error or any other global cannot change what runs.
            if (!scriptUnsafe) {
                log('error', ['Execution blocked: scriptUnsafe is false']);
                return;
            }
            const code = data.code;
            if (typeof code !== 'string') return;
            try {
                apply(construct(FunctionConstructor, [code]) as () => void, undefined, []);
            } catch (e: any) {
                let text = '';
                try {
                    text = e && typeof e.message === 'string' ? cut(e.message) : errorText(e);
                } catch {
                    text = 'an error'; // a thrown value whose message cannot be read
                }
                log('error', [text]);
            }
            return;
        }
        // RPC frames (RPC_REQ / RPC_RES) and anything else go to the broker, which validates every
        // frame defensively and never throws back out at the message handler. Its handleMessage was taken when
        // the broker was made: guest code can replace bridge.handleMessage, never what this calls.
        if (handleBridgeMessage) handleBridgeMessage(data);
    };

    // The startup gate (backlog S46, cooperative mode; ADR-003 amendment). The host is `ready` as soon as this bootstrap
    // has announced its port, before the parser has reached the guest's own scripts, so a call or an execute() can
    // arrive while the methods those scripts expose do not exist yet. Such frames (RPC_REQ, EXECUTE) wait here, in
    // one queue in arrival order, until the guest document is parsed: a trusted DOMContentLoaded has fired (deferred
    // and module scripts have run by then), or readyState reads 'complete'; and readyState does not read 'loading'
    // (a guest that reopened its document with document.open() is parsing again). PING and RPC_RES never wait: the
    // watchdog measures the event loop from `ready` on, and the guest's own calls get their answers. A guest that
    // never finishes parsing (document.open() without close()) stays ready and alive; the calls it is sent time out.
    // The queue is checked on every frame that arrives, not only at DOMContentLoaded (a capture listener on the
    // document), because document.open() erases the document's listeners; each frame that waits registers it again
    // (a no-op while it is registered), so the reopened document's own DOMContentLoaded drains the queue too. Held
    // frames run one per microtask, so a call's method runs before the next frame, as it would have on arrival. At
    // most MAX_HELD wait: past that a call is answered BUSY at once and an execute() is dropped with a log line.
    // Every primitive is captured above, before guest code (review B2): a guest that replaces
    // Document.prototype.readyState, shadows document.readyState or dispatches its own DOMContentLoaded cannot open
    // the gate early. A guest can only keep it closed for itself (document.open(), or stopping the event in a
    // listener of its window): its own calls then wait for 'complete' or time out. Worker and strict mode have no
    // gate: their guest code runs only in a worker, which has no document.
    // Mirrors the exported MAX_INBOUND_IN_FLIGHT (rpc.ts; a test keeps them equal): declared here to survive stringification.
    const MAX_HELD = 256;
    const held: unknown[] = list();
    let nextHeld = 0;     // index of the next frame to run; held.length - nextHeld frames wait
    let parsed = false;   // a trusted DOMContentLoaded has fired
    let draining = false; // a drain is running, one frame per microtask
    const gateOpen = () => {
        if (!doc || !readyStateOf) return true;
        const state = apply(readyStateOf, doc, []);
        return state === 'complete' || (parsed && state !== 'loading');
    };
    const drainStep = () => {
        if (nextHeld >= held.length || !gateOpen()) {
            if (nextHeld >= held.length) {
                held.length = 0;
                nextHeld = 0;
            }
            draining = false;
            return;
        }
        const frame = held[nextHeld];
        held[nextHeld] = undefined;
        nextHeld++;
        try {
            run(frame);
        } finally {
            apply(queueMicrotaskFn, g, [drainStep]);
        }
    };
    const drain = () => {
        if (draining || nextHeld >= held.length || !gateOpen()) return;
        draining = true;
        drainStep();
    };
    const onParsed = (event: Event) => {
        if (event.isTrusted !== true) return; // isTrusted is an own, unforgeable property
        parsed = true;
        drain();
    };
    const hold = (data: any) => {
        if (held.length - nextHeld < MAX_HELD) {
            held[held.length] = data;
            apply(listen, doc, ['DOMContentLoaded', onParsed, true]);
            return;
        }
        if (data.type === 'EXECUTE') {
            log('error', [`[Sandbox] execute() was dropped: ${MAX_HELD} calls and executions are already waiting for the guest document to be parsed.`]);
            return;
        }
        const id = data.id;
        if (typeof id !== 'string' && typeof id !== 'number') return; // malformed: dropped, as the broker drops it
        post({ type: 'RPC_RES', id, ok: false, error: `too many calls waiting for the guest document to be parsed (${MAX_HELD})`, code: 'BUSY' });
    };
    if (doc) apply(listen, doc, ['DOMContentLoaded', onParsed, true]);

    const attach = (handedPort: MessagePort) => {
        if (port) return;
        port = handedPort;

        apply(setOnMessage, port, [(ev: MessageEvent) => {
            const data = apply(dataOf, ev, []);
            drain(); // frames that waited go first, once the document is parsed
            // The host's liveness watchdog (backlog S6, src/lib/watchdog.ts). Answered here, before the
            // broker, so it is not a callable method: it can never collide with a name the guest exposes,
            // and guest code cannot unexpose or replace it. Answering at all is the signal — a blocked
            // event loop cannot run this handler.
            if (data?.type === 'PING') {
                if (typeof data.n === 'number') post({ type: 'PONG', n: data.n });
                return;
            }
            const runsGuestCode = data?.type === 'EXECUTE' || data?.type === 'RPC_REQ';
            if (runsGuestCode && (nextHeld < held.length || !gateOpen())) {
                hold(data);
                return;
            }
            run(data);
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
        // The lines buffered before the port count against this second's budgets as they leave now (M-2): at most
        // LOG_BUFFER_LIMIT (= LOG_LINES_PER_SECOND) lines and LOG_BYTES_PER_SECOND bytes, what one window holds, so the
        // guest's lines that follow at once wait for the window like any others, and the host dispatches all of them.
        lineBudget(logsBuffered, true);
        byteBudget(bufferedBytes, true);
        if (skipped > 0) ownLine('warn', `[bridge] skipped ${skipped} queued bridge frame(s) that could not be posted (not transferable).`);
        if (droppedForLines + droppedForBytes > 0) {
            const caps = (droppedForLines > 0 ? `${droppedForLines} past ${LOG_BUFFER_LIMIT} lines` : '')
                + (droppedForLines > 0 && droppedForBytes > 0 ? ', ' : '')
                + (droppedForBytes > 0 ? `${droppedForBytes} past ${LOG_BYTES_PER_SECOND} bytes` : '');
            ownLine('warn', `[Sandbox] ${droppedForLines + droppedForBytes} console line(s) logged before the sandbox was connected were dropped (${caps}): at most ${LOG_BUFFER_LIMIT} lines and ${LOG_BYTES_PER_SECOND} bytes are kept until then.`);
        }

        // posted as it is, never swallowed: a port that cannot carry it is no port, and attach() throws (onInit)
        post({ type: 'LOG', level: 'info', args: [`${mode} Ready`], own: true });
    };

    // Cooperative mode: the bootstrap's own end of the channel it announced, attached now, before any guest code runs.
    if (announced) {
        attach(announced.port1);
        return { attach, writeFiles, log };
    }

    // Worker mode: the one INIT_PORT (review B1), the port1 the frame made (worker-bootstrap.ts): a trusted message with
    // exactly one port. In a dedicated worker only the frame that made it can post to it, and no guest code runs here
    // before the port is attached (guest code arrives only as EXECUTE frames on it). A capture listener that stops the
    // event; anything else is ignored and the listener stays. It never throws. Once the port is attached, the worker
    // tells the frame it runs (WORKER_STARTED, review round 2, C-5): the frame announces the port to the host only then,
    // so the host is never `ready` with no worker behind the port.
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
            return;
        }
        try {
            if (postToFrame) apply(postToFrame, g, [{ type: 'WORKER_STARTED' }]);
        } catch {
            // no frame to tell (a unit test's stand-in): the port is attached all the same
        }
    };
    if (!features?.externalPort && typeof addGlobalListener === 'function') apply(addGlobalListener, g, ['message', onInit, true]);
    return { attach, writeFiles, log };
}
