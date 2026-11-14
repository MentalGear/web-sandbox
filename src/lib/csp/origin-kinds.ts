/**
 * The kinds of load a policy has a directive for, and the empty policy: what every build's policy templates
 * (csp-generator.ts) are written over. The `origins` option that fills a policy with origins, and its parser, are the
 * network modes' (origins.ts), which sealed mode never reaches (ADR-008).
 *
 * Host-side only, never stringified into a guest.
 */
import type { Origin } from '../origin';
import { defineData } from '../utils';

/** Every kind, in the order the policy emits their directives. */
export const ORIGIN_KINDS = ['scripts', 'styles', 'images', 'fonts', 'media', 'connect'] as const;

/** A kind of load a policy has a directive for: every list of `origins`. */
export type OriginKind = (typeof ORIGIN_KINDS)[number];

/** `origins` as parsed: every kind present, every entry an Origin; frozen, lists included. */
export type OriginPolicy = { readonly [K in OriginKind]: readonly Origin[] };

function emptyPolicy(): OriginPolicy {
    const policy: Record<string, readonly Origin[]> = {};
    for (const kind of ORIGIN_KINDS) defineData(policy, kind, Object.freeze([]));
    return Object.freeze(policy) as OriginPolicy;
}

/** The empty policy: no origin for any kind. */
export const NO_ORIGINS: OriginPolicy = emptyPolicy();

// An entry as it may appear in a warning: a string clamped and JSON-quoted (control characters show), else its type.
// Every config warning shows a value through it (R1:R1-3): JSON.stringify of a BigInt or a cyclic entry would throw
// and refuse the whole config.
export const shown = (value: unknown) => (typeof value === 'string' ? JSON.stringify(value.slice(0, 64)) : `a value of type ${value === null ? 'null' : typeof value}`);
