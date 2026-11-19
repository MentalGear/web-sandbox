// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { createSizeOf } from '@src/lib/structured-size';
import { LOG_MAX_BYTES } from '@src/lib/sandbox-log';

/**
 * The byte measure counts what is delivered (S77, class P): for every kind a sender may post, the measured size of its
 * snapshot is at least the size of what the receiver is handed. The values here are measured as built: they hold no
 * getter and no Proxy, which is what a snapshot is. test/e2e/exact-budget.spec.ts runs the same property on the clones and
 * message channels of Chromium, Firefox and WebKit. A `Blob` or a `File` is not of the closed set (I7):
 * test/unit/snapshot-kinds.test.ts enumerates the kinds.
 *
 * "Delivered" is stated here, apart from the measure, as the size of each kind's fields in the units the budgets use:
 * two bytes a UTF-16 code unit of a string, 8 a number, and 8 a slot of an array (a sparse array's receiver walks every
 * slot, however few hold an element).
 */

const sizeOf = createSizeOf();

// The kinds of the closed set that carry a string, a number or a length beyond what their own keys show.
type Leaf = { label: string; value: unknown; delivered: number };

const stringBytes = (text: string) => 2 * text.length + 8;
const sparse = (length: number, ...at: number[]) => {
    const array: unknown[] = [];
    array.length = length;
    for (const index of at) array[index] = 1;
    return array;
};

const bigText = fc.oneof(fc.string({ maxLength: 64 }), fc.integer({ min: 0, max: 200000 }).map(n => 'n'.repeat(n)));

const leaf: fc.Arbitrary<Leaf> = fc.oneof(
    fc.integer({ min: 0, max: 2 ** 32 - 1 }).chain(length => fc.array(fc.integer({ min: 0, max: Math.max(0, length - 1) }), { maxLength: 6 }).map((at): Leaf => {
        const value = sparse(length, ...(length > 0 ? at : []));
        return { label: 'sparse array', value, delivered: 8 * length };
    })),
    fc.array(fc.nat(), { maxLength: 50 }).map((value): Leaf => ({ label: 'array', value, delivered: 8 * value.length })),
    bigText.map((value): Leaf => ({ label: 'string', value, delivered: stringBytes(value) })),
    fc.uint8Array({ maxLength: 4096 }).map((value): Leaf => ({ label: 'Uint8Array', value, delivered: value.byteLength })),
    fc.constantFrom<Leaf>(
        { label: 'number', value: 1.5, delivered: 8 },
        { label: 'Date', value: new Date(0), delivered: 8 },
        { label: 'RegExp', value: /a+/gi, delivered: stringBytes('a+') },
        { label: 'Map', value: new Map([['k', 'v']]), delivered: stringBytes('k') + stringBytes('v') },
        { label: 'Set', value: new Set(['v']), delivered: stringBytes('v') },
    ),
);

// a leaf alone, or inside an array, an object, a Map's value or a Set
const placed = leaf.chain(({ value, delivered, label }) => fc.constantFrom<Leaf>(
    { label, value, delivered },
    { label: `[${label}]`, value: [value], delivered: delivered + 8 },
    { label: `{${label}}`, value: { k: value }, delivered: delivered + stringBytes('k') },
    { label: `Map<${label}>`, value: new Map([['k', value]]), delivered },
    { label: `Set<${label}>`, value: new Set([value]), delivered },
));

describe('the measure counts at least what is delivered, for every supported kind (S77)', () => {
    it('any value of the closed set, alone or inside another: the snapshot measures at least its delivered size, and the walk never throws', () => {
        fc.assert(fc.property(placed, ({ value, delivered }) => {
            return sizeOf(value, Infinity) >= delivered;
        }), { numRuns: 600 });
    });

    it('a sparse array is charged by its length: 2**32 - 1 slots with one element are past every limit, and the walk answers without listing its keys', () => {
        const wide = sparse(2 ** 32 - 1, 5);
        expect(sizeOf(wide, LOG_MAX_BYTES)).toBeGreaterThan(LOG_MAX_BYTES);
        expect(sizeOf(wide, Infinity)).toBeGreaterThanOrEqual(8 * (2 ** 32 - 1));
        expect(sizeOf([wide, 'next'], 1024)).toBeGreaterThan(1024);
        // the bound where length alone exceeds LOG_MAX_BYTES: about 131 000 slots
        expect(sizeOf(sparse(Math.floor(LOG_MAX_BYTES / 8) + 1), LOG_MAX_BYTES)).toBeGreaterThan(LOG_MAX_BYTES);
        expect(sizeOf(sparse(1000, 3), LOG_MAX_BYTES)).toBeGreaterThanOrEqual(8000);
        expect(sizeOf(sparse(1000, 3), LOG_MAX_BYTES)).toBeLessThan(LOG_MAX_BYTES);
        // a dense array is charged as before: by its elements
        expect(sizeOf([1, 2, 3], Infinity)).toBe(16 + 3 * (2 * 1 + 8 + 8));
    });
});

describe('the measure is exact, not only a bound from below (BD3:TST-4, class P)', () => {
    // The property tests above hold the measure to "at least what is delivered", so a constant under the slack of a kind
    // could be dropped unseen. These are the constants themselves, in bytes: every object 16, a Map entry 16, a Set entry 8.
    it.each([
        ['an empty object', () => ({}), 16],
        ['a Map with one entry of two empty strings (16 an entry)', () => new Map([['', '']]), 16 + 16 + 8 + 8],
        ['a Set with one number (8 an entry)', () => new Set([1]), 16 + 8 + 8],
    ] as const)('%s', (_, make, bytes) => {
        expect(sizeOf(make(), Infinity)).toBe(bytes);
    });

    it('a BigInt past the limit is Infinity at once: the cap decides before its digits are written out (2**26 bits)', () => {
        const big = (1n << (2n ** 26n)) - 1n;
        const toString = vi.spyOn(BigInt.prototype, 'toString');
        try {
            // the measure takes the text function when it is made, so it is made under the spy
            expect(createSizeOf()(big, LOG_MAX_BYTES)).toBe(Infinity);
            expect(toString).not.toHaveBeenCalled();
        } finally {
            toString.mockRestore();
        }
    });

    it('a SharedArrayBuffer is never small, bare or as the buffer of a view: Infinity, its kind named', () => {
        const bare = { kind: '' };
        expect(sizeOf(new SharedArrayBuffer(8), LOG_MAX_BYTES, undefined, bare)).toBe(Infinity);
        expect(bare.kind).toBe('SharedArrayBuffer');
        const viewed = { kind: '' };
        expect(sizeOf(new Uint8Array(new SharedArrayBuffer(8)), LOG_MAX_BYTES, undefined, viewed)).toBe(Infinity);
        expect(viewed.kind).toBe('SharedArrayBuffer');
    });
});
