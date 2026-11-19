// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSizeOf } from '@src/lib/structured-size';

/**
 * What docs/API.md states about the byte measure is what the measure counts (BD3:DOC-11, class P with D: a doc's copy of
 * a constant). Each constant the paragraph "What the byte measure counts" states is measured here on a sample of its kind,
 * and the paragraph must state it; a kind it refuses is refused by the measure.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const squash = (text: string) => text.replace(/\s+/g, ' ');
const API = squash(readFileSync(path.join(ROOT, 'docs/API.md'), 'utf8'));
const PARAGRAPH = API.slice(API.indexOf('**What the byte measure counts.**'), API.indexOf("never an array's `length`.", API.indexOf('**What the byte measure counts.**')));
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

    it('the kinds it says are refused measure past every limit, their kind named: a Blob and a File among them (I7)', () => {
        expect(PARAGRAPH).toContain('Any other kind is refused as unsupported, with its kind named: an `Error`, an `ImageData`, a `SharedArrayBuffer`, a `Blob` or a `File`, and a resizable `ArrayBuffer` (`resizable ArrayBuffer`),');
        for (const value of [new Error('e'), new SharedArrayBuffer(8), new Blob([]), new File([], 'f'), new ArrayBuffer(8, { maxByteLength: 16 })]) {
            const unsupported = { kind: '' };
            expect(measure(value, Infinity, undefined, unsupported)).toBe(Infinity);
            expect(unsupported.kind).not.toBe('');
        }
    });
});
