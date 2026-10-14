/**
 * Guest writes (backlog C5, ADR-004 amendment "guest writes"), host side: the overlay of one environment.
 *
 * With `guestWrites: true` the guest's `sandboxFiles.write()` and `sandboxFiles.remove()` ask the host, through
 * the reserved broker method `sandbox:write` (WRITE_METHOD), to record a change. Nothing the guest writes ever
 * reaches the store, a policy or a guest by itself: it is recorded here, in an overlay that belongs to the
 * environment that wrote it, and only the embedder's explicit commitGuestWrites(paths) applies part of it to the
 * store (FileStore.apply(), files.ts), where the next build picks it up like any registered file. Off (the
 * default), there is no overlay and the method refuses every request with FILES_NOT_ALLOWED.
 *
 * What holds by construction:
 *   - One set of rules. A write is checked by CheckedFile.from(), the same path and entry validation as
 *     registerFiles(), so its type is the type the store assigns (override or extension table), and the
 *     write-time quota is FileStore.check() of the store with the overlay and this write applied: the count and
 *     the registered bytes, exactly apply()'s first step, without lexing. The commit is FileStore.apply(), the
 *     full check including what module and stylesheet rewrites add. So a write the host could never register is
 *     refused at once with registerFiles()'s own code, and a commit can still be refused (FILES_QUOTA_EXCEEDED)
 *     if the host registered more in between; a refused commit changes neither the store nor the overlay.
 *   - The host is the single source of truth. A refused request changes nothing here; the guest's own view
 *     (in-sandbox-files.ts) changes only after this module's answer.
 *   - Removal marks are bounded by the store: a removal is recorded only for a path the store holds (or one the
 *     overlay wrote, which is then simply forgotten); a path in neither is answered `change: 'none'` (the guest
 *     rejects NOT_FOUND) and records nothing. A mark whose path the host unregistered later is forgotten before
 *     the marks are listed or committed, so a listed mark always names a stored file.
 *   - Code needs a second opt-in. A commit refuses any file whose type is not on INERT_TYPES unless
 *     `{ code: true }`: JavaScript, HTML, SVG, XML, WebAssembly and every type not listed (an override included).
 *     The type checked is the CheckedFile's, the one the store will load the file as, never the file name.
 *   - The rate is bounded per environment: at most GUEST_WRITES_PER_SECOND requests are handled and at most
 *     GUEST_WRITE_BYTES_PER_SECOND bytes recorded in any one-second window, refused with FILES_BUSY. That also
 *     bounds the host's 'fileswritten' events (one per recorded change).
 *   - An overlay ends with its environment: close() (teardown) refuses every later request, so what the host
 *     inspects after a termination is what that environment wrote. The host discards it at the next build.
 *
 * Host-side only, never stringified into the guest, so it may use module scope freely.
 */
import { CheckedFile, describePath, fileError, isValidPath, MAX_TOTAL_BYTES, type FileStore } from './files';
import { createRateLimiter } from './rate-limit';

/** The reserved broker method the guest's sandboxFiles.write() and remove() call (rpc.ts, reserved names). */
export const WRITE_METHOD = 'sandbox:write';

/** Most write and remove requests handled per environment in any one-second window; later ones are FILES_BUSY. */
export const GUEST_WRITES_PER_SECOND = 100;

/** Most bytes of written content recorded per environment in any one-second window; later writes are FILES_BUSY. */
export const GUEST_WRITE_BYTES_PER_SECOND = MAX_TOTAL_BYTES;

/**
 * The types commitGuestWrites() applies without `{ code: true }`: images, fonts, audio and video the browser
 * only decodes, plain text, JSON and CSS. Exact strings, no prefixes: `image/svg+xml` is a document that can
 * carry script, and a guest's type override (`image/x-anything`) is not on the list either. Everything else —
 * JavaScript, HTML, SVG, XML, WebAssembly, unknown types — runs or is parsed as code somewhere and needs the
 * explicit flag. Kept equal to the extension table's image/font/audio/video types (minus SVG) by a test.
 */
export const INERT_TYPES: ReadonlySet<string> = new Set([
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/x-icon', 'image/bmp',
    'font/woff', 'font/woff2', 'font/ttf', 'font/otf',
    'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/flac',
    'video/mp4', 'video/webm', 'video/ogg',
    'text/plain', 'application/json', 'text/css',
]);

/** One pending change, as listGuestWrites() reports it: fresh objects, `content` a copy of the written bytes. */
export type GuestWrite =
    | { path: string; change: 'write'; type: string; size: number; content: Uint8Array }
    | { path: string; change: 'remove' };

/**
 * What the host answers a request, the guest's only source for changing its view. `none`: a removal of a path in
 * neither the store nor the overlay; nothing was recorded (the guest rejects NOT_FOUND).
 */
export type GuestWriteAnswer =
    | { path: string; change: 'write'; type: string; size: number }
    | { path: string; change: 'remove' }
    | { path: string; change: 'none' };

export interface GuestWritesOptions {
    store: FileStore;
    now?: () => number;
}

export interface GuestWrites {
    /** Handles one request from the guest: records it and answers, or throws a FileError (a library code). */
    handle(request: unknown): GuestWriteAnswer;
    /** The pending changes, sorted by path. */
    list(): GuestWrite[];
    /**
     * Applies the pending changes at `paths` (already validated paths; one without a pending change is skipped) to
     * the store, atomically, and forgets them. Returns what the store reports as changed. Throws FILES_NOT_ALLOWED
     * for a non-inert write without `code`, or the store's refusal; then nothing changes.
     */
    commit(paths: readonly string[], code: boolean): string[];
    /** Its environment ended: every later request is refused. What was recorded stays listable and committable. */
    close(): void;
}

const WRITE_CALLER = 'sandboxFiles.write()';
const REMOVE_CALLER = 'sandboxFiles.remove()';
const COMMIT_CALLER = 'commitGuestWrites()';

/** One overlay per environment, created by the build when guestWrites is on. */
export function createGuestWrites({ store, now = () => performance.now() }: GuestWritesOptions): GuestWrites {
    // path → the write (a CheckedFile) or a removal mark (null). Never holds a refused request.
    const overlay = new Map<string, CheckedFile | null>();
    let closed = false;
    // Sliding one-second windows (rate-limit.ts, the limiter the log lines use too): at most the limit in ANY
    // one-second window, as documented. The fixed windows they replace let 199 requests (and twice the bytes)
    // through around a window boundary (focused review 2026-10-14, W2). One clock reading serves both.
    const requests = createRateLimiter(GUEST_WRITES_PER_SECOND);
    const bytes = createRateLimiter(GUEST_WRITE_BYTES_PER_SECOND);

    const busy = (what: string) => fileError('FILES_BUSY', `${what}: at most ${GUEST_WRITES_PER_SECOND} writes and ${GUEST_WRITE_BYTES_PER_SECOND} bytes per second; retry later.`);

    // The store as the guest sees it, with `path` changed to `file`: what the write-time quota checks.
    const overlaid = (path: string, file: CheckedFile) => {
        const put = new Map<string, CheckedFile>();
        const remove: string[] = [];
        for (const [pending, change] of overlay) {
            if (pending === path) continue;
            if (change === null) remove.push(pending);
            else put.set(pending, change);
        }
        put.set(path, file);
        return { put, remove };
    };

    const handle = (request: unknown): GuestWriteAnswer => {
        if (closed) throw fileError('FILES_NOT_ALLOWED', 'the environment that sent this write has ended.');
        // Counted first, refused or not: the window bounds the work a guest can make the host do.
        const time = now();
        if (!requests.admit(time)) throw busy('guest writes refused');

        // Only `change`, `path` and `entry` are read, each once: the request is the guest's structured-cloned data.
        const source = request !== null && typeof request === 'object' ? request as Record<string, unknown> : {};
        const change = source.change;
        const path = source.path;

        if (change === 'remove') {
            if (!isValidPath(path)) throw fileError('INVALID_PATH', `${REMOVE_CALLER} refused the path ${describePath(path)}.`);
            const pending = overlay.get(path);
            const inStore = store.has(path);
            if (pending === null || (pending === undefined && !inStore)) return { path, change: 'none' };
            // A file the overlay wrote over nothing is forgotten, not marked: a mark only ever names a stored path.
            if (inStore) overlay.set(path, null);
            else overlay.delete(path);
            return { path, change: 'remove' };
        }
        if (change !== 'write') throw fileError('INVALID_FILE', 'a guest write request is { change: "write", path, entry } or { change: "remove", path }.');

        const file = CheckedFile.from(path, source.entry, WRITE_CALLER);
        const valid = path as string; // CheckedFile.from() checked it
        store.check(overlaid(valid, file), WRITE_CALLER);
        // After the quota, so a write past the cap is FILES_QUOTA_EXCEEDED whatever the rate.
        if (!bytes.admit(time, file.bytes.length)) throw busy(`${WRITE_CALLER} refused`);
        overlay.set(valid, file);
        return { path: valid, change: 'write', type: file.type, size: file.bytes.length };
    };

    // A removal mark names a path the store held when it was recorded; the host may unregister that path later
    // (focused review 2026-10-14, W3). A mark whose path the store no longer holds would remove nothing and only
    // mislead whoever reads the list, so it is forgotten here, where marks are read: list() and commit() call
    // this first, and handle() needs no copy of it (a removal of such a path is answered 'none' anyway).
    const forgetStaleMarks = () => {
        for (const [path, change] of [...overlay]) if (change === null && !store.has(path)) overlay.delete(path);
    };

    const list = (): GuestWrite[] => {
        forgetStaleMarks();
        const writes: GuestWrite[] = [];
        for (const path of [...overlay.keys()].sort()) {
            const file = overlay.get(path)!;
            writes.push(file === null ? { path, change: 'remove' } : { path, change: 'write', type: file.type, size: file.bytes.length, content: file.bytes.slice() });
        }
        return writes;
    };

    const commit = (paths: readonly string[], code: boolean): string[] => {
        forgetStaleMarks();
        const put = new Map<string, CheckedFile>();
        const remove: string[] = [];
        for (const path of paths) {
            if (!overlay.has(path)) continue;
            const file = overlay.get(path)!;
            if (file === null) {
                remove.push(path);
                continue;
            }
            if (!code && !INERT_TYPES.has(file.type)) {
                throw fileError('FILES_NOT_ALLOWED', `${COMMIT_CALLER} refused ${describePath(path)}: its type ${file.type} is not inert; pass { code: true } to commit files that can run or be parsed as code.`);
            }
            put.set(path, file);
        }
        // Every check before any change: apply() throws and changes nothing, and the overlay is untouched then.
        const changed = store.apply({ put, remove }, COMMIT_CALLER);
        for (const path of put.keys()) overlay.delete(path);
        for (const path of remove) overlay.delete(path);
        return changed;
    };

    return { handle, list, commit, close: () => { closed = true; } };
}

/**
 * Checks commitGuestWrites()'s arguments: `paths` is an array of valid paths (required: there is no commit-all),
 * and only a literal `true` in `options.code` commits non-inert files. Throws INVALID_PATH.
 */
export function parseCommitArguments(paths: unknown, options: unknown): { paths: string[]; code: boolean } {
    if (!Array.isArray(paths)) throw fileError('INVALID_PATH', `${COMMIT_CALLER} expects an array of paths.`);
    for (const path of paths) {
        if (!isValidPath(path)) throw fileError('INVALID_PATH', `${COMMIT_CALLER} refused the path ${describePath(path)}.`);
    }
    const code = options !== null && typeof options === 'object' && (options as { code?: unknown }).code === true;
    return { paths: [...paths], code };
}
