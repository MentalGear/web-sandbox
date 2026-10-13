import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { inSandboxFiles, inSandboxImportMap, inSandboxMarkup } from './in-sandbox-files';
import type { SandboxFiles } from './files';

// The guest receives the function as source text: run that text, not the module import, so a
// reference to anything outside the function would fail here as it would in the guest.
const install = (entries: unknown) => new Function(`(${inSandboxFiles.toString()})(${JSON.stringify(entries)});`)();
const files = () => (globalThis as any).sandboxFiles as SandboxFiles;

const NOT_FOUND = { isError: true, code: 'NOT_FOUND', keys: ['code'], message: '[sandboxFiles] NOT_FOUND: no such file' };
// jsdom's Blob has no text()/arrayBuffer(), so the blobs handed to the blob store are read with FileReader.
const bytesOf = (blob: Blob) => new Promise<number[]>(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(Array.from(new Uint8Array(reader.result as ArrayBuffer)));
    reader.readAsArrayBuffer(blob);
});

const shape = (e: any) => ({ isError: e instanceof Error, code: e?.code, keys: Object.keys(e), message: e?.message });

describe('inSandboxFiles (the guest bootstrap, run from its source text)', () => {
    let minted = 0;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalFromBase64 = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64');
    beforeEach(() => {
        // jsdom has no blob store
        URL.createObjectURL = vi.fn(() => `blob:null/fake-${++minted}`);
    });
    afterEach(() => {
        URL.createObjectURL = originalCreateObjectURL;
        delete (globalThis as any).sandboxFiles;
        if (originalFromBase64) Object.defineProperty(Uint8Array, 'fromBase64', originalFromBase64);
        else delete (Uint8Array as any).fromBase64;
    });

    const ENTRIES = [
        ['a.txt', 'text/plain', btoa(String.fromCharCode(...new TextEncoder().encode('héllo')))],
        ['bin/all.bin', 'application/octet-stream', btoa(String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i)))],
    ];

    it.each([
        ['atob fallback', false],
        ['Uint8Array.fromBase64', true],
    ])('decodes every entry into a typed blob with its own URL (%s)', async (_label, native) => {
        const fromBase64 = vi.fn((b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
        (Uint8Array as any).fromBase64 = native ? fromBase64 : undefined;
        install(ENTRIES);

        expect(fromBase64).toHaveBeenCalledTimes(native ? 2 : 0);
        expect(files().list()).toEqual(['a.txt', 'bin/all.bin']);
        expect(files().url('a.txt')).toBe(`blob:null/fake-${minted - 1}`);
        expect(files().url('bin/all.bin')).toBe(`blob:null/fake-${minted}`);
        const [text, binary] = (URL.createObjectURL as any).mock.calls.map((call: [Blob]) => call[0]) as Blob[];
        expect([text!.type, binary!.type]).toEqual(['text/plain', 'application/octet-stream']);
        expect(await bytesOf(text!)).toEqual(Array.from(new TextEncoder().encode('héllo')));
        expect(await bytesOf(binary!)).toEqual(Array.from({ length: 256 }, (_, i) => i));
    });

    it('a rewritten module: url() names the module form built from slices and replacement texts; read() and text() keep the bytes as registered', async () => {
        const source = "é import './a.js'; import('./b.js');";
        const bytes = new TextEncoder().encode(source);
        const at = (text: string) => new TextEncoder().encode(source.slice(0, source.indexOf(text))).length;
        const edits = [at("'./a.js'"), at("'./a.js'") + 8, '"https://vfs.invalid/a.js"', at("'./b.js'"), at("'./b.js'") + 8, '"https://vfs.invalid/b.js"'];
        install([['m.js', 'text/javascript', btoa(String.fromCharCode(...bytes)), edits]]);

        const blobs = (URL.createObjectURL as any).mock.calls.map((call: [Blob]) => call[0]) as Blob[];
        expect(blobs).toHaveLength(1); // one URL per file: the module form's
        expect(blobs[0]!.type).toBe('text/javascript');
        expect(new TextDecoder().decode(new Uint8Array(await bytesOf(blobs[0]!)))).toBe('é import "https://vfs.invalid/a.js"; import("https://vfs.invalid/b.js");');
        expect(files().url('m.js')).toBe(`blob:null/fake-${minted}`);
        // jsdom's Blob has no arrayBuffer(): give it one (through FileReader) for this read() only
        const original = Blob.prototype.arrayBuffer;
        Blob.prototype.arrayBuffer = function (this: Blob) { return bytesOf(this).then(b => new Uint8Array(b).buffer); };
        const registered = new TextDecoder().decode(await files().read('m.js').finally(() => { Blob.prototype.arrayBuffer = original; }));
        expect(registered).toBe(source);
    });

    it('every failed lookup is the same NOT_FOUND Error, thrown by url() and rejected by read() and text() (successful reads: files.spec.ts)', async () => {
        install(ENTRIES);
        for (const path of ['missing', 'A.txt', './a.txt', '/a.txt', 'bin//all.bin', '__proto__', 'toString', '', null, 7, { toString: () => 'a.txt' }]) {
            let thrown: unknown;
            try { files().url(path as string); } catch (e) { thrown = e; }
            expect(shape(thrown)).toEqual(NOT_FOUND);
            await expect(files().read(path as string).catch(shape)).resolves.toEqual(NOT_FOUND);
            await expect(files().text(path as string).catch(shape)).resolves.toEqual(NOT_FOUND);
        }
    });

    it('list() returns a fresh array, and the API object is frozen', () => {
        install(ENTRIES);
        files().list().push('injected');
        expect(files().list()).toEqual(['a.txt', 'bin/all.bin']);
        expect(Object.isFrozen(files())).toBe(true);
    });

    it('an empty snapshot (no files registered) installs the same API: list() is empty and every lookup is NOT_FOUND', async () => {
        install([]);
        expect(files().list()).toEqual([]);
        let thrown: unknown;
        try { files().url('a.txt'); } catch (e) { thrown = e; }
        expect(shape(thrown)).toEqual(NOT_FOUND);
        await expect(files().read('a.txt').catch(shape)).resolves.toEqual(NOT_FOUND);
        await expect(files().text('a.txt').catch(shape)).resolves.toEqual(NOT_FOUND);
    });
});

describe('inSandboxMarkup (the bootstrap\'s last statement, run from its source text)', () => {
    let written: string[];
    const originalWrite = document.write;
    beforeEach(() => {
        written = [];
        document.write = vi.fn((...text: string[]) => { written.push(text.join('')); });
    });
    afterEach(() => {
        document.write = originalWrite;
    });

    // The bootstrap composes the two calls exactly so: the markup step gets the object inSandboxFiles returned.
    const run = (filesSource: string, parts: unknown) => new Function(`(${inSandboxMarkup.toString()})(${filesSource}, ${JSON.stringify(parts)});`)();

    it('inSandboxFiles returns the object it publishes as sandboxFiles', () => {
        const returned = new Function(`return (${inSandboxFiles.toString()})([]);`)();
        expect(returned).toBe((globalThis as any).sandboxFiles);
        delete (globalThis as any).sandboxFiles;
    });

    it('writes the parts once, each path replaced by its URL from the given files object, never from the global', () => {
        (globalThis as any).sandboxFiles = { url: () => 'blob:null/FROM-THE-GLOBAL' };
        (globalThis as any).__files = { url: (path: string) => `blob:null/${path.length}` };
        run('globalThis.__files', ['<img src="', 'logo.svg', '"><script src="', 'a.js', '"></script>']);
        expect(document.write).toHaveBeenCalledTimes(1);
        expect(written).toEqual(['<img src="blob:null/8"><script src="blob:null/4"></script>']);
        delete (globalThis as any).sandboxFiles;
        delete (globalThis as any).__files;
    });

    it('escapes the URL for the double-quoted attribute it lands in', () => {
        (globalThis as any).__files = { url: () => 'x" onerror="alert(1)&amp;' };
        run('globalThis.__files', ['<img src="', 'p', '">']);
        expect(written).toEqual(['<img src="x&quot; onerror=&quot;alert(1)&amp;amp;">']);
        delete (globalThis as any).__files;
    });

    it('writes markup without slots unchanged', () => {
        run('{ url() { throw new Error("not called") } }', ['<p>only markup</p>']);
        expect(written).toEqual(['<p>only markup</p>']);
    });
});

describe('inSandboxImportMap (the one import map, run from its source text)', () => {
    let inserted: { type: string; text: string }[];
    const originalAppend = Element.prototype.appendChild;
    beforeEach(() => {
        inserted = [];
        // record each script as it is inserted; jsdom does not implement import maps
        Element.prototype.appendChild = function <T extends Node>(this: Element, node: T): T {
            const result = originalAppend.call(this, node) as T;
            if (node instanceof HTMLScriptElement) inserted.push({ type: node.type, text: node.textContent ?? '' });
            return result;
        };
    });
    afterEach(() => {
        Element.prototype.appendChild = originalAppend;
        delete (globalThis as any).__files;
    });

    const run = (paths: unknown, guest: unknown) => new Function(`return (${inSandboxImportMap.toString()})(globalThis.__files, ${JSON.stringify(paths)}, ${JSON.stringify(guest)});`)();

    it('maps every JavaScript file\'s virtual URL to the URL of the given files object, registers it as one importmap script, removes the element, and returns the files object', () => {
        (globalThis as any).__files = { url: (path: string) => `blob:null/${path.length}` };
        const returned = run(['app/main.js', 'b.js'], null);
        expect(returned).toBe((globalThis as any).__files);
        expect(inserted).toHaveLength(1);
        expect(inserted[0]!.type).toBe('importmap');
        expect(JSON.parse(inserted[0]!.text)).toEqual({ imports: { 'https://vfs.invalid/app/main.js': 'blob:null/11', 'https://vfs.invalid/b.js': 'blob:null/4' } });
        expect(document.querySelectorAll('script[type=importmap]')).toHaveLength(0);
    });

    it("merges the guest's map: its entries stay, ours are written last and win on the same key", () => {
        (globalThis as any).__files = { url: () => 'blob:null/ours' };
        const guest = JSON.stringify({ imports: { lodash: 'https://cdn.example/l.js', 'https://vfs.invalid/a.js': 'https://attacker.test/x.js' }, scopes: { 'https://cdn.example/': { d: 'https://cdn.example/d.js' } } });
        run(['a.js'], guest);
        expect(JSON.parse(inserted[0]!.text)).toEqual({
            imports: { lodash: 'https://cdn.example/l.js', 'https://vfs.invalid/a.js': 'blob:null/ours' },
            scopes: { 'https://cdn.example/': { d: 'https://cdn.example/d.js' } },
        });
    });

    it('escapes every "<" in the JSON, whatever the guest map or a URL contains; the JSON still parses to the same map', () => {
        (globalThis as any).__files = { url: () => 'blob:null/</script><!--' };
        const guest = JSON.stringify({ imports: { '</script><script>alert(1)</script>': '<!--<script>' } });
        run(['a.js'], guest);
        const text = inserted[0]!.text;
        expect(text).not.toContain('<');
        expect(JSON.parse(text)).toEqual({ imports: { '</script><script>alert(1)</script>': '<!--<script>', 'https://vfs.invalid/a.js': 'blob:null/</script><!--' } });
    });

    it('a guest "__proto__" key stays an ordinary entry', () => {
        (globalThis as any).__files = { url: () => 'blob:null/x' };
        run(['a.js'], '{"imports":{"__proto__":"https://cdn.example/p.js"}}');
        expect(Object.keys(JSON.parse(inserted[0]!.text).imports)).toEqual(['__proto__', 'https://vfs.invalid/a.js']);
    });
});
