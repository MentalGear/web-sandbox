import { describe, it, expect, vi } from 'vitest';
import { isVirtualKey, mergeGuestImportMaps } from './import-map';

/**
 * The guest's own inline import maps, merged on the host into the one map the bootstrap registers
 * (ADR-004, PR3). Guarantees: an invalid map is left out with a warning; maps merge in document order,
 * earlier entries winning; no guest entry can match a URL in https://vfs.invalid/, which only the host maps.
 */

const merge = (...texts: string[]) => {
    const warn = vi.fn();
    const json = mergeGuestImportMaps(texts, warn);
    return { map: json === null ? null : JSON.parse(json), warnings: warn.mock.calls.map(call => String(call[0])) };
};

describe('isVirtualKey: keys that could match a URL in the virtual origin', () => {
    it.each([
        'https://vfs.invalid/app/x.js',
        'https://vfs.invalid/',
        'https://vfs.invalid/app/',
        'HTTPS://VFS.INVALID/app/x.js', // the browser normalises URL-like keys
        'https://vfs.invalid:443/x.js',
        'https://',
        'https:/',
    ])('%j is ours', (key) => {
        expect(isVirtualKey(key)).toBe(true);
    });

    it.each([
        'lodash',
        'app/x.js',
        './app/x.js', // cannot be resolved against the guest's about:blank base: stays a literal key
        '/app/x.js',
        'https://cdn.example/x.js',
        'https://vfs.invalid.example/x.js',
        'https://vfs.invalid:8443/x.js',
        'https://vfs',
        'http://vfs.invalid/x.js',
    ])('%j is the guest\'s', (key) => {
        expect(isVirtualKey(key)).toBe(false);
    });
});

describe('mergeGuestImportMaps', () => {
    it('returns null when there is no map', () => {
        expect(merge()).toEqual({ map: null, warnings: [] });
    });

    it('passes a valid map through: imports, scopes, integrity', () => {
        const guest = {
            imports: { lodash: 'https://cdn.example/lodash.js', 'pkg/': 'https://cdn.example/pkg/' },
            scopes: { 'https://cdn.example/': { dep: 'https://cdn.example/dep.js' } },
            integrity: { 'https://cdn.example/lodash.js': 'sha384-abc' },
        };
        expect(merge(JSON.stringify(guest))).toEqual({ map: guest, warnings: [] });
    });

    it.each([
        ['not JSON', '{ imports: {} }'],
        ['empty', ''],
        ['an array', '[]'],
        ['a string', '"x"'],
        ['null', 'null'],
        ['imports not an object', '{"imports": []}'],
        ['imports null', '{"imports": null}'],
        ['scopes not an object', '{"scopes": "x"}'],
        ['a scope not an object', '{"scopes": {"https://a.example/": []}}'],
        ['integrity not an object', '{"integrity": 1}'],
    ])('leaves out an invalid map (%s) with one warning', (_label, text) => {
        const { map, warnings } = merge(text);
        expect(map).toBeNull();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('not a valid import map');
    });

    it('merges several maps in document order: the earlier entry wins; an invalid one in between is left out', () => {
        const { map, warnings } = merge(
            '{"imports": {"a": "https://one.example/a.js"}, "scopes": {"https://s.example/": {"x": "https://one.example/x.js"}}}',
            'not json',
            '{"imports": {"a": "https://two.example/a.js", "b": "https://two.example/b.js"}, "scopes": {"https://s.example/": {"x": "https://two.example/x.js", "y": "https://two.example/y.js"}}}',
        );
        expect(map).toEqual({
            imports: { a: 'https://one.example/a.js', b: 'https://two.example/b.js' },
            scopes: { 'https://s.example/': { x: 'https://one.example/x.js', y: 'https://two.example/y.js' } },
        });
        expect(warnings).toEqual([expect.stringContaining('#2 is not a valid import map')]);
    });

    it('ours win: every guest key that could match a virtual URL is dropped, in imports and in every scope, with one warning', () => {
        const { map, warnings } = merge(JSON.stringify({
            imports: {
                'https://vfs.invalid/app/x.js': 'https://attacker.test/hijack.js',
                'https://vfs.invalid/': 'https://attacker.test/',
                'https://': 'https://attacker.test/',
                keep: 'https://cdn.example/keep.js',
            },
            scopes: { 'blob:': { 'https://vfs.invalid/app/x.js': 'https://attacker.test/hijack.js', 'HTTPS://VFS.INVALID/y.js': 'https://attacker.test/y.js', keep: 'https://cdn.example/scoped.js' } },
        }));
        expect(map).toEqual({ imports: { keep: 'https://cdn.example/keep.js' }, scopes: { 'blob:': { keep: 'https://cdn.example/scoped.js' } } });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('https://vfs.invalid/app/x.js');
        expect(warnings[0]).toContain('only the sandbox maps them');
    });

    it('a "__proto__" key is an ordinary entry, never a prototype', () => {
        const { map } = merge('{"imports": {"__proto__": "https://cdn.example/p.js", "a": "https://cdn.example/a.js"}}');
        expect(Object.keys(map.imports)).toEqual(['__proto__', 'a']);
        expect(Object.getPrototypeOf(map.imports)).toBe(Object.prototype); // JSON.parse of our output: an own key
    });

    it('keeps values as the guest wrote them, including markup-like text: they travel as JSON data', () => {
        const value = '</script><script>alert(1)</script><!--';
        const { map } = merge(JSON.stringify({ imports: { x: value } }));
        expect(map.imports.x).toBe(value);
    });
});
