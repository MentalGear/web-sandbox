import { describe, it, expect } from 'vitest';
import { cooperativePolicy, fileKinds, KIND_DIRECTIVES, strictViewPolicy, type PolicyInput } from './csp-generator';
import { NO_ORIGINS, ORIGIN_KINDS, parseOrigins, type OriginKind, type OriginPolicy } from './origins';
import { ORIGIN_PATTERN } from '../origin';
import { parseLikeABrowser, prng, randomInjection } from '../../../test/unit/policy-helpers';

/**
 * The guest policy (ADR-007): one template per mode. The golden strings are the policies; the properties say that no
 * input reaches beyond the six configurable directives, and that only origins do.
 */

const HASH = `'sha256-${'A'.repeat(43)}='`;
const NOTHING: ReadonlySet<OriginKind> = new Set();
const input = (overrides: Partial<PolicyInput> = {}): PolicyInput => ({ origins: NO_ORIGINS, fileKinds: NOTHING, scriptUnsafe: false, ...overrides });
const origins = (config: Record<string, unknown>, mode = 'cooperative') => parseOrigins(config, mode, () => {});
const ALL = origins({
    scripts: ['https://cdn.example'], styles: ['https://css.example'], images: ['https://img.example', 'http://localhost:5173'],
    fonts: ['https://fonts.example'], media: ['https://media.example:8443'], connect: ['https://api.example', 'wss://ws.example'],
});

const COOPERATIVE_DEFAULT = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'; upgrade-insecure-requests";
const STRICT_DEFAULT = `default-src 'none'; script-src ${HASH}; script-src-attr 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'; upgrade-insecure-requests`;

describe('the templates: golden policies', () => {
    it('cooperative (cooperative and worker mode): every directive emitted, nothing admitted beyond the inline bootstrap and inline styles', () => {
        expect(cooperativePolicy(input())).toBe(COOPERATIVE_DEFAULT);
    });

    it('cooperative with every kind, every file kind and scriptUnsafe', () => {
        expect(cooperativePolicy(input({ origins: ALL, fileKinds: new Set(ORIGIN_KINDS), scriptUnsafe: true }))).toBe(
            "default-src 'none'; script-src 'unsafe-inline' https://cdn.example blob: 'unsafe-eval'; style-src 'unsafe-inline' https://css.example blob:; "
            + "img-src https://img.example http://localhost:5173 blob:; font-src https://fonts.example blob:; media-src https://media.example:8443 blob:; "
            + "connect-src https://api.example wss://ws.example blob:; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; "
            + "form-action 'none'; manifest-src 'none'; upgrade-insecure-requests");
    });

    it('strict view, the default: the bootstrap by its hash, no handler attribute', () => {
        expect(strictViewPolicy({ ...input(), bootstrapHash: HASH })).toBe(STRICT_DEFAULT);
    });

    it("strict view with every kind and file kind and scriptUnsafe: scripts are never read, and script-src never gets blob:", () => {
        expect(strictViewPolicy({ ...input({ origins: ALL, fileKinds: new Set(ORIGIN_KINDS), scriptUnsafe: true }), bootstrapHash: HASH })).toBe(
            `default-src 'none'; script-src ${HASH} 'unsafe-eval'; script-src-attr 'none'; style-src 'unsafe-inline' https://css.example blob:; `
            + "img-src https://img.example http://localhost:5173 blob:; font-src https://fonts.example blob:; media-src https://media.example:8443 blob:; "
            + "connect-src https://api.example wss://ws.example blob:; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; "
            + "form-action 'none'; manifest-src 'none'; upgrade-insecure-requests");
    });

    it('a strict view needs one sha256 hash source', () => {
        for (const bad of ['', "'unsafe-inline'", "'sha256-x'", `${HASH}; script-src *`, `${HASH} 'unsafe-inline'`]) {
            expect(() => strictViewPolicy({ ...input(), bootstrapHash: bad }), bad).toThrow(/sha256 hash source/);
        }
    });

    it('the generator takes only origins: a cast that carries a source expression in fails the build', () => {
        for (const bad of ["'self'", '*', 'https:', 'data:', 'https://a.example; script-src *', 'https://a.example/path', 'https://*.example', 7]) {
            const forced = { ...NO_ORIGINS, images: [bad] } as unknown as OriginPolicy;
            expect(() => cooperativePolicy(input({ origins: forced })), String(bad)).toThrow(/not an origin for img-src/);
            expect(() => strictViewPolicy({ ...input({ origins: forced }), bootstrapHash: HASH }), String(bad)).toThrow(/not an origin/);
        }
    });

    it('strict never reads `scripts`, whatever the policy holds there', () => {
        const forced = { ...NO_ORIGINS, scripts: ['https://cdn.example'] } as unknown as OriginPolicy;
        expect(strictViewPolicy({ ...input({ origins: forced, fileKinds: new Set(['scripts' as const]) }), bootstrapHash: HASH })).toBe(STRICT_DEFAULT);
    });
});

describe('fileKinds: blob: for exactly the kinds of load a registered type is for (load-kinds.ts)', () => {
    it.each<[string, OriginKind[]]>([
        ['text/javascript', ['connect', 'scripts']],
        ['application/javascript', ['connect', 'scripts']],
        ['text/css', ['connect', 'styles']],
        ['image/png', ['connect', 'images']],
        ['image/svg+xml', ['connect', 'images']],
        ['font/woff2', ['connect', 'fonts']],
        ['audio/mpeg', ['connect', 'media']],
        ['video/mp4', ['connect', 'media']],
        ['text/vtt', ['connect', 'media']],
        ['application/json', ['connect']],
        ['text/plain', ['connect']],
        ['application/octet-stream', ['connect']],
    ])('%s: %j', (type, kinds) => {
        expect([...fileKinds([type])].sort()).toEqual([...kinds].sort());
    });

    it('no files: no kind', () => {
        expect(fileKinds([]).size).toBe(0);
    });
});

describe('properties over any `origins` input', () => {
    const COOPERATIVE_NAMES = ['default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'media-src', 'connect-src', 'worker-src', 'frame-src', 'object-src', 'base-uri', 'form-action', 'manifest-src', 'upgrade-insecure-requests'];
    const STRICT_NAMES = ['default-src', 'script-src', 'script-src-attr', 'style-src', 'img-src', 'font-src', 'media-src', 'connect-src', 'worker-src', 'frame-src', 'object-src', 'base-uri', 'form-action', 'manifest-src', 'upgrade-insecure-requests'];
    // what each directive holds besides origins and blob:, per template
    const LIBRARY_SOURCES: Record<string, string[]> = { 'script-src': ["'unsafe-inline'", "'unsafe-eval'", HASH], 'style-src': ["'unsafe-inline'"] };
    const CONFIGURABLE = new Set(Object.values(KIND_DIRECTIVES) as string[]);
    const KEYS = [...ORIGIN_KINDS, 'img-src', 'default-src', 'script-src', '__proto__', 'Images', 'frames'];
    const ENTRIES = ['https://a.example', 'https://b.example:8443', 'http://localhost:3000', 'http://127.0.0.1', 'wss://w.example', 'https:', '*', "'self'", 'data:', 'blob:',
        'https://*.a.example', 'https://a.example/p', "https://a.example; script-src 'unsafe-inline'", 'https://a.example,https://b.example', 'HTTPS://C.EXAMPLE:443/', 'http://api.example', ''];

    function randomConfig(random: () => number): Record<string, unknown[]> {
        const config: Record<string, unknown[]> = {};
        for (let k = Math.floor(random() * 5); k > 0; k--) {
            const key = KEYS[Math.floor(random() * KEYS.length)]!;
            const entries: unknown[] = [];
            for (let e = Math.floor(random() * 4); e > 0; e--) entries.push(random() < 0.6 ? ENTRIES[Math.floor(random() * ENTRIES.length)] : randomInjection(random));
            Object.defineProperty(config, key, { value: entries, enumerable: true, writable: true, configurable: true });
        }
        return config;
    }

    // An explicit budget for fixed work (backlog T6's class): 3000 policies generated and parsed. 2.6 s in a full idle
    // run, 5.5 s at load average 14: vitest's 5 s was under twice the idle cost. 12 times it.
    it('3000 random configs, files and switches: the directives are exactly the template\'s, in order, each once; the fixed ones byte-identical; every other source is an origin', { timeout: 30000 }, () => {
        const random = prng(0x0219);
        const fixedOf = (policy: string, names: Set<string>) => policy.split('; ').filter(part => !names.has(part.split(' ')[0]!)).join('; ');
        const cooperativeFixed = fixedOf(COOPERATIVE_DEFAULT, CONFIGURABLE);
        const strictFixed = fixedOf(STRICT_DEFAULT, CONFIGURABLE);
        for (let run = 0; run < 3000; run++) {
            const config = randomConfig(random);
            const mode = random() < 0.5 ? 'strict' : 'cooperative';
            const parsed = parseOrigins(config, mode, () => {});
            const kinds = new Set(ORIGIN_KINDS.filter(() => random() < 0.3));
            const scriptUnsafe = random() < 0.5;
            const context = JSON.stringify({ config, mode, kinds: [...kinds], scriptUnsafe });
            const policy = mode === 'strict'
                ? strictViewPolicy({ origins: parsed, fileKinds: kinds, scriptUnsafe, bootstrapHash: HASH })
                : cooperativePolicy({ origins: parsed, fileKinds: kinds, scriptUnsafe });

            const { names, directives } = parseLikeABrowser(policy);
            expect(names, context).toEqual(mode === 'strict' ? STRICT_NAMES : COOPERATIVE_NAMES);
            expect(fixedOf(policy, CONFIGURABLE), context).toBe(mode === 'strict' ? strictFixed : cooperativeFixed);
            if (mode === 'strict') expect(directives.get('script-src'), context).toEqual(scriptUnsafe ? [HASH, "'unsafe-eval'"] : [HASH]);
            for (const [name, tokens] of directives) {
                for (const token of tokens) {
                    expect(token, context).not.toMatch(/[;,\s"]/);
                    if (!CONFIGURABLE.has(name) || token === 'blob:' || token === "'none'") continue;
                    if ((LIBRARY_SOURCES[name] ?? []).includes(token)) continue;
                    expect(ORIGIN_PATTERN.test(token), `${name} ${token} in ${context}`).toBe(true);
                }
            }
            // nothing beyond what the config listed, in its kind's directive
            for (const kind of ORIGIN_KINDS) {
                const tokens = directives.get(KIND_DIRECTIVES[kind]) ?? [];
                for (const token of tokens.filter(token => ORIGIN_PATTERN.test(token))) expect(parsed[kind], context).toContain(token);
            }
            expect(policy.toLowerCase(), context).not.toMatch(/'self'|data:|\*|'strict-dynamic'|'nonce-|https: |wasm/);
        }
    });

    it("cooperative script-src always holds 'unsafe-inline' and never a nonce, a hash or 'strict-dynamic' (each would make a browser ignore it): the inline bootstrap always runs", () => {
        const random = prng(0xb007);
        for (let run = 0; run < 1000; run++) {
            const parsed = parseOrigins(randomConfig(random), 'cooperative', () => {});
            const kinds = new Set(ORIGIN_KINDS.filter(() => random() < 0.5));
            const scriptSrc = parseLikeABrowser(cooperativePolicy({ origins: parsed, fileKinds: kinds, scriptUnsafe: random() < 0.5 })).directives.get('script-src')!;
            expect(scriptSrc[0]).toBe("'unsafe-inline'");
            expect(scriptSrc.some(token => /^'(nonce|sha256|sha384|sha512)-|^'strict-dynamic'$/i.test(token))).toBe(false);
        }
    });

    it("'unsafe-eval' only with scriptUnsafe, only in script-src, in both templates", () => {
        for (const scriptUnsafe of [false, true]) {
            for (const policy of [cooperativePolicy(input({ origins: ALL, scriptUnsafe })), strictViewPolicy({ ...input({ origins: ALL, scriptUnsafe }), bootstrapHash: HASH })]) {
                const { directives } = parseLikeABrowser(policy);
                for (const [name, tokens] of directives) expect(tokens.includes("'unsafe-eval'"), name).toBe(scriptUnsafe && name === 'script-src');
            }
        }
    });
});
