import type { CSPDirectives } from "../../csp-directives";

/**
 * Directives a policy delivered in a <meta> element cannot use (CSP Level 3, §3.3): the browser discards
 * them, and Chromium says so on the console (research 11.1, backlog S7). The guest policy is always a
 * <meta> policy, so emitting one of them would only look like control: a consumer who sets
 * frame-ancestors believes they restricted embedding and has configured nothing.
 *
 * Where each concern is handled instead:
 *   frame-ancestors        who embeds the sandbox is decided by the page that hosts the element
 *   report-uri, report-to  violations are reported in the guest, by securitypolicyviolation (backlog S5)
 *   sandbox                the sandbox flags come from `capabilities` / `unsafeCapabilities`
 */
export const META_IGNORED_DIRECTIVES = ['frame-ancestors', 'report-uri', 'report-to', 'sandbox'] as const;

const INSTEAD: Record<(typeof META_IGNORED_DIRECTIVES)[number], string> = {
    'frame-ancestors': 'Who may embed the sandbox is up to the page that hosts the element.',
    'report-uri': "Violations are reported in the guest instead (see backlog S5).",
    'report-to': "Violations are reported in the guest instead (see backlog S5).",
    'sandbox': 'Use "capabilities" for the sandbox flags.',
};

// CSP directive names are case-insensitive, so 'Frame-Ancestors' is the same directive.
const ignoredUnderMeta = (name: string) =>
    (META_IGNORED_DIRECTIVES as readonly string[]).find(directive => directive === name.toLowerCase());

/**
 * Returns a copy of `directives` without the directives a <meta> policy discards, warning once per
 * directive per instance (`warned` is the instance's memory of what it already warned about), whatever
 * value it had. The directive is left out, not emitted as 'none': any value, 'none' included, would be
 * discarded by the browser just the same. Every other directive is passed on untouched, so an empty one
 * still becomes 'none' in generateCSP (backlog S16).
 */
export function dropMetaIgnoredDirectives(directives: CSPDirectives, warned: Set<string>): CSPDirectives {
    const output: Record<string, unknown> = {};

    for (const [name, values] of Object.entries(directives)) {
        const ignored = ignoredUnderMeta(name);
        if (!ignored) {
            output[name] = values;
            continue;
        }
        if (warned.has(ignored)) continue;
        warned.add(ignored);
        console.warn(`[Sandbox] "connectionsAllowed.${name}" was dropped: the guest policy is delivered in a <meta> element, where browsers ignore ${ignored}, so it would restrict nothing. ${INSTEAD[ignored as keyof typeof INSTEAD]}`);
    }

    return output as CSPDirectives;
}
