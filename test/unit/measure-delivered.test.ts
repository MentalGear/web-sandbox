// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { createSizeOf } from '@src/lib/structured-size';
import { LOG_MAX_BYTES } from '@src/lib/sandbox-log';
import { LIMITS } from '@src/lib/limits';

/**
 * The byte measure counts what is delivered (S77, class P): for every kind a sender may post, the measured size of its
 * snapshot is at least the size of what the receiver is handed. The values here are measured as built: they hold no
 * getter and no Proxy, which is what a snapshot is, and Node's structuredClone turns a File into a Blob without its name,
 * so it cannot stand for the browsers' clone. test/e2e/exact-budget.spec.ts runs the same property on the clones and
 * message channels of Chromium, Firefox and WebKit. The node environment, because its Blob and File are the platform's.
 *
 * "Delivered" is stated here, apart from the measure, as the size of each kind's fields in the units the budgets use:
 * two bytes a UTF-16 code unit of a string, 8 a number, and 8 a slot of an array (a sparse array's receiver walks every
 * slot, however few hold an element).
 */

const sizeOf = createSizeOf();

// The kinds of the closed set that carry a string, a number or a length beyond what their own keys show.
type Leaf = { label: string; value: unknown; delivered: number };

const stringBytes = (text: string) => 2 * text.length + 8;
const file = (name: string, type: string, lastModified: number) => new File(['x'], name, { type, lastModified });
const sparse = (length: number, ...at: number[]) => {
    const array: unknown[] = [];
    array.length = length;
    for (const index of at) array[index] = 1;
    return array;
};

// a Blob's or a File's type is a lowercase ASCII string without control characters (anything else is dropped to '')
const typeText = fc.stringMatching(/^[a-z]{1,8}\/[a-z0-9;=.+-]{0,200}$/);
const bigText = fc.oneof(fc.string({ maxLength: 64 }), fc.integer({ min: 0, max: 200000 }).map(n => 'n'.repeat(n)));

const leaf: fc.Arbitrary<Leaf> = fc.oneof(
    fc.tuple(bigText, typeText, fc.integer({ min: 0, max: 2 ** 40 })).map(([name, type, modified]): Leaf => {
        const value = file(name, type, modified);
        return { label: 'File', value, delivered: stringBytes(value.name) + stringBytes(value.type) + 8 };
    }),
    typeText.map((type): Leaf => {
        const value = new Blob(['x'], { type });
        return { label: 'Blob', value, delivered: stringBytes(value.type) };
    }),
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

    it('a large File name or Blob type is past a limit like the string of the same length, though it holds no bytes', () => {
        const name = 'x'.repeat(2 ** 22);
        expect(sizeOf(file(name, '', 0), LOG_MAX_BYTES)).toBeGreaterThan(LOG_MAX_BYTES);
        expect(sizeOf(file(name, '', 0), Infinity)).toBeGreaterThanOrEqual(sizeOf(name, Infinity));
        const type = 'a/' + 'b'.repeat(2 ** 22);
        expect(sizeOf(new Blob([], { type }), LOG_MAX_BYTES)).toBeGreaterThan(LOG_MAX_BYTES);
        // the controls: a File and a Blob of ordinary names and types are within it
        expect(sizeOf(file('photo.png', 'image/png', 1), LOG_MAX_BYTES)).toBeLessThan(1024);
        expect(sizeOf(new Blob(['x'], { type: 'text/plain' }), LOG_MAX_BYTES)).toBeLessThan(1024);
    });

    it('a Blob or File type past BLOB_TYPE_MAX_LENGTH is over every limit, whatever an engine would keep of it; up to it, it is counted like a string', () => {
        const max = LIMITS.BLOB_TYPE_MAX_LENGTH.value;
        const typed = (length: number) => 'a/' + 'b'.repeat(length - 2);
        for (const make of [(type: string) => new Blob([], { type }), (type: string) => file('f', type, 0)]) {
            const at = make(typed(max));
            expect(sizeOf(at, Infinity)).toBeLessThan(2 * max + 1024);
            expect(sizeOf(at, Infinity)).toBeGreaterThanOrEqual(2 * max);
            // one character more: Infinity, with a limit far above it, in a Map and in an array
            for (const over of [make(typed(max + 1)), make(typed(65535)), make(typed(2 ** 20))]) {
                expect(sizeOf(over, Infinity)).toBe(Infinity);
                expect(sizeOf(over, 2 ** 30)).toBe(Infinity);
                expect(sizeOf([new Map([['k', over]])], 2 ** 30)).toBe(Infinity);
            }
        }
        // the refusal says "past the budget", not "unsupported value": the kind is one the measure knows
        const unsupported = { kind: '' };
        expect(sizeOf(new Blob([], { type: typed(max + 1) }), 2 ** 30, undefined, unsupported)).toBe(Infinity);
        expect(unsupported.kind).toBe('');
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

// The structural half (S77, fix 3): every string-valued property a Blob and a File expose is counted by the measure or
// declared not serialized, so a field a future engine adds, or a kind with a field nobody counted, fails here.
describe('the Blob and File fields: every string-valued getter is counted or declared not serialized', () => {
    const COUNTED: Record<string, string> = { type: 'Blob', name: 'File' };
    const NOT_SERIALIZED = ['webkitRelativePath']; // the HTML spec's serialization of a File does not carry it
    const stringGetters = (instance: object): string[] => {
        const names = new Set<string>();
        for (let proto = Object.getPrototypeOf(instance); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
            for (const name of Object.getOwnPropertyNames(proto)) {
                const descriptor = Object.getOwnPropertyDescriptor(proto, name)!;
                if (!descriptor.get) continue;
                try {
                    if (typeof descriptor.get.call(instance) === 'string') names.add(name);
                } catch {
                    // not a getter of this instance
                }
            }
        }
        return [...names];
    };

    for (const [kind, make] of [['Blob', () => new Blob(['x'], { type: 'text/plain' })], ['File', () => file('f.txt', 'text/plain', 1)]] as const) {
        it(`${kind}: its string-valued getters are counted or declared`, () => {
            const found = stringGetters(make());
            expect(found.length).toBeGreaterThan(0);
            for (const name of found) expect(Object.keys(COUNTED).includes(name) || NOT_SERIALIZED.includes(name), `${kind}.${name}`).toBe(true);
        });

        it(`${kind}: each counted field moves the measure by its own length`, () => {
            const long = 'a'.repeat(1 << 20);
            const type = 'text/' + long;
            const value = kind === 'Blob' ? new Blob(['x'], { type }) : new File(['x'], long, { type });
            const bytes = sizeOf(value, Infinity);
            expect(bytes).toBeGreaterThanOrEqual(2 * value.type.length);
            if (kind === 'File') expect(bytes).toBeGreaterThanOrEqual(2 * value.type.length + 2 * (value as File).name.length);
        });
    }
});

describe('the measure is exact, not only a bound from below (BD3:TST-4, class P)', () => {
    // The property tests above hold the measure to "at least what is delivered", and a Blob or File carries 16 + 64 of slack,
    // so a constant under that could be dropped unseen. These are the constants themselves, in bytes: every object 16, a
    // Blob's handle 64, a File's lastModified 8, a Map entry 16, a Set entry 8.
    it.each([
        ['an empty Blob', () => new Blob([]), 16 + 64 + 0 + 8],
        ['a typed Blob (type "a/b")', () => new Blob([], { type: 'a/b' }), 16 + 64 + 6 + 8],
        ['a File named "n" (lastModified is counted: 8)', () => new File([], 'n', { lastModified: 1 }), 16 + 64 + 0 + 8 + (2 + 8) + 8],
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
