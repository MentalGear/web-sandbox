/**
 * The host side of file delivery (backlog C1–C3, ADR-004): path validation, the MIME table and the
 * store that lives on the element. Host-only: nothing here is stringified into the guest. The guest
 * side is src/lib/in-sandbox-files.ts, which receives a snapshot of this store as one literal.
 *
 * Files are part of the environment. The store survives reset(), load(), setConfig() and terminate();
 * every environment build takes a snapshot of it, and nothing reaches a guest that is already running.
 */

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
 *   FILES_QUOTA_EXCEEDED  the store after the batch would exceed MAX_FILES or MAX_TOTAL_BYTES
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
    size: number;
    base64: string; // the bytes, encoded once at registration: the snapshot needs nothing else
}

/** One file as the guest bootstrap receives it: [path, type, base64]. */
export type FileSnapshotEntry = [path: string, type: string, base64: string];

/**
 * The files of one element. Every mutation validates the whole batch against the store it would
 * produce before changing anything, so a refused call leaves the store exactly as it was.
 */
export class FileStore {
    private _files = new Map<string, StoredFile>();
    private _totalBytes = 0;

    /**
     * Adds or replaces the given files. Returns the paths whose content or type changed (sorted);
     * re-registering an identical file changes nothing. Throws a FileError and changes nothing on refusal.
     */
    register(files: unknown): string[] {
        const incoming = parseBatch(files);

        let fileCount = this._files.size;
        let totalBytes = this._totalBytes;
        for (const [path, file] of incoming) {
            const existing = this._files.get(path);
            if (existing) totalBytes -= existing.size;
            else fileCount++;
            totalBytes += file.bytes.length;
        }
        if (fileCount > MAX_FILES) throw fileError('FILES_QUOTA_EXCEEDED', `registerFiles() refused: at most ${MAX_FILES} files.`);
        if (totalBytes > MAX_TOTAL_BYTES) throw fileError('FILES_QUOTA_EXCEEDED', `registerFiles() refused: at most ${MAX_TOTAL_BYTES} bytes in total.`);

        // validated: apply. Encoded only now, so an oversized batch is refused before any encoding work.
        const changed: string[] = [];
        for (const [path, { type, bytes }] of incoming) {
            const file: StoredFile = { type, size: bytes.length, base64: toBase64(bytes) };
            const existing = this._files.get(path);
            if (existing && existing.type === file.type && existing.base64 === file.base64) continue;
            this._files.set(path, file);
            changed.push(path);
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
            this._totalBytes -= existing.size;
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
        for (const [path, file] of this._files) entries.push([path, file.type, file.base64]);
        return entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    }
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
