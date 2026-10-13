import { describe, it, expect, vi, afterEach } from 'vitest';
import { addFileSources, directivesForTypes } from './file-sources';
import type { CSPDirectives } from '@src/csp-directives';

describe('directivesForTypes: blob: goes only where a registered type loads', () => {
    it('no files: no directive', () => {
        expect([...directivesForTypes([])]).toEqual([]);
    });

    it.each([
        ['text/javascript', ['connect-src', 'script-src']],
        ['application/javascript', ['connect-src', 'script-src']],
        ['text/css', ['connect-src', 'style-src']],
        ['image/svg+xml', ['connect-src', 'img-src']],
        ['font/woff2', ['connect-src', 'font-src']],
        ['audio/mpeg', ['connect-src', 'media-src']],
        ['video/mp4', ['connect-src', 'media-src']],
        ['text/vtt', ['connect-src', 'media-src']],
        ['application/json', ['connect-src']],
        ['text/html', ['connect-src']],
        ['application/octet-stream', ['connect-src']],
    ])('%s → %j', (type, directives) => {
        expect([...directivesForTypes([type])].sort()).toEqual(directives);
    });
});

describe('addFileSources', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    const BASE: CSPDirectives = {
        'default-src': ["'none'"],
        'script-src': ["'unsafe-inline'"],
        'style-src': ["'unsafe-inline'"],
        'connect-src': [],
        'img-src': [],
        'font-src': [],
        'media-src': [],
        'base-uri': [],
        'form-action': [],
        'worker-src': ['blob:', 'data:'],
    };

    it('changes nothing without files', () => {
        const warn = vi.spyOn(console, 'warn');
        expect(addFileSources(BASE, [], new Set())).toEqual(BASE);
        expect(warn).not.toHaveBeenCalled();
    });

    it('adds blob: only to the directives of the types present, and never to base-uri, form-action or default-src', () => {
        const out = addFileSources(BASE, ['text/javascript', 'image/png'], new Set());
        expect(out).toEqual({
            ...BASE,
            'script-src': ["'unsafe-inline'", 'blob:'],
            'img-src': ['blob:'],
            'connect-src': ['blob:'],
        });
    });

    it('does not mutate its input', () => {
        const input = structuredClone(BASE);
        addFileSources(input, ['text/javascript', 'text/css', 'font/woff2', 'audio/ogg', 'image/gif'], new Set());
        expect(input).toEqual(BASE);
    });

    it('an empty or omitted directive keeps what default-src granted it: default-src sources are copied in before blob:', () => {
        const directives: CSPDirectives = {
            'default-src': ['https://cdn.example', "'none'", "'SELF'", "'unsafe-inline' https://two.example"],
            'img-src': [],
            // font-src omitted entirely
        };
        const out = addFileSources(directives, ['image/png', 'font/woff2'], new Set());
        const inherited = ['https://cdn.example', "'unsafe-inline'", 'https://two.example'];
        expect(out['img-src']).toEqual([...inherited, 'blob:']);
        expect(out['font-src']).toEqual([...inherited, 'blob:']);
        expect(out['connect-src']).toEqual([...inherited, 'blob:']);
        expect(out['default-src']).toEqual(directives['default-src']); // untouched
    });

    it("with default-src 'none', an empty directive becomes blob: alone", () => {
        expect(addFileSources({ 'default-src': ["'none'"], 'img-src': [] }, ['image/png'], new Set())['img-src']).toEqual(['blob:']);
    });

    it("keeps an embedder's explicit 'none' and warns once per directive per instance that those files will not load", () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const warned = new Set<string>();
        const directives: CSPDirectives = { ...BASE, 'img-src': ["'NONE'"], 'style-src': ["'none'"] };

        for (let build = 0; build < 3; build++) {
            const out = addFileSources(directives, ['image/png', 'text/css'], warned);
            expect(out['img-src']).toEqual(["'NONE'"]);
            expect(out['style-src']).toEqual(["'none'"]);
            expect(out['connect-src']).toEqual(['blob:']);
        }
        const messages = warn.mock.calls.map(call => String(call[0]));
        expect(messages).toHaveLength(2);
        expect(messages.some(m => m.includes('connectionsAllowed.img-src') && m.includes('will not load'))).toBe(true);
        expect(messages.some(m => m.includes('connectionsAllowed.style-src') && m.includes('will not load'))).toBe(true);
    });

    it('leaves a malformed directive for generateCSP to reject', () => {
        const directives = { ...BASE, 'img-src': 'blob:' } as unknown as CSPDirectives;
        expect(addFileSources(directives, ['image/png'], new Set())['img-src']).toBe('blob:');
    });
});
