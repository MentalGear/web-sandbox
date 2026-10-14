import type { CSPDirectives } from "../../csp-directives";

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
    const directives = policy as Record<string, unknown>;
    for (const name of FALLBACK_LISTS[kind]) {
        if (directives[name] !== undefined) return name;
    }
    return null;
}
