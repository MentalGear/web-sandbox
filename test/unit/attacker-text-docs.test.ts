import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidPath } from '@src/lib/files';
import { guestText } from '@src/lib/guest-values';
import { guestBytes } from '@src/lib/guest-bytes';

/**
 * The strings a guest chooses and the host page's events carry are attacker text, and the docs say so in three places: the
 * README's bullet, THREAT-MODEL's bullet and docs/API.md's "Guest-chosen text", whose table is generated from the
 * registry of guest values (GUEST_VALUES, src/lib/guest-values.ts; I10). BD2:NEW-4 wrote the list for log, violation and
 * fetch; BD3:CHL-2 found the guest-writes surface (`fileswritten`, `listGuestWrites()`) missing from it, and a path that a
 * valid-path check accepts can end a single-quoted attribute. This file holds the two handwritten lists to the registry's
 * text (class C, docs of a guest-controlled surface: the list is the registry's, not this file's), and keeps the claim
 * about paths true.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

/** Every public value whose text a guest chooses, as the docs name it: the registry's. */
const GUEST_CHOSEN: readonly string[] = guestText().map(text => text.name);

/** docs/API.md's generated table of the guest's text. */
const generatedTable = (text: string) => text.slice(text.indexOf('<!-- generated:begin guest-text -->'), text.indexOf('<!-- generated:end -->', text.indexOf('<!-- generated:begin guest-text -->')));

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
        ['docs/API.md (Guest-chosen text)', 'docs/API.md', '**Guest-chosen text.**'],
    ];

    it.each(places)('%s names every field a guest chooses, and the sink to show it with', (_, file, marker) => {
        const paragraph = paragraphWith(read(file), marker) + (file === 'docs/API.md' ? generatedTable(read(file)) : '');
        expect(GUEST_CHOSEN.length).toBeGreaterThan(8);
        for (const name of GUEST_CHOSEN) expect(paragraph, name).toContain(name);
        expect(paragraph).toContain('textContent');
        expect(paragraph, 'and the console, where the first argument is a format string').toContain('format-string');
    });

    // BD6:DOC-2, BD6:CHL-4: the app's text also reaches a page that forwards events to a server it can read
    it.each(places)('%s says not to forward the app\'s text to a network sink, a reporter or analytics', (_, file, marker) => {
        const paragraph = paragraphWith(read(file), marker);
        expect(paragraph).toContain('sendBeacon');
        expect(paragraph).toMatch(/error reporter|reporter/);
        expect(paragraph).toContain('analytics');
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
    // host's table holds the addresses. The snippet is taken from docs/API.md and run with a stub for `sandbox` (whose
    // start() takes the method in its grants), `app` and `window`.
    const snippet = (() => {
        const block = [...read('docs/API.md').matchAll(/```js\n([^]*?)```/g)].map(match => match[1]!).find(code => code.includes('methods: { openExternal }'));
        expect(block, 'the openExternal example is a js block of docs/API.md').toBeDefined();
        return block!;
    })();

    function run(code = snippet) {
        let handler: ((text: unknown) => void) | undefined;
        const sandbox = { start: (_app: unknown, grants: { methods: Record<string, (text: unknown) => void> }) => { expect(Object.keys(grants.methods)).toEqual(['openExternal']); handler = grants.methods.openExternal; } };
        const open = vi.fn();
        new Function('sandbox', 'app', 'window', code.replace(/^\/\/ in the worker:.*$/m, ''))(sandbox, {}, { open });
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
        const parameter = /const openExternal = \((\w+)\) =>/.exec(snippet)![1]!;
        const openCall = /window\.open\([^)]*\)/.exec(snippet)![0];
        expect(openCall).not.toContain(parameter);
        expect(snippet).not.toMatch(/new URL\(/);
        expect(snippet).toMatch(new RegExp(`LINKS\\.get\\(${parameter}\\)`));
    });

    it('the scan sees the form it forbids: the first example (an address from the app, checked) fails the same tests', () => {
        const old = `const OPENABLE = new Set(['https://example.com']);
const openExternal = (text) => { const url = new URL(text); if (!OPENABLE.has(url.origin)) throw new Error('openExternal: address not allowed'); window.open(url.href, '_blank', 'noopener'); };
sandbox.start(app, { methods: { openExternal } });`;
        const { call, open } = run(old);
        expect(call('https://example.com/docs?n=SECRET')).toBe('opened');
        expect([...open.mock.calls].some(([href]) => !ADDRESSES.has(href as string))).toBe(true);
        expect(old).toMatch(/new URL\(/);
    });
});

describe('the docs\' image snippet runs when the app has written nothing, a PNG, or something else (BD6:DOC-4)', () => {
    const snippet = (() => {
        const block = [...read('docs/API.md').matchAll(/```js\n([^]*?)```/g)].map(match => match[1]!).find(code => code.includes('write.content.image()'));
        expect(block, 'the image snippet is a js block of docs/API.md').toBeDefined();
        return block!;
    })();

    // A write as listGuestWrites() lists it: its content is the library's GuestBytes, whose save() is recorded here
    // (test/unit/guest-bytes.test.ts holds what save() itself does).
    const saved: string[] = [];
    const write = (path: string, type: string, bytes: Uint8Array) => {
        const content = guestBytes(path, bytes);
        return { path, change: 'write', type, size: content.size, content: { ...content, save: () => { saved.push(path); } } };
    };
    function run(writes: object[]) {
        saved.length = 0;
        const created: Array<{ type: string; size: number }> = [];
        const sandbox = { listGuestWrites: () => writes };
        const img: { src?: string } = {};
        const fakeURL = { createObjectURL: (blob: Blob) => (created.push({ type: blob.type, size: blob.size }), `blob:${created.length}`) };
        new Function('sandbox', 'img', 'URL', `return (() => { ${snippet} })();`)(sandbox, img, fakeURL);
        return { img, created, saved: [...saved] };
    }
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

    it('does nothing, and does not throw, when nothing was written', () => {
        for (const writes of [[], [write('other.bin', 'application/octet-stream', png)], [{ path: 'progress.png', change: 'remove' }]]) {
            const { img, created, saved } = run(writes);
            expect({ img, created, saved }, JSON.stringify(writes).slice(0, 50)).toEqual({ img: {}, created: [], saved: [] });
        }
    });

    it('shows a PNG in an <img> from image(), typed image/png by its signature, and saves nothing', () => {
        const { img, created, saved } = run([write('progress.png', 'text/html', png)]);
        expect(created).toEqual([{ type: 'image/png', size: png.length }]); // the type is the signature's, never the write's
        expect(img.src).toBe('blob:1');
        expect(saved).toEqual([]);
    });

    it('offers anything else with save(), never as an image', () => {
        const html = new TextEncoder().encode('<script>1</script>');
        const { img, created, saved } = run([write('progress.png', 'image/png', html)]);
        expect(created).toEqual([]);
        expect(img).toEqual({});
        expect(saved).toEqual(['progress.png']);
    });
});

describe('the docs name the rule for the guest\'s bytes where the embedder takes them (BD5:CHL-2)', () => {
    it.each([
        ['docs/API.md', 'Never make a URL of the app\'s bytes with the app\'s type'],
        ['docs/API.md', 'The bytes are the guest\'s too, and a URL made of them is a document of your origin'],
        ['src/lib/guest-writes.ts', 'Never make an object URL of `content.bytes()` with the write\'s `type`'],
        ['src/host.ts', 'Never make an object URL of its bytes with a type the guest chose'],
    ])('%s says: %s', (file, sentence) => {
        expect(read(file).replace(/\s+/g, ' ').replace(/ \* /g, ' ').replace(/ \/\/ /g, ' ')).toContain(sentence.replace(/\s+/g, ' '));
    });

    it('the guest-writes section and the recipe tell what to do instead: the sandbox view, image(), save(); bytes() is the raw step', () => {
        const api = read('docs/API.md');
        const start = api.indexOf('The bytes are the guest\'s too');
        const end = api.indexOf('A committed write\'s type and its name agree');
        expect(start, 'the section starts').toBeGreaterThan(-1);
        expect(end, 'and ends').toBeGreaterThan(start);
        const section = api.slice(start, end);
        for (const word of ['sandbox view', 'content.image()', 'GUEST_IMAGE_TYPES', 'signature', '<img>', 'content.save()', 'application/octet-stream', '.download', 'content.bytes()', 'target="_blank"', '<iframe>', '<object>', 'location']) expect(section, word).toContain(word);
        const recipe = api.slice(api.indexOf('### Images the app makes'), api.indexOf('### Input'));
        for (const word of ['createObjectURL', 'write.content.image()', 'write.content.save()']) expect(recipe, word).toContain(word);
        expect(recipe).not.toMatch(/type: (?:write|w)\.type/);
        expect(recipe, 'the embedder names no saved file').not.toContain('.download =');
    });
});
