import { describe, it, expect, vi, afterEach } from 'vitest';
import { dropMetaIgnoredDirectives, META_IGNORED_DIRECTIVES } from './drop-meta-ignored';
import { generateCSP } from './csp-generator';
import type { CSPDirectives } from '@src/csp-directives';

const warnings = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(call => String(call[0]));

describe('dropMetaIgnoredDirectives (backlog S7)', () => {
    afterEach(() => { vi.restoreAllMocks(); });
    const spyWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

    it('pins the four directives a <meta> policy discards', () => {
        expect([...META_IGNORED_DIRECTIVES]).toEqual(['frame-ancestors', 'report-uri', 'report-to', 'sandbox']);
    });

    for (const directive of META_IGNORED_DIRECTIVES) {
        describe(directive, () => {
            for (const [label, values] of [['a source list', ["'none'", 'https://a.example']], ['an empty list', []], ['a single value', ['allow-scripts']]] as const) {
                it(`is left out of the emitted policy when set to ${label}, with one warning naming it`, () => {
                    const warn = spyWarn();
                    const out = dropMetaIgnoredDirectives({ 'script-src': ["'unsafe-inline'"], [directive]: [...values] } as CSPDirectives, new Set());

                    expect(out).toEqual({ 'script-src': ["'unsafe-inline'"] });
                    // not 'none' either: the browser would discard any value
                    expect(generateCSP(out)).not.toContain(directive);
                    expect(warnings(warn)).toHaveLength(1);
                    expect(warnings(warn)[0]).toContain(`connectionsAllowed.${directive}`);
                    expect(warnings(warn)[0]).toContain('<meta>');
                });
            }

            it('warns once per instance however often it is configured, in any case', () => {
                const warn = spyWarn();
                const warned = new Set<string>();
                dropMetaIgnoredDirectives({ [directive]: ['x'] } as CSPDirectives, warned);
                const out = dropMetaIgnoredDirectives({ [directive.toUpperCase()]: ['x'] } as CSPDirectives, warned);
                dropMetaIgnoredDirectives({ [directive]: [] } as CSPDirectives, warned);

                expect(out).toEqual({});
                expect(warnings(warn)).toHaveLength(1);

                // another instance has its own memory
                dropMetaIgnoredDirectives({ [directive]: ['x'] } as CSPDirectives, new Set());
                expect(warnings(warn)).toHaveLength(2);
            });
        });
    }

    it('one warning per directive when all four are configured at once', () => {
        const warn = spyWarn();
        const all = Object.fromEntries(META_IGNORED_DIRECTIVES.map(directive => [directive, ['x']]));
        expect(dropMetaIgnoredDirectives(all as CSPDirectives, new Set())).toEqual({});
        const named = META_IGNORED_DIRECTIVES.map(directive => warnings(warn).filter(w => w.includes(`connectionsAllowed.${directive}"`)).length);
        expect(named).toEqual([1, 1, 1, 1]);
    });

    it("leaves every other directive untouched and silent; an empty one still becomes 'none' (S16)", () => {
        const warn = spyWarn();
        const directives: CSPDirectives = {
            'upgrade-insecure-requests': true,
            'default-src': [],
            'script-src': ["'unsafe-inline'"],
            'connect-src': ['https://api.example'],
            'base-uri': [],
            'form-action': [],
            'frame-src': [],
        };
        const out = dropMetaIgnoredDirectives(directives, new Set());

        expect(out).toEqual(directives);
        expect(out).not.toBe(directives); // a copy: the caller's config is never changed
        expect(generateCSP(out)).toBe("default-src 'none'; upgrade-insecure-requests; script-src 'unsafe-inline'; connect-src https://api.example; base-uri 'none'; form-action 'none'; frame-src 'none';");
        expect(warn).not.toHaveBeenCalled();
    });
});
