/**
 * The guest bootstrap of every mode: stringified into the realm, it makes the guest's end of the logic port, relays
 * console output and installs the bridge.
 */
import type { createBroker } from './rpc';
import type { createSizeOf } from './structured-size';
import type { FrameType } from './frames';
import type { LimitValue } from './limits';
import type { GATE_SOURCE_FILE } from './violation';

/**
 * The type of the one message the guest frame posts to the host page in cooperative mode, carrying its port (the
 * announcement, BR:CB1); the worker-mode frame posts the same one. host.ts accepts exactly one
 * per environment. The stringified functions spell the literal out (they close over nothing); a unit test keeps
 * them equal to this constant.
 */
export const ANNOUNCEMENT_TYPE = 'SANDBOX_PORT' satisfies FrameType;

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
 * relay's budgets, the port's secrecy, the startup gate (R2:C-1: a relay that called Math.min when a line was logged
 * would let a guest that set `Math.min = () => Infinity` lift the per-second caps). A unit test scans the text after the
 * list (`CAPTURE_POINT`), so a regression fails CI.
 */
export function inSandboxScript(
    scriptUnsafe: boolean,
    mode: 'cooperative' | 'worker' | 'strict',
    sandboxConsole: Console,
    createBrokerFn?: typeof createBroker,
    // The features, one literal from the host: the opt-in ones only when on. `externalPort` (strict mode): no INIT_PORT
    // listener of its own; the strict worker prelude takes the ports from the one trusted INIT message and hands the
    // logic port to attach().
    // `guestWrites`: the host records the guest's file writes (BL:C5); returned as `writeFiles` below.
    // `callBudget`: the per-second budget of the calls the guest makes (R3:M-2), from the element's config
    // (`callLimits`); the host always passes it. A call heavier than its bytes is refused for good (config-schema.ts).
    // `listeners`: the listeners this bootstrap installs, the egress table's rows for this mode (egress.ts,
    // bootstrapListeners): it installs these and no other. `uncaught`: the per-second budget of uncaught errors and
    // rejections (worker and strict mode; egress.ts), past which it tells the element, which ends the sandbox.
    // `connect`: the sources of the guest policy's connect-src, exactly (csp-generator.ts, connectSources): the request
    // gate admits these and nothing else; absent, it admits nothing.
    features?: {
        autoResize?: boolean; fetchBridge?: { timeoutMs: number }; externalPort?: boolean; guestWrites?: boolean; callBudget?: { calls: number; bytes: number };
        listeners?: readonly { type: string; relay: boolean; cancel: boolean; budget: boolean }[]; uncaught?: { count: number; characters: number };
        connect?: readonly string[];
    },
    // The byte measure (structured-size.ts), stringified in like createBroker: the console relay's budget and the
    // broker's are measured with it, made before any guest code runs.
    createSizeOfFn?: typeof createSizeOf,
    // Worker mode: the platform's postMessage of the worker, which the globals allowlist took before deleting it
    // (worker-globals.ts, R4:M-1), for the one WORKER_STARTED below. Nothing else in the worker holds it.
    postToFrameFn?: ((message: unknown) => void) | null,
): {
    attach(port: MessagePort): void;
    writeFiles: ((request: unknown) => Promise<unknown>) | null;
    log(level: 'log' | 'info' | 'warn' | 'error', args: unknown[]): void;
    readEvent(event: unknown, kind: 'error' | 'rejection' | 'violation'): Record<string, unknown>;
} {
    // The announcement (BR:CB1), the first statement, before anything else in the guest
    // document can run: in cooperative mode the bootstrap makes the channel itself, keeps port1 in this closure and
    // posts port2 to the host page (parent.parent: the guest's parent is the wrapper). The host takes exactly one
    // announcement per environment, from this frame's window, and ends the environment on a second one (a guest
    // that reloads or rewrites itself runs a bootstrap again). The host never posts its port INTO the guest frame: a
    // capture listener here would take it, but document.open() erases every listener of the window, so guest code that
    // called it before the wrapper's load would receive the host's port in a listener of its own (and could answer the
    // watchdog from a nested worker). So no listener in the guest realm ever carries a port of ours: the guest's end
    // never leaves this closure, and the host's end never enters the guest. Worker mode: the frame (worker-bootstrap.ts) announces the same way and hands port1 to the worker,
    // whose one INIT_PORT listener below takes it (a worker has no document to open, and no guest code runs in it
    // before the port is there).
    const announced = mode === 'cooperative' ? new MessageChannel() : null;
    if (announced) parent.parent.postMessage({ type: 'SANDBOX_PORT' }, '*', [announced.port2]);

    // ---- The captured list (AR:B2, AR:C3, R2:C-1). The port never reaches guest code (AR:B2): every
    // operation on it, and on the events that carry it, goes through a primitive captured here and is called through the
    // captured Reflect.apply, so patching MessagePort.prototype (postMessage, onmessage), MessageEvent.prototype (data,
    // ports, source), Event.prototype or Function.prototype afterwards changes nothing this script does, and never hands
    // a patched function the port as `this` or as an argument. (A guest that held the port could hand it to a nested
    // worker that answers the watchdog's pings while the guest loops.) The internal lists are written with a captured
    // defineProperty, or have no prototype, and are read by index, so inherited setters or iterators on Array.prototype
    // see none of it either (AR:C3). The list only captures: anything that runs later is written below it.
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
    const cancelEvent = Event.prototype.preventDefault;
    const listen = EventTarget.prototype.addEventListener;
    const addGlobalListener = g.addEventListener;
    const PromiseConstructor = Promise;
    const rejected = Promise.reject;
    const then = Promise.prototype.then;
    const promiseCatch = Promise.prototype.catch;
    const StringConstructor = String;
    const TypeErrorConstructor = TypeError;
    const DOMExceptionConstructor = typeof DOMException === 'function' ? DOMException : null;
    // What execute() compiles with (FR:F2): captured now, so guest code that replaces
    // globalThis.Function (or Reflect) later cannot choose what an EXECUTE frame runs, or when.
    const FunctionConstructor = Function;
    const clone = g.structuredClone;
    const toTag = Object.prototype.toString;
    const keysOf = Object.keys;
    const isArray = Array.isArray;
    const ObjectPrototype = Object.prototype;
    const SetConstructor = Set;
    const setHas = Set.prototype.has;
    const setAdd = Set.prototype.add;
    const setClear = Set.prototype.clear;
    const setForEach = Set.prototype.forEach;
    const setSize = getOwn(Set.prototype, 'size')!.get!;
    const mapSet = Map.prototype.set;
    const mapClear = Map.prototype.clear;
    const mapForEach = Map.prototype.forEach;
    const mapSize = getOwn(Map.prototype, 'size')!.get!;
    const hasOwnProperty = Object.prototype.hasOwnProperty;
    // What structured clone makes of an error, told apart by its prototype alone (R3:C-3, below): the realm's own
    // prototypes, and the platform's getters of what an error carries where it is not an own property of the clone
    // (Firefox's `stack`; a DOMException's name and message).
    const ERROR_PROTOTYPES = [Error.prototype, TypeError.prototype, RangeError.prototype, SyntaxError.prototype, ReferenceError.prototype, EvalError.prototype, URIError.prototype];
    const ERROR_NAMES = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError'];
    const inheritedStack = getOwn(Error.prototype, 'stack')?.get ?? null;
    const domExceptionPrototype = DOMExceptionConstructor ? DOMExceptionConstructor.prototype : null;
    const domExceptionName = domExceptionPrototype ? getOwn(domExceptionPrototype, 'name')?.get ?? null : null;
    const domExceptionMessage = domExceptionPrototype ? getOwn(domExceptionPrototype, 'message')?.get ?? null : null;
    const symbolText = Symbol.prototype.toString;
    const stringValueOf = String.prototype.valueOf;
    const slice = String.prototype.slice;
    const startsWith = String.prototype.startsWith;
    const clock = g.performance;
    const clockNow = clock ? clock.now : undefined; // read once (R4:C-1)
    const nowOf = typeof clockNow === 'function' ? clockNow : null;
    const DateConstructor = Date;
    const dateNow = Date.now;
    const queueMicrotaskFn = g.queueMicrotask;
    const setTimer = g.setTimeout; // the budget of uncaught errors says it is past in a task of its own (below)
    const postToFrame = mode === 'worker' && typeof postToFrameFn === 'function' ? postToFrameFn : null;
    // The worker's own close() (worker and strict mode), for a guest past the budget of uncaught errors (below).
    const closeFound = mode === 'cooperative' ? null : g.close;
    const closeWorker = typeof closeFound === 'function' ? closeFound : null;
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
    // The request gate (below; S74): the platform's three request makers, fetch, XMLHttpRequest and WebSocket, taken
    // here once, and the platform's own members the gate works them with. These are the originals: nothing after this
    // list hands one out, and the gate removes every other reference to them from the realm before guest code runs.
    const nativeFetch = g.fetch;
    const RequestConstructor = g.Request;
    let keepaliveOf: (() => unknown) | undefined; // BR:PD2 (below)
    let requestUrlOf: (() => unknown) | undefined;
    for (let proto = typeof RequestConstructor === 'function' ? RequestConstructor.prototype : null; proto && !(keepaliveOf && requestUrlOf); proto = protoOf(proto)) {
        keepaliveOf = keepaliveOf ?? getOwn(proto, 'keepalive')?.get; // own on Request.prototype in every engine measured
        requestUrlOf = requestUrlOf ?? getOwn(proto, 'url')?.get;
    }
    const NativeXMLHttpRequest = g.XMLHttpRequest;
    const xhrPrototype = typeof NativeXMLHttpRequest === 'function' ? NativeXMLHttpRequest.prototype : null;
    const xhrOpen = xhrPrototype ? getOwn(xhrPrototype, 'open')?.value : undefined;
    const xhrSend = xhrPrototype ? getOwn(xhrPrototype, 'send')?.value : undefined;
    const xhrAbort = xhrPrototype ? getOwn(xhrPrototype, 'abort')?.value : undefined;
    const xhrReadyState = xhrPrototype ? getOwn(xhrPrototype, 'readyState')?.get : undefined;
    const xhrWithCredentials = xhrPrototype ? getOwn(xhrPrototype, 'withCredentials')?.get : undefined;
    const NativeWebSocket = g.WebSocket;
    const URLConstructor = g.URL;
    const ObjectPrototypeFound = Object.prototype;
    let urlHref: (() => unknown) | undefined;
    let urlHost: (() => unknown) | undefined;
    let urlProtocol: PropertyDescriptor | undefined;
    let urlUsernameTo: ((value: string) => void) | undefined;
    let urlPasswordTo: ((value: string) => void) | undefined;
    let urlHashTo: ((value: string) => void) | undefined;
    for (let proto = typeof URLConstructor === 'function' ? URLConstructor.prototype : null; proto && proto !== ObjectPrototypeFound; proto = protoOf(proto)) {
        urlHref = urlHref ?? getOwn(proto, 'href')?.get; // own on URL.prototype in every engine
        urlHost = urlHost ?? getOwn(proto, 'host')?.get;
        urlProtocol = urlProtocol ?? getOwn(proto, 'protocol');
        urlUsernameTo = urlUsernameTo ?? getOwn(proto, 'username')?.set;
        urlPasswordTo = urlPasswordTo ?? getOwn(proto, 'password')?.set;
        urlHashTo = urlHashTo ?? getOwn(proto, 'hash')?.set;
    }
    const ProgressEventConstructor = g.ProgressEvent;
    const EventConstructor = g.Event;
    const dispatch = EventTarget.prototype.dispatchEvent;
    const namesOf = Object.getOwnPropertyNames;
    const WeakMapConstructor = WeakMap;
    const weakGet = WeakMap.prototype.get;
    const weakSet = WeakMap.prototype.set;
    const weakDelete = WeakMap.prototype.delete;
    const clearTimer = g.clearTimeout;
    // BR:PD4 (below): the traversal methods' owners.
    const HistoryConstructor = g.History;
    const NavigationConstructor = g.Navigation;
    const historyPrototype = mode === 'cooperative' && typeof HistoryConstructor === 'function' ? HistoryConstructor.prototype : null;
    const navigationPrototype = mode === 'cooperative' && typeof NavigationConstructor === 'function' ? NavigationConstructor.prototype : null;
    // Auto-sizing (BL:B6, below): the document and what is measured, through the prototypes' own getters.
    const doc: Document | null = mode === 'cooperative' ? document : null;
    const ResizeObserverFound = g.ResizeObserver;
    const ResizeObserverConstructor = mode === 'cooperative' && typeof ResizeObserverFound === 'function' ? ResizeObserverFound : null;
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
    // The request gate's base URL, as XMLHttpRequest and WebSocket resolve a relative one: the document's base (cooperative
    // mode), or the worker's location.
    const NodeConstructor = doc ? g.Node : null;
    const baseUriOf = NodeConstructor ? getOwn(NodeConstructor.prototype, 'baseURI')?.get : undefined;
    const locationFound = doc ? null : g.location;
    let locationHrefOf: (() => unknown) | undefined;
    for (let proto = locationFound ?? null; proto && !locationHrefOf; proto = protoOf(proto)) locationHrefOf = getOwn(proto, 'href')?.get;
    const sizeOf = createSizeOfFn ? createSizeOfFn() : null;
    // The one reader of guest values (class G, R5:N-6; readEvent and readOptions below): Reflect.get, and the
    // platform's getters of the events the bootstrap reads, from each interface's prototype chain, by "Interface.field".
    // Guest code that later puts its own getter on ErrorEvent.prototype (or any prototype on the way) changes nothing the
    // bootstrap reads. Null where an engine has no such interface: then the field is read once through Reflect.get.
    const getProperty = Reflect.get;
    const EVENT_READS = [
        'ErrorEvent', 'message', 'ErrorEvent', 'error',
        'PromiseRejectionEvent', 'reason',
        'SecurityPolicyViolationEvent', 'effectiveDirective', 'SecurityPolicyViolationEvent', 'violatedDirective',
        'SecurityPolicyViolationEvent', 'blockedURI', 'SecurityPolicyViolationEvent', 'sourceFile',
        'SecurityPolicyViolationEvent', 'lineNumber', 'SecurityPolicyViolationEvent', 'columnNumber',
    ];
    const eventGetters: Record<string, ((this: unknown) => unknown) | null> = setPrototype({}, null);
    for (let i = 0; i + 1 < EVENT_READS.length; i += 2) {
        const found = g[EVENT_READS[i]!];
        let getter: ((this: unknown) => unknown) | null = null;
        for (let proto = typeof found === 'function' ? found.prototype : null; proto && !getter; proto = protoOf(proto)) getter = getOwn(proto, EVENT_READS[i + 1]!)?.get ?? null;
        defineOwn(eventGetters, EVENT_READS[i] + '.' + EVENT_READS[i + 1], { value: getter, enumerable: true });
    }
    const CAPTURE_POINT = 'nothing below reads a global, or an intrinsic guest code can replace';

    // Lists of our own: an index written to them never reaches an inherited setter, and they are read by index only.
    const list = <T>(): T[] => setPrototype([], null);
    const append = (target: unknown[], value: unknown) => defineOwn(target, target.length, { value, writable: true, enumerable: true, configurable: true });
    const publish = (name: string, value: unknown) => defineOwn(g, name, { value, writable: true, enumerable: true, configurable: true });

    // ---- One reader of guest values (class G; R5:N-6, and the reader R5:N-2's fix shares). An object the guest
    // hands the library (an option object, an event, a thrown value) can answer each read differently, through a getter or
    // a Proxy: sandboxFetch read `init.method` once to test it and again to use it, so it tested one value and sent
    // another. Every guest-supplied option object and event is read here, each listed field once, into a snapshot of our
    // own (no prototype, so no inherited getter), and the code after works on the snapshot only. An event's fields are
    // read through the platform's getters captured above; an option object's through the captured Reflect.get. A field
    // whose read throws is undefined. test/unit/read-once.test.ts scans that no function reads a property of a guest value
    // twice.
    const snapshotOf = (): Record<string, unknown> => setPrototype({}, null);
    const keep = (snapshot: Record<string, unknown>, field: string, value: unknown) => defineOwn(snapshot, field, { value, enumerable: true });
    const readOptions = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
        const snapshot = snapshotOf();
        const readable = value !== null && (typeof value === 'object' || typeof value === 'function');
        for (let i = 0; i < fields.length; i++) {
            let read: unknown;
            try {
                read = readable ? apply(getProperty, undefined, [value, fields[i]!]) : undefined;
            } catch {
                read = undefined;
            }
            keep(snapshot, fields[i]!, read);
        }
        return snapshot;
    };
    const EVENT_KINDS: Record<string, readonly string[]> = setPrototype({
        error: ['ErrorEvent', 'message', 'error'],
        rejection: ['PromiseRejectionEvent', 'reason'],
        violation: ['SecurityPolicyViolationEvent', 'effectiveDirective', 'violatedDirective', 'blockedURI', 'sourceFile', 'lineNumber', 'columnNumber'],
    }, null);
    const readEvent = (event: unknown, kind: 'error' | 'rejection' | 'violation'): Record<string, unknown> => {
        const fields = EVENT_KINDS[kind]!;
        const snapshot = snapshotOf();
        for (let i = 1; i < fields.length; i++) {
            const getter = eventGetters[fields[0] + '.' + fields[i]];
            let read: unknown;
            try {
                read = getter ? apply(getter, event, []) : apply(getProperty, undefined, [event, fields[i]!]);
            } catch {
                read = undefined; // not an event of that interface (a guest's own), or no such field
            }
            keep(snapshot, fields[i]!, read);
        }
        return snapshot;
    };

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

    // Hardening of the guest realm against platform gaps CSP does not cover (BR:PD4, BR:PD6; the request gate below
    // covers BR:PD2), each made here, before guest code, with primitives captured above, and each limited to this realm:
    // a frame or a worker the guest creates is a realm of its own and keeps the platform's behaviour (the residual of
    // backlog S13).
    //
    // BR:PD4, history traversal (cooperative mode). history.back(), forward() and go() traverse the whole tab's session
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
    // BR:PD6, window.name (cooperative mode). A frame's name is a target the host page's links, forms and window.open()
    // look up, so a guest that named itself received the host's navigations and window.open() handles meant for a window
    // of the host's own. Here window.name reads '' and ignores writes. The platform's accessor is an own property of
    // the window and nothing else holds it, so once it is replaced no guest code can reach it: redefining or
    // deleting this one leaves the frame's name as it is (left configurable, as the platform's was). A frame the
    // guest creates can still be named (`<iframe name>`): host pages should not use named targets (README).
    if (mode === 'cooperative') defineOwn(g, 'name', { get: function () { return ''; }, set: nothing, enumerable: true, configurable: true });

    // The one cut of the strings this bootstrap posts (a log line's, a violation report's): a string longer than `most` is
    // cut to it, through the captured slice; anything else is returned as it is, for the receiver to validate.
    const cutAt = (value: unknown, most: number): unknown => (typeof value === 'string' && value.length > most ? apply(slice, value, [0, most]) : value);

    // CSP violation reports (backlog S5, src/lib/violation.ts): the egress table's securitypolicyviolation row, installed
    // with the others below, before any guest code runs: a capture listener on the global object is the first listener on
    // the event's path, so guest code cannot stop it from seeing a violation by registering first. Guest
    // code can still suppress its own reports later (the bootstrap shares its realm, though the port never reaches
    // it), which is why a report is evidence of an attempt and silence proves nothing. Forwarded as a first-class VIOLATION frame, not
    // through the broker, so it can never collide with an exposed method name. Reports raised before
    // INIT_PORT wait in the outbox like bridge frames. Synthetic events (isTrusted false) are not reports.
    // At most VIOLATION_LIMIT per environment (the host caps at the same number, VIOLATION_EVENT_LIMIT,
    // and is the authoritative bound); declared here because this function is stringified. Its fields are read once
    // each, through the platform's getters (readEvent), so a getter the guest put on the prototype answers nothing here.
    // Its strings are cut before they are posted (backlog S61.3; class E-cpu, "cut before posting"), at
    // VIOLATION_MAX_STRING, the length the host keeps (violation.ts, which cuts them again on receipt): a report names a
    // URL the guest chose, and every engine reports an https URL whole, so a fetch of a 100 000-character URL would cross
    // whole to the host page's thread, up to VIOLATION_LIMIT times (test/e2e/violation-strings.spec.ts). The
    // cut is the bootstrap's one helper (cutAt), on the snapshot readEvent made.
    const VIOLATION_LIMIT: LimitValue<'VIOLATION_EVENT_LIMIT'> = 100;
    const VIOLATION_MAX_STRING: LimitValue<'VIOLATION_MAX_STRING'> = 2048; // VIOLATION_MAX_STRING (violation.ts), typed by it
    let violationsSent = 0;
    const relayViolation = (event: Event) => {
        if (!event.isTrusted || violationsSent >= VIOLATION_LIMIT) return;
        violationsSent++;
        const read = readEvent(event, 'violation');
        send({
            type: 'VIOLATION',
            directive: cutAt(read.effectiveDirective || read.violatedDirective, VIOLATION_MAX_STRING),
            blockedURI: cutAt(read.blockedURI, VIOLATION_MAX_STRING),
            sourceFile: cutAt(read.sourceFile, VIOLATION_MAX_STRING),
            lineNumber: read.lineNumber,
            columnNumber: read.columnNumber,
        });
    };

    // ---- The request gate (S74): one chokepoint for every request the guest's
    // realm can make with fetch, XMLHttpRequest and WebSocket, so a request behaves, and is reported, the same on every
    // engine. Each request's URL is resolved as the platform resolves it and admitted only when it is exactly one of the
    // sources of the guest policy's connect-src (`features.connect`, the list the host writes that directive from:
    // csp-generator.ts, connectSources): an origin by its scheme, host and port, or `blob:` for any blob: URL where the
    // build's files put it there. A refused request never reaches the platform. It fails as the platform fails a request
    // its policy refuses (fetch: a rejected TypeError; XMLHttpRequest: a network error, an `error` event, or a NetworkError
    // from a synchronous send(); WebSocket: a SecurityError from the constructor), with one text of the library's, and the
    // gate reports it itself, as a VIOLATION frame of `connect-src` whose sourceFile is the gate's (GATE_SOURCE_FILE,
    // violation.ts), within the same VIOLATION_LIMIT: so an engine that raises no violation in a worker (WebKit) reports
    // it too, and every engine reports one thing. The browser's policy stays underneath (the second layer): a redirect to
    // an origin it refuses is the browser's to refuse and to report, per engine (test/e2e/redirect-refusal.spec.ts, ledger row
    // redirect-refusal-outcome). A gate that errs can only refuse more.
    //
    // fetch and XMLHttpRequest never carry credentials (class A, S74): every fetch is made from a Request built again
    // with `credentials: 'omit'`, and an XMLHttpRequest's `withCredentials` stays false (its setter changes nothing), so
    // no cookie of a listed origin's site rides on either, on any engine. A WebSocket handshake cannot be stripped, and
    // carries what the engine sends (cookie-facts.ts).
    //
    // BR:PD2, keepalive: Firefox sends `fetch(url, { keepalive: true })` without checking connect-src, so the gate also
    // refuses a keepalive request. It reads `keepalive` and `url` from the Request it built with the captured constructor,
    // exactly as fetch() itself would, so a getter on the init, or a Request made with keepalive, cannot answer twice.
    //
    // The originals cannot be reached from guest code, by construction: each was taken once in the captured list and is
    // only ever called by the gate (test/unit/request-gate.test.ts scans this text for that). Every copy of a gated name on
    // the global object and on its prototype chain is removed (a worker's fetch lives on WorkerGlobalScope.prototype in
    // every engine, BD1:ISO-2), the gated function is put on the global object, writable (guest code can still wrap it)
    // and not configurable (the gate stays underneath any wrapper); XMLHttpRequest's request-making members are replaced on
    // its prototype, and each constructor's prototype names the gated constructor as its `constructor`. A frame the guest
    // creates is cross-origin to this realm (no allow-same-origin), so the guest cannot take an original from it; that
    // frame, and a worker the guest creates in cooperative mode, are realms of their own with the platform's request
    // makers, under the same policy (the residual of backlog S13). If any member the gate needs is missing, the request
    // maker is removed instead: the gate fails closed.
    const GATE_SOURCE: typeof GATE_SOURCE_FILE = 'web-sandbox:request-gate'; // GATE_SOURCE_FILE (violation.ts), typed by it
    const connectList = features?.connect;
    const admittedSources: string[] = list();
    for (let i = 0; connectList && i < connectList.length; i++) {
        if (typeof connectList[i] === 'string') append(admittedSources, connectList[i]);
    }
    const urlReady = typeof URLConstructor === 'function' && urlHref && urlHost && urlProtocol?.get && urlProtocol.set && urlUsernameTo && urlPasswordTo && urlHashTo;
    const protocolOf = urlProtocol?.get;
    const protocolTo = urlProtocol?.set;
    const parseUrl = (text: string, base?: unknown): URL => construct(URLConstructor, base === undefined ? [text] : [text, base]);
    // Whether the policy's connect-src lists the URL `href`: its exact origin, or `blob:` for a blob: URL.
    const admits = (href: string): boolean => {
        let url: URL;
        try {
            url = parseUrl(href);
        } catch {
            return false;
        }
        const protocol = apply(protocolOf!, url, []) as string;
        const key = protocol === 'blob:' ? protocol : protocol + '//' + (apply(urlHost!, url, []) as string);
        for (let i = 0; i < admittedSources.length; i++) {
            if (admittedSources[i] === key) return true;
        }
        return false;
    };
    // The URL a refusal names, as the engines report it: an http(s) or ws(s) URL without credentials or fragment, and
    // any other by its scheme alone.
    const reportedUrl = (href: string): string => {
        let url: URL;
        try {
            url = parseUrl(href);
        } catch {
            return href;
        }
        const protocol = apply(protocolOf!, url, []) as string;
        if (protocol !== 'https:' && protocol !== 'http:' && protocol !== 'wss:' && protocol !== 'ws:') return apply(slice, protocol, [0, -1]) as string;
        apply(urlUsernameTo!, url, ['']);
        apply(urlPasswordTo!, url, ['']);
        apply(urlHashTo!, url, ['']);
        return apply(urlHref!, url, []) as string;
    };
    const refuse = (href: string) => {
        if (violationsSent >= VIOLATION_LIMIT) return;
        violationsSent++;
        send({ type: 'VIOLATION', directive: 'connect-src', blockedURI: cutAt(reportedUrl(href), VIOLATION_MAX_STRING), sourceFile: GATE_SOURCE });
    };
    // A URL XMLHttpRequest or WebSocket was given, resolved against the base they use; throws a SyntaxError for one that
    // does not parse.
    const resolved = (value: unknown): URL => {
        if (typeof value === 'symbol') throw construct(TypeErrorConstructor, ['a URL cannot be a Symbol']);
        const text = StringConstructor(value);
        const base = baseUriOf && doc ? apply(baseUriOf, doc, []) : locationHrefOf && locationFound ? apply(locationHrefOf, locationFound, []) : undefined;
        try {
            return parseUrl(text, base);
        } catch {
            throw construct(DOMExceptionConstructor!, ['the URL does not parse', 'SyntaxError']);
        }
    };
    const refusal = 'refused by the sandbox: the origin is not in its origins.connect';
    // Every copy of `name` on the global object and its prototype chain removed, then `value` put on the global object
    // (nothing for undefined). Throws where a copy that holds `original` stays: the bootstrap ends before any guest code.
    // The global object's own copy is replaced in place where it cannot be deleted (a writable one, which the gate itself
    // leaves).
    const replaceGlobal = (name: string, original: unknown, value: unknown, enumerable: boolean) => {
        for (let owner: object | null = g; owner; owner = protoOf(owner)) {
            if (!getOwn(owner, name)) continue;
            deleteOwn(owner, name);
            const left = getOwn(owner, name);
            if (left && left.value === original && original !== undefined && (owner !== g || value === undefined)) throw construct(TypeErrorConstructor, ['[Sandbox] the request gate could not remove ' + name]);
        }
        if (value !== undefined && !defineOwn(g, name, { value, writable: true, enumerable, configurable: false })) throw construct(TypeErrorConstructor, ['[Sandbox] the request gate could not install ' + name]);
    };
    // A gated constructor in place of `original`: its statics, its prototype (the platform's, whose `constructor` now
    // names the gated one), and its own prototype's chain.
    const adopt = (gated: object, original: { prototype: object }) => {
        const names = namesOf(original);
        for (let i = 0; i < names.length; i++) {
            const name = names[i]!;
            if (name !== 'prototype' && name !== 'length' && name !== 'name') defineOwn(gated, name, getOwn(original, name)!);
        }
        setPrototype(gated, protoOf(original));
        const prototype = original.prototype;
        if (!defineOwn(gated, 'prototype', { value: prototype, writable: false, enumerable: false, configurable: false })) throw construct(TypeErrorConstructor, ['[Sandbox] the request gate could not adopt a prototype']);
        if (!defineOwn(prototype, 'constructor', { value: gated, writable: true, enumerable: false, configurable: false })) throw construct(TypeErrorConstructor, ['[Sandbox] the request gate could not adopt a prototype']);
    };
    const NEW_REQUIRED = "Failed to construct: please use the 'new' operator";

    // fetch: the Request built as fetch() builds it, then again without credentials; checked; handed to the platform.
    if (typeof nativeFetch === 'function' && typeof RequestConstructor === 'function' && keepaliveOf && requestUrlOf && urlReady) {
        const keepalive = keepaliveOf;
        const urlOf = requestUrlOf;
        const omit = setPrototype({ credentials: 'omit' }, null); // no prototype: the init is read member by member
        // keepalive is read from the Request fetch() itself would make: Firefox does not carry it into a Request built
        // from another, so the one sent is checked before it is built.
        const gatedFetch = function fetch(input: unknown, init?: unknown) {
            let request;
            try {
                request = construct(RequestConstructor, init === undefined ? [input] : [input, init]);
            } catch (error) {
                return apply(rejected, PromiseConstructor, [error]);
            }
            const href = apply(urlOf, request, []) as string;
            if (!admits(href)) {
                refuse(href);
                return apply(rejected, PromiseConstructor, [construct(TypeErrorConstructor, ['fetch() ' + refusal])]);
            }
            if (apply(keepalive, request, []) === true) {
                return apply(rejected, PromiseConstructor, [construct(TypeErrorConstructor, ['fetch() with keepalive is not available in the sandbox'])]);
            }
            let sent;
            try {
                sent = construct(RequestConstructor, [request, omit]);
            } catch (error) {
                return apply(rejected, PromiseConstructor, [error]);
            }
            return apply(nativeFetch, g, [sent]);
        };
        replaceGlobal('fetch', nativeFetch, gatedFetch, true);
    } else {
        replaceGlobal('fetch', nativeFetch, undefined, true);
    }

    // XMLHttpRequest: open() checks the URL and hands the platform the resolved URL, or, for a refused one, a placeholder
    // it never sends; send() of a refused request fails as a network error does (asynchronously: loadstart, then
    // readystatechange, error and loadend, with readyState 4 and status 0; a synchronous one throws a NetworkError), and
    // abort() and readyState follow the same states. A record per refused request, by index: [state, URL, async, timer].
    const xhrReady = typeof NativeXMLHttpRequest === 'function' && xhrPrototype && typeof xhrOpen === 'function' && typeof xhrSend === 'function'
        && typeof xhrAbort === 'function' && xhrReadyState && xhrWithCredentials && typeof ProgressEventConstructor === 'function'
        && typeof EventConstructor === 'function' && DOMExceptionConstructor && urlReady;
    if (xhrReady) {
        const readyStateOfRequest = xhrReadyState!;
        const refusedRequests = construct(WeakMapConstructor, []) as WeakMap<object, unknown[]>;
        const recordOf = (xhr: unknown): unknown[] | undefined => apply(weakGet, refusedRequests, [xhr]) as unknown[] | undefined;
        const progressInit = setPrototype({ lengthComputable: false, loaded: 0, total: 0 }, null);
        const fire = (xhr: unknown, type: string) => apply(dispatch, xhr, [type === 'readystatechange' ? construct(EventConstructor, [type]) : construct(ProgressEventConstructor, [type, progressInit])]);
        const settle = (xhr: unknown, record: unknown[], type: string) => {
            record[0] = 'done';
            fire(xhr, 'readystatechange');
            fire(xhr, type);
            fire(xhr, 'loadend');
        };
        const open = function open(this: unknown, method: unknown, url: unknown) {
            apply(readyStateOfRequest, this, []); // the platform's own check that `this` is a request
            const count = arguments.length;
            const earlier = recordOf(this);
            if (earlier) {
                apply(clearTimer, g, [earlier[3]]);
                apply(weakDelete, refusedRequests, [this]);
            }
            const href = count >= 2 ? (apply(urlHref!, resolved(url), []) as string) : '';
            const refused = count >= 2 && !admits(href);
            const args: unknown[] = list();
            append(args, method);
            if (count >= 2) append(args, refused ? 'about:blank' : href);
            for (let i = 2; i < count; i++) append(args, arguments[i]);
            apply(xhrOpen, this, args);
            if (!refused) return;
            const record: unknown[] = list();
            append(record, 'opened');
            append(record, href);
            append(record, count < 3 || !!arguments[2]);
            append(record, undefined);
            apply(weakSet, refusedRequests, [this, record]);
        };
        const sendRequest = function send(this: unknown, body?: unknown) {
            const record = recordOf(this);
            if (!record) return apply(xhrSend, this, arguments.length === 0 ? [] : [body]);
            if (record[0] !== 'opened') throw construct(DOMExceptionConstructor!, ['send() needs an opened request', 'InvalidStateError']);
            refuse(record[1] as string);
            if (record[2] !== true) {
                record[0] = 'done';
                throw construct(DOMExceptionConstructor!, ['XMLHttpRequest ' + refusal, 'NetworkError']);
            }
            record[0] = 'sending';
            fire(this, 'loadstart');
            const xhr = this;
            record[3] = apply(setTimer, g, [() => {
                if (recordOf(xhr) === record && record[0] === 'sending') settle(xhr, record, 'error');
            }, 0]);
        };
        const abort = function abort(this: unknown) {
            const record = recordOf(this);
            apply(xhrAbort, this, []);
            if (!record) return;
            const state = record[0];
            if (state === 'sending') {
                apply(clearTimer, g, [record[3]]);
                settle(this, record, 'abort');
            }
            if (state === 'sending' || state === 'done') record[0] = 'unsent';
        };
        const readyState = function (this: unknown) {
            const value = apply(readyStateOfRequest, this, []);
            const record = recordOf(this);
            const state = record ? record[0] : null;
            return state === 'done' ? 4 : state === 'unsent' ? 0 : value;
        };
        const withCredentialsOf = xhrWithCredentials!;
        const withCredentials = function (this: unknown) {
            return apply(withCredentialsOf, this, []); // false: the platform's setter is never called
        };
        const unchanged = function (this: unknown) {
            apply(withCredentialsOf, this, []); // the platform's check that `this` is a request; the value stays false
        };
        const gatedXMLHttpRequest = function XMLHttpRequest(this: unknown) {
            if (new.target === undefined) throw construct(TypeErrorConstructor, [NEW_REQUIRED]);
            return construct(NativeXMLHttpRequest, [], new.target);
        };
        // Configurable, as the platform's: what replaces or deletes them reaches no original either.
        const MEMBERS: [string, PropertyDescriptor][] = [
            ['open', { value: open, writable: true, enumerable: true, configurable: true }],
            ['send', { value: sendRequest, writable: true, enumerable: true, configurable: true }],
            ['abort', { value: abort, writable: true, enumerable: true, configurable: true }],
            ['readyState', { get: readyState, enumerable: true, configurable: true }],
            ['withCredentials', { get: withCredentials, set: unchanged, enumerable: true, configurable: true }],
        ];
        for (let i = 0; i < MEMBERS.length; i++) {
            if (!defineOwn(xhrPrototype, MEMBERS[i]![0], MEMBERS[i]![1])) throw construct(TypeErrorConstructor, ['[Sandbox] the request gate could not install XMLHttpRequest.' + MEMBERS[i]![0]]);
        }
        adopt(gatedXMLHttpRequest, NativeXMLHttpRequest);
        replaceGlobal('XMLHttpRequest', NativeXMLHttpRequest, gatedXMLHttpRequest, false);
    } else {
        replaceGlobal('XMLHttpRequest', NativeXMLHttpRequest, undefined, false);
    }

    // WebSocket: the URL resolved, an http(s) one taken as its ws(s) form, as the constructor does; checked; the
    // platform's constructor given the resolved URL.
    if (typeof NativeWebSocket === 'function' && DOMExceptionConstructor && urlReady) {
        const gatedWebSocket = function WebSocket(this: unknown, url: unknown, protocols?: unknown) {
            if (new.target === undefined) throw construct(TypeErrorConstructor, [NEW_REQUIRED]);
            const count = arguments.length;
            if (count === 0) return construct(NativeWebSocket, [], new.target);
            const target = resolved(url);
            const protocol = apply(protocolOf!, target, []);
            if (protocol === 'https:') apply(protocolTo!, target, ['wss:']);
            else if (protocol === 'http:') apply(protocolTo!, target, ['ws:']);
            else if (protocol !== 'wss:' && protocol !== 'ws:') throw construct(DOMExceptionConstructor!, ['a WebSocket URL is ws:, wss:, http: or https:', 'SyntaxError']);
            const href = apply(urlHref!, target, []) as string;
            if (!admits(href)) {
                refuse(href);
                throw construct(DOMExceptionConstructor!, ['WebSocket ' + refusal, 'SecurityError']);
            }
            return construct(NativeWebSocket, count < 2 ? [href] : [href, protocols], new.target);
        };
        adopt(gatedWebSocket, NativeWebSocket);
        replaceGlobal('WebSocket', NativeWebSocket, gatedWebSocket, false);
    } else {
        replaceGlobal('WebSocket', NativeWebSocket, undefined, false);
    }

    // Content auto-sizing (BL:B6, src/lib/auto-resize.ts), opt-in and cooperative mode only: a worker has no
    // document. A ResizeObserver on the root element reports the content height as a RESIZE frame, outside
    // the broker like VIOLATION. Its callbacks run at most once per rendering update, after layout, so the
    // guest measures once per frame and sends only a changed height. The measure is the root element's
    // box, which follows content in normal flow both ways (it shrinks too, unlike the root's scrollHeight,
    // which never reads less than the viewport); when content overflows the viewport, scrollHeight, so
    // overflow the root's box does not contain still grows the frame. The body is observed as well once it
    // exists, for guests whose root is pinned to the viewport (html { height: 100% }). The host validates,
    // clamps and rate-limits every report: the fields are claims of the guest's realm, since guest code can bend what the
    // bootstrap reads (it cannot post on the port itself).
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

    // ---- Sliding one-second windows: the guest's per-second budgets (the console relay's, below, and the calls'), each
    // the host's own rule (rate-limit.ts) with the host's constant: at most `limit` in any one-second window. Each
    // admitted weight is kept with its time until it leaves the window (R2:M-1: a token bucket would let a full bucket
    // and its refill through in one window, twice what the host takes, so the host would drop lines the guest had
    // relayed, among them the relay's own warning that it had started dropping). Inline arithmetic and lists of our own
    // only (R2:C-1: Math.min is the guest's to replace). `mode` 'spent' records a weight already
    // spent (the lines flushed on attach, below) whatever the window holds; 'fits' only says whether it would be admitted.
    // A weight that is not a finite number ≥ 0 is refused in every mode, recording nothing: rate-limit.ts's isWeight, the
    // same expression (backlog S61, class C; a unit test compares the texts, and a differential property runs both).
    const now = (): number => (nowOf ? apply(nowOf, clock, []) : apply(dateNow, DateConstructor, []));
    const slidingWindow = (limit: number) => {
        const times: number[] = list();
        const weights: number[] = list();
        let head = 0; // entries before head have left the window
        let total = 0;
        return (weight: number, mode?: 'spent' | 'fits'): boolean => {
            if (!(typeof weight === 'number' && weight >= 0 && weight - weight === 0)) return false;
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
            const fits = total + weight <= limit;
            if (mode === 'fits' || (mode !== 'spent' && !fits)) return fits;
            if (weight > 0) {
                times[times.length] = at;
                weights[weights.length] = weight;
                total += weight;
            }
            return true;
        };
    };

    // The per-second budget of the calls the guest makes (R3:M-2): at most callBudget.calls calls and
    // callBudget.bytes bytes of their frames in any one-second window, counted here, in the broker that holds the only
    // way onto the port, so a call past it never crosses: the broker refuses it BUSY. The host counts the same window on
    // receipt (host.ts) and answers BUSY past it. Without it, calls of 32 MiB back to back keep the host's thread busy
    // within every other cap, and small calls reach tens of thousands per second. A call counts against both windows or
    // neither. A call heavier than the whole byte budget can never fit an empty window (R5:L-2; the config schema's
    // invariant, config-schema.ts): it is refused for good, ARGS_NOT_TRANSFERABLE, which is not retryable, as the element
    // refuses one that arrives anyway. BUSY would be wrong: with a budget smaller than one call (about 136 bytes), every
    // call, sandboxFetch() and guest writes included, would be BUSY forever.
    const callBudget = features?.callBudget;
    const budgetCalls = callBudget ? callBudget.calls : 0;
    const budgetBytes = callBudget ? callBudget.bytes : 0;
    const callsWindow = callBudget ? slidingWindow(budgetCalls) : null;
    const callBytesWindow = callBudget ? slidingWindow(budgetBytes) : null;
    const admitOutbound = callsWindow && callBytesWindow ? (bytes: number): { code: 'BUSY' | 'ARGS_NOT_TRANSFERABLE'; reason: string } | null => {
        if (bytes > budgetBytes) return { code: 'ARGS_NOT_TRANSFERABLE', reason: 'the call is heavier than callLimits.maxBytesPerSecond (' + budgetBytes + ' bytes), so it can never be carried' };
        if (!callsWindow(1, 'fits') || !callBytesWindow(bytes, 'fits')) return { code: 'BUSY', reason: 'more than ' + budgetCalls + ' calls or ' + budgetBytes + ' bytes of calls in one second' };
        callsWindow(1, 'spent');
        callBytesWindow(bytes, 'spent');
        return null;
    } : undefined;

    // The guest's broker accepts a library code (FETCH_*) in the refusal of a call to a reserved method, so
    // sandboxFetch() rejects with the host's code; the host's broker never accepts one (see rpc.ts). The startup gate
    // (below) refuses through it a call it cannot hold: its builder makes every RPC frame (rpc.ts, R3:C-1).
    let refuseHeld: ((request: unknown, reason: string) => void) | null = null;
    const bridge = createBrokerFn ? createBrokerFn(send, {
        acceptLibraryCodes: true,
        sizeOf: sizeOf ?? undefined,
        admitOutbound,
        takeBusyRefusal: (refuse) => { refuseHeld = refuse; },
    }) : null;
    const handleBridgeMessage = bridge ? bridge.handleMessage : null;
    const bridgeCall = bridge ? bridge.callWithTimeout : null; // read once: sandboxFetch and guest writes call it (below)
    if (bridge) publish('bridge', bridge);

    // The host-mediated fetch bridge (BL:B5, src/lib/fetch-bridge.ts, ADR-006), opt-in, both modes. A
    // separate global, never a replacement for fetch: guest code that wants it as fetch assigns it itself.
    // It sends only url, method, headers and body (string, ArrayBuffer or typed array) to the reserved
    // sandbox:fetch method; the host decides everything else and refuses with a FETCH_* code. The broker's
    // own timeout is a backstop a little past the host's, so the host's FETCH_TIMEOUT normally arrives first.
    // Whole responses only: the answer becomes a Response here, with its body in memory.
    // Defined in every environment (R1:R4-8): without the bridge the host refuses every request with FETCH_NOT_ALLOWED
    // ("the fetch bridge is off"), as docs/API.md says, rather than a call throwing a ReferenceError. One path either way:
    // the host decides.
    if (bridge) {
        const callWithTimeout = bridgeCall!;
        const fetchBridgeFeature = features?.fetchBridge;
        const callTimeoutMs = (fetchBridgeFeature ? fetchBridgeFeature.timeoutMs : 10000) + 5000;
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
        // init's three fields, each read once (readOptions; R5:N-6: `method` read to test it and again to send it would
        // let a getter answer 'GET' to the test and anything at all to the send).
        const FETCH_INIT = ['method', 'headers', 'body'];
        publish('sandboxFetch', (input: unknown, init?: unknown) => {
            let request;
            try {
                const options = readOptions(init, FETCH_INIT);
                const method = options.method;
                const headers: [string, string][] = list();
                if (HeadersConstructor && headersForEach) {
                    apply(headersForEach, construct(HeadersConstructor, [options.headers]), [(value: string, name: string) => append(headers, [name, value])]);
                }
                request = { url: StringConstructor(input), method: method === undefined ? 'GET' : StringConstructor(method), headers, body: toBody(options.body) };
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

    // Guest writes (BL:C5, src/lib/guest-writes.ts), opt-in, every mode: the one way to send a write or a
    // removal to the host, the reserved sandbox:write method. Like sandboxFetch, it calls the broker's
    // callWithTimeout captured here, before any guest code runs, so replacing bridge.callWithTimeout (or the port's
    // prototypes, see above) later changes nothing on this path. It is not a global: the bootstrap hands it to
    // inSandboxFiles, which builds sandboxFiles.write() and remove() on it (null when off: they refuse locally).
    // The host answers at once (it decides synchronously), so the broker's default 30 s timeout is only a backstop.
    let writeFiles: ((request: unknown) => Promise<unknown>) | null = null;
    if (bridge && features?.guestWrites === true) {
        const callWithTimeout = bridgeCall!;
        writeFiles = (request: unknown) => callWithTimeout(30000, 'sandbox:write', request);
    }

    // ---- The console relay (R1:R4-1, R1:R3-3, R1:R4-2, R1:R4-6, R1:R4-7): the one chokepoint every guest log line
    // goes through, in every mode (cooperative, worker, and strict, whose prelude logs through `log` below). It never
    // throws, whatever the guest logs, and what it posts is bounded before it is posted:
    //   - at most LOG_MAX_ARGS arguments, strings cut at LOG_MAX_STRING (the host cuts again on receipt);
    //   - an Error or DOMException becomes { name, message, stack }, strings cut the same way, wherever it is in an
    //     argument (R3:C-3: nested, it would measure as past the byte budget, which it is not);
    //   - a value structured clone refuses (a function, a Symbol, a DOM node, an Event, a Response, a Proxy, a WeakMap,
    //     a Promise) becomes a string that names its kind, instead of a DataCloneError thrown at the guest's console
    //     call and the line lost;
    //   - all arguments of one line together measure at most LOG_MAX_BYTES (structured-size.ts, with primitives
    //     captured now): an argument past what is left of it becomes a string saying so, so
    //     `console.log(new Uint8Array(64 MiB))` crosses as a few bytes, and an argument holding a kind the measure does
    //     not know (an ImageData, a SharedArrayBuffer) crosses as a string that names it, never as past the budget;
    //   - at most LOG_LINES_PER_SECOND lines and LOG_BYTES_PER_SECOND bytes leave in any one-second window (the host's
    //     own rule and constant, the sliding windows above): the host dispatches no more than that anyway, and a line
    //     dropped here is never cloned onto the host's thread, which is what a flood within the per-line caps costs. The
    //     first dropped line sends one warning, once per environment.
    // Each argument is cloned once here, with the captured structuredClone (R2:C-3), and the clone, the
    // snapshot, is what is measured and what the line carries: a getter cannot answer the measure one way and the post
    // another, and a line buffered before the port is attached holds its values as they were when logged, as postMessage
    // would, and is known to post. Mirrors of LOG_MAX_ARGS, LOG_MAX_STRING, LOG_EVENTS_PER_SECOND, LOG_MAX_BYTES and
    // LOG_BYTES_PER_SECOND (sandbox-log.ts): declared here to survive stringification, typed by the limits registry.
    const LOG_MAX_ARGS: LimitValue<'LOG_MAX_ARGS'> = 64;
    const LOG_MAX_STRING: LimitValue<'LOG_MAX_STRING'> = 65536;
    const LOG_MAX_BYTES: LimitValue<'LOG_MAX_BYTES'> = 1048576;
    const LOG_LINES_PER_SECOND: LimitValue<'LOG_EVENTS_PER_SECOND'> = 1000;
    const LOG_BYTES_PER_SECOND: LimitValue<'LOG_BYTES_PER_SECOND'> = 4194304;
    // At most LOG_BUFFER_LIMIT lines (and LOG_BYTES_PER_SECOND bytes) wait for the port (a strict entry's top level runs
    // before the view hands the worker its ports: VR:V2): one window's worth, so they fit
    // the host's window when they are flushed (R2:M-2). Past either they are counted, and one warning on attach says how
    // many were dropped, and for which cap.
    const LOG_BUFFER_LIMIT = LOG_LINES_PER_SECOND;
    const cut = (text: string) => cutAt(text, LOG_MAX_STRING) as string;
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
    // The name of a value's kind, for a line's own words: `Uint8Array` of `[object Uint8Array]` (R3:M-7: the brackets
    // are not doubled), its type for a primitive.
    // At most KIND_MAX_LENGTH characters (a mirror of structured-size.ts's): a tag is the guest's to choose
    // (Symbol.toStringTag), and this text is posted unmeasured.
    const KIND_MAX_LENGTH: LimitValue<'KIND_MAX_LENGTH'> = 64;
    const kindOf = (value: unknown): string => {
        if (typeof value !== 'object' || value === null) return typeof value;
        const tag = tagOf(value);
        const name = apply(slice, tag, [8, tag.length - 1 < 8 + KIND_MAX_LENGTH ? tag.length - 1 : 8 + KIND_MAX_LENGTH]) as string;
        return name || 'object';
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
    // A thrown or rejected value as it is reported: its text, an error's "name: message", anything else by kind (a
    // primitive as itself); and how many characters the browser reads of it to make its own report, which the budget of
    // uncaught errors counts (egress.ts, UNCAUGHT_CHARACTERS_PER_SECOND): a string's, or the name and message of any
    // object or function. Firefox reports every rejection of a worker to the host page's thread, and the cost follows the
    // characters of an error's message and name (a stack, a toString or a getter cost nothing, since the browser reads
    // data properties only). Which objects the browser takes for errors is its own internal class, never what the object
    // says of itself (Symbol.toStringTag is the guest's to set, S78): so every object's name and message are counted, more
    // than the browser reads, never less (research 18: a model of the browser may only err toward refusing). Each is read
    // once here, and a getter's answer is counted too; a String object counts as its string.
    const lengthOf = (value: unknown): number => {
        if (typeof value === 'string') return value.length;
        if (typeof value !== 'object' || value === null) return 0;
        try {
            const text = apply(stringValueOf, value, []);
            return typeof text === 'string' ? text.length : 0;
        } catch {
            return 0;
        }
    };
    const reportOf = (value: unknown): { text: string; characters: number } => {
        if (typeof value === 'string') return { text: cut(value), characters: value.length };
        if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
            return { text: typeof value === 'symbol' ? describe(value) : '' + (value as string), characters: 0 };
        }
        let name: unknown;
        let message: unknown;
        try {
            name = (value as { name?: unknown }).name;
            message = (value as { message?: unknown }).message;
        } catch {
            // a getter that throws: what was read so far
        }
        const characters = lengthOf(name) + lengthOf(message);
        if (!isErrorLike(value)) return { text: describe(value), characters };
        const nameText = textOf(name);
        const messageText = textOf(message);
        return { text: nameText ? (messageText ? nameText + ': ' + messageText : nameText) : messageText, characters };
    };
    const errorText = (value: unknown): string => reportOf(value).text;
    // "Uncaught …" once: Chromium's ErrorEvent message already starts with it, Firefox's and WebKit's do not.
    const uncaught = (text: string) => (apply(startsWith, text, ['Uncaught ']) ? text : 'Uncaught ' + text);
    // One argument's snapshot (R3:C-3): its clone, or, for a value clone refuses deeper in (a function in an object, a
    // Proxy), its kind.
    const snapshot = (value: unknown): unknown => {
        try {
            return clone(value);
        } catch {
            return describe(value);
        }
    };

    // Errors anywhere in a snapshot become { name, message, stack } (R3:C-3), in place, before the line is measured.
    // Structured clone keeps an Error, and the byte measure counts one as past every budget (structured-size.ts: its
    // stack is the engine's to serialize), so `console.log({ error })`, `[new TypeError()]` and Promise.allSettled's
    // results would cross as "past the log line's byte budget", which is false. The walk visits plain objects, arrays, Maps
    // and Sets, each object once, at most ERROR_WALK_NODES of them and ERROR_WALK_DEPTH deep. An error past those bounds
    // stays, and the measure names it ("unsupported value: Error"): bounded, and true.
    // It runs no guest code with a snapshot object at hand: the snapshot is posted after it (a line logged before the
    // port is attached waits in the outbox), so guest code that held one could grow it past the budgets measured here.
    // So an object's kind is read from its prototype (Object.getPrototypeOf has no hook on an ordinary object), never
    // from Object.prototype.toString, which reads Symbol.toStringTag through the prototype chain, guest code's; a Map or
    // a Set is told by the platform's own getters, captured; and an error's fields are its own properties (an own
    // accessor of a clone is the engine's), or the platform's getters captured above.
    const ERROR_WALK_NODES: LimitValue<'ERROR_WALK_NODES'> = 10000;
    const ERROR_WALK_DEPTH: LimitValue<'ERROR_WALK_DEPTH'> = 64;
    const brandOf = (read: (this: unknown) => unknown, value: unknown): unknown => {
        try {
            return apply(read, value, []);
        } catch {
            return undefined;
        }
    };
    // An own property's value, through its own getter if it has one (on a clone, the engine's), else undefined.
    const ownValue = (object: object, key: string): unknown => {
        const descriptor = getOwn(object, key);
        if (!descriptor) return undefined;
        if (apply(hasOwnProperty, descriptor, ['value'])) return descriptor.value;
        const read = apply(hasOwnProperty, descriptor, ['get']) ? descriptor.get : undefined;
        return typeof read === 'function' ? brandOf(read, object) : undefined;
    };
    // The form of an error in a snapshot, or null for anything else.
    const snapshotErrorForm = (object: object): { name: string; message: string; stack: string } | null => {
        const proto = protoOf(object);
        let name: string | null = null;
        for (let i = 0; i < ERROR_PROTOTYPES.length && name === null; i++) if (ERROR_PROTOTYPES[i] === proto) name = ERROR_NAMES[i]!;
        if (name !== null) {
            const stack = ownValue(object, 'stack') ?? (inheritedStack ? brandOf(inheritedStack, object) : undefined);
            return { name, message: textOf(ownValue(object, 'message')), stack: textOf(stack) };
        }
        if (proto === null || proto !== domExceptionPrototype) return null;
        return {
            name: textOf(domExceptionName ? brandOf(domExceptionName, object) : undefined),
            message: textOf(domExceptionMessage ? brandOf(domExceptionMessage, object) : undefined),
            stack: textOf(ownValue(object, 'stack')),
        };
    };
    const withErrorForms = (root: unknown): unknown => {
        if (!root || typeof root !== 'object') return root;
        const rootForm = snapshotErrorForm(root);
        if (rootForm) return rootForm;
        const objects: object[] = list();
        const depths: number[] = list();
        const seen = construct(SetConstructor, []);
        objects[0] = root;
        depths[0] = 0;
        let visited = 0;
        while (objects.length > 0 && visited < ERROR_WALK_NODES) {
            const object = objects[objects.length - 1]!;
            const depth = depths[depths.length - 1]!;
            objects.length = objects.length - 1;
            depths.length = depths.length - 1;
            if (apply(setHas, seen, [object])) continue;
            apply(setAdd, seen, [object]);
            visited++;
            // A member as it stays: an error's form, or the member, walked later if it is an object and not too deep.
            const formOf = (member: unknown): unknown => {
                if (!member || typeof member !== 'object') return member;
                const form = snapshotErrorForm(member);
                if (form) return form;
                if (depth + 1 < ERROR_WALK_DEPTH) {
                    objects[objects.length] = member;
                    depths[depths.length] = depth + 1;
                }
                return member;
            };
            if (isArray(object) || protoOf(object) === ObjectPrototype) {
                const keys = keysOf(object);
                for (let i = 0; i < keys.length; i++) {
                    const member = (object as Record<string, unknown>)[keys[i]!];
                    const form = formOf(member);
                    if (form !== member) defineOwn(object, keys[i]!, { value: form, writable: true, enumerable: true, configurable: true });
                }
                continue;
            }
            // A Map or a Set: its entries again, in their order, when one of them changed.
            const isMap = typeof brandOf(mapSize, object) === 'number';
            if (!isMap && typeof brandOf(setSize, object) !== 'number') continue;
            const keys: unknown[] = list();
            const values: unknown[] = list();
            let changed = false;
            apply(isMap ? mapForEach : setForEach, object, [(value: unknown, key: unknown) => {
                const keyForm = formOf(key);
                const valueForm = isMap ? formOf(value) : keyForm;
                if (keyForm !== key || valueForm !== value) changed = true;
                keys[keys.length] = keyForm;
                values[values.length] = valueForm;
            }]);
            if (!changed) continue;
            apply(isMap ? mapClear : setClear, object, []);
            for (let i = 0; i < keys.length; i++) {
                if (isMap) apply(mapSet, object, [keys[i], values[i]]);
                else apply(setAdd, object, [keys[i]]);
            }
        }
        return root;
    };

    // The line to post, its bytes, and whether it is smaller than what was logged (an argument, a string or a byte
    // budget cut). Its arguments are snapshots, strings, and primitives.
    // The placeholders are part of the budget by construction (backlog S61.3; class P, the two ends of one budget measuring
    // different things). An argument past what is left becomes a placeholder that says so, and the placeholder takes its
    // own bytes from what is left; a placeholder that did not fit (50 bytes left, a placeholder of 118) would make the
    // line cross past LOG_MAX_BYTES as the host measures it (sandbox-log.ts, toLogDetail): the host would drop the
    // placeholder and warn that the guest's line was too large, which the relay never sends. So room
    // for one tail is kept back from the start (TAIL_BYTES, the longest tail), and an argument and its placeholder are
    // measured against what is left besides it; when even the placeholder does not fit, the tail ends the line, saying how
    // many arguments it drops. So every prefix of the line fits LOG_MAX_BYTES as the host measures it, argument by argument
    // (test/unit/structural.test.ts, the relay against the host's reading, with fast-check).
    const tailOf = (dropped: number) => '[Sandbox] ' + dropped + ' more argument(s) past the log line\'s byte budget (' + LOG_MAX_BYTES + ')';
    const TAIL_BYTES = tailOf(LOG_MAX_ARGS).length * 2 + 8; // at most LOG_MAX_ARGS dropped: no tail has more digits
    const safeArgs = (args: unknown[]): { line: unknown[]; bytes: number; cut: boolean } => {
        let reduced = args.length > LOG_MAX_ARGS;
        const count = reduced ? LOG_MAX_ARGS : args.length;
        const out: unknown[] = list();
        let left = LOG_MAX_BYTES - TAIL_BYTES; // what an argument or a placeholder may take; the tail's room is kept apart
        let tail = 0; // the bytes of the tail, when the line ends with one
        for (let i = 0; i < count; i++) {
            let value = args[i];
            if (typeof value === 'string') {
                value = cut(value);
                if (value !== args[i]) reduced = true;
            } else if (typeof value === 'symbol' || typeof value === 'function') value = describe(value);
            else if (isErrorLike(value)) value = errorForm(value);
            else if (typeof value === 'object' && value !== null) value = withErrorForms(snapshot(value));
            const unsupported = { kind: '' };
            const bytes = sizeOf ? sizeOf(value, left, undefined, unsupported) : 0;
            if (bytes > left) {
                reduced = true;
                // what it is: a kind the measure does not know, or a value past what is left of the budget (R3:C-3)
                const placeholder = unsupported.kind ? '[unsupported value: ' + unsupported.kind + ']' : '[' + kindOf(value) + ': past the log line\'s byte budget (' + LOG_MAX_BYTES + ')]';
                const cost = placeholder.length * 2 + 8;
                if (cost > left) {
                    const text = tailOf(count - i);
                    out[out.length] = text;
                    tail = text.length * 2 + 8;
                    break;
                }
                value = placeholder;
                left -= cost;
            } else {
                left -= bytes;
            }
            out[out.length] = value;
        }
        return { line: out, bytes: LOG_MAX_BYTES - TAIL_BYTES - left + tail + 16, cut: reduced };
    };

    // The per-second budgets of the lines (the sliding windows above, with the host's constants).
    const lineBudget = slidingWindow(LOG_LINES_PER_SECOND);
    const byteBudget = slidingWindow(LOG_BYTES_PER_SECOND);
    let logsBuffered = 0;
    let droppedForLines = 0; // before the port: past LOG_BUFFER_LIMIT lines
    let droppedForBytes = 0; // before the port: past LOG_BYTES_PER_SECOND bytes
    let rateDropped = false; // past the per-second budgets: warned once per environment
    let bufferedBytes = 0;
    // The relay's own lines ('<mode> Ready' and its warnings, each at most once per environment) are marked `own`: the
    // host dispatches up to LOG_OWN_LINES of them per environment besides the guest's lines (sandbox-log.ts), so the
    // warning that lines were dropped arrives even when the lines before it filled the host's window (R2:M-1, R2:M-2). Only the
    // bootstrap posts on the port (guest code never holds it, AR:B2), so no guest line is ever marked.
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

    // Every console method that takes arguments (R2:C-2): each is a wrapper of ours, built here with index loops only
    // (no spread, no slice, no iterator: a patched Array.prototype[Symbol.iterator] would make such a trace or assert
    // wrapper throw, and its catch then give the browser's console the raw arguments). A wrapper relays its line
    // and hands the browser's console only what relayLine() allows; if anything throws, it hands it nothing: a line
    // that could not be relayed goes nowhere. log, info, warn and error relay at their level; debug, dir, dirxml, table,
    // group and groupCollapsed as 'log' lines; trace as a 'log' line that says so; a failed assert as an 'error' line
    // (a passing one does nothing, here and in the browser). count, countReset, time, timeLog, timeEnd, timeStamp,
    // profile and profileEnd relay nothing to the host, but take arguments to the browser's console: they are bounded
    // and budgeted like a line (unbounded, they would reach it past every budget). groupEnd and clear take none.
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
    // (R2:M-5). In a worker (worker and strict mode) the relay is the only sink: Chromium keeps a worker's
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

    // ---- The listeners: the egress table's rows for this mode (src/lib/egress.ts; R5:N-1, class E-cpu), and
    // no other. Every platform surface by which guest activity can make work on the host page's thread is a row there,
    // with what is done about it; the host hands this bootstrap the rows it owns for its mode (`features.listeners`), and
    // each listener below does what its row says: relay, cancel, count against the budget of uncaught errors. A listener
    // written by hand here would leave a surface nobody had listed (R4:M-1, errors not cancelled; R5:N-1, rejections
    // not cancelled). Capture listeners on the global, installed before any guest code runs.
    //
    // Uncaught errors and unhandled rejections (R1:R4-2, R1:R4-6) are relayed as 'error' lines, "Uncaught …" and
    // "Uncaught (in promise) …". Errors in cooperative and worker mode, trusted ones only; in strict mode the prelude
    // relays the error event (an entry's own error ends the sandbox, in-sandbox-view.ts) and this listener only counts it.
    // Unhandled rejections in every mode, trusted or not: WebKit (every realm) and Firefox (workers) dispatch the
    // platform's own with isTrusted false (measured), and a forged one makes only a line the guest could log itself. What
    // the browser gives is all there is: WebKit mutes the errors of the guest document's inline scripts and of a worker's
    // blob: script ("Script error.", no error object; measured). Each event is read once, through the platform's getters
    // (readEvent).
    //
    // Cancelled once relayed (worker and strict mode; cooperative mode leaves the browser's console to the guest document
    // for debugging). An uncaught error that is not cancelled reaches the Worker object in the frame, with its message, on
    // the host page's thread in Firefox and WebKit, outside every budget (R4:M-1: errors of 16 Mi characters
    // in a loop keep Firefox's host page 99% busy and WebKit's 88%); before the port is attached an error still reaches the
    // frame, which reads it as a worker that failed to start (worker-bootstrap.ts), so errors are cancelled from then on.
    // A rejection that is not cancelled is reported by the browser (R5:N-1: Chromium's host page 11–12% busy
    // under the reviewers' flood); cancelled, Chromium reports nothing.
    //
    // Counted (worker and strict mode): Firefox reports a worker's unhandled rejection to the host page's thread whether
    // or not it is cancelled (measured: 99% busy under the reviewers' flood, cancelled or not; 7 GB in 25 s), and a
    // rejection handled later (rejectionhandled) costs it too. Nothing in the worker can stop that report, so the guest
    // that causes it is stopped instead: past UNCAUGHT_PER_SECOND uncaught errors and rejections, or
    // UNCAUGHT_CHARACTERS_PER_SECOND characters of what the browser reports of them (reportOf), in any one second, the
    // bootstrap tells the element once (UNCAUGHT_PAST_BUDGET, on the port only it holds), and the element ends the sandbox
    // with its reason. A report the browser made before that is not undone: one error of hundreds of millions of
    // characters costs what it costs, once. A rejection event the guest dispatches itself counts as well (WebKit's and
    // Firefox's workers dispatch the platform's own untrusted, so the two cannot be told apart): it can only end its own
    // sandbox, which a guest can do anyway.
    const uncaughtBudget = features?.uncaught;
    const uncaughtCount = uncaughtBudget ? slidingWindow(uncaughtBudget.count) : null;
    const uncaughtCharacters = uncaughtBudget ? slidingWindow(uncaughtBudget.characters) : null;
    // Past the budget the worker also stops itself, once its frame to the element is on the port: Firefox's host page is
    // busy with the reports already made, so the element's own message waits behind them, and a guest still raising
    // errors meanwhile would add more (measured: a flood of small rejections kept Firefox's host page 99% busy for the 4 s
    // its frame took to arrive). close() ends the worker after the current task, and the frame, already on the port, is
    // the element's to read. Before the port is attached the frame waits in the outbox, and the worker stops at attach.
    // The frame leaves in a task of its own, after the event that crossed the budget is dispatched to its end: in strict
    // mode the prelude relays an error from a listener after this one (in-sandbox-view.ts), and its line must leave
    // before the frame that ends the sandbox, which would otherwise drop it.
    let pastUncaught = false;
    let pastSaid = false;
    const stopPastUncaught = () => {
        if (!pastSaid || !port || !closeWorker) return;
        try {
            apply(closeWorker, g, []);
        } catch {
            // no close() to call: the element ends the sandbox on the frame all the same
        }
    };
    const countUncaught = (characters: number) => {
        if (!uncaughtCount || !uncaughtCharacters || pastUncaught) return;
        if (uncaughtCount(1, 'fits') && uncaughtCharacters(characters, 'fits')) {
            uncaughtCount(1, 'spent');
            uncaughtCharacters(characters, 'spent');
            return;
        }
        pastUncaught = true;
        const say = () => {
            pastSaid = true;
            send({ type: 'UNCAUGHT_PAST_BUDGET' });
            stopPastUncaught();
        };
        try {
            apply(setTimer, g, [say, 0]);
        } catch {
            say(); // no timer: at once
        }
    };
    // One row's listener: what it reads of its event, and what the row says to do with it. Null for a type this
    // bootstrap has no listener for.
    const listenerFor = (row: { type: string; relay: boolean; cancel: boolean; budget: boolean }): ((event: Event) => void) | null => {
        const type = row.type;
        const relay = row.relay === true;
        const cancel = row.cancel === true;
        const budget = row.budget === true;
        if (type === 'securitypolicyviolation') return relay ? relayViolation : null;
        if (type === 'rejectionhandled') return budget ? () => countUncaught(0) : null;
        if (type === 'error') {
            return (event: Event) => {
                if (event.isTrusted !== true) return; // isTrusted is an own, unforgeable property
                const read = readEvent(event, 'error');
                const message = read.message;
                const error = read.error;
                let text = '';
                try {
                    text = error !== null && error !== undefined ? errorText(error) : textOf(message);
                    if (!text) text = textOf(message) || 'an error';
                } catch {
                    text = 'an error';
                }
                // relayed and cancelled first, then counted: the line of the one past the budget still arrives
                if (relay) log('error', [uncaught(text)]);
                if (cancel && port) apply(cancelEvent, event, []);
                if (budget) countUncaught(lengthOf(message));
            };
        }
        if (type === 'unhandledrejection') {
            return (event: Event) => {
                let report = { text: 'a rejection', characters: 0 };
                try {
                    report = reportOf(readEvent(event, 'rejection').reason);
                } catch {
                    // a reason that cannot be read: said as 'a rejection'
                }
                if (relay) log('error', ['Uncaught (in promise) ' + report.text]);
                if (cancel) apply(cancelEvent, event, []);
                if (budget) countUncaught(report.characters);
            };
        }
        return null;
    };
    const rows = features?.listeners;
    for (let i = 0; rows && typeof addGlobalListener === 'function' && i < rows.length; i++) {
        const listener = rows[i]!;
        const handler = listenerFor(listener);
        if (handler) apply(addGlobalListener, g, [listener.type, handler, true]);
    }

    // One frame from the host that runs guest code: an EXECUTE, or an RPC_REQ (the broker calls the exposed method).
    const run = (data: any) => {
        if (data?.type === 'EXECUTE') {
            // Compiled with the Function captured above and called through the captured apply: what runs is the
            // embedder's code, now. Nothing is reported back: workerExecutionTimeout is the host's ping at the
            // deadline, answered above only by a free event loop (host.ts, _armExecutionBudget). No global is
            // looked up on this path (BR:CB2): the code must already be a string (the host
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
                    // the message read once (R4:C-1): a getter answers each read as it likes
                    const message = e === null || e === undefined ? undefined : e.message;
                    text = typeof message === 'string' ? cut(message) : errorText(e);
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
    // Every primitive is captured above, before guest code (AR:B2): a guest that replaces
    // Document.prototype.readyState, shadows document.readyState or dispatches its own DOMContentLoaded cannot open
    // the gate early. A guest can only keep it closed for itself (document.open(), or stopping the event in a
    // listener of its window): its own calls then wait for 'complete' or time out. Worker and strict mode have no
    // gate: their guest code runs only in a worker, which has no document.
    // Mirrors the exported MAX_INBOUND_IN_FLIGHT (rpc.ts): declared here to survive stringification, typed by it.
    const MAX_HELD: LimitValue<'MAX_INBOUND_IN_FLIGHT'> = 256;
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
        // refused BUSY through the broker's builder (rpc.ts, R3:C-1), which drops a malformed request as it drops any
        if (refuseHeld) refuseHeld(data, `too many calls waiting for the guest document to be parsed (${MAX_HELD})`);
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
            const type = data?.type; // the host's frame, read once like any value (class G)
            if (type === 'PING') {
                const n = data.n;
                if (typeof n === 'number') post({ type: 'PONG', n });
                return;
            }
            const runsGuestCode = type === 'EXECUTE' || type === 'RPC_REQ';
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
        // The lines buffered before the port count against this second's budgets as they leave now (R2:M-2): at most
        // LOG_BUFFER_LIMIT (= LOG_LINES_PER_SECOND) lines and LOG_BYTES_PER_SECOND bytes, what one window holds, so the
        // guest's lines that follow at once wait for the window like any others, and the host dispatches all of them.
        lineBudget(logsBuffered, 'spent');
        byteBudget(bufferedBytes, 'spent');
        if (skipped > 0) ownLine('warn', `[bridge] skipped ${skipped} queued bridge frame(s) that could not be posted (not transferable).`);
        if (droppedForLines + droppedForBytes > 0) {
            const caps = (droppedForLines > 0 ? `${droppedForLines} past ${LOG_BUFFER_LIMIT} lines` : '')
                + (droppedForLines > 0 && droppedForBytes > 0 ? ', ' : '')
                + (droppedForBytes > 0 ? `${droppedForBytes} past ${LOG_BYTES_PER_SECOND} bytes` : '');
            ownLine('warn', `[Sandbox] ${droppedForLines + droppedForBytes} console line(s) logged before the sandbox was connected were dropped (${caps}): at most ${LOG_BUFFER_LIMIT} lines and ${LOG_BYTES_PER_SECOND} bytes are kept until then.`);
        }

        // posted as it is, never swallowed: a port that cannot carry it is no port, and attach() throws (onInit)
        post({ type: 'LOG', level: 'info', args: [`${mode} Ready`], own: true });
        stopPastUncaught(); // a guest past the budget of uncaught errors before the port arrived: its frame has just left
    };

    // Cooperative mode: the bootstrap's own end of the channel it announced, attached now, before any guest code runs.
    if (announced) {
        attach(announced.port1);
        return { attach, writeFiles, log, readEvent };
    }

    // Worker mode: the one INIT_PORT (AR:B1), the port1 the frame made (worker-bootstrap.ts): a trusted message with
    // exactly one port. In a dedicated worker only the frame that made it can post to it, and no guest code runs here
    // before the port is attached (guest code arrives only as EXECUTE frames on it). A capture listener that stops the
    // event; anything else is ignored and the listener stays. It never throws. Once the port is attached, the worker
    // tells the frame it runs (WORKER_STARTED, R2:C-5): the frame announces the port to the host only then,
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
    return { attach, writeFiles, log, readEvent };
}
