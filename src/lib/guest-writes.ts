/**
 * Guest writes (backlog C5, ADR-004 amendment "guest writes"), host side: the overlay of one environment.
 *
 * With `guestWrites: true` the guest's `sandboxFiles.write()` and `sandboxFiles.remove()` ask the host, through
 * the reserved broker method `sandbox:write` (WRITE_METHOD), to record a change. Nothing the guest writes ever
 * reaches the store, a policy or a guest by itself: it is recorded here, in an overlay that belongs to the
 * environment that wrote it, and only the embedder's explicit commitGuestWrites(writes) applies part of it to the
 * store (FileStore.apply(), files.ts), where the next build picks it up like any registered file. Off (the
 * default), there is no overlay and the method refuses every request with FILES_NOT_ALLOWED.
 *
 * What holds by construction:
 *   - One set of rules. A write is checked by CheckedFile.fromGuest(), the path validation of the app's files and the
 *     content of a FileContent, and its type is a function of its path (I8): FILE_TYPES's for the extension, or
 *     FALLBACK_TYPE. The guest gives a path and bytes, and a write that carries a type of its own is refused. The
 *     write-time quota is FileStore.check() of the build's store with the overlay and this write applied: the count and
 *     the registered bytes, exactly apply()'s first step, without lexing. The commit is FileStore.apply(), the
 *     full check including what module and stylesheet rewrites add. So a write the host could never register is
 *     refused at once with the store's own code, and a commit can still be refused (FILES_QUOTA_EXCEEDED)
 *     if the host registered more in between; a refused commit changes neither the store nor the overlay.
 *   - The host is the single source of truth. A refused request changes nothing here; the guest's own view
 *     (in-sandbox-files.ts) changes only after this module's answer.
 *   - Removal marks are bounded by the guest's base and by the store, with one predicate (`markable`) for recording and
 *     for listing. The base is what the build delivered with the guest's own committed writes over it: a commit takes a
 *     change off the pending list, never out of the guest's view. A removal is recorded only for a path of the base the
 *     store still holds (one the overlay
 *     wrote is then simply forgotten); a path the guest cannot see is answered `change: 'none'` (the guest rejects
 *     NOT_FOUND) and records nothing. A mark whose path the host unregistered later is forgotten before the marks are
 *     listed or committed, so a listed mark always names a stored file. A removal of a path the build delivered and
 *     the host unregistered since changes the guest's view and records nothing (R4:L-4: a recorded mark would be
 *     announced and never listed).
 *   - One diff (R5:N-4, R5:L-4). Every request is recorded by record(), which compares the two projections
 *     of the path before and after it: what listGuestWrites() shows there, and what the guest sees there. The host
 *     announces 'fileswritten' exactly when the first changed, and tells the strict view exactly when the second did, so
 *     the list, the announcement and the view cannot disagree about what a request did.
 *   - Code needs a second opt-in. A commit refuses any file whose type is not on INERT_TYPES unless
 *     `{ code: true }`: JavaScript, HTML, SVG, XML, WebAssembly and every extension the table does not have. The type
 *     checked is the CheckedFile's, the one the store will load the file as, which is the one its name says.
 *   - A commit stores only what the embedder was handed, while it is still what is pending (I4, BD5:DOC-6). Every
 *     recorded change is an entry of its own, and list() mints frozen values the element knows by identity
 *     (MintedWrites, a WeakMap from the value to its entry). A commit looks each value's own entry up and applies it
 *     only while that entry is its path's entry in this overlay: a newer change at the path, a commit, and a build (a
 *     new overlay) each leave it out. Nothing is compared by content, so a copy of a value names no entry. One stale
 *     value commits nothing (all or none).
 *   - The rate is bounded per environment: at most GUEST_WRITES_PER_SECOND requests are handled and at most
 *     GUEST_WRITE_BYTES_PER_SECOND bytes recorded in any one-second window, refused with FILES_BUSY. That also
 *     bounds the host's 'fileswritten' events (one per recorded change).
 *   - An overlay ends with its environment: close() (teardown) refuses every later request, so what the host
 *     inspects after a termination is what that environment wrote. The host discards it at the next build.
 *
 * Host-side only, never stringified into the guest, so it may use module scope freely.
 */
import { CheckedFile, checkPath, describePath, fileError, FILE_TYPES, MAX_TOTAL_BYTES, type FileStore, type FileTypeRow } from './files';
import { mintUncodedError } from './minted-errors';
import { createRateLimiter } from './rate-limit';

/** The reserved broker method the guest's sandboxFiles.write() and remove() call (rpc.ts, reserved names). */
export const WRITE_METHOD = 'sandbox:write';

/**
 * Most guest write and remove requests handled per environment in any one-second window (`guestWrites`); later ones are
 * refused with `FILES_BUSY`. It also bounds the `fileswritten` events.
 */
export const GUEST_WRITES_PER_SECOND = 100;

/**
 * Most bytes of written content recorded per environment in any one-second window (`guestWrites`); later writes are
 * refused with `FILES_BUSY`. It equals the whole file quota, 8 MiB.
 */
export const GUEST_WRITE_BYTES_PER_SECOND = MAX_TOTAL_BYTES;

/**
 * The types commitGuestWrites() applies without `{ code: true }`: the types of FILE_TYPES's inert rows (files.ts), and
 * no other. Exact strings: `image/svg+xml` is a document that can carry script, and FALLBACK_TYPE, an extension the table
 * does not have, is not inert either.
 */
export const INERT_TYPES: ReadonlySet<string> = inertTypes();

function inertTypes(): ReadonlySet<string> {
    const types = new Set<string>();
    for (const row of Object.values(FILE_TYPES) as FileTypeRow[]) if (row.inert) types.add(row.type);
    return types;
}

/**
 * One pending change of the guest, as `listGuestWrites()` reports it: a write (with its `type`, `size`
 * and a copy of the written bytes in `content`) or a removal. Each call reports fresh frozen objects, and a change reaches the
 * files only when such an object is given to `commitGuestWrites()`, which knows the objects its element returned by identity.
 *
 * @remarks
 * The `path` and the `content` are the guest's: attacker text. The `type` is the library's for the path's extension
 * (`application/octet-stream` for one it does not know), never a type the guest gave, so it always agrees with the name;
 * the guest still chooses it by choosing the path (`evil.svg` is `image/svg+xml`). Never make an object URL of `content` with the
 * write's `type` (or none) and open it: an SVG or HTML file is then a document of your origin. Show an image in the sandbox
 * view, or in an `<img>` from a `Blob` you typed `image/png` after checking its signature; offer anything else as a download.
 * Show a path with `textContent`, never
 * in an HTML, URL, `eval`, template or `console` format-string sink (a valid path can hold `'`, `(`, `)`, `;`, `=`, `&`, `!`, `$`, `*`, `+`, `,`
 * and `@`, so one written into a single-quoted attribute can end it and add one).
 */
export type GuestWrite =
    | { readonly path: string; readonly change: 'write'; readonly type: string; readonly size: number; readonly content: Uint8Array }
    | { readonly path: string; readonly change: 'remove' };

/**
 * One recorded change of an overlay: the written file, or null for a removal mark. Each request that records a change
 * makes a new one, so an entry is that change by identity (I4).
 */
export interface PendingWrite {
    readonly path: string;
    readonly file: CheckedFile | null;
}

/** The values one element minted (list()), each to the entry it was made from (I4). */
export type MintedWrites = WeakMap<GuestWrite, PendingWrite>;

/**
 * What the host answers a request, the guest's only source for changing its view. `none`: a removal of a path in
 * neither the store nor the overlay; nothing was recorded (the guest rejects NOT_FOUND).
 */
export type GuestWriteAnswer =
    | { path: string; change: 'write'; type: string; size: number }
    | { path: string; change: 'remove' }
    | { path: string; change: 'none' };

export interface GuestWritesOptions {
    /** The element's store: commits are applied to it, and listed marks are checked against it. */
    store: FileStore;
    /**
     * The store as this environment's build delivered it (FileStore.copy()); `store` when left out. Every answer to the
     * guest is decided against it plus the overlay (BR:CB4): which removals name a file, and the
     * write-time quota. Answered from the live store, a removal or the quota would tell the guest about files the host
     * registered after the build, which the guest otherwise never sees.
     */
    built?: FileStore;
    /** The element's minted values, which list() adds each value it makes to; a fresh map when left out. */
    minted?: MintedWrites;
    now?: () => number;
}

/**
 * What one recorded request changed (R5:N-4, R5:L-4; class D): the one diff of the overlay at the request's
 * path, of which every projection is derived. `listed`: the entry listGuestWrites() shows at the path changed, so
 * 'fileswritten' names it (and only then). `view`: what the guest sees at the path changed, so the strict view is told,
 * with `shown`, what the guest now sees there: the written file, or null for nothing.
 */
export interface GuestWriteDiff {
    listed: boolean;
    view: boolean;
    shown: Readonly<CheckedFile> | null;
}

export interface GuestWrites {
    /** Handles one request from the guest: records it and answers, or throws a FileError (a library code). */
    handle(request: unknown): GuestWriteAnswer;
    /** The same, with what it changed: the one diff the host derives the announcement and the view's change from. */
    record(request: unknown): { answer: GuestWriteAnswer; diff: GuestWriteDiff };
    /** The pending changes, sorted by path: values minted now, each added to `minted`. */
    list(): GuestWrite[];
    /**
     * Applies the given entries (parseCommitArguments) to the store, atomically, and forgets them, if every one is its
     * path's current entry here; returns what the store reports as changed. If any is stale, returns null and changes
     * nothing. Throws FILES_NOT_ALLOWED for a non-inert write without `code`, or the store's refusal; then nothing changes.
     */
    commit(entries: readonly PendingWrite[], code: boolean): string[] | null;
    /**
     * The pending change at `path`, as recorded: the written file (its store type and bytes, not a copy: read them, never
     * change them), null for a removal mark, undefined for none. Strict mode reads it right after handle() to show the
     * view what the guest wrote (R1:R4-4).
     */
    change(path: string): Readonly<CheckedFile> | null | undefined;
    /** Its environment ended: every later request is refused. What was recorded stays listable and committable. */
    close(): void;
}

const WRITE_CALLER = 'sandboxFiles.write()';
const REMOVE_CALLER = 'sandboxFiles.remove()';
const COMMIT_CALLER = 'commitGuestWrites()';

/** One overlay per environment, created by the build when guestWrites is on. */
export function createGuestWrites({ store, built = store, minted = new WeakMap(), now = () => performance.now() }: GuestWritesOptions): GuestWrites {
    // path → the write (a CheckedFile) or a removal mark (null). Never holds a refused request. Each recorded change
    // is a new entry (pend), which is what a minted value commits by (I4).
    const overlay = new Map<string, PendingWrite>();
    const pend = (path: string, file: CheckedFile | null) => overlay.set(path, Object.freeze({ path, file }));
    // Writes the host committed: off the pending list, still in the guest's view, which changes only through the host's
    // answers. The guest's base is the build's files with these over them.
    const committed = new Map<string, CheckedFile>();
    const inBase = (path: string) => committed.has(path) || built.has(path);
    // Paths of the guest's base it removed from its own view (its answer said 'remove'), marked or not: a second removal
    // is 'none', as the guest's sandboxFiles does not list the path. A write to the path brings it back.
    const removedInView = new Set<string>();
    // The one predicate a removal mark is recorded by and kept by (R5:L-4): it names a file the store holds.
    const markable = (path: string) => store.has(path);
    let closed = false;
    // Sliding one-second windows (rate-limit.ts, the limiter the log lines use too): at most the limit in ANY
    // one-second window, as documented. A fixed window would let 199 requests (and twice the bytes)
    // through around a window boundary (FR:W2). One clock reading serves both.
    const requests = createRateLimiter(GUEST_WRITES_PER_SECOND);
    const bytes = createRateLimiter(GUEST_WRITE_BYTES_PER_SECOND);

    const busy = (what: string) => fileError('FILES_BUSY', `${what}: at most ${GUEST_WRITES_PER_SECOND} writes and ${GUEST_WRITE_BYTES_PER_SECOND} bytes per second; retry later.`);

    // The store as the guest sees it, with `path` changed to `file`: what the write-time quota checks.
    const overlaid = (path: string, file: CheckedFile) => {
        const put = new Map<string, CheckedFile>();
        const remove: string[] = [];
        for (const [pending, { file: change }] of overlay) {
            if (pending === path || change === null) continue;
            put.set(pending, change);
        }
        for (const [kept, file] of committed) if (kept !== path && !overlay.has(kept) && !removedInView.has(kept)) put.set(kept, file);
        for (const removed of removedInView) if (removed !== path && !put.has(removed)) remove.push(removed);
        put.set(path, file);
        return { put, remove };
    };

    // One request, its `path` already read (record, below).
    const handleOnce = (request: unknown, path: unknown): GuestWriteAnswer => {
        if (closed) throw fileError('FILES_NOT_ALLOWED', 'the environment that sent this write has ended.');
        // Counted first, refused or not: the window bounds the work a guest can make the host do.
        const time = now();
        if (!requests.admit(time)) throw busy('guest writes refused');

        // Only `change`, `path` and `entry` are read, each once: the request is the guest's structured-cloned data.
        const source = request !== null && typeof request === 'object' ? request as Record<string, unknown> : {};
        const change = source.change;

        if (change === 'remove') {
            checkPath(path, REMOVE_CALLER);
            const written = overlay.get(path)?.file;
            const based = inBase(path);
            // what the guest sees: what it wrote, else its base's file it did not remove
            if (!written && (!based || removedInView.has(path))) return { path, change: 'none' };
            if (based) removedInView.add(path);
            // A file the overlay wrote over nothing is forgotten, not marked: a mark only ever names a stored path.
            if (based && markable(path)) pend(path, null);
            else overlay.delete(path);
            return { path, change: 'remove' };
        }
        if (change !== 'write') throw fileError('INVALID_FILE', 'a guest write request is { change: "write", path, entry } or { change: "remove", path }.');

        const file = CheckedFile.fromGuest(path, source.entry, WRITE_CALLER);
        const valid = path as string; // CheckedFile.fromGuest() checked it
        built.check(overlaid(valid, file), WRITE_CALLER);
        // After the quota, so a write past the cap is FILES_QUOTA_EXCEEDED whatever the rate.
        if (!bytes.admit(time, file.bytes.length)) throw busy(`${WRITE_CALLER} refused`);
        pend(valid, file);
        removedInView.delete(valid);
        return { path: valid, change: 'write', type: file.type, size: file.bytes.length };
    };

    // ---- The one diff (R5:N-4, R5:L-4; class D). The overlay, removedInView and the store are one state, and the host
    // shows it three ways: listGuestWrites(), the 'fileswritten' announcement, and the strict view's copy of what the
    // guest sees (VIEW_WRITE). Deriving each by a predicate of its own would let them disagree: a removal of a file the
    // host had unregistered after the build changes nothing listed, yet the view must stop showing the file the guest no
    // longer has (R5:N-4); a withdrawn write (a new path written, then removed) changes the list and is announced (R5:L-4),
    // since the list changed. So both projections at the request's path are taken before and after it, and compared:
    // the announcement is "the listed entry changed", the view's change is "what the guest sees changed".
    type Listed = CheckedFile | 'remove' | null;
    type Shown = CheckedFile | 'built' | null;
    // What listGuestWrites() shows at `path`: the written file, a removal mark (only one that names a stored file: see
    // forgetStaleMarks), or nothing.
    const listedAt = (path: string): Listed => {
        if (!overlay.has(path)) return null;
        const change = overlay.get(path)!.file;
        if (change === null) return markable(path) ? 'remove' : null;
        return change;
    };
    // What the guest's own sandboxFiles holds at `path`, which is what the strict view may show: what it wrote, else its
    // base's file it did not remove (a committed write of its own, else the build's), else nothing.
    const shownAt = (path: string): Shown => {
        const written = overlay.get(path)?.file;
        if (written) return written;
        if (removedInView.has(path)) return null;
        return committed.get(path) ?? (built.has(path) ? 'built' : null);
    };
    // Two states of a path are the same when they hold the same thing: a file by its type and bytes (writing the same
    // bytes again changes nothing anyone can see), anything else by itself.
    const sameFile = (a: CheckedFile, b: CheckedFile) => {
        if (a === b) return true;
        if (a.type !== b.type || a.bytes.length !== b.bytes.length) return false;
        for (let i = 0; i < a.bytes.length; i++) if (a.bytes[i] !== b.bytes[i]) return false;
        return true;
    };
    const same = (a: Listed | Shown, b: Listed | Shown) => (a instanceof CheckedFile && b instanceof CheckedFile ? sameFile(a, b) : a === b);

    const record = (request: unknown): { answer: GuestWriteAnswer; diff: GuestWriteDiff } => {
        const requested = request !== null && typeof request === 'object' ? (request as { path?: unknown }).path : undefined;
        const path = typeof requested === 'string' ? requested : null;
        const listedBefore = path === null ? null : listedAt(path);
        const shownBefore = path === null ? null : shownAt(path);
        const answer = handleOnce(request, requested);
        if (answer.change === 'none') return { answer, diff: { listed: false, view: false, shown: null } };
        const listedAfter = listedAt(answer.path);
        const shownAfter = shownAt(answer.path);
        return {
            answer,
            diff: {
                listed: !same(listedBefore, listedAfter),
                view: !same(shownBefore, shownAfter),
                shown: shownAfter instanceof CheckedFile ? shownAfter : null,
            },
        };
    };

    // A removal mark names a path the store held when it was recorded; the host may unregister that path later
    // (FR:W3). A mark whose path the store does not hold would remove nothing and only
    // mislead whoever reads the list, so it is forgotten here, where marks are read: list() and commit() call
    // this first, and handle() needs no copy of it (a removal of such a path is answered 'none' anyway).
    const forgetStaleMarks = () => {
        for (const [path, { file }] of [...overlay]) if (file === null && !markable(path)) overlay.delete(path);
    };

    // A frozen value of one entry, which the element knows by identity (I4). `content` is a copy: what the embedder
    // does to it changes neither the entry nor what a commit stores.
    const mint = (entry: PendingWrite): GuestWrite => {
        const { path, file } = entry;
        const value: GuestWrite = Object.freeze(file === null
            ? { path, change: 'remove' as const }
            : { path, change: 'write' as const, type: file.type, size: file.bytes.length, content: file.bytes.slice() });
        minted.set(value, entry);
        return value;
    };

    const list = (): GuestWrite[] => {
        forgetStaleMarks();
        const writes: GuestWrite[] = [];
        for (const path of [...overlay.keys()].sort()) writes.push(mint(overlay.get(path)!));
        return writes;
    };

    // An entry is current while it is its path's entry here; an older one, a committed one and another overlay's are not.
    const allCurrent = (entries: readonly PendingWrite[]) => {
        for (const entry of entries) if (overlay.get(entry.path) !== entry) return false;
        return true;
    };

    const commit = (entries: readonly PendingWrite[], code: boolean): string[] | null => {
        forgetStaleMarks();
        if (!allCurrent(entries)) return null;
        const put = new Map<string, CheckedFile>();
        const remove = new Set<string>();
        for (const { path, file } of entries) {
            if (file === null) {
                remove.add(path);
                continue;
            }
            if (!code && !INERT_TYPES.has(file.type)) {
                throw fileError('FILES_NOT_ALLOWED', `${COMMIT_CALLER} refused ${describePath(path)}: its type ${file.type} is not inert; pass { code: true } to commit files that can run or be parsed as code.`);
            }
            put.set(path, file);
        }
        // Every check before any change: apply() throws and changes nothing, and the overlay is untouched then.
        const changed = store.apply({ put, remove: [...remove] }, COMMIT_CALLER);
        for (const [path, file] of put) {
            overlay.delete(path);
            committed.set(path, file);
        }
        for (const path of remove) {
            overlay.delete(path);
            committed.delete(path);
        }
        return changed;
    };

    const handle = (request: unknown): GuestWriteAnswer => record(request).answer;

    return { handle, record, list, commit, change: (path: string) => overlay.get(path)?.file, close: () => { closed = true; } };
}

/**
 * Checks commitGuestWrites()'s arguments before anything is applied: `writes` is an array (required: there is no
 * commit-all) of values this element minted (`minted`), each read once into its entry, and only a literal `true` in
 * `options.code` commits non-inert files. Throws a TypeError for anything else, a copy of a minted value included (I4).
 */
export function parseCommitArguments(writes: unknown, options: unknown, minted: MintedWrites): { entries: PendingWrite[]; code: boolean } {
    if (!Array.isArray(writes)) throw mintUncodedError(TypeError, `[Sandbox] ${COMMIT_CALLER} expects an array of the values listGuestWrites() returned.`);
    const values: unknown[] = [...writes];
    const entries: PendingWrite[] = [];
    for (const value of values) {
        const entry = minted.get(value as GuestWrite);
        if (!entry) throw mintUncodedError(TypeError, `[Sandbox] ${COMMIT_CALLER} takes only values this element's listGuestWrites() returned, never a copy of one.`);
        entries.push(entry);
    }
    const code = options !== null && typeof options === 'object' && (options as { code?: unknown }).code === true;
    return { entries, code };
}
