import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { assertHashableScript, scriptHashSource, sha256 } from './script-hash';
import { buildViewDocument, viewBootstrapHash, viewBootstrapText } from '../in-sandbox-view';
import { buildWrapperDocument } from '../frame-documents';

/** The reference: crypto.subtle over the UTF-8 of `text`, as a CSP hash-source. */
async function subtleSource(text: string): Promise<string> {
    const digest = new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    return `'sha256-${Buffer.from(digest).toString('base64')}'`;
}

describe('sha256 (synchronous, FIPS 180-4)', () => {
    it('matches crypto.subtle on the standard vectors and at every padding boundary', async () => {
        const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
        expect(hex(sha256(new Uint8Array()))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        expect(hex(sha256(new TextEncoder().encode('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        for (const length of [1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 70000]) {
            const bytes = new Uint8Array(length).map((_, i) => (i * 31 + length) & 0xff);
            const reference = new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes));
            expect(hex(sha256(bytes)), `length ${length}`).toBe(hex(reference));
        }
    });

    it('scriptHashSource hashes the UTF-8 of the text: non-ASCII, "<", "&" and quotes', async () => {
        for (const text of ['ascii', "void 'é € 😀 ü';", 'if (1 < 2 && "a" !== \'&amp;\') {}', '']) {
            expect(scriptHashSource(text)).toBe(await subtleSource(text));
        }
    });
});

describe('A3: the hash covers the text as parsed', () => {
    it('refuses CR, CR LF and NUL (the HTML parser changes them) and anything that ends or re-enters a script element', () => {
        for (const text of ['a;\r\nb;', 'a;\rb;', 'a; /*\u0000*/', 'x = "</script>"', 'x = "</SCRIPT"', '<!-- x', 'x = "<script"']) {
            expect(() => assertHashableScript(text), JSON.stringify(text)).toThrow();
            expect(() => scriptHashSource(text)).toThrow();
        }
        expect(() => assertHashableScript('a;\nb; if (a < b) {}')).not.toThrow();
    });

    it('why: the parser yields LF for CR LF, so a hash over the authored text would not match', () => {
        const parsed = new DOMParser().parseFromString('<script>a;\r\nb;</script>', 'text/html').querySelector('script')!.textContent;
        expect(parsed).toBe('a;\nb;');
    });

    it('the view bootstrap: crypto.subtle over the text the parser yields from the wrapper and view documents equals the hash in the policy', async () => {
        const text = viewBootstrapText();
        const wrapper = buildWrapperDocument(buildViewDocument("script-src 'none'", text), 'allow-scripts allow-forms');
        // two levels of srcdoc, each decoded by the parser, exactly as the browser receives them
        const viewSource = new DOMParser().parseFromString(wrapper, 'text/html').querySelector('iframe')!.getAttribute('srcdoc')!;
        const parsedText = new DOMParser().parseFromString(viewSource, 'text/html').querySelector('script')!.textContent!;
        expect(parsedText).toBe(text);
        expect(viewBootstrapHash()).toBe(await subtleSource(parsedText));
        expect(viewBootstrapHash()).toMatch(/^'sha256-[A-Za-z0-9+/]{43}='$/);
    });
});
