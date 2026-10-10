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
 *   Response: { type: 'RPC_RES', id, ok, value?, error? }
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

export interface BrokerOptions {
    // Default per-call timeout in ms; 0 disables timeouts entirely. Override per call via callWithTimeout.
    timeoutMs?: number;
}

export interface Broker {
    /** Publishes one of YOUR methods under `name` for the other side to call. Last registration wins. */
    expose(name: string, fn: RpcMethod): void;
    /** Invokes a method the OTHER side exposed; resolves/rejects with its result. Uses the default timeout. */
    call(method: string, ...args: unknown[]): Promise<unknown>;
    /** Like call(), but with an explicit timeout in ms for this one call (0 disables it). */
    callWithTimeout(timeoutMs: number, method: string, ...args: unknown[]): Promise<unknown>;
    /**
     * Feed every inbound port frame here; non-RPC and malformed frames are ignored, never thrown on.
     * Answers to an inbound request go to `reply` — the channel it arrived on — or to `send` without one.
     */
    handleMessage(data: unknown, reply?: RpcSend): void;
    /** Rejects every in-flight call (used by the host on teardown so no promise hangs). */
    rejectAllPending(reason: Error): void;
}

export function createBroker(send: RpcSend, options: BrokerOptions = {}): Broker {
    // Declared INSIDE the function so it survives stringification into the guest. A call whose
    // handler never answers would otherwise hang forever; 30s is generous for a local same-process
    // port yet still bounds a wedged peer.
    const DEFAULT_TIMEOUT_MS = 30000;
    const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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
            respond({ type: 'RPC_RES', id, ok: false, error: `result is not transferable: ${errorMessage(error)}` });
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
            respond({ type: 'RPC_RES', id, ok: false, error: `unknown method: ${data.method}` });
            return;
        }

        // We CALL a pre-registered function reference with the cloned args — we never eval / new Function
        // the method name or the args, and the args arrived as inert structured-clone data, so nothing
        // the peer sends is ever interpreted as code. Funnelling through Promise.resolve().then(...) makes
        // a sync return, a sync throw, an async resolve and an async reject all settle the same way.
        Promise.resolve().then(() => method(...data.args)).then(
            value => sendResult(respond, id, value),
            error => respond({ type: 'RPC_RES', id, ok: false, error: errorMessage(error) }),
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
        entry.reject(new Error(typeof data.error === 'string' ? data.error : 'RPC call failed'));
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
        if (typeof method !== 'string') return Promise.reject(new Error('RPC method name must be a string'));

        // Check transferability up front, before recording anything or sending. A value structured clone
        // cannot carry would otherwise throw from postMessage — or, for a call queued before the port
        // exists, only at flush time, where it would take the frames behind it down with it. The frame
        // carries this clone rather than the caller's array: the clone is known to post, it pins the
        // arguments to their call-time values (as postMessage does), and the check has already paid for it.
        let sendableArgs: unknown[];
        try {
            sendableArgs = structuredClone(args);
        } catch (error) {
            return Promise.reject(new Error(`RPC arguments are not transferable: ${errorMessage(error)}`));
        }

        const id = ++nextId;
        return new Promise<unknown>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    const entry = takePending(id);
                    if (entry) entry.reject(new Error(`RPC timeout after ${timeoutMs}ms: ${method}`));
                }, timeoutMs);
            }
            // Record the pending promise BEFORE sending, so a response can never arrive first.
            pending.set(id, { resolve, reject, timer });
            try {
                send({ type: 'RPC_REQ', id, method, args: sendableArgs });
            } catch (error) {
                // A failed send must leave nothing behind: drop the pending entry and disarm its timer.
                takePending(id);
                reject(new Error(`RPC call could not be sent: ${errorMessage(error)}`));
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

    function rejectAllPending(reason: Error): void {
        // Settle every outstanding call so no promise hangs when the transport goes away (teardown,
        // re-init, terminate). Snapshot the ids first, since takePending mutates the map as we go.
        const ids = [...pending.keys()];
        for (const id of ids) {
            const entry = takePending(id);
            if (entry) entry.reject(reason);
        }
    }

    return { expose, call, callWithTimeout, handleMessage, rejectAllPending };
}
