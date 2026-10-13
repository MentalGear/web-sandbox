import type { CSPDirectives } from "../../csp-directives";

/**
 * Why the guest policy never contains 'self':
 * the guest document has an opaque origin, and browsers disagree on what 'self' matches there.
 * Measured 2026-10-13 (docs/research/blob-delivery-probe.md, backlog S14): WebKit admits ANY https
 * origin (scripts from it load and run), Chromium admits the host page's origin, Firefox matches
 * nothing. A source whose meaning depends on the engine cannot be part of an allowlist, so it is
 * removed from every directive; the origins a guest needs are listed explicitly instead.
 */
const SELF = "'self'";

const isSelf = (token: string) => token.toLowerCase() === SELF; // CSP keywords are case-insensitive

/**
 * Returns a copy of `directives` with the source expression 'self' removed from every directive,
 * warning once per directive per instance (`warned` is the instance's memory of what it already
 * warned about). Values are split on whitespace, since generateCSP joins them with spaces and a
 * value "'self' https://a" would otherwise carry 'self' through.
 *
 * A directive that held only 'self' becomes 'none'. Left empty, it would be omitted and fall back to
 * default-src (or, for base-uri / form-action, be emitted as 'none' by the generator) — a fallback
 * can be broader than what the caller asked for, an explicit 'none' never is.
 */
export function dropSelfSources(directives: CSPDirectives, warned: Set<string>): CSPDirectives {
    const output: Record<string, unknown> = { ...directives };

    for (const [name, values] of Object.entries(directives)) {
        if (!Array.isArray(values)) continue; // upgrade-insecure-requests, or a bad value generateCSP rejects

        let dropped = false;
        const kept: unknown[] = [];
        for (const value of values) {
            if (typeof value !== 'string') { kept.push(value); continue; } // generateCSP rejects it
            const tokens = value.trim().split(/\s+/);
            const remaining = tokens.filter(token => !isSelf(token));
            if (remaining.length === tokens.length) { kept.push(value); continue; }
            dropped = true;
            if (remaining.length > 0) kept.push(remaining.join(' '));
        }
        if (!dropped) continue;

        output[name] = kept.length > 0 ? kept : ["'none'"];
        if (!warned.has(name)) {
            warned.add(name);
            console.warn(`[Sandbox] "'self'" is not allowed in "connectionsAllowed.${name}" and was dropped. The guest has an opaque origin, for which browsers disagree on what 'self' matches (WebKit admits any https origin); list the origins you need explicitly.`);
        }
    }

    return output as CSPDirectives;
}
