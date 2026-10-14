import { describe, it, expect, vi } from 'vitest';
import { FileStore, MAX_FILES, MAX_PATH_LENGTH, MAX_TOTAL_BYTES, mimeTypeFor, type FileErrorCode } from './files';
import { createGuestWrites, GUEST_WRITE_BYTES_PER_SECOND, GUEST_WRITES_PER_SECOND, INERT_TYPES, parseCommitArguments, WRITE_METHOD } from './guest-writes';

/**
 * Guest writes, host side (backlog C5): the overlay of one environment over the element's FileStore. The guest
 * side is in-sandbox-files.test.ts, the element's wiring test/unit/host.test.ts, the browsers
 * test/e2e/guest-writes.spec.ts.
 */

const refusal = (fn: () => unknown): unknown => {
    try {
        fn();
    } catch (e: any) {
        return { code: e?.code, keys: Object.keys(e), isError: e instanceof Error };
    }
    return 'not refused';
};
const refused = (code: FileErrorCode) => ({ code, keys: ['code'], isError: true });

// A store and an overlay over it, with a clock the test moves.
function setup(files: Record<string, unknown> = {}) {
    const store = new FileStore(() => {});
    store.register(files);
    let time = 0;
    const writes = createGuestWrites({ store, now: () => time });
    const tick = (ms: number) => { time += ms; };
    const write = (path: unknown, entry: unknown) => writes.handle({ change: 'write', path, entry });
    const remove = (path: unknown) => writes.handle({ change: 'remove', path });
    // the overlay with each write's content as its length and a checksum: deep equality over megabytes is slow
    const digest = (bytes: Uint8Array) => { let h = 0; for (let i = 0; i < bytes.length; i++) h = (h * 31 + bytes[i]!) | 0; return h; };
    const state = () => ({ store: store.list(), overlay: writes.list().map(w => (w.change === 'write' ? { ...w, content: [w.content.length, digest(w.content)] } : w)) });
    return { store, writes, write, remove, tick, state };
}

describe('the method and its constants', () => {
    it('the reserved name, and the rate bounds', () => {
        expect(WRITE_METHOD).toBe('sandbox:write');
        expect(GUEST_WRITES_PER_SECOND).toBe(100);
        expect(GUEST_WRITE_BYTES_PER_SECOND).toBe(MAX_TOTAL_BYTES);
    });
});

describe('a write is checked by the store\'s own rules, and a refused one changes nothing', () => {
    const BAD_PATHS: unknown[] = ['../x', '%2e%2e/x', '/x', 'a//b', 'a\\b', 'a/./b', 'x/', '', ' x', 'ü.txt', 'x'.repeat(MAX_PATH_LENGTH + 1), 7, null, undefined, {}, ['a.txt'], true];

    it.each(BAD_PATHS.map(path => [JSON.stringify(path) ?? String(path), path]))('path %s: INVALID_PATH for a write and a remove; store and overlay unchanged', (_label, path) => {
        const { write, remove, state } = setup({ 'kept.txt': 'k' });
        write('w.txt', 'w');
        const before = state();
        expect(refusal(() => write(path, 'x'))).toEqual(refused('INVALID_PATH'));
        expect(refusal(() => remove(path))).toEqual(refused('INVALID_PATH'));
        expect(state()).toEqual(before);
    });

    it('a path of exactly MAX_PATH_LENGTH characters is fine (positive control)', () => {
        const { write, state } = setup();
        expect(write('x'.repeat(MAX_PATH_LENGTH), 'x')).toMatchObject({ change: 'write' });
        expect(state().overlay).toHaveLength(1);
    });

    it.each([
        ['a number', 5], ['null', null], ['a boolean', true], ['an array', [1, 2]], ['a plain object', { a: 1 }],
        ['a wrapper without type', { content: 'x' }], ['a wrapper with a bad type', { content: 'x', type: 'text plain' }],
        ['a wrapper with a type and parameters', { content: 'x', type: 'text/plain;charset=x' }], ['a wrapper of a number', { content: 5, type: 'text/plain' }],
        ['an ArrayBuffer (the guest sends bytes)', new ArrayBuffer(1)],
    ])('entry %s: INVALID_FILE; nothing changes', (_label, entry) => {
        const { write, state } = setup();
        expect(refusal(() => write('e.txt', entry))).toEqual(refused('INVALID_FILE'));
        expect(state()).toEqual({ store: [], overlay: [] });
    });

    it.each([[null], [7], ['write'], [{}], [{ change: 'move', path: 'a.txt' }], [{ change: 'WRITE', path: 'a.txt', entry: 'x' }]])('request %j: INVALID_FILE', (request) => {
        const { writes, state } = setup();
        expect(refusal(() => writes.handle(request))).toEqual(refused('INVALID_FILE'));
        expect(state()).toEqual({ store: [], overlay: [] });
    });

    it('the type is the store\'s: from the extension, or the override (lower-cased); the answer says which', () => {
        const { write, writes } = setup();
        expect(write('a.JS', 'x')).toEqual({ path: 'a.JS', change: 'write', type: 'text/javascript', size: 1 });
        expect(write('noext', 'x')).toEqual({ path: 'noext', change: 'write', type: 'application/octet-stream', size: 1 });
        expect(write('img.png', { content: new Uint8Array([1, 2]), type: 'Image/SVG+xml' })).toEqual({ path: 'img.png', change: 'write', type: 'image/svg+xml', size: 2 });
        expect(writes.list().map(w => [w.path, w.change === 'write' && w.type])).toEqual([['a.JS', 'text/javascript'], ['img.png', 'image/svg+xml'], ['noext', 'application/octet-stream']]);
    });

    it('content is copied at write time, and list() hands out copies', () => {
        const { write, writes } = setup();
        const bytes = new Uint8Array([1, 2, 3]);
        write('b.bin', bytes);
        bytes.fill(9);
        const first = writes.list()[0] as any;
        expect(Array.from(first.content)).toEqual([1, 2, 3]);
        first.content.fill(7);
        expect(Array.from((writes.list()[0] as any).content)).toEqual([1, 2, 3]);
    });
});

describe('the write-time quota is the store with the overlay applied (no lexing)', () => {
    it('bytes: at the cap a write passes, one byte past it is refused; replacing counts the difference; a removal frees a stored file\'s cost', () => {
        const { write, remove, tick, state } = setup({ 'fill.bin': new Uint8Array(MAX_TOTAL_BYTES - 100) });
        expect(write('a.bin', new Uint8Array(60))).toMatchObject({ change: 'write' });
        expect(write('b.bin', new Uint8Array(40))).toMatchObject({ change: 'write' }); // exactly at the cap
        const atCap = state();
        expect(refusal(() => write('c.bin', new Uint8Array(1)))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        expect(refusal(() => write('a.bin', new Uint8Array(61)))).toEqual(refused('FILES_QUOTA_EXCEEDED')); // a replacement that grows
        expect(state()).toEqual(atCap);
        expect(write('a.bin', new Uint8Array(10))).toMatchObject({ size: 10 }); // a replacement that shrinks
        expect(write('c.bin', new Uint8Array(50))).toMatchObject({ size: 50 });
        expect(remove('fill.bin')).toEqual({ path: 'fill.bin', change: 'remove' });
        tick(1000); // the byte rate is its own bound (below)
        expect(write('d.bin', new Uint8Array(MAX_TOTAL_BYTES - 100))).toMatchObject({ change: 'write' });
        expect(state().store.map(f => f.path)).toEqual(['fill.bin']); // the store itself never changed
    });

    it('a write over a stored file replaces its cost, including what its rewrite added (the stored cost), without lexing the write', () => {
        const source = Array.from({ length: 50 }, (_, i) => `import './m${i}.js';`).join('\n');
        const { store, write } = setup({ 'app.js': source });
        // fill the rest, by registered bytes, so only the stored rewrite cost is left to give back
        const rest = MAX_TOTAL_BYTES - (store as any)._totalBytes;
        expect(write('fill.bin', new Uint8Array(rest))).toMatchObject({ change: 'write' });
        expect(refusal(() => write('one.bin', new Uint8Array(1)))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        // the same JavaScript, written: only its registered bytes count now, so its old rewrite cost is free again
        expect(write('app.js', source)).toMatchObject({ change: 'write' });
        expect(write('one.bin', new Uint8Array(1))).toMatchObject({ change: 'write' });
    });

    it('the count: a new path counts, a replacement does not, a removal of a stored file frees one', () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < MAX_FILES - 1; i++) files[`f/${i}.txt`] = '';
        const { write, remove, state } = setup(files);
        expect(write('one.txt', '')).toMatchObject({ change: 'write' });
        expect(refusal(() => write('two.txt', ''))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        expect(write('f/0.txt', 'replaced')).toMatchObject({ change: 'write' });
        expect(write('one.txt', 'again')).toMatchObject({ change: 'write' });
        expect(remove('f/1.txt')).toMatchObject({ change: 'remove' });
        expect(write('two.txt', '')).toMatchObject({ change: 'write' });
        expect(refusal(() => write('three.txt', ''))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        expect(state().overlay.map(w => [w.path, w.change])).toEqual([['f/0.txt', 'write'], ['f/1.txt', 'remove'], ['one.txt', 'write'], ['two.txt', 'write']]);
    });
});

describe('removals', () => {
    it('a stored path is marked; a path only the overlay wrote is forgotten; a path in neither is answered "none" and records nothing', () => {
        const { write, remove, state } = setup({ 'kept.txt': 'k' });
        write('new.txt', 'n');
        write('kept.txt', 'over');
        expect(remove('kept.txt')).toEqual({ path: 'kept.txt', change: 'remove' });
        expect(remove('new.txt')).toEqual({ path: 'new.txt', change: 'remove' });
        expect(state().overlay).toEqual([{ path: 'kept.txt', change: 'remove' }]);
        expect(remove('kept.txt')).toEqual({ path: 'kept.txt', change: 'none' }); // already removed in the guest's view
        expect(remove('never.txt')).toEqual({ path: 'never.txt', change: 'none' });
        expect(remove('new.txt')).toEqual({ path: 'new.txt', change: 'none' });
        expect(state().overlay).toEqual([{ path: 'kept.txt', change: 'remove' }]);
        // a write after a removal replaces the mark
        expect(write('kept.txt', 'back')).toMatchObject({ change: 'write' });
        expect(state().overlay.map(w => w.change)).toEqual(['write']);
    });

    it('removal marks are bounded by the store: a flood of removals of unknown paths records nothing', () => {
        const { remove, tick, state } = setup({ 'a.txt': 'a' });
        for (let i = 0; i < 1000; i++) {
            if (i % GUEST_WRITES_PER_SECOND === 0) tick(1000);
            expect(remove(`missing/${i}.txt`).change).toBe('none');
        }
        tick(1000);
        expect(remove('a.txt').change).toBe('remove');
        expect(state().overlay).toEqual([{ path: 'a.txt', change: 'remove' }]);
    });
});

describe('commit: the full store check, only the given paths, and code needs { code: true }', () => {
    it('applies exactly the given paths, atomically, returns what changed, and forgets them; others stay pending', () => {
        const { store, write, remove, writes } = setup({ 'old.txt': 'o', 'gone.txt': 'g' });
        write('a.txt', 'a');
        write('b.json', '{}');
        remove('gone.txt');
        expect(writes.commit(['a.txt', 'gone.txt', 'not-pending.txt'], false)).toEqual(['a.txt', 'gone.txt']);
        expect(store.list().map(f => f.path)).toEqual(['a.txt', 'old.txt']);
        expect(writes.list().map(w => w.path)).toEqual(['b.json']);
        expect(writes.commit([], false)).toEqual([]);
    });

    it('refused when the host registered more meanwhile: FILES_QUOTA_EXCEEDED, and neither store nor overlay changes', () => {
        const { store, write, writes, state } = setup();
        write('a.png', new Uint8Array(100));
        store.register({ 'host.bin': new Uint8Array(MAX_TOTAL_BYTES - 50) });
        const before = state();
        expect(refusal(() => writes.commit(['a.png'], false))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        expect(state()).toEqual(before);
        store.unregister(['host.bin']);
        expect(writes.commit(['a.png'], false)).toEqual(['a.png']); // positive control
    });

    it('lexes JavaScript at commit: a write that passed by its bytes is refused when its rewrite cost does not fit', () => {
        const source = Array.from({ length: 200 }, (_, i) => `import './m${i}.js';`).join('\n');
        const bytes = new TextEncoder().encode(source).length;
        const { store, write, writes, state } = setup({ 'fill.bin': new Uint8Array(MAX_TOTAL_BYTES - bytes) });
        expect(write('app.js', source)).toMatchObject({ change: 'write' }); // fits by its registered bytes
        const before = state();
        expect(refusal(() => writes.commit(['app.js'], true))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        expect(state()).toEqual(before);
        store.unregister(['fill.bin']);
        expect(writes.commit(['app.js'], true)).toEqual(['app.js']); // positive control
    });

    describe('the inert list', () => {
        it('INERT_TYPES is exactly the extension table\'s image, font, audio and video types without SVG, plus text/plain, application/json and text/css', () => {
            const extensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'svg', 'woff', 'woff2', 'ttf', 'otf', 'mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'mp4', 'webm', 'ogv', 'js', 'mjs', 'css', 'html', 'htm', 'json', 'map', 'xml', 'txt', 'md', 'csv', 'vtt', 'wasm'];
            const media = new Set(extensions.map(e => mimeTypeFor(`x.${e}`)).filter(t => /^(image|font|audio|video)\//.test(t) && t !== 'image/svg+xml'));
            expect([...INERT_TYPES].sort()).toEqual([...media, 'text/plain', 'application/json', 'text/css'].sort());
        });

        const NON_INERT: [string, unknown][] = [
            ['app.js', 'void 0'], ['app.mjs', 'export {}'], ['page.html', '<p>'], ['page.htm', '<p>'], ['icon.svg', '<svg/>'], ['feed.xml', '<x/>'],
            ['mod.wasm', new Uint8Array([0, 97, 115, 109])], ['readme.md', '# x'], ['data.csv', 'a,b'], ['subs.vtt', 'WEBVTT'], ['x.unknown', 'x'], ['noext', 'x'],
            ['fake.png', { content: '<svg/>', type: 'image/svg+xml' }], ['note.txt', { content: 'void 0', type: 'text/javascript' }],
            ['made-up.png', { content: 'x', type: 'image/x-anything' }], ['app.js.txt', { content: 'x', type: 'application/javascript' }],
        ];

        it.each(NON_INERT)('%s: refused with FILES_NOT_ALLOWED without code: true (anything but a literal true), store and overlay unchanged; committed with it', (path, entry) => {
            const { store, write, writes, state } = setup();
            write(path, entry);
            write('ok.txt', 'fine');
            const before = state();
            for (const code of [false]) expect(refusal(() => writes.commit(['ok.txt', path], code))).toEqual(refused('FILES_NOT_ALLOWED'));
            expect(state()).toEqual(before);
            expect(writes.commit([path, 'ok.txt'], true)).toEqual([path, 'ok.txt'].sort());
            expect(store.list().map(f => f.path)).toEqual([path, 'ok.txt'].sort());
        });

        it.each(['a.png', 'a.jpg', 'a.gif', 'a.webp', 'a.avif', 'a.ico', 'a.bmp', 'a.woff', 'a.woff2', 'a.ttf', 'a.otf', 'a.mp3', 'a.wav', 'a.ogg', 'a.m4a', 'a.flac', 'a.mp4', 'a.webm', 'a.ogv', 'a.txt', 'a.json', 'a.map', 'a.css'])('%s is inert: committed without the flag', (path) => {
            const { write, writes } = setup();
            write(path, 'x');
            expect(writes.commit([path], false)).toEqual([path]);
        });

        it('a removal is never code: committed without the flag', () => {
            const { write, remove, writes, store } = setup({ 'app.js': 'void 0' });
            remove('app.js');
            write('x.txt', 'x');
            expect(writes.commit(['app.js'], false)).toEqual(['app.js']);
            expect(store.list()).toEqual([]);
        });
    });

    it('parseCommitArguments: an array of valid paths is required; only a literal true is code', () => {
        expect(parseCommitArguments(['a.txt'], undefined)).toEqual({ paths: ['a.txt'], code: false });
        expect(parseCommitArguments(['a.txt'], { code: true })).toEqual({ paths: ['a.txt'], code: true });
        for (const options of [{ code: 'true' }, { code: 1 }, true, null, { code: [true] }]) expect(parseCommitArguments([], options).code).toBe(false);
        for (const paths of [undefined, null, 'a.txt', { 0: 'a.txt' }]) expect(refusal(() => parseCommitArguments(paths, undefined))).toEqual(refused('INVALID_PATH'));
        for (const path of ['../x', '', 7, null]) expect(refusal(() => parseCommitArguments(['a.txt', path], undefined))).toEqual(refused('INVALID_PATH'));
    });
});

describe('the rate: GUEST_WRITES_PER_SECOND requests and GUEST_WRITE_BYTES_PER_SECOND bytes per window, FILES_BUSY past them', () => {
    it('requests: the 101st in a window is refused, refused requests count too, and the next window starts afresh', () => {
        const { write, writes, tick, state } = setup();
        for (let i = 0; i < GUEST_WRITES_PER_SECOND - 1; i++) write(`f/${i}.txt`, 'x');
        expect(refusal(() => write('../bad', 'x'))).toEqual(refused('INVALID_PATH')); // the 100th, counted
        const before = state();
        expect(refusal(() => write('late.txt', 'x'))).toEqual(refused('FILES_BUSY'));
        expect(refusal(() => writes.handle({ change: 'remove', path: 'f/0.txt' }))).toEqual(refused('FILES_BUSY'));
        expect(state()).toEqual(before);
        tick(999);
        expect(refusal(() => write('late.txt', 'x'))).toEqual(refused('FILES_BUSY'));
        tick(1);
        expect(write('late.txt', 'x')).toMatchObject({ change: 'write' });
    });

    it('bytes: recorded bytes per window are bounded even where the quota is not (a replacement); a write past the cap is FILES_QUOTA_EXCEEDED first', () => {
        const { write, tick, state } = setup();
        const third = Math.floor(GUEST_WRITE_BYTES_PER_SECOND / 3) + 1;
        write('big.bin', new Uint8Array(third));
        write('big.bin', new Uint8Array(third));
        const before = state();
        expect(refusal(() => write('big.bin', new Uint8Array(third)))).toEqual(refused('FILES_BUSY'));
        expect(state()).toEqual(before);
        expect(refusal(() => write('other.bin', new Uint8Array(MAX_TOTAL_BYTES)))).toEqual(refused('FILES_QUOTA_EXCEEDED'));
        tick(1000);
        expect(write('big.bin', new Uint8Array(third))).toMatchObject({ change: 'write' });
    });
});

describe('lifecycle', () => {
    it('close(): every later request is refused (FILES_NOT_ALLOWED); what was recorded stays listable and committable', () => {
        const { store, write, writes } = setup();
        write('a.txt', 'a');
        writes.close();
        expect(refusal(() => write('b.txt', 'b'))).toEqual(refused('FILES_NOT_ALLOWED'));
        expect(refusal(() => writes.handle({ change: 'remove', path: 'a.txt' }))).toEqual(refused('FILES_NOT_ALLOWED'));
        expect(writes.list().map(w => w.path)).toEqual(['a.txt']);
        expect(writes.commit(['a.txt'], false)).toEqual(['a.txt']);
        expect(store.list().map(f => f.path)).toEqual(['a.txt']);
    });

    it('reads the clock once per request (fake clock)', () => {
        const store = new FileStore(() => {});
        const now = vi.fn(() => 0);
        const writes = createGuestWrites({ store, now });
        writes.handle({ change: 'write', path: 'a.txt', entry: 'a' });
        expect(now).toHaveBeenCalledTimes(1);
    });
});
