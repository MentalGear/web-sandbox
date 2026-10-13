import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { inSandboxFiles, inSandboxMarkup } from './in-sandbox-files';
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
