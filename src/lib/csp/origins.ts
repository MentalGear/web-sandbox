import { parseOrigin, type Origin, type OriginRules } from "../origin";
import { defineData, ownField } from "../utils";

/**
 * `origins`: what the embedder may open in the guest policy (ADR-007). One list of exact origins per kind of load,
 * and nothing else: no directive names, no source expressions. Every directive of the policy, and every source
 * that is not an origin listed here, is the library's (csp-generator.ts).
 *
 * What a config can say is limited by its type, and what a config does say is parsed at the boundary, once, by
 * parseOrigins(): a kind it does not know, an entry that is not an origin (parseOrigin, origin.ts) and, in strict
 * mode, `scripts` are each dropped with one warning. Dropping only narrows: a kind with no origin left is 'none'.
 * A value that is not an object, or a kind that is not a list, cannot be read at all and refuses the config.
 *
 * Host-side only, never stringified into a guest.
 */

/**
 * The `origins` option: the exact origins the guest may load each kind of resource from, one list per kind. It adds
 * origins to six directives of the guest's policy and can change nothing else.
 *
 * @remarks
 * An entry is one exact origin, `https://host[:port]`; in `connect` also `wss://host[:port]`, which is kept only beside
 * its `https://host[:port]` twin (the pair admits both `fetch()` and `WebSocket` on every engine); plain `http://` only
 * for `localhost` and `127.0.0.1`. Case is folded and a default port is dropped. Anything else is dropped with one warning
 * per entry (other schemes, `*`, `'self'` and other keywords, paths, credentials, an IPv6 literal, a non-ASCII or
 * percent-encoded host), and a key that is not a kind is dropped too. Dropping only narrows: a kind with no origin left
 * admits none. An `origins` that is not an object, or a kind that is not a list, cannot be read and refuses the whole
 * config. An origin on the host page's site (the registrable domain of its host as the browser decides it: the page's
 * own origin on any scheme or port, its subdomains, its parents and its siblings) is dropped in every mode, with one
 * warning per kind: some engines send the host site's cookies with a guest request to it. A loopback, private or
 * link-local host reaches the user's own machine or network, and engines differ on whether a page of the public web may
 * do that: it is kept, with one warning per kind, only when the host page is itself on one, and dropped, with a warning,
 * otherwise. The fetch bridge sends no credentials. Registered files add `blob:` to the
 * directive of each kind of load their type is for, whatever is listed here. See ADR-007.
 *
 * @defaultValue none
 */
export interface SandboxOrigins {
    /**
     * fetch(), XMLHttpRequest and WebSocket: connect-src. A WebSocket needs an entry of its own (`wss://host`), and that
     * entry is dropped with a warning unless `https://host` is listed too: the pair admits `fetch()` and `WebSocket` to
     * the host on every engine, and `https://host` alone admits `fetch()` only. Cooperative mode's guest document also
     * has EventSource and sendBeacon(), which this list governs; strict and worker mode's worker has neither. The host
     * page's own `connect-src` narrows this list in every engine (`hostContentSecurityPolicy`). The guest's fetch(),
     * XMLHttpRequest and WebSocket are the library's request gate: they admit exactly these origins (and `blob:` for
     * registered files), refuse anything else before the browser sees it and report it as a `violation`, the same on
     * every engine; fetch() and XMLHttpRequest send no credentials (docs/API.md#the-request-gate).
     */
    connect?: readonly string[];
    /** Images, CSS backgrounds, icons: img-src. */
    images?: readonly string[];
    /** Stylesheets (`<link rel=stylesheet>`, `@import`): style-src. Inline styles are always allowed. */
    styles?: readonly string[];
    /** Web fonts (`@font-face`): font-src. */
    fonts?: readonly string[];
    /** Audio, video, text tracks: media-src. */
    media?: readonly string[];
    /** Scripts (`<script src>`, modules, importScripts()): script-src. Not in strict mode. */
    scripts?: readonly string[];
}

/**
 * {@link SandboxOrigins} in strict mode: no `scripts`, since the view runs only the library's bootstrap (ADR-005). A
 * `scripts` list is a type error here and is dropped with a warning at run time. Use it to type an `origins` value whose
 * mode is chosen at run time.
 */
export type StrictSandboxOrigins = Omit<SandboxOrigins, 'scripts'> & { readonly scripts?: never };

/** A kind of load `origins` takes origins for. */
export type OriginKind = keyof SandboxOrigins;

/** Every kind, in the order the policy emits their directives. */
export const ORIGIN_KINDS = ['scripts', 'styles', 'images', 'fonts', 'media', 'connect'] as const satisfies readonly OriginKind[];

/** `origins` as parsed: every kind present, every entry an Origin; frozen, lists included. */
export type OriginPolicy = { readonly [K in OriginKind]: readonly Origin[] };

// https: for any host; plain http: only for loopback (local development); wss: for connections only.
const RULES: OriginRules = { anyHost: ['https:'], loopbackOnly: ['http:'] };
const CONNECT_RULES: OriginRules = { anyHost: ['https:', 'wss:'], loopbackOnly: ['http:'] };

/** The schemes an entry of `kind` may have (origin.ts). */
export function originRules(kind: OriginKind): OriginRules {
    return kind === 'connect' ? CONNECT_RULES : RULES;
}

const isKind = (key: string): key is OriginKind => (ORIGIN_KINDS as readonly string[]).includes(key);

// An entry as it may appear in a warning: a string clamped and JSON-quoted (control characters show), else its type.
// Every config warning shows a value through it (R1:R1-3): JSON.stringify of a BigInt or a cyclic entry would throw
// and refuse the whole config.
export const shown = (value: unknown) => (typeof value === 'string' ? JSON.stringify(value.slice(0, 64)) : `a value of type ${value === null ? 'null' : typeof value}`);

/** The empty policy: no origin for any kind. */
export const NO_ORIGINS: OriginPolicy = parseOrigins(undefined, 'cooperative', () => {});

/** The options whose type refuses a config: `origins` itself, and each of its kinds. */
export type OriginsOption = 'origins' | OriginKind;

/**
 * What the reason of a refused config says of an `origins` of the wrong type (BD3:NEW-3): a fixed text of the library's
 * that names the option, one for each of them, never the value or the error's message (the one rule for every caught
 * error, host.ts). The reason follows `TypeError: `.
 */
export const ORIGINS_REFUSAL_TEXT: Readonly<Record<OriginsOption, string>> = Object.freeze({
    origins: 'origins is not an object',
    ...(Object.fromEntries(ORIGIN_KINDS.map(kind => [kind, `origins.${kind} is not a list`])) as Record<OriginKind, string>),
});

/** The TypeError that refuses a config for the type of `option`; the element's reason names it (ORIGINS_REFUSAL_TEXT). */
export class OriginsTypeError extends TypeError {
    constructor(readonly option: OriginsOption) {
        super(option === 'origins' ? 'origins must be an object of origin lists' : `origins.${option} must be a list of origins`);
    }
}

/**
 * `input` (the config's `origins`, already a structured clone) as an OriginPolicy for `mode`. Throws an
 * OriginsTypeError for an input that is present but not an object, or a kind that is present but not a list: the caller
 * refuses the config. Everything else it cannot use goes to `warn`, one message per entry, and is left out.
 */
export function parseOrigins(input: unknown, mode: unknown, warn: (message: string) => void): OriginPolicy {
    if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw new OriginsTypeError('origins');
    const source = (input ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(source)) {
        if (!isKind(key)) warn(`[Sandbox] origins.${shown(key)} was dropped: origins takes ${ORIGIN_KINDS.join(', ')}.`);
    }

    const policy: Record<string, readonly Origin[]> = {};
    for (const kind of ORIGIN_KINDS) {
        const entries = ownField(source, kind);
        if (entries !== undefined && !Array.isArray(entries)) throw new OriginsTypeError(kind);
        defineData(policy, kind, Object.freeze(originsOf(kind, entries ?? [], mode, warn)));
    }
    return Object.freeze(policy) as OriginPolicy;
}

function originsOf(kind: OriginKind, entries: readonly unknown[], mode: unknown, warn: (message: string) => void): Origin[] {
    if (kind === 'scripts' && mode === 'strict') {
        if (entries.length > 0) warn('[Sandbox] origins.scripts is not used in strict mode and was dropped: the view runs only the library\'s bootstrap, and the worker loads no script (see docs/ADR-005).');
        return [];
    }
    const origins = new Set<Origin>();
    for (const entry of entries) {
        const origin = parseOrigin(entry, originRules(kind));
        if (origin === null) {
            warn(`[Sandbox] origins.${kind} entry ${shown(entry)} was dropped: list exact origins like "https://cdn.example" (https; http only for localhost and 127.0.0.1${kind === 'connect' ? '; wss' : ''}). Wildcards, schemes, keywords, data:, blob: and paths are not origins (see docs/API.md#origins).`);
            continue;
        }
        origins.add(origin);
    }
    if (kind !== 'connect') return [...origins];
    const { kept, orphans } = withHttpsTwins([...origins]);
    for (const orphan of orphans) {
        warn(`[Sandbox] origins.connect entry ${shown(orphan)} was dropped: it needs ${shown(httpsTwin(orphan))} listed as well. Some engines let a wss:// entry admit https:// requests and others do not, so the library admits the pair on every engine, or neither (see docs/API.md#origins).`);
    }
    return kept;
}

/** The `https://` origin that a `wss://` origin needs beside it: the same host and port. */
export function httpsTwin(origin: string): string {
    return `https://${origin.slice('wss://'.length)}`;
}

/**
 * `list` without the `wss://` origins whose `https://` twin is not in it. A `wss://host` source admits `https://host`
 * requests in WebKit (CSP3's scheme matching) and not in Chromium or Firefox (measured, CONNECT_ENGINE_FACTS in
 * connect-facts.ts), and no source expression removes the difference. Admitting both on a pair makes the engines agree: a
 * connect list is then nothing, `https://h`, or `https://h` with `wss://h`, and each admits the same requests everywhere.
 */
export function withHttpsTwins(list: readonly Origin[]): { kept: Origin[]; orphans: Origin[] } {
    const listed = new Set<string>(list);
    const kept: Origin[] = [];
    const orphans: Origin[] = [];
    for (const origin of list) (origin.startsWith('wss://') && !listed.has(httpsTwin(origin)) ? orphans : kept).push(origin);
    return { kept, orphans };
}
