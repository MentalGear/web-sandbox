/**
 * The host page's Content-Security-Policy as text (`hostContentSecurityPolicy`), split into its policies: what every
 * reading of it starts from, the Trusted Types one (host-trusted-types.ts) in every build and the network modes'
 * `connect-src` one (host-connect.ts).
 *
 * Host-side only, never stringified into a guest.
 */

/**
 * A policy list as separate policies. A string is a serialized policy list as a header or a `<meta>` carries it:
 * policies separated by commas (`Content-Security-Policy: a, b` is two policies); a list is taken as it is, one policy
 * per entry.
 */
export function splitPolicies(text: string | readonly string[]): string[] {
    const policies = typeof text === 'string' ? text.split(',') : text;
    return policies.map(policy => policy.trim()).filter(policy => policy !== '');
}
