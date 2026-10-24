import { describe, expect, it } from 'vitest';
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
    });

    it('docs/API.md says it where the guest-writes surface is described too', () => {
        const paragraph = paragraphWith(read('docs/API.md'), 'Treat written content as the guest');
        for (const word of ['path', 'type', 'textContent', 'single-quoted attribute']) expect(paragraph, word).toContain(word);
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
