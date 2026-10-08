import { describe, it, expect } from 'vitest';
import { buildGuestDocument, buildWrapperDocument, escapeAttribute, toInlineScriptLiteral, WRAPPER_CSP } from './frame-documents';

const CSP = "default-src 'none';";

// parse the way the browser will: the HTML parser, not string matching
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

const HOSTILE_CONTENT = [
    '',
    '<div id="root"></div>',
    '<html><body><!-- <head> --></body></html>',
    '<!-- <html><head> --><html><head></head><body></body></html>',
    '<html><head><img src=x><!--</head><body></body></html>',
    '<!DOCTYPE html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body></body></html>',
    '<head><base href="https://evil.example/"></head>',
    '<textarea><head></textarea>',
    '<script>/*',
    '<plaintext>',
    '</head></html><head>',
];

describe('buildGuestDocument', () => {
    it.each(HOSTILE_CONTENT)('keeps the CSP meta as the first parsed head element for %j', (content) => {
        const doc = parse(buildGuestDocument({ csp: CSP, bootstrapScript: 'void 0', content }));

        const first = doc.head.firstElementChild;
        expect(first?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
        expect(first?.getAttribute('content')).toBe(CSP);
    });

    it('places the base tag and bootstrap script right after the CSP', () => {
        const doc = parse(buildGuestDocument({ csp: CSP, baseHref: 'https://vfs.example/id/', bootstrapScript: 'void 0', content: '<head><base href="https://evil.example/"></head>' }));

        const [meta, base, script] = [...doc.head.children];
        expect(meta?.tagName).toBe('META');
        expect(base?.getAttribute('href')).toBe('https://vfs.example/id/');
        expect(script?.textContent).toBe('void 0');
        // the first <base> wins, and it is ours
        expect(doc.querySelector('base')).toBe(base);
    });

    it('escapes attribute values so a policy cannot break out of the meta tag', () => {
        const doc = parse(buildGuestDocument({ csp: `a" onload="x`, bootstrapScript: '', content: '' }));
        expect(doc.head.firstElementChild?.getAttribute('content')).toBe('a" onload="x');
    });
});

describe('buildWrapperDocument', () => {
    it('embeds the guest document verbatim and carries the frame-src policy', () => {
        const guest = buildGuestDocument({ csp: CSP, bootstrapScript: 'console.log("&amp; \\"quoted\\"")', content: '<p title="x&y">hi</p>' });
        const doc = parse(buildWrapperDocument(guest, 'allow-scripts allow-forms'));

        expect(doc.head.firstElementChild?.getAttribute('content')).toBe(WRAPPER_CSP);
        const frame = doc.querySelector('iframe');
        expect(frame?.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
        expect(frame?.getAttribute('srcdoc')).toBe(guest);
    });

    it('delegates Permissions Policy features to the guest frame only when asked', () => {
        const guest = buildGuestDocument({ csp: CSP, bootstrapScript: '', content: '' });

        expect(parse(buildWrapperDocument(guest, 'allow-scripts')).querySelector('iframe')?.hasAttribute('allow')).toBe(false);
        expect(parse(buildWrapperDocument(guest, 'allow-scripts', 'fullscreen')).querySelector('iframe')?.getAttribute('allow')).toBe('fullscreen');
    });
});

describe('helpers', () => {
    it('escapeAttribute escapes & and "', () => {
        expect(escapeAttribute(`a&"b`)).toBe('a&amp;&quot;b');
    });

    it('toInlineScriptLiteral cannot close the surrounding script tag', () => {
        const literal = toInlineScriptLiteral('</script><script>alert(1)</script>');
        expect(literal).not.toContain('</script');
        expect(JSON.parse(literal)).toBe('</script><script>alert(1)</script>');
    });
});
