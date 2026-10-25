import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidPath } from '@src/lib/files';

/**
 * The strings a guest chooses and the host page's events carry are attacker text, and the docs say so in three places: the
 * README's bullet, THREAT-MODEL's bullet and the events paragraph of docs/API.md (rendered from the TSDoc of
 * `WebSandboxEventMap`). BD2:NEW-4 wrote the list for log, violation and fetch; BD3:CHL-2 found the guest-writes surface
 * (`fileswritten`, `listGuestWrites()`) missing from it, and a path that a valid-path check accepts can end a
 * single-quoted attribute. This file keeps the three lists to the same fields (class C, docs of a guest-controlled
 * surface), and keeps the claim about paths true.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

/** Every public field or method whose string a guest chooses, as the docs name it. */
const GUEST_CHOSEN: ReadonlyArray<readonly string[]> = [['args', 'arguments'], ['blockedURI'], ['sourceFile'], ['url'], ['fileswritten'], ['listGuestWrites']];

/** The paragraph, or the list item, of `text` that holds `marker`. */
function paragraphWith(text: string, marker: string): string {
    const found = text.split(/\n\s*\n|\n(?=(?:\*   |- ))/).map(paragraph => paragraph.replace(/\s+/g, ' ')).find(paragraph => paragraph.includes(marker));
    expect(found, marker).toBeDefined();
    return found!;
}

describe('the attacker-text lists', () => {
    const places: Array<[string, string, string]> = [
        ['README.md', 'README.md', 'Every string a guest can set is attacker text'],
        ['docs/THREAT-MODEL.md', 'docs/THREAT-MODEL.md', 'Every string a guest can set is attacker text'],
        ['docs/API.md (the events)', 'docs/API.md', 'Guest-controlled text (a log'],
    ];

    it.each(places)('%s names every field a guest chooses, and the sink to show it with', (_, file, marker) => {
        const paragraph = paragraphWith(read(file), marker);
        for (const names of GUEST_CHOSEN) expect(names.some(name => paragraph.includes(name)), names.join(' or ')).toBe(true);
        expect(paragraph).toContain('textContent');
        expect(paragraph, 'and the console, where the first argument is a format string').toContain('format-string');
    });

    it('docs/API.md says it where the guest-writes surface is described too', () => {
        const paragraph = paragraphWith(read('docs/API.md'), 'Treat written content as the guest');
        for (const word of ['path', 'type', 'textContent', 'single-quoted attribute']) expect(paragraph, word).toContain(word);
    });
});

describe('the docs\' examples never put a guest string first in a console call (BD3:DOC-3)', () => {
    const GUEST_FIELD = /\b(?:e|event)\.detail\.(?:directive|blockedURI|sourceFile|args|url|paths|message|reason)\b/;

    it.each(['README.md', 'docs/API.md'])('%s', (file) => {
        const examples = [...read(file).matchAll(/console\.(?:log|warn|error|info|debug)\(([^;\n]*)\)/g)].map(match => match[1]!);
        expect(examples.length, 'the scan sees the examples').toBeGreaterThan(2);
        // `detail.reason` is the library's text; the guest's fields are not, and may follow a fixed first argument
        const first = (call: string) => call.split(',')[0]!.trim();
        const offending = examples.filter(call => GUEST_FIELD.test(first(call)) && !/detail\.reason/.test(first(call)));
        expect(offending).toEqual([]);
        expect(examples.some(call => /^'violation',/.test(call)), 'a violation example, with a fixed first argument').toBe(true);
    });

    it('the scan sees the form it forbids', () => {
        expect(GUEST_FIELD.test('e.detail.directive, e.detail.blockedURI')).toBe(true);
        expect(GUEST_FIELD.test("'violation'")).toBe(false);
    });
});

describe('a guest-written path is attacker text: a valid path can end a single-quoted attribute', () => {
    it("is accepted by the path check with characters that are not safe in an attribute or a URL, and with none of the ones a double-quoted attribute needs", () => {
        const path = "a'onclick='alert(1)";
        expect(isValidPath(path)).toBe(true);
        // the characters the docs name are all valid in a segment
        for (const character of ["'", '(', ')', ';', '=', '&', '!', '$', '*', '+', ',', '@']) expect(isValidPath(`a${character}b`), character).toBe(true);
        // and the ones that end a double-quoted attribute or a tag are not, which is why the docs name the single-quoted one
        for (const character of ['"', '<', '>', ' ', ':']) expect(isValidPath(`a${character}b`), JSON.stringify(character)).toBe(false);
        const html = `<li title='${path}'>`;
        const template = document.createElement('template');
        template.innerHTML = html;
        const attributes = [...template.content.firstElementChild!.attributes].map(attribute => attribute.name);
        expect(attributes, 'the path added an attribute').toContain('onclick');
    });
});

describe("the docs' openExternal example runs as written, and opens only an address of a listed https origin (BD4:NEW-2)", () => {
    // The example passes the guest's string to window.open, the sink the attacker-text rule forbids for a raw string, so its
    // guard is code the docs ship. The snippet is taken from docs/API.md and run with a stub for `sandbox` and `window`.
    const snippet = (() => {
        const block = [...read('docs/API.md').matchAll(/```js\n([^]*?)```/g)].map(match => match[1]!).find(code => code.includes("sandbox.expose('openExternal'"));
        expect(block, 'the openExternal example is a js block of docs/API.md').toBeDefined();
        return block!;
    })();

    function run(code = snippet) {
        let handler: ((text: unknown) => void) | undefined;
        const sandbox = { expose: (name: string, fn: (text: unknown) => void) => { expect(name).toBe('openExternal'); handler = fn; } };
        const open = vi.fn();
        new Function('sandbox', 'window', code.replace(/^\/\/ in the worker:.*$/m, ''))(sandbox, { open });
        return { call: (text: unknown) => { try { handler!(text); return 'opened'; } catch (error) { return (error as Error).message; } }, open };
    }

    it('opens an address of a listed origin: the parsed href, in a new tab, with noopener', () => {
        const { call, open } = run();
        expect(call('https://example.com/docs?a=1#b')).toBe('opened');
        expect(call('HTTPS://EXAMPLE.COM/x')).toBe('opened');
        expect(call('https://example.com\\@evil.example/')).toBe('opened'); // the URL parser reads a backslash as a slash: host example.com
        expect(open.mock.calls).toEqual([
            ['https://example.com/docs?a=1#b', '_blank', 'noopener'],
            ['https://example.com/x', '_blank', 'noopener'],
            ['https://example.com/@evil.example/', '_blank', 'noopener'], // the parsed address, not the guest's text
        ]);
    });

    it('refuses everything else, and window.open is never called', () => {
        const { call, open } = run();
        const hostile: unknown[] = [
            "javascript:alert('x')", ' JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<script>1</script>', 'blob:https://example.com/x', 'file:///etc/passwd',
            'http://example.com/', 'https://example.com@evil.example/', 'https://example.com.evil.example/', 'https://evil.example/https://example.com/',
            'https://example.com:8443/', 'https://sub.example.com/', '//example.com/', 'example.com', '/docs', '', 'https://', 'https://example.com/' + 'a'.repeat(2048),
            5, null, undefined, {}, ['https://example.com/'], { toString: () => 'https://example.com/' },
        ];
        for (const text of hostile) expect(call(text), String(text).slice(0, 40)).toBe('openExternal: address not allowed');
        expect(open).not.toHaveBeenCalled();
    });

    it('the protocol check holds on its own: with plain-http, javascript: and opaque origins on the list, only https: opens', () => {
        const widened = snippet.replace("new Set(['https://example.com'])", "new Set(['https://example.com', 'http://example.com', 'null'])");
        expect(widened).not.toBe(snippet);
        const { call, open } = run(widened);
        for (const text of ['http://example.com/', 'javascript:alert(1)', 'data:,x', 'blob:null/x']) expect(call(text), text).toBe('openExternal: address not allowed');
        expect(open).not.toHaveBeenCalled();
        expect(call('https://example.com/')).toBe('opened');
    });
});
