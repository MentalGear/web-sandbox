import { describe, it, expect, vi, afterEach } from 'vitest';
import { viewBootstrapHash, viewBootstrapText } from '@src/lib/in-sandbox-view';

/**
 * Strict mode on the host (ADR-005): the documents the element builds, read back from the wrapper's srcdoc.
 * Exact policy strings, the sandbox flags, the warnings, and that the view document carries nothing of the
 * guest's: no markup, no entry, no file, only the policy and the hashed bootstrap.
 */

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const wrapperOf = (el: HTMLElement) => el.shadowRoot!.querySelector('iframe')!;
const viewSourceOf = (el: HTMLElement) => parse(wrapperOf(el).srcdoc).querySelector('iframe')!.getAttribute('srcdoc')!;
const viewOf = (el: HTMLElement) => parse(viewSourceOf(el));
const policyOf = (el: HTMLElement) => viewOf(el).querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;

async function mount(config: Record<string, unknown>, files?: Record<string, string>) {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    if (files) el.registerFiles(files);
    document.body.appendChild(el);
    el.setConfig(config);
    return el;
}

const H = () => viewBootstrapHash();

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

// The strict template (csp-generator.ts, ADR-007) with `origins` filled in: every directive emitted, in its order.
const STRICT = (h: string, parts: { script?: string; style?: string; img?: string; font?: string; media?: string; connect?: string } = {}) =>
    `default-src 'none'; script-src ${h}${parts.script ?? ''}; script-src-attr 'none'; style-src 'unsafe-inline'${parts.style ?? ''}; `
    + `img-src ${parts.img ?? "'none'"}; font-src ${parts.font ?? "'none'"}; media-src ${parts.media ?? "'none'"}; connect-src ${parts.connect ?? "'none'"}; `
    + `worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'; upgrade-insecure-requests`;

describe('the strict view policy: exact strings', () => {
    it('default config', async () => {
        const el = await mount({ mode: 'strict' });
        expect(policyOf(el)).toBe(STRICT(H()));
    });

    it("scriptUnsafe adds 'unsafe-eval' and nothing else", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'strict', scriptUnsafe: true });
        expect(policyOf(el)).toBe(STRICT(H(), { script: " 'unsafe-eval'" }));
    });

    it("registered files: blob: for their types' kinds, never in script-src, even with JavaScript files; the configured origins are there", async () => {
        const el = await mount({ mode: 'strict', origins: { connect: ['https://api.example'], fonts: ['https://fonts.example'] } },
            { 'app.js': 'void 0', 'lib/mod.mjs': 'export {}', 'img/logo.png': 'x', 'site.css': 'p{}' });
        expect(policyOf(el)).toBe(STRICT(H(), { style: ' blob:', img: 'blob:', font: 'https://fonts.example', connect: 'https://api.example blob:' }));
        expect(policyOf(el)).not.toMatch(/script-src[^;]*blob:/);
    });

    it('broad review ST1: a file of a type the view mints no URL for (SVG, HTML, XML, any +xml) adds blob: only to connect-src (the worker reads it), and is not given to the view', async () => {
        const el = await mount({ mode: 'strict' }, { 'img/logo.svg': '<svg/>', 'page.html': '<p>', 'data.xml': '<x/>' });
        expect(policyOf(el)).toBe(STRICT(H(), { connect: 'blob:' }));
        if (el._strictInit) expect(el._strictInit.viewFiles).toEqual([]);
    });

    it('broad review ST1: data: cannot be configured for any kind (ADR-007): dropped with one warning each, the kind stays as listed', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'strict', origins: { images: ['data:', 'https://img.example'], fonts: ['data:'], media: ['DATA:'] } });
        expect(policyOf(el)).toBe(STRICT(H(), { img: 'https://img.example' }));
        expect(policyOf(el)).not.toMatch(/data:/i);
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => /origins\.\w+ entry "data:"/i.test(m))).toHaveLength(3);
    });

    it("scripts are dropped with one warning per instance (across reset); the policy never shows them; nothing else can be configured", async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'strict', origins: { scripts: ['https://cdn.example'], images: ["'self'", 'https://img.example'] } });
        el.reset();
        el.setConfig({ mode: 'strict', origins: { scripts: ['https://cdn.example'] } });
        expect(policyOf(el)).toBe(STRICT(H()));
        const messages = warn.mock.calls.map(c => String(c[0]));
        expect(messages.filter(m => m.includes('origins.scripts is not used in strict mode'))).toHaveLength(1);
        expect(messages.filter(m => m.includes("'self'"))).toHaveLength(1);
    });

    it('the shipping defaults raise no strict-mode warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await mount({ mode: 'strict' });
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('strict mode'))).toEqual([]);
    });
});

describe('the strict documents', () => {
    it('the view document holds the policy, the referrer policy and the one hashed bootstrap — no guest markup, entry or file', async () => {
        const el = await mount({ mode: 'strict', entry: 'main.js', html: '<p id="GUEST-MARKUP-7f3">guest</p>' }, { 'main.js': 'console.log("GUEST-ENTRY-7f3")', 'notes.txt': 'GUEST-FILE-7f3' });
        const wrapper = wrapperOf(el).srcdoc;
        expect(wrapper).not.toMatch(/GUEST-(MARKUP|ENTRY|FILE)-7f3|R1VFU1Q/); // nor their base64
        const view = viewOf(el);
        expect(Array.from(view.head.children).map(e => e.localName)).toEqual(['meta', 'meta', 'script']);
        expect(view.querySelector('meta[name="referrer"]')!.getAttribute('content')).toBe('no-referrer');
        expect(view.body.innerHTML).toBe('');
        expect(view.querySelector('script')!.textContent).toBe(viewBootstrapText());
    });

    it('sandbox flags: allow-scripts allow-forms plus the safe capabilities, on both frames; unsafe capabilities dropped with one warning, no allow attribute', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'strict', capabilities: ['allow-pointer-lock'], unsafeCapabilities: ['allow-popups', 'allow-modals', 'fullscreen'] });
        el.reset();
        const wrapper = wrapperOf(el);
        const inner = parse(wrapper.srcdoc).querySelector('iframe')!;
        expect([wrapper.getAttribute('sandbox'), inner.getAttribute('sandbox')]).toEqual(['allow-scripts allow-forms allow-pointer-lock', 'allow-scripts allow-forms allow-pointer-lock']);
        expect([wrapper.getAttribute('allow'), inner.getAttribute('allow'), wrapper.hasAttribute('allowfullscreen')]).toEqual([null, null, false]);
        const messages = warn.mock.calls.map(c => String(c[0]));
        expect(messages.filter(m => m.includes('not available in strict mode'))).toEqual(['[Sandbox] unsafeCapabilities are not available in strict mode and were dropped: allow-popups, allow-modals, fullscreen.']);
        expect(messages.filter(m => m.includes('is enabled: it lets guest content act outside'))).toEqual([]);
        expect(await mount({ mode: 'strict' }).then(e => wrapperOf(e).getAttribute('sandbox'))).toBe('allow-scripts allow-forms');
    });

    it('"entry" outside strict mode is ignored with one warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'cooperative', entry: 'main.js' });
        el.reset();
        el.setConfig({ mode: 'worker', entry: 'main.js' });
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('"entry"'))).toHaveLength(1);
    });
});

describe('review C2: the worker source runs the entry in its own scope, after the scope check', () => {
    it('scope check first, then the prelude, then the entry inside (function () { … }).call(this), then the marker', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'strict', entry: 'main.js' }, { 'main.js': 'function Worker() {} var x = 1;' });
        const source: string = el._strictInit?.workerSource ?? el._getStrictWorkerSource([], 'function Worker() {} var x = 1;');
        expect(source.startsWith('(function (g) {(function assertEntryScoped(')).toBe(true);
        expect(source).toMatch(/\}\)\(this\);\n\(function \(\) \{\nfunction Worker\(\) \{\} var x = 1;\n\}\)\.call\(this\);\n__sandboxEntryRan_[0-9a-f]{32}\(\);\n$/);
    });

    it('broad review ST4: the marker the line after the entry calls has a name drawn per build, which the prelude defines', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'strict' });
        const names = new Set<string>();
        for (let i = 0; i < 20; i++) {
            const source: string = el._getStrictWorkerSource([], 'void 0');
            const marker = /\n(__sandboxEntryRan_[0-9a-f]{32})\(\);\n$/.exec(source)![1]!;
            expect(source).toContain(`"entryDoneName":"${marker}"`);
            names.add(marker);
        }
        expect(names.size).toBe(20);
    });
});

describe('guest writes in strict mode (backlog C5): the worker carries the writer, the view never sees the overlay', () => {
    const sourceOf = (el: any): string => el._strictInit?.workerSource ?? el._getStrictWorkerSource(el._files.snapshot(), '');

    it("with guestWrites: the prelude hands sandboxFiles the comms script's captured write call, and still removes URL.createObjectURL before the entry", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'strict', guestWrites: true, entry: 'main.js' }, { 'main.js': 'void 0', 'a.png': 'x' });
        const source = sourceOf(el);
        expect(source).toContain('"guestWrites":true');
        expect(source).toMatch(/\}\)\(\[\[[^\n]*\]\], comms\.writeFiles\);\(function inStrictWorker\(/);
        const removal = source.search(/remove\(g\.URL, ['"]createObjectURL['"]\)/);
        expect(removal).toBeGreaterThan(0);
        expect(removal).toBeLessThan(source.indexOf('(function () {\nvoid 0\n}).call(this);'));
        expect(el._guestWrites).not.toBeNull();
        // the view gets the snapshot's non-JavaScript files and nothing else: the overlay never reaches it
        if (el._strictInit) expect(el._strictInit.viewFiles.map((f: any) => f[0])).toEqual(['a.png']);
    });

    it('without guestWrites (or with anything but a literal true): no writer, no feature, no overlay', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const guestWrites of [undefined, 'true', 1]) {
            const el = await mount({ mode: 'strict', guestWrites });
            const source = sourceOf(el);
            expect(source).not.toContain('"guestWrites":true');
            expect(source).not.toContain('comms.writeFiles');
            expect(el._guestWrites).toBeNull();
            el.remove();
        }
    });
});
