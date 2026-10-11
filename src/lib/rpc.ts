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
 *   `code` rides only on a failure and names what failed on the responding side (an RpcPeerCode).
 *   Both sides run this same function, so the two ends of the wire cannot disagree on its meaning.
 *
 * Refusals (backlog B7). Every rejection this broker produces is a plain Error with a string `code`
 * from a closed set (RpcErrorCode). The codes split by who can cause them:
 *   - LOCAL codes (TIMEOUT, TERMINATED, NOT_TRANSFERABLE, SEND_FAILED, INVALID_CALL) are minted only
 *     by the side whose call is refused, from its own state: its timer, its teardown, its clone check,
 *     its transport, its argument check;
 *   - PEER_ERROR is the only code a response from the other side can produce. Its `peerCode` says
 *     what the other side reported, clamped to RpcPeerCode.
 * So nothing the other side sends can make a rejection look like one of the local side's own: a
 * response that claims `code: 'TERMINATED'`, or carries the exact termination text, still rejects
 * with code PEER_ERROR. The message stays the other side's text verbatim (a handler's throw rejects
 * with its original message) — the code, not the text, is the part a caller can branch on.
 * `code` is a plain own property rather than an Error subclass: a subclass would be a module-scope
 * class this function cannot close over (see above), and a property reads the same in every realm.
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
 *   TIMEOUT          the per-call timer fired before an answer arrived (the only code worth retrying)
 *   TERMINATED       the transport went away: the sandbox was reset or terminated (retry only after
 *                    the next 'ready')
 *   NOT_TRANSFERABLE the arguments cannot be structured-cloned; nothing was sent
 *   SEND_FAILED      the transport threw while sending; nothing was left pending
 *   INVALID_CALL     the method name is not a string; nothing was sent
 *   PEER_ERROR       the other side answered with a failure; see `peerCode`
 */
export type RpcErrorCode = 'TIMEOUT' | 'TERMINATED' | 'NOT_TRANSFERABLE' | 'SEND_FAILED' | 'INVALID_CALL' | 'PEER_ERROR';

/**
 * What the other side reported, on a PEER_ERROR. Clamped on receipt: any other value, or none, reads
 * as HANDLER_ERROR.
 *   UNKNOWN_METHOD          no method of that name is exposed there
 *   HANDLER_ERROR           the handler threw or rejected (the message is its text)
 *   RESULT_NOT_TRANSFERABLE the handler's return value cannot be structured-cloned
 */
export type RpcPeerCode = 'UNKNOWN_METHOD' | 'HANDLER_ERROR' | 'RESULT_NOT_TRANSFERABLE';

/** The shape of every rejection from call()/callWithTimeout(): a plain Error with these own properties. */
export interface RpcError extends Error {
    code: RpcErrorCode;
    /** Present only when code is 'PEER_ERROR'. */
    peerCode?: RpcPeerCode;
}

export interface BrokerOptions {
    // Default per-call timeout in ms; 0 disables timeouts entirely. Override per call via callWithTimeout.
    timeoutMs?: number;
}

export interface Broker {
    /** Publishes one of YOUR methods under `name` for the other side to call. Last registration wins. */
    expose(name: string, fn: RpcMethod): void;
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
    // port yet still bounds a wedged peer.
    const DEFAULT_TIMEOUT_MS = 30000;
    const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // The one source of truth for the code strings (see RpcErrorCode / RpcPeerCode for meanings). Inside
    // the function for the same reason as everything else; the type makes it exhaustive and exact.
    const CODE: { readonly [K in RpcErrorCode | RpcPeerCode]: K } = {
        TIMEOUT: 'TIMEOUT',
        TERMINATED: 'TERMINATED',
        NOT_TRANSFERABLE: 'NOT_TRANSFERABLE',
        SEND_FAILED: 'SEND_FAILED',
        INVALID_CALL: 'INVALID_CALL',
        PEER_ERROR: 'PEER_ERROR',
        UNKNOWN_METHOD: 'UNKNOWN_METHOD',
        HANDLER_ERROR: 'HANDLER_ERROR',
        RESULT_NOT_TRANSFERABLE: 'RESULT_NOT_TRANSFERABLE',
    };

    // Methods WE expose. Using a Map (not a plain object) is the core of the hardening — see handleRequest.
    const registry = new Map<string, RpcMethod>();

    // Calls WE initiated, keyed by the id we chose.
    type Pending = {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout> | null;
    };
    const pending = new Map<number, Pending>();
    let nextId = 0;

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
    // makes a local code trustworthy: the other side has no path into this function.
    function localRefusal(code: Exclude<RpcErrorCode, 'PEER_ERROR'>, message: string): RpcError {
        const error = new Error(message) as RpcError;
        error.code = code;
        return error;
    }

    // Turns a failure the other side reported into a rejection. The inbound frame is untrusted, so its
    // `code` is never copied into `code`: the rejection is always PEER_ERROR, and the reported reason is
    // clamped into `peerCode` — one of the three names the responder sends, or HANDLER_ERROR for
    // anything else (a local code, an unknown string, a non-string, nothing). The message is the other
    // side's text verbatim, or a fixed fallback when it sent none. Each field is read once, and peerCode is
    // always one of our own constants rather than the inbound value.
    function peerRefusal(data: any): RpcError {
        const reportedError = data.error;
        const reportedCode = data.code;
        const error = new Error(typeof reportedError === 'string' ? reportedError : 'RPC call failed') as RpcError;
        error.code = CODE.PEER_ERROR;
        error.peerCode = reportedCode === CODE.UNKNOWN_METHOD ? CODE.UNKNOWN_METHOD
            : reportedCode === CODE.RESULT_NOT_TRANSFERABLE ? CODE.RESULT_NOT_TRANSFERABLE
            : CODE.HANDLER_ERROR;
        return error;
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
        const method = registry.get(data.method);
        if (!method) {
            respond({ type: 'RPC_RES', id, ok: false, error: `unknown method: ${data.method}`, code: CODE.UNKNOWN_METHOD });
            return;
        }

        // We CALL a pre-registered function reference with the cloned args — we never eval / new Function
        // the method name or the args, and the args arrived as inert structured-clone data, so nothing
        // the peer sends is ever interpreted as code. Funnelling through Promise.resolve().then(...) makes
        // a sync return, a sync throw, an async resolve and an async reject all settle the same way.
        // A throw is always reported as HANDLER_ERROR: a `code` the handler put on its error is not
        // forwarded (and the caller would clamp it anyway — see peerRefusal).
        Promise.resolve().then(() => method(...data.args)).then(
            value => sendResult(respond, id, value),
            error => respond({ type: 'RPC_RES', id, ok: false, error: errorMessage(error), code: CODE.HANDLER_ERROR }),
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
        entry.reject(peerRefusal(data));
    }

    function expose(name: string, fn: RpcMethod): void {
        // Sanitize before storing (a bad name or non-callable would only fail later, confusingly).
        if (typeof name !== 'string' || typeof fn !== 'function') return;
        // Re-exposing a name REPLACES the previous handler (last registration wins): the least
        // surprising choice, it mirrors Map.set and lets a handler be hot-swapped.
        registry.set(name, fn);
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
            return Promise.reject(localRefusal(CODE.NOT_TRANSFERABLE, `RPC arguments are not transferable: ${errorMessage(error)}`));
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
            pending.set(id, { resolve, reject, timer });
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

    return { expose, call, callWithTimeout, handleMessage, rejectAllPending, terminationError };
}
