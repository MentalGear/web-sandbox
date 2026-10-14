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
 * Array, Error, String, setTimeout/clearTimeout, structuredClone). A top-level import or constant
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
 * Refusals (backlog B7). Every rejection this broker produces is a plain Error with a string `code`
 * from one closed set (RpcErrorCode), split into two disjoint groups by who can cause them:
 *   - LOCAL codes (TIMEOUT, TERMINATED, ARGS_NOT_TRANSFERABLE, SEND_FAILED, INVALID_CALL) are minted
 *     only by the side whose call is refused, from its own state: its timer, its teardown, its clone
 *     check, its transport, its argument check;
 *   - codes REPORTED BY THE OTHER SIDE (UNKNOWN_METHOD, HANDLER_ERROR, RESULT_NOT_TRANSFERABLE, BUSY) are
 *     the only ones a response can produce: the wire `code` is clamped into this group on receipt.
 * Because the groups are disjoint and the clamp never leaves the second one, nothing the other side
 * sends can make a rejection look like one of the local side's own: a response that claims
 * `code: 'TERMINATED'`, or carries the exact termination text, rejects with code HANDLER_ERROR. For the
 * reported codes the message stays the other side's text verbatim (a handler's throw rejects with its
 * original message) — the code, not the text, is the part a caller can branch on.
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
// and unit-testable.
export type RpcSend = (frame: unknown) => void;

/**
 * Why a call was refused. The set is closed and the strings are wire protocol (pinned by a test).
 * Set only by the side whose call is refused:
 *   TIMEOUT                 the per-call timer fired before an answer arrived (the only code worth retrying)
 *   TERMINATED              the transport went away: the sandbox was reset or terminated (retry only
 *                           after the next 'ready')
 *   ARGS_NOT_TRANSFERABLE   the arguments cannot be structured-cloned; nothing was sent
 *   SEND_FAILED             the transport threw while sending; nothing was left pending
 *   INVALID_CALL            the method name is not a string; nothing was sent
 * Reported by the other side (the message is its text; any other reported value reads as HANDLER_ERROR):
 *   UNKNOWN_METHOD          no method of that name is exposed there
 *   HANDLER_ERROR           the handler threw or rejected
 *   RESULT_NOT_TRANSFERABLE the handler's return value cannot be structured-cloned
 *   BUSY                    the other side already has MAX_INBOUND_IN_FLIGHT of your calls in flight on this
 *                           channel; nothing ran (retryable once earlier calls settle)
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
    // Declared INSIDE the function so it survives stringification into the guest. A call whose
    // handler never answers would otherwise hang forever; 30s is generous for a local same-process
    // port yet still bounds an unresponsive other side.
    const DEFAULT_TIMEOUT_MS = 30000;
    const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const acceptLibraryCodes = options.acceptLibraryCodes === true;
    // Mirrors the exported RESERVED_METHOD_PREFIX (a test keeps them equal): declared here to survive stringification.
    const RESERVED_PREFIX = 'sandbox:';
    // Mirrors the exported MAX_INBOUND_IN_FLIGHT, for the same reason.
    const MAX_IN_FLIGHT = 256;

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

    // The library codes (RpcLibraryCode), closed: what a reserved method may report.
    const LIBRARY_CODES: readonly RpcLibraryCode[] = [
        'FETCH_NOT_ALLOWED', 'FETCH_BUSY', 'FETCH_REDIRECT', 'FETCH_TOO_LARGE', 'FETCH_TIMEOUT', 'FETCH_FAILED',
        'INVALID_PATH', 'INVALID_FILE', 'FILES_QUOTA_EXCEEDED', 'FILES_NOT_ALLOWED', 'FILES_BUSY',
    ];
    const isLibraryCode = (code: unknown): code is RpcLibraryCode => typeof code === 'string' && (LIBRARY_CODES as readonly string[]).includes(code);
    const isReservedName = (name: string) => name.startsWith(RESERVED_PREFIX);

    // Methods WE expose. Using a Map (not a plain object) is the core of the hardening — see handleRequest.
    // Reserved names live in their own map, written only by exposeReserved: see the header.
    const registry = new Map<string, RpcMethod>();
    const reservedRegistry = new Map<string, RpcMethod>();

    // Calls WE initiated, keyed by the id we chose.
    type Pending = {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout> | null;
        reserved: boolean; // a call to a reserved name: the only kind a library code may refuse
    };
    const pending = new Map<number, Pending>();
    let nextId = 0;

    // Inbound calls running now, per reply channel (review B7). Keyed by the channel an answer goes back on: the
    // host passes one per port, so the count belongs to one environment and a channel that is gone takes its
    // count with it once its calls settle. An entry is removed when its count returns to 0.
    const inFlight = new Map<RpcSend, number>();

    // Normalizes anything thrown/rejected into a plain string for the wire. Wrapped in try/catch so a
    // value with a throwing toString can never take the message handler down with it.
    function errorMessage(error: unknown): string {
        try {
            if (error && typeof (error as any).message === 'string') return (error as any).message;
            return String(error);
        } catch {
            return 'unknown error';
        }
    }

    // Mints a refusal with a LOCAL code. Called only from this side's own state (its timer, teardown,
    // clone check, send, argument check) — never with anything taken from an inbound frame. That is what
    // makes a local code trustworthy: the other side has no path into this function. Its parameter type
    // admits only the local codes.
    function localRefusal(code: Exclude<RpcErrorCode, 'UNKNOWN_METHOD' | 'HANDLER_ERROR' | 'RESULT_NOT_TRANSFERABLE' | 'BUSY'>, message: string): RpcError {
        const error = new Error(message) as RpcError;
        error.code = code;
        return error;
    }

    // Turns a failure the other side reported into a rejection. The inbound frame is untrusted, so its
    // `code` is clamped into the codes the other side may report: exactly UNKNOWN_METHOD,
    // RESULT_NOT_TRANSFERABLE or BUSY pass through, and anything else (a local code, an unknown string, a
    // non-string, nothing) becomes HANDLER_ERROR. So a response can never yield a local code. The
    // message is the other side's text verbatim, or a fixed fallback when it sent none. Each field is
    // read once, and `code` is always one of our own constants rather than the inbound value.
    // A library code passes only for a call to a reserved name on a broker created with acceptLibraryCodes
    // (the guest's); it is then the matching string from our own LIBRARY_CODES, never the inbound value.
    function refusalFromResponse(data: any, reserved: boolean): RpcError {
        const reportedError = data.error;
        const reportedCode = data.code;
        const error = new Error(typeof reportedError === 'string' ? reportedError : 'RPC call failed') as RpcError;
        const libraryCode = reserved && acceptLibraryCodes ? LIBRARY_CODES.find(code => code === reportedCode) : undefined;
        error.code = reportedCode === CODE.UNKNOWN_METHOD ? CODE.UNKNOWN_METHOD
            : reportedCode === CODE.RESULT_NOT_TRANSFERABLE ? CODE.RESULT_NOT_TRANSFERABLE
            : reportedCode === CODE.BUSY ? CODE.BUSY
            : libraryCode !== undefined ? libraryCode as unknown as RpcErrorCode
            : CODE.HANDLER_ERROR;
        return error;
    }

    // The code an error thrown by a handler is reported with: a library code only from a reserved method.
    function handlerErrorCode(error: unknown, reserved: boolean): string {
        if (!reserved || !error || typeof error !== 'object') return CODE.HANDLER_ERROR;
        const code = (error as any).code;
        return isLibraryCode(code) ? code : CODE.HANDLER_ERROR;
    }

    // Removes a pending call and disarms its timer, returning it once (or null if already settled).
    // Routing every settle path through here makes a second settle for the same id a no-op, which is
    // what keeps a stale or duplicate response from resolving a later call that reused nothing.
    function takePending(id: number): Pending | null {
        const entry = pending.get(id);
        if (!entry) return null;
        pending.delete(id);
        if (entry.timer !== null) clearTimeout(entry.timer);
        return entry;
    }

    // Answers a request with its handler's result. A value structured clone cannot carry (a function, a
    // DOM node, a Symbol) makes the send throw a DataCloneError; inside the promise callback nothing would
    // catch it, so the caller would sit out its whole timeout. Answer with an error frame instead — a
    // string error always clones — so the caller fails promptly and nothing else is affected.
    function sendResult(respond: RpcSend, id: string | number, value: unknown): void {
        try {
            respond({ type: 'RPC_RES', id, ok: true, value });
        } catch (error) {
            respond({ type: 'RPC_RES', id, ok: false, error: `result is not transferable: ${errorMessage(error)}`, code: CODE.RESULT_NOT_TRANSFERABLE });
        }
    }

    // `respond` is where every answer to this request goes: success, handler error, unknown method and
    // not-transferable alike (see handleMessage for why that is the channel the request arrived on).
    function handleRequest(data: any, respond: RpcSend): void {
        // The inbound request is untrusted (on the host it is attacker-controlled). Validate its shape
        // with guard clauses and drop anything malformed SILENTLY — a message handler must never throw.
        // id may be a string or number, method must be a string, args must be an array.
        const id = data.id;
        if (typeof id !== 'string' && typeof id !== 'number') return;
        if (typeof data.method !== 'string') return;
        if (!Array.isArray(data.args)) return;

        // Lookup is allowlist-only: registry.get(name), NEVER registry[name]. A Map has no prototype
        // chain, so the only names that resolve are ones we explicitly exposed. Names such as
        // "__proto__", "constructor", "prototype", "toString" or "valueOf" are just ordinary (absent)
        // keys here; on a plain object they would instead resolve to inherited functions and let the
        // caller reach or mutate the prototype chain. So unknown and inherited names alike resolve to
        // nothing and invoke nothing.
        const reserved = isReservedName(data.method);
        const method = reserved ? reservedRegistry.get(data.method) : registry.get(data.method);
        if (!method) {
            respond({ type: 'RPC_RES', id, ok: false, error: `unknown method: ${data.method}`, code: CODE.UNKNOWN_METHOD });
            return;
        }

        // At most MAX_IN_FLIGHT calls run at once per channel (review B7): beyond that the call is refused at
        // once, before its method runs, so a flood of calls to a method that never settles holds a bounded amount.
        const running = inFlight.get(respond) ?? 0;
        if (running >= MAX_IN_FLIGHT) {
            respond({ type: 'RPC_RES', id, ok: false, error: `too many calls in flight (${MAX_IN_FLIGHT})`, code: CODE.BUSY });
            return;
        }
        inFlight.set(respond, running + 1);
        const release = () => {
            const left = (inFlight.get(respond) ?? 1) - 1;
            if (left > 0) inFlight.set(respond, left);
            else inFlight.delete(respond);
        };

        // We CALL a pre-registered function reference with the cloned args — we never eval / new Function
        // the method name or the args, and the args arrived as inert structured-clone data, so nothing
        // the other side sends is ever interpreted as code. Funnelling through Promise.resolve().then(...) makes
        // a sync return, a sync throw, an async resolve and an async reject all settle the same way.
        // A throw is reported as HANDLER_ERROR: a `code` the handler put on its error is not forwarded (and
        // the caller would clamp it anyway — see refusalFromResponse). The one exception is a library code
        // from a reserved method (handlerErrorCode).
        Promise.resolve().then(() => method(...data.args)).then(
            value => {
                release();
                sendResult(respond, id, value);
            },
            error => {
                release();
                respond({ type: 'RPC_RES', id, ok: false, error: errorMessage(error), code: handlerErrorCode(error, reserved) });
            },
        );
    }

    function handleResponse(data: any): void {
        // We only ever mint numeric ids, so a non-number id is stale or forged — ignore it.
        const id = data.id;
        if (typeof id !== 'number') return;
        const entry = takePending(id);
        if (!entry) return; // unknown, stale, or already-settled id
        if (data.ok) {
            // undefined is represented natively: an absent `value` reads back as undefined, and a
            // handler that returns nothing therefore resolves to undefined — no sentinel needed.
            entry.resolve(data.value);
            return;
        }
        entry.reject(refusalFromResponse(data, entry.reserved));
    }

    function expose(name: string, fn: RpcMethod): void {
        // Sanitize before storing (a bad name or non-callable would only fail later, confusingly).
        if (typeof name !== 'string' || typeof fn !== 'function') return;
        // Reserved names belong to the library (exposeReserved): never registered here.
        if (isReservedName(name)) return;
        // Re-exposing a name REPLACES the previous handler (last registration wins): the least
        // surprising choice, it mirrors Map.set and lets a handler be hot-swapped.
        registry.set(name, fn);
    }

    function exposeReserved(name: string, fn: RpcMethod): void {
        if (typeof name !== 'string' || typeof fn !== 'function' || !isReservedName(name)) return;
        reservedRegistry.set(name, fn);
    }

    function callWithTimeout(timeoutMs: number, method: string, ...args: unknown[]): Promise<unknown> {
        // Sanitize before applying: a non-string method can never match a registered name.
        if (typeof method !== 'string') return Promise.reject(localRefusal(CODE.INVALID_CALL, 'RPC method name must be a string'));

        // Check transferability up front, before recording anything or sending. A value structured clone
        // cannot carry would otherwise throw from postMessage — or, for a call queued before the port
        // exists, only at flush time, where it would take the frames behind it down with it. The frame
        // carries this clone rather than the caller's array: the clone is known to post, it pins the
        // arguments to their call-time values (as postMessage does), and the check has already paid for it.
        let sendableArgs: unknown[];
        try {
            sendableArgs = structuredClone(args);
        } catch (error) {
            return Promise.reject(localRefusal(CODE.ARGS_NOT_TRANSFERABLE, `RPC arguments are not transferable: ${errorMessage(error)}`));
        }

        const id = ++nextId;
        return new Promise<unknown>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    const entry = takePending(id);
                    if (entry) entry.reject(localRefusal(CODE.TIMEOUT, `RPC timeout after ${timeoutMs}ms: ${method}`));
                }, timeoutMs);
            }
            // Record the pending promise BEFORE sending, so a response can never arrive first.
            pending.set(id, { resolve, reject, timer, reserved: isReservedName(method) });
            try {
                send({ type: 'RPC_REQ', id, method, args: sendableArgs });
            } catch (error) {
                // A failed send must leave nothing behind: drop the pending entry and disarm its timer.
                takePending(id);
                reject(localRefusal(CODE.SEND_FAILED, `RPC call could not be sent: ${errorMessage(error)}`));
            }
        });
    }

    function call(method: string, ...args: unknown[]): Promise<unknown> {
        return callWithTimeout(defaultTimeoutMs, method, ...args);
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

    function rejectAllPending(message: string): void {
        // Settle every outstanding call so no promise hangs when the transport goes away (teardown,
        // re-init, terminate). Snapshot the ids first, since takePending mutates the map as we go.
        // Each call gets its own Error, so one caller cannot mutate the reason another one sees.
        const ids = [...pending.keys()];
        for (const id of ids) {
            const entry = takePending(id);
            if (entry) entry.reject(terminationError(message));
        }
    }

    return { expose, exposeReserved, call, callWithTimeout, handleMessage, rejectAllPending, terminationError };
}
