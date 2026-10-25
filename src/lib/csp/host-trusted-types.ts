/**
 * The host page's Trusted Types directives, as far as the library needs them (INHERITED_CONTEXT.trustedTypesRequirement):
 * the same two outcomes on every engine, though one of them (Firefox, at the version measured) has no Trusted Types.
 *  - the build: a page that requires Trusted Types for scripts (`require-trusted-types-for 'script'`) and whose
 *    `trusted-types` list does not name the library's policy ends the build with the Trusted Types reason, because the
 *    library's writes then reach a sink as strings, which the page refuses;
 *  - `execute()`: the code of `execute()` is a string evaluated in the guest, which inherits the requirement, and which the
 *    browser refuses there; where the browser has no Trusted Types the library refuses it.
 * Where the browser has Trusted Types (Chromium and WebKit) the browser decides both, and these functions are not asked.
 * Where it has none the library asks them of the policy text the embedder gives (`hostContentSecurityPolicy`) and of nothing
 * else (the library never asks the page for its policy, host-connect.ts), so without the option nothing is applied there and
 * the sandbox builds as the browser lets it. The prediction only ever refuses what Chromium and WebKit refuse
 * (test/e2e/trusted-types-uniform.spec.ts runs the same policies on all three).
 *
 * The grammar is TRUSTED_TYPES_RULES, as values: only what Chromium and WebKit do alike. Where they differ the library follows
 * the specification and the table has no row: the keyword's case (`'SCRIPT'`: WebKit folds it, Chromium does not enforce) and a
 * `require-trusted-types-for` named twice (Chromium counts the first, WebKit both; here the first counts). A list of
 * policies (every policy the page sent, header and meta alike) is read as the browsers read it: a requirement of any policy
 * counts, and the library's policy name must pass every `trusted-types` list.
 *
 * Host-side only, never stringified into a guest.
 */
import { splitPolicies } from './host-connect';

export type TrustedTypesMode = 'strict' | 'sealed' | 'cooperative' | 'worker';

/** What a policy list says of Trusted Types. */
export interface TrustedTypesStance {
    /** Some policy has `require-trusted-types-for 'script'`: a string reaching a script sink is refused. */
    readonly requires: boolean;
    /** Every `trusted-types` list of the policies admits the library's policy name (no list at all admits it). */
    readonly admitsName: boolean;
    /** Every list allows a policy named `default` (names it, or `*`), which the host page may have made to take the element's strings. */
    readonly namesDefault: boolean;
}

const WHITESPACE = /[ \t\n\f\r]+/;

/** The tokens of the first occurrence of each directive of one serialized policy, by lower-cased name. */
function directivesOf(policy: string): Map<string, readonly string[]> {
    const seen = new Map<string, readonly string[]>();
    for (const directive of policy.split(';')) {
        const tokens = directive.split(WHITESPACE).filter(token => token !== '');
        if (tokens.length === 0) continue;
        const name = tokens[0]!.toLowerCase();
        if (!seen.has(name)) seen.set(name, tokens.slice(1));
    }
    return seen;
}

/** What the policies say of Trusted Types, for the policy name `name` (trusted-types.ts: TRUSTED_TYPES_POLICY). */
export function trustedTypesStance(text: string | readonly string[], name: string): TrustedTypesStance {
    let requires = false;
    let admitsName = true;
    let namesDefault = true;
    for (const policy of splitPolicies(text)) {
        const directives = directivesOf(policy);
        if (directives.get('require-trusted-types-for')?.some(token => token.toLowerCase() === "'script'")) requires = true;
        const list = directives.get('trusted-types');
        if (list === undefined) continue;
        // policy names are case-sensitive, keywords are not; `'none'` and `'allow-duplicates'` name no policy
        if (!list.includes('default') && !list.includes('*')) namesDefault = false;
        if (!list.includes('*') && !list.includes(name)) admitsName = false;
    }
    return Object.freeze({ requires, admitsName, namesDefault });
}

/**
 * Whether the build ends with the Trusted Types reason. Strict mode's view and worker mode's frame make their own policy in
 * a document with no default policy, so a refused name ends them whatever the host page's default policy does; the cooperative
 * build writes its frames from the host page's realm, whose default policy (if the host page made one, which lists that all allow
 * `default` suggest) takes the strings, so there such a page does not end it.
 */
export const buildRefused = (stance: TrustedTypesStance, mode: TrustedTypesMode): boolean =>
    stance.requires && !stance.admitsName && (mode !== 'cooperative' || !stance.namesDefault);

/** Whether `execute()` is refused: the page requires Trusted Types for scripts, so a string is not evaluated. */
export const executeRefused = (stance: TrustedTypesStance): boolean => stance.requires;

type Verdict = 'ends' | 'ready';

/** One rule of the grammar, as a value: the unit test checks every example, the docs render the table. */
export interface TrustedTypesRule {
    /** The directive or token, as written in the host page's policy. */
    readonly source: string;
    /** What it does, in words (docs/API.md#host-page-policy). */
    readonly says: string;
    /** A policy, then the build's outcome in strict and worker mode, in cooperative mode, and `execute()`'s. */
    readonly examples: readonly (readonly [policy: string, strictAndWorker: Verdict, cooperative: Verdict, execute: 'refused' | 'runs'])[];
}

export const TRUSTED_TYPES_RULES: readonly TrustedTypesRule[] = [
    {
        source: "`require-trusted-types-for 'script'`", says: "the requirement: strings are refused at script sinks, so `execute()` is refused; the directive's name folds case",
        examples: [
            ["require-trusted-types-for 'script'", 'ready', 'ready', 'refused'],
            ["REQUIRE-TRUSTED-TYPES-FOR 'script'", 'ready', 'ready', 'refused'],
            ["require-trusted-types-for 'script'; TRUSTED-TYPES other", 'ends', 'ends', 'refused'],
            ["require-trusted-types-for 'style'", 'ready', 'ready', 'runs'],
            ["img-src *; connect-src 'self'", 'ready', 'ready', 'runs'],
        ],
    },
    {
        source: '`trusted-types` without the requirement', says: 'names the policies the page lets be made and refuses nothing by itself: a string is still taken, so the build goes on',
        examples: [
            ['trusted-types other', 'ready', 'ready', 'runs'],
            ["trusted-types 'none'", 'ready', 'ready', 'runs'],
        ],
    },
    {
        source: '`trusted-types` naming `web-sandbox`, or `*`', says: "admits the library's policy: the build goes on, with the requirement too",
        examples: [
            ["require-trusted-types-for 'script'; trusted-types web-sandbox", 'ready', 'ready', 'refused'],
            ["require-trusted-types-for 'script'; trusted-types a web-sandbox b 'allow-duplicates'", 'ready', 'ready', 'refused'],
            ["require-trusted-types-for 'script'; trusted-types *", 'ready', 'ready', 'refused'],
            ["require-trusted-types-for 'script'; trusted-types * 'allow-duplicates'", 'ready', 'ready', 'refused'],
        ],
    },
    {
        source: "`trusted-types` naming other policies, or `'none'`", says: "with the requirement the library's policy is refused, and the build ends with the Trusted Types reason; names are case-sensitive",
        examples: [
            ["require-trusted-types-for 'script'; trusted-types other", 'ends', 'ends', 'refused'],
            ["require-trusted-types-for 'script'; trusted-types 'none'", 'ends', 'ends', 'refused'],
            ["require-trusted-types-for 'script'; trusted-types", 'ends', 'ends', 'refused'],
            ["require-trusted-types-for 'script'; trusted-types Web-Sandbox", 'ends', 'ends', 'refused'],
            ["require-trusted-types-for 'script'; trusted-types web-sandbox2", 'ends', 'ends', 'refused'],
            ["trusted-types other; require-trusted-types-for 'script'", 'ends', 'ends', 'refused'],
        ],
    },
    {
        source: '`trusted-types default`', says: "a page whose every list allows a policy named `default` may have made one, which takes the element's strings in cooperative mode; strict and worker mode make their policy in a frame that has none, so a refused name ends them",
        examples: [
            ["require-trusted-types-for 'script'; trusted-types default", 'ends', 'ready', 'refused'],
            ["require-trusted-types-for 'script'; trusted-types default other", 'ends', 'ready', 'refused'],
            ["require-trusted-types-for 'script'; trusted-types default web-sandbox", 'ready', 'ready', 'refused'],
        ],
    },
    {
        source: 'a list of policies', says: 'is read as the browsers do: the requirement of any policy counts, and the library\'s policy must pass every `trusted-types` list',
        examples: [
            ["require-trusted-types-for 'script', trusted-types other", 'ends', 'ends', 'refused'],
            ["trusted-types web-sandbox, require-trusted-types-for 'script'", 'ready', 'ready', 'refused'],
            ["require-trusted-types-for 'script'; trusted-types web-sandbox, trusted-types other", 'ends', 'ends', 'refused'],
            ["require-trusted-types-for 'script'; trusted-types web-sandbox, trusted-types default", 'ends', 'ends', 'refused'],
            ["require-trusted-types-for 'script'; trusted-types default web-sandbox, trusted-types default", 'ends', 'ready', 'refused'],
        ],
    },
];
