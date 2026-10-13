/**
 * The host side of file delivery (backlog C1–C3, ADR-004): path validation, the MIME table and the
 * store that lives on the element. Host-only: nothing here is stringified into the guest. The guest
 * side is src/lib/in-sandbox-files.ts, which receives a snapshot of this store as one literal.
 *
 * Files are part of the environment. The store survives reset(), load(), setConfig() and terminate();
 * every environment build takes a snapshot of it, and nothing reaches a guest that is already running.
 */

import { moduleSpecifierEdits, VIRTUAL_ROOT } from './module-specifiers';

// The cap (backlog C3). Module constants rather than config: each value was measured to load in all
// three engines (test/e2e/files.spec.ts), so raise one only after that test passes at the new value.
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_FILES = 1000;
export const MAX_PATH_LENGTH = 256;

export type FileContent = string | Uint8Array; // a string is stored as UTF-8; a Uint8Array is copied
export type FileEntry = FileContent | { content: FileContent; type: string };

export interface FileInfo {
    path: string;
    type: string;
    size: number; // bytes
}

/**
 * Why registerFiles() or unregisterFiles() refused a batch. The strings are API (pinned by a test).
 * They are not RpcErrorCode: no broker is involved, the host refuses its own caller.
 *   INVALID_PATH          a path fails isValidPath(), or unregisterFiles() was not given an array of paths
 *   INVALID_FILE          the batch is not an object, or an entry is not a string, a Uint8Array or
 *                         { content, type } with a valid type
 *   FILES_QUOTA_EXCEEDED  the store after the batch would exceed MAX_FILES or MAX_TOTAL_BYTES (a
 *                         JavaScript file counts its registered bytes plus what its rewrite adds,
 *                         rewriteCost())
 * In the guest, every failed lookup is NOT_FOUND (in-sandbox-files.ts).
 */
export type FileErrorCode = 'INVALID_PATH' | 'INVALID_FILE' | 'FILES_QUOTA_EXCEEDED';

/**
 * The guest's view, published as the global `sandboxFiles` by the bootstrap (in-sandbox-files.ts) in
 * every environment, empty when no file is registered. Every failed lookup is an Error with `code: 'NOT_FOUND'`.
 */
export interface SandboxFiles {
    list(): string[];
    url(path: string): string;
    read(path: string): Promise<Uint8Array>;
    text(path: string): Promise<string>;
}

/** The shape of every refusal: a plain Error with an own `code` (backlog B7). */
export interface FileError extends Error {
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
// (docs/research/blob-delivery-probe.md, section 2), so an unknown file must not get one.
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

// The JavaScript MIME types a file can be given; only text/javascript comes from the extension table.
const JAVASCRIPT_TYPES = new Set(['text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript']);

/** Whether a file of this type is JavaScript: it loads through script-src, and its module specifiers are rewritten. */
export function isJavaScriptType(type: string): boolean {
    return JAVASCRIPT_TYPES.has(type);
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
    cost: number; // what counts against MAX_TOTAL_BYTES: size plus rewriteCost(edits)
    base64: string; // the bytes as registered, encoded once at registration: the snapshot needs nothing else
    edits: ByteEdits | null; // the module rewrite, for JavaScript files whose specifiers were rewritten
}

/**
 * A JavaScript file's module rewrite as the guest receives it: flat triples
 * [start, end, text, start, end, text, ...], where [start, end) is a range of the registered BYTES
 * (sorted, non-overlapping) and `text` replaces it. The guest builds the module from slices of the
 * registered bytes and these texts (inSandboxFiles), so the literal carries the file once.
 */
export type ByteEdits = (number | string)[];

/**
 * One file as the guest bootstrap receives it: [path, type, base64], plus the module rewrite for a
 * JavaScript file whose relative specifiers were rewritten (module-specifiers.ts).
 */
export type FileSnapshotEntry = [path: string, type: string, base64: string] | [path: string, type: string, base64: string, edits: ByteEdits];

// What one rewritten specifier adds to the snapshot literal besides its text: two offsets of up to
// 8 digits, three commas and two quotes, rounded up.
const EDIT_OVERHEAD = 24;

/**
 * What a module rewrite adds to the snapshot literal, in bytes, counted against MAX_TOTAL_BYTES so the
 * literal never grows past what the cap was measured at: each edit's text plus EDIT_OVERHEAD. The
 * texts are JSON strings of URLs, so ASCII: their length is their size.
 */
export function rewriteCost(edits: ByteEdits | null): number {
    if (!edits) return 0;
    let cost = 0;
    for (let i = 2; i < edits.length; i += 3) cost += (edits[i] as string).length + EDIT_OVERHEAD;
    return cost;
}

/**
 * The files of one element. Every mutation validates the whole batch against the store it would
 * produce before changing anything, so a refused call leaves the store exactly as it was.
 */
export class FileStore {
    private _files = new Map<string, StoredFile>();
    private _totalBytes = 0; // the sum of every file's cost

    // Lexer failures are reported here, once per registration of the file (console.warn by default).
    constructor(private readonly _warn: (message: string) => void = message => console.warn(message)) {}

    /**
     * Adds or replaces the given files. Returns the paths whose content or type changed (sorted);
     * re-registering an identical file changes nothing. Throws a FileError and changes nothing on refusal.
     */
    register(files: unknown): string[] {
        const incoming = parseBatch(files);

        let fileCount = this._files.size;
        for (const path of incoming.keys()) if (!this._files.has(path)) fileCount++;
        if (fileCount > MAX_FILES) throw fileError('FILES_QUOTA_EXCEEDED', `registerFiles() refused: at most ${MAX_FILES} files.`);
        const quotaError = () => fileError('FILES_QUOTA_EXCEEDED', `registerFiles() refused: at most ${MAX_TOTAL_BYTES} bytes in total.`);

        // The registered bytes alone first, so an oversized batch is refused before any lexing or encoding work.
        let totalBytes = this._totalBytes;
        for (const [path, file] of incoming) totalBytes += file.bytes.length - (this._files.get(path)?.cost ?? 0);
        if (totalBytes > MAX_TOTAL_BYTES) throw quotaError();

        // Then with what each module rewrite adds (rewriteCost). Lexed now, still before any change.
        const rewrites = new Map<string, ModuleRewrite>();
        for (const [path, file] of incoming) {
            if (!isJavaScriptType(file.type)) continue;
            const rewrite = rewriteModule(path, file.bytes);
            rewrites.set(path, rewrite);
            totalBytes += rewriteCost(rewrite.edits);
        }
        if (totalBytes > MAX_TOTAL_BYTES) throw quotaError();

        // validated: apply. Encoded only now.
        const changed: string[] = [];
        for (const [path, { type, bytes }] of incoming) {
            const rewrite = rewrites.get(path);
            const edits = rewrite?.edits ?? null;
            const file: StoredFile = { type, size: bytes.length, cost: bytes.length + rewriteCost(edits), base64: toBase64(bytes), edits };
            const existing = this._files.get(path);
            if (existing && existing.type === file.type && existing.base64 === file.base64) continue;
            this._files.set(path, file);
            changed.push(path);
            // once per file registration, and only for a file that changed: delivered as registered
            if (rewrite?.failure) this._warn(`[Sandbox] ${describePath(path)} is registered as JavaScript but could not be lexed as a module (${rewrite.failure}), so its relative imports were not rewritten and will fail in the guest. The file is delivered unchanged.`);
        }
        this._totalBytes = totalBytes;
        return changed.sort();
    }

    /**
     * Removes the given paths, or every file when `paths` is undefined. Paths that are not registered
     * are ignored. Returns the paths removed (sorted). Throws INVALID_PATH and removes nothing if
     * `paths` is not an array of valid paths.
     */
    unregister(paths?: unknown): string[] {
        const targets = paths === undefined ? [...this._files.keys()] : parsePathList(paths);

        const removed: string[] = [];
        for (const path of targets) {
            const existing = this._files.get(path);
            if (!existing) continue;
            this._files.delete(path);
            this._totalBytes -= existing.cost;
            removed.push(path);
        }
        return removed.sort();
    }

    /** Every file, sorted by path, as fresh objects. */
    list(): FileInfo[] {
        const infos: FileInfo[] = [];
        for (const [path, file] of this._files) infos.push({ path, type: file.type, size: file.size });
        return infos.sort((a, b) => (a.path < b.path ? -1 : 1));
    }

    /** What one environment build hands the guest, sorted by path. Empty when no file is registered. */
    snapshot(): FileSnapshotEntry[] {
        const entries: FileSnapshotEntry[] = [];
        for (const [path, file] of this._files) {
            entries.push(file.edits ? [path, file.type, file.base64, [...file.edits]] : [path, file.type, file.base64]);
        }
        return entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    }
}

interface ModuleRewrite {
    edits: ByteEdits | null; // null: nothing to rewrite, or the lexer failed
    failure?: string; // why the file is delivered unchanged
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

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
        return { edits: null, failure: e instanceof Error ? e.message.slice(0, 80) : 'lexer error' };
    }
    if (edits.length === 0) return { edits: null };

    // UTF-16 offsets to UTF-8 byte offsets, in one pass over the source (edits are sorted)
    const byteEdits: ByteEdits = [];
    let char = 0;
    let byte = 0;
    for (const edit of edits) {
        byte += utf8Length(source, char, edit.start);
        const start = byte;
        byte += utf8Length(source, edit.start, edit.end);
        char = edit.end;
        byteEdits.push(start, byte, edit.text);
    }
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

interface ParsedFile {
    type: string;
    bytes: Uint8Array; // already a copy of the caller's data
}

// Validates a whole registerFiles() batch. Returns the files to store; throws on the first bad entry.
function parseBatch(files: unknown): Map<string, ParsedFile> {
    if (files === null || typeof files !== 'object' || Array.isArray(files)) {
        throw fileError('INVALID_FILE', 'registerFiles() expects an object mapping paths to file contents.');
    }

    const parsed = new Map<string, ParsedFile>();
    for (const [path, entry] of Object.entries(files)) {
        if (!isValidPath(path)) throw fileError('INVALID_PATH', `registerFiles() refused the path ${describePath(path)}.`);
        parsed.set(path, parseEntry(path, entry));
    }
    return parsed;
}

function parseEntry(path: string, entry: unknown): ParsedFile {
    const isWrapped = entry !== null && typeof entry === 'object' && !isUint8Array(entry);
    const content = isWrapped ? (entry as { content?: unknown }).content : entry;
    const type = isWrapped ? (entry as { type?: unknown }).type : mimeTypeFor(path);

    const bytes = toBytes(content);
    if (!bytes) throw fileError('INVALID_FILE', `registerFiles() refused ${describePath(path)}: content must be a string or a Uint8Array.`);
    if (!isValidMimeType(type)) throw fileError('INVALID_FILE', `registerFiles() refused ${describePath(path)}: type must be a MIME type such as "text/plain".`);

    return { type: type.toLowerCase(), bytes };
}

function parsePathList(paths: unknown): string[] {
    if (!Array.isArray(paths)) throw fileError('INVALID_PATH', 'unregisterFiles() expects an array of paths.');
    for (const path of paths) {
        if (!isValidPath(path)) throw fileError('INVALID_PATH', `unregisterFiles() refused the path ${describePath(path)}.`);
    }
    return paths;
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

// For messages only: bounded, and quoted so control characters are visible.
function describePath(path: unknown): string {
    if (typeof path !== 'string') return `of type ${typeof path}`;
    return JSON.stringify(path.length > 80 ? path.slice(0, 80) + '…' : path);
}
