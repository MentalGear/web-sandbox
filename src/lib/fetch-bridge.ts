/**
 * The host-mediated fetch bridge (backlog B5, ADR-006), host side.
 *
 * With `fetchBridge` configured, the guest gets `sandboxFetch(url, init)` (in-sandbox-script.ts), which asks
 * the host to make the request: the guest's policy is unchanged (connect-src stays what the embedder set,
 * 'none' by default), and every request the host makes for the guest is decided and logged here.
 *
 * Bridge discipline: the bridge grants no more than a direct guest request would. Every request is decided here, on
 * the host, and made by the bridge's frame (bridge-frame.ts, in-bridge-frame.ts; BD1:ISO-1, class E-net), a frame of
 * the library's with an opaque origin: the transport createFetchBridge is given is that frame's, and nothing here calls
 * the host page's fetch. So no Service Worker of the host page answers a bridge request (none controls an opaque
 * origin), no wrapper of the host page's fetch sees it, and the target sees `Origin: null`. Every request is pinned to:
 *   - credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', mode: 'cors' (BRIDGE_REQUEST_OPTIONS, the
 *     same options in the Request the host checks and in the request the frame makes);
 *   - redirect: 'manual' — a redirect is never followed; the opaque redirect it yields is refused with
 *     FETCH_REDIRECT (the same no-follow guarantee as 'error', but told apart from a network failure);
 *   - an exact-origin allowlist (scheme, host and port; no source expressions). That alone refuses the host
 *     page's own origin and every loopback, private and link-local host unless it is listed; those are
 *     checked again by name (isPrivateHost) so the refusal says why, and so the check survives any future
 *     widening of the allowlist. A page cannot see DNS answers: a listed public name that resolves to a
 *     private address (DNS rebinding) is a limit, not a guarantee;
 *   - methods and request headers from allowlists (no Cookie ever; Authorization only when listed);
 *   - a body cap read incrementally (Content-Length is checked first, never trusted), one chunk at a time as the host
 *     reads it from the frame, a per-call timeout and an AbortController that teardown also fires; whole responses
 *     only, no streaming;
 *   - a cap on concurrent requests, so the host's memory is bounded by about 3 × maxConcurrent × maxBytes (a bound, not a
 *     measurement: a body is held as the chunks read and as the joined body, and the result is cloned for the guest).
 * The target sees `Origin: null` (never the host page's origin or URL: no Referer), and the response must pass CORS for
 * an opaque origin. Every sandboxed frame on the web has that origin, an attacker's too, so a target answers
 * `Access-Control-Allow-Origin: *` or `null` only for public data, never with `Access-Control-Allow-Credentials: true`,
 * and never treats `null` as trusted. The bridge sends no credentials (cookies, HTTP authentication), so it gets what any
 * anonymous page gets.
 *
 * Every request is reported once, when it settles, as a FetchRecord (the host's 'fetch' event): refused
 * attempts included. Fields that come from the guest are validated or clamped before they are reported. Once the
 * environment is torn down (abortAll), every record its bridge still makes is 'aborted', whatever the request settled on
 * (createFetchBridge, record).
 *
 * Host-side only, never stringified into the guest, so it may use module scope freely.
 */
import type { RpcLibraryCode } from './rpc';
import { ownField, type Complete, type Holds } from './utils';
import { parseOrigin, type Origin, type OriginRules } from './origin';
import { shown } from './csp/origins';
import { setLongTimeout } from './long-timer';
import { BRIDGE_REQUEST_OPTIONS } from './in-bridge-frame';

/** The method name the bridge is exposed under: reserved, so no exposed method can collide with it. */
export const FETCH_METHOD = 'sandbox:fetch';

/**
 * Why `sandboxFetch()` rejected: the rejection's `code`, and the `code` of a {@link FetchRecord}. Minted only by the host.
 * - `FETCH_NOT_ALLOWED`: refused before any request, because of the URL, the origin, the method, a header or the body.
 * - `FETCH_BUSY`: refused before any request, because `maxConcurrent` requests are already in flight. Retryable.
 * - `FETCH_REDIRECT`: the response was a redirect, which is never followed.
 * - `FETCH_TOO_LARGE`: the request body or the response body exceeds `maxBytes`.
 * - `FETCH_TIMEOUT`: no whole response within `timeoutMs`. Retryable.
 * - `FETCH_FAILED`: the request failed (network error, CORS), the bridge's frame could not start, or the sandbox was
 *   torn down. Retryable.
 */
export type FetchErrorCode = Extract<RpcLibraryCode, `FETCH_${string}`>;

const FETCH_CODES = ['FETCH_NOT_ALLOWED', 'FETCH_BUSY', 'FETCH_REDIRECT', 'FETCH_TOO_LARGE', 'FETCH_TIMEOUT', 'FETCH_FAILED'] as const satisfies readonly FetchErrorCode[];
type FetchErrorCodesComplete = Holds<Complete<FetchErrorCode, typeof FETCH_CODES>>;

// Typed as the public API has it; the list it is made from is complete by construction.
/** Every {@link FetchErrorCode}, as a value. */
export const FETCH_ERROR_CODES: readonly FetchErrorCode[] = FETCH_CODES;

/**
 * The `fetchBridge` option: what `sandboxFetch()` in the guest may reach. Only `allow` is required.
 *
 * @remarks
 * The host decides every request, and a hidden frame of the library's with an opaque origin makes it, never the host
 * page: the host page's Service Worker and any wrapper of its `fetch` never see it. So the target sees `Origin: null`,
 * and its CORS must allow that: `Access-Control-Allow-Origin: *` or `null`, for public data only. Every sandboxed frame
 * on the web, an attacker's too, has the origin `null`: a target must never pair it with
 * `Access-Control-Allow-Credentials: true` or treat `null` as trusted. The bridge itself sends no credentials (no cookies,
 * no HTTP authentication), so it gets what any anonymous page gets. Every request is pinned to no credentials, no
 * `Referer`, no redirects (refused with `FETCH_REDIRECT`) and `cache: 'no-store'`. The frame runs the same hashed
 * bootstrap as the strict view, under the same hash, so a host page policy that admits the sandbox admits it, and one
 * that refuses the view refuses it too (strict mode then ends with the startup reason). A frame that fails to start
 * alone fails the bridge closed and leaves the sandbox running (docs/API.md#host-page-policy). The host page's own origin and loopback, private and link-local hosts are refused
 * unless listed. A listed public name that resolves to a private address cannot be detected
 * from a page. A number that is not finite or is below 1 takes its default, and one above its bound takes the bound.
 * See ADR-006.
 */
export interface FetchBridgeConfig {
    /**
     * The exact origins the guest may reach: scheme, host and optional port, like `https://api.example` or
     * `http://localhost:8080`. An entry with a path, query, fragment, credentials or `*` is dropped with a warning, and so
     * is a value that is not a list. An empty list refuses everything. Listing the host page's own origin or a loopback,
     * private or link-local host works, with one warning each.
     */
    allow: string[];
    /**
     * Most bytes of one response body, and of one request body. At most `33554432` (32 MiB).
     *
     * @defaultValue `1048576` (1 MiB)
     */
    maxBytes?: number;
    /**
     * Most ms for one request, response body included. At most `120000`.
     *
     * @defaultValue `10000`
     */
    timeoutMs?: number;
    /**
     * The methods the guest may use, from `GET`, `HEAD`, `POST`, `PUT`, `PATCH` and `DELETE`. Replaces the default list.
     *
     * @defaultValue `['GET', 'HEAD', 'POST']`
     */
    methods?: string[];
    /**
     * Header names the guest may set beyond `accept`, `accept-language`, `content-language` and `content-type`.
     * `Authorization` only this way; `Cookie`, `Host`, `Origin`, `Referer`, `Sec-*`, `Proxy-*` and other forbidden names
     * never.
     *
     * @defaultValue none
     */
    headers?: string[];
    /**
     * Most requests in flight at once; a request past it is refused with `FETCH_BUSY`. At most `16`. The host's memory
     * for the bridge is bounded by about 3 times `maxConcurrent` times `maxBytes`: a response is held as the chunks read
     * and as the joined body, and the result is cloned for the guest (a bound, not a measurement).
     *
     * @defaultValue `4`
     */
    maxConcurrent?: number;
}

/** The fields of {@link FetchBridgeConfig}, as a value: what toFetchPolicy reads (own fields only, ownField), and what the config tests enumerate. */
export const FETCH_BRIDGE_FIELDS = ['allow', 'maxBytes', 'timeoutMs', 'methods', 'headers', 'maxConcurrent'] as const satisfies readonly (keyof FetchBridgeConfig)[];
type FetchBridgeFieldsComplete = Holds<Complete<keyof FetchBridgeConfig, typeof FETCH_BRIDGE_FIELDS>>;

/** A validated FetchBridgeConfig: every field present and in range. */
export interface FetchPolicy {
    allow: readonly Origin[];
    maxBytes: number;
    timeoutMs: number;
    methods: readonly string[];
    headers: readonly string[];
    maxConcurrent: number;
}

/**
 * A refusal minted by the bridge: an Error with a library code. `reason`, when set, is the host's own account of a
 * refusal whose guest text says less; it goes to the record, never to the guest (the broker sends only the message
 * and the code).
 */
export type FetchRefusal = Error & { code: FetchErrorCode; reason?: string; unsent?: true };

/**
 * The `detail` of a `fetch` event: one request through the bridge, reported once when it settled. A union keyed by
 * `outcome`; each member has exactly the fields its outcome has, and the fields it lacks are typed `never`, so reading
 * one is allowed and gives `undefined`.
 *
 * - `'ok'`: a response was handed to the guest, whatever its HTTP status. Has `status`; has no `code`.
 * - `'refused'`: no request was made; the bridge's rules, or the browser's `Request`, refused it, or the bridge's frame
 *   could not start. `code` says why (`FETCH_NOT_ALLOWED`, `FETCH_BUSY`, `FETCH_TOO_LARGE` for a request body, or
 *   `FETCH_FAILED` when the frame could not start). `bytes` is `0`. `reason` is present for a refusal of an origin that
 *   is not listed (the host page's own origin, or a loopback, private or link-local host) and for a frame that could
 *   not start: what the host knows beyond the text the guest gets.
 * - `'failed'`: the request was handed to the bridge's frame and no whole response was handed over; `code` says why (`FETCH_REDIRECT`,
 *   `FETCH_TOO_LARGE` for a response body, `FETCH_TIMEOUT` or `FETCH_FAILED`). `status` is present once a response's
 *   status was read (not for a redirect, which is refused first). It is not proof that a request left the page: the browser's `fetch` also rejects some requests before
 *   sending them (the host page's own `connect-src`, mixed content, local-network blocking).
 * - `'aborted'`: the environment was torn down (by `reset()`, `load()`, `setConfig()`, `terminate()` or removal) before
 *   the record was made, whatever the request had settled on. `code` is `FETCH_FAILED`; `status` and `bytes` are as
 *   measured.
 *
 * @remarks
 * A record belongs to the environment that made the request and is dispatched when the request settles, so an `'aborted'`
 * record of a torn-down environment can arrive after the call that tore it down, while the next build is loading; after
 * a teardown an environment's records are all `'aborted'`. Fields that come from the guest are validated or clamped
 * first. `method` is upper case (`''` when the guest sent no valid one). `url` is the whole URL without its fragment, at
 * most 8192 characters (a longer one is refused and reported cut), or the guest's string cut to that when it is not a
 * URL. `bytes` counts the response body bytes read. `durationMs` runs from the request to its settlement. `url` is
 * guest-controlled text (it can be `javascript:`): show it with `textContent`, never in an HTML, URL (such as a link
 * `href`), `eval` or template sink.
 */
export type FetchRecord = {
    /** The method, upper case; `''` when the guest sent no valid one. */
    method: string;
    /**
     * The URL without its fragment, or the guest's string when it is not a URL; at most 8192 characters.
     * Guest-controlled text: show it with `textContent`, never in an HTML, URL (such as a link `href`: it can be
     * `javascript:`), `eval` or template sink.
     */
    url: string;
    /** Time from the request to its settlement, in ms. */
    durationMs: number;
} & (
    | { outcome: 'ok'; status: number; bytes: number; code?: never; reason?: never }
    | { outcome: 'refused'; code: FetchErrorCode; reason?: string; bytes: 0; status?: never }
    | { outcome: 'failed'; code: FetchErrorCode; status?: number; bytes: number; reason?: never }
    | { outcome: 'aborted'; code: 'FETCH_FAILED'; status?: number; bytes: number; reason?: never }
);

/** Every {@link FetchRecord} `outcome`, as a value; the written-out type and this list are kept equal. */
export const FETCH_OUTCOMES = ['ok', 'refused', 'failed', 'aborted'] as const satisfies readonly FetchRecord['outcome'][];
type FetchOutcomesComplete = Holds<Complete<FetchRecord['outcome'], typeof FETCH_OUTCOMES>>;

/** What the guest receives for a whole response; its sandboxFetch() turns it into a Response. */
export interface FetchResult {
    url: string;
    status: number;
    statusText: string;
    headers: [string, string][];
    body: Uint8Array;
}

// The defaults and bounds of `fetchBridge` (toFetchPolicy), each a row of the limits registry (limits.ts).
export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const MAX_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_FETCH_TIMEOUT_MS = 10000;
export const MAX_TIMEOUT_MS = 120000;
export const DEFAULT_MAX_CONCURRENT = 4;
export const MAX_MAX_CONCURRENT = 16;
const DEFAULT_METHODS = ['GET', 'HEAD', 'POST'];
const ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const SAFE_HEADERS = ['accept', 'accept-language', 'content-language', 'content-type'];
// Names an embedder cannot add: the browser forbids them in fetch, or they carry host-page authority.
const FORBIDDEN_HEADER = /^(accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie|cookie2|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/;
const MAX_HEADERS = 64;
const MAX_HEADER_VALUE = 8192;
// The longest URL the bridge takes, as the guest wrote it and as parsed (percent-encoding can make the parsed one
// longer): past it a request is refused. A record reports the whole URL, so it is never longer than this either (R3:M-4:
// a valid request's URL is never reported cut).
export const MAX_URL = 8192;
const NULL_BODY_STATUSES = [101, 103, 204, 205, 304];

/** An Error with a library code, the only kind of refusal this module produces. */
export function fetchRefusal(code: FetchErrorCode, message: string): FetchRefusal {
    const error = new Error(`[sandboxFetch] ${code}: ${message}`) as FetchRefusal;
    error.code = code;
    return error;
}

const boundedInteger = (value: unknown, fallback: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback;
    return Math.min(Math.floor(value), max);
};

/**
 * The schemes an allowlist entry may have: https and http, for any host. Each entry is read by the one origin parser
 * the guest policy's `origins` use too (origin.ts, ADR-007): an exact origin as written, so an entry can only ever
 * mean one origin. Paths, queries, fragments, credentials, wildcards, IPv6 literals and anything the URL parser
 * would rewrite are refused.
 */
export const FETCH_ORIGIN_RULES: OriginRules = { anyHost: ['https:', 'http:'], loopbackOnly: [] };

/**
 * Validates a `fetchBridge` config into a policy, or returns null when there is none to apply (not an
 * object). Entries that cannot be used are dropped and reported through `warn`; an empty allowlist is a
 * valid policy that refuses everything. A list field that is not a list is dropped with a warning, as a whole: `allow`
 * then admits nothing, `methods` and `headers` keep their defaults. Every value shown in a warning is clamped
 * (`shown`, R1:R1-3: JSON.stringify of a BigInt or a cyclic entry would throw and refuse the whole config).
 * An allowlist that names the host page's own origin (`hostOrigin`) or a loopback, private or link-local host is
 * honoured, as configured, with one warning each (R1:R3-5): it lets the guest reach what the bridge otherwise refuses.
 */
export function toFetchPolicy(config: unknown, warn: (message: string) => void, hostOrigin = ''): FetchPolicy | null {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
    const source = config as Record<string, unknown>;
    const listOf = (field: 'allow' | 'methods' | 'headers', fallback: readonly unknown[]): readonly unknown[] => {
        const value = ownField(source, field);
        if (value === undefined) return fallback;
        if (Array.isArray(value)) return value;
        warn(`[Sandbox] fetchBridge.${field} must be a list; ${shown(value)} was dropped.`);
        return fallback;
    };

    const allow = new Set<Origin>();
    for (const entry of listOf('allow', [])) {
        const origin = parseOrigin(entry, FETCH_ORIGIN_RULES);
        if (origin === null) {
            warn(`[Sandbox] fetchBridge.allow entry ${shown(entry)} was dropped: list exact origins like "https://api.example" (scheme, host, optional port).`);
            continue;
        }
        if (origin === hostOrigin) warn(`[Sandbox] fetchBridge.allow lists the host page's own origin (${origin}): the guest can send requests to it through the bridge (without credentials).`);
        else if (isPrivateHost(new URL(origin).hostname)) warn(`[Sandbox] fetchBridge.allow lists ${origin}, a loopback, private or link-local host: the guest can reach it through the bridge.`);
        allow.add(origin);
    }

    const methods = new Set<string>();
    for (const entry of listOf('methods', DEFAULT_METHODS)) {
        const method = typeof entry === 'string' ? entry.toUpperCase() : '';
        if (!ALLOWED_METHODS.includes(method)) {
            warn(`[Sandbox] fetchBridge.methods entry ${shown(entry)} was dropped: one of ${ALLOWED_METHODS.join(', ')}.`);
            continue;
        }
        methods.add(method);
    }

    const headers = new Set<string>(SAFE_HEADERS);
    for (const entry of listOf('headers', [])) {
        const name = typeof entry === 'string' ? entry.toLowerCase() : '';
        if (!HEADER_NAME.test(name) || FORBIDDEN_HEADER.test(name)) {
            warn(`[Sandbox] fetchBridge.headers entry ${shown(entry)} was dropped: not a header name the guest may set.`);
            continue;
        }
        headers.add(name);
    }

    return Object.freeze({
        allow: Object.freeze([...allow]),
        maxBytes: boundedInteger(ownField(source, 'maxBytes'), DEFAULT_MAX_BYTES, MAX_MAX_BYTES),
        timeoutMs: boundedInteger(ownField(source, 'timeoutMs'), DEFAULT_FETCH_TIMEOUT_MS, MAX_TIMEOUT_MS),
        methods: Object.freeze([...methods]),
        headers: Object.freeze([...headers]),
        maxConcurrent: boundedInteger(ownField(source, 'maxConcurrent'), DEFAULT_MAX_CONCURRENT, MAX_MAX_CONCURRENT),
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
 * The names that are private by convention, as a value (class C: the one list isPrivateHost reads, and the test that
 * enumerates it). A name ends in one of these suffixes (or is one) when it is meant for a machine or network of the
 * user's own, whatever address it resolves to: the page never sees DNS answers, but these names are decidable from the
 * name. `reason` is why each is here.
 */
export const PRIVATE_NAME_SUFFIXES = [
    { suffix: 'localhost', reason: 'RFC 6761: loopback, by name, in every resolver' },
    { suffix: 'local', reason: 'RFC 6762: multicast DNS, names on the local link (printer.local)' },
    { suffix: 'internal', reason: 'ICANN (2024) reserved it for private use; also the cloud and container hosts (metadata.google.internal, host.docker.internal)' },
    { suffix: 'home.arpa', reason: 'RFC 8375: the home network' },
    { suffix: 'localdomain', reason: 'the resolver default for the machine itself (localhost.localdomain)' },
    { suffix: 'lan', reason: 'the convention of home and office routers (router.lan)' },
    { suffix: 'intranet', reason: 'the convention of a company network' },
    { suffix: 'corp', reason: 'the convention of a company network, and a name ICANN never delegated (name collision)' },
    { suffix: 'home', reason: 'the convention of a home network, and a name ICANN never delegated (name collision)' },
] as const;

/**
 * Whether a URL's hostname (as `new URL()` writes it, so already canonical: IPv4 in dotted decimal, IPv6
 * in brackets) names this machine or a private, link-local or otherwise non-public address: IPv4/IPv6 literals in those
 * ranges, a single-label name (`printer`, `intranet`: only a search domain or hosts file can resolve it, and that is the
 * user's own network) and the names private by convention (PRIVATE_NAME_SUFFIXES: `localhost`, `*.local`,
 * `*.internal`, `*.lan`, `*.home.arpa`, …). A name that only RESOLVES to such an address cannot
 * be recognised here (DNS rebinding): the page never sees DNS answers.
 */
export function isPrivateHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    if (host.startsWith('[') && host.endsWith(']')) {
        const hextets = ipv6Hextets(host.slice(1, -1));
        return hextets === null ? true : isPrivateIPv6(hextets); // an IPv6 literal we cannot read is refused
    }
    const octets = ipv4Octets(host);
    if (octets !== null) return isPrivateIPv4(octets);
    if (!host.includes('.')) return true; // a single label
    return PRIVATE_NAME_SUFFIXES.some(({ suffix }) => host === suffix || host.endsWith(`.${suffix}`));
}

/** A request the bridge will make: every field validated. */
export interface ValidRequest {
    url: URL;
    method: string;
    headers: [string, string][];
    body: string | Uint8Array | undefined;
}

// The URL a record names. One longer than MAX_URL is refused anyway and reported cut, without being parsed (R4:C-8):
// parsing a guest's string of any length only to cut its result would be work the guest chose the size of.
const reportedUrl = (value: unknown): string => {
    if (typeof value !== 'string') return '';
    if (value.length > MAX_URL) return value.slice(0, MAX_URL);
    try {
        const url = new URL(value);
        url.hash = '';
        return url.href.slice(0, MAX_URL);
    } catch {
        return value.slice(0, MAX_URL);
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
        // by the Request the bridge builds before it records anything (createFetchBridge, AR:B6).
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
export function validateRequest(request: unknown, policy: FetchPolicy, hostOrigin: string): ValidRequest | FetchRefusal {
    if (!request || typeof request !== 'object') return fetchRefusal('FETCH_NOT_ALLOWED', 'not a request');
    const source = request as Record<string, unknown>;

    const rawUrl = source.url;
    if (typeof rawUrl !== 'string') return fetchRefusal('FETCH_NOT_ALLOWED', 'the URL must be an absolute URL string');
    if (rawUrl.length > MAX_URL) return fetchRefusal('FETCH_NOT_ALLOWED', `the URL is longer than ${MAX_URL} characters`);
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return fetchRefusal('FETCH_NOT_ALLOWED', 'the URL must be absolute (the guest has no base URL)');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return fetchRefusal('FETCH_NOT_ALLOWED', `${url.protocol} URLs are not fetched`);
    if (url.username || url.password) return fetchRefusal('FETCH_NOT_ALLOWED', 'URLs with credentials are not fetched');
    url.hash = '';
    if (url.href.length > MAX_URL) return fetchRefusal('FETCH_NOT_ALLOWED', `the URL is longer than ${MAX_URL} characters`);

    if (!(policy.allow as readonly string[]).includes(url.origin)) {
        // One text to the guest for every origin that is not listed (BR:CB6): a refusal that
        // said "the host page's own origin" would tell the guest which origin embeds it, by probing. Why it is not listed
        // stays on the host, in the record's `reason`.
        const refusal = fetchRefusal('FETCH_NOT_ALLOWED', `${url.origin} is not in fetchBridge.allow`);
        if (url.origin === hostOrigin) refusal.reason = "the host page's own origin, which is not in fetchBridge.allow";
        else if (isPrivateHost(url.hostname)) refusal.reason = 'a loopback, private or link-local host, which is not in fetchBridge.allow';
        return refusal;
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

/**
 * Whether a response to `method` has no body to read: a response to HEAD, one with a null-body status (204, 304 and the
 * rest), or one the transport gave no body. Such a response is empty and never too large, whatever Content-Length it
 * repeats for the resource it stands for. Chromium hands a HEAD response an empty stream, not a null body, so the method
 * counts too.
 */
const hasNoBody = (method: string, response: BridgeResponse): boolean => response.body === null || method === 'HEAD' || NULL_BODY_STATUSES.includes(response.status);

/**
 * Reads a response body chunk by chunk, stopping as soon as it exceeds maxBytes. A response without a body (hasNoBody)
 * is read as empty; the declared length is checked only for a body that would be read.
 */
async function readBody(response: BridgeResponse, method: string, maxBytes: number, onBytes: (total: number) => void): Promise<Uint8Array> {
    if (response.body === null || hasNoBody(method, response)) {
        await response.body?.cancel().catch(() => {});
        return new Uint8Array(0);
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) {
        await response.body.cancel().catch(() => {});
        throw fetchRefusal('FETCH_TOO_LARGE', `the response declares ${declared} bytes, more than ${maxBytes}`);
    }

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

/**
 * A response as the bridge reads it: what the bridge's frame reports of the response it received (bridge-frame.ts), its
 * body read from the frame one chunk at a time. A platform Response has this shape too (the unit tests' transports).
 */
export interface BridgeResponse {
    readonly type: string;
    readonly status: number;
    readonly statusText: string;
    readonly headers: { get(name: string): string | null; has(name: string): boolean; forEach(callback: (value: string, name: string) => void): void };
    readonly body: ReadableStream<Uint8Array> | null;
}

/**
 * What makes a bridge request: given the Request the bridge built and checked, and the init it was built from (the
 * validated method, headers and body, BRIDGE_REQUEST_OPTIONS and the request's signal), it resolves with the response or
 * rejects. In the element it is always the bridge frame's (bridge-frame.ts, createBridgeFrame); a test passes its own.
 */
export type BridgeTransport = (request: Request, init: RequestInit) => Promise<BridgeResponse>;

export interface FetchBridgeOptions {
    policy: FetchPolicy;
    hostOrigin: string;
    /** Called once per request, when it settles (the host dispatches the 'fetch' event). */
    onRecord: (record: FetchRecord) => void;
    /** What makes the requests: the bridge frame's transport (BD1:ISO-1). There is no default. */
    transport: BridgeTransport;
    now?: () => number;
}

export interface FetchBridge {
    /** Handles one sandboxFetch() request from the guest: resolves with the whole response or rejects with a library code. */
    handle(request: unknown): Promise<FetchResult>;
    /**
     * Ends the bridge with its environment (teardown): aborts every request in flight, and from then on every record the
     * bridge makes is 'aborted' and every request is refused, whatever path it settles on.
     */
    abortAll(): void;
}

// What a request is known by when it settles, from the guest's validated fields, and when it started.
type Base = { method: string; url: string; started: number };

// What a path proposes to record: the outcome it settled on and the fields that outcome has. record() makes the
// FetchRecord of it, or an 'aborted' one when the environment is gone: no path proposes 'aborted'.
type Settled =
    | { outcome: 'ok'; status: number; bytes: number }
    | { outcome: 'refused'; code: FetchErrorCode; reason?: string }
    | { outcome: 'failed'; code: FetchErrorCode; status?: number; bytes: number };

/** The members of FetchRecord that a request which was not torn down ends in: each has the fields its outcome has, and no other. */
function recordOf({ method, url }: Base, durationMs: number, settled: Settled): FetchRecord {
    switch (settled.outcome) {
        case 'ok':
            return Object.freeze({ method, url, durationMs, outcome: 'ok', status: settled.status, bytes: settled.bytes });
        case 'refused':
            return Object.freeze({ method, url, durationMs, outcome: 'refused', code: settled.code, bytes: 0, ...(settled.reason === undefined ? {} : { reason: settled.reason }) });
        case 'failed':
            return Object.freeze({ method, url, durationMs, outcome: 'failed', code: settled.code, bytes: settled.bytes, ...(settled.status === undefined ? {} : { status: settled.status }) });
        default:
            return settled satisfies never; // a new outcome does not compile until it is handled
    }
}

/** What a request ends in once its environment is torn down, whatever it settled on: status and bytes as measured (a refusal made no request, so it measured none). */
function abortedRecord({ method, url }: Base, durationMs: number, settled: Settled): FetchRecord {
    if (settled.outcome === 'refused') return Object.freeze({ method, url, durationMs, outcome: 'aborted', code: 'FETCH_FAILED', bytes: 0 });
    return Object.freeze({ method, url, durationMs, outcome: 'aborted', code: 'FETCH_FAILED', bytes: settled.bytes, ...(settled.status === undefined ? {} : { status: settled.status }) });
}

const TEARDOWN = 'teardown';
const TIMEOUT = 'timeout';

/** One bridge per environment: its requests end with the environment (abortAll). */
export function createFetchBridge({ policy, hostOrigin, onRecord, transport, now = () => performance.now() }: FetchBridgeOptions): FetchBridge {
    const inFlight = new Set<AbortController>();
    let closed = false;

    // The one place a record is made, and the one place its outcome is final (LM-1, class L: an environment's events
    // reaching listeners after its teardown). Each path below proposes the outcome it settled on; once abortAll()
    // has run, the record is 'aborted' instead, with code FETCH_FAILED, whatever was proposed. Status and bytes stay as
    // measured; a refusal's `reason` goes (it explains a refusal, and this is not one).
    //
    // Why here and not on each path: a listener of one request's record can tear the environment down (reset() or
    // terminate()) while another request's body is already read, and that request would settle on the success path and
    // record 'ok' after the teardown; so would a redirect refusal, a 'failed' record and a request refused after close.
    // docs/API.md promises that after its teardown an environment's records are 'aborted': with the decision made
    // here, from the bridge's lifetime and not from how the request ended, that holds for every path, present and future,
    // because no path picks the final outcome. `closed` is read after the clock, as the last thing before the
    // record is handed over, so a teardown up to that instant is seen (the unit test tears down from inside that clock
    // read: test/unit/fetch-bridge-lifecycle.test.ts). Nothing can run between this and onRecord.
    //
    // Returns the outcome recorded: when it is 'aborted', the guest's call rejects with the teardown refusal
    // (tornDown) instead of handing over a body or another refusal. Its environment is gone, so the answer could only
    // reach a closed port anyway (host.ts, _onGuestMessage), and the guest is told the same thing on every path.
    const record = (base: Base, settled: Settled): FetchRecord['outcome'] => {
        const durationMs = Math.max(0, now() - base.started);
        if (closed) {
            onRecord(abortedRecord(base, durationMs, settled));
            return 'aborted';
        }
        onRecord(recordOf(base, durationMs, settled));
        return settled.outcome;
    };
    const tornDown = () => fetchRefusal('FETCH_FAILED', 'the sandbox was torn down');

    const handle = async (request: unknown): Promise<FetchResult> => {
        const source = request && typeof request === 'object' ? request as Record<string, unknown> : {};
        const base = { method: reportedMethod(source.method ?? 'GET'), url: reportedUrl(source.url), started: now() };

        const refuse = (error: FetchRefusal): never => {
            const outcome = record(base, error.reason === undefined ? { outcome: 'refused', code: error.code } : { outcome: 'refused', code: error.code, reason: error.reason });
            throw outcome === 'aborted' ? tornDown() : error;
        };
        // A request that reaches a closed bridge: no request is made, and record() reports it 'aborted', not 'refused'.
        // It was sent by the torn-down environment, which alone holds this bridge (host.ts, _exposeFetch binds the reserved
        // method to its own environment's bridge), before its teardown, and it settles after it: what API.md calls
        // 'aborted' ("the environment was torn down meanwhile"), and API.md promises that only 'aborted' records of a
        // torn-down environment arrive after its teardown. 'refused' would break that promise for the one request that
        // was already on its way.
        if (closed) refuse(tornDown());
        const valid = validateRequest(request, policy, hostOrigin);
        if (valid instanceof Error) return refuse(valid);
        if (inFlight.size >= policy.maxConcurrent) refuse(fetchRefusal('FETCH_BUSY', `${policy.maxConcurrent} requests are already in flight`));

        // The platform validates the request before anything is recorded as made (AR:B6): the Request constructor applies the Fetch standard's own checks (a header value is a
        // ByteString without NUL, CR or LF; the body is a BufferSource or a string; the method and mode agree),
        // so nothing it refuses can reach the frame and be reported as 'failed'. What it throws is a refusal; no
        // request exists then. validateRequest() keeps only what is policy: the origin allowlist, private hosts,
        // methods, header names, sizes. The transport is given that Request and the same init, and the frame makes
        // the request from the same fields and the same pinned options, so what was checked is what is sent.
        const controller = new AbortController();
        const init: RequestInit = {
            method: valid.method,
            headers: valid.headers,
            body: valid.body as BodyInit | undefined,
            signal: controller.signal,
            ...BRIDGE_REQUEST_OPTIONS,
        };
        let outgoing: Request;
        try {
            outgoing = new Request(valid.url.href, init);
        } catch (error) {
            return refuse(fetchRefusal('FETCH_NOT_ALLOWED', `the browser refused the request (${error instanceof Error ? error.name : 'error'})`));
        }
        inFlight.add(controller);
        const timer = setLongTimeout(() => controller.abort(TIMEOUT), policy.timeoutMs);
        let bytes = 0;
        let status: number | undefined;
        let result: FetchResult;
        try {
            // The frame makes the request (in-bridge-frame.ts), with the init again, whole: an abort that reaches a
            // fetch only through the Request's own (following) signal does not stop a response whose headers have
            // arrived in WebKit, and any partial init makes the Request constructor reset the referrer policy, which
            // brings a Referer back (all three engines; test/e2e/fetch-bridge.spec.ts). The controller's abort reaches
            // the frame as BRIDGE_ABORT, which aborts the frame's own fetch.
            const response = await transport(outgoing, init);
            if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400 && response.headers.has('location'))) {
                await response.body?.cancel().catch(() => {});
                throw fetchRefusal('FETCH_REDIRECT', 'the response was a redirect, which the bridge never follows');
            }
            status = response.status;
            const body = await readBody(response, valid.method, policy.maxBytes, (total) => { bytes = total; });
            const headers: [string, string][] = [];
            response.headers.forEach((value, name) => headers.push([name, value]));
            result = {
                url: valid.url.href,
                status,
                statusText: response.statusText,
                headers,
                body,
            };
        } catch (error) {
            // A teardown's abort lands here too, as whatever the fetch or the read threw: record() makes it 'aborted'
            // (abortAll closes the bridge before it aborts), so no branch here needs to recognise it.
            if (!controller.signal.aborted && error instanceof Error && (error as FetchRefusal).unsent === true) {
                // The transport never made the request (its frame could not start): a refusal, with the host's reason.
                controller.abort('done');
                const unsent = error as FetchRefusal;
                const outcome = record(base, unsent.reason === undefined ? { outcome: 'refused', code: unsent.code } : { outcome: 'refused', code: unsent.code, reason: unsent.reason });
                throw outcome === 'aborted' ? tornDown() : unsent;
            }
            const reason = controller.signal.aborted ? controller.signal.reason : null;
            const refusal = reason === TIMEOUT ? fetchRefusal('FETCH_TIMEOUT', `no whole response within ${policy.timeoutMs} ms`)
                : error instanceof Error && FETCH_ERROR_CODES.includes((error as any).code) ? error as Error & { code: FetchErrorCode }
                : fetchRefusal('FETCH_FAILED', 'the request failed (network error or CORS)');
            // whatever failed, nothing of this request may stay open upstream
            if (!controller.signal.aborted) controller.abort('done');
            throw record(base, { outcome: 'failed', status, bytes, code: refusal.code }) === 'aborted' ? tornDown() : refusal;
        } finally {
            timer.cancel();
            inFlight.delete(controller);
        }
        // Recorded outside the try, so that the teardown refusal thrown here is not taken for a failure of the request.
        if (record(base, { outcome: 'ok', status: result.status, bytes }) === 'aborted') throw tornDown();
        return result;
    };

    const abortAll = () => {
        closed = true;
        const controllers = [...inFlight];
        for (const controller of controllers) controller.abort(TEARDOWN);
    };

    return { handle, abortAll };
}
