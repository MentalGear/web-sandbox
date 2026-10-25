import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AMBIENT_CREDENTIALS, ambientCredentialsSentence, carriedTo, carrierClause, carrierModes, COOKIE_CARRIER_IDS, COOKIE_CARRIERS, COOKIE_ENGINE_FACTS, COOKIE_ENGINES, cookieCarriersIn, cookieSentence, engineClause, engineClauses, SAME_SITE_VALUES, sameSiteCookieClause, sameSiteValues, STRICT_COOKIE_CARRIERS, withCode } from '@src/lib/cookie-facts';
import { normaliseConfig, SANDBOX_MODES, type SandboxMode } from '@src/lib/config-schema';
import { connectSources } from '@src/lib/csp/csp-generator';
import { ORIGIN_KINDS } from '@src/lib/csp/origins';
import { CONTEXT_ENGINES, INHERITED_CONTEXT } from '@src/lib/inherited-context';

/**
 * The engine-facts table for cookies (S74, class A): the one place that says which engine sends which SameSite cookies
 * with a request of the sandbox. The warning and the docs are rendered from it; no document states an engine's cookie
 * behaviour in words of its own, which is what this file keeps.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('COOKIE_ENGINE_FACTS', () => {
    it('has a row for every engine of the suite, with SameSite values only', () => {
        expect([...COOKIE_ENGINES]).toEqual([...CONTEXT_ENGINES]);
        for (const engine of COOKIE_ENGINES) {
            const facts = COOKIE_ENGINE_FACTS[engine];
            expect(facts.name, engine).not.toBe('');
            expect(facts.measured, engine).not.toBe('');
            for (const list of [facts.sends.sameSite, facts.sends.crossSite, ...(facts.protectedBy ? [facts.protectedBy.sends.sameSite, facts.protectedBy.sends.crossSite] : [])] as readonly (readonly string[])[]) {
                for (const value of list) expect(SAME_SITE_VALUES as readonly string[], `${engine} ${value}`).toContain(value);
                expect(new Set(list).size, engine).toBe(list.length);
            }
        }
    });

    it("an engine that honours the credentialless attribute sends nothing; one that does not sends something; a protection only narrows", () => {
        for (const engine of COOKIE_ENGINES) {
            const facts = COOKIE_ENGINE_FACTS[engine];
            const sendsNothing = facts.sends.sameSite.length === 0 && facts.sends.crossSite.length === 0;
            expect(sendsNothing, engine).toBe(facts.credentialless);
            if (!facts.protectedBy) continue;
            for (const reach of ['sameSite', 'crossSite'] as const) {
                for (const value of facts.protectedBy.sends[reach]) expect(facts.sends[reach] as readonly string[], `${engine} ${reach} ${value}`).toContain(value);
            }
        }
    });

    it('says where each engine takes the host page\'s site from, and whether a framed page can read its ancestors (BD4:ISO-1, BD4:ISO-3)', () => {
        for (const engine of COOKIE_ENGINES) expect(COOKIE_ENGINE_FACTS[engine].siteFrom, engine).not.toBe('');
        // test/e2e/host-site-layouts.spec.ts reads `'ancestorOrigins' in location` on every engine against these
        expect(COOKIE_ENGINES.filter(engine => COOKIE_ENGINE_FACTS[engine].hasAncestorOrigins)).toEqual(['chromium', 'webkit']);
        expect(COOKIE_ENGINE_FACTS.webkit.siteFrom).toContain("the top-level document's URL");
    });

    it('Chromium is the engine that honours credentialless, and the facts are the ones the S74 board measured', () => {
        expect(COOKIE_ENGINES.filter(engine => COOKIE_ENGINE_FACTS[engine].credentialless)).toEqual(['chromium']);
        expect(COOKIE_ENGINE_FACTS.firefox.sends).toEqual({ sameSite: ['None'], crossSite: ['None'] });
        expect(COOKIE_ENGINE_FACTS.webkit.sends).toEqual({ sameSite: ['None', 'Lax', 'Strict'], crossSite: ['None'] });
    });
});

describe('COOKIE_CARRIERS: the requests the library cannot strip (BD3:DOC-1)', () => {
    it('names the request of cooperative and worker mode, and the five that only cooperative mode has, which the gate does not cover; strict mode has none', () => {
        expect(cookieCarriersIn('worker')).toEqual(['websocket']);
        expect(cookieCarriersIn('cooperative')).toEqual(['websocket', 'markup', 'beacon', 'eventsource', 'ping', 'frames']);
        expect(cookieCarriersIn('strict')).toEqual([]);
        expect(STRICT_COOKIE_CARRIERS).toEqual([]);
        expect(Object.isFrozen(STRICT_COOKIE_CARRIERS)).toBe(true);
        for (const id of COOKIE_CARRIER_IDS) expect(COOKIE_CARRIERS[id].modes as readonly string[], id).not.toContain('strict');
        expect(COOKIE_CARRIER_IDS.map(id => carrierModes(COOKIE_CARRIERS[id]))).toEqual(['cooperative and worker mode', ...Array(5).fill('cooperative mode only')]);
    });

    it('each row names the entries it can be made to: lists of origins, with any scheme or a scheme of them (BD4:ISO-1)', () => {
        for (const id of COOKIE_CARRIER_IDS) {
            const { kinds, schemes } = COOKIE_CARRIERS[id].reaches as { kinds: readonly string[]; schemes: readonly string[] | null };
            expect(kinds.length, id).toBeGreaterThan(0);
            for (const kind of kinds) expect(ORIGIN_KINDS as readonly string[], `${id} ${kind}`).toContain(kind);
            if (schemes !== null) for (const scheme of schemes) expect(scheme, id).toMatch(/^[a-z]+:$/);
        }
        // what an undecided host site refuses, by mode: a WebSocket's wss:// entries in worker mode; every list in cooperative mode
        const reached = (mode: SandboxMode) => ORIGIN_KINDS.flatMap(kind => ['https://a.example', 'wss://a.example'].filter(origin => carriedTo(cookieCarriersIn(mode), kind, origin)).map(origin => `${kind} ${origin.slice(0, origin.indexOf(':'))}`));
        expect(reached('strict')).toEqual([]);
        expect(reached('worker')).toEqual(['connect wss']);
        expect(reached('cooperative')).toEqual([...ORIGIN_KINDS.filter(kind => kind !== 'connect').flatMap(kind => [`${kind} https`, `${kind} wss`]), 'connect https', 'connect wss']);
    });

    it('each row is said, and the spec that makes it exists (a cooperative-mode row\'s reads the table)', () => {
        for (const id of COOKIE_CARRIER_IDS) {
            const carrier = COOKIE_CARRIERS[id];
            for (const text of [carrier.request, carrier.short, carrier.why]) expect(text, id).not.toBe('');
            for (const engine of carrier.unsentBy) expect(COOKIE_ENGINES, `${id} ${engine}`).toContain(engine);
            const spec = readFileSync(path.join(root, carrier.test), 'utf8');
            if (carrier.modes.length === 1) expect(spec, `${id}: its spec makes the request from the table`).toContain('COOKIE_CARRIERS');
        }
    });

    it('the README\'s sentence names every carrier, in every engine\'s sentence', () => {
        const tick = (text: string) => `\`${text}\``;
        const sentence = cookieSentence(tick);
        expect(sentence).toContain(carrierClause(tick));
        for (const id of COOKIE_CARRIER_IDS) expect(sentence, id).toContain(withCode(COOKIE_CARRIERS[id].short, tick));
        expect(carrierClause()).toBe("a WebSocket handshake in cooperative and worker mode; in cooperative mode also a load of the guest's markup or CSS, navigator.sendBeacon(), EventSource with withCredentials, an <a ping> click and the requests of a frame the guest creates");
        expect(sentence).toContain('No request of strict mode carries a cookie, on any engine');
    });
});

/**
 * The structural test of the class's chokepoint for strict mode (S74, class A): STRICT_COOKIE_CARRIERS is empty, and what
 * makes it so holds for every config. Strict mode's two would-be carriers are a WebSocket handshake and a view load
 * made without CORS: the strict config after normalisation keeps no `ws:` or `wss:` entry in any kind, so the policy's
 * connect-src and the request gate's list name none (the gate refuses every WebSocket there besides,
 * test/unit/request-gate-strict.test.ts), and the renderer has no exception to the forced `crossorigin`
 * (test/unit/view-credentials.test.ts). Each part has its positive control: the same configs in worker mode keep the
 * `wss://` entries.
 */
describe('strict mode has no cookie carrier: the config after normalisation', () => {
    const HOSTS = ['https://app.example.com', 'http://localhost:4444', 'null', ''];
    const ENTRIES = ['https://api.other.example', 'wss://api.other.example', 'WSS://API.other.example:443', 'wss://ws.other.example', 'https://ws.other.example:8443', 'wss://ws.other.example:8443',
        'ws://api.other.example', 'ws://localhost:3000', 'http://localhost:3000', 'wss://localhost:3000', 'https://app.example.com', 'wss://app.example.com', 'https://203.0.113.7', 'wss://203.0.113.7'];
    // every subset of a window of the entries, in every kind and in a key that is no kind: enough to reach each rule
    const configs = (): Record<string, string[]>[] => {
        const out: Record<string, string[]>[] = [];
        for (let start = 0; start < ENTRIES.length; start++) {
            for (let mask = 1; mask < 16; mask++) {
                const picked = [0, 1, 2, 3].filter(bit => mask & (1 << bit)).map(bit => ENTRIES[(start + bit) % ENTRIES.length]!);
                out.push({ connect: picked });
                out.push(Object.fromEntries([...ORIGIN_KINDS, 'withoutCors'].map(kind => [kind, picked])));
            }
        }
        return out;
    };
    const socketEntries = (mode: SandboxMode, hostOrigin: string, origins: Record<string, string[]>) => {
        const value = normaliseConfig({ mode, origins, hostContentSecurityPolicy: false }, { hostOrigin, hostSites: [hostOrigin] }).value!;
        const listed = [...Object.values(value.origins).flat(), ...connectSources({ origins: value.origins, fileKinds: new Set(['connect']), scriptUnsafe: false })];
        return { keys: Object.keys(value.origins), sockets: listed.filter(entry => /^wss?:/i.test(entry)) };
    };

    it('keeps no ws: or wss: entry in any kind, for any host page, and no list but the kinds', () => {
        let checked = 0;
        for (const hostOrigin of HOSTS) {
            for (const origins of configs()) {
                const { keys, sockets } = socketEntries('strict', hostOrigin, origins);
                expect(sockets, `${hostOrigin} ${JSON.stringify(origins)}`).toEqual([]);
                expect(keys.sort(), hostOrigin).toEqual([...ORIGIN_KINDS].sort());
                checked++;
            }
        }
        expect(checked).toBeGreaterThan(400);
    });

    it('positive control: the same configs keep wss:// entries in worker and cooperative mode, so the check sees one', () => {
        for (const mode of SANDBOX_MODES.filter(mode => mode !== 'strict')) {
            const found = configs().filter(origins => socketEntries(mode, 'https://app.example.com', origins).sockets.length > 0);
            expect(found.length, mode).toBeGreaterThan(10);
            expect(socketEntries(mode, 'https://app.example.com', { connect: ['https://api.other.example', 'wss://api.other.example'] }).sockets, mode).toEqual(['wss://api.other.example', 'wss://api.other.example']);
        }
    });
});

describe('the ambient credentials besides cookies (BD3:ISO-4)', () => {
    const squash = (text: string) => text.replace(/\s+/g, ' ');
    const KEYWORDS = ['HTTP authentication', 'client certificate'];

    it('are named by the inventory row of the cookies, and by the README, API.md and THREAT-MODEL', () => {
        expect(AMBIENT_CREDENTIALS).toHaveLength(2);
        const channel = INHERITED_CONTEXT.cookies.channel;
        for (const keyword of KEYWORDS) {
            expect(channel, `the cookies row: ${keyword}`).toContain(keyword);
            for (const file of ['README.md', 'docs/API.md', 'docs/THREAT-MODEL.md']) expect(squash(readFileSync(path.join(root, file), 'utf8')), `${file}: ${keyword}`).toContain(keyword);
        }
    });

    it('are said once in the README\'s sentence, with what to do and that nothing was measured; the gate and the bridge send none', () => {
        const tick = (text: string) => `\`${text}\``;
        expect(cookieSentence(tick)).toContain(ambientCredentialsSentence());
        expect(ambientCredentialsSentence()).toContain('not measured');
        for (const file of ['docs/API.md', 'docs/THREAT-MODEL.md']) {
            const text = squash(readFileSync(path.join(root, file), 'utf8'));
            expect(text, file).toMatch(/send none|sends none/);
            expect(text, file).toContain('not measured');
        }
    });
});

describe('the sentences rendered from it', () => {
    const plain = (text: string) => text;
    const tick = (text: string) => `\`${text}\``;

    it('write the values the way a cookie is written, and none for no value', () => {
        expect(sameSiteValues([])).toBe('none');
        expect(sameSiteValues(['None'])).toBe('SameSite=None');
        expect(sameSiteValues(['None', 'Lax'])).toBe('SameSite=None and Lax');
        expect(sameSiteValues(['None', 'Lax', 'Strict'], tick)).toBe('`SameSite=None, Lax and Strict`');
    });

    it('name every engine, once, with what it sends and what narrows it', () => {
        expect(engineClause('chromium', 'sameSite')).toBe("Chromium: none (the sandbox's frame is credentialless)");
        expect(engineClause('firefox', 'sameSite')).toBe("Firefox: SameSite=None (none with Total Cookie Protection, Firefox's default)");
        expect(engineClause('webkit', 'sameSite')).toBe('WebKit: SameSite=None, Lax and Strict');
        expect(engineClause('webkit', 'crossSite')).toBe('WebKit: SameSite=None (none with Safari, which blocks third-party cookies; not measured)');
        for (const reach of ['sameSite', 'crossSite'] as const) {
            const clauses = engineClauses(reach, plain);
            for (const engine of COOKIE_ENGINES) expect(clauses.split(COOKIE_ENGINE_FACTS[engine].name + ':').length - 1, `${reach} ${engine}`).toBe(1);
        }
        expect(cookieSentence(tick)).toContain(engineClauses('sameSite', tick));
        expect(cookieSentence(tick)).toContain(engineClauses('crossSite', tick, false));
    });

    it("are what the `origins` warning says: an origin on the host page's site, in strict mode and in the others", () => {
        const context = { hostOrigin: 'https://app.example.com', hostSites: ['https://app.example.com'] };
        for (const mode of ['strict', 'cooperative', 'worker'] as const) {
            const said = normaliseConfig({ mode, origins: { connect: ['https://api.example.com'] } }, context).warnings.filter(message => /^\[Sandbox\] origins\.connect (lists|dropped) /.test(message));
            expect(said, mode).toHaveLength(1);
            expect(said[0], mode).toContain(sameSiteCookieClause());
        }
    });
});

describe('no document states an engine\'s cookie behaviour outside a generated region', () => {
    const DOCUMENTS = ['README.md', 'SECURITY.md', 'ARCHITECTURE.md', ...readdirSync(path.join(root, 'docs')).filter(file => file.endsWith('.md') && file !== 'BACKLOG.md').map(file => `docs/${file}`)];
    const ENGINE = /\b(chromium|firefox|webkit|safari)\b/i;

    /** The lines of a Markdown file outside its generated regions and fenced code, with their numbers. */
    function prose(file: string): Array<[number, string]> {
        const lines = readFileSync(path.join(root, file), 'utf8').split('\n');
        const kept: Array<[number, string]> = [];
        let generated = false;
        let fenced = false;
        lines.forEach((line, index) => {
            if (/^<!-- generated:begin /.test(line)) generated = true;
            else if (line === '<!-- generated:end -->') generated = false;
            else if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
            else if (!generated && !fenced) kept.push([index + 1, line]);
        });
        return kept;
    }

    it.each(DOCUMENTS)('%s', (file) => {
        const offending = prose(file).filter(([, line]) => /cookie/i.test(line) && ENGINE.test(line));
        expect(offending.map(([number, line]) => `${file}:${number}: ${line.trim().slice(0, 140)}`)).toEqual([]);
    });
});
