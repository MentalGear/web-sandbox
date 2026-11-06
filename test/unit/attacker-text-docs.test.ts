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

describe("the docs' openExternal example opens only an address the host holds, and never one the app gives (BD4:NEW-2, BD5:NEW-1)", () => {
    // The first example let the app give an address and checked its scheme and origin (BD4:NEW-2); an address that passes
    // still carries the app's data in its path, query and fragment to a server (BD5:NEW-1). So the app names a key, and the
    // host's table holds the addresses. The snippet is taken from docs/API.md and run with a stub for `sandbox` and `window`.
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

    /** The addresses the snippet holds: what it opens for each key of its table, read by running it. */
    const table = (() => {
        const keys = [...snippet.matchAll(/\['([a-z]+)', 'https:\/\/[^']+'\]/g)].map(match => match[1]!);
        expect(keys.length, 'the table lists its links').toBeGreaterThan(1);
        const { call, open } = run();
        return new Map(keys.map(key => (call(key), [key, open.mock.calls.at(-1)![0] as string] as const)));
    })();
    const ADDRESSES = new Set(table.values());

    it('a listed key opens exactly its fixed address, in a new tab, with noopener', () => {
        const { call, open } = run();
        for (const [key, href] of table) expect(call(key), key).toBe('opened');
        expect(open.mock.calls).toEqual([...table.values()].map(href => [href, '_blank', 'noopener']));
        expect([...table.values()]).toEqual(['https://example.com/docs', 'https://example.com/help']);
    });

    it('whatever the app sends, an address is opened only when it is one of the table\'s: never the app\'s text', () => {
        const { call, open } = run();
        const keys = [...table.keys()];
        const hostile: unknown[] = [
            ...keys.flatMap(key => [`${key}?x`, `${key}#x`, `${key}/x`, ` ${key}`, `${key} `, key.toUpperCase(), `${key}\n`]),
            'https://example.com/docs?x=1', 'https://example.com/docs', 'https://example.com/', 'https://evil.example/', "javascript:alert('x')", 'data:text/html,<script>1</script>',
            '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '', 'https://', '/docs', '//example.com/docs',
            5, null, undefined, true, {}, [], [keys[0]], { toString: () => keys[0] }, { [Symbol.toPrimitive]: () => keys[0] }, ...new Array(1000).fill(0).map((_, n) => `k${n * 7919 % 10007}${'x'.repeat(n % 9)}`),
        ];
        for (const text of hostile) expect(call(text), String(typeof text === 'object' ? JSON.stringify(text) : text).slice(0, 40)).toBe('openExternal: unknown link');
        expect(open).not.toHaveBeenCalled();
        // and over every key too, nothing that is opened is anything but a table value
        for (const key of keys) call(key);
        for (const [href] of open.mock.calls) expect(ADDRESSES.has(href as string)).toBe(true);
    });

    it('no href holds any part of the argument that is not already in the table\'s value, and the argument never reaches new URL() or window.open()', () => {
        const { call, open } = run();
        const secret = 'SECRET-NOTE customer=alice@example.org';
        for (const text of [`docs?n=${secret}`, `https://example.com/${secret}`, secret, `docs#${secret}`]) call(text);
        for (const key of table.keys()) call(`${key}`);
        for (const [href] of open.mock.calls) expect(String(href)).not.toContain('SECRET');
        // a source scan: the parameter is only a key into the table
        const parameter = /sandbox\.expose\('openExternal', \((\w+)\)/.exec(snippet)![1]!;
        const openCall = /window\.open\([^)]*\)/.exec(snippet)![0];
        expect(openCall).not.toContain(parameter);
        expect(snippet).not.toMatch(/new URL\(/);
        expect(snippet).toMatch(new RegExp(`LINKS\\.get\\(${parameter}\\)`));
    });

    it('the scan sees the form it forbids: the first example (an address from the app, checked) fails the same tests', () => {
        const old = `const OPENABLE = new Set(['https://example.com']);
sandbox.expose('openExternal', (text) => { const url = new URL(text); if (!OPENABLE.has(url.origin)) throw new Error('openExternal: address not allowed'); window.open(url.href, '_blank', 'noopener'); });`;
        const { call, open } = run(old);
        expect(call('https://example.com/docs?n=SECRET')).toBe('opened');
        expect([...open.mock.calls].some(([href]) => !ADDRESSES.has(href as string))).toBe(true);
        expect(old).toMatch(/new URL\(/);
    });
});

describe('the docs name the rule for the guest\'s bytes where the embedder takes them (BD5:CHL-2)', () => {
    it.each([
        ['docs/API.md', 'Never make a URL of the app\'s bytes with the app\'s type'],
        ['docs/API.md', 'The bytes are the guest\'s too, and a URL made of them is a document of your origin'],
        ['src/lib/guest-writes.ts', 'Never make an object URL of `content` with the'],
        ['src/host.ts', 'Never make an object URL of them with that type'],
    ])('%s says: %s', (file, sentence) => {
        expect(read(file).replace(/\s+/g, ' ').replace(/ \* /g, ' ').replace(/ \/\/ /g, ' ')).toContain(sentence.replace(/\s+/g, ' '));
    });

    it('the guest-writes section and the recipe tell what to do instead: the sandbox view, an image Blob typed by the host, a download', () => {
        const api = read('docs/API.md');
        const section = api.slice(api.indexOf('The bytes are the guest\'s too'), api.indexOf('A committed write\'s type is the guest\'s claim'));
        for (const word of ['sandbox view', 'image/png', 'signature', '<img>', '<a download>', 'application/octet-stream', 'target="_blank"', '<iframe>', '<object>', 'location']) expect(section, word).toContain(word);
        const recipe = api.slice(api.indexOf('### Images the app makes'), api.indexOf('### Input'));
        for (const word of ['createObjectURL', "type: 'image/png'", "'application/octet-stream'", 'link.download']) expect(recipe, word).toContain(word);
        expect(recipe).not.toMatch(/type: (?:write|w)\.type/);
    });
});
