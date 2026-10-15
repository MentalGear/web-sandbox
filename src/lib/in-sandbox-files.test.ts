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
        // jsdom's Blob has no arrayBuffer(): give it one (through FileReader) for this read() only, before the store
        // captures it (review round 2, C-1: sandboxFiles uses what it took before any guest code ran)
        const original = Blob.prototype.arrayBuffer;
        Blob.prototype.arrayBuffer = function (this: Blob) { return bytesOf(this).then(b => new Uint8Array(b).buffer); };
        try {
            install([['m.js', 'text/javascript', btoa(String.fromCharCode(...bytes)), edits]]);
        } finally {
            Blob.prototype.arrayBuffer = original;
        }

        const blobs = (URL.createObjectURL as any).mock.calls.map((call: [Blob]) => call[0]) as Blob[];
        expect(blobs).toHaveLength(1); // one URL per file: the module form's
        expect(blobs[0]!.type).toBe('text/javascript');
        expect(new TextDecoder().decode(new Uint8Array(await bytesOf(blobs[0]!)))).toBe('é import "https://vfs.invalid/a.js"; import("https://vfs.invalid/b.js");');
        expect(files().url('m.js')).toBe(`blob:null/fake-${minted}`);
        const registered = new TextDecoder().decode(await files().read('m.js'));
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

    // A stylesheet entry as the host builds it (files.ts): byte ranges of the registered text, each with a slot.
    const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    const sheetEntry = (path: string, css: string, slots: [string, string][]) => {
        const at = (text: string) => new TextEncoder().encode(css.slice(0, css.indexOf(text))).length;
        const edits = slots.flatMap(([text, target]) => [at(text), at(text) + new TextEncoder().encode(text).length, [target]]);
        return [path, 'text/css', b64(css), edits];
    };
    const textOf = async (blob: Blob) => new TextDecoder().decode(new Uint8Array(await bytesOf(blob)));
    const blobFor = (url: string) => ((URL.createObjectURL as any).mock.calls as [Blob][])[Number(url.split('-').at(-1)) - first]![0];
    let first = 0;

    it('a stylesheet: each slot becomes a CSS string holding the URL of a file made earlier in the literal; read() keeps the registered bytes', async () => {
        first = minted + 1;
        const css = 'é @import "b.css"; a { b: url( img/x.svg ) }';
        install([
            ['img/x.svg', 'image/svg+xml', b64('<svg/>')],
            ['b.css', 'text/css', b64('')],
            sheetEntry('a.css', css, [['"b.css"', 'b.css'], [' img/x.svg ', 'img/x.svg']]),
        ]);
        const url = files().url('a.css');
        expect(await textOf(blobFor(url))).toBe(`é @import "${files().url('b.css')}"; a { b: url("${files().url('img/x.svg')}") }`);
        expect(blobFor(url).type).toBe('text/css');
    });

    it('a slot naming a file not made yet (later in the literal, or the stylesheet itself) keeps its registered bytes: one pass, nothing followed, nothing loops', async () => {
        first = minted + 1;
        const a = '@import "b.css"; @import "a.css"; x { y: url(i.svg) }';
        install([
            ['i.svg', 'image/svg+xml', b64('<svg/>')],
            sheetEntry('a.css', a, [['"b.css"', 'b.css'], ['"a.css"', 'a.css'], ['i.svg', 'i.svg']]),
            sheetEntry('b.css', '@import "a.css";', [['"a.css"', 'a.css']]),
        ]);
        expect(await textOf(blobFor(files().url('a.css')))).toBe(`@import "b.css"; @import "a.css"; x { y: url("${files().url('i.svg')}") }`);
        expect(await textOf(blobFor(files().url('b.css')))).toBe(`@import "${files().url('a.css')}";`);
        expect((URL.createObjectURL as any).mock.calls).toHaveLength(3); // one URL per file
    });

    it('escapes the URL for a CSS string, whatever it contains, so the string cannot end early or break a <style>', async () => {
        first = minted + 1;
        let calls = 0;
        URL.createObjectURL = vi.fn(() => (++calls === 1 ? 'blob:x"y\'z\\w<v>u\nt\u0000s' : `blob:null/fake-${++minted}`)) as any;
        install([
            ['i.svg', 'image/svg+xml', b64('<svg/>')],
            sheetEntry('a.css', 'a { b: url(i.svg) }', [['i.svg', 'i.svg']]),
        ]);
        const blob = ((URL.createObjectURL as any).mock.calls as [Blob][])[1]![0];
        expect(await textOf(blob)).toBe('a { b: url("blob:x\\22 y\\27 z\\5c w\\3c v\\3e u\\a t\\0 s") }');
    });

    it('list() is sorted by path, whatever order the literal is in (the host orders it for dependencies)', () => {
        install([['z.svg', 'image/svg+xml', b64('')], ['b.css', 'text/css', b64('')], ['a.css', 'text/css', b64('')]]);
        expect(files().list()).toEqual(['a.css', 'b.css', 'z.svg']);
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

describe('sandboxFiles.write() and remove(): guest writes, the guest side (backlog C5, run from its source text)', () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalArrayBuffer = Blob.prototype.arrayBuffer;
    beforeEach(() => {
        URL.createObjectURL = vi.fn(() => 'blob:null/fake');
        // jsdom's Blob has no arrayBuffer(): give it one through FileReader
        Blob.prototype.arrayBuffer = function (this: Blob) { return bytesOf(this).then(b => new Uint8Array(b).buffer); };
    });
    afterEach(() => {
        URL.createObjectURL = originalCreateObjectURL;
        Blob.prototype.arrayBuffer = originalArrayBuffer;
        delete (globalThis as any).sandboxFiles;
    });

    // A host stand-in for the captured sandbox:write call: records each request and answers when told to.
    function host() {
        const requests: any[] = [];
        const answers: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
        const writeFiles = vi.fn((request: unknown) => {
            requests.push(structuredClone(request)); // as the broker clones it
            return new Promise((resolve, reject) => answers.push({ resolve, reject }));
        });
        const accept = (i: number) => {
            const r = requests[i];
            answers[i]!.resolve(r.change === 'write' ? { path: r.path, change: 'write', type: 'text/plain', size: r.entry?.content?.length ?? r.entry.length } : { path: r.path, change: 'remove' });
        };
        return { requests, answers, writeFiles, accept };
    }
    const installWith = (entries: unknown, writeFiles: unknown) =>
        new Function('writeFiles', `return (${inSandboxFiles.toString()})(${JSON.stringify(entries)}, writeFiles);`)(writeFiles) as SandboxFiles;
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    const SNAPSHOT = [['kept.txt', 'text/plain', btoa('kept')]];

    it('both exist in every environment; without the write call (guestWrites off) they reject FILES_NOT_ALLOWED and send nothing', async () => {
        for (const writeFiles of [undefined, null]) {
            const api = installWith(SNAPSHOT, writeFiles);
            const notAllowed = { isError: true, code: 'FILES_NOT_ALLOWED', keys: ['code'], message: '[sandboxFiles] FILES_NOT_ALLOWED: guest writes are off' };
            await expect(api.write('a.txt', 'x').catch(shape)).resolves.toEqual(notAllowed);
            await expect(api.remove('kept.txt').catch(shape)).resolves.toEqual(notAllowed);
            expect(api.list()).toEqual(['kept.txt']);
        }
    });

    it('the view changes only after the host\'s answer: before it nothing is listed; a refusal leaves the view as it was, with the host\'s code', async () => {
        const { requests, answers, writeFiles, accept } = host();
        const api = installWith(SNAPSHOT, writeFiles);
        const pending = api.write('a.txt', 'héllo');
        await settle();
        expect(requests.map(r => [r.change, r.path, Array.from(r.entry)])).toEqual([['write', 'a.txt', Array.from(new TextEncoder().encode('héllo'))]]);
        expect(api.list()).toEqual(['kept.txt']);
        accept(0);
        await expect(pending).resolves.toBeUndefined();
        expect(api.list()).toEqual(['a.txt', 'kept.txt']);
        expect(new TextDecoder().decode(await api.read('a.txt'))).toBe('héllo');

        const refused = api.write('b.txt', 'x');
        await settle();
        answers[1]!.reject(Object.assign(new Error('refused'), { code: 'FILES_QUOTA_EXCEEDED' }));
        await expect(refused.catch((e: any) => e.code)).resolves.toBe('FILES_QUOTA_EXCEEDED');
        const removed = api.remove('kept.txt');
        await settle();
        answers[2]!.reject(Object.assign(new Error('refused'), { code: 'FILES_BUSY' }));
        await expect(removed.catch((e: any) => e.code)).resolves.toBe('FILES_BUSY');
        expect(api.list()).toEqual(['a.txt', 'kept.txt']);
    });

    it('url() of a written path is NOT_FOUND, an overwritten snapshot path included; no URL is minted for a write', async () => {
        const { writeFiles, accept } = host();
        const api = installWith(SNAPSHOT, writeFiles);
        const minted = (URL.createObjectURL as any).mock.calls.length;
        const writes = [api.write('new.txt', 'n'), api.write('kept.txt', 'over')];
        await settle();
        accept(0);
        await settle();
        accept(1);
        await Promise.all(writes);
        for (const path of ['new.txt', 'kept.txt']) {
            let thrown: unknown;
            try { api.url(path); } catch (e) { thrown = e; }
            expect(shape(thrown), path).toEqual(NOT_FOUND);
        }
        expect((URL.createObjectURL as any).mock.calls.length).toBe(minted);
        expect(new TextDecoder().decode(await api.read('kept.txt'))).toBe('over');
    });

    it('remove(): the path leaves the view after the answer; a "none" answer (in neither store nor writes) rejects NOT_FOUND and changes nothing', async () => {
        const { requests, answers, writeFiles, accept } = host();
        const api = installWith(SNAPSHOT, writeFiles);
        const missing = api.remove('never.txt');
        await settle();
        answers[0]!.resolve({ path: 'never.txt', change: 'none' });
        await expect(missing.catch(shape)).resolves.toEqual(NOT_FOUND);
        const removed = api.remove('kept.txt');
        await settle();
        expect(requests[1]).toEqual({ change: 'remove', path: 'kept.txt' });
        accept(1);
        await removed;
        expect(api.list()).toEqual([]);
        await expect(api.read('kept.txt').catch(shape)).resolves.toEqual(NOT_FOUND);
    });

    it('content is copied when write() is called, whatever the caller does next; requests leave in call order even after a Blob\'s read', async () => {
        const { requests, writeFiles } = host();
        const api = installWith([], writeFiles);
        const bytes = new Uint8Array([1, 2, 3]);
        const buffer = new Uint8Array([4, 5]).buffer;
        api.write('blob.bin', new Blob([new Uint8Array([9, 9])]));
        api.write('typed.bin', bytes);
        api.write('buffer.bin', buffer);
        api.write('view.bin', new DataView(new Uint8Array([0, 6, 7, 0]).buffer, 1, 2));
        api.write('wrapped', { content: new Uint16Array([0x4241]), type: 'text/plain' });
        api.remove('x.txt');
        bytes.fill(0);
        new Uint8Array(buffer).fill(0);
        for (let i = 0; i < 10; i++) await settle();
        expect(requests.map(r => [r.change, r.path])).toEqual([['write', 'blob.bin'], ['write', 'typed.bin'], ['write', 'buffer.bin'], ['write', 'view.bin'], ['write', 'wrapped'], ['remove', 'x.txt']]);
        expect(requests.slice(0, 4).map(r => Array.from(r.entry))).toEqual([[9, 9], [1, 2, 3], [4, 5], [6, 7]]);
        expect([Array.from(requests[4].entry.content), requests[4].entry.type]).toEqual([[0x41, 0x42], 'text/plain']);
    });

    it('what is not a path or content is sent as null, for the host to refuse; only change, path and entry are sent', async () => {
        const { requests, writeFiles } = host();
        const api = installWith([], writeFiles);
        api.write(7 as any, 5);
        api.write({ toString: () => 'a.txt' } as any, { content: { a: 1 }, type: 7 });
        api.remove(null as any);
        for (let i = 0; i < 5; i++) await settle();
        expect(requests).toEqual([
            { change: 'write', path: null, entry: null },
            { change: 'write', path: null, entry: { content: null, type: null } },
            { change: 'remove', path: null },
        ]);
    });

    it('a throwing getter on a wrapper rejects the write and sends nothing', async () => {
        const { requests, writeFiles } = host();
        const api = installWith([], writeFiles);
        const entry = { get content() { throw new Error('nope'); }, type: 'text/plain' };
        await expect(api.write('a.txt', entry).catch((e: any) => e.message)).resolves.toBe('nope');
        await settle();
        expect(requests).toEqual([]);
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

    it('a CSS slot in a <style> gets the URL escaped for a CSS string; in a style attribute, then for the attribute too', () => {
        (globalThis as any).__files = { url: (path: string) => (path === 'odd' ? 'x"y\'z\\w<v>u&t' : `blob:null/${path}`) };
        run('globalThis.__files', [
            '<style>a { b: url("', ['i.svg', 'css'], '") } c { d: url("', ['odd', 'css'], '") }</style><p style="b: url(&quot;', ['odd', 'css-attribute'], '&quot;)" title="', 'odd', '">',
        ]);
        expect(written).toEqual([
            '<style>a { b: url("blob:null/i.svg") } c { d: url("x\\22 y\\27 z\\5c w\\3c v\\3e u&t") }</style>'
            + '<p style="b: url(&quot;x\\22 y\\27 z\\5c w\\3c v\\3e u&amp;t&quot;)" title="x&quot;y\'z\\w<v>u&amp;t">',
        ]);
        // what the guest's parser makes of it: one <style> whose text is one rule per reference, and an
        // attribute whose CSS string holds the URL exactly
        const doc = new DOMParser().parseFromString(written[0]!, 'text/html');
        expect(doc.querySelectorAll('style')).toHaveLength(1);
        expect(doc.querySelector('p')!.getAttribute('style')).toBe('b: url("x\\22 y\\27 z\\5c w\\3c v\\3e u&t")');
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
