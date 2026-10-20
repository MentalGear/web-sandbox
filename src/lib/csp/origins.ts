import { parseOrigin, type Origin, type OriginRules } from "../origin";
import { defineData } from "../utils";

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

/** The guest policy's origins (`origins`): the exact origins the guest may load each kind from. Default: none. */
export interface SandboxOrigins {
    /** fetch(), XMLHttpRequest, WebSocket (wss: too), EventSource, sendBeacon: connect-src. */
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

/** `origins` in strict mode: no `scripts`, since the view runs only the library's bootstrap (ADR-005). */
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

/**
 * `input` (the config's `origins`, already a structured clone) as an OriginPolicy for `mode`. Throws a TypeError
 * for an input that is present but not an object, or a kind that is present but not a list: the caller refuses the
 * config. Everything else it cannot use goes to `warn`, one message per entry, and is left out.
 */
export function parseOrigins(input: unknown, mode: unknown, warn: (message: string) => void): OriginPolicy {
    if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw new TypeError('origins must be an object of origin lists');
    const source = (input ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(source)) {
        if (!isKind(key)) warn(`[Sandbox] origins.${shown(key)} was dropped: origins takes ${ORIGIN_KINDS.join(', ')}.`);
    }

    const policy: Record<string, readonly Origin[]> = {};
    for (const kind of ORIGIN_KINDS) {
        const entries = Object.hasOwn(source, kind) ? source[kind] : undefined;
        if (entries !== undefined && !Array.isArray(entries)) throw new TypeError(`origins.${kind} must be a list of origins`);
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
    return [...origins];
}
