import { deflateSync } from 'node:zlib';
import { test, expect, type SandboxDriver } from './fixture';
import { useRecorder } from './recorder';
import { waitInView, inView } from './strict-view';
import { MAX_FILES, MAX_TOTAL_BYTES } from '@src/lib/files';
import { GUEST_WRITES_PER_SECOND, GUEST_WRITE_BYTES_PER_SECOND } from '@src/lib/guest-writes';
import type { SandboxConfig, SandboxConfigOptions } from '@src/host';
import type { StrictSandboxOrigins } from '@src/lib/csp/origins';

/**
 * Guest writes (backlog C5, src/lib/guest-writes.ts, ADR-004 amendment "guest writes"), in iframe, worker and
 * strict mode. Each test names the guarantee it proves:
 *   1. off (the default), a write is refused by both routes (sandboxFiles and a forged bridge call), and no raw
 *      frame records anything; the store, the overlay and the events stay empty (positive control: on)
 *   2. a write is refused with registerFiles()'s own codes, by both routes, and a refused write changes nothing
 *   3. the cap is the store's: at the cap a write passes, one byte or one file past it is refused, a removal
 *      frees space; past the rate, FILES_BUSY
 *   4. the guest reads its own acknowledged writes byte-exact, typed by the store; url() never names one
 *   5. lifecycle: reset() discards the overlay; terminate() keeps it, and a commit after it reaches the next
 *      build (fileschanged), in strict mode as an image the view renders
 *   6. a commit of anything but an inert type needs { code: true }; the type is the store's
 *   7. a flood is refused with FILES_BUSY and 'fileswritten' stays bounded; a listener's reset() mid-flood leaves
 *      the next environment untouched (only the current port is heard)
 *   8. strict mode: the view renders no blob: content but registered files, with written files present
 *   9. writing adds no egress; two sandboxes keep their writes apart
 * Evidence (backlog T5): read from the host page, outside the guest: listFiles(), listGuestWrites(), the
 * 'fileswritten' events the harness records, the view's DOM (strict-view.ts) and the recorder's listeners. The
 * guest's own outcome is asserted from inside the guest, by exact code.
 */

const recorder = useRecorder();

const MODES = ['iframe', 'worker', 'strict'] as const;
type Mode = typeof MODES[number];

// One guest-side helper: how a promise (or a function returning one) settled, by exact code.
const OUTCOME = `const outcome = (run) => Promise.resolve().then(run).then(
    (value) => ({ ok: true, value: value === undefined ? null : value }),
    (e) => ({ code: e && e.code, isError: e instanceof Error, keys: e && typeof e === 'object' ? Object.keys(e) : null }));`;
const inGuest = <T = any>(sandbox: SandboxDriver, body: string, timeout?: number) => sandbox.inGuest<T>(`${OUTCOME}\n${body}`, timeout);

// a config every mode can take: origins without scripts (strict mode has none)
const writesOn = (mode: Mode, config: SandboxConfigOptions & { origins?: StrictSandboxOrigins } = {}): SandboxConfig => ({ mode, guestWrites: true, ...config });

// What the host page sees, read outside the guest.
async function hostView(sandbox: SandboxDriver, selector = 'web-sandbox') {
    return sandbox.page.evaluate((selector) => {
        const el = document.querySelector(selector) as any;
        return {
            files: el.listFiles().map((f: any) => f.path),
            writes: el.listGuestWrites().map((w: any) => (w.change === 'write' ? { path: w.path, change: w.change, type: w.type, size: w.size } : w)),
            events: (window as any).sandboxWrites.filter((e: any) => e.sandbox === (el.id || 'main')).map((e: any) => e.paths),
        };
    }, selector);
}
const contentOf = (sandbox: SandboxDriver, path: string) => sandbox.page.evaluate((path) => {
    const write = (document.querySelector('web-sandbox') as any).listGuestWrites().find((w: any) => w.path === path);
    return write?.content ? Array.from(write.content as Uint8Array) : null;
}, path);
const commit = (sandbox: SandboxDriver, paths: unknown, options?: unknown) => sandbox.page.evaluate(({ paths, options }) => {
    const el = document.querySelector('web-sandbox') as any;
    const changed: string[][] = [];
    const listener = (e: any) => changed.push(e.detail.paths);
    el.addEventListener('fileschanged', listener);
    try {
        el.commitGuestWrites(paths, options);
        return { ok: true, changed };
    } catch (e: any) {
        return { code: e?.code, changed };
    } finally {
        el.removeEventListener('fileschanged', listener);
    }
}, { paths, options });

// A PNG of width × height, so a rendered <img> tells "this file decoded" by its natural size.
function png(width: number, height: number): Buffer {
    const table = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (bytes: Buffer) => {
        let c = 0xffffffff;
        for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Buffer) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const sum = Buffer.alloc(4);
        sum.writeUInt32BE(crc(body));
        return Buffer.concat([length, body, sum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
    const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)])));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG_3x5 = Array.from(png(3, 5));

for (const mode of MODES) {
    test.describe(`${mode} mode`, () => {
        test('1. off: both routes refused with FILES_NOT_ALLOWED and nothing recorded; on, the same calls are recorded (positive control)', async ({ sandbox }) => {
            await sandbox.registerFiles({ 'kept.txt': 'kept' });
            expect(await sandbox.mount({ mode })).toBe('ready');
            const off = await inGuest(sandbox, `return {
                write: await outcome(() => sandboxFiles.write('a.txt', 'x')),
                remove: await outcome(() => sandboxFiles.remove('kept.txt')),
                forgedWrite: await outcome(() => bridge.call('sandbox:write', { change: 'write', path: 'a.txt', entry: 'x' })),
                forgedRemove: await outcome(() => bridge.callWithTimeout(5000, 'sandbox:write', { change: 'remove', path: 'kept.txt' })),
                list: sandboxFiles.list(),
            }`);
            const refused = { code: 'FILES_NOT_ALLOWED', isError: true, keys: ['code'] };
            expect(off).toEqual({ write: refused, remove: refused, forgedWrite: refused, forgedRemove: refused, list: ['kept.txt'] });
            expect(await hostView(sandbox)).toEqual({ files: ['kept.txt'], writes: [], events: [] });

            expect(await sandbox.mount(writesOn(mode))).toBe('ready');
            const on = await inGuest(sandbox, `return {
                write: await outcome(() => sandboxFiles.write('a.txt', 'x')),
                forged: await outcome(() => bridge.call('sandbox:write', { change: 'write', path: 'b.txt', entry: new Uint8Array([1]) })),
                remove: await outcome(() => sandboxFiles.remove('kept.txt')),
            }`);
            expect(on.write).toEqual({ ok: true, value: null });
            expect(on.forged).toEqual({ ok: true, value: { path: 'b.txt', change: 'write', type: 'text/plain', size: 1 } });
            expect(on.remove).toEqual({ ok: true, value: null });
            expect(await hostView(sandbox)).toEqual({
                files: ['kept.txt'],
                writes: [{ path: 'a.txt', change: 'write', type: 'text/plain', size: 1 }, { path: 'b.txt', change: 'write', type: 'text/plain', size: 1 }, { path: 'kept.txt', change: 'remove' }],
                events: [['a.txt'], ['b.txt'], ['kept.txt']],
            });
        });

        test('1b. no raw route: frames the guest can post itself (to its parents, its own global, an RPC_REQ, an FS_WRITE) record nothing, while a write through sandboxFiles does (positive control)', async ({ sandbox }) => {
            expect(await sandbox.mount(writesOn(mode))).toBe('ready');
            await inGuest(sandbox, `
                const frames = [
                    { type: 'RPC_REQ', id: 1, method: 'sandbox:write', args: [{ change: 'write', path: 'raw.txt', entry: 'x' }] },
                    { type: 'FS_WRITE', path: 'raw.txt', content: 'x' },
                ];
                for (const frame of frames) {
                    for (const target of [globalThis.parent, globalThis.parent && globalThis.parent.parent, globalThis.top, globalThis]) {
                        try { if (target && target.postMessage) target.postMessage(frame, '*'); } catch (e) { try { target.postMessage(frame); } catch (e2) {} }
                    }
                }
                bridge.expose('sandbox:write', () => 'guest');
                return true;`);
            await sandbox.page.waitForTimeout(300);
            expect(await hostView(sandbox)).toEqual({ files: [], writes: [], events: [] });
            expect(await inGuest(sandbox, `return outcome(() => sandboxFiles.write('real.txt', 'y'))`)).toEqual({ ok: true, value: null });
            expect(await hostView(sandbox)).toEqual({ files: [], writes: [{ path: 'real.txt', change: 'write', type: 'text/plain', size: 1 }], events: [['real.txt']] });
        });

        test("2. every refusal carries registerFiles()'s own code, by both routes, and changes nothing on either side", async ({ sandbox }) => {
            await sandbox.registerFiles({ 'kept.txt': 'kept' });
            expect(await sandbox.mount(writesOn(mode))).toBe('ready');
            const result = await inGuest(sandbox, `
                const paths = ['../x', '%2e%2e/x', '/x', 'a//b', 'a\\\\b', 'a/./b', '', 'x'.repeat(257), 'ü.txt', 7, null, {}, ['a.txt']];
                const entries = [5, null, true, { content: 'x' }, { content: 'x', type: 'not a type' }, { content: 5, type: 'text/plain' }, { a: 1 }];
                const both = (request, viaFiles) => Promise.all([outcome(viaFiles), outcome(() => bridge.call('sandbox:write', request))]);
                const r = { paths: [], removes: [], entries: [], requests: [] };
                for (const path of paths) {
                    r.paths.push(await both({ change: 'write', path, entry: 'x' }, () => sandboxFiles.write(path, 'x')));
                    r.removes.push(await both({ change: 'remove', path }, () => sandboxFiles.remove(path)));
                }
                for (const entry of entries) r.entries.push(await both({ change: 'write', path: 'e.txt', entry }, () => sandboxFiles.write('e.txt', entry)));
                for (const request of [null, 7, 'x', {}, { change: 'move', path: 'kept.txt' }, { change: 'WRITE', path: 'a.txt', entry: 'x' }]) {
                    r.requests.push(await outcome(() => bridge.call('sandbox:write', request)));
                }
                r.list = sandboxFiles.list();
                return r;`);
            const code = (c: string) => ({ code: c, isError: true, keys: ['code'] });
            for (const [i, pair] of result.paths.entries()) expect(pair, `write path #${i}`).toEqual([code('INVALID_PATH'), code('INVALID_PATH')]);
            for (const [i, pair] of result.removes.entries()) expect(pair, `remove path #${i}`).toEqual([code('INVALID_PATH'), code('INVALID_PATH')]);
            for (const [i, pair] of result.entries.entries()) expect(pair, `entry #${i}`).toEqual([code('INVALID_FILE'), code('INVALID_FILE')]);
            expect(result.requests).toEqual(new Array(6).fill(code('INVALID_FILE')));
            expect(result.list).toEqual(['kept.txt']);
            expect(await hostView(sandbox)).toEqual({ files: ['kept.txt'], writes: [], events: [] });
        });

        test('3. the cap is the store\'s: at the cap a write passes, one byte past it is FILES_QUOTA_EXCEEDED, a removal frees the space; the file count likewise', async ({ sandbox, page }) => {
            const PAD = 1000;
            await page.evaluate(({ size }) => (document.querySelector('web-sandbox') as any).registerFiles({ 'fill.bin': new Uint8Array(size) }), { size: MAX_TOTAL_BYTES - PAD });
            expect(await sandbox.mount(writesOn(mode))).toBe('ready');
            const bytes = await inGuest(sandbox, `return {
                under: await outcome(() => sandboxFiles.write('a.bin', new Uint8Array(${PAD - 1}))),
                atCap: await outcome(() => sandboxFiles.write('b.bin', new Uint8Array(1))),
                past: await outcome(() => sandboxFiles.write('c.bin', new Uint8Array(1))),
                replaceGrowing: await outcome(() => sandboxFiles.write('a.bin', new Uint8Array(${PAD}))),
                list: sandboxFiles.list(),
            }`);
            expect(bytes).toEqual({
                under: { ok: true, value: null }, atCap: { ok: true, value: null },
                past: { code: 'FILES_QUOTA_EXCEEDED', isError: true, keys: ['code'] },
                replaceGrowing: { code: 'FILES_QUOTA_EXCEEDED', isError: true, keys: ['code'] },
                list: ['a.bin', 'b.bin', 'fill.bin'],
            });
            expect((await hostView(sandbox)).writes.map((w: any) => [w.path, w.size])).toEqual([['a.bin', PAD - 1], ['b.bin', 1]]);
            // removing a stored file frees its whole size for the guest's next write
            const freed = await inGuest(sandbox, `return {
                remove: await outcome(() => sandboxFiles.remove('fill.bin')),
                big: await outcome(() => sandboxFiles.write('c.bin', new Uint8Array(${PAD}))),
                list: sandboxFiles.list(),
            }`);
            expect(freed).toEqual({ remove: { ok: true, value: null }, big: { ok: true, value: null }, list: ['a.bin', 'b.bin', 'c.bin'] });
            expect((await hostView(sandbox)).files).toEqual(['fill.bin']); // the store itself is untouched

            // the count: the store holds MAX_FILES - 1, the guest may add one file, not two; replacing one is fine
            await page.evaluate((n) => {
                const el = document.querySelector('web-sandbox') as any;
                el.unregisterFiles();
                const files: Record<string, string> = {};
                for (let i = 0; i < n; i++) files[`f/${i}.txt`] = '';
                el.registerFiles(files);
            }, MAX_FILES - 1);
            expect(await sandbox.reset()).toBe('ready');
            expect(await inGuest(sandbox, `return [
                await outcome(() => sandboxFiles.write('one.txt', '')),
                await outcome(() => sandboxFiles.write('two.txt', '')),
                await outcome(() => sandboxFiles.write('f/0.txt', 'replaced')),
            ]`)).toEqual([{ ok: true, value: null }, { code: 'FILES_QUOTA_EXCEEDED', isError: true, keys: ['code'] }, { ok: true, value: null }]);
        });

        test('3b. the byte rate: at most GUEST_WRITE_BYTES_PER_SECOND recorded per second, refused with FILES_BUSY (a replaced file does not grow the store, so only the rate refuses it)', async ({ sandbox }) => {
            expect(await sandbox.mount(writesOn(mode))).toBe('ready');
            const third = Math.floor(GUEST_WRITE_BYTES_PER_SECOND / 3) + 1;
            const r = await inGuest(sandbox, `
                const started = performance.now();
                const results = [];
                for (let i = 0; i < 3; i++) results.push(await outcome(() => sandboxFiles.write('big.bin', new Uint8Array(${third}))));
                return { results, elapsed: performance.now() - started };`, 30000);
            if (r.elapsed < 900) {
                expect(r.results).toEqual([{ ok: true, value: null }, { ok: true, value: null }, { code: 'FILES_BUSY', isError: true, keys: ['code'] }]);
                expect((await hostView(sandbox)).events).toEqual([['big.bin'], ['big.bin']]);
            } else {
                // a slow engine crossed into a new window: each recorded write still has its event
                expect(r.results.filter((x: any) => x.ok).length).toBe((await hostView(sandbox)).events.length);
            }
        });

        test('4. the guest reads its own acknowledged writes byte-exact, typed by the store (extension or override); url() of a written path is NOT_FOUND; content is copied when write() is called', async ({ sandbox }) => {
            await sandbox.registerFiles({ 'note.txt': 'registered' });
            expect(await sandbox.mount(writesOn(mode))).toBe('ready');
            const r = await inGuest(sandbox, `
                const all = Uint8Array.from({ length: 256 }, (_, i) => i);
                const mutable = all.slice();
                const pending = sandboxFiles.write('bytes.bin', mutable);
                mutable.fill(0); // after the call: changes nothing that was written
                const view = new DataView(all.buffer, 16, 4);
                const results = await Promise.all([
                    pending,
                    sandboxFiles.write('note.txt', 'héllo ✓'),
                    sandboxFiles.write('data.json', new Blob(['{"a":1}'], { type: 'text/html' })),
                    sandboxFiles.write('raw', { content: new Uint16Array([0x4241]), type: 'Text/Plain' }),
                    sandboxFiles.write('buffer.bin', all.buffer.slice(250)),
                    sandboxFiles.write('view.bin', view),
                ]);
                const read = async (p) => Array.from(await sandboxFiles.read(p));
                return {
                    results,
                    list: sandboxFiles.list(),
                    bytes: await read('bytes.bin'),
                    note: await sandboxFiles.text('note.txt'),
                    json: await sandboxFiles.text('data.json'),
                    raw: await read('raw'),
                    buffer: await read('buffer.bin'),
                    view: await read('view.bin'),
                    urls: await Promise.all(['bytes.bin', 'note.txt', 'raw'].map((p) => outcome(() => sandboxFiles.url(p)))),
                    copies: (await sandboxFiles.read('bytes.bin')) !== (await sandboxFiles.read('bytes.bin')),
                };`);
            const ALL = Array.from({ length: 256 }, (_, i) => i);
            expect(r.results).toEqual([null, null, null, null, null, null]);
            expect(r.list).toEqual(['buffer.bin', 'bytes.bin', 'data.json', 'note.txt', 'raw', 'view.bin']);
            expect(r.bytes).toEqual(ALL);
            expect(r.note).toBe('héllo ✓');
            expect(r.json).toBe('{"a":1}');
            expect(r.raw).toEqual([0x41, 0x42]);
            expect(r.buffer).toEqual([250, 251, 252, 253, 254, 255]);
            expect(r.view).toEqual([16, 17, 18, 19]);
            expect(r.urls).toEqual(new Array(3).fill({ code: 'NOT_FOUND', isError: true, keys: ['code'] }));
            expect(r.copies).toBe(true);
            // from outside: the host holds the same bytes, typed by the store (the Blob's own type is not used)
            expect((await hostView(sandbox)).writes).toEqual([
                { path: 'buffer.bin', change: 'write', type: 'application/octet-stream', size: 6 },
                { path: 'bytes.bin', change: 'write', type: 'application/octet-stream', size: 256 },
                { path: 'data.json', change: 'write', type: 'application/json', size: 7 },
                { path: 'note.txt', change: 'write', type: 'text/plain', size: Buffer.byteLength('héllo ✓') },
                { path: 'raw', change: 'write', type: 'text/plain', size: 2 },
                { path: 'view.bin', change: 'write', type: 'application/octet-stream', size: 4 },
            ]);
            expect(await contentOf(sandbox, 'bytes.bin')).toEqual(ALL);
            expect(await contentOf(sandbox, 'note.txt')).toEqual(Array.from(Buffer.from('héllo ✓')));
            expect((await hostView(sandbox)).files).toEqual(['note.txt']);
            // removing: a written path, a registered one, and one in neither (NOT_FOUND, nothing recorded)
            const removed = await inGuest(sandbox, `return {
                written: await outcome(() => sandboxFiles.remove('raw')),
                registered: await outcome(() => sandboxFiles.remove('note.txt')),
                again: await outcome(() => sandboxFiles.remove('note.txt')),
                missing: await outcome(() => sandboxFiles.remove('never.txt')),
                list: sandboxFiles.list(),
                read: await outcome(() => sandboxFiles.read('note.txt')),
            }`);
            const notFound = { code: 'NOT_FOUND', isError: true, keys: ['code'] };
            expect(removed).toEqual({ written: { ok: true, value: null }, registered: { ok: true, value: null }, again: notFound, missing: notFound, list: ['buffer.bin', 'bytes.bin', 'data.json', 'view.bin'], read: notFound });
            const after = await hostView(sandbox);
            expect(after.writes.map((w: any) => [w.path, w.change])).toEqual([['buffer.bin', 'write'], ['bytes.bin', 'write'], ['data.json', 'write'], ['note.txt', 'remove'], ['view.bin', 'write']]);
            expect(after.events.slice(-2)).toEqual([['raw'], ['note.txt']]); // the NOT_FOUND removals dispatched nothing
        });

        test('5. reset() discards the overlay; terminate() keeps it, a commit after it fires fileschanged, and the next build sees the committed file', async ({ sandbox, page }) => {
            expect(await sandbox.mount(writesOn(mode))).toBe('ready');
            await inGuest(sandbox, `await sandboxFiles.write('gone.txt', 'x'); return true;`);
            expect((await hostView(sandbox)).writes).toHaveLength(1);
            expect(await sandbox.reset()).toBe('ready');
            expect(await hostView(sandbox)).toMatchObject({ files: [], writes: [] });
            expect(await inGuest(sandbox, 'return sandboxFiles.list()')).toEqual([]);

            await inGuest(sandbox, `await sandboxFiles.write('pic.png', new Uint8Array(${JSON.stringify(PNG_3x5)})); await sandboxFiles.write('note.txt', 'kept'); return true;`);
            await page.evaluate(() => (document.querySelector('web-sandbox') as any).terminate());
            expect(await sandbox.state()).toBe('terminated');
            expect((await hostView(sandbox)).writes.map((w: any) => w.path)).toEqual(['note.txt', 'pic.png']);
            expect(await commit(sandbox, ['pic.png', 'note.txt'])).toEqual({ ok: true, changed: [['note.txt', 'pic.png']] });
            expect(await hostView(sandbox)).toMatchObject({ files: ['note.txt', 'pic.png'], writes: [] });
            expect(await sandbox.reset()).toBe('ready');
            const r = await inGuest(sandbox, `return {
                list: sandboxFiles.list(),
                text: await sandboxFiles.text('note.txt'),
                png: Array.from(await sandboxFiles.read('pic.png')).length,
                url: (() => { try { return sandboxFiles.url('pic.png').slice(0, 5); } catch (e) { return e.code; } })(),
                image: typeof Image === 'function' ? await new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i.naturalWidth + 'x' + i.naturalHeight); i.onerror = () => resolve('error'); i.src = sandboxFiles.url('pic.png'); }) : 'no Image here',
            }`);
            expect(r).toEqual({ list: ['note.txt', 'pic.png'], text: 'kept', png: PNG_3x5.length, url: 'blob:', image: mode === 'iframe' ? '3x5' : 'no Image here' });
        });

        test('6. a commit of a non-inert type needs { code: true }: JavaScript, HTML, SVG, XML, wasm, unknown and an override; the type is the store\'s, so a renamed file does not pass', async ({ sandbox }) => {
            expect(await sandbox.mount(writesOn(mode))).toBe('ready');
            await inGuest(sandbox, `
                await sandboxFiles.write('app.js', 'void 0');
                await sandboxFiles.write('page.html', '<p>x</p>');
                await sandboxFiles.write('icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
                await sandboxFiles.write('feed.xml', '<x/>');
                await sandboxFiles.write('mod.wasm', new Uint8Array([0, 97, 115, 109]));
                await sandboxFiles.write('blob.unknown', 'x');
                await sandboxFiles.write('noext', 'x');
                await sandboxFiles.write('fake.png', { content: '<svg xmlns="http://www.w3.org/2000/svg"/>', type: 'image/svg+xml' });
                await sandboxFiles.write('script.txt', { content: 'void 0', type: 'text/javascript' });
                await sandboxFiles.write('ok.txt', 'inert');
                return true;`);
            const nonInert = ['app.js', 'page.html', 'icon.svg', 'feed.xml', 'mod.wasm', 'blob.unknown', 'noext', 'fake.png', 'script.txt'];
            for (const path of nonInert) {
                expect(await commit(sandbox, [path]), path).toEqual({ code: 'FILES_NOT_ALLOWED', changed: [] });
                expect(await commit(sandbox, ['ok.txt', path], { code: 'yes' }), path).toEqual({ code: 'FILES_NOT_ALLOWED', changed: [] });
            }
            const before = await hostView(sandbox);
            expect(before.files).toEqual([]);
            expect(before.writes).toHaveLength(nonInert.length + 1);
            expect(await commit(sandbox, ['ok.txt'])).toEqual({ ok: true, changed: [['ok.txt']] });
            expect(await commit(sandbox, nonInert, { code: true })).toEqual({ ok: true, changed: [[...nonInert].sort()] });
            expect(await hostView(sandbox)).toMatchObject({ files: [...nonInert, 'ok.txt'].sort(), writes: [] });
            // a path with no pending change is skipped; a list is required, and every entry must be a valid path
            expect(await commit(sandbox, ['nothing.txt'])).toEqual({ ok: true, changed: [] });
            expect(await commit(sandbox, undefined)).toEqual({ code: 'INVALID_PATH', changed: [] });
            expect(await commit(sandbox, ['../x'])).toEqual({ code: 'INVALID_PATH', changed: [] });
        });

        test('7. a flood is refused with FILES_BUSY past GUEST_WRITES_PER_SECOND, and fileswritten stays bounded: one event per recorded write', async ({ sandbox }) => {
            expect(await sandbox.mount(writesOn(mode))).toBe('ready');
            const r = await inGuest(sandbox, `
                const started = performance.now();
                const results = await Promise.all(Array.from({ length: 250 }, (_, i) => outcome(() => sandboxFiles.write('f/' + i + '.txt', 'x'))));
                return { ok: results.filter((x) => x.ok).length, busy: results.filter((x) => x.code === 'FILES_BUSY').length, elapsed: performance.now() - started };`, 30000);
            expect(r.ok + r.busy).toBe(250);
            expect(r.busy).toBeGreaterThan(0);
            if (r.elapsed < 900) expect(r.ok).toBe(GUEST_WRITES_PER_SECOND); // every request arrived inside one window
            const host = await hostView(sandbox);
            expect(host.events).toHaveLength(r.ok);
            expect(host.writes).toHaveLength(r.ok);
        });

        test("7b. a listener that resets the sandbox in 'fileswritten' mid-flood is never undone: the next environment records nothing from the old one (Firefox delivers frames queued on a closed port)", async ({ sandbox, page }) => {
            expect(await sandbox.mount(writesOn(mode))).toBe('ready');
            await page.evaluate(() => {
                const el = document.querySelector('web-sandbox') as any;
                let seen = 0;
                const listener = () => {
                    if (++seen < 10) return;
                    el.removeEventListener('fileswritten', listener);
                    (window as any).resetAt = (window as any).sandboxWrites.length + 1;
                    el.reset();
                };
                el.addEventListener('fileswritten', listener);
            });
            const ready = page.evaluate(() => new Promise((resolve) => (document.querySelector('web-sandbox') as any).addEventListener('ready', () => resolve('ready'), { once: true })));
            await sandbox.run(`for (let i = 0; i < 200; i++) sandboxFiles.write('flood/' + i + '.txt', 'x').catch(() => {});`);
            expect(await ready).toBe('ready');
            await page.waitForTimeout(500); // anything still queued on the old port has arrived by now
            const host = await hostView(sandbox);
            expect(host.events).toHaveLength(10);
            expect(host.writes).toEqual([]);
            // positive control: the new environment records its own writes
            expect(await inGuest(sandbox, `return outcome(() => sandboxFiles.write('after.txt', 'y'))`)).toEqual({ ok: true, value: null });
            expect((await hostView(sandbox)).writes.map((w: any) => w.path)).toEqual(['after.txt']);
        });

        test('9b. two sandboxes keep their writes apart: each overlay, list and event belongs to its own element', async ({ sandbox, page }) => {
            expect(await sandbox.mount(writesOn(mode))).toBe('ready');
            expect(await sandbox.mountSecond(writesOn(mode))).toBe('ready');
            await inGuest(sandbox, `await sandboxFiles.write('main.txt', 'm'); return true;`);
            const second = await page.evaluate(() => ({
                writes: (document.getElementById('second') as any).listGuestWrites(),
                events: (window as any).sandboxWrites.map((e: any) => e.sandbox),
            }));
            expect(second).toEqual({ writes: [], events: ['main'] });
            expect((await hostView(sandbox)).writes.map((w: any) => w.path)).toEqual(['main.txt']);
        });
    });
}

test.describe('strict mode: the view and the overlay', () => {
    test('8. C1 holds with written files present: the worker mints no URL for them, the view renders none of their content (the path stays unresolved), while a registered file renders (positive control)', async ({ sandbox, page, browserName }) => {
        await sandbox.registerFiles({ 'registered.png': { base64: Buffer.from(PNG_3x5).toString('base64') } });
        expect(await sandbox.mount(writesOn('strict'))).toBe('ready');
        const r = await inGuest(sandbox, `
            await sandboxFiles.write('written.png', new Uint8Array(${JSON.stringify(PNG_3x5)}));
            await sandboxFiles.write('registered.png', new Uint8Array(${JSON.stringify(PNG_3x5)}));
            return {
                urls: await Promise.all(['written.png', 'registered.png'].map((p) => outcome(() => sandboxFiles.url(p)))),
                mint: typeof URL.createObjectURL,
            };`);
        expect(r).toEqual({ urls: new Array(2).fill({ code: 'NOT_FOUND', isError: true, keys: ['code'] }), mint: 'undefined' });
        await sandbox.run(`sandboxView.render('<img id="w" src="written.png"><img id="r" src="registered.png"><p id="done">done</p>')`);
        await waitInView(page, browserName, `!!document.getElementById('done') && document.getElementById('r').complete && document.getElementById('r').naturalWidth === 3`, 8000);
        const view = await inView<any>(page, browserName, `({
            written: document.getElementById('w').getAttribute('src'),
            writtenSize: document.getElementById('w').naturalWidth,
            registered: document.getElementById('r').getAttribute('src').slice(0, 5),
        })`);
        expect(view).toEqual({ written: 'written.png', writtenSize: 0, registered: 'blob:' });
    });

    test('5b. a committed image is a registered file at the next build: the view renders it from its own URL', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount(writesOn('strict'))).toBe('ready');
        await inGuest(sandbox, `await sandboxFiles.write('img/pic.png', new Uint8Array(${JSON.stringify(PNG_3x5)})); return true;`);
        expect(await commit(sandbox, ['img/pic.png'])).toEqual({ ok: true, changed: [['img/pic.png']] });
        expect(await sandbox.reset()).toBe('ready');
        await sandbox.run(`sandboxView.render('<img id="pic" src="img/pic.png"><p id="done">done</p>')`);
        expect(await waitInView(page, browserName, `document.getElementById('pic') && document.getElementById('pic').complete && document.getElementById('pic').naturalWidth + 'x' + document.getElementById('pic').naturalHeight`, 8000)).toBe('3x5');
    });
});

test.describe('9. writing adds no egress', () => {
    for (const mode of MODES) {
        test(`${mode} mode: written code never runs, so it reaches no listener; committed with { code: true } and loaded at the next build, the same file does (positive control)`, async ({ sandbox }) => {
            const policy = { origins: { connect: [recorder.allowed] } };
            expect(await sandbox.mount(writesOn(mode, policy))).toBe('ready');
            const source = `fetch('${recorder.allowed}/written-js').catch(() => {}); globalThis.__written = true;`;
            await inGuest(sandbox, `
                await sandboxFiles.write('run.js', ${JSON.stringify(source)});
                await sandboxFiles.write('page.html', '<img src="${recorder.allowed}/written-html.svg">');
                await sandboxFiles.write('style.css', 'body { background: url("${recorder.allowed}/written-css.svg"); }');
                return true;`);
            await sandbox.page.waitForTimeout(500);
            expect(recorder.paths('allowed')).toEqual([]);
            expect(recorder.paths('blocked')).toEqual([]);

            expect(await commit(sandbox, ['run.js'], { code: true })).toEqual({ ok: true, changed: [['run.js']] });
            if (mode === 'strict') {
                // strict mode runs a registered file only as the entry
                expect(await sandbox.mount(writesOn(mode, { ...policy, entry: 'run.js' }))).toBe('ready');
            } else {
                expect(await sandbox.reset()).toBe('ready');
                // loaded as a classic script: importScripts in a worker, a <script> element in a document
                expect(await inGuest(sandbox, `
                    const url = sandboxFiles.url('run.js');
                    if (typeof importScripts === 'function') importScripts(url);
                    else await new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = url; s.onload = resolve; s.onerror = reject; document.head.appendChild(s); });
                    return globalThis.__written === true;`)).toBe(true);
            }
            await recorder.waitFor('allowed', '/written-js');
            expect(recorder.paths('blocked')).toEqual([]);
        });
    }
});
