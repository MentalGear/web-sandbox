import { describe, expect, it } from 'vitest';
import { hostRegistrableDomain, isAddress, probeRegistrableDomain, type CookieJar } from '@src/lib/host-site';
import { sharesHostSite } from '@src/lib/origin';

/**
 * The cookie-domain probe (S74, class A) against a jar with a browser's cookie rules: a page can set a cookie for its
 * own host or a parent domain of it, unless that parent is a public suffix. The suffixes here are a toy list; the
 * engines' own are in test/e2e/host-site.spec.ts.
 */

const SUFFIXES = new Set(['com', 'uk', 'co.uk', 'io', 'github.io', 'test']);

/** A document's cookie accessor for a page at `host`: it keeps a cookie whose Domain the page may set, and expires it on Max-Age=0. */
function jarFor(host: string, options: { blocked?: boolean; throws?: boolean } = {}): CookieJar & { log: string[]; stored: Map<string, string> } {
    const stored = new Map<string, string>();
    const log: string[] = [];
    return {
        log,
        stored,
        get cookie() {
            if (options.throws) throw new DOMException('cookies are not available', 'SecurityError');
            return [...stored.entries()].map(([key, value]) => `${key.split('|')[0]}=${value}`).join('; ');
        },
        set cookie(line: string) {
            if (options.throws) throw new DOMException('cookies are not available', 'SecurityError');
            log.push(line);
            if (options.blocked) return;
            const [pair, ...attributes] = line.split(';').map(part => part.trim());
            const [name, value] = pair!.split('=') as [string, string];
            const domain = attributes.find(attribute => attribute.toLowerCase().startsWith('domain='))?.slice(7) ?? host;
            const expired = attributes.includes('Max-Age=0');
            const allowed = domain === host || (host.endsWith(`.${domain}`) && !SUFFIXES.has(domain));
            const key = `${name}|${domain}`;
            if (expired) stored.delete(key);
            else if (allowed) stored.set(key, value);
        },
    };
}

describe('probeRegistrableDomain: ask the browser, no public-suffix list', () => {
    it.each<[string, string]>([
        ['app.example.com', 'example.com'],
        ['example.com', 'example.com'],
        ['a.b.c.example.com', 'example.com'],
        ['www.example.co.uk', 'example.co.uk'],
        ['example.co.uk', 'example.co.uk'],
        ['user.github.io', 'user.github.io'],
        ['deep.user.github.io', 'user.github.io'],
        ['app.test', 'app.test'],
    ])('%s is under %s', (host, domain) => {
        expect(probeRegistrableDomain(host, jarFor(host))).toBe(domain);
    });

    it('a host with no dot, and an address, are their own site without a cookie', () => {
        for (const host of ['localhost', 'intranet', '127.0.0.1', '[::1]', '::1']) {
            const jar = jarFor(host);
            expect(probeRegistrableDomain(host, jar), host).toBe(host);
            expect(jar.log, host).toEqual([]);
        }
        expect(isAddress('127.0.0.1')).toBe(true);
        expect(isAddress('1.example.com')).toBe(false);
    });

    it('leaves no cookie behind, and writes only the probe cookie, with a Max-Age as its own expiry', () => {
        const jar = jarFor('www.example.co.uk');
        expect(probeRegistrableDomain('www.example.co.uk', jar)).toBe('example.co.uk');
        expect(jar.stored.size).toBe(0);
        expect(jar.cookie).toBe('');
        const names = new Set(jar.log.map(line => line.split('=')[0]));
        expect(names.size).toBe(1);
        expect([...names][0]).toMatch(/^__ws_site_probe_[a-z0-9]+$/);
        for (const line of jar.log) expect(line).toMatch(/Max-Age=(10|0)/);
        // from the top-level domain down: uk, co.uk, example.co.uk, each set and read, then removed
        const domains = jar.log.filter(line => line.includes('Max-Age=10')).map(line => /Domain=([^;]+)/.exec(line)?.[1] ?? '(host only)');
        expect(domains).toEqual(['(host only)', 'uk', 'co.uk', 'example.co.uk']);
    });

    it('is null where the probe cannot run: no document, blocked cookies, an accessor that throws', () => {
        expect(probeRegistrableDomain('app.example.com', undefined)).toBeNull();
        expect(probeRegistrableDomain('app.example.com', jarFor('app.example.com', { blocked: true }))).toBeNull();
        expect(probeRegistrableDomain('app.example.com', jarFor('app.example.com', { throws: true }))).toBeNull();
        expect(probeRegistrableDomain('', jarFor('x'))).toBeNull();
    });

    it('host names are folded to lower case', () => {
        expect(probeRegistrableDomain('App.Example.COM', jarFor('app.example.com'))).toBe('example.com');
    });

    it("hostRegistrableDomain asks the page's own document, once per host name; jsdom's page is a single label", () => {
        expect(hostRegistrableDomain('localhost')).toBe('localhost');
        expect(hostRegistrableDomain()).toBe(hostRegistrableDomain(location.hostname));
    });
});

describe('sharesHostSite with the probed registrable domain', () => {
    const HOST = 'https://app.example.co.uk';
    const site = () => 'example.co.uk';

    it.each<[string, boolean]>([
        ['https://app.example.co.uk', true],       // the page's own host
        ['http://app.example.co.uk:8080', true],   // any scheme and port
        ['https://api.example.co.uk', true],       // a sibling
        ['https://deep.api.example.co.uk', true],  // a sibling's subdomain
        ['https://example.co.uk', true],           // the registrable domain (a parent)
        ['https://co.uk', false],                  // a public suffix is above the site, not on it
        ['https://other.co.uk', false],
        ['https://evilexample.co.uk', false],      // a suffix of the string, not of the name
        ['https://example.com', false],
        ['https://127.0.0.1', false],
    ])('%s: %s', (origin, expected) => {
        expect(sharesHostSite(origin, HOST, site)).toBe(expected);
    });

    it('asks for the site only for a name that could be on it: the same last label', () => {
        let asked = 0;
        const counting = () => { asked++; return 'example.co.uk'; };
        expect(sharesHostSite('https://cdn.other.net', HOST, counting)).toBe(false);
        expect(sharesHostSite('https://app.example.co.uk', HOST, counting)).toBe(true);
        expect(sharesHostSite('https://127.0.0.1', HOST, counting)).toBe(false);
        expect(asked).toBe(0);
        expect(sharesHostSite('https://api.example.co.uk', HOST, counting)).toBe(true);
        expect(asked).toBe(1);
    });

    it('falls back to the name check where the probe cannot run: above and below the page, never a sibling', () => {
        for (const noProbe of [undefined, () => null]) {
            expect(sharesHostSite('https://sub.app.example.co.uk', HOST, noProbe)).toBe(true);
            expect(sharesHostSite('https://example.co.uk', HOST, noProbe)).toBe(true);
            expect(sharesHostSite('https://api.example.co.uk', HOST, noProbe)).toBe(false);
        }
    });

    it('an address is only its own site, and a hostOrigin that is not an origin shares nothing', () => {
        expect(sharesHostSite('https://127.0.0.1:9000', 'http://127.0.0.1:3000', () => '127.0.0.1')).toBe(true);
        expect(sharesHostSite('https://127.0.0.2', 'http://127.0.0.1:3000', () => '127.0.0.1')).toBe(false);
        for (const hostOrigin of ['', 'null']) expect(sharesHostSite('https://a.example', hostOrigin, site)).toBe(false);
    });
});
