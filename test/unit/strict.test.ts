import { describe, it, expect, vi, afterEach } from 'vitest';
import { viewBootstrapHash, viewBootstrapText } from '@src/lib/in-sandbox-view';
import { strictPolicyOverrides, strictViewDirectives, STRICT_FIXED, STRICT_PASSED_THROUGH } from '@src/lib/csp/strict-policy';
import { generateCSP } from '@src/lib/csp/csp-generator';

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

describe('the strict view policy: exact strings', () => {
    it('default config', async () => {
        const el = await mount({ mode: 'strict' });
        expect(policyOf(el)).toBe(`default-src 'none'; script-src ${H()}; script-src-attr 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; upgrade-insecure-requests;`);
    });

    it("scriptUnsafe adds 'unsafe-eval' and nothing else", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'strict', scriptUnsafe: true });
        expect(policyOf(el)).toBe(`default-src 'none'; script-src ${H()} 'unsafe-eval'; script-src-attr 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; upgrade-insecure-requests;`);
    });

    it('registered files: blob: for their types\' directives, never in script-src, even with JavaScript files; embedder fetch directives pass through', async () => {
        const el = await mount({ mode: 'strict', connectionsAllowed: { 'connect-src': ['https://api.example'], 'font-src': ['https://fonts.example'] } },
            { 'app.js': 'void 0', 'lib/mod.mjs': 'export {}', 'img/logo.svg': '<svg/>', 'site.css': 'p{}' });
        expect(policyOf(el)).toBe(`default-src 'none'; script-src ${H()}; script-src-attr 'none'; style-src 'unsafe-inline' blob:; base-uri 'none'; form-action 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; upgrade-insecure-requests; connect-src https://api.example blob:; img-src blob:; font-src https://fonts.example;`);
        expect(policyOf(el)).not.toMatch(/script-src[^;]*blob:/);
    });

    it('fixed directives are replaced and unknown ones dropped, each with one warning per instance (across reset); the policy never shows them', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'strict', connectionsAllowed: {
            'script-src': ["'unsafe-inline'", 'https://cdn.example', 'blob:'],
            'worker-src': ['data:', 'https://w.example'],
            'frame-src': ['https://frames.example'],
            'object-src': ['*'], 'base-uri': ['https://b.example'], 'form-action': ['https://f.example'],
            'script-src-elem': ['*'], 'child-src': ['*'],
            'img-src': ["'self'", 'https://img.example'],
        } });
        el.reset();
        el.setConfig({ mode: 'strict', connectionsAllowed: { 'script-src': ['https://cdn.example'] } });
        const policy = policyOf(el);
        expect(policy).toBe(`default-src 'none'; script-src ${H()}; script-src-attr 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; upgrade-insecure-requests;`);
        const messages = warn.mock.calls.map(c => String(c[0]));
        for (const name of ['script-src', 'worker-src', 'frame-src', 'object-src', 'base-uri', 'form-action']) {
            expect(messages.filter(m => m.includes(`"connectionsAllowed.${name}" is fixed in strict mode`)), name).toHaveLength(1);
        }
        for (const name of ['script-src-elem', 'child-src']) {
            expect(messages.filter(m => m.includes(`"connectionsAllowed.${name}" is not used in strict mode`)), name).toHaveLength(1);
        }
        expect(messages.filter(m => m.includes("'self'"))).toHaveLength(1); // the S14 drop applies as everywhere
    });

    it('the shipping defaults raise no strict-mode warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await mount({ mode: 'strict' });
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('strict mode'))).toEqual([]);
    });

    it('strictViewDirectives / strictPolicyOverrides: every key of a config is passed through, fixed, or dropped', () => {
        const all = { 'default-src': ['https://d.example'], 'script-src': ['*'], 'unknown-src': ['*'], 'img-src': ['https://i.example'] } as any;
        const policy = generateCSP(strictViewDirectives(all, "'sha256-x'", false));
        expect(policy).toBe("default-src https://d.example; script-src 'sha256-x'; script-src-attr 'none'; base-uri 'none'; form-action 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; upgrade-insecure-requests; img-src https://i.example;");
        expect(strictPolicyOverrides(all, { 'script-src': ["'unsafe-inline'"] })).toHaveLength(2);
        expect(new Set([...STRICT_FIXED, ...STRICT_PASSED_THROUGH]).size).toBe(STRICT_FIXED.length + STRICT_PASSED_THROUGH.length);
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
        const el = await mount({ entry: 'main.js' });
        el.reset();
        el.setConfig({ entry: 'main.js' });
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('"entry"'))).toHaveLength(1);
    });
});
