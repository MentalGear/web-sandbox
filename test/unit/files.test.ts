import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildGuestDocument, buildWrapperDocument, escapeAttribute, toInlineScriptLiteral } from '@src/lib/frame-documents';
import { inSandboxScript } from '@src/lib/in-sandbox-script';
import { inSandboxFiles, inSandboxImportMap, inSandboxMarkup } from '@src/lib/in-sandbox-files';
import { rewriteMarkupReferences } from '@src/lib/markup-references';
import { mimeTypeFor } from '@src/lib/files';
import { createBroker } from '@src/lib/rpc';
import { workerBootstrap } from '@src/lib/worker-bootstrap';
import { keepOnlyWorkerGlobals, WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS } from '@src/lib/worker-globals';

// The files a build can name, typed by extension as the store types them.
const typesOf = (paths: string[]) => new Map(paths.map(path => [path, mimeTypeFor(path)]));

/**
 * Files on the element (ADR-004), as far as the host's own output shows them: what goes into the
 * guest document and its policy. The guest side runs in test/e2e/files.spec.ts.
 */

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

// The guest document's security block as the element writes it: the policy, the DNS-prefetch switch (broad review
// PD3), then the bootstrap. Returns the head's children without the switch, after checking it is the second one.
const DNS_PREFETCH_OFF = '<meta http-equiv="x-dns-prefetch-control" content="off">';
const securityChildren = (doc: Document): Element[] => {
    const children = [...doc.head.children];
    expect(children[1]?.outerHTML).toBe(DNS_PREFETCH_OFF);
    return [children[0]!, ...children.slice(2)];
};

// The wrapper's srcdoc holds the guest frame, whose srcdoc is the guest document.
const wrapperOf = (el: HTMLElement) => el.shadowRoot!.querySelector('iframe')!.srcdoc;
const guestDocumentOf = (el: HTMLElement) => parse(wrapperOf(el)).querySelector('iframe')!.getAttribute('srcdoc')!;
const policyOf = (el: HTMLElement) => parse(guestDocumentOf(el)).querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
const directive = (policy: string, name: string) => policy.split(';').map(d => d.trim()).find(d => d === name || d.startsWith(name + ' '));

async function mount(config?: Record<string, unknown>, files?: Record<string, unknown>) {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    if (files) el.registerFiles(files);
    document.body.appendChild(el);
    if (config) el.setConfig(config);
    return el;
}

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

// The guest policy for the shipped default, and with scriptUnsafe, with no files (the cooperative template, ADR-007). Pinned literally.
const DEFAULT_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'; upgrade-insecure-requests";
const UNSAFE_POLICY = DEFAULT_POLICY.replace("script-src 'unsafe-inline'", "script-src 'unsafe-inline' 'unsafe-eval'");

describe('with no files: the policy is unchanged, and the document differs only by the empty files bootstrap', () => {
    // How 98f9c81 composed the bootstrap, before files existed, and the one thing added since.
    const comms = (scriptUnsafe: boolean, mode: string) => `(${inSandboxScript.toString()})(${scriptUnsafe}, '${mode}', console, ${createBroker.toString()});`;
    const EMPTY_FILES = `(${inSandboxFiles.toString()})([]);`;

    it('cooperative mode, default config', async () => {
        const el = await mount();
        expect(policyOf(el)).toBe(DEFAULT_POLICY);
        // blob: only where 98f9c81 had it: worker-src
        expect(policyOf(el).split(';').map(d => d.trim()).filter(d => d.includes('blob:'))).toEqual(['worker-src blob:']);
        const guest = buildGuestDocument({ csp: DEFAULT_POLICY, bootstrapScript: comms(false, 'cooperative') + EMPTY_FILES, content: '<div id="root"></div>' });
        expect(wrapperOf(el)).toBe(buildWrapperDocument(guest, ''));
    });

    it('worker mode: the empty bootstrap goes into the worker source', async () => {
        const el = await mount({ mode: 'worker', scriptUnsafe: true });
        expect(policyOf(el)).toBe(UNSAFE_POLICY);
        // the worker keeps only the allowlisted globals first (independent verification V1), then the comms script and files
        const globals = `(${keepOnlyWorkerGlobals.toString()})(this, ${toInlineScriptLiteral(WORKER_GLOBALS)}, ${toInlineScriptLiteral(WORKER_NAVIGATOR_MEMBERS)});`;
        const bootstrap = `(${workerBootstrap.toString()})(${JSON.stringify(globals + comms(true, 'worker') + EMPTY_FILES).replaceAll('<', '\\u003c')});`;
        expect(wrapperOf(el)).toBe(buildWrapperDocument(buildGuestDocument({ csp: UNSAFE_POLICY, bootstrapScript: bootstrap, content: '' }), 'allow-scripts'));
    });

    it('registering and then unregistering every file gives the same document as never registering one', async () => {
        const config = { capabilities: ['allow-scripts'], html: '<p>same</p>' };
        const never = await mount(config);
        const both = await mount(config, { 'a.js': 'x', 'b.css': 'y' });
        expect(wrapperOf(both)).not.toBe(wrapperOf(never));
        both.unregisterFiles();
        both.reset();
        expect(wrapperOf(both)).toBe(wrapperOf(never));
    });
});

describe('with files, the policy admits blob: only for the registered types', () => {
    it('one JavaScript file: script-src and connect-src gain blob:, nothing else changes', async () => {
        const el = await mount(undefined, { 'main.js': 'void 0' });
        expect(policyOf(el)).toBe(DEFAULT_POLICY.replace("script-src 'unsafe-inline'", "script-src 'unsafe-inline' blob:").replace("connect-src 'none'", 'connect-src blob:'));
    });

    it('every type family maps to its own directive; base-uri and form-action stay none', async () => {
        const el = await mount(undefined, {
            'a.css': '', 'b.svg': '', 'c.woff2': new Uint8Array(1), 'd.mp3': new Uint8Array(1), 'e.json': '{}',
        });
        const policy = policyOf(el);
        expect(directive(policy, 'script-src')).toBe("script-src 'unsafe-inline'");
        expect(directive(policy, 'style-src')).toBe("style-src 'unsafe-inline' blob:");
        expect(directive(policy, 'img-src')).toBe('img-src blob:');
        expect(directive(policy, 'font-src')).toBe('font-src blob:');
        expect(directive(policy, 'media-src')).toBe('media-src blob:');
        expect(directive(policy, 'connect-src')).toBe('connect-src blob:');
        expect(directive(policy, 'base-uri')).toBe("base-uri 'none'");
        expect(directive(policy, 'form-action')).toBe("form-action 'none'");
        expect(directive(policy, 'default-src')).toBe("default-src 'none'");
    });

    it("the configured origins and blob: share a kind's directive: origins first, blob: last; no 'self' ever", async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ scriptUnsafe: true, origins: { scripts: ["'self'", 'https://cdn.example'], images: ['https://img.example'] } }, { 'a.js': '', 'b.png': new Uint8Array(1) });
        const policy = policyOf(el);
        expect(policy.toLowerCase()).not.toContain("'self'");
        expect(directive(policy, 'script-src')).toBe("script-src 'unsafe-inline' https://cdn.example blob: 'unsafe-eval'");
        expect(directive(policy, 'img-src')).toBe('img-src https://img.example blob:');
        expect(directive(policy, 'default-src')).toBe("default-src 'none'");
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes("'self'"))).toHaveLength(1);
    });
});

describe('the guest document', () => {
    const HOSTILE_CONTENT = [
        '<html><body><!-- <head> --></body></html>',
        '<!-- <html><head> --><html><head></head><body></body></html>',
        '<html><head><img src=x><!--</head><body></body></html>',
        '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>',
        '<head><base href="https://evil.example/"></head>',
        '<script>/*',
        '<plaintext>',
        '</script><script>sandboxFiles = null</script>',
    ];

    const CASES = HOSTILE_CONTENT.flatMap(html => [[html, 'with files'], [html, 'without files']] as const);
    it.each(CASES)('keeps the CSP meta first and the file bootstrap in the security block for %j (%s)', async (html, which) => {
        const files = which === 'with files' ? { 'x.js': '</script><script>alert(1)</script>', 'y.css': '<!--' } : undefined;
        const el = await mount({ capabilities: ['allow-scripts'], html }, files);
        const doc = parse(guestDocumentOf(el));
        const [meta, script] = securityChildren(doc);
        expect(meta?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
        expect(meta?.getAttribute('content')).toContain('script-src');
        expect(script?.tagName).toBe('SCRIPT');
        expect(script?.textContent).toContain(inSandboxFiles.toString());
        // file contents travel as base64 inside the one literal: they can never close the script
        expect(script?.textContent).not.toContain('</script');
    });

    it('carries exactly one literal: the snapshot, sorted, as [path, type, base64]', async () => {
        const el = await mount(undefined, { 'b.txt': 'B', 'a/x.svg': '<svg/>', 'c.bin': new Uint8Array([0, 255]) });
        const script = parse(guestDocumentOf(el)).head.querySelector('script')!.textContent!;
        const call = `(${inSandboxFiles.toString()})(`;
        expect(script.split(call)).toHaveLength(2);
        const literal = script.slice(script.indexOf(call) + call.length, -2);
        expect(JSON.parse(literal)).toEqual([
            ['a/x.svg', 'image/svg+xml', btoa('<svg/>')],
            ['b.txt', 'text/plain', btoa('B')],
            ['c.bin', 'application/octet-stream', btoa('\u0000ÿ')],
        ]);
    });

    it('worker mode puts the same literal into the worker source, not into the frame', async () => {
        const el = await mount({ mode: 'worker' }, { 'w.js': 'self.ok = 1' });
        const frameScript = parse(guestDocumentOf(el)).head.querySelector('script')!.textContent!;
        expect(frameScript.startsWith(`(${workerBootstrap.toString()})(`)).toBe(true);
        const workerSource: string = JSON.parse(frameScript.slice(`(${workerBootstrap.toString()})(`.length, -2));
        expect(workerSource).toContain(`(${inSandboxFiles.toString()})(${JSON.stringify([['w.js', 'text/javascript', btoa('self.ok = 1')]])});`);
        expect(directive(policyOf(el), 'script-src')).toBe("script-src 'unsafe-inline' blob:");
    });

    it('contains no host identifier: no session id, no host origin, no base element', async () => {
        const el = await mount({ capabilities: ['allow-scripts'] }, { 'a.js': '' });
        const guest = guestDocumentOf(el);
        expect(parse(guest).querySelector('base')).toBeNull();
        expect(guest).not.toContain(location.origin);
        expect(guest).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    });
});

describe('files are part of the environment', () => {
    it('registerFiles changes nothing in the running frame; the next build snapshots the store', async () => {
        const el = await mount(undefined, { 'a.js': '1' });
        const before = wrapperOf(el);
        const frame = el.shadowRoot.querySelector('iframe');
        el.registerFiles({ 'b.js': '2' });
        el.unregisterFiles(['a.js']);
        expect(el.shadowRoot.querySelector('iframe')).toBe(frame);
        expect(wrapperOf(el)).toBe(before);

        el.reset();
        expect(wrapperOf(el)).not.toBe(before);
        expect(guestDocumentOf(el)).toContain(JSON.stringify([['b.js', 'text/javascript', btoa('2')]]));
    });

    it('the store survives terminate(), load() and setConfig()', async () => {
        const el = await mount(undefined, { 'a.js': '1' });
        el.terminate('test');
        el.load('<p>x</p>');
        el.setConfig({ capabilities: ['allow-scripts'] });
        expect(el.listFiles()).toEqual([{ path: 'a.js', type: 'text/javascript', size: 1 }]);
        expect(guestDocumentOf(el)).toContain(inSandboxFiles.toString());
    });

    it("fires 'fileschanged' synchronously, once per call that changed something, with { paths }", async () => {
        const el = await mount();
        const seen: unknown[] = [];
        el.addEventListener('fileschanged', (e: CustomEvent) => seen.push(e.detail));
        el.registerFiles({ 'b.js': '1', 'a.js': '1' });
        expect(seen).toEqual([{ paths: ['a.js', 'b.js'] }]);
        el.registerFiles({ 'a.js': '1' }); // identical
        el.unregisterFiles(['missing.js']);
        expect(() => el.registerFiles({ '../x.js': '' })).toThrow();
        expect(seen).toHaveLength(1);
        el.unregisterFiles();
        expect(seen).toEqual([{ paths: ['a.js', 'b.js'] }, { paths: ['a.js', 'b.js'] }]);
    });

    it('a refused batch throws an Error with its code and leaves store and event silent', async () => {
        const el = await mount(undefined, { 'keep.js': '' });
        let events = 0;
        el.addEventListener('fileschanged', () => events++);
        let caught: any;
        try { el.registerFiles({ 'ok.js': '', 'a/../b.js': '' }); } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(Error);
        expect({ code: caught.code, keys: Object.keys(caught) }).toEqual({ code: 'INVALID_PATH', keys: ['code'] });
        expect(el.listFiles().map((f: any) => f.path)).toEqual(['keep.js']);
        expect(events).toBe(0);
    });
});

describe('virtualFilesUrl is gone', () => {
    it('is dropped from the config with one warning per instance, and changes nothing in the document', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const plain = await mount({ capabilities: ['allow-scripts'] });
        const el = await mount({ capabilities: ['allow-scripts'], virtualFilesUrl: 'http://virtual-files.localhost:4444' });
        el.setConfig({ capabilities: ['allow-scripts'], virtualFilesUrl: '/src/virtual-files' });
        expect(wrapperOf(el)).toBe(wrapperOf(plain));
        expect(document.querySelectorAll('iframe')).toHaveLength(0); // no hub frame in the host page
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('virtualFilesUrl'))).toHaveLength(1);
    });
});

describe('markup references (PR2): guest markup that names a registered file is written by the bootstrap', () => {
    const SCRIPTS = { capabilities: ['allow-scripts'] };
    const NONCE = '0123456789abcdef0123456789abcdef';
    const FILES = { 'logo.svg': '<svg/>', 'app.js': 'void 0', 'img/x.svg': '<svg/>' };
    const snapshotLiteral = (el: any) => toInlineScriptLiteral(el._files.snapshot());
    // FILES has one JavaScript file, so the bootstrap also registers the import map (module graph, PR3)
    const filesStep = (el: any) => `(${inSandboxImportMap.toString()})((${inSandboxFiles.toString()})(${snapshotLiteral(el)}), ["app.js"], null)`;
    const comms = (mode = 'cooperative') => `(${inSandboxScript.toString()})(false, '${mode}', console, ${createBroker.toString()});`;
    const bootstrapScriptOf = (el: HTMLElement) => parse(guestDocumentOf(el)).head.querySelector('script')!.textContent!;

    it.each([
        ['markup without references', '<p>no files named</p><img src="https://cdn.example/x.png">'],
        ['references to unregistered files', '<img src="missing.svg"><script src="other.js"></script><link rel="stylesheet" href="x.css">'],
        ['references spelled differently', '<img src="LOGO.SVG"><img src="logo.svg?v=1"><img src="logo.svg#f"><img src="%6Cogo.svg"><img srcset="logo.svg?v=1 1x, LOGO.SVG 2x">'],
        ['CSS that names no file', '<style>@import "missing.css"; p { background: url(logo.svg#f) } /* url(logo.svg) */ q::after { content: "logo.svg" }</style><p style="background: url(\'logo.svg?x\')">p</p>'],
        ['a reference inside <template>', '<template><img src="logo.svg"></template>'],
    ])('no match (%s): the guest document is byte for byte the one built without the rewrite', async (_, html) => {
        const el = await mount({ ...SCRIPTS, html }, FILES);
        const guest = buildGuestDocument({ csp: policyOf(el), bootstrapScript: comms() + `${filesStep(el)};`, content: html });
        expect(wrapperOf(el)).toBe(buildWrapperDocument(guest, 'allow-scripts'));
        expect(guestDocumentOf(el)).not.toContain(inSandboxMarkup.toString());
    });

    it('a match: the document ends with the bootstrap, whose last statement writes the parts with the URLs inSandboxFiles returns', async () => {
        const html = '<h1>t</h1><img src="logo.svg"><script src="./app.js"></script><img src="/img/x.svg"><img src="missing.svg">';
        const el = await mount({ ...SCRIPTS, html }, FILES);
        const parts = rewriteMarkupReferences(html, typesOf(Object.keys(FILES)), NONCE)!;
        expect(parts.filter((_, i) => i % 2 === 1)).toEqual(['logo.svg', 'app.js', 'img/x.svg']);
        const bootstrap = comms() + `(${inSandboxMarkup.toString()})(${filesStep(el)}, ${toInlineScriptLiteral(parts)});`;
        expect(guestDocumentOf(el)).toBe(`<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policyOf(el))}">${DNS_PREFETCH_OFF}<script>${bootstrap}</script>`);
        expect(wrapperOf(el)).toBe(buildWrapperDocument(guestDocumentOf(el), 'allow-scripts'));
    });

    it('load() rewrites the new markup; the default markup and worker mode never rewrite', async () => {
        const el = await mount(SCRIPTS, FILES);
        expect(guestDocumentOf(el)).toContain('<div id="root"></div>');
        el.load('<img src="logo.svg">');
        expect(bootstrapScriptOf(el)).toContain(inSandboxMarkup.toString());
        const worker = await mount({ mode: 'worker', html: '<img src="logo.svg">' }, FILES);
        expect(guestDocumentOf(worker)).not.toContain('inSandboxMarkup');
        expect(guestDocumentOf(worker)).not.toContain('document.write');
    });

    it.each([
        ['scripts are not allowed (no allow-scripts)', { capabilities: [] }],
    ])('the markup stays as written when the bootstrap cannot run: %s', async (_, config) => {
        const html = '<img src="logo.svg">';
        const el = await mount({ ...config, html }, FILES);
        expect(guestDocumentOf(el)).not.toContain(inSandboxMarkup.toString());
        expect(guestDocumentOf(el).endsWith(`</script></head>${html}`)).toBe(true);
    });

    it('draws a fresh 128-bit nonce for every build that rewrites, and none for a build that does not', async () => {
        const el = await mount({ ...SCRIPTS, html: '<p>none</p>' }, FILES);
        const spy = vi.spyOn(crypto, 'getRandomValues');
        el.reset();
        expect(spy).not.toHaveBeenCalled();
        el.load('<img src="logo.svg">');
        el.reset();
        const nonces = spy.mock.results.map(result => Array.from(result.value as Uint8Array).join(','));
        expect(spy.mock.calls.map(call => (call[0] as Uint8Array).length)).toEqual([16, 16]);
        expect(new Set(nonces).size).toBe(2);
    });

    // S2 with matched references: the policy must stay the first thing the guest parser sees, and nothing
    // in the markup may end the bootstrap script early or come before it.
    const HOSTILE_WITH_REFERENCE = [
        '<img src="logo.svg"><script>/*',
        '<img src="logo.svg"><plaintext>',
        '<img src="logo.svg"><!--',
        '<img src="logo.svg" title="</script><script>sandboxFiles = null</script>">',
        '<img src="logo.svg"></script><script>alert(1)</script>',
        '<img src="logo.svg"><textarea><head></textarea>',
        '<img src="logo.svg"></head></html><head>',
        '<html><head><img src=logo.svg><!--</head><body></body></html>',
        '<!-- <html><head> --><html><head><script src="app.js"></script></head><body></body></html>',
        '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><link rel="icon" href="logo.svg"></head></html>',
        '<head><base href="https://evil.example/"></head><img src="logo.svg">',
        '<img src="logo.svg" alt="   vfs-slot-0123456789abcdef0123456789abcdef-0">',
        '<svg><style><img src="logo.svg"></style></svg><img src="logo.svg">',
        '<noscript><img src="logo.svg"></noscript><img src="logo.svg">',
    ];
    it.each(HOSTILE_WITH_REFERENCE)('keeps the CSP meta first and the bootstrap intact for %j, before and after the write', async (html) => {
        const el = await mount({ ...SCRIPTS, html }, FILES);
        const guest = guestDocumentOf(el);
        const doc = parse(guest);
        const [meta, script, ...rest] = securityChildren(doc);
        expect(meta?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
        expect(meta?.getAttribute('content')).toBe(policyOf(el));
        expect(script?.textContent).toContain(inSandboxMarkup.toString());
        expect(rest).toEqual([]);
        expect(doc.body.childNodes).toHaveLength(0); // all guest markup is inside the bootstrap's literal
        // the markup travels inside a JS string literal that cannot contain "<": it cannot close the script
        expect(script!.textContent).not.toContain('</script');
        expect(script!.textContent).not.toContain('<!--');

        // what the guest parser sees after the write: the written markup follows the bootstrap script
        // (any nonce but the host's gives the host's parts; the corpus forges NONCE, which the host never draws)
        const parts = rewriteMarkupReferences(html, typesOf(Object.keys(FILES)), 'f'.repeat(32))!;
        expect(script!.textContent!.endsWith(`, ${toInlineScriptLiteral(parts)});`)).toBe(true);
        const written = parse(guest + parts.map((part, i) => (i % 2 === 0 ? part : `blob:null/${i}`)).join(''));
        const [writtenMeta, writtenScript] = securityChildren(written);
        expect(writtenMeta?.getAttribute('content')).toBe(policyOf(el));
        expect(writtenScript?.textContent).toBe(script!.textContent);
        expect(written.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')[0]).toBe(writtenMeta);
    });
});

describe('module graph (PR3): one import map, registered by the bootstrap, only with JavaScript files', () => {
    const SCRIPTS = { capabilities: ['allow-scripts'] };
    const comms = (mode = 'cooperative') => `(${inSandboxScript.toString()})(false, '${mode}', console, ${createBroker.toString()});`;
    const filesCall = (el: any) => `(${inSandboxFiles.toString()})(${toInlineScriptLiteral(el._files.snapshot())})`;
    const mapCall = (el: any, paths: string[], guest: string | null) => `(${inSandboxImportMap.toString()})(${filesCall(el)}, ${toInlineScriptLiteral(paths)}, ${toInlineScriptLiteral(guest)})`;
    const bootstrapScriptOf = (el: HTMLElement) => parse(guestDocumentOf(el)).head.querySelector('script')!.textContent!;
    // the arguments of the bootstrap's last call: [files step, parts]
    const writtenParts = (el: HTMLElement): string[] => {
        const script = bootstrapScriptOf(el);
        return JSON.parse(script.slice(script.lastIndexOf(', [') + 2, -2));
    };
    const GUEST_MAP = '<script type="importmap">{"imports":{"lodash":"https://cdn.example/lodash.js","https://vfs.invalid/app.js":"https://attacker.test/x.js"}}</script>';

    it('no JavaScript file: no import map, and a guest import map stays in the markup as written (as before)', async () => {
        const html = `${GUEST_MAP}<p>x</p>`;
        const el = await mount({ ...SCRIPTS, html }, { 'style.css': 'p {}', 'data.json': '{}' });
        const guest = buildGuestDocument({ csp: policyOf(el), bootstrapScript: comms() + `${filesCall(el)};`, content: html });
        expect(guestDocumentOf(el)).toBe(guest);
        expect(guestDocumentOf(el)).not.toContain('inSandboxImportMap');
    });

    it('no file at all: a guest import map stays in the markup as written', async () => {
        const html = `${GUEST_MAP}<script type="module">import './app.js';</script>`;
        const el = await mount({ ...SCRIPTS, html });
        expect(guestDocumentOf(el).endsWith(`</script></head>${html}`)).toBe(true);
        expect(guestDocumentOf(el)).not.toContain('inSandboxImportMap');
    });

    it('with JavaScript files: the import map step names every JavaScript file (by type, sorted) and nothing else; markup with nothing to change stays embedded as written', async () => {
        const html = '<p>no modules here</p>';
        const el = await mount({ ...SCRIPTS, html }, {
            'b.js': "import './a.mjs';", 'a.mjs': 'export {}', 'x.txt': { content: 'import "./a.mjs"', type: 'application/javascript' }, 'style.css': '', 'n.js': { content: '', type: 'text/plain' },
        });
        const guest = buildGuestDocument({ csp: policyOf(el), bootstrapScript: comms() + `${mapCall(el, ['a.mjs', 'b.js', 'x.txt'], null)};`, content: html });
        expect(guestDocumentOf(el)).toBe(guest);
    });

    it("a guest inline import map is taken out of the markup and merged by the host: ours win on the virtual origin, with one warning per element", async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const html = `${GUEST_MAP}<script type="module">import { a } from './app.js';</script>`;
        const el = await mount({ ...SCRIPTS, html }, { 'app.js': 'export const a = 1;' });
        el.reset();
        const guestMap = JSON.stringify({ imports: { lodash: 'https://cdn.example/lodash.js' } });
        expect(bootstrapScriptOf(el)).toContain(`${mapCall(el, ['app.js'], guestMap)}, `);
        const written = writtenParts(el);
        expect(written).toHaveLength(1); // no slot: only the inline module changed
        const doc = parse(written[0]!);
        expect(doc.querySelectorAll('script[type=importmap]')).toHaveLength(0);
        expect(doc.querySelector('script[type=module]')!.textContent).toBe(`import { a } from "https://vfs.invalid/app.js";`);
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('import map entries'))).toHaveLength(1);
    });

    it('an invalid guest import map is left out (taken out of the markup, not merged), with one warning per element across rebuilds', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ ...SCRIPTS, html: '<script type="importmap">{ nope</script><p>x</p>' }, { 'app.js': '' });
        el.reset();
        el.reset();
        expect(bootstrapScriptOf(el)).toContain(`${mapCall(el, ['app.js'], null)}, `);
        expect(writtenParts(el).join('')).not.toContain('importmap');
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('not a valid import map'))).toHaveLength(1);
    });

    it('an inline module the lexer cannot parse is left as written, with one warning per element across rebuilds', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const html = `<script type="module">import {</script>`;
        const el = await mount({ ...SCRIPTS, html }, { 'app.js': '' });
        el.reset();
        expect(guestDocumentOf(el).endsWith(`</script></head>${html}`)).toBe(true);
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('inline module script #1'))).toHaveLength(1);
    });

    it.each([
        ['scripts are not allowed (no allow-scripts)', { capabilities: [] }],
    ])('no import map and no change to the markup when the bootstrap cannot run: %s (modules then fail closed)', async (_, config) => {
        const html = `${GUEST_MAP}<script type="module">import './app.js';</script>`;
        const el = await mount({ ...config, html }, { 'app.js': '' });
        expect(guestDocumentOf(el)).not.toContain('inSandboxImportMap');
        expect(guestDocumentOf(el).endsWith(`</script></head>${html}`)).toBe(true);
    });

    it('worker mode: no import map (import maps do not apply to workers); the snapshot still carries the rewrite', async () => {
        const el = await mount({ mode: 'worker', html: '<script type="module">import "./a.js"</script>' }, { 'm.js': "import './a.js';" });
        const frameScript = parse(guestDocumentOf(el)).head.querySelector('script')!.textContent!;
        const workerSource: string = JSON.parse(frameScript.slice(`(${workerBootstrap.toString()})(`.length, -2));
        expect(workerSource).not.toContain('importmap');
        expect(workerSource).toContain(`${filesCall(el)};`);
        expect(el._files.snapshot()[0]).toHaveLength(4);
    });

    // S2 with the module graph: guest import maps, inline modules and file paths are data; none of
    // them may end the bootstrap script early or come before the policy.
    const HOSTILE_MODULE_MARKUP = [
        '<script type="importmap">{"imports":{"</script><script>alert(1)</script>":"<!--"}}</script>',
        '<script type="importmap">{"imports":{"x":"</script><plaintext>"}}</script><script type="module">import "./app.js"</script>',
        '<script type="module">import "./app.js"; "</scr" + "ipt><script>alert(1)</script>"</script>',
        '<script type="module">import "./<!--app.js"; import "./app.js"</script>',
        '<script type="importmap"></script></head><script type="importmap">{"imports":{}}</script><plaintext>',
        '<!-- <script type="importmap"> --><script type="module">import "/app.js"</script>',
        '<script type="importmap">{"imports":{"a":"b"}}</script><img src="logo.svg"><script>/*',
    ];
    it.each(HOSTILE_MODULE_MARKUP)('keeps the CSP meta first and the bootstrap intact for %j', async (html) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ ...SCRIPTS, html }, { 'app.js': "import './<script>.js'; export {}", 'logo.svg': '<svg/>' });
        const guest = guestDocumentOf(el);
        const doc = parse(guest);
        const [meta, script, ...rest] = securityChildren(doc);
        expect(meta?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
        expect(meta?.getAttribute('content')).toBe(policyOf(el));
        expect(script?.textContent).toContain(inSandboxImportMap.toString());
        expect(script!.textContent).not.toContain('</script');
        expect(script!.textContent).not.toContain('<!--');
        if (script!.textContent!.includes(inSandboxMarkup.toString())) {
            // written by the bootstrap: all guest markup is inside its literal
            expect(rest).toEqual([]);
            expect(doc.body.childNodes).toHaveLength(0);
            expect(guest.endsWith('</script>')).toBe(true);
        } else {
            // nothing to change (the lexer failed, or a specifier holds '<'): embedded as written, after the security block
            expect(guest.endsWith(`</script></head>${html}`)).toBe(true);
        }
    });
});

describe('CSS references and srcset (PR4)', () => {
    const SCRIPTS = { capabilities: ['allow-scripts'] };
    const FILES = { 'logo.svg': '<svg/>', 'style.css': '@import "base.css"; a { b: url(logo.svg) }', 'base.css': 'p { color: red }' };
    const bootstrapScriptOf = (el: HTMLElement) => parse(guestDocumentOf(el)).head.querySelector('script')!.textContent!;

    it('the snapshot literal carries each stylesheet after the files it names, with its slots; the policy is what the file types alone give', async () => {
        const el = await mount({ ...SCRIPTS, html: '<p>x</p>' }, FILES);
        const snapshot = el._files.snapshot();
        expect(snapshot.map((entry: unknown[]) => entry[0])).toEqual(['base.css', 'logo.svg', 'style.css']);
        expect(snapshot[2][3].filter((_: unknown, i: number) => i % 3 === 2)).toEqual([['base.css'], ['logo.svg']]);
        expect(bootstrapScriptOf(el)).toContain(`(${inSandboxFiles.toString()})(${toInlineScriptLiteral(snapshot)})`);
        // the same types without any reference between them: the same policy
        const plain = await mount({ ...SCRIPTS, html: '<p>x</p>' }, { 'logo.svg': '<svg/>', 'style.css': 'a {}', 'base.css': 'p {}' });
        expect(policyOf(el)).toBe(policyOf(plain));
        expect(directive(policyOf(el), 'style-src')).toBe("style-src 'unsafe-inline' blob:");
        expect(directive(policyOf(el), 'img-src')).toBe('img-src blob:');
    });

    it('a reference cycle among stylesheets warns once per element, across rebuilds', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount(SCRIPTS, { 'a.css': '@import "b.css";', 'b.css': '@import "a.css";' });
        el.reset();
        el.load('<p>y</p>');
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('reference each other in a cycle'))).toHaveLength(1);
    });

    it('inline <style>, style="" and srcset that name files are written by the bootstrap with CSS and attribute slots', async () => {
        const html = '<style>p { background: url(logo.svg) }</style><p style="background: url(logo.svg)">x</p><img srcset="logo.svg 1x">';
        const el = await mount({ ...SCRIPTS, html }, FILES);
        const parts = rewriteMarkupReferences(html, typesOf(Object.keys(FILES)), 'f'.repeat(32))!;
        expect(parts.filter((_, i) => i % 2 === 1)).toEqual([['logo.svg', 'css'], ['logo.svg', 'css-attribute'], 'logo.svg']);
        expect(bootstrapScriptOf(el).endsWith(`(${inSandboxMarkup.toString()})((${inSandboxFiles.toString()})(${toInlineScriptLiteral(el._files.snapshot())}), ${toInlineScriptLiteral(parts)});`)).toBe(true);
    });

    // S2 with CSS slots: the markup, the CSS around a slot and the stylesheet bytes are data; none of them
    // may end the bootstrap script early or come before the policy.
    const HOSTILE_CSS_MARKUP = [
        '<style>p { background: url(logo.svg) }</style><script>/*',
        '<style>p { background: url(logo.svg) }</style><plaintext>',
        '<style>p { background: url(logo.svg) } /* </style><script>alert(1)</script> */</style>',
        '<style>@import "style.css";</style><!--',
        '<p style="background: url(logo.svg)" title="</script><script>alert(1)</script>">x</p>',
        '<p style="background: url(&quot;logo.svg&quot;)" title="<!--">x</p>',
        '<img srcset="logo.svg 1x, </script><script>alert(1)</script> 2x">',
        '<img srcset="logo.svg 1x" alt="vfs-slot-0123456789abcdef0123456789abcdef-0">',
        '<style>a { b: url("vfs-slot-0123456789abcdef0123456789abcdef-0") } c { d: url(logo.svg) }</style>',
        '<svg><style>a{fill:url(logo.svg)}</style></svg><style>a{b:url(logo.svg)}</style>',
        '<noscript><style>a{b:url(logo.svg)}</style></noscript><img srcset="logo.svg">',
        '<textarea><style>a{b:url(logo.svg)}</style></textarea><p style="b:url(logo.svg)">',
    ];
    it.each(HOSTILE_CSS_MARKUP)('keeps the CSP meta first and the bootstrap intact for %j, before and after the write', async (html) => {
        const el = await mount({ ...SCRIPTS, html }, { ...FILES, 'evil.css': '</script><script>alert(1)</script><!-- a { b: url(logo.svg) }' });
        const guest = guestDocumentOf(el);
        const doc = parse(guest);
        const [meta, script, ...rest] = securityChildren(doc);
        expect(meta?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
        expect(meta?.getAttribute('content')).toBe(policyOf(el));
        expect(script?.textContent).toContain(inSandboxMarkup.toString());
        expect(rest).toEqual([]);
        expect(doc.body.childNodes).toHaveLength(0);
        expect(script!.textContent).not.toContain('</script');
        expect(script!.textContent).not.toContain('<!--');

        // what the guest parser sees after the write, with each slot filled as the bootstrap fills it
        const parts = rewriteMarkupReferences(html, typesOf([...Object.keys(FILES), 'evil.css']), 'f'.repeat(32))!;
        expect(script!.textContent!.endsWith(`, ${toInlineScriptLiteral(parts)});`)).toBe(true);
        const filled = parts.map((part, i) => (i % 2 === 0 ? part : `blob:null/${i}`)).join('');
        const written = parse(guest + filled);
        const [writtenMeta, writtenScript] = securityChildren(written);
        expect(writtenMeta?.getAttribute('content')).toBe(policyOf(el));
        expect(writtenScript?.textContent).toBe(script!.textContent);
        expect(written.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')[0]).toBe(writtenMeta);
    });
});
