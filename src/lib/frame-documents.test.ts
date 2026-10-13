import { describe, it, expect } from 'vitest';
import { buildGuestDocument, buildWrapperDocument, escapeAttribute, FRAME_REFERRER_POLICY, toInlineScriptLiteral, WRAPPER_BASE, WRAPPER_CSP } from './frame-documents';

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

    it('places the bootstrap script right after the CSP, ahead of any guest <base>', () => {
        const doc = parse(buildGuestDocument({ csp: CSP, bootstrapScript: 'void 0', content: '<head><base href="https://evil.example/"></head>' }));

        const [meta, script, guestBase] = [...doc.head.children];
        expect(meta?.tagName).toBe('META');
        expect(script?.textContent).toBe('void 0');
        // the guest's own <base> lands after the policy, which keeps base-uri 'none' in force over it
        expect(guestBase?.tagName).toBe('BASE');
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

    it('hides the host page URL from the guest (S15): an inert base and a no-referrer policy, both ahead of the guest frame', () => {
        const guest = buildGuestDocument({ csp: CSP, bootstrapScript: '', content: '<head><base href="https://evil.example/"><meta name="referrer" content="unsafe-url"></head>' });
        const doc = parse(buildWrapperDocument(guest, 'allow-scripts', ['fullscreen']));

        expect(WRAPPER_BASE).toBe('about:blank');
        expect(FRAME_REFERRER_POLICY).toBe('no-referrer');
        // the policy stays first; the wrapper's one <base> and one referrer policy follow it, in <head>
        const head = [...doc.head.children].map(el => el.outerHTML);
        expect(head.slice(0, 3)).toEqual([
            `<meta http-equiv="Content-Security-Policy" content="${WRAPPER_CSP}">`,
            `<base href="about:blank">`,
            `<meta name="referrer" content="no-referrer">`,
        ]);
        expect(doc.querySelectorAll('base')).toHaveLength(1);
        expect(doc.querySelectorAll('meta[name="referrer"]')).toHaveLength(1);
        // the wrapper's policy does not restrict base-uri, so its own <base> applies (the guest's policy does, see below)
        expect(WRAPPER_CSP).not.toContain('base-uri');
        expect(doc.baseURI).toBe('about:blank');

        // the guest frame carries the attribute that sets its document.referrer
        const frame = doc.querySelector('iframe')!;
        expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
        expect(frame.getAttribute('srcdoc')).toBe(guest); // the guest's own <base> and referrer meta are only in its document
    });

    it('delegates Permissions Policy features to the guest frame only when asked', () => {
        const guest = buildGuestDocument({ csp: CSP, bootstrapScript: '', content: '' });

        expect(parse(buildWrapperDocument(guest, 'allow-scripts')).querySelector('iframe')?.hasAttribute('allow')).toBe(false);

        const frame = parse(buildWrapperDocument(guest, 'allow-scripts', ['fullscreen'])).querySelector('iframe');
        // '*', not the default 'src': a sandboxed srcdoc frame's declared origin is a fresh opaque one
        expect(frame?.getAttribute('allow')).toBe('fullscreen *');
        expect(frame?.hasAttribute('allowfullscreen')).toBe(true);
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
