/**
 * The host page's origin and its site for cookies (S74, class A; `INHERITED_CONTEXT.cookies`): the one place that says
 * which origin the host page has and which hosts get the host site's cookies with a request of the sandbox. Every
 * decision about "the host page" (the same-site drop and the private-network rule of `limitHostReach`, config-schema.ts;
 * `fetchBridge.allow`'s rules, fetch-bridge.ts; the bridge's own-origin refusal) reads its input here.
 *
 * The host page's origin is `self.origin` of the realm the element runs in: the origin of that realm's settings, which
 * is the origin its cookies are keyed by. Never the document's URL (`location.origin` reads `'null'` in a same-origin
 * srcdoc or a DOM-built `about:blank` frame, whose realm has the page's real origin and cookies), nor `document.baseURI`
 * (a `<base>` moves it), `document.domain` (the page can set it) or `top` (another origin's, or unreadable).
 * test/unit/host-site.test.ts scans host-side code for any other source of it.
 *
 * The site needs no probe and no public-suffix list. A cookie is shared by the hosts under one registrable domain, and a
 * registrable domain is a public suffix plus one label, so it always has at least two labels. Hence the rule
 * (`onHostSite`), which can only say "on the site" more often than the browser's list would, never less:
 *  - a domain name of two labels or more: the host itself, or any host whose last two labels are the host's
 *    (`api.example.com` and `app.example.com` share `example.com`). Under a public suffix of several labels this also
 *    takes in other sites (`a.github.io` and `b.github.io`, `x.example.co.uk` and `other.co.uk`): an over-refusal, which
 *    the drop warning names, with the fetch bridge (no credentials) as the way to reach such an origin;
 *  - an IP address, `localhost` or any other single-label host: that exact host only;
 *  - an opaque host origin (`'null'`, a sandboxed host document): no site of its own, so no entry is on it (a request
 *    from it carries only another site's cookies, as any cross-site request does); `limitHostReach` keeps its entries
 *    and says so;
 *  - a host origin that is neither (empty, unparseable): undecided, so every entry counts as on the site (refused).
 * Scheme and port do not matter: cookies ignore both.
 *
 * Host-side only, never stringified into a guest.
 */

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Whether `host` is an address (IPv4, or IPv6 as a URL writes it), which is only its own site. */
export const isAddress = (host: string): boolean => IPV4.test(host) || host.includes(':') || host.startsWith('[');

/** The opaque origin's serialization: a host page with it has no site of its own. */
export const OPAQUE_ORIGIN = 'null';

/**
 * The host page's origin: `self.origin` of the realm the element runs in (see the module comment), or `''` where the
 * realm has none (no browser realm), which every rule here treats as undecided.
 */
export function hostPageOrigin(): string {
    const origin = (globalThis as { origin?: unknown }).origin;
    return typeof origin === 'string' ? origin : '';
}

/** The host of a tuple origin, lower case and without a trailing dot; null for an opaque or unparseable one. */
function hostOf(origin: string): string | null {
    if (origin === OPAQUE_ORIGIN) return null;
    try {
        const host = new URL(origin).hostname.toLowerCase().replace(/\.$/, '');
        return host === '' ? null : host;
    } catch {
        return null;
    }
}

/** Whether `hostOrigin` is decided: a tuple origin or the opaque one. Any other value makes onHostSite refuse every entry. */
export const hostOriginKnown = (hostOrigin: string): boolean => hostOrigin === OPAQUE_ORIGIN || hostOf(hostOrigin) !== null;

const lastTwoLabels =(host: string): string => host.split('.').slice(-2).join('.');

/**
 * Whether a request of the sandbox to `origin` can carry the host site's cookies: the rule of the module comment. True
 * for a `hostOrigin` that is undecided (neither a tuple origin nor `'null'`), false for an opaque one.
 *
 * @param origin - An entry, as parseOrigin (origin.ts) wrote it.
 * @param hostOrigin - The host page's origin, from hostPageOrigin().
 */
export function onHostSite(origin: string, hostOrigin: string): boolean {
    if (hostOrigin === OPAQUE_ORIGIN) return false;
    const page = hostOf(hostOrigin);
    if (page === null) return true;
    const host = hostOf(origin);
    if (host === null) return true;
    if (host === page) return true;
    if (isAddress(page) || !page.includes('.')) return false;
    if (isAddress(host)) return false;
    return lastTwoLabels(host) === lastTwoLabels(page);
}
