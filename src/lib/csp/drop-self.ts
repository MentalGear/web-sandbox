import type { CSPDirectives } from "../../csp-directives";
import { defineData } from "../utils";
import { assertWidensOnly } from "./effective-directive";
import { policyTokens, type PolicyTokens } from "./policy-grammar";

/**
 * Why the guest policy never contains 'self':
 * the guest document has an opaque origin, and browsers disagree on what 'self' matches there.
 * Measured 2026-10-13 (docs/research/blob-delivery-probe.md, backlog S14): WebKit admits ANY https
 * origin (scripts from it load and run), Chromium admits the host page's origin, Firefox matches
 * nothing. A source whose meaning depends on the engine cannot be part of an allowlist, so it is
 * removed from every directive; the origins a guest needs are listed explicitly instead.
 */
const SELF = "'self'";

const isSelf = (token: unknown) => typeof token === 'string' && token.toLowerCase() === SELF; // CSP keywords are case-insensitive

/**
 * Returns a copy of `directives` with the source expression 'self' removed from every directive,
 * warning once per directive per instance (`warned` is the instance's memory of what it already
 * warned about). Takes only the policy grammar's output (PolicyTokens), so a value "'self' https://a" has been
 * split into two elements before it gets here and cannot carry 'self' through.
 *
 * A directive that held only 'self' is left empty, which generateCSP emits as 'none' (backlog S16):
 * never a fallback to default-src, which can be broader than what the caller asked for.
 */
export function dropSelfSources(directives: PolicyTokens, warned: Set<string>): PolicyTokens {
    policyTokens(directives, 'dropSelfSources');
    const output: Record<string, unknown> = { ...directives };

    for (const [name, values] of Object.entries(directives)) {
        // upgrade-insecure-requests, or a bad value generateCSP rejects (a non-string element stays for it to refuse)
        if (!Array.isArray(values) || !values.some(isSelf)) continue;

        defineData(output, name, values.filter(token => !isSelf(token))); // defined, never assigned (F4)
        if (!warned.has(name)) {
            warned.add(name);
            console.warn(`[Sandbox] "'self'" is not allowed in "connectionsAllowed.${name}" and was dropped. The guest has an opaque origin, for which browsers disagree on what 'self' matches (WebKit admits any https origin); list the origins you need explicitly.`);
        }
    }

    return policyTokens(assertWidensOnly(directives, output as CSPDirectives, [], 'dropSelfSources'), 'dropSelfSources');
}
