/**
 * A guest write's content as the embedder gets it (design 02, "GuestBytes"; I9): the bytes the guest wrote, with four
 * named ways out in place of a raw `Uint8Array`. The two common needs, showing an image the app made and offering a file
 * for download, are steps the library takes itself, so the type a `Blob` of guest bytes gets and the name a saved file
 * gets are the library's:
 *   - image() answers a `Blob` only for bytes that begin with a signature of GUEST_IMAGE_SIGNATURES, typed as that row's
 *     type, whatever the path says. Each type is a raster image, which a browser only decodes; never SVG, a document
 *     that runs script when its `blob:` URL is opened. A polyglot (an image signature followed by markup or script) is
 *     typed as the image, and so is only decoded.
 *   - save() has the browser save the bytes as an `application/octet-stream` blob (FALLBACK_TYPE), which every engine
 *     saves and none renders (review 2, finding 3: p2-output.txt), under savedName(path). The name is the library's
 *     attribute on the library's link: Chromium and WebKit ignore a `File`'s own name when saving it, so handing the
 *     embedder a named `File` would leave the name to the embedder's `download` attribute, naturally the guest's path.
 *   - bytes() is the one raw way out: a fresh copy each call, so nothing the embedder does to it reaches the entry or
 *     what a commit stores (guest-writes.ts commits the entry's bytes, never anything read back from a value).
 *
 * Host-realm code handed to the embedder: it runs with the host page's built-ins, which are the embedder's to keep.
 * Each value is frozen and holds the write's bytes without copying them; nothing here changes them.
 */
import type { RASTER_IMAGE_TYPES } from './in-sandbox-view';
import { FALLBACK_TYPE, INERT_TYPES, mimeTypeFor } from './files';
import type { Holds } from './utils';

/**
 * The types {@link GuestBytes}'s `image()` can answer a `Blob` of: the raster images, which a browser only decodes, and
 * opened on their own are an image, never a document. SVG is not one.
 */
export const GUEST_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'] as const;

/** One type of {@link GUEST_IMAGE_TYPES}. */
export type GuestImageType = (typeof GUEST_IMAGE_TYPES)[number];

// GUEST_IMAGE_TYPES and the types the view mints a URL for from a guest write (RASTER_IMAGE_TYPES) are one set: the
// build fails if either gains a type the other lacks.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : { differ: [A, B] }) : { differ: [A, B] };
type GuestImageTypesAreTheViewsRasterTypes = Holds<Same<GuestImageType, (typeof RASTER_IMAGE_TYPES)[number]>>;

/** One byte of a signature: its value, or null for any byte (a length field). */
export type SignatureByte = number | null;

const ascii = (text: string): number[] => {
    const codes: number[] = [];
    for (let i = 0; i < text.length; i++) codes.push(text.charCodeAt(i));
    return codes;
};
const ANY_4 = [null, null, null, null];

/**
 * The signatures image() recognises, one row per type of GUEST_IMAGE_TYPES (the `satisfies` makes the rows exactly those
 * types): bytes that begin with one of a row's signatures are that type. WebP is a RIFF container with the form type
 * `WEBP`; AVIF an ISO media file whose `ftyp` box names the major brand `avif` (a still image) or `avis` (a sequence).
 */
export const GUEST_IMAGE_SIGNATURES = {
    'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    'image/jpeg': [[0xff, 0xd8, 0xff]],
    'image/gif': [ascii('GIF87a'), ascii('GIF89a')],
    'image/webp': [[...ascii('RIFF'), ...ANY_4, ...ascii('WEBP')]],
    'image/avif': [[...ANY_4, ...ascii('ftypavif')], [...ANY_4, ...ascii('ftypavis')]],
} as const satisfies Readonly<Record<GuestImageType, readonly (readonly SignatureByte[])[]>>;

/**
 * A guest write's bytes (`GuestWrite.content`), with the ways out the library names. The bytes are the guest's:
 * attacker data, whatever the path says they are.
 *
 * @remarks
 * Each value is frozen and made by the element with the {@link GuestWrite} it belongs to. Show an image the app made with
 * `image()`, in an `<img>` only; offer anything else with `save()`. `bytes()` hands out the raw bytes, and a `Blob` of
 * them typed by the write's `type`, or by no type, is a document of your origin when its URL is opened (an SVG or HTML
 * file runs script there): that step is yours to avoid.
 */
export interface GuestBytes {
    /** The number of bytes, as `bytes()` would hand them out. */
    readonly size: number;
    /**
     * The raw bytes: a copy each call, which you may change without changing the write or what a commit stores.
     *
     * @returns A new `Uint8Array` of the bytes the guest wrote.
     */
    bytes(): Uint8Array;
    /**
     * The bytes decoded as UTF-8, a malformed sequence as U+FFFD; a leading byte order mark is dropped.
     *
     * @returns The guest's text: attacker text, to show with `textContent`.
     */
    text(): string;
    /**
     * The bytes as an image, when they begin with the signature of one of {@link GUEST_IMAGE_TYPES}, whatever the path's
     * extension.
     *
     * @remarks
     * Bytes that hold more after a signature (markup or script behind a PNG header) are still typed as the image, which a
     * browser only decodes. Never SVG.
     *
     * @returns A `Blob` of the bytes typed as the image the signature names, or `null` for bytes of any other kind.
     */
    image(): Blob | null;
    /**
     * Has the browser save the bytes as a file, under a name the library chose: the last segment of the write's path when
     * its extension is one of an inert type, otherwise that segment with `.download` added (`report.html` is saved as
     * `report.html.download`, `invoice.pdf.exe` as `invoice.pdf.exe.download`).
     *
     * @remarks
     * The library clicks a link of its own to an `application/octet-stream` blob, which a browser saves and does not
     * render, and revokes the blob's URL. Nothing navigates. Whether the browser asks the user, saves at once or blocks
     * repeated downloads is the browser's.
     */
    save(): void;
}

/** The type of GUEST_IMAGE_TYPES whose signature `bytes` begin with, or null. */
export function imageTypeOf(bytes: Uint8Array): GuestImageType | null {
    for (const type of GUEST_IMAGE_TYPES) {
        const signatures: readonly (readonly SignatureByte[])[] = GUEST_IMAGE_SIGNATURES[type];
        for (const signature of signatures) if (beginsWith(bytes, signature)) return type;
    }
    return null;
}

function beginsWith(bytes: Uint8Array, signature: readonly SignatureByte[]): boolean {
    if (bytes.length < signature.length) return false;
    for (let i = 0; i < signature.length; i++) {
        const expected = signature[i];
        if (expected !== null && bytes[i] !== expected) return false;
    }
    return true;
}

/** The suffix savedName() adds to a name whose extension is not inert. */
export const SAVED_NAME_SUFFIX = '.download';

/**
 * The name save() gives the file of a write at `path` (a valid path): its last segment, with SAVED_NAME_SUFFIX added
 * unless its extension is one of INERT_TYPES's (FILE_TYPES, case-insensitive, as the write's type is found). No
 * extension, a dotfile and an extension the table does not have are not inert.
 */
export function savedName(path: string): string {
    const segment = path.slice(path.lastIndexOf('/') + 1);
    if (INERT_TYPES.has(mimeTypeFor(segment))) return segment;
    return segment + SAVED_NAME_SUFFIX;
}

/** The value of one write's bytes (guest-writes.ts, mint), frozen; `bytes` is the entry's and is only read. */
export function guestBytes(path: string, bytes: Uint8Array): GuestBytes {
    return Object.freeze({
        size: bytes.length,
        bytes: () => bytes.slice(),
        text: () => new TextDecoder().decode(bytes),
        image: () => imageOf(bytes),
        save: () => saveAs(bytes, savedName(path)),
    });
}

function imageOf(bytes: Uint8Array): Blob | null {
    const type = imageTypeOf(bytes);
    if (type === null) return null;
    return new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
}

/**
 * The library's own link: an object URL of an `application/octet-stream` blob, a `download` attribute of the library's,
 * clicked once and never put in a document, its URL revoked. Neither the guest nor the embedder names the file or its type.
 */
function saveAs(bytes: Uint8Array, name: string): void {
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: FALLBACK_TYPE }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
}
