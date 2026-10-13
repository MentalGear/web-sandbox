import { describe, it, expect } from 'vitest';
import {
    FALLBACK_TYPE, FileStore, MAX_FILES, MAX_PATH_LENGTH, MAX_TOTAL_BYTES,
    isValidMimeType, isValidPath, mimeTypeFor, type FileErrorCode,
} from './files';

const BASE = 'https://vfs.invalid/';

// Paths a guest could also reach by spelling them differently, or that a URL parser would rewrite.
const REJECTED_PATHS: [label: string, path: unknown][] = [
    ['empty', ''],
    ['parent segment', '..'],
    ['parent prefix', '../x.js'],
    ['parent inside', 'a/../b.js'],
    ['current segment', '.'],
    ['current prefix', './x.js'],
    ['current inside', 'a/./b.js'],
    ['absolute', '/x.js'],
    ['double slash', 'a//b.js'],
    ['trailing slash', 'a/'],
    ['protocol-relative', '//host/x.js'],
    ['backslash', 'a\\b.js'],
    ['backslash traversal', '..\\x.js'],
    ['encoded dots (lower)', '%2e%2e/x.js'],
    ['encoded dots (upper)', '%2E%2E/x.js'],
    ['encoded slash', '..%2fx.js'],
    ['any percent', 'a%20b.js'],
    ['drive letter', 'c:/x.js'],
    ['scheme', 'https://evil.example/x.js'],
    ['scheme only', 'https:x.js'],
    ['query', 'x.js?v=1'],
    ['fragment', 'x.js#a'],
    ['tab', 'a\tb.js'],
    ['line feed', 'a\nb.js'],
    ['space', 'a b.js'],
    ['NUL', 'a\u0000b.js'],
    ['fullwidth dots', '\uFF0E\uFF0E/x.js'],
    ['non-ASCII', 'caf\u00E9.js'],
    ['overlong', 'a'.repeat(MAX_PATH_LENGTH + 1)],
    ['number', 42],
    ['null', null],
    ['undefined', undefined],
    ['object', { toString: () => 'x.js' }],
    ['array', ['x.js']],
];

const ACCEPTED_PATHS = [
    'index.html',
    'x.js',
    'src/main.js',
    'a/b/c/d.css',
    'assets/logo.svg',
    '.env',
    '...',
    'a..b.js',
    'file.name.with.dots.txt',
    "weird~!$&'()*+,;=@-_.chars",
    'UPPER/Case.JS',
    'a'.repeat(MAX_PATH_LENGTH),
];

describe('isValidPath: a path is accepted only in its one canonical spelling', () => {
    it.each(REJECTED_PATHS)('refuses %s', (_label, path) => {
        expect(isValidPath(path)).toBe(false);
    });

    it.each(ACCEPTED_PATHS)('accepts %j', (path) => {
        expect(isValidPath(path)).toBe(true);
    });

    it('round-trips: every accepted path is exactly what new URL() keeps, for every printable ASCII character in every position', () => {
        let accepted = 0;
        for (let code = 0x20; code < 0x7f; code++) {
            const ch = String.fromCharCode(code);
            for (const path of [ch, `a${ch}`, `${ch}a`, `a/${ch}`, `${ch}/a`, `a${ch}b/c`]) {
                if (!isValidPath(path)) continue;
                accepted++;
                expect(new URL(path, BASE).href).toBe(BASE + path);
            }
        }
        expect(accepted).toBeGreaterThan(100); // the property was exercised, not vacuously true
    });
});

describe('mimeTypeFor: never empty', () => {
    it.each([
        ['main.js', 'text/javascript'],
        ['lib/mod.MJS', 'text/javascript'],
        ['style.css', 'text/css'],
        ['index.html', 'text/html'],
        ['data.json', 'application/json'],
        ['logo.svg', 'image/svg+xml'],
        ['a.PNG', 'image/png'],
        ['a.jpeg', 'image/jpeg'],
        ['a.webp', 'image/webp'],
        ['font.woff2', 'font/woff2'],
        ['module.wasm', 'application/wasm'],
        ['clip.mp4', 'video/mp4'],
        ['sound.mp3', 'audio/mpeg'],
        ['notes.txt', 'text/plain'],
    ])('%s is %s', (path, type) => {
        expect(mimeTypeFor(path)).toBe(type);
    });

    it.each(['README', 'archive.unknown', '.env', 'dir.js/file', 'trailing.', 'x.toString', 'x.__proto__', 'x.constructor'])(
        '%s falls back to application/octet-stream', (path) => {
            expect(mimeTypeFor(path)).toBe(FALLBACK_TYPE);
        });

    it('an override must be a type/subtype token', () => {
        for (const ok of ['text/plain', 'application/vnd.api+json', 'image/x-icon', 'TEXT/JavaScript']) expect(isValidMimeType(ok)).toBe(true);
        for (const bad of ['', 'text', 'text/', '/plain', 'text/plain; charset=utf-8', 'text/plain ', 'text /plain', 'a/b/c', 'text/pl\u00E4in', 42, null]) {
            expect(isValidMimeType(bad)).toBe(false);
        }
    });
});

// How a store call settled, for asserting refusals by their exact code and shape.
function refusal(action: () => unknown): { code: unknown; keys: string[]; isError: boolean } | 'no refusal' {
    try {
        action();
        return 'no refusal';
    } catch (e: any) {
        return { code: e.code, keys: Object.keys(e), isError: e instanceof Error };
    }
}
const refused = (code: FileErrorCode) => ({ code, keys: ['code'], isError: true });

describe('FileStore', () => {
    it('pins the refusal codes (they are API)', () => {
        const store = new FileStore();
        expect([
            refusal(() => store.register({ '../x.js': '' })),
            refusal(() => store.register({ 'x.js': 42 })),
            refusal(() => store.register({ 'x.bin': new Uint8Array(MAX_TOTAL_BYTES + 1) })),
        ]).toEqual([refused('INVALID_PATH'), refused('INVALID_FILE'), refused('FILES_QUOTA_EXCEEDED')]);
    });

    it('stores strings as UTF-8 and copies Uint8Arrays, so later mutation by the caller changes nothing', () => {
        const store = new FileStore();
        const bytes = new Uint8Array([1, 2, 3]);
        store.register({ 'a.txt': 'é', 'b.bin': bytes, 'c.dat': { content: 'x', type: 'Text/Plain' } });
        bytes[0] = 99;

        expect(store.list()).toEqual([
            { path: 'a.txt', type: 'text/plain', size: 2 },
            { path: 'b.bin', type: FALLBACK_TYPE, size: 3 },
            { path: 'c.dat', type: 'text/plain', size: 1 },
        ]);
        expect(store.snapshot()).toEqual([
            ['a.txt', 'text/plain', btoa('\u00C3\u00A9')],
            ['b.bin', FALLBACK_TYPE, btoa('\u0001\u0002\u0003')],
            ['c.dat', 'text/plain', btoa('x')],
        ]);
    });

    it.each([
        ['chunked btoa fallback', undefined],
        ['Uint8Array.prototype.toBase64', function (this: Uint8Array) { return Buffer.from(this).toString('base64'); }],
    ])('encodes large binary content exactly (%s)', (_label, toBase64) => {
        const original = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toBase64');
        Object.defineProperty(Uint8Array.prototype, 'toBase64', { value: toBase64, configurable: true, writable: true });
        try {
            const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 31) & 0xff);
            const store = new FileStore();
            store.register({ 'x.bin': bytes });
            expect(store.snapshot()[0]![2]).toBe(Buffer.from(bytes).toString('base64'));
        } finally {
            if (original) Object.defineProperty(Uint8Array.prototype, 'toBase64', original);
            else delete (Uint8Array.prototype as any).toBase64;
        }
    });

    it('copies only the bytes of a view, not its whole buffer', () => {
        const store = new FileStore();
        store.register({ 'v.bin': new Uint8Array([9, 1, 2, 9]).subarray(1, 3) });
        expect(store.snapshot()).toEqual([['v.bin', FALLBACK_TYPE, btoa('\u0001\u0002')]]);
    });

    it('validates the whole batch before changing anything: one bad entry leaves the store as it was', () => {
        const store = new FileStore();
        store.register({ 'keep.js': 'old' });
        const before = store.snapshot();

        const batches: [unknown, FileErrorCode][] = [
            [{ 'new.js': 'x', 'keep.js': 'new', '/abs.js': 'x' }, 'INVALID_PATH'],
            [{ 'new.js': 'x', 'keep.js': 'new', 'bad.js': { content: 'x', type: 'not a type' } }, 'INVALID_FILE'],
            [{ 'new.js': 'x', 'keep.js': 'new', 'bad.js': { content: 7, type: 'text/plain' } }, 'INVALID_FILE'],
            [{ 'new.js': 'x', 'keep.js': 'new', 'bad.js': new ArrayBuffer(1) }, 'INVALID_FILE'],
            [{ 'new.js': 'x', 'big.bin': new Uint8Array(MAX_TOTAL_BYTES) }, 'FILES_QUOTA_EXCEEDED'],
            [null, 'INVALID_FILE'],
            [['x.js'], 'INVALID_FILE'],
            ['x.js', 'INVALID_FILE'],
        ];
        for (const [batch, code] of batches) {
            expect(refusal(() => store.register(batch))).toEqual(refused(code));
            expect(store.snapshot()).toEqual(before);
        }
    });

    it('caps the resulting store, not the batch: replacing a file frees its old size', () => {
        const store = new FileStore();
        const half = MAX_TOTAL_BYTES / 2;
        store.register({ 'a.bin': new Uint8Array(half), 'b.bin': new Uint8Array(half) });
        expect(store.list().map(f => f.size)).toEqual([half, half]);

        // at the cap exactly: replacing a.bin with an equally large file is fine
        expect(refusal(() => store.register({ 'a.bin': new Uint8Array(half).fill(1) }))).toBe('no refusal');
        // one byte over the cap, counted against the store the batch would produce
        expect(refusal(() => store.register({ 'c.bin': new Uint8Array(1) }))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        expect(refusal(() => store.register({ 'a.bin': new Uint8Array(half + 1) }))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        // freeing space makes room again
        store.unregister(['b.bin']);
        expect(refusal(() => store.register({ 'c.bin': new Uint8Array(half) }))).toBe('no refusal');
    });

    it('caps the number of files', () => {
        const store = new FileStore();
        const many: Record<string, string> = {};
        for (let i = 0; i < MAX_FILES; i++) many[`f${i}.txt`] = '';
        store.register(many);
        expect(store.list()).toHaveLength(MAX_FILES);
        expect(refusal(() => store.register({ 'one-more.txt': '' }))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        expect(refusal(() => store.register({ 'f0.txt': 'replaced' }))).toBe('no refusal');
    });

    it('reports exactly the paths that changed', () => {
        const store = new FileStore();
        expect(store.register({ 'b.js': '1', 'a.js': '1' })).toEqual(['a.js', 'b.js']);
        expect(store.register({ 'a.js': '1' })).toEqual([]); // identical: nothing changed
        expect(store.register({ 'a.js': { content: '1', type: 'text/plain' } })).toEqual(['a.js']); // type changed
        expect(store.register({ 'b.js': '2', 'c.js': '3' })).toEqual(['b.js', 'c.js']);
        expect(store.register({})).toEqual([]);
    });

    it('unregisters given paths, ignores unknown ones, and with no argument removes everything', () => {
        const store = new FileStore();
        store.register({ 'a.js': '', 'b.js': '', 'c.js': '' });
        expect(store.unregister(['b.js', 'missing.js'])).toEqual(['b.js']);
        expect(store.list().map(f => f.path)).toEqual(['a.js', 'c.js']);
        expect(store.unregister([])).toEqual([]);
        expect(store.unregister()).toEqual(['a.js', 'c.js']);
        expect(store.list()).toEqual([]);
        expect(store.snapshot()).toEqual([]);
    });

    it('refuses an invalid unregister list atomically', () => {
        const store = new FileStore();
        store.register({ 'a.js': '', 'b.js': '' });
        expect(refusal(() => store.unregister(['a.js', '../b.js']))).toEqual(refused('INVALID_PATH'));
        expect(refusal(() => store.unregister('a.js'))).toEqual(refused('INVALID_PATH'));
        expect(refusal(() => store.unregister(null))).toEqual(refused('INVALID_PATH'));
        expect(store.list().map(f => f.path)).toEqual(['a.js', 'b.js']);
    });

    it('lists and snapshots in path order, as fresh copies', () => {
        const store = new FileStore();
        store.register({ 'z.js': '', 'a/b.js': '', 'A.js': '' });
        const list = store.list();
        expect(list.map(f => f.path)).toEqual(['A.js', 'a/b.js', 'z.js']);
        list[0]!.path = 'mutated';
        expect(store.list()[0]!.path).toBe('A.js');
    });
});
