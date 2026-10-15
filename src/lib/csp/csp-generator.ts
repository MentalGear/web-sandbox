import { ORIGIN_PATTERN, type Origin } from "../origin";
import { admits, LOAD_KIND_NAMES, LOAD_KINDS } from "../load-kinds";
import type { OriginKind, OriginPolicy } from "./origins";

/**
 * The guest policy: one template per mode, filled with the parsed origins (origins.ts) and the library's own
 * sources (ADR-007). The one place a policy string is made.
 *
 * Every directive is emitted, always, in a fixed order, with 'none' where it admits nothing, so no browser ever
 * consults a fallback chain and no input can change which directives exist or what the fixed ones say. An embedder
 * can only add Origins to the six directives of `origins`; everything else here is the library's:
 *
 *   cooperative (iframe and worker mode)              strict view (ADR-005; its worker inherits it)
 *   default-src 'none'                                 default-src 'none'
 *   script-src 'unsafe-inline' <scripts> [blob:]       script-src 'sha256-<bootstrap>' ['unsafe-eval']
 *              ['unsafe-eval']                         script-src-attr 'none'
 *   style-src 'unsafe-inline' <styles> [blob:]         style-src 'unsafe-inline' <styles> [blob:]
 *   img-src <images> [blob:]                           img-src <images> [blob:]
 *   font-src <fonts> [blob:]                           font-src <fonts> [blob:]
 *   media-src <media> [blob:]                          media-src <media> [blob:]
 *   connect-src <connect> [blob:]                      connect-src <connect> [blob:]
 *   worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none';
 *   upgrade-insecure-requests                          (the same for both)
 *
 * Why each fixed part:
 *   - script-src 'unsafe-inline' (cooperative): the library's bootstrap is an inline script, and without it there is
 *     no bridge, no sandboxFiles, no violation reports and WebRTC stays available. No nonce, hash or
 *     'strict-dynamic' is ever emitted there, so a browser never ignores 'unsafe-inline'.
 *   - 'unsafe-eval' only with scriptUnsafe, only in script-src (never in default-src, which no directive here
 *     falls back to anyway).
 *   - blob: per kind only for the registered files of this build (fileKinds(), from the one load-kind table), so a
 *     file is admitted exactly for the loads that may name it (ADR-004). Strict mode never puts blob: in
 *     script-src: its view runs no guest script and its worker is classic.
 *   - worker-src blob: alone: the library's workers start from blob: URLs, and WebKit ran a data: SharedWorker
 *     outside the policy (broad review PD1). frame-src, object-src, base-uri, form-action and manifest-src 'none'
 *     (research 12, S9). No 'self' anywhere: browsers disagree on what it matches for the guest's opaque origin
 *     (S14). No data: anywhere: a data: SVG opened in a new tab runs script (ST1); registered files cover the need.
 *   - upgrade-insecure-requests: a plain-http origin (loopback only) still loads, upgraded where the engine does so.
 *   - prefetch-src is not emitted: it is not a CSP Level 3 directive (Chromium warns about it); any engine that
 *     still reads it falls back to default-src 'none'.
 *
 * Host-side only, never stringified into a guest.
 */

/** The directive each kind of `origins` adds its origins to. */
export const KIND_DIRECTIVES = {
    scripts: 'script-src',
    styles: 'style-src',
    images: 'img-src',
    fonts: 'font-src',
    media: 'media-src',
    connect: 'connect-src',
} as const satisfies Record<OriginKind, string>;

/** What a policy is made from, besides its mode. */
export interface PolicyInput {
    origins: OriginPolicy;
    /** The kinds of load this build's registered files need blob: for (fileKinds()). */
    fileKinds: ReadonlySet<OriginKind>;
    /** Adds 'unsafe-eval' to script-src. */
    scriptUnsafe: boolean;
}

type Directive = readonly [name: string, sources: readonly string[]];

const NONE = "'none'";
const UNSAFE_INLINE = "'unsafe-inline'";
const UNSAFE_EVAL = "'unsafe-eval'";
const BLOB = 'blob:';
const HASH_SOURCE = /^'sha256-[A-Za-z0-9+/]{43}='$/;

// The directives that are the same for every input and every mode.
const FIXED: readonly Directive[] = [
    ['worker-src', [BLOB]],
    ['frame-src', []],
    ['object-src', []],
    ['base-uri', []],
    ['form-action', []],
    ['manifest-src', []],
];

/** The kinds of load files of these types need blob: for, read from the one load-kind table (load-kinds.ts). */
export function fileKinds(types: Iterable<string>): Set<OriginKind> {
    const kinds = new Set<OriginKind>();
    for (const type of types) {
        for (const kind of LOAD_KIND_NAMES) if (admits(kind, type)) kinds.add(LOAD_KINDS[kind].key);
    }
    return kinds;
}

/** iframe and worker mode: the guest document's policy, which worker mode's worker inherits. */
export function cooperativePolicy(input: PolicyInput): string {
    return format([
        ['default-src', []],
        ['script-src', [UNSAFE_INLINE, ...sourcesOf(input, 'scripts'), ...(input.scriptUnsafe ? [UNSAFE_EVAL] : [])]],
        ['style-src', [UNSAFE_INLINE, ...sourcesOf(input, 'styles')]],
        ...fetchDirectives(input),
        ...FIXED,
    ]);
}

/** Strict mode: the view's policy (ADR-005), admitting only the bootstrap by its hash; the worker inherits it. */
export function strictViewPolicy(input: PolicyInput & { bootstrapHash: string }): string {
    if (!HASH_SOURCE.test(input.bootstrapHash)) throw new Error('[Sandbox] the strict view policy needs the bootstrap as one sha256 hash source.');
    return format([
        ['default-src', []],
        ['script-src', [input.bootstrapHash, ...(input.scriptUnsafe ? [UNSAFE_EVAL] : [])]],
        ['script-src-attr', []],
        ['style-src', [UNSAFE_INLINE, ...sourcesOf(input, 'styles')]],
        ...fetchDirectives(input),
        ...FIXED,
    ]);
}

// The four directives both templates fill the same way. Strict mode never reads `scripts`.
const fetchDirectives = (input: PolicyInput): Directive[] => [
    ['img-src', sourcesOf(input, 'images')],
    ['font-src', sourcesOf(input, 'fonts')],
    ['media-src', sourcesOf(input, 'media')],
    ['connect-src', sourcesOf(input, 'connect')],
];

/** A kind's origins, each checked against ORIGIN_PATTERN again (a cast cannot carry a source in), then blob: if its files need it. */
function sourcesOf(input: PolicyInput, kind: OriginKind): string[] {
    const sources: string[] = [];
    for (const origin of input.origins[kind] as readonly Origin[]) {
        if (typeof origin !== 'string' || !ORIGIN_PATTERN.test(origin)) throw new Error(`[Sandbox] the policy was given something that is not an origin for ${KIND_DIRECTIVES[kind]}; refused.`);
        sources.push(origin);
    }
    if (input.fileKinds.has(kind)) sources.push(BLOB);
    return sources;
}

function format(directives: readonly Directive[]): string {
    const parts: string[] = [];
    for (const [name, sources] of directives) parts.push(`${name} ${sources.length === 0 ? NONE : sources.join(' ')}`);
    parts.push('upgrade-insecure-requests');
    return parts.join('; ');
}
