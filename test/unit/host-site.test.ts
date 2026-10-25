import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hostPageOrigin, hostSiteOrigins, hostSiteUndecided, isAddress, onHostSite, OPAQUE_ORIGIN, type HostRealm } from '@src/lib/host-site';
import { normaliseConfig, UNDECIDED_SITE_RULE, type SandboxMode } from '@src/lib/config-schema';
import { COOKIE_CARRIERS, cookieCarriersIn } from '@src/lib/cookie-facts';
import { ORIGIN_KINDS } from '@src/lib/csp/origins';
import { STRINGIFIED } from '@src/lib/realms';
import { SyntaxKind, tokenize } from '../../scripts/js-tokens';

/**
 * The host page's origin and site (src/lib/host-site.ts, S74 class A; BD4:ISO-1, BD4:ISO-3), the one chokepoint of every
 * decision about the host page: what it reads of the element's realm in each layout (top-level, framed by the same
 * site or another, opaque, with ancestors that cannot be read), the rule over host × entry pairs, its soundness against
 * a public-suffix list (it may refuse more than the list, never less), what `limitHostReach` makes of it in each mode
 * (an undecided site refuses every entry a cookie carrier of the mode reaches, COOKIE_CARRIERS), and a scan that keeps
 * every other reader of the host page out of host-side code.
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
        expect(onHostSite(entry, [host])).toBe(expected);
    });

    it('an entry is on the site of any tuple origin of the list; an opaque or unreadable one puts nothing on its site', () => {
        expect(onHostSite('https://api.framer.net', ['https://app.example.com', 'https://www.framer.net'])).toBe(true);
        expect(onHostSite('https://cdn.example.com', ['https://app.example.com', 'https://www.framer.net'])).toBe(true);
        expect(onHostSite('https://api.other.org', ['https://app.example.com', 'https://www.framer.net'])).toBe(false);
        for (const list of [[OPAQUE_ORIGIN], [''], ['not an origin'], ['https://'], [], [OPAQUE_ORIGIN, '']]) {
            for (const entry of ['https://app.example.com', 'http://localhost:1', 'https://127.0.0.1']) expect(onHostSite(entry, list), `${JSON.stringify(list)} ${entry}`).toBe(false);
        }
    });

    it('isAddress: IPv4 and bracketed IPv6, not a name that starts with a digit', () => {
        expect(isAddress('127.0.0.1')).toBe(true);
        expect(isAddress('[::1]')).toBe(true);
        expect(isAddress('1.example.com')).toBe(false);
    });

    it("hostPageOrigin is the realm's self.origin, and hostSiteOrigins reads the realm itself (jsdom's top-level page here)", () => {
        expect(hostPageOrigin()).toBe(globalThis.origin);
        expect(hostSiteOrigins()).toEqual([globalThis.origin, globalThis.location.origin]);
        expect(hostSiteUndecided(hostSiteOrigins())).toBeNull();
    });
});

// The host page as each layout gives it to the element's realm. A fake realm has the members hostSiteOrigins reads; an
// ancestor of another origin throws on `origin`, as a WindowProxy does.
const H = 'https://app.example.com';
const S = 'https://cdn.example.com';  // H's sibling
const X = 'https://www.framer.net';   // another site, which frames the host page in some layouts
const E = 'https://api.other.org';    // a site that is no page's: the positive control
const EI = 'https://img.other.org';

type Ancestor = { origin: string; readable: boolean };
function topRealm(origin: string, url = origin): HostRealm {
    const realm: { origin: string; location: object; top?: unknown; parent?: unknown } = { origin, location: { origin: url } };
    realm.top = realm;
    realm.parent = realm;
    return realm;
}
/** A realm framed by `ancestors` (nearest first, the last is the top), with `location.ancestorOrigins` or without. */
function framedRealm(origin: string, ancestors: Ancestor[], withAncestorOrigins: boolean): HostRealm {
    const windows = ancestors.map(({ origin: own, readable }) => {
        const window: Record<string, unknown> = {};
        Object.defineProperty(window, 'origin', { get: () => { if (!readable) throw new DOMException('Blocked a frame', 'SecurityError'); return own; } });
        return window;
    });
    windows.forEach((window, index) => { window.parent = windows[index + 1] ?? window; window.top = windows[windows.length - 1]; });
    const location = withAncestorOrigins ? { origin: 'null', ancestorOrigins: Object.assign([...ancestors.map(a => a.origin)], { item: () => null }) } : { origin: 'null' };
    return { origin, location, top: windows[windows.length - 1], parent: windows[0] };
}
const ancestor = (origin: string, readable = false): Ancestor => ({ origin, readable });

/** Each layout: the realm, the list it gives, and whether the site is decided. */
const LAYOUTS: Record<string, { realm: HostRealm; sites: string[]; decided: boolean }> = {
    'top-level page': { realm: topRealm(H), sites: [H, H], decided: true },
    'top-level page, opaque (served with CSP sandbox)': { realm: topRealm(OPAQUE_ORIGIN, H), sites: [OPAQUE_ORIGIN, H], decided: false },
    'top-level about:blank of the page': { realm: topRealm(H, OPAQUE_ORIGIN), sites: [H, OPAQUE_ORIGIN], decided: false },
    'framed by the same site (ancestorOrigins)': { realm: framedRealm(H, [ancestor(S)], true), sites: [H, S], decided: true },
    'framed by another site (ancestorOrigins)': { realm: framedRealm(H, [ancestor(X)], true), sites: [H, X], decided: true },
    'framed twice (ancestorOrigins)': { realm: framedRealm(H, [ancestor(S), ancestor(X)], true), sites: [H, S, X], decided: true },
    'opaque, in a sandboxed frame of the same site': { realm: framedRealm(OPAQUE_ORIGIN, [ancestor(H)], true), sites: [OPAQUE_ORIGIN, H], decided: false },
    'framed by an opaque page': { realm: framedRealm(H, [ancestor(OPAQUE_ORIGIN)], true), sites: [H, OPAQUE_ORIGIN], decided: false },
    'framed, ancestorOrigins empty': { realm: framedRealm(H, [], true), sites: [H, ''], decided: false },
    'framed by the same origin, no ancestorOrigins: read up the parent chain': { realm: framedRealm(H, [ancestor(H, true)], false), sites: [H, H], decided: true },
    'framed by another site, no ancestorOrigins: unreadable': { realm: framedRealm(H, [ancestor(X)], false), sites: [H, ''], decided: false },
    'framed by the same origin under another site, no ancestorOrigins': { realm: framedRealm(H, [ancestor(H, true), ancestor(X)], false), sites: [H, H, ''], decided: false },
    'no browser realm': { realm: {}, sites: ['', ''], decided: false },
};

describe('hostSiteOrigins: every origin whose site counts, in each layout', () => {
    it.each(Object.entries(LAYOUTS))('%s', (_, { realm, sites, decided }) => {
        const read = hostSiteOrigins(realm);
        expect(read).toEqual(sites);
        expect(Object.isFrozen(read)).toBe(true);
        expect(hostSiteUndecided(read) === null).toBe(decided);
    });

    it('a member that throws is unreadable, never an error', () => {
        const hostile = { get origin() { throw new Error('x'); }, get location() { throw new Error('x'); }, get top() { throw new Error('x'); }, get parent() { throw new Error('x'); } };
        expect(hostSiteOrigins(hostile)).toEqual(['', '']);
    });

    it('says why the site is undecided: an origin not known, an opaque one, an ancestor that cannot be read', () => {
        expect(hostSiteUndecided(['', ''])).toBe("the host page's origin is not known");
        expect(hostSiteUndecided([OPAQUE_ORIGIN, H])).toContain('is opaque (a sandboxed document)');
        expect(hostSiteUndecided([H, OPAQUE_ORIGIN])).toContain('is opaque (a sandboxed document)');
        expect(hostSiteUndecided([H, ''])).toContain('location.ancestorOrigins');
        expect(hostSiteUndecided([H, X])).toBeNull();
    });
});

describe('limitHostReach, on the rule: what each layout keeps in each mode', () => {
    // the entries: another site (E: kept wherever the site is decided), H's sibling S, the framing site X, each with its wss:// twin
    const ORIGINS = { connect: [E, E.replace('https:', 'wss:'), S, S.replace('https:', 'wss:'), X, X.replace('https:', 'wss:')], images: [EI, S, X] };
    const wss = (origin: string) => origin.replace('https:', 'wss:');
    const run = (layout: string, mode: SandboxMode) => {
        const sites = LAYOUTS[layout]!.sites;
        return normaliseConfig({ mode, origins: ORIGINS }, { hostOrigin: sites[0]!, hostSites: sites });
    };

    // [layout, mode, connect kept, images kept]
    it.each<[string, SandboxMode, string[], string[]]>([
        // decided: what is on the site of the page's origin and its ancestors' is dropped in every mode; the rest is kept
        ['top-level page', 'strict', [E, X], [EI, X]],
        ['top-level page', 'worker', [E, wss(E), X, wss(X)], [EI, X]],
        ['top-level page', 'cooperative', [E, wss(E), X, wss(X)], [EI, X]],
        ['framed by another site (ancestorOrigins)', 'strict', [E], [EI]],
        ['framed by another site (ancestorOrigins)', 'worker', [E, wss(E)], [EI]],
        ['framed by another site (ancestorOrigins)', 'cooperative', [E, wss(E)], [EI]],
        ['framed by the same origin, no ancestorOrigins: read up the parent chain', 'worker', [E, wss(E), X, wss(X)], [EI, X]],
        // undecided: what is on a readable origin's site is dropped in every mode, and so is every entry a cookie carrier
        // of the mode reaches: none in strict mode, wss:// in worker mode, every list in cooperative mode
        ['top-level page, opaque (served with CSP sandbox)', 'strict', [E, X], [EI, X]],
        ['top-level page, opaque (served with CSP sandbox)', 'worker', [E, X], [EI, X]],
        ['top-level page, opaque (served with CSP sandbox)', 'cooperative', [], []],
        ['opaque, in a sandboxed frame of the same site', 'worker', [E, X], [EI, X]],
        ['opaque, in a sandboxed frame of the same site', 'cooperative', [], []],
        ['framed by an opaque page', 'strict', [E, X], [EI, X]],
        ['framed by an opaque page', 'worker', [E, X], [EI, X]],
        ['framed by an opaque page', 'cooperative', [], []],
        ['framed by another site, no ancestorOrigins: unreadable', 'strict', [E, X], [EI, X]],
        ['framed by another site, no ancestorOrigins: unreadable', 'worker', [E, X], [EI, X]],
        ['framed by another site, no ancestorOrigins: unreadable', 'cooperative', [], []],
        ['no browser realm', 'worker', [E, S, X], [EI, S, X]],
        ['no browser realm', 'cooperative', [], []],
    ])('%s, %s mode', (layout, mode, connect, images) => {
        const result = run(layout, mode);
        expect(result.value!.origins.connect).toEqual(connect);
        expect(result.value!.origins.images).toEqual(images);
    });

    it('every entry dropped for an undecided site is named in one warning per kind, with why and the carriers of the mode', () => {
        const layout = 'framed by another site, no ancestorOrigins: unreadable';
        const worker = run(layout, 'worker').warnings.filter(message => message.includes("(the host page's site is undecided)"));
        expect(worker).toHaveLength(1);
        expect(worker[0]).toMatch(/^\[Sandbox\] origins\.connect dropped /);
        for (const origin of [wss(E), wss(X)]) expect(worker[0]).toContain(`${origin} (the host page's site is undecided)`);
        expect(worker[0]).not.toContain(wss(S)); // on the page's own site: dropped as that
        expect(worker[0]).toContain(hostSiteUndecided(LAYOUTS[layout]!.sites)!);
        expect(worker[0]).toContain(`that ${COOKIE_CARRIERS.websocket.short} can reach`);
        expect(worker[0]).toContain(UNDECIDED_SITE_RULE);

        const cooperative = run(layout, 'cooperative').warnings.filter(message => message.includes("(the host page's site is undecided)"));
        expect(cooperative.map(message => /^\[Sandbox\] origins\.(\w+) dropped /.exec(message)?.[1])).toEqual(['images', 'connect']);
        expect(cooperative[1]).toContain(`${E} (the host page's site is undecided)`);
        // strict mode: nothing is dropped for it
        expect(run(layout, 'strict').warnings.filter(message => message.includes('undecided'))).toEqual([]);
    });

    it("an entry on a readable origin's site is dropped as on the site, before the undecided rule", () => {
        const said = run('top-level page, opaque (served with CSP sandbox)', 'cooperative').warnings;
        expect(said.filter(message => message.includes(`${S} (on the host page's site)`))).toHaveLength(2);
        expect(said.filter(message => message.includes(`${S} (the host page's site is undecided)`))).toEqual([]);
    });

    it('the undecided rule refuses what COOKIE_CARRIERS says the mode reaches, kind by kind', () => {
        // every kind, an https and a wss entry: the kinds and schemes each mode's carriers reach, from the table's rows
        const listed = Object.fromEntries(ORIGIN_KINDS.map(kind => [kind, kind === 'connect' ? [E, wss(E)] : [E]]));
        for (const mode of ['strict', 'worker', 'cooperative'] as const) {
            const { origins } = normaliseConfig({ mode, origins: listed }, { hostOrigin: H, hostSites: [H, ''] }).value!;
            const refused = ORIGIN_KINDS.flatMap(kind => (listed[kind] ?? []).filter(entry => !(origins[kind] as readonly string[]).includes(entry) && !(mode === 'strict' && entry.startsWith('wss:')) && !(mode === 'strict' && kind === 'scripts')).map(entry => `${kind} ${entry}`));
            const reached = ORIGIN_KINDS.flatMap(kind => (listed[kind] ?? []).filter(entry => cookieCarriersIn(mode).some(id => {
                const { kinds, schemes } = COOKIE_CARRIERS[id].reaches as { kinds: readonly string[]; schemes: readonly string[] | null };
                return kinds.includes(kind) && (schemes === null || schemes.includes(entry.slice(0, entry.indexOf(':') + 1)));
            })).map(entry => `${kind} ${entry}`));
            expect(refused, mode).toEqual(reached);
        }
        expect(cookieCarriersIn('strict')).toEqual([]);
    });

    it('a sibling under a public suffix of several labels is dropped, with the over-refusal and the fetch bridge named', () => {
        const result = normaliseConfig({ mode: 'cooperative', origins: { connect: ['https://bob.github.io', 'https://cdn.other.net'] } }, { hostOrigin: 'https://alice.github.io', hostSites: ['https://alice.github.io', 'https://alice.github.io'] });
        expect(result.value!.origins.connect).toEqual(['https://cdn.other.net']);
        const dropped = result.warnings.filter(message => /^\[Sandbox\] origins\.connect dropped /.test(message));
        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toContain("https://bob.github.io (on the host page's site)");
        expect(dropped[0]).toContain('github.io');
        expect(dropped[0]).toContain('may be refused too');
        expect(dropped[0]).toContain('fetchBridge.allow');
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
                const said = onHostSite(entryOrigin, [pageOrigin]);
                if (sameSite && !said) throw new Error(`${entry} is on the site of ${page} (${registrable(page)}), and the rule says it is not`);
                if (!sameSite && said) overRefused++;
                pairs++;
            }
        }
        expect(pairs).toBe(hosts.length ** 2);
        expect(overRefused, 'the rule refuses more than the list somewhere (a suffix of several labels)').toBeGreaterThan(0);
    }, 60_000);
});


// Every decision about the host page reads it through host-site.ts: its origin from hostPageOrigin (self.origin of the
// element's realm), its site from hostSiteOrigins (that origin, the top-level URL's, every ancestor's). No other
// host-side code reads the page's location, URL, base URL, domain, referrer, cookie jar or ancestors (BD4:TST-5): the
// document's URL differs from the realm's origin in a same-origin srcdoc or a DOM-built about:blank frame, a `<base>`
// moves the base URL, the page sets document.domain and wraps document.cookie, and an ancestor's origin is the site
// rule's to read. The in-sandbox bootstraps (the modules the realms registry stringifies into a sandbox document) run
// in their own realms, and are not host-side.
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
    // a global (not a member of something else) and the members of it that read the host page; '*' is every member
    const FORBIDDEN: Record<string, readonly string[]> = {
        location: ['*'],
        top: ['*'],
        parent: ['*'],
        frames: ['*'],
        opener: ['*'],
        document: ['cookie', 'domain', 'baseURI', 'URL', 'documentURI', 'referrer', 'location'],
        window: ['origin', 'location', 'top', 'parent', 'frames', 'opener', 'frameElement'],
        self: ['origin', 'location', 'top', 'parent', 'frames', 'opener', 'frameElement'],
        globalThis: ['origin', 'location', 'top', 'parent', 'frames', 'opener', 'frameElement'],
    };
    // a member that reads the host page whatever it is read from
    const MEMBERS = ['ancestorOrigins'];
    const ACCESS = new Set([SyntaxKind.DotToken, SyntaxKind.QuestionDotToken, SyntaxKind.OpenBracketToken]);

    /** Each read the scan forbids in code (not comments or strings), as `object.member (line n)`. */
    function reads(text: string): string[] {
        const tokens = tokenize(text);
        const found: string[] = [];
        const line = (start: number) => text.slice(0, start).split('\n').length;
        tokens.forEach((token, index) => {
            if (token.kind !== SyntaxKind.Identifier) return;
            const before = tokens[index - 1];
            if (MEMBERS.includes(token.text) && before && ACCESS.has(before.kind)) found.push(`.${token.text} (line ${line(token.start)})`);
            if (!Object.hasOwn(FORBIDDEN, token.text)) return;
            // a member of something else (`setup.parent`) or a property key is not the global
            if (before && (before.kind === SyntaxKind.DotToken || before.kind === SyntaxKind.QuestionDotToken)) return;
            const access = tokens[index + 1];
            if (!access || !ACCESS.has(access.kind)) return;
            const member = tokens[index + 2];
            const name = member?.kind === SyntaxKind.StringLiteral ? member.text.slice(1, -1) : member?.text;
            const allowed = FORBIDDEN[token.text]!;
            if (name !== undefined && (allowed.includes('*') || allowed.includes(name))) found.push(`${token.text}.${name} (line ${line(token.start)})`);
        });
        return found;
    }

    it('the scan sees each form it forbids, in code only, and not a member of something else', () => {
        const forms = [
            'globalThis.location?.origin', "location['hostname']", "document.cookie = 'x'", 'location.host', 'location.href', 'document.domain', 'document.baseURI',
            'window.origin', 'self.origin', 'globalThis.origin', 'document.URL', 'document.documentURI', 'document.referrer', 'parent.location.href', 'top.location',
            'window.top', 'frames[0]', 'x.ancestorOrigins', 'location.ancestorOrigins',
        ];
        for (const form of forms) expect(reads(`const a = ${form};`), form).not.toEqual([]);
        expect(reads("// location.origin\n/* document.cookie */ const c = 'location.origin'; setup.parent.appendChild(x); const o = { top: 1, parent: 2 }; o.top; window.addEventListener('x', f); self.crypto;")).toEqual([]);
    });

    it("no host-side file but host-site.ts reads the page's location, URL, origin, domain, referrer, cookie jar or ancestors", () => {
        const files = hostSide();
        expect(files).toContain('src/lib/host-site.ts');
        expect(files).toContain('src/lib/config-schema.ts');
        expect(files).not.toContain('src/lib/in-sandbox-script.ts');
        // the positive control: host-site.ts itself reads what the scan forbids elsewhere
        expect(reads(readFileSync(path.join(ROOT, 'src/lib/host-site.ts'), 'utf8')).length).toBeGreaterThan(0);
        const offending = files.filter(file => file !== 'src/lib/host-site.ts').flatMap(file => reads(readFileSync(path.join(ROOT, file), 'utf8')).map(read => `${file}: ${read}`));
        expect(offending).toEqual([]);
    });

    it('the element hands the config the host page from host-site.ts, read when a rule of the config asks, and from nowhere else', () => {
        const host = readFileSync(path.join(ROOT, 'src/host.ts'), 'utf8');
        expect(host.match(/normaliseConfig\(/g)).toHaveLength(1);
        expect(host).toContain('normaliseConfig(copy, readHostPage)');
        expect(host).toContain('const readHostPage = (): NormaliseContext => ({ hostOrigin: hostPageOrigin(), hostSites: hostSiteOrigins() });');
        const callers = hostSide().filter(file => file !== 'src/lib/host-site.ts' && /\bhostSiteOrigins\(/.test(readFileSync(path.join(ROOT, file), 'utf8')));
        expect(callers).toEqual(['src/host.ts']);
    });
});
