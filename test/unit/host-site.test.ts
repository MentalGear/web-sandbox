import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hostOriginKnown, hostPageOrigin, isAddress, onHostSite, OPAQUE_ORIGIN } from '@src/lib/host-site';
import { normaliseConfig } from '@src/lib/config-schema';
import { STRINGIFIED } from '@src/lib/realms';
import { SyntaxKind, tokenize } from '../../scripts/js-tokens';

/**
 * The host page's origin and site (src/lib/host-site.ts, S74 class A), the one chokepoint of every decision about the
 * host page: the rule over host × entry pairs, its soundness against a public-suffix list (it may refuse more than the
 * list, never less), what `limitHostReach` makes of it, and a scan that keeps every other source of the host page's
 * origin out of host-side code.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('onHostSite: the rule, over host × entry pairs', () => {
    it.each<[host: string, entry: string, expected: boolean]>([
        // a name of two labels or more: the host, or a host that shares its last two labels; scheme and port do not matter
        ['https://app.example.com', 'https://app.example.com', true],
        ['https://app.example.com', 'http://app.example.com:8080', true],
        ['https://app.example.com', 'wss://app.example.com', true],
        ['https://app.example.com', 'https://api.example.com', true],          // a sibling
        ['https://app.example.com', 'https://deep.api.example.com', true],     // a sibling's subdomain
        ['https://app.example.com', 'https://example.com', true],              // the parent
        ['https://example.com', 'https://cdn.example.com', true],              // a child
        ['https://app.example.com', 'https://com', false],                     // a single label is a public suffix
        ['https://app.example.com', 'https://example.net', false],
        ['https://app.example.com', 'https://evilexample.com', false],         // a suffix of the string, not of the name
        ['https://app.example.com', 'https://app.example.com.evil.net', false],
        ['https://app.example.com', 'https://203.0.113.7', false],
        // a public suffix of several labels: two sites share their last two labels, so the rule refuses both (over-refusal)
        ['https://www.example.co.uk', 'https://api.example.co.uk', true],
        ['https://www.example.co.uk', 'https://other.co.uk', true],
        ['https://www.example.co.uk', 'https://co.uk', true],
        ['https://www.example.co.uk', 'https://example.com', false],
        ['https://alice.github.io', 'https://bob.github.io', true],
        ['https://alice.github.io', 'https://github.io', true],
        ['https://alice.github.io', 'https://alice.gitlab.io', false],
        // an address, localhost and a single label: that host only
        ['http://127.0.0.1:3000', 'https://127.0.0.1:9000', true],
        ['http://127.0.0.1:3000', 'https://127.0.0.2', false],
        ['http://127.0.0.1:3000', 'https://0.1', false],
        ['http://[::1]:3000', 'http://[::1]:4000', true],
        ['http://localhost:5173', 'http://localhost:9000', true],
        ['http://localhost:5173', 'https://app.localhost', false],
        ['http://intranet', 'http://intranet:8080', true],
        ['http://intranet', 'http://wiki.intranet', false],
        // *.localhost is a name of two labels or more
        ['http://a.app.localhost', 'http://b.app.localhost', true],
        ['http://app.localhost', 'http://api.localhost', false],
        // the trailing dot of a fully qualified host is not part of the comparison
        ['https://app.example.com.', 'https://api.example.com', true],
        // case
        ['https://APP.Example.com', 'https://api.example.com', true],
    ])('a page at %s: %s is on its site: %s', (host, entry, expected) => {
        expect(onHostSite(entry, host)).toBe(expected);
    });

    it("an opaque host origin ('null') has no site: nothing is on it", () => {
        for (const entry of ['https://app.example.com', 'http://localhost:1', 'https://127.0.0.1']) expect(onHostSite(entry, OPAQUE_ORIGIN), entry).toBe(false);
        expect(hostOriginKnown(OPAQUE_ORIGIN)).toBe(true);
    });

    it('a host origin that is not known (empty, not an origin) puts every entry on its site: refused', () => {
        for (const host of ['', 'about:blank', 'not an origin', 'https://']) {
            expect(hostOriginKnown(host), host).toBe(false);
            for (const entry of ['https://app.example.com', 'https://other.example', 'http://localhost:1']) expect(onHostSite(entry, host), `${host} ${entry}`).toBe(true);
        }
    });

    it('isAddress: IPv4 and bracketed IPv6, not a name that starts with a digit', () => {
        expect(isAddress('127.0.0.1')).toBe(true);
        expect(isAddress('[::1]')).toBe(true);
        expect(isAddress('1.example.com')).toBe(false);
    });

    it("hostPageOrigin is the realm's self.origin (jsdom's page here)", () => {
        expect(hostPageOrigin()).toBe(globalThis.origin);
    });
});

// The soundness of the rule: against a public-suffix list (a fixture of every kind: one label, several labels, a private
// section's), every pair the list puts on one site the rule puts on one site too. It never says "another site" where the
// browser would send the host site's cookies.
describe('onHostSite is never narrower than a public-suffix list', () => {
    const SUFFIXES = ['com', 'uk', 'co.uk', 'io', 'github.io', 'test', 'net', 'jp', 'kyoto.jp', 'ide.kyoto.jp', 'localhost'];
    const registrable = (host: string): string => {
        if (isAddress(host) || !host.includes('.')) return host;
        const labels = host.split('.');
        let longest = 1; // the implicit "*" rule: an unknown top-level label is a suffix
        for (let from = 0; from < labels.length; from++) if (SUFFIXES.includes(labels.slice(from).join('.'))) { longest = Math.max(longest, labels.length - from); }
        return labels.length > longest ? labels.slice(-(longest + 1)).join('.') : host;
    };
    const LABELS = ['a', 'b', 'example', 'co', 'uk', 'github', 'io', 'com', 'test', 'kyoto', 'jp', 'ide', 'localhost'];
    const hosts: string[] = ['127.0.0.1', '10.0.0.5', '[::1]'];
    for (const x of LABELS) {
        hosts.push(x);
        for (const y of LABELS) {
            hosts.push(`${x}.${y}`);
            for (const z of ['com', 'uk', 'io', 'jp', 'test', 'localhost']) hosts.push(`${x}.${y}.${z}`);
        }
    }
    hosts.push('a.ide.kyoto.jp', 'b.ide.kyoto.jp', 'x.a.ide.kyoto.jp', 'a.b.github.io', 'a.example.co.uk', 'b.example.co.uk');

    it(`over ${hosts.length} × ${hosts.length} pairs`, () => {
        let pairs = 0;
        let overRefused = 0;
        for (const page of hosts) {
            for (const entry of hosts) {
                const pageOrigin = `https://${page}`;
                const entryOrigin = `https://${entry}`;
                const sameSite = registrable(page) === registrable(entry);
                const said = onHostSite(entryOrigin, pageOrigin);
                if (sameSite && !said) throw new Error(`${entry} is on the site of ${page} (${registrable(page)}), and the rule says it is not`);
                if (!sameSite && said) overRefused++;
                pairs++;
            }
        }
        expect(pairs).toBe(hosts.length ** 2);
        expect(overRefused, 'the rule refuses more than the list somewhere (a suffix of several labels)').toBeGreaterThan(0);
    }, 60_000);
});

describe('limitHostReach, on the rule: what each host origin keeps', () => {
    const said = (hostOrigin: string, connect: string[]) => normaliseConfig({ mode: 'cooperative', origins: { connect } }, { hostOrigin });
    const DROP = /^\[Sandbox\] origins\.connect dropped /;

    it('a sibling under a public suffix of several labels is dropped, with the over-refusal and the fetch bridge named', () => {
        const result = said('https://alice.github.io', ['https://bob.github.io', 'https://cdn.other.net']);
        expect(result.value!.origins.connect).toEqual(['https://cdn.other.net']);
        const dropped = result.warnings.filter(message => DROP.test(message));
        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toContain("https://bob.github.io (on the host page's site)");
        expect(dropped[0]).toContain('github.io');
        expect(dropped[0]).toContain('may be refused too');
        expect(dropped[0]).toContain('fetchBridge.allow');
    });

    it("an opaque host origin keeps its entries, with one warning per kind that says the page's origin is opaque; a private one is still dropped", () => {
        const result = normaliseConfig({ mode: 'cooperative', origins: { connect: ['https://app.example.com', 'http://localhost:9'], images: ['https://img.example.com'] } }, { hostOrigin: OPAQUE_ORIGIN });
        expect(result.value!.origins.connect).toEqual(['https://app.example.com']);
        expect(result.value!.origins.images).toEqual(['https://img.example.com']);
        const opaque = result.warnings.filter(message => message.includes('whose origin is opaque'));
        expect(opaque).toHaveLength(2);
        expect(opaque.filter(message => message.includes('origins.connect lists https://app.example.com from a host page whose origin is opaque'))).toHaveLength(1);
        expect(result.warnings.filter(message => message.includes('origins.connect dropped http://localhost:9 (a loopback, private or link-local host)'))).toHaveLength(1);
    });

    it('a host origin that is not known drops every entry, and says why', () => {
        const result = said('', ['https://api.other.example', 'https://cdn.other.net']);
        expect(result.value!.origins.connect).toEqual([]);
        expect(result.warnings.filter(message => DROP.test(message))).toEqual([expect.stringContaining("https://api.other.example (the host page's origin is not known), https://cdn.other.net (the host page's origin is not known)")]);
    });
});

// Every decision about the host page reads its origin from hostPageOrigin (self.origin of the element's realm). The
// document's URL (location.origin, location.hostname) differs from it in a same-origin srcdoc or a DOM-built about:blank
// frame, and document.cookie is the page's to wrap: neither is read by host-side code. The in-sandbox bootstraps (the
// modules the realms registry stringifies into a sandbox document) run in their own realms, and are not host-side.
describe('host-side code reads the host page only through host-site.ts', () => {
    const BOOTSTRAPS = new Set<string>(Object.values(STRINGIFIED).map(row => row.module).filter(module => module !== 'src/host.ts'));
    const hostSide = (): string[] => {
        const files = ['src/host.ts'];
        const walk = (dir: string) => {
            for (const name of readdirSync(path.join(ROOT, dir))) {
                const relative = `${dir}/${name}`;
                if (statSync(path.join(ROOT, relative)).isDirectory()) walk(relative);
                else if (relative.endsWith('.ts') && !relative.endsWith('.test.ts') && !BOOTSTRAPS.has(relative)) files.push(relative);
            }
        };
        walk('src/lib');
        return files;
    };
    const FORBIDDEN: Record<string, readonly string[]> = { location: ['origin', 'hostname'], document: ['cookie'] };

    /** `object.member`, `object?.member` and `object['member']` in code (not comments), as `object.member` per line. */
    function reads(text: string): string[] {
        const tokens = tokenize(text);
        const found: string[] = [];
        tokens.forEach((token, index) => {
            if (token.kind !== SyntaxKind.Identifier || !Object.hasOwn(FORBIDDEN, token.text)) return;
            const access = tokens[index + 1];
            const member = access && (access.kind === SyntaxKind.DotToken || access.kind === SyntaxKind.QuestionDotToken) ? tokens[index + 2]
                : access?.kind === SyntaxKind.OpenBracketToken ? tokens[index + 2] : undefined;
            const name = member?.kind === SyntaxKind.StringLiteral ? member.text.slice(1, -1) : member?.text;
            if (name !== undefined && FORBIDDEN[token.text]!.includes(name)) found.push(`${token.text}.${name} (line ${text.slice(0, token.start).split('\n').length})`);
        });
        return found;
    }

    it('the scan sees each form it forbids, in code only', () => {
        expect(reads("const a = globalThis.location?.origin; const b = location['hostname']; document.cookie = 'x';")).toHaveLength(3);
        expect(reads("// location.origin\n/* document.cookie */ const c = 'location.origin';")).toEqual([]);
    });

    it('no host-side file reads location.origin, location.hostname or document.cookie', () => {
        const files = hostSide();
        expect(files).toContain('src/lib/host-site.ts');
        expect(files).toContain('src/lib/config-schema.ts');
        expect(files).not.toContain('src/lib/in-sandbox-script.ts');
        const offending = files.flatMap(file => reads(readFileSync(path.join(ROOT, file), 'utf8')).map(read => `${file}: ${read}`));
        expect(offending).toEqual([]);
    });
});
