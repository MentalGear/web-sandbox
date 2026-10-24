import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
    connectAdmits, connectSources, HOST_SOURCE_RULES, hostAdmits, hostReach, narrowToHostPolicy, parseHostPolicies, policyNotGiven, schemeAdmits,
    sourceAdmits, sourceKind, splitPolicies, type HostPolicyOption, type SourceKind,
} from '@src/lib/csp/host-connect';
import { NO_ORIGINS, ORIGIN_KINDS, parseOrigins, withHttpsTwins, type OriginPolicy } from '@src/lib/csp/origins';
import { toFetchPolicy, type FetchPolicy } from '@src/lib/fetch-bridge';
import type { Origin } from '@src/lib/origin';

/**
 * The host page's `connect-src` as the library reads it (src/lib/csp/host-connect.ts): the grammar as a table of rules
 * (HOST_SOURCE_RULES, which docs/API.md#host-page-policy renders), every example of every rule asserted, and a property
 * per rule over generated origins and sources. The parser admits an origin only where every engine does, and only ever
 * narrows: nothing it does not understand admits an origin.
 */

const admits = (policy: string, origin: string) => hostAdmits(parseHostPolicies(policy), origin);

// ---- the rules, as values ---------------------------------------------------------------------------------------------

describe('HOST_SOURCE_RULES: every example of every rule', () => {
    for (const rule of HOST_SOURCE_RULES) {
        it.each(rule.examples.map(example => [...example]))(`${rule.source}: %s admits %s: %s`, (policy, origin, admitted) => {
            expect(admits(policy as string, origin as string)).toBe(admitted);
        });
    }

    it('the rules name every kind of source the parser reads, and each has examples that admit and examples that refuse (a wildcard only admits; what admits nothing only refuses)', () => {
        const kinds: readonly (SourceKind | 'directive' | 'none')[] = ['directive', 'none', 'self', 'wildcard', 'scheme', 'host', 'bare', 'other'];
        expect(new Set(HOST_SOURCE_RULES.map(rule => rule.kind))).toEqual(new Set(kinds));
        for (const rule of HOST_SOURCE_RULES) {
            const outcomes = new Set(rule.examples.map(example => example[2]));
            expect(rule.examples.length, rule.source).toBeGreaterThan(0);
            if (rule.kind === 'wildcard') expect(outcomes, rule.source).toEqual(new Set([true]));
            else if (rule.kind === 'other') expect(outcomes, rule.source).toEqual(new Set([false]));
            else expect(outcomes, `${rule.source} has an example of each outcome`).toEqual(new Set([true, false]));
        }
    });

    it('sourceKind reads each kind of source as the rule that names it', () => {
        expect(sourceKind('*')).toBe('wildcard');
        expect(sourceKind("'self'")).toBe('self');
        expect(sourceKind("'SELF'")).toBe('self');
        for (const source of ['https:', 'wss:', 'data:', 'x-y.z:']) expect(sourceKind(source), source).toBe('scheme');
        for (const source of ['https://a.example', 'https://*.a.example:*', 'https://a.example/path', 'http://localhost:3000', 'https://*', 'wss://*:*']) expect(sourceKind(source), source).toBe('host');
        for (const source of ['a.example', '*.a.example', 'a.example:*', 'localhost:3000', '*:*', 'a.example/path']) expect(sourceKind(source), source).toBe('bare');
        for (const source of ["'none'", "'unsafe-inline'", "'nonce-x'", "'sha256-x'", '', 'https://', 'https://[::1]', 'a b', 'https://a.example.', 'https://a:b', '"x"']) expect(sourceKind(source), source).toBe('other');
    });
});

// ---- the directive and the policy list ---------------------------------------------------------------------------------

describe('connectSources: which directive governs, and what a policy list is', () => {
    it('connect-src, else default-src, else nothing restricts; the first occurrence of a directive counts; names fold case', () => {
        expect(connectSources("connect-src https://a.example; default-src 'none'")).toEqual({ restricts: true, sources: ['https://a.example'] });
        expect(connectSources('default-src https://b.example; img-src *')).toEqual({ restricts: true, sources: ['https://b.example'] });
        expect(connectSources("img-src *; script-src 'self'")).toEqual({ restricts: false });
        expect(connectSources('')).toEqual({ restricts: false });
        expect(connectSources('connect-src https://a.example; connect-src https://b.example')).toEqual({ restricts: true, sources: ['https://a.example'] });
        expect(connectSources('Connect-Src https://a.example')).toEqual({ restricts: true, sources: ['https://a.example'] });
        expect(connectSources('  connect-src \t https://a.example \n https://b.example ;;  ')).toEqual({ restricts: true, sources: ['https://a.example', 'https://b.example'] });
    });

    it("'none' alone, or an empty directive, leaves no source; next to other sources it is dropped", () => {
        expect(connectSources("connect-src 'none'")).toEqual({ restricts: true, sources: [] });
        expect(connectSources('connect-src')).toEqual({ restricts: true, sources: [] });
        expect(connectSources("connect-src 'none' https://a.example")).toEqual({ restricts: true, sources: ['https://a.example'] });
    });

    it('splitPolicies: a string is a serialized list (commas), a list is one policy per entry', () => {
        expect(splitPolicies("connect-src 'self', connect-src https://a.example")).toEqual(["connect-src 'self'", 'connect-src https://a.example']);
        expect(splitPolicies(['a b', ' c ', ''])).toEqual(['a b', 'c']);
        expect(splitPolicies('')).toEqual([]);
        expect(splitPolicies(' , ')).toEqual([]);
    });

    it('a list of policies is an intersection: an origin must pass each, and no policy at all refuses nothing', () => {
        const both = parseHostPolicies('connect-src https://a.example https://b.example, connect-src https://b.example https://c.example');
        expect(['https://a.example', 'https://b.example', 'https://c.example'].map(origin => hostAdmits(both, origin))).toEqual([false, true, false]);
        expect(hostAdmits(parseHostPolicies(''), 'https://anything.example')).toBe(true);
        expect(hostAdmits(parseHostPolicies(["connect-src 'self'", 'img-src *']), 'https://app.example')).toBe(false);
        expect(hostAdmits(parseHostPolicies(['img-src *', 'script-src *']), 'https://app.example')).toBe(true);
    });
});

// ---- a property per rule -----------------------------------------------------------------------------------------------

const label = fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/);
const host = fc.array(label, { minLength: 1, maxLength: 4 }).map(parts => parts.join('.'));
const port = fc.integer({ min: 1, max: 65535 });
const DEFAULT = { https: 443, wss: 443, http: 80, ws: 80 } as const;
const originOf = (scheme: keyof typeof DEFAULT, name: string, number: number | null) => `${scheme}://${name}${number === null || number === DEFAULT[scheme] ? '' : `:${number}`}`;
const entry = fc.record({ scheme: fc.constantFrom('https', 'wss', 'http'), name: host, number: fc.option(port, { nil: null }) }).map(({ scheme, name, number }) => ({ scheme, name, number, origin: originOf(scheme, name, number) }));

describe('a property per rule', () => {
    it("'none', or no source, admits nothing", () => {
        fc.assert(fc.property(entry, ({ origin }) => !admits("connect-src 'none'", origin) && !admits('connect-src', origin) && !admits("default-src 'none'", origin)));
    });

    it("'none' next to a source changes nothing about that source", () => {
        fc.assert(fc.property(entry, fc.constantFrom('*', 'https:', 'http:', 'wss:'), ({ origin }, source) => admits(`connect-src 'none' ${source}`, origin) === admits(`connect-src ${source}`, origin)));
    });

    it("'self' admits nothing, whatever the page and the origin", () => {
        fc.assert(fc.property(entry, ({ origin }) => !admits("connect-src 'self'", origin) && !admits("connect-src 'SELF'", origin) && !admits("default-src 'self'", origin)));
    });

    it('* admits every origin of the network schemes', () => {
        fc.assert(fc.property(entry, ({ origin }) => admits('connect-src *', origin)));
    });

    it('a scheme source admits an origin by schemeAdmits: the same scheme, http: also https:, ws: also wss:, and no other widening', () => {
        const pairs: [string, string, boolean][] = [
            ['https:', 'https:', true], ['https:', 'http:', false], ['https:', 'wss:', false],
            ['http:', 'http:', true], ['http:', 'https:', true], ['http:', 'wss:', false],
            ['wss:', 'wss:', true], ['wss:', 'https:', false], ['wss:', 'http:', false],
            ['ws:', 'wss:', true], ['ws:', 'https:', false], ['ws:', 'http:', false],
            ['data:', 'https:', false], ['blob:', 'wss:', false],
        ];
        for (const [source, scheme, expected] of pairs) expect(schemeAdmits(source, scheme), `${source} ${scheme}`).toBe(expected);
        fc.assert(fc.property(entry, fc.constantFrom('https:', 'http:', 'wss:', 'ws:', 'data:', 'blob:', 'filesystem:'), ({ origin, scheme }, source) => admits(`connect-src ${source}`, origin) === schemeAdmits(source, `${scheme}:`)));
    });

    it('a host source admits its own origin, in any case, and no other host or port', () => {
        fc.assert(fc.property(entry, entry, ({ scheme, name, number, origin }, other) => {
            expect(admits(`connect-src ${origin}`, origin), 'itself').toBe(true);
            expect(admits(`connect-src ${origin.toUpperCase()}`, origin), 'in upper case').toBe(true);
            if (other.name !== name) expect(admits(`connect-src ${origin}`, originOf(scheme as keyof typeof DEFAULT, other.name, number)), 'another host').toBe(false);
            const next = originOf(scheme as keyof typeof DEFAULT, name, (number ?? DEFAULT[scheme as keyof typeof DEFAULT]) % 65535 + 1);
            expect(admits(`connect-src ${origin}`, next), 'another port').toBe(false);
        }));
    });

    it('a host source with a port admits that port only; with `:*` any; with none the scheme default', () => {
        fc.assert(fc.property(host, port, port, (name, a, b) => {
            expect(admits(`connect-src https://${name}:${a}`, originOf('https', name, a))).toBe(true);
            expect(admits(`connect-src https://${name}:${a}`, originOf('https', name, b))).toBe(a === b);
            expect(admits(`connect-src https://${name}:*`, originOf('https', name, b))).toBe(true);
            expect(admits(`connect-src https://${name}`, originOf('https', name, b))).toBe(b === 443);
        }));
    });

    it('an upgraded scheme (http:// for https://, ws:// for wss://) is taken when the source names no port, or any port, and not with a port written', () => {
        fc.assert(fc.property(host, port, fc.constantFrom(['http', 'https'], ['ws', 'wss']) as fc.Arbitrary<[keyof typeof DEFAULT, keyof typeof DEFAULT]>, (name, number, [from, to]) => {
            expect(admits(`connect-src ${from}://${name}`, originOf(to, name, null)), 'no port').toBe(true);
            expect(admits(`connect-src ${from}://${name}:*`, originOf(to, name, number)), 'any port').toBe(true);
            expect(admits(`connect-src ${from}://${name}:${number}`, originOf(to, name, number)), 'a port written').toBe(false);
            expect(admits(`connect-src ${from}://${name}:${number}`, originOf(from, name, number)), 'the same scheme, a port written').toBe(true);
        }));
    });

    it('a host without a scheme admits nothing', () => {
        fc.assert(fc.property(entry, ({ name, number, origin }) => {
            const written = `${name}${number === null ? '' : `:${number}`}`;
            expect(admits(`connect-src ${written}`, origin)).toBe(false);
            expect(admits(`connect-src ${name}:*`, origin)).toBe(false);
            expect(admits(`connect-src *.${name}`, origin)).toBe(false);
        }));
    });

    it('*.host admits subdomains of the host, one or more labels, and never the bare domain or a lookalike', () => {
        fc.assert(fc.property(host, host, (domain, sub) => {
            expect(admits(`connect-src https://*.${domain}`, `https://${sub}.${domain}`)).toBe(true);
            expect(admits(`connect-src https://*.${domain}`, `https://${domain}`)).toBe(false);
            expect(admits(`connect-src https://*.${domain}`, `https://${sub}${domain}`)).toBe(false);
        }));
    });

    it('* as the host admits every host of the scheme, with any port under `:*`', () => {
        fc.assert(fc.property(entry, ({ scheme, name, number }) => {
            const s = scheme as keyof typeof DEFAULT;
            expect(admits(`connect-src ${s}://*:*`, originOf(s, name, number))).toBe(true);
            expect(admits(`connect-src ${s}://*`, originOf(s, name, number))).toBe(number === null || number === DEFAULT[s]);
        }));
    });

    it('a path admits nothing but for a lone slash, which is the whole origin', () => {
        fc.assert(fc.property(entry, fc.stringMatching(/^[a-z0-9]{1,6}(\/[a-z0-9]{0,6}){0,2}$/), ({ origin }, path) => {
            expect(admits(`connect-src ${origin}/${path}`, origin)).toBe(false);
            expect(admits(`connect-src ${origin}/`, origin)).toBe(true);
        }));
    });

    it('anything else admits nothing: keywords, nonces, hashes, and tokens that are not sources', () => {
        const other = fc.oneof(
            fc.constantFrom("'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'", "'unsafe-hashes'", "'report-sample'", "'wasm-unsafe-eval'", "'inline-speculation-rules'"),
            fc.stringMatching(/^[A-Za-z0-9+/]{8,40}$/).map(value => `'nonce-${value}'`),
            fc.stringMatching(/^[A-Za-z0-9+/]{8,40}$/).map(value => `'sha256-${value}='`),
            fc.stringMatching(/^[^\s;,]{1,12}$/).filter(value => ['other', 'bare', 'self'].includes(sourceKind(value))),
        );
        fc.assert(fc.property(entry, fc.array(other, { minLength: 1, maxLength: 5 }), ({ origin }, tokens) => !admits(`connect-src ${tokens.join(' ')}`, origin)));
    });

    it('adding a source never narrows, and a longer policy list never admits what a shorter one refused', () => {
        const source = fc.oneof(entry.map(value => value.origin), fc.constantFrom('*', 'https:', 'http:', 'wss:', "'self'", "'none'", 'https://*.example'));
        fc.assert(fc.property(entry, fc.array(source, { maxLength: 4 }), source, fc.array(source, { maxLength: 3 }), ({ origin }, sources, more, extraPolicy) => {
            const base = `connect-src ${sources.join(' ')}`;
            if (admits(base, origin)) expect(admits(`${base} ${more}`, origin)).toBe(true);
            const policies = [base, ...extraPolicy.map(value => `connect-src ${value}`)];
            const first = hostAdmits(parseHostPolicies(policies.slice(0, 1)), origin);
            expect(hostAdmits(parseHostPolicies(policies), origin) && !first).toBe(false);
        }));
    });

    it('never throws, whatever the text', () => {
        fc.assert(fc.property(fc.string({ maxLength: 200 }), (text) => {
            const policies = parseHostPolicies(text);
            for (const origin of ['https://a.example', 'wss://a.example:8443', 'http://127.0.0.1:3000', 'not an origin', '']) expect(typeof hostAdmits(policies, origin)).toBe('boolean');
            expect(typeof connectAdmits(connectSources(text), 'not an origin')).toBe('boolean');
            expect(typeof sourceAdmits(text, 'https://a.example')).toBe('boolean');
        }), { numRuns: 300 });
    });
});

// ---- the intersection with the lists ----------------------------------------------------------------------------------

const origins = (connect: string[]): OriginPolicy => parseOrigins({ connect, images: ['https://img.example'] }, 'cooperative', () => {});
const bridge = (allow: string[]): FetchPolicy => toFetchPolicy({ allow }, () => {})!;

const warning0 = (result: { warnings: string[] }) => result.warnings[0] ?? '';

describe("narrowToHostPolicy: the lists as configured, less what the page's policy refuses", () => {
    const run = (connect: string[], allow: string[] | null, policy: string) => {
        const warnings: string[] = [];
        const result = narrowToHostPolicy(origins(connect), allow === null ? null : bridge(allow), parseHostPolicies(policy), message => warnings.push(message));
        return { ...result, warnings };
    };

    it('drops each origin a policy refuses from origins.connect and fetchBridge.allow, with one warning per list', () => {
        const { origins: narrowed, fetchPolicy, warnings } = run(['https://a.example', 'https://b.example'], ['https://b.example', 'https://c.example'], 'connect-src https://a.example https://c.example');
        expect(narrowed.connect).toEqual(['https://a.example']);
        expect(fetchPolicy!.allow).toEqual(['https://c.example']);
        expect(warnings).toHaveLength(2);
        expect(warnings[0]).toMatch(/^\[Sandbox\] origins\.connect dropped https:\/\/b\.example: /);
        expect(warnings[1]).toMatch(/^\[Sandbox\] fetchBridge\.allow dropped https:\/\/b\.example: /);
        for (const warning of warnings) expect(warning).toContain('hostContentSecurityPolicy');
    });

    it("changes only connect and the bridge's allow list: every other kind and field is the one configured, and the result is frozen", () => {
        const configured = origins(['https://a.example']);
        const policy = bridge(['https://a.example']);
        const { origins: narrowed, fetchPolicy } = narrowToHostPolicy(configured, policy, parseHostPolicies("connect-src 'none'"), () => {});
        for (const kind of ORIGIN_KINDS.filter(kind => kind !== 'connect')) expect(narrowed[kind], kind).toBe(configured[kind]);
        expect(fetchPolicy).toEqual({ ...policy, allow: [] });
        expect(Object.isFrozen(narrowed) && Object.isFrozen(narrowed.connect) && Object.isFrozen(fetchPolicy) && Object.isFrozen(fetchPolicy!.allow)).toBe(true);
    });

    it('returns the lists themselves, silently, when nothing is refused or there is no policy', () => {
        const configured = origins(['https://a.example']);
        const policy = bridge(['https://a.example']);
        for (const text of ['connect-src https://a.example', 'connect-src *', "img-src 'none'", '']) {
            const warnings: string[] = [];
            const narrowed = narrowToHostPolicy(configured, policy, parseHostPolicies(text), message => warnings.push(message));
            expect(narrowed.origins, text).toBe(configured);
            expect(narrowed.fetchPolicy, text).toBe(policy);
            expect(warnings, text).toEqual([]);
        }
        expect(narrowToHostPolicy(NO_ORIGINS, null, parseHostPolicies("connect-src 'none'"), () => { throw new Error('no warning'); })).toEqual({ origins: NO_ORIGINS, fetchPolicy: null });
    });

    it("'self' alone drops every origin, the page's own included, and the warning tells the embedder to list the origin; naming the origin keeps it", () => {
        const dropped = run(['https://app.example', 'https://api.example'], ['https://app.example'], "connect-src 'self'");
        expect(dropped.origins.connect).toEqual([]);
        expect(dropped.warnings).toHaveLength(2);
        for (const warning of dropped.warnings) expect(warning).toContain("Your policy names 'self'");
        expect(warning0(run(['https://api.example'], null, 'connect-src https://other.example'))).not.toContain("'self'");
        expect(run(['https://app.example', 'https://api.example'], null, "connect-src 'self' https://app.example").origins.connect).toEqual(['https://app.example']);
    });

    it('a wss:// entry whose https:// twin the policy refused goes too; one whose twin stays, stays', () => {
        const refusedTwin = run(['https://a.example', 'wss://a.example', 'https://b.example', 'wss://b.example'], null, 'connect-src wss://a.example https://b.example wss://b.example');
        expect(refusedTwin.origins.connect).toEqual(['https://b.example', 'wss://b.example']);
        expect(refusedTwin.warnings).toHaveLength(2);
        expect(refusedTwin.warnings[0]).toContain('origins.connect dropped https://a.example');
        expect(refusedTwin.warnings[1]).toContain('origins.connect dropped wss://a.example: its https:// twin was dropped');
    });

    it('an http:// loopback entry is refused by a policy that admits https: only', () => {
        const { origins: narrowed } = run(['https://a.example', 'http://127.0.0.1:3000'], null, 'connect-src https:');
        expect(narrowed.connect).toEqual(['https://a.example']);
    });

    it('property: what is kept is exactly what every policy admits, in order', () => {
        const policy = fc.constantFrom("connect-src 'self'", 'connect-src https:', 'connect-src https://*.example', "connect-src 'none'", 'connect-src *', "default-src 'self' https://a.example", '');
        fc.assert(fc.property(fc.array(entry.map(value => value.origin).filter(value => !value.startsWith('wss') && !value.startsWith('http:')), { maxLength: 6 }), fc.array(policy, { maxLength: 3 }), (list, texts) => {
            const configured = origins(list);
            const parsed = parseHostPolicies(texts);
            const { origins: narrowed } = narrowToHostPolicy(configured, null, parsed, () => {});
            expect(narrowed.connect).toEqual(configured.connect.filter(origin => hostAdmits(parsed, origin)));
        }));
    });
});

describe('withHttpsTwins: a wss:// origin stays only beside its https:// twin', () => {
    const list = (values: string[]) => values as Origin[];

    it.each([
        ['wss alone', ['wss://a.example'], [], ['wss://a.example']],
        ['the pair', ['https://a.example', 'wss://a.example'], ['https://a.example', 'wss://a.example'], []],
        ['the pair, wss first', ['wss://a.example', 'https://a.example'], ['wss://a.example', 'https://a.example'], []],
        ['https alone', ['https://a.example'], ['https://a.example'], []],
        ['another port is another origin', ['https://a.example', 'wss://a.example:8443'], ['https://a.example'], ['wss://a.example:8443']],
        ['the same port', ['https://a.example:8443', 'wss://a.example:8443'], ['https://a.example:8443', 'wss://a.example:8443'], []],
        ['another host', ['https://b.example', 'wss://a.example'], ['https://b.example'], ['wss://a.example']],
        ['http is not a twin', ['http://127.0.0.1:3000', 'wss://127.0.0.1:3000'], ['http://127.0.0.1:3000'], ['wss://127.0.0.1:3000']],
    ])('%s', (_, input, kept, orphans) => {
        expect(withHttpsTwins(list(input))).toEqual({ kept, orphans });
    });

    it('property: every kept wss:// origin has its twin kept, and nothing but a wss:// origin is dropped', () => {
        fc.assert(fc.property(fc.array(entry.filter(value => value.scheme !== 'http').map(value => value.origin), { maxLength: 8 }), (values) => {
            const { kept, orphans } = withHttpsTwins(list(values));
            for (const origin of kept) if (origin.startsWith('wss://')) expect(kept).toContain(`https://${origin.slice(6)}`);
            for (const origin of orphans) expect(origin.startsWith('wss://') && !values.includes(`https://${origin.slice(6)}`)).toBe(true);
            expect([...kept, ...orphans].sort()).toEqual([...values].sort());
        }));
    });
});

// ---- hostReach: what one build's connect lists are, from hostContentSecurityPolicy alone (host.ts `_reach`) -------------

describe("hostReach: a build's connect lists from hostContentSecurityPolicy alone (BD4:CHL-1, BD4:CHL-2)", () => {
    const API = 'https://api.example';
    const CDN = 'https://cdn.example';
    const origins = (connect: string[]): OriginPolicy => parseOrigins({ connect }, 'strict', () => {});
    const bridge = (allow: string[]): FetchPolicy => toFetchPolicy({ allow }, () => {}, 'https://app.example')!;
    const refusesApi = "connect-src 'self' https://cdn.example";

    type Row = [name: string, option: HostPolicyOption, connect: string[], allow: string[], warned: RegExp[]];
    // every value the option can have, with connect and bridge origins listed (CDN admitted by the policy, API refused)
    const ROWS: Row[] = [
        ['false: the page sends no policy, the lists are kept', false, [API, CDN], [API, CDN], []],
        ['a text: narrowed by it', refusesApi, [CDN], [CDN], [/^\[Sandbox\] origins\.connect dropped https:\/\/api\.example: /, /^\[Sandbox\] fetchBridge\.allow dropped https:\/\/api\.example: /]],
        ['a text that refuses nothing: kept', 'img-src *', [API, CDN], [API, CDN], []],
        ['left out: both lists dropped, with one warning', undefined, [], [], [/^\[Sandbox\] origins\.connect dropped https:\/\/api\.example, https:\/\/cdn\.example; fetchBridge\.allow dropped https:\/\/api\.example, https:\/\/cdn\.example: hostContentSecurityPolicy was not given/]],
    ];

    it.each(ROWS)('%s', (_, option, connect, allow, warned) => {
        const warnings: string[] = [];
        const result = hostReach(origins([API, CDN]), bridge([API, CDN]), option, message => warnings.push(message));
        expect(result.origins.connect).toEqual(connect);
        expect(result.fetchPolicy!.allow).toEqual(allow);
        expect(warnings).toHaveLength(warned.length);
        warned.forEach((pattern, index) => expect(warnings[index]).toMatch(pattern));
    });

    it('left out: the one warning is policyNotGiven, which names each list that had entries and says exactly what to pass', () => {
        const both: string[] = [];
        hostReach(origins([API]), bridge([CDN]), undefined, message => both.push(message));
        expect(both).toEqual([policyNotGiven({ connect: [API], allow: [CDN] })]);
        expect(both[0]).toContain('Pass hostContentSecurityPolicy: your page\'s policy as text');
        expect(both[0]).toContain('or false if your page sends no Content-Security-Policy');
        expect(both[0]).toContain('docs/API.md#your-connect-src');

        const connectOnly: string[] = [];
        const onlyConnect = hostReach(origins([API]), null, undefined, message => connectOnly.push(message));
        expect(onlyConnect.fetchPolicy).toBeNull();
        expect(connectOnly).toEqual([expect.stringMatching(/^\[Sandbox\] origins\.connect dropped https:\/\/api\.example: hostContentSecurityPolicy was not given/)]);

        const allowOnly: string[] = [];
        const onlyAllow = hostReach(origins([]), bridge([API]), undefined, message => allowOnly.push(message));
        expect(onlyAllow.origins.connect).toEqual([]);
        expect(onlyAllow.fetchPolicy!.allow).toEqual([]);
        expect(allowOnly).toEqual([expect.stringMatching(/^\[Sandbox\] fetchBridge\.allow dropped https:\/\/api\.example: hostContentSecurityPolicy was not given/)]);
    });

    it('left out keeps nothing, frozen, and the other kinds and the bridge\'s other settings as they were', () => {
        const configured = parseOrigins({ images: [CDN], connect: [API] }, 'strict', () => {});
        const policy = bridge([API]);
        const result = hostReach(configured, policy, undefined, () => {});
        expect(result.origins.connect).toEqual([]);
        expect(result.origins.images).toEqual([CDN]);
        expect(result.fetchPolicy!.allow).toEqual([]);
        expect({ ...result.fetchPolicy, allow: policy.allow }).toEqual(policy);
        expect(Object.isFrozen(result.origins) && Object.isFrozen(result.origins.connect) && Object.isFrozen(result.fetchPolicy!.allow)).toBe(true);
    });

    it('a build with nothing to narrow is left as it is, whatever the option, and says nothing', () => {
        const none = origins([]);
        const images = parseOrigins({ images: [CDN], connect: [API] }, 'strict', () => {});
        for (const [, option] of ROWS) {
            const warnings: string[] = [];
            const result = hostReach(none, null, option, message => warnings.push(message));
            expect(result.origins).toBe(none);
            expect(result.fetchPolicy).toBeNull();
            expect(warnings).toEqual([]);
            expect(hostReach(images, null, option, () => {}).origins.images).toEqual([CDN]);
        }
    });

    it('only ever narrows: for any option and any lists, what is kept was configured, and a list is kept whole only with false or a policy that admits it', () => {
        const ORIGIN_POOL = [API, CDN, 'https://x.example:8443', 'http://127.0.0.1:3000'];
        const optionArb = fc.oneof(fc.constant<HostPolicyOption>(undefined), fc.constant<HostPolicyOption>(false), fc.constantFrom<HostPolicyOption>(refusesApi, 'connect-src *', "connect-src 'none'", "connect-src 'self'", 'img-src *'));
        fc.assert(fc.property(fc.subarray(ORIGIN_POOL), fc.subarray(ORIGIN_POOL), optionArb, (connect, allow, option) => {
            const result = hostReach(origins(connect), allow.length > 0 ? bridge(allow) : null, option, () => {});
            for (const kept of result.origins.connect) expect(connect).toContain(kept);
            for (const kept of result.fetchPolicy?.allow ?? []) expect(allow).toContain(kept);
            if (option === undefined) {
                expect(result.origins.connect).toEqual([]);
                expect(result.fetchPolicy?.allow ?? []).toEqual([]);
            }
            if (option === false) {
                expect(result.origins.connect).toEqual(origins(connect).connect);
                expect(result.fetchPolicy?.allow ?? []).toEqual(allow.length > 0 ? bridge(allow).allow : []);
            }
        }));
    });
});
