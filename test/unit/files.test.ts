import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildGuestDocument, buildWrapperDocument } from '@src/lib/frame-documents';
import { inSandboxScript } from '@src/lib/in-sandbox-script';
import { inSandboxFiles } from '@src/lib/in-sandbox-files';
import { createBroker } from '@src/lib/rpc';
import { workerBootstrap } from '@src/lib/worker-bootstrap';

/**
 * Files on the element (ADR-004), as far as the host's own output shows them: what goes into the
 * guest document and its policy. The guest side runs in test/e2e/files.spec.ts.
 */

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

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

// The guest policy for the shipped default, and with scriptUnsafe, before files existed. Pinned literally.
const DEFAULT_POLICY = "default-src 'none'; upgrade-insecure-requests; script-src 'unsafe-inline'; base-uri 'none'; style-src 'unsafe-inline'; form-action 'none'; worker-src blob: data:;";
const UNSAFE_POLICY = "default-src 'none'; upgrade-insecure-requests; script-src 'unsafe-inline' 'unsafe-eval'; base-uri 'none'; style-src 'unsafe-inline'; form-action 'none'; worker-src blob: data:;";

describe('with no files: the policy is unchanged, and the document differs only by the empty files bootstrap', () => {
    // How 98f9c81 composed the bootstrap, before files existed, and the one thing added since.
    const comms = (scriptUnsafe: boolean, mode: string) => `(${inSandboxScript.toString()})(${scriptUnsafe}, '${mode}', console, ${createBroker.toString()});`;
    const EMPTY_FILES = `(${inSandboxFiles.toString()})([]);`;

    it('iframe mode, default config', async () => {
        const el = await mount();
        expect(policyOf(el)).toBe(DEFAULT_POLICY);
        // blob: only where 98f9c81 had it: worker-src
        expect(policyOf(el).split(';').map(d => d.trim()).filter(d => d.includes('blob:'))).toEqual(['worker-src blob: data:']);
        const guest = buildGuestDocument({ csp: DEFAULT_POLICY, bootstrapScript: comms(false, 'iframe') + EMPTY_FILES, content: '<div id="root"></div>' });
        expect(wrapperOf(el)).toBe(buildWrapperDocument(guest, ''));
    });

    it('worker mode: the empty bootstrap goes into the worker source', async () => {
        const el = await mount({ mode: 'worker', scriptUnsafe: true });
        expect(policyOf(el)).toBe(UNSAFE_POLICY);
        const bootstrap = `(${workerBootstrap.toString()})(${JSON.stringify(comms(true, 'worker') + EMPTY_FILES).replaceAll('<', '\\u003c')});`;
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
        expect(policyOf(el)).toBe("default-src 'none'; upgrade-insecure-requests; script-src 'unsafe-inline' blob:; connect-src blob:; base-uri 'none'; style-src 'unsafe-inline'; form-action 'none'; worker-src blob: data:;");
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

    it("never contains 'self', even when default-src carries it into a file directive; the S14 drop still runs last", async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ scriptUnsafe: true, connectionsAllowed: { 'default-src': ["'self'", 'https://cdn.example'], 'script-src': ["'self'"], 'img-src': [] } }, { 'a.js': '', 'b.png': new Uint8Array(1) });
        const policy = policyOf(el);
        expect(policy.toLowerCase()).not.toContain("'self'");
        expect(directive(policy, 'script-src')).toBe("script-src blob: 'unsafe-eval'");
        expect(directive(policy, 'img-src')).toBe('img-src https://cdn.example blob:');
        expect(directive(policy, 'default-src')).toBe('default-src https://cdn.example');
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes("'self'"))).toHaveLength(2); // default-src and script-src
    });

    it("keeps an explicit 'none' and warns once per directive across rebuilds", async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ connectionsAllowed: { 'img-src': ["'none'"] } }, { 'a.png': new Uint8Array(1) });
        el.reset();
        el.reset();
        expect(directive(policyOf(el), 'img-src')).toBe("img-src 'none'");
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('img-src') && m.includes('will not load'))).toHaveLength(1);
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
        const [meta, script] = [...doc.head.children];
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
