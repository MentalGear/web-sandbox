// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '@src/lib/limits';
import { createSizeOf } from '@src/lib/structured-size';

/**
 * What docs/API.md states about the byte measure is what the measure counts (BD3:DOC-11, class P with D: a doc's copy of
 * a constant). Each constant the paragraph "What the byte measure counts" states is measured here on a sample of its kind,
 * and the paragraph must state it; the Blob-type limit is stated as the library's for the types the engines keep.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const squash = (text: string) => text.replace(/\s+/g, ' ');
const API = squash(readFileSync(path.join(ROOT, 'docs/API.md'), 'utf8'));
const PARAGRAPH = API.slice(API.indexOf('**What the byte measure counts.**'), API.indexOf('A type of up to 4096 characters crosses on every engine.'));
const measure = createSizeOf();
const sizeOf = (value: unknown) => measure(value, Infinity);

describe('the constants of the byte measure that docs/API.md states', () => {
    it('finds the paragraph', () => {
        expect(PARAGRAPH.length).toBeGreaterThan(800);
    });

    // [what the paragraph says, a sample, the bytes the measure gives it]
    const STATED: Array<[string, unknown, number]> = [
        ['Every object, of any kind, costs 16', {}, 16],
        ['a `Date` nothing more', new Date(0), 16],
        ['a string costs two bytes a code unit plus 8'.replace('a string', 'A string'), 'abc', 2 * 3 + 8],
        ['any other primitive 8', 1.5, 8],
        ["a `BigInt` its two's-complement bytes plus 8", 15n, 1 + 8],
        ['a `Map` 16 an entry and its key and value', new Map([[1, 2]]), 16 + 16 + 8 + 8],
        ['a `Set` 8 an entry and its value', new Set([1]), 16 + 8 + 8],
        ['a `RegExp` two bytes a character of its source plus 24', /ab/, 16 + 2 * 2 + 24],
        ['an `ArrayBuffer` its byte length', new ArrayBuffer(10), 16 + 10],
        ['a typed array or a `DataView` its whole buffer, once', new Uint8Array(new ArrayBuffer(10), 2, 3), 16 + 10],
        ['a `Blob` 64 plus its `type` like a string', new Blob([], { type: 'text/a' }), 16 + 64 + 2 * 6 + 8],
        ['a `File` that plus its `name` like a string and 8 for `lastModified`', new File([], 'ab', { type: 'text/a' }), 16 + 64 + 2 * 6 + 8 + (2 * 2 + 8) + 8],
    ];

    it.each(STATED)('%s', (statement, value, bytes) => {
        expect(PARAGRAPH, 'the paragraph states it').toContain(statement);
        expect(sizeOf(value), 'and the measure counts it').toBe(bytes);
    });

    it('an object met again costs 8', () => {
        const shared = {};
        const once = sizeOf([shared]);
        const twice = sizeOf([shared, shared]);
        // the second slot adds its key and the repeated object: 2 * 1 + 8 for the key '1' plus the 8 of an object met again
        expect(twice - once).toBe(2 * 1 + 8 + 8);
        expect(PARAGRAPH).toContain('an object met again 8');
    });

    it('the Blob type limit is stated as the engines\' behaviour says: the library\'s for the types an engine keeps, with Chromium\'s emptying named', () => {
        expect(LIMITS.BLOB_TYPE_MAX_LENGTH.value).toBe(4096);
        const label = LIMITS.BLOB_TYPE_MAX_LENGTH.label;
        expect(label).toContain('on every engine that keeps the type');
        expect(label).toContain('Chromium empties');
        expect(API).toContain('on every engine that keeps the type: Chromium empties a type of 65 536 characters or more');
        expect(API).not.toContain('is over every byte budget, on every engine, and is refused');
    });
});
