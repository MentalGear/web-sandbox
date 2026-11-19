import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { FALLBACK_TYPE, FILE_TYPES, FileStore, mimeTypeFor, type FileTypeRow } from '@src/lib/files';
import { createGuestWrites, INERT_TYPES } from '@src/lib/guest-writes';

/**
 * A guest write's type comes from its path (I8, design 02 "A guest write's type comes from its path"): FILE_TYPES
 * (files.ts) is the one table of types and of which writes commit without `{ code: true }`, and a write's type is that
 * table's for its path's extension, or FALLBACK_TYPE. Every row is run here, as a path, as a guest write and as a commit;
 * then every way a guest could claim a type of its own is shown to change nothing: the claim is refused, never believed.
 */

const ROWS = Object.entries(FILE_TYPES) as [string, FileTypeRow][];

const refusal = (fn: () => unknown): unknown => {
    try {
        fn();
    } catch (e: any) {
        return e?.code;
    }
    return 'not refused';
};

// An element's store and one environment's overlay over it.
function overlay() {
    const store = new FileStore(() => {});
    const writes = createGuestWrites({ store, now: () => 0 });
    return { store, writes };
}

describe('FILE_TYPES: every row, as a path (I8)', () => {
    it.each(ROWS)('.%s: its type, in any case of the extension, in any directory; and nothing else gives it', (extension, row) => {
        for (const path of [`f.${extension}`, `dir/sub/f.${extension}`, `f.${extension.toUpperCase()}`, `a.b.${extension}`]) expect(mimeTypeFor(path), path).toBe(row.type);
        // the extension is the last segment's last one: a second extension after it, a dotfile, a directory's dot
        for (const path of [`f.${extension}.zz`, `.${extension}`, `d.${extension}/f`]) expect(mimeTypeFor(path), path).toBe(FALLBACK_TYPE);
    });

    it('a path without an extension the table has is FALLBACK_TYPE, which is never inert', () => {
        for (const path of ['noext', 'f.', 'f.unknown', 'f.html5', 'f.p n g', '.env']) expect(mimeTypeFor(path), path).toBe(FALLBACK_TYPE);
        expect(FALLBACK_TYPE).toBe('application/octet-stream');
        expect(INERT_TYPES.has(FALLBACK_TYPE)).toBe(false);
    });

    it('the keys are lower case, and rows that share a type agree on whether it is inert', () => {
        const inert = new Map<string, boolean>();
        for (const [extension, row] of ROWS) {
            expect(extension).toBe(extension.toLowerCase());
            if (inert.has(row.type)) expect(inert.get(row.type), row.type).toBe(row.inert);
            inert.set(row.type, row.inert);
        }
    });

    it('INERT_TYPES is exactly the types of the inert rows', () => {
        const expected = new Set<string>();
        for (const [, row] of ROWS) if (row.inert) expected.add(row.type);
        expect([...INERT_TYPES].sort()).toEqual([...expected].sort());
    });

    it('the types that run or are parsed as documents are not inert', () => {
        for (const type of ['text/javascript', 'text/html', 'image/svg+xml', 'application/xml', 'application/wasm']) {
            const rows = ROWS.filter(([, row]) => row.type === type);
            expect(rows.length, type).toBeGreaterThan(0);
            for (const [extension, row] of rows) expect(row.inert, extension).toBe(false);
        }
    });
});

describe('FILE_TYPES: every row, as a guest write and its commit (I8)', () => {
    it.each(ROWS)('.%s: recorded with its type; committed without { code: true } exactly when the row is inert', (extension, row) => {
        const { store, writes } = overlay();
        const path = `w/f.${extension}`;
        expect(writes.handle({ change: 'write', path, entry: 'x' })).toEqual({ path, change: 'write', type: row.type, size: 1 });
        expect(writes.list()).toMatchObject([{ path, type: row.type }]);
        if (row.inert) expect(writes.commit([path], false)).toEqual([path]);
        else {
            expect(refusal(() => writes.commit([path], false))).toBe('FILES_NOT_ALLOWED');
            expect(writes.commit([path], true)).toEqual([path]);
        }
        expect(store.list()).toMatchObject([{ path, type: row.type }]);
    });

    it('evil.html is text/html, needs { code: true } to commit, and is stored as text/html', () => {
        const { store, writes } = overlay();
        expect(writes.handle({ change: 'write', path: 'evil.html', entry: new TextEncoder().encode('<script>1</script>') })).toMatchObject({ type: 'text/html' });
        expect(refusal(() => writes.commit(['evil.html'], false))).toBe('FILES_NOT_ALLOWED');
        expect(store.list()).toEqual([]);
        expect(writes.commit(['evil.html'], true)).toEqual(['evil.html']);
        expect(store.list()).toMatchObject([{ path: 'evil.html', type: 'text/html' }]);
    });
});

describe('a claimed type cannot disagree with the path (I8)', () => {
    const CLAIMS = [...new Set([...ROWS.map(([, row]) => row.type), 'image/png', 'text/plain', 'Image/PNG', 'application/octet-stream'])];

    it.each(ROWS)('.%s: a write that carries a type beside its bytes is refused INVALID_FILE, whatever the type, and records nothing', (extension) => {
        const { writes } = overlay();
        for (const type of CLAIMS) {
            for (const content of ['x', new Uint8Array([1])]) {
                expect(refusal(() => writes.handle({ change: 'write', path: `f.${extension}`, entry: { content, type } })), type).toBe('INVALID_FILE');
            }
        }
        expect(writes.list()).toEqual([]);
    });

    it('any request: what is recorded at a path has the path\'s type, whatever else the request carries', () => {
        const extensions = [...ROWS.map(([extension]) => extension), 'unknown', ''];
        const path = fc.tuple(fc.constantFrom(...extensions), fc.boolean()).map(([extension, upper]) => (extension ? `p.${upper ? extension.toUpperCase() : extension}` : 'p'));
        const claim = fc.constantFrom(...CLAIMS);
        const entry = fc.oneof(
            fc.constantFrom<unknown>('x', new Uint8Array([1, 2])),
            claim.map(type => ({ content: 'x', type })),
            claim.map(type => ({ content: new Uint8Array([1]), type, mimeType: type })),
        );
        const request = fc.record({ path, entry, type: claim, contentType: claim, mime: claim }, { requiredKeys: ['path', 'entry'] });
        fc.assert(fc.property(fc.array(request, { minLength: 1, maxLength: 8 }), (requests) => {
            const { writes } = overlay();
            for (const r of requests) {
                try {
                    writes.handle({ change: 'write', ...r });
                } catch {
                    // refused: nothing recorded for it
                }
            }
            return writes.list().every(write => write.change === 'write' && write.type === mimeTypeFor(write.path));
        }), { numRuns: 300 });
    });
});
