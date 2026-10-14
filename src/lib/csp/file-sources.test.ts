import { describe, it, expect, vi, afterEach } from 'vitest';
import { addFileSources, kindsForTypes } from './file-sources';
import { effectiveDirective, fallbackList } from './effective-directive';
import { prng } from '../../../test/unit/policy-helpers';
import { generateCSP } from './csp-generator';
import type { CSPDirectives } from '@src/csp-directives';
import { sanitizeDirectives } from './policy-grammar';

// the policy steps take only the grammar's output (PolicyTokens, A1): test policies go through it, as the host's do
const tokens = (directives: CSPDirectives) => sanitizeDirectives(directives);

describe('kindsForTypes: blob: goes only where a registered type loads', () => {
    it('no files: no directive', () => {
        expect([...kindsForTypes([])]).toEqual([]);
    });

    it.each([
        ['text/javascript', ['connect-src', 'script-src-elem']],
        ['application/javascript', ['connect-src', 'script-src-elem']],
        ['text/css', ['connect-src', 'style-src-elem']],
        ['image/svg+xml', ['connect-src', 'img-src']],
        ['font/woff2', ['connect-src', 'font-src']],
        ['audio/mpeg', ['connect-src', 'media-src']],
        ['video/mp4', ['connect-src', 'media-src']],
        ['text/vtt', ['connect-src', 'media-src']],
        ['application/json', ['connect-src']],
        ['text/html', ['connect-src']],
        ['application/octet-stream', ['connect-src']],
    ])('%s → %j', (type, directives) => {
        expect([...kindsForTypes([type])].sort()).toEqual(directives);
    });
});

describe('addFileSources', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    // the shipping default (DEFAULT_SANDBOX_CONFIG): fetch directives it does not set are left out
    const BASE: CSPDirectives = {
        'default-src': ["'none'"],
        'script-src': ["'unsafe-inline'"],
        'style-src': ["'unsafe-inline'"],
        'base-uri': [],
        'form-action': [],
        'worker-src': ['blob:'],
    };

    it('changes nothing without files', () => {
        const warn = vi.spyOn(console, 'warn');
        expect(addFileSources(tokens(BASE), [], new Set())).toEqual(BASE);
        expect(warn).not.toHaveBeenCalled();
    });

    it('adds blob: only to the directives of the types present, and never to base-uri, form-action or default-src', () => {
        const out = addFileSources(tokens(BASE), ['text/javascript', 'image/png'], new Set());
        expect(out).toEqual({
            ...BASE,
            'script-src': ["'unsafe-inline'", 'blob:'],
            'img-src': ['blob:'],
            'connect-src': ['blob:'],
        });
    });

    it('does not mutate its input', () => {
        const input = structuredClone(BASE);
        addFileSources(tokens(input), ['text/javascript', 'text/css', 'font/woff2', 'audio/ogg', 'image/gif'], new Set());
        expect(input).toEqual(BASE);
    });

    it('an omitted directive keeps what default-src granted it: default-src sources are copied in before blob:', () => {
        const directives: CSPDirectives = {
            'default-src': ['https://cdn.example', "'none'", "'SELF'", "'unsafe-inline' https://two.example"],
            // img-src, font-src and connect-src omitted
        };
        const out = addFileSources(tokens(directives), ['image/png', 'font/woff2'], new Set());
        const inherited = ['https://cdn.example', "'unsafe-inline'", 'https://two.example'];
        expect(out['img-src']).toEqual([...inherited, 'blob:']);
        expect(out['font-src']).toEqual([...inherited, 'blob:']);
        expect(out['connect-src']).toEqual([...inherited, 'blob:']);
        expect(out['default-src']).toEqual(tokens(directives)['default-src']); // untouched
    });

    it.each([
        ['none', ["'none'"]],
        ['empty', []],
        ['blank', ['', '  ']],
        ['omitted', undefined],
    ])("with a %s default-src, an omitted directive becomes blob: alone", (_, defaultSrc) => {
        const directives: CSPDirectives = defaultSrc === undefined ? {} : { 'default-src': defaultSrc };
        const out = addFileSources(tokens(directives), ['image/png'], new Set());
        expect(out['img-src']).toEqual(['blob:']);
        expect(out['connect-src']).toEqual(['blob:']);
        // and the emitted policy denies everything else
        expect(generateCSP(out)).toBe("default-src 'none'; connect-src blob:; img-src blob:;");
    });

    it("an empty directive is 'none' (S16): kept, with the warning, never widened to default-src's sources", () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const directives: CSPDirectives = { 'default-src': ['https://cdn.example'], 'img-src': [], 'connect-src': [''] };
        const out = addFileSources(tokens(directives), ['image/png'], new Set());
        expect(out['img-src']).toEqual([]);
        expect(out['connect-src']).toEqual([]); // [''] is [] in the grammar's tokens
        expect(generateCSP(out)).toBe("default-src https://cdn.example; img-src 'none'; connect-src 'none';");
        expect(warn.mock.calls.map(c => String(c[0]))).toEqual([
            expect.stringContaining('connectionsAllowed.connect-src'),
            expect.stringContaining('connectionsAllowed.img-src'),
        ]);
    });

    it("keeps an embedder's explicit 'none' and warns once per directive per instance that those files will not load", () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const warned = new Set<string>();
        const directives: CSPDirectives = { ...BASE, 'img-src': ["'NONE'"], 'style-src': ["'none'"] };

        for (let build = 0; build < 3; build++) {
            const out = addFileSources(tokens(directives), ['image/png', 'text/css'], warned);
            expect(out['img-src']).toEqual(["'NONE'"]);
            expect(out['style-src']).toEqual(["'none'"]);
            expect(out['connect-src']).toEqual(['blob:']);
        }
        const messages = warn.mock.calls.map(call => String(call[0]));
        expect(messages).toHaveLength(2);
        expect(messages.some(m => m.includes('connectionsAllowed.img-src') && m.includes('will not load'))).toBe(true);
        expect(messages.some(m => m.includes('connectionsAllowed.style-src') && m.includes('will not load'))).toBe(true);
    });

    it('exclude (strict mode): an excluded directive never gets blob:, even with files of its type and no config for it', () => {
        expect([...kindsForTypes(['text/javascript', 'image/png'], ['script-src-elem'])].sort()).toEqual(['connect-src', 'img-src']);
        const out = addFileSources(tokens({ 'default-src': ['https://d.example'] }), ['text/javascript', 'image/png'], new Set(), { exclude: ['script-src-elem'] });
        expect(out['script-src']).toBeUndefined();
        expect(out['img-src']).toEqual(['https://d.example', 'blob:']);
    });

    it('leaves a malformed directive for generateCSP to reject', () => {
        const directives = { ...BASE, 'img-src': 'blob:' } as unknown as CSPDirectives;
        expect(addFileSources(tokens(directives), ['image/png'], new Set())['img-src']).toBe('blob:');
    });
});

// addFileSources as it was before the fallback table (448f750), for the byte-identity property below.
function legacyAddFileSources(directives: CSPDirectives, types: Iterable<string>): CSPDirectives {
    const tokensOf = (values: readonly unknown[]) => values.flatMap(value => typeof value === 'string' ? value.trim().split(/\s+/).filter(Boolean) : []);
    const isKeyword = (token: string, keyword: string) => token.toLowerCase() === keyword;
    const needed = new Set<string>();
    for (const type of types) {
        needed.add('connect-src');
        if (type === 'text/javascript') needed.add('script-src');
        if (type === 'text/css') needed.add('style-src');
        if (type.startsWith('image/')) needed.add('img-src');
        if (type.startsWith('font/')) needed.add('font-src');
        if (type.startsWith('audio/') || type.startsWith('video/') || type === 'text/vtt') needed.add('media-src');
    }
    const output: Record<string, unknown> = { ...directives };
    const defaultSrc = Array.isArray(directives['default-src']) ? tokensOf(directives['default-src']) : [];
    const inherited = defaultSrc.filter(token => !isKeyword(token, "'none'") && !isKeyword(token, "'self'"));
    for (const name of needed) {
        const values = (directives as Record<string, unknown>)[name];
        if (values !== undefined && !Array.isArray(values)) continue;
        if (values === undefined) {
            output[name] = [...inherited, 'blob:'];
            continue;
        }
        if (tokensOf(values).every(token => isKeyword(token, "'none'"))) continue;
        output[name] = [...(values as string[]), 'blob:'];
    }
    return output as CSPDirectives;
}

// What the implementation before the table produced, with the one change of the broad review (PA1): where the blob:
// it added to (or the script-src it created for) registered scripts reached worker-src through its fallback, worker-src
// is pinned to what governed it before, as a directive of its own appended last. Written out here, independently.
const WORKER_FALLBACK = ['worker-src', 'child-src', 'script-src', 'default-src'];
function withWorkersPinned(input: CSPDirectives, legacy: CSPDirectives): CSPDirectives {
    const governing = (policy: CSPDirectives) => WORKER_FALLBACK.find(name => Object.hasOwn(policy, name));
    const tokens = (policy: CSPDirectives) => {
        const name = governing(policy);
        const values = name ? (policy as Record<string, unknown>)[name] : [];
        return new Set((Array.isArray(values) ? values : []).flatMap(v => String(v).trim().split(/\s+/)).filter(t => t && t.toLowerCase() !== "'none'").map(t => t.toLowerCase()));
    };
    const was = tokens(input);
    if ([...tokens(legacy)].every(token => was.has(token))) return legacy;
    const name = governing(input);
    const values = name ? (input as Record<string, unknown>)[name] : [];
    return { ...legacy, 'worker-src': Array.isArray(values) ? [...values] : [] } as CSPDirectives;
}

describe('addFileSources over the one fallback table (follow-up audit 2026-10-14, the A3 class)', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('script-src-elem and style-src-elem, when set, govern scripts and stylesheets: blob: goes there, and script-src / style-src are left as they were', () => {
        const directives: CSPDirectives = {
            'default-src': ["'none'"],
            'script-src': ["'unsafe-inline'"],
            'script-src-elem': ["'unsafe-inline'"],
            'style-src': ["'unsafe-inline'"],
            'style-src-elem': ["'unsafe-inline'"],
        };
        const out = addFileSources(tokens(directives), ['text/javascript', 'text/css'], new Set());
        expect(out).toEqual({
            ...directives,
            'script-src-elem': ["'unsafe-inline'", 'blob:'],
            'style-src-elem': ["'unsafe-inline'", 'blob:'],
            'connect-src': ['blob:'],
        });
        // the policy grants blob: exactly where the browser checks these loads, and nowhere else
        expect(generateCSP(out)).toBe("default-src 'none'; script-src 'unsafe-inline'; script-src-elem 'unsafe-inline' blob:; style-src 'unsafe-inline'; style-src-elem 'unsafe-inline' blob:; connect-src blob:;");
    });

    it("an -elem directive that is 'none' keeps the files out, with the warning naming it, even when the base directive would admit them", () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const directives: CSPDirectives = { 'script-src': ["'unsafe-inline'"], 'script-src-elem': [] };
        const out = addFileSources(tokens(directives), ['text/javascript'], new Set());
        expect([out['script-src'], out['script-src-elem']]).toEqual([["'unsafe-inline'"], []]);
        expect(warn.mock.calls.map(c => String(c[0]))).toEqual([expect.stringContaining('connectionsAllowed.script-src-elem')]);
    });

    it("a base directive that is 'none' does not keep files out when the -elem directive governs and admits them", () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const out = addFileSources(tokens({ 'style-src': ["'none'"], 'style-src-elem': ["'unsafe-inline'"] }), ['text/css'], new Set());
        expect([out['style-src'], out['style-src-elem']]).toEqual([["'none'"], ["'unsafe-inline'", 'blob:']]);
        expect(warn).not.toHaveBeenCalled();
    });

    it('-attr directives govern no load a file can be: a config with them adds blob: where it did before', () => {
        const directives: CSPDirectives = { 'script-src': ["'unsafe-inline'"], 'script-src-attr': ["'none'"], 'style-src-attr': ["'unsafe-inline'"] };
        expect(addFileSources(tokens(directives), ['text/javascript', 'text/css'], new Set())).toEqual(withWorkersPinned(directives, legacyAddFileSources(directives, ['text/javascript', 'text/css'])));
    });

    it('the table: the first directive of a kind\'s fallback list that the policy holds governs it; null means default-src', () => {
        expect(effectiveDirective({ 'script-src-elem': ["'unsafe-inline'"], 'script-src': ['blob:'] }, 'script-src-elem')).toBe('script-src-elem');
        expect(effectiveDirective({ 'script-src': ['x'] }, 'script-src-elem')).toBe('script-src');
        expect(effectiveDirective({ 'script-src': ['x'] }, 'script-src-attr')).toBe('script-src');
        expect(effectiveDirective({ 'default-src': ['x'] }, 'style-src-elem')).toBe('default-src');
        expect(effectiveDirective({ 'child-src': [] }, 'worker-src')).toBe('child-src');
        expect(effectiveDirective({ 'script-src-elem': [] }, 'eval')).toBeNull();
        expect(effectiveDirective({}, 'img-src')).toBeNull();
        expect(fallbackList('worker-src')).toEqual(['worker-src', 'child-src', 'script-src', 'default-src']);
        expect(fallbackList('frame-src')).toEqual(['frame-src', 'child-src', 'default-src']);
    });

    it('property: 500 random configs without -elem / -attr directives come out byte-identical to the implementation before the table, but for worker-src pinned where blob: reached it (broad review PA1)', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const random = prng(0xa3);
        const NAMES = ['default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'media-src', 'connect-src', 'worker-src', 'base-uri', 'form-action', 'frame-src', 'object-src', 'manifest-src', 'child-src'];
        const SOURCES = ["'none'", "'NONE'", "'self'", "'unsafe-inline'", 'https://a.example', 'blob:', 'data:', '', ' ', "'none' https://b.example", '*'];
        const TYPES = ['text/javascript', 'text/css', 'image/png', 'font/woff2', 'audio/ogg', 'video/mp4', 'text/vtt', 'application/json'];
        const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
        for (let run = 0; run < 500; run++) {
            const directives: Record<string, string[]> = {};
            for (const name of NAMES) {
                if (random() < 0.5) continue;
                const values: string[] = [];
                for (let i = Math.floor(random() * 3); i > 0; i--) values.push(pick(SOURCES));
                directives[name] = values;
            }
            const types: string[] = [];
            for (let i = Math.floor(random() * 4); i > 0; i--) types.push(pick(TYPES));
            const input = tokens(directives as CSPDirectives); // blank and multi-token values arrive split, as from the host
            const now = addFileSources(input, types, new Set());
            const before = withWorkersPinned(input, legacyAddFileSources(input, types));
            expect(generateCSP(now), JSON.stringify({ directives, types })).toBe(generateCSP(before));
            expect(now).toEqual(before);
        }
    });
});
