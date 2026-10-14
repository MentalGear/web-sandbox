import type { CSPDirectives } from "../../csp-directives";
import { defineData } from "../utils";
import { policyTokens, type PolicyTokens } from "./policy-grammar";

/**
 * Which directive of a policy governs a kind of check: the one table every part of the library that reasons
 * about it reads (follow-up audit 2026-10-14, the A3 class).
 *
 * A browser checks a load (or an inline script, a handler attribute, eval) against its *effective directive*,
 * and when the policy does not hold that directive, against the next one in its *fallback list*, ending with
 * default-src (CSP Level 3, §6.8.3 and §6.8.4). A policy can name several of them: with script-src-elem set, a
 * `<script src>` is checked against it and script-src is never consulted for that load. Before this table the
 * library had two answers: the bootstrap check read script-src-elem → script-src → default-src (review A3),
 * while file sources added blob: to script-src and style-src only, so an embedder who set script-src-elem or
 * style-src-elem got registered files refused. One table, read by every consumer, removes the disagreement.
 *
 * Kinds are named by their CSP Level 3 effective directive; 'eval' is the check for string compilation
 * (EnsureCSPDoesNotBlockStringCompilation), which reads script-src, then default-src.
 *
 * Self-contained module scope is fine: host-side only, never stringified into a guest.
 */
const FALLBACK_LISTS = {
    'script-src-elem': ['script-src-elem', 'script-src', 'default-src'],
    'script-src-attr': ['script-src-attr', 'script-src', 'default-src'],
    'style-src-elem': ['style-src-elem', 'style-src', 'default-src'],
    'style-src-attr': ['style-src-attr', 'style-src', 'default-src'],
    'worker-src': ['worker-src', 'child-src', 'script-src', 'default-src'],
    'frame-src': ['frame-src', 'child-src', 'default-src'],
    'connect-src': ['connect-src', 'default-src'],
    'img-src': ['img-src', 'default-src'],
    'font-src': ['font-src', 'default-src'],
    'media-src': ['media-src', 'default-src'],
    'object-src': ['object-src', 'default-src'],
    'manifest-src': ['manifest-src', 'default-src'],
    'prefetch-src': ['prefetch-src', 'default-src'],
    'eval': ['script-src', 'default-src'],
} as const satisfies Record<string, readonly (keyof CSPDirectives)[]>;

/** A kind of check, named by its CSP Level 3 effective directive ('eval': string compilation). */
export type LoadKind = keyof typeof FALLBACK_LISTS;

/** A directive that can govern some kind of check. */
export type GoverningDirective = (typeof FALLBACK_LISTS)[LoadKind][number];

/** The fallback list of `kind`, most specific first, default-src last. */
export function fallbackList(kind: LoadKind): readonly GoverningDirective[] {
    return FALLBACK_LISTS[kind];
}

/**
 * The directive of `policy` that governs `kind`: the first of its fallback list the policy holds (any value,
 * even one generateCSP will refuse), or null when it holds none of them. A null answer means "default-src",
 * since the generator always emits one ('none' unless configured).
 */
export function effectiveDirective(policy: CSPDirectives, kind: LoadKind): GoverningDirective | null {
    for (const name of FALLBACK_LISTS[kind]) {
        if (directiveOf(policy, name) !== undefined) return name;
    }
    return null;
}

/** A directive's value if the policy holds it as its own key, else undefined: a directive is never inherited (F4). */
export function directiveOf(policy: CSPDirectives, name: string): unknown {
    return Object.hasOwn(policy, name) ? (policy as Record<string, unknown>)[name] : undefined;
}

const tokensOf = (values: readonly unknown[]): string[] => {
    const tokens: string[] = [];
    for (const value of values) {
        if (typeof value !== 'string') continue; // generateCSP rejects it later
        for (const token of value.trim().split(/\s+/)) {
            if (token) tokens.push(token);
        }
    }
    return tokens;
};

/**
 * default-src's sources as a directive created in its place starts with them: every token but 'none' and 'self'
 * (CSP keywords are case-insensitive). Empty when default-src is absent, empty or 'none'. A step that has to give
 * one kind of load something of its own, where only default-src governs it, creates that kind's own directive
 * from these, so the kind keeps what default-src allowed it and nothing else is widened (file-sources.ts, and
 * addEvalSource below).
 */
export function inheritedDefaultSources(policy: CSPDirectives): string[] {
    const values = directiveOf(policy, 'default-src');
    if (!Array.isArray(values)) return [];
    return tokensOf(values).filter(token => token.toLowerCase() !== "'none'" && token.toLowerCase() !== "'self'");
}

/** Every kind of check the table knows, for a step's postcondition (assertWidensOnly). */
export const LOAD_KIND_LIST = Object.keys(FALLBACK_LISTS) as LoadKind[];

const EVAL_SOURCES = ["'unsafe-eval'", "'wasm-unsafe-eval'"];
const ATTRIBUTE_KINDS: readonly LoadKind[] = ['script-src-attr', 'style-src-attr'];

/**
 * The sources that decide `kind`'s checks in `policy`: the tokens of the directive that governs it (effectiveDirective),
 * as a set, keywords lower-cased (CSP keywords and schemes are case-insensitive), 'none' left out (it is the empty set).
 * Only what can decide that kind counts: 'eval' reads only 'unsafe-eval' and 'wasm-unsafe-eval', which nothing else
 * reads; an attribute check loads no URL, so only quoted sources (keywords, hashes) count there. So blob: added to
 * script-src for registered scripts changes no handler attribute and no eval check, while blob: reaching worker-src
 * through script-src does change worker-src.
 */
export function effectiveSources(policy: CSPDirectives, kind: LoadKind): Set<string> {
    const governing = effectiveDirective(policy, kind);
    const values = governing === null ? undefined : directiveOf(policy, governing);
    const sources = new Set<string>();
    if (!Array.isArray(values)) return sources; // none, or a bad value generateCSP refuses: nothing it admits
    for (const raw of tokensOf(values)) {
        const token = raw.toLowerCase();
        if (token === "'none'") continue;
        const evalSource = EVAL_SOURCES.includes(token);
        if (kind === 'eval' ? !evalSource : evalSource) continue;
        if (ATTRIBUTE_KINDS.includes(kind) && !token.startsWith("'")) continue;
        sources.add(token);
    }
    return sources;
}

/**
 * The postcondition of every policy step (broad review 2026-10-14, PA1): a step may add sources only to the kinds of
 * check it names (`mayWiden`); for every other kind the sources after the step are a subset of those before
 * (effectiveSources). Throws when a step widened another kind, so the build fails closed with a reason ('the
 * environment could not be built') instead of shipping the wider policy. Returns `after`.
 *
 * Why at every step rather than at the end: what a kind falls back to depends on which directives exist, so a step
 * that creates or extends one directive for one kind can change what another kind is checked against. File sources
 * did: blob: added to (or a script-src created for) registered scripts also reached worker-src through its fallback
 * to script-src, when the policy had no worker-src or child-src.
 */
export function assertWidensOnly<T extends CSPDirectives>(before: CSPDirectives, after: T, mayWiden: Iterable<LoadKind>, step: string): T {
    const allowed = new Set(mayWiden);
    for (const kind of LOAD_KIND_LIST) {
        if (allowed.has(kind)) continue;
        const was = effectiveSources(before, kind);
        for (const source of effectiveSources(after, kind)) {
            if (!was.has(source)) throw new Error(`[Sandbox] the policy step ${step} would add ${source} to what ${kind} admits; refused.`);
        }
    }
    return after;
}

const UNSAFE_EVAL = "'unsafe-eval'";

/**
 * Grants string compilation (eval, new Function; 'unsafe-eval' covers WebAssembly too) where the table says a
 * browser checks it: the directive that governs 'eval', script-src, or default-src when the policy has no
 * script-src. It is never added to default-src, which is the fallback of every other kind of load: script-src is
 * created instead, from default-src's sources (inheritedDefaultSources), so the scripts it now governs keep what
 * default-src allowed them. The one place the keyword is written (focused review 2026-10-14, F5): scriptUnsafe in
 * iframe and worker mode (host.ts) and the strict view (strict-policy.ts). Before, the host appended it with
 * `directives["script-src"]?.push(...)`, which did nothing at all for a policy without script-src.
 * A script-src that is not a list is left for generateCSP to refuse.
 */
export function addEvalSource(policy: PolicyTokens): PolicyTokens {
    policyTokens(policy, 'addEvalSource');
    const output = { ...policy } as CSPDirectives;
    const current = effectiveDirective(policy, 'eval') === 'script-src' ? directiveOf(policy, 'script-src') : inheritedDefaultSources(policy);
    if (!Array.isArray(current)) return output as PolicyTokens;
    defineData(output, 'script-src', [...current, UNSAFE_EVAL]);
    return policyTokens(assertWidensOnly(policy, output, ['eval'], 'addEvalSource'), 'addEvalSource');
}
