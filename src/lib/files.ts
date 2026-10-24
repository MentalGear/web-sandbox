/**
 * The host side of file delivery (backlog C1–C3, ADR-004): path validation, the MIME table and the
 * store that lives on the element. Host-only: nothing here is stringified into the guest. The guest
 * side is src/lib/in-sandbox-files.ts, which receives a snapshot of this store as one literal.
 *
 * Files are part of the environment. The store survives reset(), load(), setConfig() and terminate();
 * every environment build takes a snapshot of it, and nothing reaches a guest that is already running.
 */

import { moduleSpecifierEdits, VIRTUAL_ROOT } from './module-specifiers';
import type { Complete, Holds } from './utils';
import { cssReferences, cssUrlReferences } from './css-references';
import { virtualPathOf } from './markup-references';
import { admits, type LoadKindName } from './load-kinds';

// The cap (backlog C3). Module constants rather than config: each value was measured to load in all
// three engines (test/e2e/files.spec.ts), so raise one only after that test passes at the new value.
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_FILES = 1000;
export const MAX_PATH_LENGTH = 256;

/** A file's content for `registerFiles()`: a string is stored as UTF-8, a `Uint8Array` is copied. */
export type FileContent = string | Uint8Array;
/**
 * One `registerFiles()` entry: the content, typed by its path's extension, or `{ content, type }` with an
 * explicit MIME type.
 */
export type FileEntry = FileContent | { content: FileContent; type: string };

/** One registered file, as `listFiles()` reports it. */
export interface FileInfo {
    /** The path it was registered under, e.g. `src/main.js`. */
    path: string;
    /** Its MIME type: given at registration, or from the extension (`application/octet-stream` when unknown). */
    type: string;
    /** Its size in bytes, as registered. */
    size: number;
}

/**
 * Why a change to the files was refused: the `code` of a {@link FileError}. The strings are API and, for guest writes,
 * wire protocol. They are not {@link RpcErrorCode} values: `registerFiles()`,
 * `unregisterFiles()` and `commitGuestWrites()` refuse the host's own caller, and a guest
 * write is refused by the host's library method.
 * - `INVALID_PATH`: a path is not valid, or a list of paths is not an array.
 * - `INVALID_FILE`: the batch is not an object, or an entry is not a string, a `Uint8Array` or `{ content, type }` with a
 *   valid type (for a guest write: not a write or a remove).
 * - `FILES_QUOTA_EXCEEDED`: the store after the change would exceed 1000 files or 8 MiB. A JavaScript file counts its
 *   registered bytes plus what its module rewrite adds, and a stylesheet its bytes plus what its references add.
 * - `FILES_NOT_ALLOWED`: an opt-in is missing, either a guest write while `guestWrites` is off or a commit of a file
 *   whose type is not inert without `{ code: true }`.
 * - `FILES_BUSY`: a guest write past the per-environment rate ({@link GUEST_WRITES_PER_SECOND},
 *   {@link GUEST_WRITE_BYTES_PER_SECOND}). Retryable.
 *
 * In the guest, every failed lookup is `NOT_FOUND`, which is not in this set.
 */
export type FileErrorCode = 'INVALID_PATH' | 'INVALID_FILE' | 'FILES_QUOTA_EXCEEDED' | 'FILES_NOT_ALLOWED' | 'FILES_BUSY';

/** Every FileErrorCode, as a value (S76): what docs/API.md's Files table lists, with the guest's NOT_FOUND. */
export const FILE_ERROR_CODES = ['INVALID_PATH', 'INVALID_FILE', 'FILES_QUOTA_EXCEEDED', 'FILES_NOT_ALLOWED', 'FILES_BUSY'] as const satisfies readonly FileErrorCode[];
type FileErrorCodesComplete = Holds<Complete<FileErrorCode, typeof FILE_ERROR_CODES>>;

/**
 * The guest's view of the registered files: the global `sandboxFiles`, present in every environment (empty when no file
 * is registered). Every failed lookup is an `Error` with `code: 'NOT_FOUND'`.
 *
 * @remarks
 * With `guestWrites` the guest's own writes, once the host acknowledged them, are part of this view; no URL is minted
 * for them. This interface is what the guest sees, so no host code implements it.
 */
export interface SandboxFiles {
    /**
     * The registered paths with the guest's acknowledged writes and removals applied.
     *
     * @returns The paths, sorted.
     */
    list(): string[];
    /**
     * The file's `blob:` URL, minted in the guest's own realm (the rewritten form of a module or stylesheet).
     *
     * @param path - A registered path.
     * @returns The URL.
     * @throws An `Error` with `code: 'NOT_FOUND'`, also for a path the guest wrote.
     */
    url(path: string): string;
    /**
     * The bytes as registered, or as the guest wrote them.
     *
     * @param path - A registered path or one the guest wrote.
     * @returns A fresh copy per call. Rejects with `NOT_FOUND` when there is no such file.
     */
    read(path: string): Promise<Uint8Array>;
    /**
     * The content as registered, or as the guest wrote it, decoded as UTF-8.
     *
     * @param path - A registered path or one the guest wrote.
     * @returns The text. Rejects with `NOT_FOUND` when there is no such file.
     */
    text(path: string): Promise<string>;
    /**
     * Asks the host to record a write. The guest's view changes only once the host has recorded it. The entry's bytes are
     * copied when this is called.
     *
     * @param path - The path to write.
     * @param entry - A string, a `Blob`, an `ArrayBuffer` or a typed array, or `{ content, type }`.
     * @returns Resolves once the host recorded the write. Rejects with the host's {@link FileErrorCode}, or with
     * `FILES_NOT_ALLOWED` without sending when `guestWrites` is off.
     */
    write(path: string, entry: unknown): Promise<void>;
    /**
     * Asks the host to record a removal.
     *
     * @param path - The path to remove.
     * @returns Resolves once the host recorded it. Rejects with `NOT_FOUND` for a path in neither the store nor the
     * guest's writes.
     */
    remove(path: string): Promise<void>;
}

/**
 * The shape of every refusal of the file methods: a plain `Error` with an own `code`. Branch on the code, never on the
 * message.
 */
export interface FileError extends Error {
    /** Why the change was refused. */
    code: FileErrorCode;
}

export function fileError(code: FileErrorCode, message: string): FileError {
    const error = new Error(`[Sandbox] ${message}`) as FileError;
    error.code = code;
    return error;
}

// One segment: the RFC 3986 unreserved and sub-delims characters, plus '@'. Nothing that a URL
// parser decodes, folds or treats as a delimiter: no %, \, :, ?, #, whitespace, controls or non-ASCII.
const SEGMENT = /^[A-Za-z0-9._~!$&'()*+,;=@-]+$/;
const ROUND_TRIP_BASE = 'https://vfs.invalid/';

/**
 * Whether `path` may name a file. Paths are validated, never normalised: a path the guest could
 * spell two ways, or that a URL parser would rewrite, is refused rather than repaired. So `a/./b`,
 * `a//b`, `/a` and `%2e%2e` are refused, and an accepted path is exactly what new URL() keeps.
 */
export function isValidPath(path: unknown): path is string {
    if (typeof path !== 'string') return false;
    if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;

    for (const segment of path.split('/')) {
        if (!SEGMENT.test(segment)) return false; // also refuses empty segments: leading, trailing or doubled '/'
        if (segment === '.' || segment === '..') return false;
    }

    // Belt and braces: the character rules above already imply this.
    return new URL(path, ROUND_TRIP_BASE).href === ROUND_TRIP_BASE + path;
}

// Never empty: a blob with an empty type is applied as a stylesheet by every engine
// (docs/archive/research/blob-delivery-probe.md, section 2), so an unknown file must not get one.
export const FALLBACK_TYPE = 'application/octet-stream';

const MIME_TYPES: Readonly<Record<string, string>> = {
    js: 'text/javascript',
    mjs: 'text/javascript',
    css: 'text/css',
    html: 'text/html',
    htm: 'text/html',
    json: 'application/json',
    map: 'application/json',
    xml: 'application/xml',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    vtt: 'text/vtt',
    wasm: 'application/wasm',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    mp4: 'video/mp4',
    webm: 'video/webm',
    ogv: 'video/ogg',
};

/**
 * Whether a file of this type is JavaScript: a script load admits it (load-kinds.ts, the one table), it loads
 * through script-src, and its module specifiers are rewritten. Only text/javascript comes from the extension table.
 */
export function isJavaScriptType(type: string): boolean {
    return admits('script', type);
}

/** Whether a file of this type is a stylesheet (load-kinds.ts): its url() and @import references are rewritten. */
export function isStylesheetType(type: string): boolean {
    return admits('style', type);
}

/** The type a file gets from its extension (case-insensitive), or FALLBACK_TYPE. Never empty. */
export function mimeTypeFor(path: string): string {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return FALLBACK_TYPE; // no extension, or a dotfile such as .env
    const extension = name.slice(dot + 1).toLowerCase();
    return Object.hasOwn(MIME_TYPES, extension) ? MIME_TYPES[extension]! : FALLBACK_TYPE;
}

// type "/" subtype, each an RFC 6838 restricted name. No parameters: a blob's type is the whole
// string, and `text/css;x` would only be another way to spell a type the CSP mapping has to know.
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

/** Whether `type` may override a file's type. */
export function isValidMimeType(type: unknown): type is string {
    return typeof type === 'string' && MIME_TYPE.test(type);
}

interface StoredFile {
    type: string;
    size: number; // registered bytes: what listFiles() reports and read() returns
    cost: number; // what counts against MAX_TOTAL_BYTES: size plus rewriteCost(edits) plus referenceCost(references)
    base64: string; // the bytes as registered, encoded once at registration: the snapshot needs nothing else
    edits: ByteEdits | null; // the module rewrite, for JavaScript files whose specifiers were rewritten
    references: CssReferenceRange[] | null; // a stylesheet's references that could name a file
}

/**
 * A slot in a stylesheet: the guest replaces the edit's range with a CSS string holding this file's
 * blob: URL (inSandboxFiles).
 */
export type FileSlot = [path: string];

/**
 * A rewrite as the guest receives it: flat triples [start, end, replacement, ...], where
 * [start, end) is a range of the registered BYTES (sorted, non-overlapping). The replacement is a text
 * (a JavaScript file's module rewrite) or a slot (a stylesheet's reference to a registered file). The
 * guest builds the delivered form from slices of the registered bytes and the replacements
 * (inSandboxFiles), so the literal carries the file once.
 */
export type ByteEdits = (number | string | FileSlot)[];

/**
 * One file as the guest bootstrap receives it: [path, type, base64], plus the rewrite for a JavaScript
 * file whose relative specifiers were rewritten (module-specifiers.ts) or a stylesheet whose references
 * name registered files (css-references.ts).
 */
export type FileSnapshotEntry = [path: string, type: string, base64: string] | [path: string, type: string, base64: string, edits: ByteEdits];

/**
 * A stylesheet's reference that could name a file, found at registration: [start, end) in the
 * registered bytes, the path it resolves to against the stylesheet's own virtual URL, and the kind of load it
 * makes (css-references.ts). Whether a file of an admitted type is registered at that path is decided per build,
 * in snapshot(): the store can change in between.
 */
export type CssReferenceRange = [start: number, end: number, path: string, kind: LoadKindName];

// What one rewritten specifier adds to the snapshot literal besides its text: two offsets of up to
// 8 digits, three commas and two quotes, rounded up.
const EDIT_OVERHEAD = 24;

/**
 * What a module rewrite adds to the snapshot literal, in bytes, counted against MAX_TOTAL_BYTES so the
 * literal never grows past what the cap is sized for: each edit's text plus EDIT_OVERHEAD. The
 * texts are JSON strings of URLs, so ASCII: their length is their size.
 */
export function rewriteCost(edits: ByteEdits | null): number {
    if (!edits) return 0;
    let cost = 0;
    for (let i = 2; i < edits.length; i += 3) cost += (edits[i] as string).length + EDIT_OVERHEAD;
    return cost;
}

// What a slot puts into the guest's stylesheet in place of its range: a CSS string holding a blob: URL
// of this realm, `"blob:null/<36-character UUID>"`, 48 characters (the guest's origin is opaque, so it
// serialises as "null"; nothing in the URL needs a CSS escape).
export const SLOT_URL_BYTES = 48;

/**
 * What a stylesheet's references add, in bytes, counted against MAX_TOTAL_BYTES: per reference that
 * could name a file, what the literal carries for its slot (the path, two offsets and separators:
 * path length plus EDIT_OVERHEAD) and what the guest's stylesheet holds in its place (SLOT_URL_BYTES).
 * Counted at registration for every such reference, registered target or not, so the cost of a file
 * never depends on what else is registered and the check stays atomic. Paths are ASCII.
 */
export function referenceCost(references: readonly CssReferenceRange[] | null): number {
    if (!references) return 0;
    let cost = 0;
    for (const [, , path] of references) cost += path.length + EDIT_OVERHEAD + SLOT_URL_BYTES;
    return cost;
}

/**
 * One file checked against the store's rules: a valid path, its bytes copied from the caller's data, and its
 * type as the store assigns it (the override, or the extension table). `CheckedFile.from()` is the only way to
 * make one (the constructor is private), so a value of this type has passed the same parseEntry() as every
 * registered file: the guest-write overlay keeps its writes in this form (guest-writes.ts), and the type it
 * shows the host and checks against the inert list is the very type the store will load the file as.
 */
export class CheckedFile {
    private constructor(readonly type: string, readonly bytes: Uint8Array) {}

    /** Checks `path` and `entry` (a FileEntry); throws INVALID_PATH or INVALID_FILE. `caller` names the API in messages. */
    static from(path: unknown, entry: unknown, caller: string): CheckedFile {
        if (!isValidPath(path)) throw fileError('INVALID_PATH', `${caller} refused the path ${describePath(path)}.`);
        const { type, bytes } = parseEntry(path, entry, caller);
        return new CheckedFile(type, bytes);
    }
}

/**
 * One change to the store, for FileStore.apply(): files to add or replace, and paths to remove. Every value of
 * `put` is a FileEntry or a CheckedFile, every key and every entry of `remove` is checked by isValidPath(). A
 * path may appear in one of the two only.
 */
export interface FileChanges {
    put?: ReadonlyMap<unknown, unknown>;
    remove?: readonly unknown[];
}

// A change that passed every check except the rewrite costs (FileStore._plan).
interface FilePlan {
    put: Map<string, CheckedFile>;
    remove: Set<string>;
    totalBytes: number; // the store's total cost after the change, counting each put file's registered bytes only
}

/**
 * The files of one element. Every mutation goes through apply(), which validates the whole change against
 * the store it would produce before changing anything, so a refused call leaves the store exactly as it was.
 * register(), unregister() and the guest-write commit (guest-writes.ts) are thin wrappers over it: path and
 * entry validation, types, refusal codes and the quota are one implementation.
 */
export class FileStore {
    private _files = new Map<string, StoredFile>();
    private _totalBytes = 0; // the sum of every file's cost
    private _warnedCycles = new Set<string>(); // reference cycles already warned about (snapshot)
    private _warnedKinds = new Set<string>(); // references to a file of a type their load does not admit, warned about (snapshot)

    // Lexer failures are reported here, once per registration of the file (console.warn by default).
    constructor(private readonly _warn: (message: string) => void = message => console.warn(message)) {}

    /**
     * Adds or replaces the given files. Returns the paths whose content or type changed (sorted);
     * re-registering an identical file changes nothing. Throws a FileError and changes nothing on refusal.
     */
    register(files: unknown): string[] {
        if (files === null || typeof files !== 'object' || Array.isArray(files)) {
            throw fileError('INVALID_FILE', 'registerFiles() expects an object mapping paths to file contents.');
        }
        return this.apply({ put: new Map(Object.entries(files)) }, 'registerFiles()');
    }

    /**
     * Removes the given paths, or every file when `paths` is undefined. Paths that are not registered
     * are ignored. Returns the paths removed (sorted). Throws INVALID_PATH and removes nothing if
     * `paths` is not an array of valid paths.
     */
    unregister(paths?: unknown): string[] {
        if (paths === undefined) return this.apply({ remove: [...this._files.keys()] }, 'unregisterFiles()');
        if (!Array.isArray(paths)) throw fileError('INVALID_PATH', 'unregisterFiles() expects an array of paths.');
        return this.apply({ remove: paths }, 'unregisterFiles()');
    }

    /**
     * A copy of the store as it is now, for one environment build (host.ts): the build's snapshot and the guest-write
     * overlay's answers come from it, never from the store as it changes afterwards. Cheap: stored files are never
     * mutated, only replaced. Warnings are shared with this store, so a build's snapshot warns once per element.
     */
    copy(): FileStore {
        const copy = new FileStore(this._warn);
        copy._files = new Map(this._files);
        copy._totalBytes = this._totalBytes;
        copy._warnedCycles = this._warnedCycles;
        copy._warnedKinds = this._warnedKinds;
        return copy;
    }

    /** Whether a file is stored at `path`. */
    has(path: string): boolean {
        return this._files.has(path);
    }

    /**
     * Checks a change without making it: every path and entry, the file count and the registered bytes against
     * MAX_TOTAL_BYTES, exactly as apply() does first, but without lexing (rewriteCost, referenceCost) or
     * encoding anything. Throws the refusal apply() would throw for those; apply() may still refuse the same
     * change for what the rewrites add. Used for a guest's write (guest-writes.ts), whose full check is its commit.
     */
    check(changes: FileChanges, caller: string): void {
        this._plan(changes, caller);
    }

    /**
     * The one mutation of the store: adds or replaces `changes.put` and removes `changes.remove` (paths not
     * stored are ignored), atomically. Returns the paths whose content or type changed or that were removed,
     * sorted; re-registering an identical file changes nothing. Throws a FileError and changes nothing on
     * refusal. `caller` names the public API in refusal messages.
     */
    apply(changes: FileChanges, caller: string): string[] {
        const { put, remove, totalBytes: registeredBytes } = this._plan(changes, caller);
        const quotaError = () => fileError('FILES_QUOTA_EXCEEDED', `${caller} refused: at most ${MAX_TOTAL_BYTES} bytes in total.`);
        let totalBytes = registeredBytes;

        // Then with what each module rewrite (rewriteCost) and each stylesheet's references
        // (referenceCost) add. Lexed and tokenized now, still before any change.
        const rewrites = new Map<string, ModuleRewrite>();
        const stylesheets = new Map<string, StylesheetReferences>();
        for (const [path, file] of put) {
            if (isJavaScriptType(file.type)) {
                const rewrite = rewriteModule(path, file.bytes);
                rewrites.set(path, rewrite);
                totalBytes += rewriteCost(rewrite.edits);
            } else if (isStylesheetType(file.type)) {
                const found = stylesheetReferences(path, file.bytes);
                stylesheets.set(path, found);
                totalBytes += referenceCost(found.references);
            }
        }
        if (totalBytes > MAX_TOTAL_BYTES) throw quotaError();

        // validated: apply. Encoded only now.
        const changed: string[] = [];
        for (const path of remove) {
            if (!this._files.has(path)) continue;
            this._files.delete(path);
            changed.push(path);
        }
        for (const [path, { type, bytes }] of put) {
            const rewrite = rewrites.get(path);
            const edits = rewrite?.edits ?? null;
            const stylesheet = stylesheets.get(path);
            const references = stylesheet?.references ?? null;
            const cost = bytes.length + rewriteCost(edits) + referenceCost(references);
            const file: StoredFile = { type, size: bytes.length, cost, base64: toBase64(bytes), edits, references };
            const existing = this._files.get(path);
            if (existing && existing.type === file.type && existing.base64 === file.base64) continue;
            this._files.set(path, file);
            changed.push(path);
            // once per file registration, and only for a file that changed: delivered as registered
            if (rewrite?.failure) this._warn(`[Sandbox] ${describePath(path)} is registered as JavaScript but could not be lexed as a module (${rewrite.failure}), so its relative imports were not rewritten and will fail in the guest. The file is delivered unchanged.`);
            if (stylesheet?.failure) this._warn(`[Sandbox] ${describePath(path)} is registered as CSS but is ${stylesheet.failure}, so its url() and @import references were not rewritten and will fail in the guest. The file is delivered unchanged.`);
        }
        this._totalBytes = totalBytes;
        return changed.sort();
    }

    // The first half of every check (apply() and check()): each path and entry in order, then the file count,
    // then the registered bytes alone, so an oversized change is refused before any lexing or encoding work.
    // A file being replaced or removed gives back its whole cost (registered bytes plus what its rewrite added).
    private _plan(changes: FileChanges, caller: string): FilePlan {
        const put = new Map<string, CheckedFile>();
        for (const [path, entry] of changes.put ?? []) {
            // a CheckedFile has been through CheckedFile.from() already: its bytes are a copy, its type the store's
            put.set(path as string, entry instanceof CheckedFile && isValidPath(path) ? entry : CheckedFile.from(path, entry, caller));
        }
        const remove = new Set<string>();
        for (const path of changes.remove ?? []) {
            if (!isValidPath(path)) throw fileError('INVALID_PATH', `${caller} refused the path ${describePath(path)}.`);
            if (put.has(path)) throw fileError('INVALID_PATH', `${caller} refused the path ${describePath(path)}: it is both written and removed.`);
            remove.add(path);
        }

        let fileCount = this._files.size;
        for (const path of put.keys()) if (!this._files.has(path)) fileCount++;
        for (const path of remove) if (this._files.has(path)) fileCount--;
        if (fileCount > MAX_FILES) throw fileError('FILES_QUOTA_EXCEEDED', `${caller} refused: at most ${MAX_FILES} files.`);

        let totalBytes = this._totalBytes;
        for (const [path, file] of put) totalBytes += file.bytes.length - (this._files.get(path)?.cost ?? 0);
        for (const path of remove) totalBytes -= this._files.get(path)?.cost ?? 0;
        if (totalBytes > MAX_TOTAL_BYTES) throw fileError('FILES_QUOTA_EXCEEDED', `${caller} refused: at most ${MAX_TOTAL_BYTES} bytes in total.`);
        return { put, remove, totalBytes };
    }

    /** Every file, sorted by path, as fresh objects. */
    list(): FileInfo[] {
        const infos: FileInfo[] = [];
        for (const [path, file] of this._files) infos.push({ path, type: file.type, size: file.size });
        return infos.sort((a, b) => (a.path < b.path ? -1 : 1));
    }

    /**
     * What one environment build hands the guest, in delivery order: every file without slots first,
     * sorted by path, then the stylesheets whose references name registered files, each after every
     * file it references (so the guest, which makes the blobs in this order, always has the URL a slot
     * needs). Empty when no file is registered.
     *
     * A stylesheet's reference becomes a slot only if a file is registered at its path and the
     * reference does not lie on a cycle. A cycle — `a.css` imports `b.css`, which imports `a.css`, or a
     * stylesheet that names itself — has no order in which every file comes after the files it names,
     * so every reference on a cycle (every reference between two files of one strongly connected
     * component) is left as registered and fails closed in the guest, as an unresolvable relative URL.
     * Their other references, and references into the cycle from outside, still resolve. One warning
     * per distinct cycle per store.
     *
     * A reference names a registered file only if the file's type is admitted for the reference's kind of load
     * (load-kinds.ts; FR:W1): an @import names a stylesheet, a url() in @font-face a font,
     * any other url() an image. A reference to a file of another type is left as written (fails closed), with one
     * warning per stylesheet, target and kind; it is no edge either, so it can make no cycle.
     */
    snapshot(): FileSnapshotEntry[] {
        // the references of a stylesheet that name a registered file of an admitted type: the one test, used below
        const resolves = (from: string, [, , target, kind]: CssReferenceRange): boolean => {
            const file = this._files.get(target);
            if (!file) return false;
            if (admits(kind, file.type)) return true;
            this._warnKindMismatch(from, target, file.type, kind);
            return false;
        };
        const targets = new Map<string, string[]>(); // a stylesheet's registered targets, sorted, unique
        for (const [path, file] of this._files) {
            if (!file.references) continue;
            const named = new Set<string>();
            for (const reference of file.references) if (resolves(path, reference)) named.add(reference[2]);
            if (named.size > 0) targets.set(path, [...named].sort());
        }
        const component = stronglyConnectedComponents(targets);
        const onCycle = (from: string, to: string) => component.get(from) === component.get(to);
        this._warnCycles(targets, component);

        const entryOf = (path: string, file: StoredFile): FileSnapshotEntry => {
            if (file.edits) return [path, file.type, file.base64, [...file.edits]];
            const edits: ByteEdits = [];
            for (const [start, end, target, kind] of file.references ?? []) {
                const named = this._files.get(target);
                if (named && admits(kind, named.type) && !onCycle(path, target)) edits.push(start, end, [target]);
            }
            return edits.length > 0 ? [path, file.type, file.base64, edits] : [path, file.type, file.base64];
        };

        const plain: FileSnapshotEntry[] = [];
        const slotted = new Map<string, FileSnapshotEntry>();
        for (const [path, file] of this._files) {
            const entry = entryOf(path, file);
            if (entry[3]?.some(edit => Array.isArray(edit))) slotted.set(path, entry);
            else plain.push(entry);
        }
        const byPath = (a: FileSnapshotEntry, b: FileSnapshotEntry) => (a[0] < b[0] ? -1 : 1);
        const entries = plain.sort(byPath);

        // Depth first, in path order: a stylesheet is emitted after every slotted stylesheet it names.
        // The edges left are acyclic; marking before descending would end the walk on a cycle anyway.
        const visited = new Set<string>();
        const visit = (path: string) => {
            if (visited.has(path)) return;
            visited.add(path);
            for (const target of targets.get(path) ?? []) if (slotted.has(target) && !onCycle(path, target)) visit(target);
            entries.push(slotted.get(path)!);
        };
        for (const path of [...slotted.keys()].sort()) visit(path);
        return entries;
    }

    private _warnKindMismatch(from: string, target: string, type: string, kind: LoadKindName) {
        const message = `[Sandbox] the stylesheet ${describePath(from)} names ${describePath(target)} as ${kind === 'style' ? 'a stylesheet (@import)' : kind === 'font' ? 'a font (@font-face)' : 'an image (url())'}, but its type is ${type}, so the reference is left as written and will not load in the guest.`;
        if (this._warnedKinds.has(message)) return;
        this._warnedKinds.add(message);
        this._warn(message);
    }

    // One warning per distinct cycle (a strongly connected component with more than one file, or a
    // stylesheet that names itself), naming its files, the first time a build meets it.
    private _warnCycles(targets: Map<string, string[]>, component: Map<string, number>) {
        const members = new Map<number, string[]>();
        for (const path of targets.keys()) {
            const id = component.get(path)!;
            if (!members.has(id)) members.set(id, []);
            members.get(id)!.push(path);
        }
        for (const paths of members.values()) {
            const cyclic = paths.length > 1 || targets.get(paths[0]!)!.includes(paths[0]!);
            if (!cyclic) continue;
            const names = paths.sort().map(describePath);
            const message = `[Sandbox] the stylesheets ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''} reference each other in a cycle, so the references between them are left as written and will not load in the guest. Their other references still resolve.`;
            if (this._warnedCycles.has(message)) continue;
            this._warnedCycles.add(message);
            this._warn(message);
        }
    }
}

/**
 * Tarjan's algorithm over `edges` (a node's targets; targets without an entry have no edges): the id
 * of each node's strongly connected component. Two nodes share an id exactly when each reaches the
 * other, so an edge lies on a cycle exactly when both its ends share an id (a self-edge included).
 */
function stronglyConnectedComponents(edges: ReadonlyMap<string, readonly string[]>): Map<string, number> {
    const index = new Map<string, number>();
    const lowLink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const component = new Map<string, number>();
    let next = 0;
    let components = 0;

    // Recursive: depth is bounded by the number of files (MAX_FILES).
    const connect = (node: string) => {
        index.set(node, next);
        lowLink.set(node, next);
        next++;
        stack.push(node);
        onStack.add(node);
        for (const target of edges.get(node) ?? []) {
            if (!index.has(target)) {
                connect(target);
                lowLink.set(node, Math.min(lowLink.get(node)!, lowLink.get(target)!));
            } else if (onStack.has(target)) {
                lowLink.set(node, Math.min(lowLink.get(node)!, index.get(target)!));
            }
        }
        if (lowLink.get(node) === index.get(node)) {
            let member: string;
            do {
                member = stack.pop()!;
                onStack.delete(member);
                component.set(member, components);
            } while (member !== node);
            components++;
        }
    };
    for (const node of [...edges.keys()].sort()) if (!index.has(node)) connect(node);
    return component;
}

interface ModuleRewrite {
    edits: ByteEdits | null; // null: nothing to rewrite, or the lexer failed
    failure?: string; // why the file is delivered unchanged
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

interface StylesheetReferences {
    references: CssReferenceRange[] | null; // null: none, or the file is not UTF-8
    failure?: string; // why the file is delivered unchanged
}

/**
 * The references of a stylesheet registered at `path` that could name a file: each url() or @import
 * (css-references.ts) that resolves, against the stylesheet's own virtual URL, to a valid path with
 * no query or fragment, as a range of its registered bytes. A stylesheet that is not UTF-8 is delivered
 * unchanged, with `failure` set; its relative references then fail closed in the guest.
 */
function stylesheetReferences(path: string, bytes: Uint8Array): StylesheetReferences {
    let source: string;
    try {
        source = UTF8.decode(bytes);
    } catch {
        return { references: null, failure: 'not UTF-8' };
    }
    const references: CssReferenceRange[] = [];
    const toBytes = utf8Offsets(source);
    for (const reference of cssUrlReferences(source)) {
        const target = virtualPathOf(reference.url, VIRTUAL_ROOT + path);
        if (target === null || !isValidPath(target)) continue;
        references.push([toBytes(reference.start), toBytes(reference.end), target, reference.kind]);
    }
    return { references: references.length > 0 ? references : null };
}

// UTF-16 offsets of `source` to UTF-8 byte offsets, for offsets asked in increasing order: one pass in all.
function utf8Offsets(source: string): (offset: number) => number {
    let char = 0;
    let byte = 0;
    return (offset: number) => {
        byte += utf8Length(source, char, offset);
        char = offset;
        return byte;
    };
}

/**
 * The module rewrite of a JavaScript file registered at `path`: its relative specifiers resolved
 * against its own virtual URL (module-specifiers.ts), as edits of its registered bytes. A file that is
 * not UTF-8 (a module always is) or that the lexer cannot parse is delivered unchanged, with `failure`
 * set; its relative imports then fail closed in the guest, exactly as without the rewrite.
 */
function rewriteModule(path: string, bytes: Uint8Array): ModuleRewrite {
    let source: string;
    try {
        source = UTF8.decode(bytes);
    } catch {
        return { edits: null, failure: 'not UTF-8' };
    }
    let edits;
    try {
        edits = moduleSpecifierEdits(source, VIRTUAL_ROOT + path);
    } catch (e) {
        // The lexer's position only, never its message as such (the one rule for caught errors, FR:F3): es-module-lexer says "Parse error @:line:column", and nothing else reaches the warning.
        const at = /@:(\d{1,9}):(\d{1,9})/.exec(e instanceof Error ? String(e.message) : '');
        return { edits: null, failure: at ? `parse error at ${at[1]}:${at[2]}` : 'lexer error' };
    }
    if (edits.length === 0) return { edits: null };

    // UTF-16 offsets to UTF-8 byte offsets, in one pass over the source (edits are sorted)
    const byteEdits: ByteEdits = [];
    const toBytes = utf8Offsets(source);
    for (const edit of edits) byteEdits.push(toBytes(edit.start), toBytes(edit.end), edit.text);
    return { edits: byteEdits };
}

// The UTF-8 length of source[from, to). The source came from a fatal UTF-8 decode, so every surrogate is paired.
function utf8Length(source: string, from: number, to: number): number {
    let length = 0;
    for (let i = from; i < to; i++) {
        const unit = source.charCodeAt(i);
        if (unit < 0x80) length += 1;
        else if (unit < 0x800) length += 2;
        else if (unit >= 0xd800 && unit <= 0xdbff) { length += 4; i++; }
        else length += 3;
    }
    return length;
}

/** A registered stylesheet the strict view gets without its network URLs, or not at all (viewStylesheets). */
export interface ViewStylesheetDrop {
    path: string;
    /** The network URLs dropped, as written; empty when the whole file was left out. */
    urls: string[];
    /** Why the whole file was left out, or null when only its network URLs went. */
    unreadable: string | null;
}

// The labels of UTF-8 (Encoding Standard), and the UTF-16 ones, which a stylesheet's @charset reads as UTF-8 (CSS Syntax).
const UTF8_CHARSETS = ['unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'utf-8', 'utf8', 'x-unicode20utf8', 'utf-16be', 'utf-16le'];
// The @charset rule as the browser reads it: these bytes at the very start of the file (CSS Syntax, the fallback encoding).
const CHARSET_RULE = /^@charset "([^"]{0,1014})";/;

/**
 * Strict mode's registered stylesheets as the view gets them (S74, BD2:ISO-2): without a network URL. No attribute
 * reaches a load that CSS makes, so it would carry the listed origin's cookies (Firefox, WebKit); every `url()`,
 * `@import`, `image-set()` and `@font-face` source with an absolute http: or https: URL (cssReferences, `network`
 * scope) becomes `""` through the snapshot's own edits, beside the slots of the references to registered files, which
 * stay and become the view's blob: URLs. The browser must read the file as the tokenizer did, so a stylesheet that is
 * not UTF-8, or whose `@charset` names another encoding, gets no URL in the view at all (its references fail closed).
 * `entries` are the view's files (FileSnapshotEntry); every other entry is returned as it is. Each stylesheet that lost
 * something is in `dropped`, for the element's warning.
 */
export function viewStylesheets(entries: readonly FileSnapshotEntry[]): { entries: FileSnapshotEntry[]; dropped: ViewStylesheetDrop[] } {
    const out: FileSnapshotEntry[] = [];
    const dropped: ViewStylesheetDrop[] = [];
    for (const entry of entries) {
        if (entry[1] !== 'text/css') {
            out.push(entry);
            continue;
        }
        const [path, type, base64] = entry;
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        let source: string;
        try {
            source = UTF8.decode(bytes);
        } catch {
            dropped.push({ path, urls: [], unreadable: 'it is not UTF-8' });
            continue;
        }
        const charset = CHARSET_RULE.exec(source);
        if (charset && !UTF8_CHARSETS.includes(charset[1]!.trim().toLowerCase())) {
            dropped.push({ path, urls: [], unreadable: 'its @charset names an encoding other than UTF-8' });
            continue;
        }
        const slots = entry[3] ?? [];
        const taken = (start: number, end: number) => {
            for (let i = 0; i < slots.length; i += 3) if ((slots[i] as number) < end && start < (slots[i + 1] as number)) return true;
            return false;
        };
        const toBytes = utf8Offsets(source);
        const drops: [start: number, end: number][] = [];
        const urls: string[] = [];
        for (const reference of cssReferences(source, 'network')) {
            const start = toBytes(reference.start);
            const end = toBytes(reference.end);
            if (taken(start, end)) continue; // a registered file's slot (https://vfs.invalid/…): the view's blob: URL
            drops.push([start, end]);
            urls.push(reference.url);
        }
        if (drops.length === 0) {
            out.push(entry);
            continue;
        }
        const edits: [number, number, string | FileSlot][] = [];
        for (let i = 0; i < slots.length; i += 3) edits.push([slots[i] as number, slots[i + 1] as number, slots[i + 2] as string | FileSlot]);
        for (const [start, end] of drops) edits.push([start, end, '""']);
        edits.sort((a, b) => a[0] - b[0]);
        out.push([path, type, base64, edits.flat()]);
        dropped.push({ path, urls, unreadable: null });
    }
    return { entries: out, dropped };
}

interface ParsedFile {
    type: string;
    bytes: Uint8Array; // already a copy of the caller's data
}

// One entry of a change, at a path already checked (CheckedFile.from): its bytes copied, its type the
// override or the extension table's. Throws INVALID_FILE.
function parseEntry(path: string, entry: unknown, caller: string): ParsedFile {
    const isWrapped = entry !== null && typeof entry === 'object' && !isUint8Array(entry);
    const content = isWrapped ? (entry as { content?: unknown }).content : entry;
    const type = isWrapped ? (entry as { type?: unknown }).type : mimeTypeFor(path);

    const bytes = toBytes(content);
    if (!bytes) throw fileError('INVALID_FILE', `${caller} refused ${describePath(path)}: content must be a string or a Uint8Array.`);
    if (!isValidMimeType(type)) throw fileError('INVALID_FILE', `${caller} refused ${describePath(path)}: type must be a MIME type such as "text/plain".`);

    return { type: type.toLowerCase(), bytes };
}

// Realm-independent: a Uint8Array from another frame is still one.
function isUint8Array(value: unknown): value is Uint8Array {
    return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
}

// A copy, so a caller mutating its array afterwards changes nothing that was registered.
function toBytes(content: unknown): Uint8Array | null {
    if (typeof content === 'string') return new TextEncoder().encode(content);
    if (!isUint8Array(content)) return null;
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength).slice();
}

function toBase64(bytes: Uint8Array): string {
    // Uint8Array.prototype.toBase64 where the engine has it (much faster), else chunked btoa
    const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
    if (typeof native === 'function') return native.call(bytes);
    const CHUNK = 0x8000; // keeps String.fromCharCode's argument list well below engine limits
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/** A path for a refusal message: bounded, and quoted so control characters are visible. Never throws. */
export function describePath(path: unknown): string {
    if (typeof path !== 'string') return `of type ${typeof path}`;
    return JSON.stringify(path.length > 80 ? path.slice(0, 80) + '…' : path);
}
