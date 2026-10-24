import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_ORIGINS, ORIGIN_KINDS, ORIGIN_LISTS, ORIGINS_REFUSAL_TEXT, originRules, OriginsTypeError, parseOrigins, type SandboxOrigins, type StrictSandboxOrigins } from './origins';
import type { SandboxConfig } from '../../host';

const parse = (input: unknown, mode: unknown = 'cooperative') => {
    const warnings: string[] = [];
    const policy = parseOrigins(input, mode, (message) => warnings.push(message));
    return { policy, warnings };
};

describe('parseOrigins: `origins` parsed once, at the boundary (ADR-007)', () => {
    it('keeps exact origins per kind, canonical and without duplicates; every kind is present', () => {
        const { policy, warnings } = parse({ images: ['https://img.example', 'HTTPS://IMG.example:443/'], connect: ['https://ws.example', 'wss://ws.example', 'http://localhost:3000'] });
        expect(policy).toEqual({ scripts: [], styles: [], images: ['https://img.example'], fonts: [], media: [], connect: ['https://ws.example', 'wss://ws.example', 'http://localhost:3000'], withoutCors: [] });
        expect(warnings).toEqual([]);
    });

    it('withoutCors: strict mode only, parsed with the rules of the other lists; outside strict mode ignored with one warning', () => {
        const strict = parse({ images: ['https://img.example'], media: ['https://media.example'], withoutCors: ['HTTPS://IMG.example:443/', 'https://media.example', 'http://localhost:3000', '*', 'wss://img.example'] }, 'strict');
        expect(strict.policy.withoutCors).toEqual(['https://img.example', 'https://media.example', 'http://localhost:3000']);
        expect(strict.warnings).toEqual([
            expect.stringContaining('origins.withoutCors entry "*" was dropped'),
            expect.stringContaining('origins.withoutCors entry "wss://img.example" was dropped'),
            '[Sandbox] origins.withoutCors lists "http://localhost:3000", which none of images, media, styles, fonts lists: it loads nothing until one of them does.',
        ]);
        // it adds nothing to a kind
        expect(strict.policy.images).toEqual(['https://img.example']);
        for (const mode of ['cooperative', 'worker']) {
            const other = parse({ images: ['https://img.example'], withoutCors: ['https://img.example'] }, mode);
            expect(other.policy.withoutCors, mode).toEqual([]);
            expect(other.warnings, mode).toEqual(["[Sandbox] origins.withoutCors is used only in strict mode and was ignored: the other modes make their loads the engine's way."]);
            expect(parse({ withoutCors: [] }, mode).warnings, mode).toEqual([]);
        }
        expect(() => parse({ withoutCors: 'https://img.example' }, 'strict')).toThrow(TypeError);
    });

    it('is frozen, its lists included', () => {
        const { policy } = parse({ images: ['https://img.example'] });
        expect(Object.isFrozen(policy)).toBe(true);
        for (const kind of ORIGIN_KINDS) expect(Object.isFrozen(policy[kind]), kind).toBe(true);
        expect(Object.isFrozen(NO_ORIGINS)).toBe(true);
    });

    it('drops each entry that is not an origin with one warning naming the kind and the entry: dropping only narrows', () => {
        const { policy, warnings } = parse({ images: ['data:', "'self'", 'https://ok.example', '*', 'https:', 1], fonts: ['blob:'] });
        expect(policy.images).toEqual(['https://ok.example']);
        expect(policy.fonts).toEqual([]);
        expect(warnings).toHaveLength(6);
        expect(warnings[0]).toBe('[Sandbox] origins.images entry "data:" was dropped: list exact origins like "https://cdn.example" (https; http only for localhost and 127.0.0.1). Wildcards, schemes, keywords, data:, blob: and paths are not origins (see docs/API.md#origins).');
        expect(warnings[4]).toContain('origins.images entry a value of type number');
        expect(warnings[5]).toContain('origins.fonts entry "blob:"');
    });

    it('the rules per kind: https for any host, plain http for loopback only, wss for connect only', () => {
        for (const kind of ORIGIN_KINDS) {
            expect(originRules(kind), kind).toEqual({ anyHost: kind === 'connect' ? ['https:', 'wss:'] : ['https:'], loopbackOnly: ['http:'] });
        }
    });

    it('wss: only for connect', () => {
        const { policy, warnings } = parse({ connect: ['https://a.example', 'wss://a.example'], images: ['wss://a.example'] });
        expect([policy.connect, policy.images]).toEqual([['https://a.example', 'wss://a.example'], []]);
        expect(warnings).toEqual([expect.stringContaining('origins.images entry "wss://a.example"')]);
    });

    it('a wss:// entry is kept only beside its https:// twin (same host and port); otherwise it is dropped with one warning that names the twin, in every mode', () => {
        for (const mode of ['strict', 'cooperative', 'worker']) {
            const alone = parse({ connect: ['wss://a.example'] }, mode);
            expect(alone.policy.connect, mode).toEqual([]);
            expect(alone.warnings, mode).toEqual(['[Sandbox] origins.connect entry "wss://a.example" was dropped: it needs "https://a.example" listed as well. Some engines let a wss:// entry admit https:// requests and others do not, so the library admits the pair on every engine, or neither (see docs/API.md#origins).']);
            const pair = parse({ connect: ['wss://a.example:8443', 'https://a.example:8443', 'WSS://B.example:443/', 'https://b.example'] }, mode);
            expect(pair.policy.connect, mode).toEqual(['wss://a.example:8443', 'https://a.example:8443', 'wss://b.example', 'https://b.example']);
            expect(pair.warnings, mode).toEqual([]);
        }
        const elsewhere = parse({ connect: ['https://a.example', 'wss://a.example:8443', 'wss://b.example', 'https://b.example:8443', 'http://localhost:3000', 'wss://localhost:3000'] });
        expect(elsewhere.policy.connect).toEqual(['https://a.example', 'https://b.example:8443', 'http://localhost:3000']);
        expect(elsewhere.warnings).toHaveLength(3);
        expect(elsewhere.warnings.map(message => /needs "([^"]+)"/.exec(message)![1])).toEqual(['https://a.example:8443', 'https://b.example', 'https://localhost:3000']);
    });

    it('the twin rule is for connect: another kind never lists a wss:// origin, so nothing else is paired', () => {
        const { policy } = parse({ images: ['https://a.example'], connect: ['https://a.example'] });
        expect([policy.images, policy.connect]).toEqual([['https://a.example'], ['https://a.example']]);
    });

    it('drops a key that is not a kind, with one warning, whatever its value', () => {
        const { policy, warnings } = parse(JSON.parse('{"img-src": ["https://a.example"], "Images": 5, "__proto__": {"images": ["https://p.example"]}}'));
        expect(policy).toEqual(NO_ORIGINS);
        expect(warnings).toEqual([
            '[Sandbox] origins."img-src" was dropped: origins takes scripts, styles, images, fonts, media, connect, withoutCors.',
            '[Sandbox] origins."Images" was dropped: origins takes scripts, styles, images, fonts, media, connect, withoutCors.',
            '[Sandbox] origins."__proto__" was dropped: origins takes scripts, styles, images, fonts, media, connect, withoutCors.',
        ]);
    });

    it('strict mode: scripts are dropped with one warning; an empty list says nothing', () => {
        const strict = parse({ scripts: ['https://cdn.example'], images: ['https://img.example'] }, 'strict');
        expect([strict.policy.scripts, strict.policy.images]).toEqual([[], ['https://img.example']]);
        expect(strict.warnings).toEqual(["[Sandbox] origins.scripts is not used in strict mode and was dropped: the view runs only the library's bootstrap, and the worker loads no script (see docs/ADR-005)."]);
        expect(parse({ scripts: [] }, 'strict').warnings).toEqual([]);
        for (const mode of ['cooperative', 'worker', undefined]) expect(parse({ scripts: ['https://cdn.example'] }, mode).policy.scripts, String(mode)).toEqual(['https://cdn.example']);
    });

    it('absent, and every kind absent or undefined: no origin', () => {
        expect(parse(undefined).policy).toEqual(NO_ORIGINS);
        expect(parse({}).policy).toEqual(NO_ORIGINS);
        expect(parse({ images: undefined }).policy).toEqual(NO_ORIGINS);
    });

    it.each([[null], ['https://a.example'], [['https://a.example']], [7], [true]])('a value that is not an object refuses the config: %j', (value) => {
        expect(() => parse(value)).toThrowError(TypeError);
        expect(() => parse(value)).toThrowError('origins must be an object of origin lists');
    });

    it.each([['a string', 'https://a.example'], ['null', null], ['an object', { 0: 'https://a.example' }], ['a number', 1]])('a kind that is not a list refuses the config: %s', (_, value) => {
        expect(() => parse({ images: value })).toThrowError(TypeError);
        expect(() => parse({ images: value })).toThrowError('origins.images must be a list of origins');
    });

    it('the refusal carries the option, and the fixed text the element gives for it names that option, for `origins` and for each list (BD3:NEW-3)', () => {
        const refused = (input: unknown) => { try { parse(input); } catch (error) { return error; } return null; };
        const top = refused(5);
        expect(top).toBeInstanceOf(OriginsTypeError);
        expect(top).toBeInstanceOf(TypeError);
        expect((top as TypeError).name).toBe('TypeError');
        expect(ORIGINS_REFUSAL_TEXT[(top as OriginsTypeError).option]).toBe('origins is not an object');
        for (const kind of ORIGIN_LISTS) {
            const error = refused({ [kind]: 7 }) as OriginsTypeError;
            expect(error, kind).toBeInstanceOf(OriginsTypeError);
            expect(error.option).toBe(kind);
            expect(ORIGINS_REFUSAL_TEXT[kind]).toBe(`origins.${kind} is not a list`);
        }
        expect(Object.keys(ORIGINS_REFUSAL_TEXT).sort()).toEqual(['origins', ...ORIGIN_LISTS].sort());
    });
});

describe('the types: what a mode cannot use does not compile', () => {
    it('strict mode has no `scripts`; the other modes do; connectionsAllowed is gone', () => {
        const strict: SandboxConfig = { mode: 'strict', origins: { images: ['https://a.example'] } };
        // @ts-expect-error scripts is not an origin kind in strict mode
        const strictScripts: SandboxConfig = { mode: 'strict', origins: { scripts: ['https://cdn.example'] } };
        const strictOrigins: StrictSandboxOrigins = { connect: ['https://api.example'] };
        // @ts-expect-error not even through a variable
        const strictFromVariable: SandboxConfig = { mode: 'strict', origins: { scripts: ['https://cdn.example'] } as SandboxOrigins };
        const cooperative: SandboxConfig = { mode: 'cooperative', origins: { scripts: ['https://cdn.example'] } };
        const worker: SandboxConfig = { mode: 'worker', origins: { scripts: ['https://cdn.example'] } };
        // a mode chosen at run time takes origins that every mode can use
        const anyMode = (mode: 'cooperative' | 'worker' | 'strict'): SandboxConfig => ({ mode, origins: strictOrigins });
        // @ts-expect-error connectionsAllowed was removed
        const removed: SandboxConfig = { connectionsAllowed: { 'img-src': ['https://a.example'] } };
        // @ts-expect-error a kind takes origins, not a source string
        const notAList: SandboxConfig = { origins: { images: 'https://a.example' } };
        // @ts-expect-error not a kind
        const notAKind: SandboxOrigins = { 'img-src': ['https://a.example'] };
        expect([strict, strictScripts, strictFromVariable, cooperative, worker, anyMode('strict'), removed, notAList, notAKind]).toHaveLength(9);
    });

    it('ORIGIN_LISTS are exactly the keys of SandboxOrigins: the kinds, and withoutCors', () => {
        const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'origins.ts'), 'utf8');
        const body = source.slice(source.indexOf('export interface SandboxOrigins {'), source.indexOf('\n}', source.indexOf('export interface SandboxOrigins {')));
        const keys = [...body.matchAll(/^ {4}(\w+)\?:/gm)].map(match => match[1]);
        expect([...keys].sort()).toEqual([...ORIGIN_LISTS].sort());
        expect(ORIGIN_LISTS.filter(list => !(ORIGIN_KINDS as readonly string[]).includes(list))).toEqual(['withoutCors']);
    });
});
