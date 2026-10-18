/**
 * β — a typed, bidirectional RPC broker that rides the MessageChannel already connecting
 * host and guest (backlog B1). It adds a request/response + method-registry layer on top of
 * the existing INIT_PORT / EXECUTE / LOG protocol without touching any of those frames.
 *
 * SELF-CONTAINED BY DESIGN. `createBroker` is used two ways:
 *   - the host imports it and calls it directly;
 *   - the guest side is injected by STRINGIFYING it (`createBroker.toString()`) into the
 *     in-sandbox bootstrap, exactly like `inSandboxScript`.
 * So it must close over nothing from module scope: every helper lives INSIDE the function and
 * it references only platform globals that exist in both Window and Worker scopes (Map, Promise,
 * Array, Error, String, setTimeout/clearTimeout, structuredClone), each taken once, in the captured list at
 * its top: in the guest that list runs before any guest code, and nothing after it reads a global or a
 * prototype guest code can replace (review round 2, C-1). A top-level import or constant
 * would read as `undefined` once stringified into the guest. The upside is that both sides run
 * the very same dispatcher.
 * For the same reason it sticks to syntax the build emits verbatim: down-levelled syntax compiles to
 * module-scope helpers (async/await, for one, can become an `__async`/`__awaiter` helper) that the
 * stringified body would call but the guest would not have — which is why it uses promise chains, never async/await.
 *
 * Wire protocol (new discriminated types, alongside the untouched INIT_PORT/EXECUTE/LOG):
 *   Request:  { type: 'RPC_REQ', id, method, args }
 *   Response: { type: 'RPC_RES', id, ok, value?, error?, code? }
 *   `code` rides only on a failure and names what failed on the responding side (UNKNOWN_METHOD,
 *   HANDLER_ERROR, RESULT_NOT_TRANSFERABLE or BUSY). Both sides run this same function, so the two ends of
 *   the wire cannot disagree on its meaning.
 *
 * Every frame is bounded as a whole, by construction (review round 3, C-1). Frames are made in one place, the builders
 * requestFrame, resultFrame and refusalFrame below (a unit test keeps every 'RPC_REQ' and 'RPC_RES' literal of src/
 * there, and every post of this function on one of their frames), and each part they are given is bounded before they
 * are: an id is our own counter, or a number or a string of at most MAX_NAME_LENGTH characters (anything else is a
 * malformed frame, dropped); a method name is at most MAX_NAME_LENGTH characters at both ends (the caller refuses a
 * longer one INVALID_CALL, the receiver answers UNKNOWN_METHOD without echoing it); an error text is cut to
 * MAX_TEXT_LENGTH characters by the builder, and every error this function mints is cut the same way, so a text
 * received is cut again; arguments and a result are snapshots, and the whole frame that carries them is measured
 * before it is posted and again where it arrives. Before, only the arguments and a result were measured: a method name
 * of 2^27 characters was echoed whole in `unknown method: …`, and a handler's error text of 2^28 characters crossed as
 * it was, each stalling the host 0.2–0.7 s per call.
 *
 * Refusals (backlog B7). Every rejection this broker produces is a plain Error with a string `code`
 * from one closed set (RpcErrorCode), grouped by who can cause them:
 *   - LOCAL-ONLY codes (TIMEOUT, TERMINATED, SEND_FAILED, INVALID_CALL) are minted only by the side whose
 *     call is refused, from its own state: its timer, its teardown, its transport, its argument check;
 *   - codes REPORTED BY THE OTHER SIDE (UNKNOWN_METHOD, HANDLER_ERROR, RESULT_NOT_TRANSFERABLE, BUSY,
 *     ARGS_NOT_TRANSFERABLE) are the only ones a response can produce: the wire `code` is clamped into this
 *     group on receipt. Two of them are also minted locally, for the same condition seen early: BUSY (the
 *     other side's per-second budget) and ARGS_NOT_TRANSFERABLE (arguments the other side could never carry,
 *     refused before sending; review round 4, C-5: the receiver answered them BUSY, retryable).
 * Because the clamp never yields a local-only code, nothing the other side sends can make a rejection
 * look like one of the local side's own: a response that claims `code: 'TERMINATED'`, or carries the
 * exact termination text, rejects with code HANDLER_ERROR. For the
 * reported codes the message stays the other side's text verbatim, up to MAX_TEXT_LENGTH characters (a handler's
 * throw rejects with its original message) — the code, not the text, is the part a caller can branch on.
 * `code` is a plain own property rather than an Error subclass: a subclass would be a module-scope
 * class this function cannot close over (see above), and a property reads the same in every realm.
 *
 * Reserved methods (backlog B5, ADR-006). Names starting with `sandbox:` belong to the library: they live in
 * a registry of their own, filled only by `exposeReserved`, and `expose` never registers such a name. So an
 * embedder's or a guest's method can never replace a library method, and a library method never answers to
 * a name someone else exposed: the two namespaces are disjoint by construction. A reserved method's
 * refusal may carry one of the LIBRARY codes (RpcLibraryCode: the fetch bridge's FETCH_* codes and the guest writes' file codes), and
 * only a reserved method's: a code on any other handler's error is not forwarded (HANDLER_ERROR, as above).
 * The calling side accepts a library code only for a call to a reserved name, and only when created with
 * `acceptLibraryCodes` — the guest's broker. The host's broker is not, so nothing the guest sends can ever
 * give a host call a library code: on the host every response is clamped exactly as described above.
 *
 * Symmetric model: on each side `expose` publishes YOUR methods and `call` invokes the OTHER
 * side's methods. Each side keeps its own monotonic id counter, its own `pending` map (calls it
 * initiated) and its own registry (methods it exposed). ids only need to be unique within the
 * caller's own pending map — the responder merely echoes them back — so a per-side counter is enough.
 */

// A method the other side may call. Args and the return value cross via structured clone.
export type RpcMethod = (...args: any[]) => unknown;

// Posts one frame onto the transport. The host queues until its port exists; the guest buffers
// until INIT_PORT. The broker itself never touches the port, which keeps it transport-agnostic
// and unit-testable. `transfer` is given only to a reply channel of a broker made with `transferResults`: the
// ArrayBuffers of a result's snapshot, which no one else holds (sendResult).
// A send that returns a string did not post the frame: the environment the call was made for is gone (review round 3,
// L-2: the host's send, when a getter in the arguments ended it while they were copied). The call is refused at once
// with TERMINATED and that text, so no call is ever left pending on a transport that will not answer it. Any other
// return value means the frame was posted (or queued for its environment's port).
export type RpcSend = (frame: unknown, transfer?: Transferable[]) => unknown;

/**
 * Why a call was refused. The set is closed and the strings are wire protocol (pinned by a test).
 * Set only by the side whose call is refused:
 *   TIMEOUT                 the per-call timer fired before an answer arrived (the only code worth retrying)
 *   TERMINATED              the transport went away: the sandbox was reset or terminated (retry only
 *                           after the next 'ready')
 *   ARGS_NOT_TRANSFERABLE   the arguments cannot be structured-cloned, measure past RPC_MAX_BYTES or hold a kind the
 *                           measure does not know; nothing was sent. Also reported by the other side for a request
 *                           that arrives so (its own broker never sends one); nothing ran there
 *   SEND_FAILED             the transport threw while sending; nothing was left pending
 *   INVALID_CALL            the method name is not a string, or is longer than 256 characters; nothing was sent
 * Reported by the other side (the message is its text; any other reported value reads as HANDLER_ERROR):
 *   UNKNOWN_METHOD          no method of that name is exposed there
 *   HANDLER_ERROR           the handler threw or rejected
 *   RESULT_NOT_TRANSFERABLE the handler's return value cannot be structured-cloned, or an answer arrived past
 *                           RPC_MAX_BYTES
 *   BUSY                    the other side already has MAX_INBOUND_IN_FLIGHT of your calls (or RPC_MAX_INBOUND_BYTES
 *                           of their arguments) in flight on this channel; nothing ran (retryable once earlier calls
 *                           settle). The guest's own calls are also
 *                           refused BUSY past the per-second budget of the calls a guest makes (review round 3, M-2),
 *                           by the host on receipt and, before anything is sent, by the guest's broker itself: the
 *                           one reported code a broker also mints, for the other side's budget, applied early
 */
export type RpcErrorCode =
    | 'TIMEOUT' | 'TERMINATED' | 'ARGS_NOT_TRANSFERABLE' | 'SEND_FAILED' | 'INVALID_CALL'
    | 'UNKNOWN_METHOD' | 'HANDLER_ERROR' | 'RESULT_NOT_TRANSFERABLE' | 'BUSY';

/**
 * Most inbound calls a broker runs at once per channel (review B7): a further request is answered at once with
 * BUSY and its method is not called. Bounds the work and memory the other side can hold open on this side
 * with calls to a method that is slow or never settles. Mirrored inside createBroker (a test keeps them equal).
 */
export const MAX_INBOUND_IN_FLIGHT = 256;

/**
 * The byte budget of one RPC message (review round 1, R3-3), measured with structured-size.ts: a call's arguments and
 * a result. The largest message the library itself sends is a fetch bridge body at its largest `maxBytes` (32 MiB)
 * with its headers, so 33 MiB. A call past it is refused before anything is sent (ARGS_NOT_TRANSFERABLE), a result
 * past it is answered RESULT_NOT_TRANSFERABLE, and a frame past it that arrives anyway is not acted on. Mirrored inside
 * createBroker (a test keeps them equal).
 */
export const RPC_MAX_BYTES = 34603008;

/**
 * Most bytes of arguments a broker holds in inbound calls running at once, per channel (review round 1, R3-3): a call
 * that would take it past this is answered BUSY and its method does not run. With MAX_INBOUND_IN_FLIGHT alone, 256
 * calls of 32 MiB each to a method that never settles held 8 GiB on the host (measured in WebKit). Mirrored inside
 * createBroker (a test keeps them equal).
 */
export const RPC_MAX_INBOUND_BYTES = 67108864;

/**
 * Codes a library-reserved method (a `sandbox:` name) reports, from one closed set, disjoint from
 * RpcErrorCode: the fetch bridge's FETCH_* (backlog B5, src/lib/fetch-bridge.ts) and the guest writes' file
 * codes (backlog C5, src/lib/guest-writes.ts; the same FileErrorCode strings registerFiles() throws, files.ts).
 * The strings are wire protocol (pinned by a test). Only the guest's calls to reserved methods can be refused
 * with them. NOT_FOUND is not one: the guest mints it from the host's answer (in-sandbox-files.ts).
 */
export type RpcLibraryCode =
    | 'FETCH_NOT_ALLOWED' | 'FETCH_BUSY' | 'FETCH_REDIRECT' | 'FETCH_TOO_LARGE' | 'FETCH_TIMEOUT' | 'FETCH_FAILED'
    | 'INVALID_PATH' | 'INVALID_FILE' | 'FILES_QUOTA_EXCEEDED' | 'FILES_NOT_ALLOWED' | 'FILES_BUSY';

/** Every library-reserved method name starts with this prefix; expose() never registers one. */
export const RESERVED_METHOD_PREFIX = 'sandbox:';

/** The shape of every rejection from call()/callWithTimeout(): a plain Error with an own `code`. */
export interface RpcError extends Error {
    code: RpcErrorCode;
}

export interface BrokerOptions {
    // Default per-call timeout in ms; 0 disables timeouts entirely. Override per call via callWithTimeout.
    timeoutMs?: number;
    // Accept a library code (RpcLibraryCode) in a refusal of a call to a reserved method. Only the guest's
    // broker sets it; the host's never does, so a host call can never be refused with a library code.
    acceptLibraryCodes?: boolean;
    // The byte measure (createSizeOf() of structured-size.ts) the budgets RPC_MAX_BYTES and RPC_MAX_INBOUND_BYTES are
    // measured with. Both brokers the library makes pass one (host.ts, in-sandbox-script.ts); passed in rather than
    // closed over because this function is stringified.
    sizeOf?: (value: unknown, limit: number, buffers?: unknown[], unsupported?: { kind: string }) => number;
    // Post a result's snapshot with its ArrayBuffers transferred (sendResult): only the host's broker, whose reply
    // channels take a transfer list. The guest's posts nothing but the frame.
    transferResults?: boolean;
    // The per-second budget of the calls the guest makes (review round 3, M-2), as a sliding one-second window its owner
    // keeps: given a call's frame bytes, counts it and returns null, or returns why it is refused (and counts nothing).
    // The guest's broker asks `admitOutbound` before it sends a call, and refuses one past it BUSY, locally, so it never
    // crosses; the host's asks `admitInbound` when a request arrives, before its method is looked up, and answers BUSY.
    admitOutbound?: (bytes: number) => string | null;
    admitInbound?: (bytes: number) => string | null;
    // The guest's startup gate (in-sandbox-script.ts) answers a request it cannot hold with BUSY. It is given, once, the
    // function that does so through this broker's builder, so no RPC frame is made anywhere else (C-1); it is never part
    // of the returned object, so guest code never holds it.
    takeBusyRefusal?: (refuse: (request: unknown, reason: string) => void) => void;
}

export interface Broker {
    /**
     * Publishes one of YOUR methods under `name` for the other side to call. Last registration wins. A
     * reserved name (one starting with RESERVED_METHOD_PREFIX) is ignored: those belong to the library.
     */
    expose(name: string, fn: RpcMethod): void;
    /**
     * Publishes a LIBRARY method under a reserved name (it must start with RESERVED_METHOD_PREFIX; any other
     * name is ignored). Its refusals may carry a library code (RpcLibraryCode), set on the thrown error's
     * own `code`; any other code is reported as HANDLER_ERROR.
     */
    exposeReserved(name: string, fn: RpcMethod): void;
    /**
     * Invokes a method the OTHER side exposed and resolves with its result. Uses the default timeout.
     * Every rejection is an RpcError: branch on its `code`, never on its message.
     */
    call(method: string, ...args: unknown[]): Promise<unknown>;
    /** Like call(), but with an explicit timeout in ms for this one call (0 disables it). */
    callWithTimeout(timeoutMs: number, method: string, ...args: unknown[]): Promise<unknown>;
    /**
     * Feed every inbound port frame here; non-RPC and malformed frames are ignored, never thrown on.
     * Answers to an inbound request go to `reply` — the channel it arrived on — or to `send` without one.
     */
    handleMessage(data: unknown, reply?: RpcSend): void;
    /**
     * Rejects every in-flight call with code TERMINATED and `message` (used by the host on teardown so
     * no promise hangs). Each call gets its own Error.
     */
    rejectAllPending(message: string): void;
    /**
     * An Error with code TERMINATED, for a call the owner refuses because its transport is gone (the
     * host's call() after terminate). Lets the owner refuse with the same code string the broker uses.
     */
    terminationError(message: string): RpcError;
}

export function createBroker(send: RpcSend, options: BrokerOptions = {}): Broker {
    // ---- The captured list (review round 2, C-1). In the guest this function runs in the bootstrap, before any guest
    // code, and its closures run long after: so every global and every prototype method they use is taken here, and
    // nothing below it reads one (a unit test scans the text). Before, `inFlight.get(respond)` called whatever
    // Map.prototype.get was at that moment, and so handed the guest the bootstrap's `send`, which posts any frame on the
    // port past the console relay's budgets. The host captures the same list from its own realm.
    const apply = Reflect.apply;
    const construct = Reflect.construct;
    const defineOwn = Reflect.defineProperty;
    const setPrototype = Object.setPrototypeOf;
    const isArray = Array.isArray;
    const clone = structuredClone;
    const MapConstructor = Map;
    const mapGet = Map.prototype.get;
    const mapSet = Map.prototype.set;
    const mapDelete = Map.prototype.delete;
    const mapForEach = Map.prototype.forEach;
    const PromiseConstructor = Promise;
    const resolved = Promise.resolve;
    const rejected = Promise.reject;
    const then = Promise.prototype.then;
    const ErrorConstructor = Error;
    const StringConstructor = String;
    const startsWith = String.prototype.startsWith;
    const slice = String.prototype.slice;
    const setTimer = setTimeout;
    const clearTimer = clearTimeout;
    // Declared INSIDE the function so it survives stringification into the guest. A call whose
    // handler never answers would otherwise hang forever; 30s is generous for a local same-process
    // port yet still bounds an unresponsive other side.
    const DEFAULT_TIMEOUT_MS = 30000;
    const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const acceptLibraryCodes = options.acceptLibraryCodes === true;
    const transferResults = options.transferResults === true;
    // Each option read once (review round 4, C-1: a value checked on one read and used from another is two values).
    const sizeOfOption = options.sizeOf;
    const admitOutboundOption = options.admitOutbound;
    const admitInboundOption = options.admitInbound;
    const takeBusyRefusalOption = options.takeBusyRefusal;
    const sizeOf = typeof sizeOfOption === 'function' ? sizeOfOption : null;
    const admitOutbound = typeof admitOutboundOption === 'function' ? admitOutboundOption : null;
    const admitInbound = typeof admitInboundOption === 'function' ? admitInboundOption : null;
    const takeBusyRefusal = typeof takeBusyRefusalOption === 'function' ? takeBusyRefusalOption : null;
    const CAPTURE_POINT = 'nothing below reads a global, or an intrinsic guest code can replace';

    // Mirrors the exported RESERVED_METHOD_PREFIX (a test keeps them equal): declared here to survive stringification.
    const RESERVED_PREFIX = 'sandbox:';
    // Mirrors the exported MAX_INBOUND_IN_FLIGHT, for the same reason.
    const MAX_IN_FLIGHT = 256;
    // Mirror RPC_MAX_BYTES and RPC_MAX_INBOUND_BYTES, for the same reason.
    const MAX_BYTES = 34603008;
    const MAX_INBOUND_BYTES = 67108864;
    // The longest method name, and the longest string id (C-1): a name is chosen by whoever exposes it, so this bounds
    // what a frame and an UNKNOWN_METHOD text can carry of it. The library's own longest is 'sandbox:write'.
    const MAX_NAME_LENGTH = 256;
    // The longest error text a frame or a rejection carries, the marker included (C-1): 64 Ki characters, as a log string.
    const MAX_TEXT_LENGTH = 65536;
    const CUT_MARKER = ` [… cut at ${MAX_TEXT_LENGTH} characters]`;
    const UNKNOWN_ERROR = 'unknown error';
    // The bytes of a value by the snapshot measure; a kind the measure does not know is written to `unsupported` (C-3).
    const bytesOf = (value: unknown, limit: number, buffers?: unknown[], unsupported?: { kind: string }) => (sizeOf ? sizeOf(value, limit, buffers, unsupported) : 0);
    // Mirrors MAX_TIMER_DELAY (long-timer.ts; a test keeps them equal), for the same reason. A call's timeout is the
    // caller's to choose, and setTimeout overflows at 2^31 ms and fires at once (review round 2, L-2): a longer timeout
    // is waited out in steps of at most this, and Infinity never fires. Returns how to disarm it.
    const MAX_TIMER_DELAY = 2147483647;
    const armTimer = (onTimeout: () => void, ms: number): (() => void) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let disarmed = false;
        const wait = (left: number) => {
            const step = left > MAX_TIMER_DELAY ? MAX_TIMER_DELAY : left;
            timer = setTimer(() => {
                timer = null;
                if (disarmed) return;
                if (left > step) wait(left - step);
                else onTimeout();
            }, step);
        };
        if (ms !== Infinity) wait(ms);
        return () => {
            disarmed = true;
            if (timer !== null) clearTimer(timer);
            timer = null;
        };
    };

    // The one source of truth for the code strings (see RpcErrorCode for meanings). Inside the function
    // for the same reason as everything else; the type makes it exhaustive and exact.
    const CODE: { readonly [K in RpcErrorCode]: K } = {
        TIMEOUT: 'TIMEOUT',
        TERMINATED: 'TERMINATED',
        ARGS_NOT_TRANSFERABLE: 'ARGS_NOT_TRANSFERABLE',
        SEND_FAILED: 'SEND_FAILED',
        INVALID_CALL: 'INVALID_CALL',
        UNKNOWN_METHOD: 'UNKNOWN_METHOD',
        HANDLER_ERROR: 'HANDLER_ERROR',
        RESULT_NOT_TRANSFERABLE: 'RESULT_NOT_TRANSFERABLE',
        BUSY: 'BUSY',
    };

    // The library codes (RpcLibraryCode), closed: what a reserved method may report. Read by index only.
    const LIBRARY_CODES: readonly RpcLibraryCode[] = [
        'FETCH_NOT_ALLOWED', 'FETCH_BUSY', 'FETCH_REDIRECT', 'FETCH_TOO_LARGE', 'FETCH_TIMEOUT', 'FETCH_FAILED',
        'INVALID_PATH', 'INVALID_FILE', 'FILES_QUOTA_EXCEEDED', 'FILES_NOT_ALLOWED', 'FILES_BUSY',
    ];
    // The library code equal to `code`, as our own constant, or undefined.
    const libraryCodeOf = (code: unknown): RpcLibraryCode | undefined => {
        for (let i = 0; i < LIBRARY_CODES.length; i++) if (LIBRARY_CODES[i] === code) return LIBRARY_CODES[i];
        return undefined;
    };
    const isReservedName = (name: string) => apply(startsWith, name, [RESERVED_PREFIX]) as boolean;
    // Maps through the captured methods only.
    const mapOf = <K, V>() => new MapConstructor() as Map<K, V>;
    const get = <K, V>(map: Map<K, V>, key: K): V | undefined => apply(mapGet, map, [key]);
    const set = <K, V>(map: Map<K, V>, key: K, value: V) => { apply(mapSet, map, [key, value]); };
    const remove = <K, V>(map: Map<K, V>, key: K) => { apply(mapDelete, map, [key]); };
    // An id a response may echo: a number (ours are), or a short string (C-1).
    type RpcId = number | string;
    const isId = (id: unknown): id is RpcId => typeof id === 'number' || (typeof id === 'string' && id.length <= MAX_NAME_LENGTH);
    // An error text, always a string of at most MAX_TEXT_LENGTH characters: a longer one keeps its start and ends with the
    // marker. A text cut once is not cut again (it is exactly MAX_TEXT_LENGTH long), so a receiver that cuts what it got
    // changes nothing. Total (review round 4, C-1): anything that is not a string becomes one first, through the captured
    // String, or the fixed text when that throws. It used to return whatever it was given when its `length` was small,
    // so a value that was not a string (a getter's second answer, below) was posted unmeasured inside a refusal frame.
    const cutText = (value: unknown): string => {
        let text: string;
        if (typeof value === 'string') {
            text = value;
        } else {
            try {
                text = StringConstructor(value);
            } catch {
                text = UNKNOWN_ERROR;
            }
        }
        return text.length > MAX_TEXT_LENGTH ? apply(slice, text, [0, MAX_TEXT_LENGTH - CUT_MARKER.length]) + CUT_MARKER : text;
    };
    // What a measure past the budget says (C-3): the kind the measure did not know, if that is why, else the budget.
    const pastBudget = (holder: string, unsupported: { kind: string }, larger: string) => (unsupported.kind ? `${holder} an unsupported value: ${unsupported.kind}` : larger);

    // ---- The one builder of RPC frames (C-1; see the header). Each takes parts already bounded: `id` is our counter or
    // passed isId, `method` was checked against MAX_NAME_LENGTH by request(), `args` and `value` are snapshots whose frame
    // the caller measures before posting it, `code` is one of our constants; `error` is cut here.
    function requestFrame(id: number, method: string, args: unknown[]) {
        return { type: 'RPC_REQ', id, method, args };
    }
    function resultFrame(id: RpcId, value: unknown) {
        return { type: 'RPC_RES', id, ok: true, value };
    }
    function refusalFrame(id: RpcId, error: unknown, code: string) {
        return { type: 'RPC_RES', id, ok: false, error: cutText(error), code };
    }

    // Methods WE expose. Using a Map (not a plain object) is the core of the hardening — see handleRequest.
    // Reserved names live in their own map, written only by exposeReserved: see the header.
    const registry = mapOf<string, RpcMethod>();
    const reservedRegistry = mapOf<string, RpcMethod>();

    // Calls WE initiated, keyed by the id we chose.
    type Pending = {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        disarm: (() => void) | null; // its timeout's, or null without one
        reserved: boolean; // a call to a reserved name: the only kind a library code may refuse
    };
    const pending = mapOf<number, Pending>();
    let nextId = 0;

    // Inbound calls running now, per reply channel (review B7). Keyed by the channel an answer goes back on: the
    // host passes one per port, so the count belongs to one environment and a channel that is gone takes its
    // count with it once its calls settle. An entry is removed when its count returns to 0.
    const inFlight = mapOf<RpcSend, number>();
    // The bytes of those calls' arguments, per reply channel (RPC_MAX_INBOUND_BYTES), kept and released with the count.
    const inFlightBytes = mapOf<RpcSend, number>();

    // Normalizes anything thrown/rejected into a plain string for the wire, cut to MAX_TEXT_LENGTH: its `message` when that
    // is a string, else the value itself as text (cutText). The message is read ONCE (review round 4, C-1): it used to be
    // read to check its type and again to use it, and a getter answered a short string to the check and a 200 MiB object
    // to the use, which cutText then passed on unmeasured (the host stalled 280–362 ms per refusal in Firefox and WebKit).
    // Wrapped in try/catch so a getter that throws can never take the message handler down with it.
    function errorMessage(error: unknown): string {
        try {
            const message = error === null || error === undefined ? undefined : (error as { message?: unknown }).message;
            return cutText(typeof message === 'string' ? message : error);
        } catch {
            return UNKNOWN_ERROR;
        }
    }

    // An Error with an own `code`, defined rather than assigned: an assignment would reach a setter guest code put on
    // Error.prototype or Object.prototype. Its message is cut to MAX_TEXT_LENGTH (C-1): every rejection this function
    // makes, a reported text received included, carries a bounded one.
    function codedError(message: string, code: string): RpcError {
        const error = new ErrorConstructor(cutText(message)) as RpcError;
        defineOwn(error, 'code', { value: code, writable: true, enumerable: true, configurable: true });
        return error;
    }

    // Mints a refusal with a LOCAL code. Called only from this side's own state (its timer, teardown,
    // clone check, send, argument check) — never with anything taken from an inbound frame. That is what
    // makes a local code trustworthy: the other side has no path into this function. Its parameter type
    // admits only the local codes.
    function localRefusal(code: Exclude<RpcErrorCode, 'UNKNOWN_METHOD' | 'HANDLER_ERROR' | 'RESULT_NOT_TRANSFERABLE' | 'BUSY'>, message: string): RpcError {
        return codedError(message, code);
    }

    // The guest's call past the per-second budget (M-2), refused here, before it is sent, as the host would answer it:
    // BUSY, the other side's code, minted for the other side's budget. Its text is the budget owner's.
    function budgetRefusal(message: string): RpcError {
        return codedError(message, CODE.BUSY);
    }

    // Turns a failure the other side reported into a rejection. The inbound frame is untrusted, so its
    // `code` is clamped into the codes the other side may report: exactly UNKNOWN_METHOD,
    // RESULT_NOT_TRANSFERABLE, BUSY or ARGS_NOT_TRANSFERABLE pass through, and anything else (a local-only code, an
    // unknown string, a non-string, nothing) becomes HANDLER_ERROR. So a response can never yield TIMEOUT, TERMINATED,
    // SEND_FAILED or INVALID_CALL. The
    // message is the other side's text verbatim up to MAX_TEXT_LENGTH (codedError cuts it again, C-1), or a fixed
    // fallback when it sent none. Each field is
    // read once, and `code` is always one of our own constants rather than the inbound value.
    // A library code passes only for a call to a reserved name on a broker created with acceptLibraryCodes
    // (the guest's); it is then the matching string from our own LIBRARY_CODES, never the inbound value.
    function refusalFromResponse(data: any, reserved: boolean): RpcError {
        const reportedError = data.error;
        const reportedCode = data.code;
        const libraryCode = reserved && acceptLibraryCodes ? libraryCodeOf(reportedCode) : undefined;
        const code = reportedCode === CODE.UNKNOWN_METHOD ? CODE.UNKNOWN_METHOD
            : reportedCode === CODE.RESULT_NOT_TRANSFERABLE ? CODE.RESULT_NOT_TRANSFERABLE
            : reportedCode === CODE.BUSY ? CODE.BUSY
            : reportedCode === CODE.ARGS_NOT_TRANSFERABLE ? CODE.ARGS_NOT_TRANSFERABLE
            : libraryCode !== undefined ? libraryCode
            : CODE.HANDLER_ERROR;
        return codedError(typeof reportedError === 'string' ? reportedError : 'RPC call failed', code);
    }

    // The code an error thrown by a handler is reported with: a library code only from a reserved method.
    function handlerErrorCode(error: unknown, reserved: boolean): string {
        if (!reserved || !error || typeof error !== 'object') return CODE.HANDLER_ERROR;
        return libraryCodeOf((error as any).code) ?? CODE.HANDLER_ERROR;
    }

    // Removes a pending call and disarms its timer, returning it once (or null if already settled).
    // Routing every settle path through here makes a second settle for the same id a no-op, which is
    // what keeps a stale or duplicate response from resolving a later call that reused nothing.
    function takePending(id: number): Pending | null {
        const entry = get(pending, id);
        if (!entry) return null;
        remove(pending, id);
        if (entry.disarm !== null) entry.disarm();
        return entry;
    }

    // Answers a request with its handler's result (review round 2, C-3): a snapshot of it is taken first, with the
    // captured structuredClone, measured, and posted; the live value is read once, by that clone. Measuring the live
    // value and posting it let a getter answer the measure small and the post large. A value structured clone cannot
    // carry (a function, a DOM node, a Symbol) is answered with an error frame — a string error always clones — so the
    // caller fails promptly, as before. The snapshot is posted with its ArrayBuffers transferred where the transport
    // takes a transfer list (the host's, `transferResults`), so a large binary result is copied once, by the snapshot,
    // and not again by the post; its strings are copied twice, which the budget bounds. What is measured is the whole
    // frame that is posted (C-1).
    function sendResult(respond: RpcSend, id: RpcId, value: unknown): void {
        let snapshot: unknown;
        try {
            snapshot = clone(value);
        } catch (error) {
            respond(refusalFrame(id, `result is not transferable: ${errorMessage(error)}`, CODE.RESULT_NOT_TRANSFERABLE));
            return;
        }
        const frame = resultFrame(id, snapshot);
        const buffers: unknown[] | undefined = transferResults ? [] : undefined;
        const unsupported = { kind: '' };
        if (bytesOf(frame, MAX_BYTES, buffers, unsupported) > MAX_BYTES) {
            respond(refusalFrame(id, pastBudget('the result holds', unsupported, `result is larger than the RPC byte budget (${MAX_BYTES})`), CODE.RESULT_NOT_TRANSFERABLE));
            return;
        }
        try {
            respond(frame, buffers as Transferable[] | undefined);
        } catch (error) {
            respond(refusalFrame(id, `result is not transferable: ${errorMessage(error)}`, CODE.RESULT_NOT_TRANSFERABLE));
        }
    }

    // `respond` is where every answer to this request goes: success, handler error, unknown method and
    // not-transferable alike (see handleMessage for why that is the channel the request arrived on).
    function handleRequest(data: any, respond: RpcSend): void {
        // The inbound request is untrusted (on the host it is attacker-controlled). Validate its shape
        // with guard clauses and drop anything malformed SILENTLY — a message handler must never throw.
        // id may be a number or a short string (isId), method must be a string, args must be an array.
        const id = data.id;
        if (!isId(id)) return;
        const name = data.method;
        if (typeof name !== 'string') return;
        const args = data.args;
        if (!isArray(args)) return;
        // A name no broker sends and none can expose (C-1): refused without echoing it.
        if (name.length > MAX_NAME_LENGTH) {
            respond(refusalFrame(id, `the method name is longer than ${MAX_NAME_LENGTH} characters`, CODE.UNKNOWN_METHOD));
            return;
        }
        // The bytes (R3-3), of the whole frame that arrived (C-1), so the other side's measure is not trusted: a request
        // past RPC_MAX_BYTES, or holding a kind the measure does not know (the other side's broker never sends either),
        // does not run. Answered ARGS_NOT_TRANSFERABLE (review round 4, C-5), the code the caller's own broker refuses the
        // same arguments with before sending: they will never be carried, so the answer is not one to retry. It was BUSY,
        // which says "retry once earlier calls settle".
        const unsupported = { kind: '' };
        const bytes = bytesOf(data, MAX_BYTES, undefined, unsupported);
        if (bytes > MAX_BYTES) {
            respond(refusalFrame(id, pastBudget('the call holds', unsupported, `the call is larger than the RPC byte budget (${MAX_BYTES})`), CODE.ARGS_NOT_TRANSFERABLE));
            return;
        }
        // The per-second budget of the calls the guest makes (M-2), counted before the method is looked up: a flood of
        // calls to names that do not exist costs this side as much as any other.
        const overBudget = admitInbound ? admitInbound(bytes) : null;
        if (overBudget !== null) {
            respond(refusalFrame(id, overBudget, CODE.BUSY));
            return;
        }

        // Lookup is allowlist-only: registry.get(name), NEVER registry[name]. A Map has no prototype
        // chain, so the only names that resolve are ones we explicitly exposed. Names such as
        // "__proto__", "constructor", "prototype", "toString" or "valueOf" are just ordinary (absent)
        // keys here; on a plain object they would instead resolve to inherited functions and let the
        // caller reach or mutate the prototype chain. So unknown and inherited names alike resolve to
        // nothing and invoke nothing.
        const reserved = isReservedName(name);
        const method = get(reserved ? reservedRegistry : registry, name);
        if (!method) {
            respond(refusalFrame(id, `unknown method: ${name}`, CODE.UNKNOWN_METHOD));
            return;
        }

        // At most MAX_IN_FLIGHT calls run at once per channel (review B7): beyond that the call is refused at
        // once, before its method runs, so a flood of calls to a method that never settles holds a bounded amount.
        const running = get(inFlight, respond) ?? 0;
        if (running >= MAX_IN_FLIGHT) {
            respond(refusalFrame(id, `too many calls in flight (${MAX_IN_FLIGHT})`, CODE.BUSY));
            return;
        }
        // The bytes too (R3-3): a request that would take this channel's running calls past RPC_MAX_INBOUND_BYTES does not run.
        const holding = get(inFlightBytes, respond) ?? 0;
        if (holding + bytes > MAX_INBOUND_BYTES) {
            respond(refusalFrame(id, `too many bytes in calls in flight (${MAX_INBOUND_BYTES})`, CODE.BUSY));
            return;
        }
        set(inFlight, respond, running + 1);
        set(inFlightBytes, respond, holding + bytes);
        const release = () => {
            const left = (get(inFlight, respond) ?? 1) - 1;
            const leftBytes = (get(inFlightBytes, respond) ?? bytes) - bytes;
            if (left > 0) {
                set(inFlight, respond, left);
                set(inFlightBytes, respond, leftBytes > 0 ? leftBytes : 0);
            } else {
                remove(inFlight, respond);
                remove(inFlightBytes, respond);
            }
        };
        const succeeded = (value: unknown) => {
            release();
            sendResult(respond, id, value);
        };
        const failed = (error: unknown) => {
            release();
            respond(refusalFrame(id, errorMessage(error), handlerErrorCode(error, reserved)));
        };

        // We CALL a pre-registered function reference with the cloned args — we never eval / new Function
        // the method name or the args, and the args arrived as inert structured-clone data, so nothing
        // the other side sends is ever interpreted as code. The method runs in a microtask, and what it returns is
        // settled with Promise.resolve, so a sync return, a sync throw, an async resolve and an async reject all settle
        // the same way. Both reactions are registered, through the captured `then`, on promises made by the captured
        // Promise, and this code never uses the promise a `then` returns. Two lookups of the realm stay reachable all
        // the same (review round 3, C-5): `then` makes the promise it returns through the species constructor, read from
        // `Promise.prototype.constructor[Symbol.species]`, and Promise.resolve of an object reads its `then`, inherited
        // from `Object.prototype` when guest code put one there. In the guest's realm both run guest code, and what it can
        // change is only how the guest's own handlers answer, which guest code decides anyway; the host's realm is the
        // host's.
        // A throw is reported as HANDLER_ERROR: a `code` the handler put on its error is not forwarded (and
        // the caller would clamp it anyway — see refusalFromResponse). The one exception is a library code
        // from a reserved method (handlerErrorCode).
        const started = apply(resolved, PromiseConstructor, [undefined]) as Promise<void>;
        apply(then, started, [() => {
            let value: unknown;
            try {
                value = apply(method, undefined, args);
            } catch (error) {
                failed(error);
                return;
            }
            let settled: Promise<unknown>;
            try {
                settled = apply(resolved, PromiseConstructor, [value]) as Promise<unknown>;
            } catch (error) {
                failed(error); // a thenable whose `then` getter throws
                return;
            }
            apply(then, settled, [succeeded, failed]);
        }]);
    }

    function handleResponse(data: any): void {
        // We only ever mint numeric ids, so a non-number id is stale or forged — ignore it.
        const id = data.id;
        if (typeof id !== 'number') return;
        const entry = takePending(id);
        if (!entry) return; // unknown, stale, or already-settled id
        // An answer past the byte budget (R3-3; the other side's broker never sends one) is not handed over: the whole
        // frame that arrived is measured (C-1), a refusal (ok: false) as much as a result (review round 4, C-1: a refusal
        // was not measured at all), and refused with a text of our own.
        const ok = data.ok;
        const unsupported = { kind: '' };
        if (bytesOf(data, MAX_BYTES, undefined, unsupported) > MAX_BYTES) {
            const holder = ok ? 'the result' : 'the answer';
            entry.reject(codedError(pastBudget(`${holder} holds`, unsupported, `${holder} is larger than the RPC byte budget (${MAX_BYTES})`), CODE.RESULT_NOT_TRANSFERABLE));
            return;
        }
        if (ok) {
            // undefined is represented natively: an absent `value` reads back as undefined, and a
            // handler that returns nothing therefore resolves to undefined — no sentinel needed.
            entry.resolve(data.value);
            return;
        }
        entry.reject(refusalFromResponse(data, entry.reserved));
    }

    function expose(name: string, fn: RpcMethod): void {
        // Sanitize before storing (a bad name or non-callable would only fail later, confusingly). A name longer than
        // MAX_NAME_LENGTH could never be called (C-1): not registered either.
        if (typeof name !== 'string' || name.length > MAX_NAME_LENGTH || typeof fn !== 'function') return;
        // Reserved names belong to the library (exposeReserved): never registered here.
        if (isReservedName(name)) return;
        // Re-exposing a name REPLACES the previous handler (last registration wins): the least
        // surprising choice, it mirrors Map.set and lets a handler be hot-swapped.
        set(registry, name, fn);
    }

    function exposeReserved(name: string, fn: RpcMethod): void {
        if (typeof name !== 'string' || typeof fn !== 'function' || !isReservedName(name)) return;
        set(reservedRegistry, name, fn);
    }

    // One call: `args` is the caller's own list (a rest parameter), read by index.
    function request(timeoutMs: number, method: string, args: unknown[]): Promise<unknown> {
        // Sanitize before applying: a non-string method can never match a registered name, nor can one longer than
        // MAX_NAME_LENGTH (C-1: the receiver would refuse it, and never echoes it).
        if (typeof method !== 'string') return apply(rejected, PromiseConstructor, [localRefusal(CODE.INVALID_CALL, 'RPC method name must be a string')]) as Promise<unknown>;
        if (method.length > MAX_NAME_LENGTH) return apply(rejected, PromiseConstructor, [localRefusal(CODE.INVALID_CALL, `RPC method name must be a string of at most ${MAX_NAME_LENGTH} characters`)]) as Promise<unknown>;

        // Check transferability up front, before recording anything or sending. A value structured clone
        // cannot carry would otherwise throw from postMessage — or, for a call queued before the port
        // exists, only at flush time, where it would take the frames behind it down with it. The frame
        // carries this clone rather than the caller's array: the clone is known to post, it pins the
        // arguments to their call-time values (as postMessage does), and the check has already paid for it.
        let sendableArgs: unknown[];
        try {
            sendableArgs = clone(args);
        } catch (error) {
            return apply(rejected, PromiseConstructor, [localRefusal(CODE.ARGS_NOT_TRANSFERABLE, `RPC arguments are not transferable: ${errorMessage(error)}`)]) as Promise<unknown>;
        }
        // The byte budget (R3-3), measured on the whole frame that will be sent (C-1): past it, nothing is sent.
        const id = ++nextId;
        const frame = requestFrame(id, method, sendableArgs);
        const unsupported = { kind: '' };
        const bytes = bytesOf(frame, MAX_BYTES, undefined, unsupported);
        if (bytes > MAX_BYTES) {
            return apply(rejected, PromiseConstructor, [localRefusal(CODE.ARGS_NOT_TRANSFERABLE, pastBudget('RPC arguments hold', unsupported, `RPC arguments are larger than the RPC byte budget (${MAX_BYTES})`))]) as Promise<unknown>;
        }
        // The per-second budget (M-2), counting only a call that is sent: past it, nothing is sent.
        const overBudget = admitOutbound ? admitOutbound(bytes) : null;
        if (overBudget !== null) return apply(rejected, PromiseConstructor, [budgetRefusal(overBudget)]) as Promise<unknown>;

        return construct(PromiseConstructor, [(resolve: (value: unknown) => void, reject: (error: Error) => void) => {
            const disarm = timeoutMs > 0 ? armTimer(() => {
                const entry = takePending(id);
                if (entry) entry.reject(localRefusal(CODE.TIMEOUT, `RPC timeout after ${timeoutMs}ms: ${method}`));
            }, timeoutMs) : null;
            // Record the pending promise BEFORE sending, so a response can never arrive first.
            set(pending, id, { resolve, reject, disarm, reserved: isReservedName(method) });
            let unsent: unknown;
            try {
                unsent = send(frame);
            } catch (error) {
                // A failed send must leave nothing behind: drop the pending entry and disarm its timer.
                takePending(id);
                reject(localRefusal(CODE.SEND_FAILED, `RPC call could not be sent: ${errorMessage(error)}`));
                return;
            }
            // Not posted: the environment this call was made for is gone (L-2, RpcSend), and nothing else would settle it.
            if (typeof unsent === 'string') {
                takePending(id);
                reject(localRefusal(CODE.TERMINATED, unsent));
            }
        }]) as Promise<unknown>;
    }

    function callWithTimeout(timeoutMs: number, method: string, ...args: unknown[]): Promise<unknown> {
        return request(timeoutMs, method, args);
    }

    function call(method: string, ...args: unknown[]): Promise<unknown> {
        return request(defaultTimeoutMs, method, args);
    }

    function handleMessage(data: unknown, reply?: RpcSend): void {
        // Defensive top-level validation: anything that is not a frame we recognise is ignored, never
        // thrown on. This is the single entry point for every inbound port message.
        if (!data || typeof data !== 'object') return;
        const type = (data as any).type;
        if (typeof type !== 'string') return;
        // An answer goes back on the channel its request arrived on when the caller names one: the host
        // does (see setupChannel), and that is what keeps one frame's answers out of the next frame.
        // Without one it falls back to `send` — the guest has a single port per frame, so they coincide.
        if (type === 'RPC_REQ') return handleRequest(data, reply ?? send);
        if (type === 'RPC_RES') return handleResponse(data);
        // LOG / EXECUTE / INIT_PORT / anything else: not ours.
    }

    function terminationError(message: string): RpcError {
        return localRefusal(CODE.TERMINATED, message);
    }

    // The startup gate's refusal of a request it cannot hold (takeBusyRefusal): BUSY, through the builder, on `send`, the
    // guest's one channel. A malformed request is dropped, as handleRequest drops it.
    function refuseHeld(request: unknown, reason: string): void {
        if (!request || typeof request !== 'object') return;
        const id = (request as { id?: unknown }).id;
        if (!isId(id)) return;
        send(refusalFrame(id, reason, CODE.BUSY));
    }
    if (takeBusyRefusal) takeBusyRefusal(refuseHeld);

    function rejectAllPending(message: string): void {
        // Settle every outstanding call so no promise hangs when the transport goes away (teardown,
        // re-init, terminate). Snapshot the ids first, since takePending mutates the map as we go.
        // Each call gets its own Error, so one caller cannot mutate the reason another one sees.
        const ids: number[] = setPrototype([], null);
        apply(mapForEach, pending, [(_entry: Pending, id: number) => { ids[ids.length] = id; }]);
        for (let i = 0; i < ids.length; i++) {
            const entry = takePending(ids[i]!);
            if (entry) entry.reject(terminationError(message));
        }
    }

    return { expose, exposeReserved, call, callWithTimeout, handleMessage, rejectAllPending, terminationError };
}
