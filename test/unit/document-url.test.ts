import { afterEach, describe, expect, it } from 'vitest';
import { defineWebSandbox, WebSandbox } from '@src/host';
import { DOCUMENT_URL_RULES, DOCUMENT_URL_SCHEMES, readDocumentUrl, registeredDocumentUrl } from '@src/lib/document-url';
import { fixedDetail, reasonText, TERMINATION_REASONS } from '@src/lib/reasons';
import { SEALED_DOCUMENT_FILE } from '@src/lib/sealed-document';

/**
 * `documentUrl` in the default build (design 03, "The public surface"): given once to defineWebSandbox(), resolved
 * against the document's own URL and never its base URL (review 2, finding 1), `http:` or `https:` with no user name,
 * password or fragment, anything else refused before anything is defined or stored; a second definition with the same
 * URL does nothing and with another throws. The network build's registration without one is
 * test/unit/document-url-network.test.ts.
 */

const PAGE = 'https://app.example/shop/cart.html?user=7';
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

    it('admits exactly the schemes of DOCUMENT_URL_SCHEMES', () => {
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
        expect(() => readDocumentUrl('f.html', 'not a URL')).toThrow(refusal('parse'));
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
