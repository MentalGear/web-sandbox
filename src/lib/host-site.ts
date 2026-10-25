/**
 * The host page's origin and its site for cookies (S74, class A; `INHERITED_CONTEXT.cookies`; BD4:ISO-1, BD4:ISO-3): the
 * one place that reads the host page and says which hosts get the host site's cookies with a request of the sandbox.
 * Every decision about "the host page" (the same-site drop and the private-network rule of `limitHostReach`,
 * config-schema.ts; `fetchBridge.allow`'s rules, fetch-bridge.ts; the bridge's own-origin refusal) reads its input here.
 *
 * The host page's origin (hostPageOrigin) is `self.origin` of the realm the element runs in: the origin of that realm's
 * settings, which is the origin its cookies are keyed by. Never the document's URL alone (`location.origin` reads
 * `'null'` in a same-origin srcdoc or a DOM-built `about:blank` frame, whose realm has the page's real origin and
 * cookies), nor `document.baseURI` (a `<base>` moves it) or `document.domain` (the page can set it).
 *
 * The host page's site (hostSiteOrigins) is not that origin's alone. An engine decides whether a request of a frame is
 * same-site from the frames above it: from every ancestor's origin, or from the top-level document's URL (which one is
 * an engine fact, cookie-facts.ts). So the site rule's one input is the list of every origin whose site counts:
 *  - `self.origin`;
 *  - the document URL's origin, when the page is the top-level document (an opaque top-level page, served with
 *    `Content-Security-Policy: sandbox`, still has its URL's site there);
 *  - every ancestor's origin: `location.ancestorOrigins` where the engine has it, else each ancestor's `origin` read up
 *    the `parent` chain, which a cross-origin ancestor refuses.
 * An entry is `''` where it cannot be read, and `'null'` where it is opaque. Either makes the list undecided
 * (hostSiteUndecided): the rule then cannot say which hosts the engine counts as the host page's site.
 * test/unit/host-site.test.ts scans host-side code for any other reader of the host page.
 *
 * The site needs no probe and no public-suffix list. A cookie is shared by the hosts under one registrable domain, and a
 * registrable domain is a public suffix plus one label, so it always has at least two labels. Hence the rule
 * (`onHostSite`), which can only say "on the site" more often than the browser's list would, never less. An entry is
 * on the site when it is on the site of any origin of the list that is a tuple origin:
 *  - a domain name of two labels or more: the host itself, or any host whose last two labels are the host's
 *    (`api.example.com` and `app.example.com` share `example.com`). Under a public suffix of several labels this also
 *    takes in other sites (`a.github.io` and `b.github.io`, `x.example.co.uk` and `other.co.uk`): an over-refusal, which
 *    the drop warning names, with the fetch bridge (no credentials) as the way to reach such an origin;
 *  - an IP address, `localhost` or any other single-label host: that exact host only.
 * Scheme and port do not matter: cookies ignore both. For an undecided list, `limitHostReach` also refuses every entry
 * that a request carrying cookies can reach in the mode (COOKIE_CARRIERS, cookie-facts.ts).
 *
 * Host-side only, never stringified into a guest.
 */

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Whether `host` is an address (IPv4, or IPv6 as a URL writes it), which is only its own site. */
export const isAddress = (host: string): boolean => IPV4.test(host) || host.includes(':') || host.startsWith('[');

/** The opaque origin's serialization: an origin of the list with it leaves the host page's site undecided. */
export const OPAQUE_ORIGIN = 'null';

/** How many ancestors hostSiteOrigins reads before it counts the rest as unreadable. */
const MAX_ANCESTORS = 64;

/**
 * The host page's origin: `self.origin` of the realm the element runs in (see the module comment), or `''` where the
 * realm has none (no browser realm). The input of the rules about the host page's own origin (the fetch bridge's, the
 * private-network rule's); the site rule reads hostSiteOrigins.
 */
export function hostPageOrigin(): string {
    const origin = (globalThis as { origin?: unknown }).origin;
    return typeof origin === 'string' ? origin : '';
}

/** What hostSiteOrigins reads of a realm: a window's members. A member that is missing or throws counts as unreadable. */
export interface HostRealm {
    readonly origin?: unknown;
    readonly location?: unknown;
    readonly top?: unknown;
    readonly parent?: unknown;
}

const read = (get: () => unknown): unknown => {
    try {
        return get();
    } catch {
        return undefined;
    }
};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Every origin whose site counts as the host page's site (the module comment): `self.origin` first; then, for the
 * top-level document, its URL's origin; for a framed one, every ancestor's origin, nearest first. `''` stands for an
 * origin that cannot be read. The site rule's one input (onHostSite, hostSiteUndecided).
 *
 * @param realm - The element's realm: the global object, except in a test.
 */
export function hostSiteOrigins(realm: HostRealm = globalThis as HostRealm): readonly string[] {
    const own = text(read(() => realm.origin));
    const location = read(() => realm.location) as { readonly origin?: unknown; readonly ancestorOrigins?: unknown } | undefined;
    if (read(() => realm.top) === realm) return Object.freeze([own, text(read(() => location?.origin))]);
    return Object.freeze([own, ...ancestorOrigins(realm, location)]);
}

/** A framed realm's ancestors' origins: `location.ancestorOrigins` where the engine has it, else up the `parent` chain. */
function ancestorOrigins(realm: HostRealm, location: { readonly ancestorOrigins?: unknown } | undefined): string[] {
    const listed = read(() => location?.ancestorOrigins) as { readonly length?: unknown; readonly [index: number]: unknown } | null | undefined;
    if (listed !== undefined && listed !== null && typeof listed.length === 'number') {
        const origins = Array.from({ length: Math.min(listed.length, MAX_ANCESTORS) }, (_, index) => text(read(() => listed[index])));
        // a framed document has an ancestor: an empty list, or one longer than is read, is not every ancestor
        return origins.length === 0 || listed.length > MAX_ANCESTORS ? [...origins, ''] : origins;
    }
    // no location.ancestorOrigins: each ancestor's own origin, which an ancestor of another origin does not give
    const origins: string[] = [];
    let current: unknown = realm;
    for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
        const parent = read(() => (current as HostRealm).parent);
        if (parent === current) return origins.length > 0 ? origins : [''];
        if (parent === null || typeof parent !== 'object') break;
        const origin = text(read(() => (parent as HostRealm).origin));
        origins.push(origin);
        if (origin === '') return origins;
        current = parent;
    }
    return [...origins, ''];
}

/** The host of a tuple origin, lower case and without a trailing dot; null for an opaque, unreadable or unparseable one. */
function hostOf(origin: string): string | null {
    if (origin === OPAQUE_ORIGIN) return null;
    try {
        const host = new URL(origin).hostname.toLowerCase().replace(/\.$/, '');
        return host === '' ? null : host;
    } catch {
        return null;
    }
}

/**
 * Why the host page's site cannot be decided from `siteOrigins` (hostSiteOrigins), as the warning says it; null when
 * every origin of the list is a tuple origin. An undecided list makes `limitHostReach` refuse every entry that a
 * request carrying cookies can reach in the mode.
 */
export function hostSiteUndecided(siteOrigins: readonly string[]): string | null {
    const own = siteOrigins[0] ?? '';
    if (own !== OPAQUE_ORIGIN && hostOf(own) === null) return "the host page's origin is not known";
    if (siteOrigins.includes(OPAQUE_ORIGIN)) return "the host page's site cannot be decided: the page's origin, its top-level URL's or that of a page that frames it is opaque (a sandboxed document)";
    if (siteOrigins.some(origin => hostOf(origin) === null)) return "the host page's site cannot be decided: a page that frames it has another origin, which the browser gives only through location.ancestorOrigins, and this one has none";
    return null;
}

const lastTwoLabels = (host: string): string => host.split('.').slice(-2).join('.');

/** Whether `host` is on the site of a page whose host is `page`: the rule of the module comment. */
function sameSite(host: string, page: string): boolean {
    if (host === page) return true;
    if (isAddress(page) || !page.includes('.')) return false;
    if (isAddress(host)) return false;
    return lastTwoLabels(host) === lastTwoLabels(page);
}

/**
 * Whether `origin` is on the site of a tuple origin of `siteOrigins`: the rule of the module comment. An opaque or
 * unreadable origin of the list puts no entry on its site; hostSiteUndecided says what that leaves undecided.
 *
 * @param origin - An entry, as parseOrigin (origin.ts) wrote it.
 * @param siteOrigins - The origins whose sites count as the host page's site, from hostSiteOrigins().
 */
export function onHostSite(origin: string, siteOrigins: readonly string[]): boolean {
    const host = hostOf(origin);
    return siteOrigins.some(siteOrigin => {
        const page = hostOf(siteOrigin);
        return page !== null && (host === null || sameSite(host, page));
    });
}
