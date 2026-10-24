/**
 * The host page's `connect-src`, as far as the library needs it (ADR-007; INHERITED_CONTEXT.cspFetch): which of the
 * origins an embedder lists in `origins.connect` and `fetchBridge.allow` the page's Content-Security-Policy admits, so
 * that the library drops the ones it refuses before it writes the guest's and the bridge's policies, in every engine.
 *
 * Why the library does it: a sandbox document is a `srcdoc` frame and copies its parent's policy list, which narrows its
 * own, but the engines do not agree on what some of its sources admit there (CONNECT_ENGINE_FACTS, connect-facts.ts: a
 * `'self'` source admits other origins in one engine, a host without a scheme is read differently by each). So the
 * narrowing is not left to the browser. The policy's text is the embedder's `hostContentSecurityPolicy`, and nothing
 * else: no API returns a page's policy, and the library does not guess it from the page (BD4:CHL-1, BD4:CHL-2). It is
 * read here by a parser of its own for one directive. hostReach is the one decision.
 *
 * The parser admits an origin only where every engine of the suite does (measured, test/e2e/connect-uniform.spec.ts): a
 * source an engine reads differently in a sandboxed frame admits nothing. So what it keeps is admitted everywhere, and what
 * it drops is dropped everywhere, even where one engine would have admitted it (it only ever narrows). HOST_SOURCE_RULES is
 * the whole grammar:
 *  - the directive is `connect-src`, else `default-src`; a policy with neither admits every origin; the first
 *    occurrence of a directive counts, as in a browser;
 *  - `'none'` alone, or an empty list, admits nothing; `'none'` next to other sources is ignored;
 *  - a source admits an origin by its scheme, host and port, and by nothing else: no path, nonce, hash or keyword admits
 *    one, and neither `'self'` (the page's origin in some engines and nothing in others) nor a host written without a
 *    scheme (WebKit reads it against the frame's own scheme) does.
 * A list of policies (every policy the page sent, header and meta alike) is an intersection: an origin must pass each.
 *
 * Host-side only, never stringified into a guest.
 */
import type { FetchPolicy } from '../fetch-bridge';
import type { Origin } from '../origin';
import { withHttpsTwins, type OriginPolicy } from './origins';

/** What one policy says about `connect-src`: no restriction, or the sources that admit (an empty list admits nothing). */
export type ConnectSources = { readonly restricts: false } | { readonly restricts: true; readonly sources: readonly string[] };

const WHITESPACE = /[ \t\n\f\r]+/;
const NO_RESTRICTION: ConnectSources = Object.freeze({ restricts: false });

/**
 * The `connect-src` of one serialized policy: the sources of its `connect-src` directive, else of `default-src`, else
 * no restriction. Directive names fold case; a directive named twice counts the first time; `'none'` among other
 * sources is dropped, and alone leaves an empty list (admits nothing), as does a directive without sources.
 */
export function connectSources(policy: string): ConnectSources {
    const seen = new Map<string, readonly string[]>();
    for (const directive of policy.split(';')) {
        const tokens = directive.split(WHITESPACE).filter(token => token !== '');
        if (tokens.length === 0) continue;
        const name = tokens[0]!.toLowerCase();
        if (!seen.has(name)) seen.set(name, tokens.slice(1));
    }
    const listed = seen.get('connect-src') ?? seen.get('default-src');
    if (listed === undefined) return NO_RESTRICTION;
    const sources = listed.filter(source => source.toLowerCase() !== "'none'");
    return Object.freeze({ restricts: true, sources: Object.freeze(sources) });
}

/**
 * A policy list as separate policies. A string is a serialized policy list as a header or a `<meta>` carries it:
 * policies separated by commas (`Content-Security-Policy: a, b` is two policies); a list is taken as it is, one policy
 * per entry.
 */
export function splitPolicies(text: string | readonly string[]): string[] {
    const policies = typeof text === 'string' ? text.split(',') : text;
    return policies.map(policy => policy.trim()).filter(policy => policy !== '');
}

const DEFAULT_PORTS: Readonly<Record<string, number>> = Object.freeze({ 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 });
// The schemes `*` admits: the network schemes (CSP3), of which an entry can have http, https and wss.
const WILDCARD_SCHEMES = ['http:', 'https:', 'ws:', 'wss:'] as const;

/** Whether a source's scheme admits an entry's: the same scheme, `http:` also `https:`, `ws:` also `wss:`, and no other widening. */
export const schemeAdmits = (source: string, entry: string): boolean => source === entry || (source === 'http:' && entry === 'https:') || (source === 'ws:' && entry === 'wss:');

interface EntryParts { readonly scheme: string; readonly host: string; readonly port: number }

function entryParts(origin: string): EntryParts | null {
    let url: URL;
    try {
        url = new URL(origin);
    } catch {
        return null;
    }
    const port = url.port === '' ? DEFAULT_PORTS[url.protocol] : Number(url.port);
    return port === undefined ? null : { scheme: url.protocol, host: url.hostname, port };
}

const SCHEME_SOURCE = /^([a-z][a-z0-9+.-]*):$/i;
const HOST_SOURCE = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\*|[0-9]+))?(\/.*)?$/i;

/** What a source expression is, for the one rule that reads it (HOST_SOURCE_RULES names them). */
export type SourceKind = 'self' | 'wildcard' | 'scheme' | 'host' | 'bare' | 'other';

export function sourceKind(source: string): SourceKind {
    if (source === '*') return 'wildcard';
    if (source.toLowerCase() === "'self'") return 'self';
    if (source.startsWith("'") || source.includes('"')) return 'other';
    if (SCHEME_SOURCE.test(source)) return 'scheme';
    const written = HOST_SOURCE.exec(source);
    if (!written) return 'other';
    return written[1] === undefined ? 'bare' : 'host';
}

/**
 * Whether one source of a `connect-src` admits `origin` (an Origin, canonical), where every engine does. `'self'`, a host
 * without a scheme and anything unknown admit nothing. A scheme that is only an upgrade of the source's (`http:` for
 * `https:`, `ws:` for `wss:`) is admitted for a host source only when it names no port, or any port (`:*`): with a port
 * written, Chromium does not take the upgrade.
 */
export function sourceAdmits(source: string, origin: string): boolean {
    const entry = entryParts(origin);
    if (entry === null) return false;
    switch (sourceKind(source)) {
        case 'wildcard':
            return (WILDCARD_SCHEMES as readonly string[]).includes(entry.scheme);
        case 'scheme':
            return schemeAdmits(`${SCHEME_SOURCE.exec(source)![1]!.toLowerCase()}:`, entry.scheme);
        case 'host': {
            const [, scheme, host, port, path] = HOST_SOURCE.exec(source)! as unknown as [string, string, string, string | undefined, string | undefined];
            if (path !== undefined && path !== '/') return false; // a path admits some of an origin's URLs, never the origin
            const sourceScheme = `${scheme.toLowerCase()}:`;
            if (!schemeAdmits(sourceScheme, entry.scheme)) return false;
            if (sourceScheme !== entry.scheme && port !== undefined && port !== '*') return false; // an upgraded scheme, with a port written
            const name = host.toLowerCase();
            if (name.startsWith('*.') ? !entry.host.endsWith(name.slice(1)) : name !== '*' && name !== entry.host) return false;
            return port === '*' || (port === undefined ? entry.port === DEFAULT_PORTS[entry.scheme] : entry.port === Number(port));
        }
        default:
            return false;
    }
}

/** Whether the sources of one policy admit `origin`. */
export function connectAdmits(policy: ConnectSources, origin: string): boolean {
    return !policy.restricts || policy.sources.some(source => sourceAdmits(source, origin));
}

/** One rule of the grammar, as a value: the unit test checks every example, the docs render the table. */
export interface HostSourceRule {
    /** What a source of this kind admits, in words (docs/API.md#host-page-policy). */
    readonly admits: string;
    /** The kind of source, as {@link sourceKind} reads it. */
    readonly kind: SourceKind | 'directive' | 'none';
    /** Sources as written in the host page's policy. */
    readonly source: string;
    /** A policy of that source and an origin of `origins.connect` or `fetchBridge.allow`, and whether the policy admits it. */
    readonly examples: readonly (readonly [policy: string, origin: string, admitted: boolean])[];
}

export const HOST_SOURCE_RULES: readonly HostSourceRule[] = [
    {
        kind: 'directive', source: '`connect-src`, else `default-src`', admits: 'the directive that governs `fetch()`, `XMLHttpRequest` and `WebSocket`; a policy with neither admits every origin; a directive named twice counts the first time',
        examples: [
            ["connect-src https://a.example; default-src 'none'", 'https://a.example', true],
            ["connect-src https://a.example; default-src 'none'", 'https://b.example', false],
            ['default-src https://a.example', 'https://b.example', false],
            ['default-src https://a.example', 'https://a.example', true],
            ["script-src 'self'; img-src *", 'https://b.example', true],
            ['connect-src https://a.example; connect-src https://b.example', 'https://b.example', false],
            ['CONNECT-SRC https://a.example', 'https://b.example', false],
        ],
    },
    {
        kind: 'none', source: "`'none'`, or no source", admits: 'nothing; next to other sources it is ignored',
        examples: [
            ["connect-src 'none'", 'https://a.example', false],
            ['connect-src', 'https://a.example', false],
            ["connect-src 'none' https://a.example", 'https://a.example', true],
            ["connect-src 'NONE'", 'https://a.example', false],
        ],
    },
    {
        kind: 'self', source: "`'self'`", admits: "nothing: in a sandboxed frame one engine lets it admit origins it does not name, so name the origin",
        examples: [
            ["connect-src 'self'", 'https://app.example', false],
            ["connect-src 'self' https://app.example", 'https://app.example', true],
            ["connect-src 'self'", 'https://other.example', false],
        ],
    },
    {
        kind: 'wildcard', source: '`*`', admits: 'an origin of the network schemes `http`, `https`, `ws` and `wss`',
        examples: [
            ['connect-src *', 'https://a.example', true],
            ['connect-src *', 'wss://a.example:8443', true],
            ['connect-src *', 'http://127.0.0.1:3000', true],
        ],
    },
    {
        kind: 'scheme', source: '`scheme:`', admits: 'an origin of that scheme; `http:` also `https:`, `ws:` also `wss:`, and no other widening',
        examples: [
            ['connect-src https:', 'https://a.example', true],
            ['connect-src https:', 'http://127.0.0.1:3000', false],
            ['connect-src http:', 'https://a.example', true],
            ['connect-src wss:', 'wss://a.example', true],
            ['connect-src wss:', 'https://a.example', false],
            ['connect-src ws:', 'wss://a.example', true],
            ['connect-src ws:', 'https://a.example', false],
            ['connect-src data: blob:', 'https://a.example', false],
        ],
    },
    {
        kind: 'host', source: '`scheme://host[:port]`', admits: "an origin whose host is equal (case folded) and whose port is equal, the scheme's default when the source names none; the scheme as for `scheme:`, except that an upgraded scheme (`http://` for `https://`, `ws://` for `wss://`) needs no port written, or `:*`",
        examples: [
            ['connect-src https://a.example', 'https://a.example', true],
            ['connect-src https://A.Example', 'https://a.example', true],
            ['connect-src https://a.example', 'https://a.example:8443', false],
            ['connect-src https://a.example:443', 'https://a.example', true],
            ['connect-src https://a.example:8443', 'https://a.example:8443', true],
            ['connect-src https://a.example:8443', 'https://a.example', false],
            ['connect-src https://a.example', 'wss://a.example', false],
            ['connect-src wss://a.example:8443', 'wss://a.example:8443', true],
            ['connect-src http://a.example', 'https://a.example', true],
            ['connect-src http://a.example:*', 'https://a.example:8443', true],
            ['connect-src http://a.example:8443', 'https://a.example:8443', false],
            ['connect-src ws://a.example', 'wss://a.example', true],
            ['connect-src ws://a.example:8443', 'wss://a.example:8443', false],
            ['connect-src http://127.0.0.1:3000', 'http://127.0.0.1:3000', true],
            ['connect-src https://a.example/', 'https://a.example', true],
        ],
    },
    {
        kind: 'host', source: '`*.host` and `:*`', admits: 'a subdomain of the host (one or more labels, not the bare domain); any port',
        examples: [
            ['connect-src https://*.example', 'https://a.example', true],
            ['connect-src https://*.example', 'https://x.y.example', true],
            ['connect-src https://*.example', 'https://example', false],
            ['connect-src https://*.example', 'https://badexample', false],
            ['connect-src https://a.example:*', 'https://a.example:8443', true],
            ['connect-src https://a.example:*', 'https://a.example', true],
            ['connect-src https://*:*', 'wss://a.example:9', false],
            ['connect-src https://*', 'https://a.example', true],
        ],
    },
    {
        kind: 'host', source: '`host/path`', admits: 'nothing: a path admits some of an origin, never the origin (a lone `/` is the whole origin)',
        examples: [
            ['connect-src https://a.example/api', 'https://a.example', false],
            ['connect-src https://a.example/api/', 'https://a.example', false],
            ['connect-src https://a.example/', 'https://a.example', true],
        ],
    },
    {
        kind: 'bare', source: '`host[:port]`, without a scheme', admits: 'nothing: WebKit reads it against the frame\'s own scheme, and Chromium does not take it with a port, so write the scheme',
        examples: [
            ['connect-src a.example', 'https://a.example', false],
            ['connect-src a.example:*', 'https://a.example', false],
            ['connect-src *.example', 'https://a.example', false],
            ['connect-src a.example https://a.example', 'https://a.example', true],
        ],
    },
    {
        kind: 'other', source: 'anything else', admits: "nothing: nonces, hashes, `'unsafe-*'`, `'strict-dynamic'`, `data:`, `blob:`, `filesystem:`, a keyword the parser does not know, a token that is not a source",
        examples: [
            ["connect-src 'unsafe-inline' 'unsafe-eval' 'strict-dynamic'", 'https://a.example', false],
            ["connect-src 'nonce-abc' 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='", 'https://a.example', false],
            ['connect-src https://[::1]', 'https://a.example', false],
            ['connect-src https://a.example.', 'https://a.example', false],
            ['connect-src https://a%2eexample', 'https://a.example', false],
            ['connect-src nonsense!', 'https://a.example', false],
        ],
    },
];

/**
 * The policies of a policy list as `connect-src` sources, ready to ask: a string (the embedder's
 * `hostContentSecurityPolicy`, header or meta syntax) or a list of policy texts.
 */
export function parseHostPolicies(text: string | readonly string[]): readonly ConnectSources[] {
    return Object.freeze(splitPolicies(text).map(connectSources));
}

/** Whether every policy of the list admits `origin`. */
export const hostAdmits = (policies: readonly ConnectSources[], origin: string): boolean =>
    policies.every(policy => connectAdmits(policy, origin));

/** What the host page's policy left of the connect lists. */
export interface NarrowedReach {
    readonly origins: OriginPolicy;
    readonly fetchPolicy: FetchPolicy | null;
}

const list = (origins: readonly string[]) => origins.join(', ');

/**
 * `origins.connect` and `fetchBridge.allow` with the origins the host page's policies refuse dropped, one warning per
 * list. Then `wss://` entries whose `https://` twin was dropped go too (a `wss://` source alone is the one scheme
 * widening, origins.ts). Returns the arguments themselves when nothing is dropped; no policy refuses nothing.
 */
export function narrowToHostPolicy(origins: OriginPolicy, fetchPolicy: FetchPolicy | null, policies: readonly ConnectSources[], warn: (message: string) => void): NarrowedReach {
    if (policies.length === 0) return { origins, fetchPolicy };
    const refused = (entries: readonly Origin[]) => entries.filter(entry => !hostAdmits(policies, entry));
    const because = "the host page's Content-Security-Policy does not admit it in connect-src (or default-src), and the sandbox's frames inherit that policy; the library applies it in every engine";
    const names = policies.some(policy => policy.restricts && policy.sources.some(source => sourceKind(source) === 'self'));
    const advice = `Allow the origin in your page's policy by its scheme and host, or pass hostContentSecurityPolicy (docs/API.md#your-connect-src).${names ? " Your policy names 'self', which engines bind differently in a sandbox document (one admits origins it does not name), so it admits nothing here: list the origin explicitly." : ''}`;

    let nextOrigins = origins;
    const noConnect = refused(origins.connect);
    if (noConnect.length > 0) {
        warn(`[Sandbox] origins.connect dropped ${list(noConnect)}: ${because}. ${advice}`);
        const kept = origins.connect.filter(entry => !noConnect.includes(entry));
        const { kept: paired, orphans } = withHttpsTwins(kept);
        if (orphans.length > 0) warn(`[Sandbox] origins.connect dropped ${list(orphans)}: its https:// twin was dropped, and a wss:// entry alone would let some engines admit https:// requests (docs/API.md#origins).`);
        const connect = Object.freeze(paired);
        nextOrigins = Object.freeze({ ...origins, connect }) as OriginPolicy;
    }

    let nextFetch = fetchPolicy;
    if (fetchPolicy !== null) {
        const noBridge = refused(fetchPolicy.allow);
        if (noBridge.length > 0) {
            warn(`[Sandbox] fetchBridge.allow dropped ${list(noBridge)}: ${because}. ${advice}`);
            nextFetch = Object.freeze({ ...fetchPolicy, allow: Object.freeze(fetchPolicy.allow.filter(entry => !noBridge.includes(entry))) });
        }
    }
    return { origins: nextOrigins, fetchPolicy: nextFetch };
}

/** What the embedder said of the host page's policy: its text, `false` (the page sends none), or nothing (undefined). */
export type HostPolicyOption = string | false | undefined;

/**
 * The warning of a build whose lists were dropped because the embedder did not give the page's policy: the entries
 * dropped, and exactly what to pass.
 */
export function policyNotGiven(dropped: { readonly connect: readonly string[]; readonly allow: readonly string[] }): string {
    const lists: string[] = [];
    if (dropped.connect.length > 0) lists.push(`origins.connect dropped ${list(dropped.connect)}`);
    if (dropped.allow.length > 0) lists.push(`fetchBridge.allow dropped ${list(dropped.allow)}`);
    return `[Sandbox] ${lists.join('; ')}: hostContentSecurityPolicy was not given, so the library does not know your page's Content-Security-Policy, which the sandbox's frames inherit and engines apply differently. Pass hostContentSecurityPolicy: your page's policy as text (as its Content-Security-Policy header or <meta> carries it; several policies separated by commas), or false if your page sends no Content-Security-Policy (docs/API.md#your-connect-src).`;
}

/**
 * The connect lists of one build under the host page's policy, from `hostContentSecurityPolicy` alone: the one decision
 * host.ts `_reach` makes, and the only source of the page's policy (BD4:CHL-1, BD4:CHL-2):
 *  - nothing to narrow (no `origins.connect` and no `fetchBridge.allow` entry): as configured, whatever the option;
 *  - `false` (the page sends no policy): as configured;
 *  - a text: narrowed by it (narrowToHostPolicy);
 *  - left out: every `origins.connect` and `fetchBridge.allow` entry dropped, with one warning (policyNotGiven). It
 *    fails closed: a list is never kept for a policy the library was not given.
 */
export function hostReach(origins: OriginPolicy, fetchPolicy: FetchPolicy | null, option: HostPolicyOption, warn: (message: string) => void): NarrowedReach {
    const configured = { origins, fetchPolicy };
    const allow = fetchPolicy?.allow ?? [];
    if (origins.connect.length === 0 && allow.length === 0) return configured;
    if (option === false) return configured;
    if (typeof option === 'string') return narrowToHostPolicy(origins, fetchPolicy, parseHostPolicies(option), warn);
    warn(policyNotGiven({ connect: origins.connect, allow }));
    const nextOrigins = origins.connect.length === 0 ? origins : Object.freeze({ ...origins, connect: Object.freeze([]) }) as OriginPolicy;
    const nextFetch = fetchPolicy === null || allow.length === 0 ? fetchPolicy : Object.freeze({ ...fetchPolicy, allow: Object.freeze([]) });
    return { origins: nextOrigins, fetchPolicy: nextFetch };
}
