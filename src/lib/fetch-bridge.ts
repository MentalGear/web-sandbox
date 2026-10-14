/**
 * The host-mediated fetch bridge (backlog B5, ADR-006), host side.
 *
 * With `fetchBridge` configured, the guest gets `sandboxFetch(url, init)` (in-sandbox-script.ts), which asks
 * the host to make the request: the guest's policy is unchanged (connect-src stays what the embedder set,
 * 'none' by default), and every request the host makes for the guest is decided and logged here.
 *
 * Bridge discipline: the bridge grants no more than a direct guest request would. A fetch from the host
 * page runs with the host page's authority, so every request it makes for the guest is pinned to:
 *   - credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', mode: 'cors';
 *   - redirect: 'manual' — a redirect is never followed; the opaque redirect it yields is refused with
 *     FETCH_REDIRECT (the same no-follow guarantee as 'error', but told apart from a network failure);
 *   - an exact-origin allowlist (scheme, host and port; no source expressions). That alone refuses the host
 *     page's own origin and every loopback, private and link-local host unless it is listed; those are
 *     checked again by name (isPrivateHost) so the refusal says why, and so the check survives any future
 *     widening of the allowlist. A page cannot see DNS answers: a listed public name that resolves to a
 *     private address (DNS rebinding) is a limit, not a guarantee;
 *   - methods and request headers from allowlists (no Cookie ever; Authorization only when listed);
 *   - a body cap read incrementally (Content-Length is checked first, never trusted), a per-call timeout
 *     and an AbortController that teardown also fires; whole responses only, no streaming;
 *   - a cap on concurrent requests, so the host's memory is bounded by maxConcurrent × maxBytes.
 * The request is made from the host page, so the target sees the host page's origin in `Origin` (never its
 * URL: no Referer) and the response must pass CORS for that origin.
 *
 * Every request is reported once, when it settles, as a FetchRecord (the host's 'fetch' event): refused
 * attempts included. Fields that come from the guest are validated or clamped before they are reported.
 *
 * Host-side only, never stringified into the guest, so it may use module scope freely.
 */
import type { RpcLibraryCode } from './rpc';

/** The method name the bridge is exposed under: reserved, so no exposed method can collide with it. */
export const FETCH_METHOD = 'sandbox:fetch';

/**
 * Why sandboxFetch() rejected (the rejection's `code`). Minted only by this module, on the host:
 *   FETCH_NOT_ALLOWED  refused before any request: the URL, origin, method, a header or the body
 *   FETCH_BUSY         refused before any request: maxConcurrent requests are already in flight (retryable)
 *   FETCH_REDIRECT     the response was a redirect, which is never followed
 *   FETCH_TOO_LARGE    the request body or the response body exceeds maxBytes
 *   FETCH_TIMEOUT      no whole response within timeoutMs (retryable)
 *   FETCH_FAILED       the request failed: network error, CORS, or the sandbox was torn down (retryable)
 */
export type FetchErrorCode = RpcLibraryCode;

export const FETCH_ERROR_CODES: readonly FetchErrorCode[] = ['FETCH_NOT_ALLOWED', 'FETCH_BUSY', 'FETCH_REDIRECT', 'FETCH_TOO_LARGE', 'FETCH_TIMEOUT', 'FETCH_FAILED'];

/** What an embedder configures as `fetchBridge`. Only `allow` is required. */
export interface FetchBridgeConfig {
    /** Exact origins the guest may reach, like 'https://api.example' or 'http://localhost:8080'. */
    allow: string[];
    /** Most bytes of one response body (and one request body). Default 1 MiB, at most 32 MiB. */
    maxBytes?: number;
    /** Most ms for one request, response body included. Default 10 000, at most 120 000. */
    timeoutMs?: number;
    /** Methods the guest may use. Default GET, HEAD and POST; PUT, PATCH and DELETE can be added. */
    methods?: string[];
    /** Request headers the guest may set beyond the safe set (accept, accept-language, content-language, content-type). */
    headers?: string[];
    /** Most requests in flight at once. Default 4, at most 16. */
    maxConcurrent?: number;
}

/** A validated FetchBridgeConfig: every field present and in range. */
export interface FetchPolicy {
    allow: readonly string[];
    maxBytes: number;
    timeoutMs: number;
    methods: readonly string[];
    headers: readonly string[];
    maxConcurrent: number;
}

/** The detail of a 'fetch' event: one request through the bridge, reported once when it settled. */
export interface FetchRecord {
    /** The method, upper case ('' when the guest sent no valid one). */
    method: string;
    /** The URL without its fragment, or the guest's string clamped to 2048 characters when it is not a URL. */
    url: string;
    /**
     * ok        a response was handed to the guest (any HTTP status)
     * refused   no request was made: the bridge's policy or the Request constructor refused it (code says why)
     * failed    fetch() was called and no response was handed over (code says why). Not proof that a request
     *           left the page: the browser's fetch rejects some requests before sending them (the host page's
     *           own connect-src, mixed content, local-network blocking), and a page cannot tell those apart
     * aborted   the sandbox was reset, terminated or removed while the request was in flight
     */
    outcome: 'ok' | 'refused' | 'failed' | 'aborted';
    /** The HTTP status, when a response arrived. */
    status?: number;
    /** Why the request was refused, failed or aborted; absent when outcome is 'ok'. */
    code?: FetchErrorCode;
    /** Response body bytes read. */
    bytes: number;
    durationMs: number;
}

/** What the guest receives for a whole response; its sandboxFetch() turns it into a Response. */
export interface FetchResult {
    url: string;
    status: number;
    statusText: string;
    headers: [string, string][];
    body: Uint8Array;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 120000;
const DEFAULT_MAX_CONCURRENT = 4;
const MAX_MAX_CONCURRENT = 16;
const DEFAULT_METHODS = ['GET', 'HEAD', 'POST'];
const ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const SAFE_HEADERS = ['accept', 'accept-language', 'content-language', 'content-type'];
// Names an embedder cannot add: the browser forbids them in fetch, or they carry host-page authority.
const FORBIDDEN_HEADER = /^(accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie|cookie2|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/;
const MAX_HEADERS = 64;
const MAX_HEADER_VALUE = 8192;
const MAX_REPORTED_URL = 2048;
const MAX_URL = 8192;
const NULL_BODY_STATUSES = [101, 103, 204, 205, 304];

/** An Error with a library code, the only kind of refusal this module produces. */
export function fetchRefusal(code: FetchErrorCode, message: string): Error & { code: FetchErrorCode } {
    const error = new Error(`[sandboxFetch] ${code}: ${message}`) as Error & { code: FetchErrorCode };
    error.code = code;
    return error;
}

const boundedInteger = (value: unknown, fallback: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback;
    return Math.min(Math.floor(value), max);
};

/**
 * One allowlist entry as an exact origin, or null: an http(s) URL with nothing but scheme, host and port
 * (a trailing '/' is fine). Paths, queries, fragments, credentials and wildcards are refused, so an entry
 * can only ever mean one origin.
 */
export function toAllowedOrigin(entry: unknown): string | null {
    if (typeof entry !== 'string') return null;
    let url: URL;
    try {
        url = new URL(entry);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (entry.includes('*')) return null;
    return url.origin;
}

/**
 * Validates a `fetchBridge` config into a policy, or returns null when there is none to apply (not an
 * object). Entries that cannot be used are dropped and reported through `warn`; an empty allowlist is a
 * valid policy that refuses everything.
 */
export function toFetchPolicy(config: unknown, warn: (message: string) => void): FetchPolicy | null {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
    const source = config as Record<string, unknown>;

    const allow = new Set<string>();
    for (const entry of Array.isArray(source.allow) ? source.allow : []) {
        const origin = toAllowedOrigin(entry);
        if (origin === null) {
            warn(`[Sandbox] fetchBridge.allow entry ${JSON.stringify(entry)} was dropped: list exact origins like "https://api.example" (scheme, host, optional port).`);
            continue;
        }
        allow.add(origin);
    }

    const methods = new Set<string>();
    for (const entry of Array.isArray(source.methods) ? source.methods : DEFAULT_METHODS) {
        const method = typeof entry === 'string' ? entry.toUpperCase() : '';
        if (!ALLOWED_METHODS.includes(method)) {
            warn(`[Sandbox] fetchBridge.methods entry ${JSON.stringify(entry)} was dropped: one of ${ALLOWED_METHODS.join(', ')}.`);
            continue;
        }
        methods.add(method);
    }

    const headers = new Set<string>(SAFE_HEADERS);
    for (const entry of Array.isArray(source.headers) ? source.headers : []) {
        const name = typeof entry === 'string' ? entry.toLowerCase() : '';
        if (!HEADER_NAME.test(name) || FORBIDDEN_HEADER.test(name)) {
            warn(`[Sandbox] fetchBridge.headers entry ${JSON.stringify(entry)} was dropped: not a header name the guest may set.`);
            continue;
        }
        headers.add(name);
    }

    return Object.freeze({
        allow: Object.freeze([...allow]),
        maxBytes: boundedInteger(source.maxBytes, DEFAULT_MAX_BYTES, MAX_MAX_BYTES),
        timeoutMs: boundedInteger(source.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
        methods: Object.freeze([...methods]),
        headers: Object.freeze([...headers]),
        maxConcurrent: boundedInteger(source.maxConcurrent, DEFAULT_MAX_CONCURRENT, MAX_MAX_CONCURRENT),
    });
}

const ipv4Octets = (host: string): number[] | null => {
    const parts = host.split('.');
    if (parts.length !== 4) return null;
    const octets: number[] = [];
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const octet = Number(part);
        if (octet > 255) return null;
        octets.push(octet);
    }
    return octets;
};

const isPrivateIPv4 = ([a, b]: number[]): boolean => {
    if (a === undefined || b === undefined) return false;
    return a === 0 || a === 10 || a === 127                 // this network, private, loopback
        || (a === 100 && b >= 64 && b <= 127)                 // shared address space (CGNAT)
        || (a === 169 && b === 254)                           // link-local
        || (a === 172 && b >= 16 && b <= 31)                  // private
        || (a === 192 && b === 168)                           // private
        || (a === 198 && (b === 18 || b === 19))              // benchmarking
        || a >= 224;                                          // multicast, reserved, broadcast
};

// The hextets of a canonical IPv6 literal as the URL parser writes it (lower case, '::' compressed, no
// dotted tail), or null.
const ipv6Hextets = (host: string): number[] | null => {
    if (!/^[0-9a-f:]+$/.test(host)) return null;
    const halves = host.split('::');
    if (halves.length > 2) return null;
    const parse = (half: string | undefined) => (half ? half.split(':').map(h => parseInt(h, 16)) : []);
    const head = parse(halves[0]);
    const tail = parse(halves[1]);
    const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
    const hextets = [...head, ...new Array(fill).fill(0), ...tail];
    return hextets.length === 8 && hextets.every(h => Number.isInteger(h) && h >= 0 && h <= 0xffff) ? hextets : null;
};

const isPrivateIPv6 = (hextets: number[]): boolean => {
    const [first = 0] = hextets;
    const allZeroBefore = (index: number) => hextets.slice(0, index).every(h => h === 0);
    if (allZeroBefore(8)) return true;                                   // ::
    if (allZeroBefore(7) && hextets[7] === 1) return true;               // ::1
    if (allZeroBefore(5) && hextets[5] === 0xffff) {                     // ::ffff:a.b.c.d (IPv4-mapped)
        return isPrivateIPv4([(hextets[6]! >> 8) & 255, hextets[6]! & 255]);
    }
    return (first & 0xfe00) === 0xfc00                                   // fc00::/7 unique local
        || (first & 0xffc0) === 0xfe80                                   // fe80::/10 link-local
        || (first & 0xff00) === 0xff00;                                  // ff00::/8 multicast
};

/**
 * Whether a URL's hostname (as `new URL()` writes it, so already canonical: IPv4 in dotted decimal, IPv6
 * in brackets) names this machine or a private, link-local or otherwise non-public address: localhost and
 * *.localhost, and IPv4/IPv6 literals in those ranges. A name that only RESOLVES to such an address cannot
 * be recognised here (DNS rebinding): the page never sees DNS answers.
 */
export function isPrivateHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host.startsWith('[') && host.endsWith(']')) {
        const hextets = ipv6Hextets(host.slice(1, -1));
        return hextets === null ? true : isPrivateIPv6(hextets); // an IPv6 literal we cannot read is refused
    }
    const octets = ipv4Octets(host);
    return octets !== null && isPrivateIPv4(octets);
}

/** A request the bridge will make: every field validated. */
export interface ValidRequest {
    url: URL;
    method: string;
    headers: [string, string][];
    body: string | Uint8Array | undefined;
}

const reportedUrl = (value: unknown): string => {
    if (typeof value !== 'string') return '';
    try {
        const url = new URL(value);
        url.hash = '';
        return url.href.slice(0, MAX_REPORTED_URL);
    } catch {
        return value.slice(0, MAX_REPORTED_URL);
    }
};

const reportedMethod = (value: unknown): string =>
    typeof value === 'string' && /^[A-Za-z]{1,16}$/.test(value) ? value.toUpperCase() : '';

const toBody = (value: unknown): string | Uint8Array | undefined | null => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
};

const toHeaders = (value: unknown, allowed: readonly string[]): [string, string][] | string => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_HEADERS) return 'headers must be at most 64 [name, value] pairs';
    const headers: [string, string][] = [];
    for (const pair of value) {
        if (!Array.isArray(pair) || pair.length !== 2) return 'headers must be [name, value] pairs';
        const [name, headerValue] = pair;
        if (typeof name !== 'string' || typeof headerValue !== 'string') return 'header names and values must be strings';
        const lower = name.toLowerCase();
        if (!allowed.includes(lower)) return `header "${lower.slice(0, 64)}" is not allowed`;
        // The value's size is policy; its syntax (a ByteString without NUL, CR or LF) is the platform's, checked
        // by the Request the bridge builds before it records anything (createFetchBridge, review B6).
        if (headerValue.length > MAX_HEADER_VALUE) return `header "${lower}" has a value longer than ${MAX_HEADER_VALUE} characters`;
        headers.push([lower, headerValue]);
    }
    return headers;
};

/**
 * Checks one request from the guest against the policy. Returns the request to make, or a refusal (no
 * request is made then). `hostOrigin` is the host page's origin, refused unless listed. Only `url`,
 * `method`, `headers` and `body` are read from the guest's object.
 */
export function validateRequest(request: unknown, policy: FetchPolicy, hostOrigin: string): ValidRequest | Error & { code: FetchErrorCode } {
    if (!request || typeof request !== 'object') return fetchRefusal('FETCH_NOT_ALLOWED', 'not a request');
    const source = request as Record<string, unknown>;

    const rawUrl = source.url;
    if (typeof rawUrl !== 'string' || rawUrl.length > MAX_URL) return fetchRefusal('FETCH_NOT_ALLOWED', 'the URL must be an absolute URL string');
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return fetchRefusal('FETCH_NOT_ALLOWED', 'the URL must be absolute (the guest has no base URL)');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return fetchRefusal('FETCH_NOT_ALLOWED', `${url.protocol} URLs are not fetched`);
    if (url.username || url.password) return fetchRefusal('FETCH_NOT_ALLOWED', 'URLs with credentials are not fetched');
    url.hash = '';

    if (!policy.allow.includes(url.origin)) {
        if (url.origin === hostOrigin) return fetchRefusal('FETCH_NOT_ALLOWED', "the host page's own origin is not in fetchBridge.allow");
        if (isPrivateHost(url.hostname)) return fetchRefusal('FETCH_NOT_ALLOWED', `${url.origin} is a loopback, private or link-local host and not in fetchBridge.allow`);
        return fetchRefusal('FETCH_NOT_ALLOWED', `${url.origin} is not in fetchBridge.allow`);
    }

    const method = source.method === undefined ? 'GET' : reportedMethod(source.method);
    if (!policy.methods.includes(method)) return fetchRefusal('FETCH_NOT_ALLOWED', `method ${method || '(invalid)'} is not allowed`);

    const headers = toHeaders(source.headers, policy.headers);
    if (typeof headers === 'string') return fetchRefusal('FETCH_NOT_ALLOWED', headers);

    const body = toBody(source.body);
    if (body === null) return fetchRefusal('FETCH_NOT_ALLOWED', 'the body must be a string, an ArrayBuffer or a typed array');
    if (body !== undefined && (method === 'GET' || method === 'HEAD')) return fetchRefusal('FETCH_NOT_ALLOWED', `a ${method} request has no body`);
    const bodyBytes = typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body?.byteLength ?? 0;
    if (bodyBytes > policy.maxBytes) return fetchRefusal('FETCH_TOO_LARGE', `the request body exceeds ${policy.maxBytes} bytes`);

    return { url, method, headers, body };
}

/** Reads a response body chunk by chunk, stopping as soon as it exceeds maxBytes. */
async function readBody(response: Response, maxBytes: number, onBytes: (total: number) => void): Promise<Uint8Array> {
    const declared = response.headers.get('content-length');
    if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw fetchRefusal('FETCH_TOO_LARGE', `the response declares ${declared} bytes, more than ${maxBytes}`);
    }
    if (!response.body) return new Uint8Array(0);

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        onBytes(total);
        // Content-Length is never trusted: the cap is enforced on what actually arrives.
        if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw fetchRefusal('FETCH_TOO_LARGE', `the response body exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}

export interface FetchBridgeOptions {
    policy: FetchPolicy;
    hostOrigin: string;
    /** Called once per request, when it settles (the host dispatches the 'fetch' event). */
    onRecord: (record: FetchRecord) => void;
    /** The fetch to use; the page's by default. */
    fetchImpl?: typeof fetch;
    now?: () => number;
}

export interface FetchBridge {
    /** Handles one sandboxFetch() request from the guest: resolves with the whole response or rejects with a library code. */
    handle(request: unknown): Promise<FetchResult>;
    /** Aborts every request in flight (teardown): each is reported as 'aborted'. Later requests are refused. */
    abortAll(): void;
}

const TEARDOWN = 'teardown';
const TIMEOUT = 'timeout';

/** One bridge per environment: its requests end with the environment (abortAll). */
export function createFetchBridge({ policy, hostOrigin, onRecord, fetchImpl, now = () => performance.now() }: FetchBridgeOptions): FetchBridge {
    const inFlight = new Set<AbortController>();
    let closed = false;

    const record = (base: { method: string; url: string; started: number }, outcome: FetchRecord['outcome'], details: Partial<FetchRecord>) => {
        onRecord(Object.freeze({ method: base.method, url: base.url, outcome, bytes: 0, durationMs: Math.max(0, now() - base.started), ...details }));
    };

    const handle = async (request: unknown): Promise<FetchResult> => {
        const source = request && typeof request === 'object' ? request as Record<string, unknown> : {};
        const base = { method: reportedMethod(source.method ?? 'GET'), url: reportedUrl(source.url), started: now() };

        const refuse = (error: Error & { code: FetchErrorCode }): never => {
            record(base, 'refused', { code: error.code });
            throw error;
        };
        if (closed) refuse(fetchRefusal('FETCH_FAILED', 'the sandbox was torn down'));
        const valid = validateRequest(request, policy, hostOrigin);
        if (valid instanceof Error) return refuse(valid);
        if (inFlight.size >= policy.maxConcurrent) refuse(fetchRefusal('FETCH_BUSY', `${policy.maxConcurrent} requests are already in flight`));

        // The platform validates the request before anything is recorded as made (review B6, follow-up audit
        // 2026-10-14): the Request constructor applies the Fetch standard's own checks (a header value is a
        // ByteString without NUL, CR or LF; the body is a BufferSource or a string; the method and mode agree),
        // so nothing it refuses can reach fetch() and be reported as 'failed'. What it throws is a refusal; no
        // request exists then. validateRequest() keeps only what is policy: the origin allowlist, private hosts,
        // methods, header names, sizes. fetch() is given that Request and the same init, so what was checked is
        // what is sent.
        const controller = new AbortController();
        const init: RequestInit = {
            method: valid.method,
            headers: valid.headers,
            body: valid.body as BodyInit | undefined,
            signal: controller.signal,
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            redirect: 'manual',
            mode: 'cors',
            cache: 'no-store',
            keepalive: false,
        };
        let outgoing: Request;
        try {
            outgoing = new Request(valid.url.href, init);
        } catch (error) {
            return refuse(fetchRefusal('FETCH_NOT_ALLOWED', `the browser refused the request (${error instanceof Error ? error.name : 'error'})`));
        }
        inFlight.add(controller);
        const timer = setTimeout(() => controller.abort(TIMEOUT), policy.timeoutMs);
        let bytes = 0;
        let status: number | undefined;
        try {
            // The init goes to fetch() again, whole. Not the Request alone: measured in WebKit, an abort that reaches
            // the fetch only through the Request's own (following) signal no longer stops a response whose headers
            // arrived, so neither the timeout nor a teardown closed the upstream connection
            // (test/e2e/fetch-bridge.spec.ts); with the init, the fetch's signal follows the controller directly. And
            // not a partial init: any init makes the Request constructor reset the referrer policy (Fetch, new
            // Request(input, init)), and a Referer came back (measured on all three engines).
            const response = await (fetchImpl ?? globalThis.fetch)(outgoing, init);
            if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400 && response.headers.has('location'))) {
                await response.body?.cancel().catch(() => {});
                throw fetchRefusal('FETCH_REDIRECT', 'the response was a redirect, which the bridge never follows');
            }
            status = response.status;
            const body = await readBody(response, policy.maxBytes, (total) => { bytes = total; });
            const headers: [string, string][] = [];
            response.headers.forEach((value, name) => headers.push([name, value]));
            record(base, 'ok', { status, bytes });
            return {
                url: valid.url.href,
                status,
                statusText: response.statusText,
                headers,
                body: NULL_BODY_STATUSES.includes(status) ? new Uint8Array(0) : body,
            };
        } catch (error) {
            const reason = controller.signal.aborted ? controller.signal.reason : null;
            if (reason === TEARDOWN) {
                record(base, 'aborted', { status, bytes, code: 'FETCH_FAILED' });
                throw fetchRefusal('FETCH_FAILED', 'the sandbox was torn down');
            }
            const refusal = reason === TIMEOUT ? fetchRefusal('FETCH_TIMEOUT', `no whole response within ${policy.timeoutMs} ms`)
                : error instanceof Error && FETCH_ERROR_CODES.includes((error as any).code) ? error as Error & { code: FetchErrorCode }
                : fetchRefusal('FETCH_FAILED', 'the request failed (network error or CORS)');
            // whatever failed, nothing of this request may stay open upstream
            if (!controller.signal.aborted) controller.abort('done');
            record(base, 'failed', { status, bytes, code: refusal.code });
            throw refusal;
        } finally {
            clearTimeout(timer);
            inFlight.delete(controller);
        }
    };

    const abortAll = () => {
        closed = true;
        const controllers = [...inFlight];
        for (const controller of controllers) controller.abort(TEARDOWN);
    };

    return { handle, abortAll };
}
