import { afterEach, describe, expect, it } from 'vitest';
import { defineWebSandbox, WebSandbox } from '@src/host';
import { DOCUMENT_URL_RULES, DOCUMENT_URL_SCHEMES, EXTENSION_SCHEMES, hostPage, OPAQUE_ORIGIN, readDocumentUrl, registeredDocumentUrl, type HostPage } from '@src/lib/document-url';
import { fixedDetail, reasonText, TERMINATION_REASONS } from '@src/lib/reasons';
import { SEALED_DOCUMENT_FILE } from '@src/lib/sealed-document';

/**
 * `documentUrl` in the default build (design 03, "The public surface"): given once to defineWebSandbox(), resolved
 * against the document's own URL and never its base URL (review 2, finding 1), `http:` or `https:` on any host page, or
 * else of the host page's own origin where that origin is neither opaque nor an extension's (design 05, row 3.10), with
 * no user name, password or fragment, anything else refused before anything is defined or stored; a second definition
 * with the same URL does nothing and with another throws. The network build's registration without one is
 * test/unit/document-url-network.test.ts.
 */

const PAGE: HostPage = { address: 'https://app.example/shop/cart.html?user=7', origin: 'https://app.example' };
const refusal = (rule: keyof typeof DOCUMENT_URL_RULES) => `[Sandbox] defineWebSandbox(): ${reasonText('documentUrlRefused', fixedDetail(DOCUMENT_URL_RULES[rule]))}.`;
const definitionError = (id: 'definitionRefused' | 'documentUrlMissing' | 'documentUrlChanged') => `[Sandbox] defineWebSandbox(): ${reasonText(id)}.`;

afterEach(() => {
    for (const base of document.querySelectorAll('base')) base.remove();
});

describe('readDocumentUrl: the one rule of a documentUrl', () => {
    it('resolves a relative URL against the document address it is given, and keeps a query and any path', () => {
        expect(readDocumentUrl('sealed-document.html', PAGE)).toBe('https://app.example/shop/sealed-document.html');
        expect(readDocumentUrl('/static/v1.2/sealed-document.html?v=1.2', PAGE)).toBe('https://app.example/static/v1.2/sealed-document.html?v=1.2');
        expect(readDocumentUrl('//files.example/sealed-document.html', PAGE)).toBe('https://files.example/sealed-document.html');
        expect(readDocumentUrl(new URL('http://localhost:8080/a/b.html'), PAGE)).toBe('http://localhost:8080/a/b.html');
    });

    it('on an http(s) host page, admits exactly the schemes of DOCUMENT_URL_SCHEMES', () => {
        expect(DOCUMENT_URL_SCHEMES).toEqual(['http:', 'https:']);
        for (const url of ['javascript:alert(1)', 'data:text/html,x', 'blob:https://app.example/1', 'file:///srv/sealed-document.html', 'about:blank', 'ftp://app.example/f.html', 'chrome-extension://abc/f.html']) {
            expect(() => readDocumentUrl(url, PAGE), url).toThrow(refusal('scheme'));
        }
    });

    it('refuses a user name or a password, and a fragment, an empty one included', () => {
        for (const url of ['https://user@app.example/f.html', 'https://:secret@app.example/f.html', 'https://u:p@app.example/f.html']) {
            expect(() => readDocumentUrl(url, PAGE), url).toThrow(refusal('credentials'));
        }
        for (const url of ['f.html#view', 'https://app.example/f.html#', '#']) {
            expect(() => readDocumentUrl(url, PAGE), url).toThrow(refusal('fragment'));
        }
    });

    it('refuses a value that is not a string or a URL, and one that does not parse', () => {
        for (const value of [undefined, null, 42, {}, { href: 'https://app.example/f.html' }, ['f.html'], () => 'f.html']) {
            expect(() => readDocumentUrl(value, PAGE)).toThrow(refusal('type'));
        }
        expect(() => readDocumentUrl('https://[::1', PAGE)).toThrow(refusal('parse'));
        expect(() => readDocumentUrl('f.html', { address: 'not a URL', origin: 'https://app.example' })).toThrow(refusal('parse'));
    });

    it('every refusal is a TypeError', () => {
        expect(() => readDocumentUrl('data:,x', PAGE)).toThrow(TypeError);
        expect(() => readDocumentUrl(1, PAGE)).toThrow(TypeError);
    });

    it("the reasons name the served file by the generator's own name", () => {
        expect(TERMINATION_REASONS.documentUrlMissing.text).toContain(SEALED_DOCUMENT_FILE);
        expect(TERMINATION_REASONS.noDocumentUrl.text).toContain(SEALED_DOCUMENT_FILE);
        for (const id of ['definitionRefused', 'documentUrlMissing', 'documentUrlRefused', 'documentUrlChanged'] as const) expect(TERMINATION_REASONS[id].decidedBy).toBe('define');
    });
});

// The rule over its whole domain (design 05, row 3.10): every URL scheme a page can name, against every kind of host page
// origin, as the page itself reads it (`self.origin`). The host pages: an http(s) site; the opaque ones, which read
// "null" (a browser's file: page with or without its frame's sandbox, a sandboxed frame, a data: page, research 34);
// Electron's file: page and Chromium's with --allow-file-access-from-files ("file://"); an app shell's standard scheme
// ("app://bundle"); and each browser's extension page.
const HOST_ORIGINS = {
    https: 'https://app.example',
    http: 'http://localhost:4444',
    opaque: 'null',
    electronFile: 'file://',
    appScheme: 'app://bundle',
    chromeExtension: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    firefoxExtension: 'moz-extension://0f9e8d7c-1111-4222-8333-944455556666',
    safariExtension: 'safari-web-extension://5A6B7C8D-0000-4000-8000-000000000000',
} as const;
type HostKind = keyof typeof HOST_ORIGINS;

// Every kind of scheme a documentUrl could name: the network's, the page's own kinds, the ones a page mints, the
// extensions'.
const URLS = [
    'https://app.example/static/sealed-document.html',
    'http://localhost:4444/static/sealed-document.html',
    'https://cdn.example/sealed-document.html',
    'file:///srv/app/sealed-document.html',
    'file://fileserver/share/sealed-document.html',
    'app://bundle/static/sealed-document.html',
    'app://other/static/sealed-document.html',
    'other://bundle/static/sealed-document.html',
    'blob:https://app.example/1c2d3e4f-0000-4000-8000-000000000000',
    'blob:null/1c2d3e4f-0000-4000-8000-000000000000',
    'blob:app://bundle/1c2d3e4f-0000-4000-8000-000000000000',
    'data:text/html,<p>x</p>',
    'javascript:void 0',
    'about:blank',
    'about:srcdoc',
    'filesystem:https://app.example/temporary/sealed-document.html',
    'ftp://app.example/sealed-document.html',
    'ws://app.example/sealed-document.html',
    `${HOST_ORIGINS.chromeExtension}/sealed-document.html`,
    `${HOST_ORIGINS.firefoxExtension}/sealed-document.html`,
    `${HOST_ORIGINS.safariExtension}/sealed-document.html`,
] as const;

// The URLs on neither http: nor https: that the rule admits, each on the one kind of host page whose own origin it is:
// Electron's file: page (file: with no host) and the app shell's scheme. Every other pair off http(s) is refused.
const ADMITTED_OFF_HTTP: Partial<Record<HostKind, readonly string[]>> = {
    electronFile: ['file:///srv/app/sealed-document.html'],
    appScheme: ['app://bundle/static/sealed-document.html'],
};

// The rule a refused pair breaks: by the host page's kind, else the origin.
function refusalOf(host: HostKind): keyof typeof DOCUMENT_URL_RULES {
    if (host === 'opaque') return 'opaqueHost';
    if (host.endsWith('Extension')) return 'extensionHost';
    return 'scheme';
}

describe('the rule over its domain: every scheme, against every kind of host page origin (design 05, row 3.10)', () => {
    it("http: and https: on every host page; off them, only the host page's own origin where it is neither opaque nor an extension's", () => {
        for (const [host, origin] of Object.entries(HOST_ORIGINS) as [HostKind, string][]) {
            const page: HostPage = { address: 'https://app.example/shop/cart.html', origin };
            for (const url of URLS) {
                const onHttp = url.startsWith('http:') || url.startsWith('https:');
                const admitted = onHttp || (ADMITTED_OFF_HTTP[host] ?? []).includes(url);
                const read = () => readDocumentUrl(url, page);
                if (admitted) expect(read(), `${host} ${url}`).toBe(new URL(url).href);
                else expect(read, `${host} ${url}`).toThrow(refusal(refusalOf(host)));
            }
        }
    });

    it("decides by the page's own origin, never by the URL parser's: a file: and a blob: URL are refused where their parsed origin equals the page's", () => {
        // the parser's string: "null" for a file: URL here (and in Firefox), the creator's origin for a blob: URL
        expect(new URL('file:///srv/app/sealed-document.html').origin).toBe(OPAQUE_ORIGIN);
        expect(new URL('blob:https://app.example/1').origin).toBe('https://app.example');
        expect(() => readDocumentUrl('file:///srv/app/sealed-document.html', { address: 'file:///srv/app/index.html', origin: OPAQUE_ORIGIN })).toThrow(refusal('opaqueHost'));
        expect(() => readDocumentUrl('blob:https://app.example/1', PAGE)).toThrow(refusal('scheme'));
        // and where the parser reads an app scheme's URL as opaque, the page's own origin still admits it
        expect(new URL('app://bundle/static/sealed-document.html').origin).toBe(OPAQUE_ORIGIN);
        expect(readDocumentUrl('sealed-document.html', { address: 'app://bundle/static/index.html', origin: 'app://bundle' })).toBe('app://bundle/static/sealed-document.html');
    });

    it('a relative URL on a file: or app-scheme page resolves beside the page, and is admitted only where the page is not opaque', () => {
        const fileAt = (origin: string): HostPage => ({ address: 'file:///srv/app/index.html', origin });
        expect(readDocumentUrl('sealed-document.html', fileAt('file://'))).toBe('file:///srv/app/sealed-document.html');
        expect(() => readDocumentUrl('sealed-document.html', fileAt(OPAQUE_ORIGIN))).toThrow(refusal('opaqueHost'));
        // an http(s) copy is the way for an opaque page, whatever its own URL
        expect(readDocumentUrl('https://cdn.example/sealed-document.html', fileAt(OPAQUE_ORIGIN))).toBe('https://cdn.example/sealed-document.html');
        // a data: page or a srcdoc frame has no URL a relative one resolves against
        expect(() => readDocumentUrl('sealed-document.html', { address: 'data:text/html,x', origin: OPAQUE_ORIGIN })).toThrow(refusal('parse'));
        expect(() => readDocumentUrl('sealed-document.html', { address: 'about:srcdoc', origin: OPAQUE_ORIGIN })).toThrow(refusal('parse'));
    });

    it('credentials and a fragment are refused off http(s) as on it, once the origin holds', () => {
        const app: HostPage = { address: 'app://bundle/index.html', origin: 'app://bundle' };
        expect(() => readDocumentUrl('app://user:pw@bundle/sealed-document.html', app)).toThrow(refusal('credentials'));
        expect(() => readDocumentUrl('sealed-document.html#view', app)).toThrow(refusal('fragment'));
        expect(() => readDocumentUrl('file:///srv/app/sealed-document.html#', { address: 'file:///srv/app/index.html', origin: 'file://' })).toThrow(refusal('fragment'));
    });

    it("the refusals of an opaque page and of an extension's name an http(s) copy of the file; the extension schemes are the browsers'", () => {
        expect(DOCUMENT_URL_RULES.opaqueHost).toContain('name an http: or https: copy of the file');
        expect(DOCUMENT_URL_RULES.extensionHost).toContain('name an http: or https: copy of the file');
        expect(EXTENSION_SCHEMES).toEqual(['chrome-extension:', 'moz-extension:', 'safari-web-extension:']);
        for (const scheme of EXTENSION_SCHEMES) expect(Object.values(HOST_ORIGINS).some(origin => origin.startsWith(`${scheme}//`)), scheme).toBe(true);
    });

    it("hostPage() reads the document's own URL and the page's own origin, and a self.origin that is not a string as opaque", () => {
        expect(hostPage()).toEqual({ address: document.URL, origin: self.origin });
        const own = Object.getOwnPropertyDescriptor(self, 'origin');
        try {
            Object.defineProperty(self, 'origin', { value: { toString: () => 'app://bundle' }, configurable: true });
            expect(hostPage().origin).toBe(OPAQUE_ORIGIN);
        } finally {
            if (own) Object.defineProperty(self, 'origin', own);
            else delete (self as { origin?: unknown }).origin;
        }
        expect(hostPage().origin).toBe(self.origin);
    });
});

// The element is defined once per test file: the definition's refusals come first, before the one that defines it.
describe('defineWebSandbox(): the definition, read whole before anything is defined', () => {
    it('refuses a definition that is not an object, a tagName that is not a string, and a missing documentUrl, defining nothing', () => {
        for (const definition of [undefined, null, 'web-sandbox', ['web-sandbox'], 7]) {
            expect(() => defineWebSandbox(definition as never)).toThrow(definitionError('definitionRefused'));
        }
        expect(() => defineWebSandbox({ tagName: 7, documentUrl: 'f.html' } as never)).toThrow(definitionError('definitionRefused'));
        expect(() => defineWebSandbox({} as never)).toThrow(definitionError('documentUrlMissing'));
        expect(() => defineWebSandbox({ tagName: 'web-sandbox' } as never)).toThrow(definitionError('documentUrlMissing'));
        // a URL that breaks a rule: nothing is defined either
        expect(() => defineWebSandbox({ documentUrl: 'javascript:void 0' })).toThrow(refusal('scheme'));
        expect(customElements.get('web-sandbox')).toBeUndefined();
        expect(registeredDocumentUrl()).toBeNull();
    });

    it("resolves a relative documentUrl against document.URL, not against a <base> in the page", () => {
        const base = document.createElement('base');
        base.href = 'https://attacker.example/';
        document.head.append(base);
        expect(document.baseURI).toBe('https://attacker.example/');
        expect(defineWebSandbox({ documentUrl: 'static/sealed-document.html' })).toBe(WebSandbox);
        expect(registeredDocumentUrl()).toBe(new URL('static/sealed-document.html', document.URL).href);
        // the vulnerable form, the base URL, would have pointed the element at the injected host
        expect(new URL('static/sealed-document.html', document.baseURI).origin).toBe('https://attacker.example');
        expect(registeredDocumentUrl()!.startsWith('https://attacker.example')).toBe(false);
        expect(customElements.get('web-sandbox')).toBe(WebSandbox);
    });

    it('a second definition with the same documentUrl does nothing; with another, or none, it throws and changes nothing', () => {
        const stored = registeredDocumentUrl();
        expect(defineWebSandbox({ documentUrl: 'static/sealed-document.html' })).toBe(WebSandbox);
        expect(defineWebSandbox({ tagName: 'web-sandbox', documentUrl: new URL('static/sealed-document.html', document.URL) })).toBe(WebSandbox);
        expect(() => defineWebSandbox({ documentUrl: 'static/sealed-document.html?v=2' })).toThrow(definitionError('documentUrlChanged'));
        expect(() => defineWebSandbox({ documentUrl: 'https://cdn.example/sealed-document.html' })).toThrow(TypeError);
        expect(registeredDocumentUrl()).toBe(stored);
    });

    it('another tag name of this class is the browser\'s refusal, and stores nothing', () => {
        const stored = registeredDocumentUrl();
        expect(() => defineWebSandbox({ tagName: 'other-sandbox', documentUrl: 'https://cdn.example/sealed-document.html' })).toThrow();
        expect(customElements.get('other-sandbox')).toBeUndefined();
        expect(registeredDocumentUrl()).toBe(stored);
    });
});
