import { describe, it, expect, vi } from 'vitest';
import {
    CheckedFile, FALLBACK_TYPE, FileStore, MAX_FILES, MAX_PATH_LENGTH, MAX_TOTAL_BYTES,
    isJavaScriptType, isStylesheetType, isValidMimeType, isValidPath, mimeTypeFor, referenceCost, rewriteCost, SLOT_URL_BYTES,
    type ByteEdits, type FileErrorCode, type FileSnapshotEntry,
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

    // An explicit budget for fixed work (backlog T6's class): the quota is the test's subject, so it registers files of
    // MAX_TOTAL_BYTES / 2 (4 MiB) five times, each copied and measured. 1.3 s in a full idle run, 2.7 s at load average
    // 14, past 5 s once there. 20 times the idle cost.
    it('caps the resulting store, not the batch: replacing a file frees its old size', { timeout: 30000 }, () => {
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

// What the guest builds from a snapshot entry (inSandboxFiles): the registered bytes, with each byte
// range replaced by its text. Returned as bytes, so offsets are checked as bytes.
function moduleBytes(base64: string, edits: ByteEdits): Uint8Array {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const parts: Uint8Array[] = [];
    let at = 0;
    for (let i = 0; i < edits.length; i += 3) {
        parts.push(bytes.subarray(at, edits[i] as number), new TextEncoder().encode(edits[i + 2] as string));
        at = edits[i + 1] as number;
    }
    parts.push(bytes.subarray(at));
    return Uint8Array.from(parts.flatMap(part => Array.from(part)));
}
const utf8 = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('FileStore: the module rewrite of JavaScript files (PR3)', () => {
    it('isJavaScriptType covers the JavaScript MIME family only', () => {
        for (const type of ['text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript']) expect(isJavaScriptType(type)).toBe(true);
        for (const type of ['text/plain', 'application/json', 'text/css', 'module', '']) expect(isJavaScriptType(type)).toBe(false);
    });

    it('a JavaScript file with relative specifiers carries byte edits; the guest builds exactly the rewritten module from them', () => {
        const store = new FileStore();
        // multi-byte characters before, between and inside specifiers: the offsets are bytes, not UTF-16 units
        const source = "// é 𝄞 ü\nimport { a } from './a.js'; const s = '€';\nexport * from \"../ü/b.js\";\nimport('/c.js');";
        store.register({ 'app/main.js': source });
        const [entry] = store.snapshot();
        expect(entry).toHaveLength(4);
        const [, type, base64, edits] = entry as [string, string, string, ByteEdits];
        expect(type).toBe('text/javascript');
        expect(decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)))).toBe(source); // the bytes as registered
        expect(decode(moduleBytes(base64, edits))).toBe(
            "// é 𝄞 ü\nimport { a } from \"https://vfs.invalid/app/a.js\"; const s = '€';\nexport * from \"https://vfs.invalid/%C3%BC/b.js\";\nimport(\"https://vfs.invalid/c.js\");");
    });

    it('keeps a byte order mark and offsets past it', () => {
        const store = new FileStore();
        const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8("import './a.js';")]);
        store.register({ 'm.js': bytes });
        const [, , base64, edits] = store.snapshot()[0] as [string, string, string, ByteEdits];
        expect(Array.from(moduleBytes(base64, edits))).toEqual([0xef, 0xbb, 0xbf, ...utf8('import "https://vfs.invalid/a.js";')]);
    });

    it.each([
        ['no relative specifiers', 'm.js', "import x from 'lodash'; export const y = 1;"],
        ['a classic script', 'c.js', 'globalThis.x = 1;'],
        ['not JavaScript by extension', 'm.txt', "import './a.js';"],
        ['JavaScript by extension, another type by override', 'm.js', { content: "import './a.js';", type: 'text/plain' }],
    ])('no edits for %s: the entry is [path, type, base64] as before', (_label, path, entry) => {
        const store = new FileStore();
        store.register({ [path]: entry });
        expect(store.snapshot()[0]).toHaveLength(3);
    });

    it('a type override to a JavaScript type is rewritten', () => {
        const store = new FileStore();
        store.register({ 'm.txt': { content: "import './a.js';", type: 'application/javascript' } });
        const [, , base64, edits] = store.snapshot()[0] as [string, string, string, ByteEdits];
        expect(decode(moduleBytes(base64, edits))).toBe('import "https://vfs.invalid/a.js";');
    });

    it.each([
        ['the lexer cannot parse it', "import { a } from './a.js'; import {", 'could not be lexed'],
        ['it is not UTF-8', Uint8Array.from([...utf8("import './a.js'; '"), 0xff, 0x27]), 'not UTF-8'],
    ])('a JavaScript file is delivered unchanged when %s, with one warning per registration of the file', (_label, content, reason) => {
        const warn = vi.fn();
        const store = new FileStore(warn);
        store.register({ 'bad.js': content, 'good.js': "import './a.js';" });
        expect(store.snapshot().map(entry => entry.length)).toEqual([3, 4]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain('"bad.js"');
        expect(String(warn.mock.calls[0]![0])).toContain(reason === 'not UTF-8' ? 'not UTF-8' : reason);
        store.register({ 'bad.js': content }); // identical: nothing changed, no second warning
        expect(warn).toHaveBeenCalledTimes(1);
        store.register({ 'bad.js': typeof content === 'string' ? content + ' ' : Uint8Array.from([...content, 0x20]) });
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it('warns through console.warn by default, and not for a refused batch', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const store = new FileStore();
        expect(refusal(() => store.register({ 'bad.js': 'import {', 'big.bin': new Uint8Array(MAX_TOTAL_BYTES) }))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        expect(warn).not.toHaveBeenCalled();
        store.register({ 'bad.js': 'import {' });
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it('listFiles() reports the registered size; the quota counts the registered bytes plus what the rewrite adds, atomically', () => {
        const store = new FileStore();
        const source = "import './a.js';"; // 16 bytes; the specifier becomes "https://vfs.invalid/a.js"
        store.register({ 'm.js': source });
        expect(store.list()).toEqual([{ path: 'm.js', type: 'text/javascript', size: 16 }]);
        const [, , , edits] = store.snapshot()[0] as [string, string, string, ByteEdits];
        const cost = rewriteCost(edits);
        expect(cost).toBe('"https://vfs.invalid/a.js"'.length + 24);

        // fill the rest of the cap exactly: accepted
        const rest = MAX_TOTAL_BYTES - 16 - cost;
        expect(refusal(() => store.register({ 'fill.bin': new Uint8Array(rest) }))).toBe('no refusal');
        // one more byte of registered content, or one more rewritten specifier, is refused and changes nothing
        const before = store.snapshot();
        expect(refusal(() => store.register({ 'one.bin': new Uint8Array(1) }))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        expect(refusal(() => store.register({ 'n.js': '' }))).toBe('no refusal'); // an empty file costs nothing
        expect(refusal(() => store.register({ 'n.js': 'x' }))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        store.unregister(['n.js']);
        expect(refusal(() => store.register({ 'fill.bin': new Uint8Array(rest - 10), 'two.js': "import'./b'" }))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        expect(store.snapshot()).toEqual(before);
        // unregistering the module frees its whole cost
        store.unregister(['m.js']);
        expect(refusal(() => store.register({ 'one.bin': new Uint8Array(16 + cost) }))).toBe('no refusal');
    });

    it('a file of nothing but imports cannot grow the snapshot past the cap: its rewrite cost is refused', () => {
        const store = new FileStore();
        const statement = "import'./a';"; // 12 bytes, each rewritten to a 23-byte string plus the edit overhead
        const source = statement.repeat(Math.floor(MAX_TOTAL_BYTES / 2 / statement.length));
        expect(utf8(source).length).toBeLessThan(MAX_TOTAL_BYTES);
        expect(refusal(() => store.register({ 'many.js': source }))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        expect(store.list()).toEqual([]);
    });
});

// What the guest delivers for a stylesheet entry (inSandboxFiles): each slot's range replaced by a CSS
// string holding the URL of the file it names, here "blob:<path>"; a slot naming a file not made yet
// (earlier in `made`) keeps its registered bytes. Returned as text.
function stylesheetText(entry: FileSnapshotEntry, made: ReadonlySet<string>): string {
    const bytes = Uint8Array.from(atob(entry[2]), c => c.charCodeAt(0));
    const edits = entry[3] ?? [];
    const parts: number[] = [];
    let at = 0;
    for (let i = 0; i < edits.length; i += 3) {
        const slot = edits[i + 2] as [string];
        if (!made.has(slot[0])) continue;
        parts.push(...bytes.subarray(at, edits[i] as number), ...utf8(JSON.stringify('blob:' + slot[0])));
        at = edits[i + 1] as number;
    }
    parts.push(...bytes.subarray(at));
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(Uint8Array.from(parts));
}
const everything = (store: FileStore) => new Set(store.list().map(f => f.path));
const entryOf = (store: FileStore, path: string) => store.snapshot().find(entry => entry[0] === path)!;

describe('FileStore: stylesheet references (PR4)', () => {
    it('isStylesheetType is text/css only', () => {
        expect(isStylesheetType('text/css')).toBe(true);
        for (const type of ['text/plain', 'text/javascript', 'text/css2', 'application/css', '']) expect(isStylesheetType(type)).toBe(false);
    });

    it("a stylesheet's url() and @import references to registered files become slots, resolved against the stylesheet's own path; the guest delivers exactly the rewritten sheet", () => {
        const store = new FileStore();
        const css = [
            '@import "base.css";',
            '@import url(../shared/reset.css) print;',
            '@font-face { font-family: F; src: url("/fonts/f.woff2") format("woff2"), local("F"); }',
            'a { background: url( ./img/bg.svg ) , image-set("img/bg.svg" 1x, url(../../../img/x.svg) 2x); }',
            '/* url(img/bg.svg) */ b::after { content: "img/bg.svg"; }',
        ].join('\n');
        store.register({
            'css/site.css': css, 'css/base.css': '', 'shared/reset.css': '', 'fonts/f.woff2': new Uint8Array(4),
            'css/img/bg.svg': '<svg/>', 'img/x.svg': '<svg/>',
        });
        const entry = entryOf(store, 'css/site.css');
        expect(entry).toHaveLength(4);
        expect((entry[3] as ByteEdits).filter((_, i) => i % 3 === 2)).toEqual([
            ['css/base.css'], ['shared/reset.css'], ['fonts/f.woff2'], ['css/img/bg.svg'], ['css/img/bg.svg'], ['img/x.svg'],
        ]);
        expect(stylesheetText(entry, everything(store))).toBe([
            '@import "blob:css/base.css";',
            '@import url("blob:shared/reset.css") print;',
            '@font-face { font-family: F; src: url("blob:fonts/f.woff2") format("woff2"), local("F"); }',
            'a { background: url("blob:css/img/bg.svg") , image-set("blob:css/img/bg.svg" 1x, url("blob:img/x.svg") 2x); }',
            '/* url(img/bg.svg) */ b::after { content: "img/bg.svg"; }',
        ].join('\n'));
        // the bytes as registered stay what read() returns
        expect(decode(Uint8Array.from(atob(entry[2]), c => c.charCodeAt(0)))).toBe(css);
    });

    it('byte offsets with multi-byte text before, between and inside references', () => {
        const store = new FileStore();
        const css = '/* é 𝄞 */ a { content: "€"; b: url(i.svg); c: url("€.svg") } /* ü */ d { e: url(\'dir/j.svg\') } f { g: url(ü.svg) }';
        store.register({ 's.css': css, 'i.svg': '', 'dir/j.svg': '' });
        // a non-ASCII reference names no file: paths are ASCII (and "€" percent-encodes)
        expect(stylesheetText(entryOf(store, 's.css'), everything(store))).toBe(
            '/* é 𝄞 */ a { content: "€"; b: url("blob:i.svg"); c: url("€.svg") } /* ü */ d { e: url("blob:dir/j.svg") } f { g: url(ü.svg) }');
    });

    it('a non-ASCII path is never a file, so a non-ASCII reference can never name one', () => {
        const store = new FileStore();
        for (const path of ['ü/i.svg', '€.svg']) expect(refusal(() => store.register({ [path]: '' }))).toEqual(refused('INVALID_PATH'));
    });

    it.each([
        ['an unregistered file', 'url(missing.svg)'],
        ['a query', 'url(i.svg?v=1)'],
        ['an empty query', 'url("i.svg?")'],
        ['a fragment', 'url(i.svg#x)'],
        ['a fragment only', 'url(#x)'],
        ['another case', 'url(I.SVG)'],
        ['another percent-encoding', 'url(%69.svg)'],
        ['a data: URL', 'url(data:image/svg+xml,<svg/>)'],
        ['another origin', 'url(https://cdn.example/i.svg)'],
        ['a scheme-relative URL', 'url(//cdn.example/i.svg)'],
        ['the virtual origin with a port', 'url(https://vfs.invalid:8443/i.svg)'],
        ['an empty url', 'url()'],
        ['a blank string', 'url("  ")'],
        ['a bad url', 'url(i .svg)'],
        ['a string that is not a URL', '; content: "i.svg"'],
        ['a comment', '/* url(i.svg) */'],
    ])('names no file, so no slot: %s', (_label, value) => {
        const store = new FileStore();
        store.register({ 's.css': `a { b: ${value} }`, 'i.svg': '' });
        expect(entryOf(store, 's.css')).toHaveLength(3);
    });

    it('the virtual origin spelled out and ".." above the root name the file, as on any server', () => {
        const store = new FileStore();
        store.register({ 'a/s.css': 'a { b: url(https://vfs.invalid/i.svg); c: url(../../../../i.svg); d: url(%2e%2e/i.svg) }', 'i.svg': '' });
        expect(stylesheetText(entryOf(store, 'a/s.css'), everything(store))).toBe('a { b: url("blob:i.svg"); c: url("blob:i.svg"); d: url("blob:i.svg") }');
    });

    it('whether a reference becomes a slot is decided per snapshot: registering or removing its target changes the next snapshot, not the stylesheet', () => {
        const store = new FileStore();
        store.register({ 's.css': 'a { b: url(later.svg) }' });
        expect(entryOf(store, 's.css')).toHaveLength(3);
        const cost = store.list(); // unchanged by the target
        store.register({ 'later.svg': '<svg/>' });
        expect(stylesheetText(entryOf(store, 's.css'), everything(store))).toBe('a { b: url("blob:later.svg") }');
        store.unregister(['later.svg']);
        expect(entryOf(store, 's.css')).toHaveLength(3);
        expect(store.list()).toEqual(cost);
    });

    it('a type override decides: a .txt registered as text/css is rewritten, a .css registered as text/plain is not', () => {
        const store = new FileStore();
        store.register({ 's.txt': { content: 'a { b: url(i.svg) }', type: 'text/css' }, 'p.css': { content: 'a { b: url(i.svg) }', type: 'text/plain' }, 'i.svg': '' });
        expect(entryOf(store, 's.txt')).toHaveLength(4);
        expect(entryOf(store, 'p.css')).toHaveLength(3);
    });

    it('JavaScript and other files are never searched for CSS references', () => {
        const store = new FileStore();
        store.register({ 'a.js': 'const s = "url(i.svg)";', 'b.html': '<style>a{b:url(i.svg)}</style>', 'i.svg': '' });
        expect(store.snapshot().map(entry => entry.length)).toEqual([3, 3, 3]);
    });

    it('a stylesheet that is not UTF-8 is delivered unchanged, with one warning per registration of the file', () => {
        const warn = vi.fn();
        const store = new FileStore(warn);
        const bad = Uint8Array.from([...utf8('a { b: url(i.svg) } /* '), 0xff, ...utf8(' */')]);
        store.register({ 'bad.css': bad, 'good.css': 'a { b: url(i.svg) }', 'i.svg': '' });
        expect(entryOf(store, 'bad.css')).toHaveLength(3);
        expect(entryOf(store, 'good.css')).toHaveLength(4);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain('"bad.css" is registered as CSS but is not UTF-8');
        store.register({ 'bad.css': bad });
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('a byte order mark is kept, and offsets count it', () => {
        const store = new FileStore();
        store.register({ 's.css': Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('@import "b.css";')]), 'b.css': '' });
        const entry = entryOf(store, 's.css');
        expect(entry[3]).toEqual([11, 18, ['b.css']]);
        expect(Array.from(utf8(stylesheetText(entry, everything(store))))).toEqual([0xef, 0xbb, 0xbf, ...utf8('@import "blob:b.css";')]);
    });
});

describe('FileStore.snapshot: delivery order and reference cycles (PR4)', () => {
    const order = (store: FileStore) => store.snapshot().map(entry => entry[0]);
    const slotsOf = (store: FileStore, path: string) => ((entryOf(store, path)[3] ?? []) as ByteEdits).filter((_, i) => i % 3 === 2).map(slot => (slot as [string])[0]);

    // every slot names a file that comes earlier in the literal: what the guest's single pass needs
    const assertDependencyOrder = (store: FileStore) => {
        const seen = new Set<string>();
        for (const entry of store.snapshot()) {
            for (let i = 2; i < (entry[3] ?? []).length; i += 3) {
                const slot = entry[3]![i];
                if (Array.isArray(slot)) expect(seen.has(slot[0])).toBe(true);
            }
            seen.add(entry[0]);
        }
        expect(seen.size).toBe(store.list().length);
    };

    it('without references between files, the order is the path order, as before', () => {
        const store = new FileStore();
        store.register({ 'z.css': 'a{}', 'b.js': "import './z.js';", 'a.svg': '', 'm.css': 'a { b: url(nothing.svg) }' });
        expect(order(store)).toEqual(['a.svg', 'b.js', 'm.css', 'z.css']);
    });

    it('files without slots first, in path order; then each stylesheet after every file it names', () => {
        const store = new FileStore();
        store.register({
            'a.css': '@import "b.css"; x { y: url(z.svg) }',
            'b.css': '@import "c/c.css";',
            'c/c.css': 'x { y: url(../z.svg) }',
            'd.css': '@import "a.css"; @import "c/c.css";',
            'z.svg': '',
            'plain.css': 'x { y: red }',
        });
        expect(order(store)).toEqual(['plain.css', 'z.svg', 'c/c.css', 'b.css', 'a.css', 'd.css']);
        assertDependencyOrder(store);
        expect(slotsOf(store, 'd.css')).toEqual(['a.css', 'c/c.css']);
    });

    it('an @import cycle: every reference on it stays as registered, the others resolve, and one warning names its files', () => {
        const warn = vi.fn();
        const store = new FileStore(warn);
        store.register({
            'a.css': '@import "b.css"; @import "leaf.css"; x { y: url(i.svg) }',
            'b.css': '@import "a.css";',
            'leaf.css': '',
            'i.svg': '',
            'outside.css': '@import "a.css"; @import "b.css";', // into the cycle from outside: resolves
        });
        expect(slotsOf(store, 'a.css')).toEqual(['leaf.css', 'i.svg']);
        expect(slotsOf(store, 'b.css')).toEqual([]);
        expect(slotsOf(store, 'outside.css')).toEqual(['a.css', 'b.css']);
        expect(stylesheetText(entryOf(store, 'a.css'), everything(store))).toBe('@import "b.css"; @import "blob:leaf.css"; x { y: url("blob:i.svg") }');
        assertDependencyOrder(store);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain('the stylesheets "a.css", "b.css" reference each other in a cycle');
        // the same cycle in every later build: no second warning
        store.snapshot();
        store.snapshot();
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('a stylesheet that names itself is a cycle of one: that reference stays, with one warning', () => {
        const warn = vi.fn();
        const store = new FileStore(warn);
        store.register({ 's.css': '@import "s.css"; x { y: url(./s.css) } z { w: url(i.svg) }', 'i.svg': '' });
        expect(slotsOf(store, 's.css')).toEqual(['i.svg']);
        // the @import is the cycle; url(./s.css) names a stylesheet where an image is loaded (focused review W1):
        // it stays for that reason, with its own warning, and is no edge of the cycle
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('cycle'))).toEqual([expect.stringContaining('"s.css"')]);
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('as an image'))).toHaveLength(1);
    });

    it('longer cycles and two cycles joined by a reference: only the references on a cycle stay; one warning per cycle', () => {
        const warn = vi.fn();
        const store = new FileStore(warn);
        store.register({
            'p.css': '@import "q.css";', 'q.css': '@import "r.css";', 'r.css': '@import "p.css"; @import "s.css";', // p → q → r → p
            's.css': '@import "t.css";', 't.css': '@import "s.css"; @import "u.css";', // s ↔ t, entered from r
            'u.css': 'x { y: red }',
        });
        expect([slotsOf(store, 'p.css'), slotsOf(store, 'q.css'), slotsOf(store, 'r.css'), slotsOf(store, 's.css'), slotsOf(store, 't.css')])
            .toEqual([[], [], ['s.css'], [], ['u.css']]);
        assertDependencyOrder(store);
        expect(warn.mock.calls.map(call => String(call[0]).match(/stylesheets (.*?) reference each other/)![1])).toEqual(['"p.css", "q.css", "r.css"', '"s.css", "t.css"']);
    });

    it('a cycle that a registration closes or opens changes the next snapshot only', () => {
        const store = new FileStore(() => {});
        store.register({ 'a.css': '@import "b.css";', 'b.css': 'x { y: red }' });
        expect(slotsOf(store, 'a.css')).toEqual(['b.css']);
        store.register({ 'b.css': '@import "a.css";' });
        expect(slotsOf(store, 'a.css')).toEqual([]);
        expect(slotsOf(store, 'b.css')).toEqual([]);
        store.unregister(['b.css']);
        expect(entryOf(store, 'a.css')).toHaveLength(3);
    });

    it('a large graph: 999 stylesheets in a chain and one cycle back to the start, in any registration order', () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 999; i++) files[`s${String(i).padStart(3, '0')}.css`] = i === 998 ? '@import "s000.css";' : `@import "s${String(i + 1).padStart(3, '0')}.css";`;
        const store = new FileStore(() => {});
        store.register(files);
        // everything is on one cycle: every reference stays, nothing to order
        expect(store.snapshot().every(entry => entry.length === 3)).toBe(true);
        // break the cycle: a chain, delivered from its end
        store.register({ 's998.css': 'x { y: red }' });
        expect(order(store)[0]).toBe('s998.css');
        expect(order(store).at(-1)).toBe('s000.css');
        assertDependencyOrder(store);
    });
});

describe('FileStore: the quota counts what stylesheet references add (PR4)', () => {
    // An explicit budget for fixed work (backlog T6's class): it fills the store to MAX_TOTAL_BYTES (8 MiB) twice. 1.5 s in
    // a full idle run, 2.4 s at load average 14. 20 times the idle cost.
    it('each reference that could name a file costs its path, the edit overhead and the blob: URL that replaces it, at registration, whether or not its target is registered', { timeout: 30000 }, () => {
        const store = new FileStore();
        const css = 'a { b: url(i.svg); c: url(missing/x.svg); d: url(https://cdn.example/x.svg); e: url(i.svg?v=1) }';
        store.register({ 's.css': css });
        const size = utf8(css).length;
        expect(store.list()).toEqual([{ path: 's.css', type: 'text/css', size }]);
        const cost = ('i.svg'.length + 24 + SLOT_URL_BYTES) + ('missing/x.svg'.length + 24 + SLOT_URL_BYTES);
        expect(referenceCost([[0, 0, 'i.svg', 'image'], [0, 0, 'missing/x.svg', 'image']])).toBe(cost);
        expect(SLOT_URL_BYTES).toBe('"blob:null/00000000-0000-0000-0000-000000000000"'.length);

        // fill the rest of the cap exactly: accepted; one byte more is refused and changes nothing
        expect(refusal(() => store.register({ 'fill.bin': new Uint8Array(MAX_TOTAL_BYTES - size - cost) }))).toBe('no refusal');
        const before = store.snapshot();
        expect(refusal(() => store.register({ 'one.bin': new Uint8Array(1) }))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        // a stylesheet that grows by one reference is refused whole
        expect(refusal(() => store.register({ 's.css': css.replace('}', '; f: url(z.svg) }') }))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        expect(store.snapshot()).toEqual(before);
        // registering the target costs only its own bytes: the reference was counted already
        store.unregister(['fill.bin']);
        expect(refusal(() => store.register({ 'i.svg': '<svg/>' }))).toBe('no refusal');
        // unregistering the stylesheet frees its whole cost
        store.unregister(['s.css', 'i.svg']);
        expect(refusal(() => store.register({ 'max.bin': new Uint8Array(MAX_TOTAL_BYTES) }))).toBe('no refusal');
    });

    it('a stylesheet of nothing but references cannot grow the snapshot or the guest past the cap', () => {
        const store = new FileStore();
        const rule = 'a{b:url(a)}'; // 11 bytes, each reference costs 1 + 24 + 48
        const css = rule.repeat(Math.floor(MAX_TOTAL_BYTES / 4 / rule.length));
        expect(refusal(() => store.register({ 'many.css': css }))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        expect(store.list()).toEqual([]);
    });
});

describe('FileStore.apply(): the one mutation (backlog C5: register, unregister and the guest-write commit are wrappers over it)', () => {
    const snapshotOf = (store: FileStore) => ({ list: store.list(), snapshot: store.snapshot(), total: (store as any)._totalBytes });

    it('puts and removes in one atomic change, returning every changed path sorted', () => {
        const store = new FileStore(() => {});
        store.register({ 'a.txt': 'a', 'b.txt': 'b' });
        expect(store.apply({ put: new Map([['c.txt', 'c'], ['a.txt', 'A']]), remove: ['b.txt', 'missing.txt'] }, 'test()')).toEqual(['a.txt', 'b.txt', 'c.txt']);
        expect(store.list().map(f => [f.path, f.size])).toEqual([['a.txt', 1], ['c.txt', 1]]);
        // identical content changes nothing; removing what is not there changes nothing
        expect(store.apply({ put: new Map([['a.txt', 'A']]), remove: ['b.txt'] }, 'test()')).toEqual([]);
    });

    it.each([
        ['a bad path in put', { put: new Map([['ok.txt', 'x'], ['../x', 'x']]) }, 'INVALID_PATH'],
        ['a bad path in remove', { put: new Map([['ok.txt', 'x']]), remove: ['a.txt', '/x'] }, 'INVALID_PATH'],
        ['a path both written and removed', { put: new Map([['a.txt', 'x']]), remove: ['a.txt'] }, 'INVALID_PATH'],
        ['a bad entry', { put: new Map<string, unknown>([['ok.txt', 'x'], ['bad.txt', 7]]), remove: ['a.txt'] }, 'INVALID_FILE'],
        ['past the count', { put: new Map(Array.from({ length: MAX_FILES }, (_, i) => [`n/${i}.txt`, ''])), remove: [] }, 'FILES_QUOTA_EXCEEDED'],
        ['past the bytes', { put: new Map([['big.bin', new Uint8Array(MAX_TOTAL_BYTES)]]), remove: ['missing.txt'] }, 'FILES_QUOTA_EXCEEDED'],
        ['past the bytes by a rewrite', { put: new Map<string, unknown>([['fill.bin', new Uint8Array(MAX_TOTAL_BYTES - 40)], ['m.js', "import './x.js';"]]), remove: ['a.txt', 'b.txt'] }, 'FILES_QUOTA_EXCEEDED'],
    ] as const)('refused whole for %s: nothing changes, removals included', (_label, changes, code) => {
        const store = new FileStore(() => {});
        store.register({ 'a.txt': 'a', 'b.txt': 'b' });
        const before = snapshotOf(store);
        expect(refusal(() => store.apply(changes as any, 'test()'))).toEqual(refused(code as FileErrorCode));
        expect(snapshotOf(store)).toEqual(before);
    });

    it('a removal frees its whole cost (rewrite included) within the same change', () => {
        const store = new FileStore(() => {});
        const source = Array.from({ length: 20 }, (_, i) => `import './m${i}.js';`).join('\n');
        store.register({ 'app.js': source });
        const free = MAX_TOTAL_BYTES - (store as any)._totalBytes;
        expect(refusal(() => store.apply({ put: new Map([['fill.bin', new Uint8Array(free + 1)]]) }, 'test()'))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        expect(store.apply({ put: new Map([['fill.bin', new Uint8Array(MAX_TOTAL_BYTES)]]), remove: ['app.js'] }, 'test()')).toEqual(['app.js', 'fill.bin']);
        expect((store as any)._totalBytes).toBe(MAX_TOTAL_BYTES);
    });

    it('check() changes nothing and lexes nothing: no warning for a module the lexer cannot parse, which apply() warns about', () => {
        const warn = vi.fn();
        const store = new FileStore(warn);
        store.register({ 'fill.bin': new Uint8Array(100) });
        const before = snapshotOf(store);
        expect(store.check({ put: new Map([['bad.js', 'import {']]), remove: ['fill.bin'] }, 'test()')).toBeUndefined();
        expect(snapshotOf(store)).toEqual(before);
        expect(warn).not.toHaveBeenCalled();
        store.apply({ put: new Map([['bad.js', 'import {']]) }, 'test()');
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('check() refuses past the registered bytes and the count; it does not count rewrites (the commit does)', () => {
        const store = new FileStore(() => {});
        store.register({ 'fill.bin': new Uint8Array(MAX_TOTAL_BYTES - 20) });
        expect(store.check({ put: new Map([['m.js', "import'./a.js'"]]) }, 'test()')).toBeUndefined(); // 14 bytes: fits by bytes
        expect(refusal(() => store.apply({ put: new Map([['m.js', "import'./a.js'"]]) }, 'test()'))).toEqual(refused('FILES_QUOTA_EXCEEDED')); // not with its rewrite
        expect(refusal(() => store.check({ put: new Map([['x.bin', new Uint8Array(21)]]) }, 'test()'))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        expect(refusal(() => store.check({ put: new Map([['../x', '']]) }, 'test()'))).toEqual(refused('INVALID_PATH'));
        expect(refusal(() => store.check({ put: new Map(Array.from({ length: MAX_FILES }, (_, i) => [`n/${i}`, ''])) }, 'test()'))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        expect(store.list().map(f => f.path)).toEqual(['fill.bin']);
    });

    it('a CheckedFile is taken as checked (no second copy), its type kept; CheckedFile.from() refuses exactly what register() refuses', () => {
        const store = new FileStore(() => {});
        const file = CheckedFile.from('img.png', { content: 'x', type: 'Text/Plain' }, 'test()');
        expect([file.type, Array.from(file.bytes)]).toEqual(['text/plain', [120]]);
        expect(store.apply({ put: new Map([['img.png', file]]) }, 'test()')).toEqual(['img.png']);
        expect(store.list()).toEqual([{ path: 'img.png', type: 'text/plain', size: 1 }]);
        // a CheckedFile under an invalid key is still refused by the key
        expect(refusal(() => store.apply({ put: new Map([['../x', file]]) }, 'test()'))).toEqual(refused('INVALID_PATH'));
        for (const [path, entry] of [['../x', ''], ['x.txt', 7], ['x.txt', { content: '', type: 'bad' }]] as const) {
            expect(refusal(() => CheckedFile.from(path, entry, 'test()'))).toEqual(refusal(() => new FileStore().register({ [path]: entry })));
        }
    });

    it('refusal messages name the caller', () => {
        const store = new FileStore(() => {});
        try { store.apply({ put: new Map([['../x', '']]) }, 'commitGuestWrites()'); } catch (e: any) { expect(e.message).toContain('commitGuestWrites() refused'); }
        try { store.register({ '../x': '' }); } catch (e: any) { expect(e.message).toContain('registerFiles() refused'); }
        try { store.unregister(['../x']); } catch (e: any) { expect(e.message).toContain('unregisterFiles() refused'); }
    });
});
