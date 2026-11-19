/**
 * Review 3, probe 5 (I7): the one measure against the places a Blob or a File can hide in a snapshot, and against the
 * other kinds the allow-list does not name. Each value is structured-cloned first (Node's structuredClone, which carries
 * Node's Blob and File), as every sender and receiver measures a clone. Run:
 *   bunx vitest run -c docs/design/review-3/vitest.config.ts
 */
import { describe, it, expect } from 'vitest';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { createSizeOf } from '@src/lib/structured-size';

const sizeOf = createSizeOf();
const LIMIT = 1 << 20;
const measure = (value: unknown) => {
    const unsupported = { kind: '' };
    const bytes = sizeOf(structuredClone(value), LIMIT, undefined, unsupported);
    return { bytes, kind: unsupported.kind };
};

describe('I7 under attack: a Blob or a File anywhere in a snapshot is refused', () => {
    const blob = new NodeBlob(['<svg/>'], { type: 'image/svg+xml' });
    const file = new NodeFile(['<svg/>'], 'evil.svg', { type: 'image/svg+xml' });
    const places: [string, (x: unknown) => unknown][] = [
        ['alone', x => x],
        ['in an own key named __proto__', x => JSON.parse('{"__proto__": 1}') && Object.defineProperty({}, '__proto__', { value: x, enumerable: true })],
        ['in a non-index key of an array', x => Object.assign([1, 2], { extra: x })],
        ['at a high index of a sparse array', x => { const a: unknown[] = []; a[100_000] = x; return a; }],
        ['as a Map key', x => new Map([[x, 1]])],
        ['as a Map value, deep', x => new Map([[1, new Map([[2, [x]]])]])],
        ['in a Set', x => new Set([1, x])],
        ['behind a cycle', x => { const o: any = { x }; o.self = o; return [o, o]; }],
        ['as an Error cause', x => new Error('m', { cause: x })],
        ['in an AggregateError', x => new AggregateError([x], 'm')],
    ];
    for (const [label, put] of places) {
        it(`a Blob ${label}`, () => expect(measure(put(blob)).bytes).toBe(Infinity));
        it(`a File ${label}`, () => expect(measure(put(file)).bytes).toBe(Infinity));
    }

    it('the kinds beside them: an Error alone, a DOMException, a detached and a resizable buffer, a typed array over a resizable buffer', () => {
        const clonedError = structuredClone(new Error('m'));
        console.log(`[review-3] this environment's structuredClone of an Error: ${Object.prototype.toString.call(clonedError)}, its prototype is Object.prototype: ${Object.getPrototypeOf(clonedError) === Object.prototype}, own keys ${JSON.stringify(Object.getOwnPropertyNames(clonedError))}; the Error itself measures ${sizeOf(new Error('m'), LIMIT)}`);
        expect(sizeOf(new Error('m'), LIMIT)).toBe(Infinity);
        // (Node clones its DOMException as a plain object, which a browser does not: measured live here; the browsers'
        // clone is test/unit/snapshot-kinds.test.ts's and test/e2e/guest-blob-refused.spec.ts's subject)
        expect(sizeOf(new DOMException('m'), LIMIT)).toBe(Infinity);
        const detached = new ArrayBuffer(16);
        structuredClone(detached, { transfer: [detached] });
        expect(() => structuredClone(detached)).toThrow(/detached/); // a detached buffer never reaches a snapshot
        expect(sizeOf(detached, LIMIT)).toBe(16); // and measured live, it holds nothing: an object's 16, and 0 bytes
        const resizable = new (ArrayBuffer as any)(8, { maxByteLength: 1 << 30 });
        const cloned = structuredClone(resizable) as any;
        console.log(`[review-3] a resizable buffer of 8 bytes measures ${sizeOf(cloned, LIMIT)}; its clone keeps maxByteLength ${cloned.maxByteLength}, resizable ${cloned.resizable}`);
        expect(sizeOf(cloned, LIMIT)).toBeLessThan(LIMIT);
        expect(measure(new Uint8Array(resizable)).bytes).toBeLessThan(LIMIT);
    });

    it('positive control: the same containers with bytes in place of the Blob are measured, not refused', () => {
        for (const [label, put] of places) {
            if (label.includes('Error')) continue;
            expect(measure(put(new Uint8Array([1, 2, 3]))).bytes, label).toBeLessThan(LIMIT);
        }
    });
});
