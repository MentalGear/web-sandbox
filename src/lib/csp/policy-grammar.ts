import type { CSPDirectives } from "../../csp-directives";
import { defineData } from "../utils";

/**
 * The grammar every guest policy is held to (adversarial review 2026-10, A1/A2).
 *
 * A policy is one string: directives separated by ';', a directive's name and sources separated by
 * whitespace, and a browser keeps the FIRST occurrence of a directive name. So a ';' or ',' inside a
 * configured source, or whitespace or ';' inside a configured directive name, would let a config emit
 * directives of its own choosing ahead of the ones the library fixes: in strict mode a `default-src` value of
 * "'none'; script-src-attr 'unsafe-inline'" would have run handler attributes in the view. Joining and
 * trimming cannot prevent that; only refusing anything that is not one name or one source can.
 *
 * So, by construction, at the one place a policy string is made (generateCSP) and at the start of the host's
 * pipeline (so every later step sees the same tokens):
 *   - a directive name is kept only if it is one of KNOWN_DIRECTIVES, exactly (lower case, nothing around it);
 *   - each value is split on ASCII whitespace into tokens, and a token is kept only if it is one CSP source
 *     expression: a keyword, a nonce or hash, a scheme, or a host with optional scheme, port and path. None of
 *     them can contain ';', ',', a quote outside the keyword forms, whitespace or a control character.
 * Everything else is dropped, with a warning through `onDrop`. A directive left with no token is emitted as
 * 'none' (S16), never omitted, so dropping can only narrow.
 *
 * Every later step of the host's pipeline takes only what this grammar returns (PolicyTokens, independent
 * verification 2026-10-14, A1): a step reads a list one element at a time, so a configured element holding several
 * sources ("'unsafe-inline' 'unsafe-eval'", "blob: data:") would carry the source it removes past it, and
 * generateCSP's own split would emit it. The type keeps a raw config out at compile time, and each step checks its
 * input again at run time (policyTokens), so a caller that casts fails the build closed instead.
 *
 * Self-contained module scope is fine: host-side only, never stringified into a guest.
 */

/**
 * The directive names a guest policy may carry: CSP Level 3's fetch, document and navigation directives that
 * a <meta> policy honours, plus frame-ancestors (dropped from the guest policy with its own warning, S7) and
 * upgrade-insecure-requests. Kept equal to the keys of CSPDirectives by a type test.
 */
export const KNOWN_DIRECTIVES = [
    'default-src', 'script-src', 'script-src-elem', 'script-src-attr', 'style-src', 'style-src-elem', 'style-src-attr',
    'img-src', 'font-src', 'connect-src', 'media-src', 'object-src', 'frame-src', 'child-src', 'worker-src',
    'manifest-src', 'prefetch-src', 'base-uri', 'form-action', 'frame-ancestors', 'upgrade-insecure-requests',
] as const;

const KEYWORDS = [
    "'self'", "'none'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", "'strict-dynamic'",
    "'unsafe-hashes'", "'report-sample'", "'unsafe-allow-redirects'", "'inline-speculation-rules'",
];

// 'nonce-<base64>' and 'sha256|384|512-<base64>' (base64 or base64url, up to two '=').
const NONCE_OR_HASH = /^'(nonce|sha256|sha384|sha512)-[A-Za-z0-9+/_-]+={0,2}'$/i;
// scheme-source: "https:", "blob:", "data:" …
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:$/;
// host-source: [scheme "://"] host [":" port] [path]. A host is "*", or labels of letters, digits and '-',
// optionally after "*."; a port is digits or "*"; a path is "/" followed by URL path characters, with no ';',
// ',' or quote (CSP requires those to be percent-encoded in a path).
const HOST = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?(?:\*|(?:\*\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)(?::(?:[0-9]{1,5}|\*))?(?:\/[A-Za-z0-9\-._~!$&+=:@%/]*)?$/;

/** Whether `token` (no whitespace) is one CSP source expression. Keywords are case-insensitive. */
export function isSourceExpression(token: string): boolean {
    if (token.startsWith("'")) return KEYWORDS.includes(token.toLowerCase()) || NONCE_OR_HASH.test(token);
    return SCHEME.test(token) || HOST.test(token);
}

declare const POLICY_TOKENS: unique symbol;

/**
 * A policy whose every list holds one source per element (the grammar's output, and every later step's): the only
 * input the policy steps accept. Made by sanitizeDirectives, or checked by policyTokens.
 */
export type PolicyTokens = CSPDirectives & { readonly [POLICY_TOKENS]: true };

// a list element that is not one token: empty, or holding ASCII whitespace
const UNSPLIT = /^$|[\t\n\f\r ]/;

/**
 * `directives` as PolicyTokens, after checking that every string in every list is one token; throws otherwise, naming
 * `step`, so the build fails closed ('the environment could not be built'). Non-strings are left for generateCSP to
 * refuse. Every policy step calls it on what it is given.
 */
export function policyTokens(directives: CSPDirectives, step: string): PolicyTokens {
    for (const [name, values] of Object.entries(directives)) {
        if (!Array.isArray(values)) continue;
        for (const value of values) {
            if (typeof value === 'string' && UNSPLIT.test(value)) {
                throw new Error(`[Sandbox] the policy step ${step} was given ${JSON.stringify(value.slice(0, 64))} in "${name}", which is not one source: only the policy grammar's output may reach it; refused.`);
            }
        }
    }
    return directives as PolicyTokens;
}

/** Whether `name` is one of KNOWN_DIRECTIVES, exactly. */
export const isKnownDirective = (name: string): boolean => (KNOWN_DIRECTIVES as readonly string[]).includes(name);

// ASCII whitespace, the separator inside a directive (CSP Level 3, §2.2.1).
const ASCII_WHITESPACE = /[\t\n\f\r ]+/;

// A name or token as it may appear in a warning: clamped, and JSON-quoted so control characters show.
const shown = (value: string) => JSON.stringify(value.slice(0, 64));

/** The tokens of one directive's values that are source expressions; every other token goes to `onDrop`. */
function sourcesOf(name: string, values: unknown[], onDrop: (message: string) => void): unknown[] {
    const kept: unknown[] = [];
    for (const value of values) {
        if (typeof value !== 'string') {
            kept.push(value); // generateCSP refuses it: a wrong type is an error, not something to drop
            continue;
        }
        for (const token of value.split(ASCII_WHITESPACE)) {
            if (token === '') continue;
            if (isSourceExpression(token)) {
                kept.push(token);
                continue;
            }
            onDrop(`[Sandbox] "connectionsAllowed.${name}" had the source ${shown(token)}, which is not one CSP source expression, and it was dropped: a source is one keyword, nonce, hash, scheme or host, with no ';', ',' or quote inside (see docs/security/ADVERSARIAL-REVIEW-2026-10.md, A1).`);
        }
    }
    return kept;
}

/**
 * Returns a copy of `directives` holding only known directive names and, in each list, only tokens that are
 * source expressions (one array element per token). Everything dropped is reported through `onDrop`, one
 * message per name or token. A value that is not an array is passed on unchanged for generateCSP to refuse,
 * except for upgrade-insecure-requests, which has no value.
 */
export function sanitizeDirectives(directives: CSPDirectives, onDrop: (message: string) => void = () => {}): PolicyTokens {
    const output: Record<string, unknown> = {};
    for (const [name, values] of Object.entries(directives)) {
        if (!isKnownDirective(name)) {
            onDrop(`[Sandbox] "connectionsAllowed" had the directive name ${shown(name)}, which is not one this sandbox supports, and it was dropped: one lower-case directive name per key (${KNOWN_DIRECTIVES.join(', ')}).`);
            continue;
        }
        // defined, never assigned (utils.ts, F4); only known names get here anyway
        if (name === 'upgrade-insecure-requests' || !Array.isArray(values)) {
            defineData(output, name, values);
            continue;
        }
        defineData(output, name, sourcesOf(name, values, onDrop));
    }
    return policyTokens(output as CSPDirectives, 'sanitizeDirectives');
}
