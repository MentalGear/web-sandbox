/**
 * The host page's site for cookies (S74, class A; `INHERITED_CONTEXT.cookies`): which hosts get the host site's cookies
 * with a request of the sandbox. A cookie is shared by the hosts under one registrable domain (`example.com` for
 * `app.example.com`, `example.co.uk` for `www.example.co.uk`, and the host itself under a public suffix such as
 * `github.io`), and where that line falls is the browser's public-suffix list, which the library does not bundle and
 * would have to keep current. It asks the browser instead, the way analytics libraries find a cookie domain: a page may
 * set a cookie for a parent domain of its host unless that domain is a public suffix, so the longest run of labels the
 * browser refuses, and the shortest it accepts, is the registrable domain.
 *
 * The probe, once per host name and only when an `origins` entry could be on the site (sharesHostSite, origin.ts):
 *  1. a host-only test cookie is set and read back, and removed: if it does not stick (cookies are blocked, the page has
 *     no cookie jar, the setter throws), the probe cannot run and the caller keeps its name heuristic (null);
 *  2. for each parent domain of the host, from the top-level domain down, the same cookie is set with `Domain=` that
 *     name; the first the browser keeps is the registrable domain, and the cookie is removed at once;
 *  3. a host with no parent the browser accepts is its own site.
 * The test cookie has a name of its own (random per probe), the value `1`, `Max-Age=10` so that a crash between the
 * write and the removal cannot leave it, and is set and removed in one synchronous run, so no request of this page
 * carries it; another tab's request in that instant could, and it holds nothing. An IP address, a single-label host and a
 * host that is not a name are decided from the name alone, without a cookie.
 *
 * Host-side only, never stringified into a guest. A unit test (test/unit/host-site.test.ts) runs it against a jar with
 * the cookie rules; test/e2e/host-site.spec.ts runs it in each engine, against hosts of a public-suffix list's every kind.
 */

/** What the probe needs of a document: its cookie accessor. */
export interface CookieJar {
    cookie: string;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Whether `host` is an address (IPv4, or IPv6 as a URL writes it), which is only its own site. */
export const isAddress = (host: string): boolean => IPV4.test(host) || host.includes(':') || host.startsWith('[');

/** A cookie name no page uses: the probe's, random per probe. */
const probeName = (): string => `__ws_site_probe_${Math.random().toString(36).slice(2, 10)}`;

function holds(jar: CookieJar, name: string): boolean {
    return jar.cookie.split(';').some(part => part.trim().startsWith(`${name}=`));
}

/**
 * Sets the test cookie (`Domain=domain`, or host-only when `domain` is null), reports whether the browser kept it, and
 * removes it again.
 */
function accepts(jar: CookieJar, name: string, domain: string | null): boolean {
    const scope = domain === null ? '' : `; Domain=${domain}`;
    jar.cookie = `${name}=1${scope}; Path=/; Max-Age=10; SameSite=Lax`;
    const kept = holds(jar, name);
    jar.cookie = `${name}=${scope}; Path=/; Max-Age=0; SameSite=Lax`;
    return kept;
}

/**
 * The registrable domain of `hostname` as `jar`'s browser decides it, or null when the browser's cookie rules cannot be
 * asked (see the module comment). `hostname` is the host of the page whose jar it is (`location.hostname`).
 */
export function probeRegistrableDomain(hostname: string, jar: CookieJar | undefined): string | null {
    const host = hostname.toLowerCase();
    if (host === '') return null;
    if (isAddress(host) || !host.includes('.')) return host;
    if (!jar) return null;
    const name = probeName();
    try {
        // a jar that keeps no host-only cookie cannot tell a refused domain from a jar that refuses everything
        if (!accepts(jar, name, null)) return null;
        const labels = host.split('.');
        for (let from = labels.length - 1; from >= 1; from--) {
            const domain = labels.slice(from).join('.');
            if (accepts(jar, name, domain)) return domain;
        }
        return host;
    } catch {
        return null;
    }
}

const known = new Map<string, string | null>();

/**
 * The registrable domain of the host page (`location.hostname`) in this browser: probeRegistrableDomain against the
 * page's own `document`, once per host name. Null where the probe cannot run (no document; cookies blocked; a page
 * whose cookie accessor throws), and then the caller decides by name alone.
 */
export function hostRegistrableDomain(hostname: string = globalThis.location?.hostname ?? ''): string | null {
    if (known.has(hostname)) return known.get(hostname)!;
    let jar: CookieJar | undefined;
    try {
        jar = globalThis.document;
    } catch {
        jar = undefined;
    }
    const domain = probeRegistrableDomain(hostname, jar);
    known.set(hostname, domain);
    return domain;
}
