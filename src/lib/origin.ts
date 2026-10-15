/**
 * The one parser for an origin an embedder lists (ADR-007): `origins` (the guest policy) and `fetchBridge.allow`
 * (ADR-006) both take exact origins, and both read them here.
 *
 * An entry is accepted only when it is already written as one origin: a scheme the caller's rules admit, "://", a
 * host, an optional port, an optional trailing "/". Nothing the WHATWG URL parser would quietly rewrite gets through,
 * because the host it parsed must be the host as written (ASCII case aside):
 *
 *   accepted   https://api.example   https://API.example:8443/   https://127.0.0.1:9000   http://localhost:5173
 *   refused    https:  *  https://*.example  'self'  data:  blob:  https://a.example/path  https://u@a.example
 *              https://a.example.  (trailing dot)    https://bücher.example  (write the xn-- form)
 *              https://127.1  https://0x7f.0.0.1  (not the address as written)    https://[::1]  (no IPv6 literal:
 *              CSP's host grammar cannot express one)    https://a%2eexample  " https://a.example"  https:\\a.example
 *
 * A default port is dropped (https://a.example:443 is https://a.example); case is folded. So the result is one
 * canonical string per origin, and the brand (`Origin`) says it came from here: the policy generator takes nothing
 * else, and checks the pattern again (ORIGIN_PATTERN), so a cast cannot carry a source expression into a policy.
 *
 * Host-side only, never stringified into a guest.
 */

declare const ORIGIN_BRAND: unique symbol;

/** An exact origin (scheme://host[:port]), canonical, produced only by parseOrigin(). */
export type Origin = string & { readonly [ORIGIN_BRAND]: true };

/** The schemes an entry may have: `anyHost` for every host, `loopbackOnly` only for LOOPBACK_HOSTS. */
export interface OriginRules {
    readonly anyHost: readonly string[];
    readonly loopbackOnly: readonly string[];
}

/** The hosts plain http: may name in a guest policy, for local development. (IPv6 [::1] cannot be written in CSP.) */
export const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];

// One DNS label: letters, digits and '-', not at either end; at most 63 characters.
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';

/**
 * What every Origin matches: a scheme, a host of dot-separated labels (an IPv4 address is such a host), an
 * optional port without a leading zero. No quote, whitespace, ';', ',', '*', '/', '%', '@' or '\' can occur.
 */
export const ORIGIN_PATTERN = new RegExp(`^[a-z][a-z0-9+.-]*://${LABEL}(?:\\.${LABEL})*(?::[1-9][0-9]{0,4})?$`);

// The entry as written: scheme "://" host [":" port] ["/"]. The host is any run of characters but the
// delimiters, so the URL parser's own reading can be compared with it.
const WRITTEN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#@\\:[\]\s%*]+)(?::([0-9]+))?\/?$/;
const HOST = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

/**
 * `entry` as an Origin under `rules`, or null. Null for anything that is not a string written as one origin
 * (see the module comment); the caller drops it with a warning.
 */
export function parseOrigin(entry: unknown, rules: OriginRules): Origin | null {
    if (typeof entry !== 'string' || entry.length > 2048) return null;
    // Printable ASCII only, tested before anything is folded (review round 1, R1-4): toLowerCase() maps a few non-ASCII
    // letters to ASCII ones (U+212A KELVIN SIGN to "k", U+0130 to "i̇"), so a non-ASCII name could pass as written.
    if (!/^[\x21-\x7e]+$/.test(entry)) return null;
    const written = WRITTEN.exec(entry);
    if (!written) return null;
    const [, scheme, host, port] = written as unknown as [string, string, string, string | undefined];
    const protocol = `${scheme.toLowerCase()}:`;
    const name = host.toLowerCase();
    const admitted = rules.anyHost.includes(protocol) || (rules.loopbackOnly.includes(protocol) && LOOPBACK_HOSTS.includes(name));
    if (!admitted || !HOST.test(name) || name.length > 253) return null;
    if (port !== undefined && !/^[1-9][0-9]{0,4}$/.test(port)) return null;

    let url: URL;
    try {
        url = new URL(entry);
    } catch {
        return null;
    }
    // the parser's host must be the host as written: no IPv4 shorthand, no IDNA mapping, no percent-decoding
    if (url.protocol !== protocol || url.hostname !== name) return null;
    const origin = `${protocol}//${url.host}`;
    return ORIGIN_PATTERN.test(origin) ? (origin as Origin) : null;
}
