import { describe, it, expect, vi, afterEach } from 'vitest';
import { SAFE_CAPABILITIES, UNSAFE_CAPABILITIES, UNSAFE_SANDBOX_FLAGS } from '@src/csp-directives';

/**
 * The owner's decisions on open findings, each reproduced here first where library logic decides: R1:R2-2 (`allow-forms`
 * is an unsafe capability in cooperative mode) and R1:R4-4 (the strict view shows raster-image guest writes); R1:R4-5 is
 * test/unit/view-api.test.ts.
 * The browser's side of each is test/e2e/allow-forms-and-view-writes.spec.ts, on all three engines.
 */

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const wrapperOf = (el: HTMLElement) => el.shadowRoot!.querySelector('iframe')!;
const flagsOf = (el: HTMLElement) => {
    const wrapper = wrapperOf(el);
    return [wrapper.getAttribute('sandbox'), parse(wrapper.srcdoc).querySelector('iframe')!.getAttribute('sandbox')];
};

async function mount(config: Record<string, unknown>) {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    el.setConfig(config);
    return el;
}

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('R2-2: allow-forms is an unsafe capability (cooperative and worker mode); strict mode always has it', () => {
    const warnings = () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        return () => warn.mock.calls.map(call => String(call[0]));
    };

    it('the lists: allow-forms is an unsafe sandbox flag, not a safe capability', () => {
        expect(SAFE_CAPABILITIES as readonly string[]).not.toContain('allow-forms');
        expect(UNSAFE_CAPABILITIES as readonly string[]).toContain('allow-forms');
        expect(UNSAFE_SANDBOX_FLAGS as readonly string[]).toContain('allow-forms');
    });

    it("cooperative mode: capabilities: ['allow-forms'] is dropped with a warning that names unsafeCapabilities; no frame gets the flag", async () => {
        const messages = warnings();
        const el = await mount({ mode: 'cooperative', capabilities: ['allow-scripts', 'allow-forms'] });
        expect(flagsOf(el)).toEqual(['allow-scripts', 'allow-scripts']);
        const dropped = messages().filter(message => message.includes('"allow-forms" is not allowed in "capabilities"'));
        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toContain('unsafeCapabilities');
    });

    it("cooperative mode: unsafeCapabilities: ['allow-forms'] is accepted on both frames, with the one unsafe-capability warning", async () => {
        const messages = warnings();
        const el = await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], unsafeCapabilities: ['allow-forms'] });
        el.reset();
        expect(flagsOf(el)).toEqual(['allow-scripts allow-forms', 'allow-scripts allow-forms']);
        expect(messages().filter(message => message.includes('"allow-forms"'))).toEqual(['[Sandbox] unsafe capability "allow-forms" is enabled: it lets guest content act outside the sandbox.']);
    });

    it("worker mode: the same lists (unsafeCapabilities: ['allow-forms'] accepted with the warning)", async () => {
        const messages = warnings();
        const el = await mount({ mode: 'worker', unsafeCapabilities: ['allow-forms'] });
        expect(flagsOf(el)).toEqual(['allow-forms allow-scripts', 'allow-forms allow-scripts']);
        expect(messages().filter(message => message.includes('"allow-forms"'))).toEqual(['[Sandbox] unsafe capability "allow-forms" is enabled: it lets guest content act outside the sandbox.']);
    });

    it("strict mode is unchanged: its view always has allow-scripts allow-forms; capabilities: ['allow-forms'] is that and warns nothing; unsafeCapabilities are dropped as before", async () => {
        const messages = warnings();
        expect(flagsOf(await mount({ mode: 'strict' }))).toEqual(['allow-scripts allow-forms', 'allow-scripts allow-forms']);
        expect(flagsOf(await mount({ mode: 'strict', capabilities: ['allow-forms', 'allow-pointer-lock'] }))).toEqual(['allow-scripts allow-forms allow-pointer-lock', 'allow-scripts allow-forms allow-pointer-lock']);
        expect(flagsOf(await mount({ capabilities: ['allow-forms'] }))).toEqual(['allow-scripts allow-forms', 'allow-scripts allow-forms']); // no mode: strict
        expect(messages().filter(message => message.includes('allow-forms'))).toEqual([]);
        expect(flagsOf(await mount({ mode: 'strict', unsafeCapabilities: ['allow-forms'] }))).toEqual(['allow-scripts allow-forms', 'allow-scripts allow-forms']);
        expect(messages().filter(message => message.includes('allow-forms'))).toEqual(['[Sandbox] unsafeCapabilities are not available in strict mode and were dropped: allow-forms.']);
    });
});

describe('R4-4: the strict view shows raster-image guest writes, minted by the view from the bytes the host holds', () => {
    it('the one set of types: VIEW_FILE_TYPES ∩ the raster image types, exactly PNG, JPEG, GIF, WebP and AVIF; never SVG; each inert and an image to the view', async () => {
        const { RASTER_IMAGE_TYPES, VIEW_FILE_TYPES, VIEW_LOAD_KINDS, VIEW_OPTIONS, VIEW_WRITE_TYPES } = await import('@src/lib/in-sandbox-view');
        const { INERT_TYPES } = await import('@src/lib/guest-writes');
        expect([...VIEW_WRITE_TYPES]).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
        expect(VIEW_WRITE_TYPES).toEqual((VIEW_FILE_TYPES as readonly string[]).filter(type => (RASTER_IMAGE_TYPES as readonly string[]).includes(type)));
        expect(VIEW_WRITE_TYPES).not.toContain('image/svg+xml');
        for (const type of VIEW_WRITE_TYPES) {
            expect(INERT_TYPES.has(type), type).toBe(true);
            expect(VIEW_LOAD_KINDS.image!.types, type).toContain(type);
            for (const kind of ['style', 'font', 'media', 'track']) expect(VIEW_LOAD_KINDS[kind]!.types, `${kind} ${type}`).not.toContain(type);
        }
        expect(VIEW_OPTIONS.writeTypes).toBe(VIEW_WRITE_TYPES); // the view reads the same constant
    });

    it("the view's policy admits blob: images when guestWrites is on (the view may mint them), and only images; off, it stays as the files make it", async () => {
        const policyOf = (el: HTMLElement) => parse(parse(wrapperOf(el).srcdoc).querySelector('iframe')!.getAttribute('srcdoc')!).querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
        const on = policyOf(await mount({ mode: 'strict', guestWrites: true }));
        const off = policyOf(await mount({ mode: 'strict' }));
        expect(on).toContain('img-src blob:;');
        expect(on.replace('img-src blob:;', "img-src 'none';")).toBe(off);
        expect(policyOf(await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], guestWrites: true }))).toContain("img-src 'none';"); // nothing mints there
    });

    describe('the host: every recorded change goes to the view, with the bytes only for those types; the guest is answered once the view has it', () => {
        const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
        const settle = () => new Promise(resolve => setTimeout(resolve, 0));
        // The element's two ports of a strict environment (jsdom never loads the frame): the logic port the guest's
        // sandbox:write requests arrive on, and a view port that records what the host posts to the view.
        function connect(el: any) {
            const { port1 } = new MessageChannel();
            el._port = port1;
            const posted: { frame: any; transfer: Transferable[] }[] = [];
            const view = { postMessage: (frame: any, transfer: Transferable[] = []) => posted.push({ frame, transfer }), close() {} };
            el._viewPort = view;
            const answers: any[] = [];
            let id = 0;
            const send = (request: unknown) => el._onGuestMessage(port1, (frame: unknown) => answers.push(frame), { type: 'RPC_REQ', id: ++id, method: 'sandbox:write', args: [request] }, null);
            const written = (n: number) => el._onViewMessage(view, { type: 'VIEW_WRITTEN', id: n });
            return { posted, answers, send, written, close: () => port1.close() };
        }

        it('a PNG: one VIEW_WRITE with a copy of the bytes, its buffer transferred; the answer waits for VIEW_WRITTEN', async () => {
            const el = await mount({ mode: 'strict', guestWrites: true });
            const { posted, answers, send, written, close } = connect(el);
            send({ change: 'write', path: 'gen/chart.png', entry: PNG });
            await settle();
            expect(posted).toHaveLength(1);
            const { frame, transfer } = posted[0]!;
            expect(frame).toEqual({ type: 'VIEW_WRITE', id: expect.any(Number), path: 'gen/chart.png', mime: 'image/png', bytes: PNG });
            expect(transfer).toEqual([frame.bytes.buffer]);
            expect(el.listGuestWrites()[0].content).toEqual(PNG); // the overlay keeps its own bytes
            expect(answers).toEqual([]);
            written(frame.id + 1); // not this write's
            await settle();
            expect(answers).toEqual([]);
            written(frame.id);
            await settle();
            expect(answers).toEqual([{ type: 'RPC_RES', id: 1, ok: true, value: { path: 'gen/chart.png', change: 'write', type: 'image/png', size: PNG.length } }]);
            close();
        });

        it('SVG, HTML, JavaScript and a type override that is no raster type: the view is told the path, never the bytes; a removal likewise', async () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const el = await mount({ mode: 'strict', guestWrites: true });
            const { posted, send, written, close } = connect(el);
            const requests = [
                { change: 'write', path: 'a.svg', entry: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
                { change: 'write', path: 'b.html', entry: '<p>' },
                { change: 'write', path: 'c.js', entry: 'void 0' },
                { change: 'write', path: 'd.png', entry: { content: PNG, type: 'image/svg+xml' } },
                { change: 'write', path: 'e.png', entry: PNG },
                { change: 'remove', path: 'e.png' },
            ];
            for (const request of requests) {
                send(request);
                await settle();
                written(posted[posted.length - 1]!.frame.id);
            }
            expect(posted.map(p => [p.frame.path, p.frame.mime, p.frame.bytes === null ? null : 'bytes', p.transfer.length])).toEqual([
                ['a.svg', 'image/svg+xml', null, 0],
                ['b.html', 'text/html', null, 0],
                ['c.js', 'text/javascript', null, 0],
                ['d.png', 'image/svg+xml', null, 0],
                ['e.png', 'image/png', 'bytes', 1],
                ['e.png', null, null, 0],
            ]);
            close();
        });

        it('cooperative mode has no view: nothing is posted and the guest is answered at once; a refused write posts nothing', async () => {
            const el = await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], guestWrites: true });
            const { answers, send, close } = connect(el);
            el._viewPort = null;
            send({ change: 'write', path: 'p.png', entry: PNG });
            await settle();
            expect(answers[0]).toMatchObject({ ok: true });
            close();

            const strict = await mount({ mode: 'strict', guestWrites: true });
            const s = connect(strict);
            s.send({ change: 'write', path: '../p.png', entry: PNG });
            await settle();
            expect(s.posted).toEqual([]);
            expect(s.answers[0]).toMatchObject({ ok: false, code: 'INVALID_PATH' });
            s.close();
        });

        it('a teardown before the view answered ends the wait: the write stays recorded and is never answered as shown', async () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const el = await mount({ mode: 'strict', guestWrites: true });
            const { posted, answers, send, written } = connect(el);
            send({ change: 'write', path: 'p.png', entry: PNG });
            await settle();
            expect(posted).toHaveLength(1);
            el.terminate();
            written(posted[0]!.frame.id);
            await settle();
            expect(answers.filter(a => a.ok === true)).toEqual([]);
            expect(el._viewWrites.size).toBe(0);
            expect(el.listGuestWrites().map((w: any) => w.path)).toEqual(['p.png']);
        });
    });

    describe('the view: it mints only for those types, replaces and revokes, and the renderer resolves the path like a registered file', () => {
        const originalWorker = (globalThis as any).Worker;
        let created: string[] = [];
        let revoked: string[] = [];
        afterEach(() => {
            (globalThis as any).Worker = originalWorker;
            delete (globalThis as any).__sandboxViewRuns;
            document.body.replaceChildren();
        });

        // The bootstrap in this document with a fake Worker and the object URLs jsdom lacks; `files` are registered files.
        const startView = async (files: [string, string, string][] = []) => {
            const { viewBootstrapText } = await import('@src/lib/in-sandbox-view');
            created = [];
            revoked = [];
            let next = 0;
            // the worker's own source (text/javascript) is not counted: only what the view mints for files and writes
            vi.spyOn(URL, 'createObjectURL').mockImplementation(((blob: Blob) => { const url = `blob:view/${++next}#${blob.type}`; if (blob.type !== 'text/javascript') created.push(url); return url; }) as typeof URL.createObjectURL);
            vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => { if (!url.endsWith('#text/javascript')) revoked.push(url); });
            const workers: MessagePort[][] = [];
            (globalThis as any).Worker = class {
                onerror: unknown = null;
                postMessage(_message: unknown, transfer: MessagePort[]) { workers.push(transfer); }
            };
            new Function(viewBootstrapText())();
            const logic = new MessageChannel(), view = new MessageChannel();
            window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: files, html: '' }, source: window, ports: [logic.port1, view.port1] }));
            const render = workers[0]![1]!;
            const acks: unknown[] = [];
            render.onmessage = (event) => { if (event.data.type === 'VIEW_ACK') acks.push(event.data); };
            render.postMessage({ type: 'VIEW_STARTED' });
            const host = view.port2;
            const fromView: any[] = [];
            host.onmessage = (event) => fromView.push(event.data);
            let id = 0;
            const write = async (path: string, mime: string | null, bytes: Uint8Array | null) => {
                const n = ++id;
                host.postMessage({ type: 'VIEW_WRITE', id: n, path, mime, bytes });
                await until(() => fromView.some(m => m.type === 'VIEW_WRITTEN' && m.id === n));
            };
            const renderHtml = async (html: string) => {
                const before = acks.length;
                render.postMessage({ type: 'VIEW_RENDER', html, into: null });
                await until(() => acks.length > before);
            };
            return { write, renderHtml };
        };
        const until = async (check: () => boolean) => {
            for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
            expect(check()).toBe(true);
        };
        const src = (id: string) => document.getElementById(id)!.getAttribute('src');
        const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

        it('a PNG write is minted and an <img> names it by path; video, audio, a stylesheet link and a track do not resolve it', async () => {
            const { write, renderHtml } = await startView();
            await write('gen/chart.png', 'image/png', PNG);
            expect(created).toEqual([expect.stringMatching(/^blob:view\/\d+#image\/png$/)]);
            await renderHtml('<img id="i" src="gen/chart.png"><img id="r" src="./gen/chart.png"><video id="v" src="gen/chart.png"></video><audio id="a" src="gen/chart.png"></audio><link id="l" rel="stylesheet" href="gen/chart.png"><video><track id="t" src="gen/chart.png"></video>');
            expect([src('i'), src('r'), src('v'), src('a'), document.getElementById('l'), src('t')]).toEqual([created[0], created[0], 'gen/chart.png', 'gen/chart.png', null, 'gen/chart.png']);
        });

        it('every raster type is minted; SVG, HTML, JavaScript, CSS, a type the host never sends, missing bytes: nothing is minted and the path names nothing', async () => {
            const { write, renderHtml } = await startView();
            for (const [i, type] of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].entries()) await write(`ok${i}`, type, PNG);
            for (const [i, type] of ['image/svg+xml', 'text/html', 'text/javascript', 'text/css', 'image/bmp', 'image/x-icon', 'application/octet-stream', 'IMAGE/PNG'].entries()) await write(`no${i}`, type, PNG);
            await write('nobytes.png', 'image/png', null);
            await write('notbytes.png', 'image/png', 'iVBOR' as any);
            expect(created).toHaveLength(5);
            await renderHtml(Array.from({ length: 8 }, (_, i) => `<img id="n${i}" src="no${i}">`).join('') + '<img id="nb" src="nobytes.png"><img id="ns" src="notbytes.png">');
            for (let i = 0; i < 8; i++) expect(src(`n${i}`)).toBe(`no${i}`);
            expect([src('nb'), src('ns')]).toEqual(['nobytes.png', 'notbytes.png']);
        });

        it('a later write to the path replaces the URL and revokes the old one; a removal revokes it; a registered file the guest replaced or removed names nothing after that', async () => {
            const { write, renderHtml } = await startView([['logo.png', 'image/png', 'iVBORw==']]);
            const registered = created[0]!;
            await write('gen/chart.png', 'image/png', PNG);
            await write('gen/chart.png', 'image/webp', PNG);
            expect(revoked).toEqual([created[1]]);
            await renderHtml('<img id="a" src="gen/chart.png"><img id="b" src="logo.png">');
            expect([src('a'), src('b')]).toEqual([created[2], registered]);
            await write('gen/chart.png', null, null);
            expect(revoked).toEqual([created[1], created[2]]);
            await write('logo.png', 'image/png', PNG);
            await renderHtml('<img id="a" src="gen/chart.png"><img id="b" src="logo.png">');
            expect([src('a'), src('b')]).toEqual(['gen/chart.png', created[3]]);
            await write('logo.png', 'text/plain', null);
            await renderHtml('<img id="b" src="logo.png"><img id="c" src="' + created[3] + '">');
            expect(revoked).toEqual([created[1], created[2], created[3]]);
            expect([src('b'), document.getElementById('c')!.hasAttribute('src')]).toEqual(['logo.png', false]); // a revoked URL is not the view's (AR:A8)
        });
    });
});
