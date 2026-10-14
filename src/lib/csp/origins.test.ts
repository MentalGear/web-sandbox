import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_ORIGINS, ORIGIN_KINDS, originRules, parseOrigins, type SandboxOrigins, type StrictSandboxOrigins } from './origins';
import type { SandboxConfig } from '../../host';

const parse = (input: unknown, mode: unknown = 'iframe') => {
    const warnings: string[] = [];
    const policy = parseOrigins(input, mode, (message) => warnings.push(message));
    return { policy, warnings };
};

describe('parseOrigins: `origins` parsed once, at the boundary (ADR-007)', () => {
    it('keeps exact origins per kind, canonical and without duplicates; every kind is present', () => {
        const { policy, warnings } = parse({ images: ['https://img.example', 'HTTPS://IMG.example:443/'], connect: ['wss://ws.example', 'http://localhost:3000'] });
        expect(policy).toEqual({ scripts: [], styles: [], images: ['https://img.example'], fonts: [], media: [], connect: ['wss://ws.example', 'http://localhost:3000'] });
        expect(warnings).toEqual([]);
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
        const { policy, warnings } = parse({ connect: ['wss://a.example'], images: ['wss://a.example'] });
        expect([policy.connect, policy.images]).toEqual([['wss://a.example'], []]);
        expect(warnings).toEqual([expect.stringContaining('origins.images entry "wss://a.example"')]);
    });

    it('drops a key that is not a kind, with one warning, whatever its value', () => {
        const { policy, warnings } = parse(JSON.parse('{"img-src": ["https://a.example"], "Images": 5, "__proto__": {"images": ["https://p.example"]}}'));
        expect(policy).toEqual(NO_ORIGINS);
        expect(warnings).toEqual([
            '[Sandbox] origins."img-src" was dropped: origins takes scripts, styles, images, fonts, media, connect.',
            '[Sandbox] origins."Images" was dropped: origins takes scripts, styles, images, fonts, media, connect.',
            '[Sandbox] origins."__proto__" was dropped: origins takes scripts, styles, images, fonts, media, connect.',
        ]);
    });

    it('strict mode: scripts are dropped with one warning; an empty list says nothing', () => {
        const strict = parse({ scripts: ['https://cdn.example'], images: ['https://img.example'] }, 'strict');
        expect([strict.policy.scripts, strict.policy.images]).toEqual([[], ['https://img.example']]);
        expect(strict.warnings).toEqual(["[Sandbox] origins.scripts is not used in strict mode and was dropped: the view runs only the library's bootstrap, and the worker loads no script (see docs/ADR-005)."]);
        expect(parse({ scripts: [] }, 'strict').warnings).toEqual([]);
        for (const mode of ['iframe', 'worker', undefined]) expect(parse({ scripts: ['https://cdn.example'] }, mode).policy.scripts, String(mode)).toEqual(['https://cdn.example']);
    });

    it('absent, and every kind absent or undefined: no origin', () => {
        expect(parse(undefined).policy).toEqual(NO_ORIGINS);
        expect(parse({}).policy).toEqual(NO_ORIGINS);
        expect(parse({ images: undefined }).policy).toEqual(NO_ORIGINS);
    });

    it.each([[null], ['https://a.example'], [['https://a.example']], [7], [true]])('a value that is not an object refuses the config: %j', (value) => {
        expect(() => parse(value)).toThrowError(new TypeError('origins must be an object of origin lists'));
    });

    it.each([['a string', 'https://a.example'], ['null', null], ['an object', { 0: 'https://a.example' }], ['a number', 1]])('a kind that is not a list refuses the config: %s', (_, value) => {
        expect(() => parse({ images: value })).toThrowError(new TypeError('origins.images must be a list of origins'));
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
        const iframe: SandboxConfig = { origins: { scripts: ['https://cdn.example'] } };
        const worker: SandboxConfig = { mode: 'worker', origins: { scripts: ['https://cdn.example'] } };
        // a mode chosen at run time takes origins that every mode can use
        const anyMode = (mode: 'iframe' | 'worker' | 'strict'): SandboxConfig => ({ mode, origins: strictOrigins });
        // @ts-expect-error connectionsAllowed was removed
        const removed: SandboxConfig = { connectionsAllowed: { 'img-src': ['https://a.example'] } };
        // @ts-expect-error a kind takes origins, not a source string
        const notAList: SandboxConfig = { origins: { images: 'https://a.example' } };
        // @ts-expect-error not a kind
        const notAKind: SandboxOrigins = { 'img-src': ['https://a.example'] };
        expect([strict, strictScripts, strictFromVariable, iframe, worker, anyMode('strict'), removed, notAList, notAKind]).toHaveLength(9);
    });

    it('ORIGIN_KINDS are exactly the keys of SandboxOrigins', () => {
        const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'origins.ts'), 'utf8');
        const body = source.slice(source.indexOf('export interface SandboxOrigins {'), source.indexOf('\n}', source.indexOf('export interface SandboxOrigins {')));
        const keys = [...body.matchAll(/^ {4}(\w+)\?:/gm)].map(match => match[1]);
        expect([...keys].sort()).toEqual([...ORIGIN_KINDS].sort());
    });
});
