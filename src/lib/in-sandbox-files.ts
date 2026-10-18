import type { FileSnapshotEntry } from './files';

/**
 * This function is stringified and injected into the sandbox (iframe or worker), after the comms
 * script and before any guest markup. Like inSandboxScript and createBroker it must be self-contained:
 * it closes over nothing from module scope, and uses no syntax the build compiles into module-scope
 * helpers (no async/await), since the stringified body would call helpers the guest does not have.
 *
 * It receives the host's file snapshot as one inline literal, [[path, type, base64], ...], and turns
 * every entry into a Blob and a blob: URL created in THIS realm, synchronously, so the URLs exist
 * before the parser reaches any guest markup. Only this realm's blob: URLs load here: a URL minted by
 * the host page or by another sandbox is refused by the blob store (docs/research/blob-delivery-probe.md,
 * section 4). The blobs belong to this document or worker and are freed with it. The host installs
 * it in every environment, with an empty list when no file is registered, so the API always exists.
 *
 * Published as `globalThis.sandboxFiles`:
 *   list()      the registered paths, sorted
 *   url(path)   the file's blob: URL; throws NOT_FOUND
 *   read(path)  Promise<Uint8Array>, a fresh copy per call; rejects NOT_FOUND
 *   text(path)  Promise<string>, decoded as UTF-8; rejects NOT_FOUND
 *
 * A JavaScript file whose relative specifiers the host rewrote (module-specifiers.ts) carries the
 * rewrite as a fourth element: byte ranges of the registered content and their replacements. Its URL
 * names the module form, assembled from slices of the registered blob and the replacement texts, so
 * the literal carries the file once; read() and text() return the bytes as registered.
 *
 * A stylesheet whose url() and @import references name registered files (css-references.ts) carries
 * the same fourth element, with a slot, `[path]`, in place of a replacement text: the reference becomes
 * a CSS string holding that file's blob: URL from THIS realm, escaped for a CSS string. So a stylesheet
 * can only be assembled once the URLs it names exist: the host orders the literal so that every file
 * comes after the files it references, and leaves every reference that lies on a cycle out (files.ts).
 * This loop is one pass in literal order and looks a slot up in the files made so far; a slot naming a
 * file not made yet (which the host's order never produces) keeps its bytes as registered, where it
 * fails closed. Nothing here follows a reference, so nothing can loop.
 *
 * A lookup is an exact Map lookup of the given string: nothing is resolved, decoded or normalised,
 * so `../x`, `%2e%2e/x`, `/x` or another instance's path is simply absent. Every failed lookup is the
 * same plain Error with an own `code: 'NOT_FOUND'` (the B7 shape), minted here, and its message
 * names nothing but the code.
 *
 * Guest writes (backlog C5, guest-writes.ts): `write(path, entry)` and `remove(path)` exist in every
 * environment. `writeFiles` is the bootstrap's captured call of the reserved sandbox:write method
 * (inSandboxScript), or null when the embedder did not set `guestWrites`: then both reject with
 * FILES_NOT_ALLOWED without sending anything (the host refuses the method itself too; that refusal is the
 * guarantee, this one only saves the round trip). With it:
 *   - nothing is checked here: the host validates path, entry, quota and rate and answers, and this map
 *     changes only after its answer, so the host is the single source of truth and a refused request
 *     leaves both sides unchanged; the type a written file reads back with is the host's (the store's);
 *   - the bytes are copied when write() is called (a Blob is immutable, so reading it later reads the same
 *     bytes), and requests leave in call order whatever a Blob's read takes;
 *   - list(), read() and text() show the guest's acknowledged writes and removals; url() of a written path
 *     throws NOT_FOUND, here and in every mode. No blob: URL is minted for anything the guest wrote, so what
 *     a URL names is always a file of this build's snapshot (in strict mode the view never sees the overlay
 *     at all; committed files reach it as registered files in a later build);
 *   - removing a path the host holds in neither its store nor the guest's writes rejects NOT_FOUND, minted
 *     here from the host's answer.
 */
// `urlTypes` (strict mode's worker, review round 1 R2-4): the only types url() mints a URL for, VIEW_FILE_TYPES. A URL
// the worker minted reaches the view only as a string in rendered markup, and the view admits it as an image only for
// a type it would show itself: a URL for any other type (an SVG) is one the view could be made to load as CSS. Any other
// file is read() and text() only; url() of it is NOT_FOUND. Null or absent: every file gets one (cooperative, worker).
export function inSandboxFiles(entries: FileSnapshotEntry[], writeFiles?: ((request: unknown) => Promise<unknown>) | null, urlTypes?: readonly string[] | null) {
    // ---- The captured list (review round 2, C-1): sandboxFiles' methods run whenever guest code calls them, so what they
    // use is taken here, before any guest code runs, and nothing below reads a global or a prototype guest code can
    // replace (a unit test scans the text). Promises are made with the captured Promise and chained with the captured
    // `then`, and this code never uses the promise a `then` returns. Two lookups of the realm stay reachable all the same
    // (review round 3, C-5): `then` makes the promise it returns through the species constructor, read from
    // `Promise.prototype.constructor[Symbol.species]`, and resolving with an object reads its `then`, inherited from
    // `Object.prototype` when guest code put one there. Both run guest code that can change only what the guest's own
    // sandboxFiles calls resolve with, in its own realm.
    const g = globalThis as any;
    const apply = Reflect.apply;
    const construct = Reflect.construct;
    const defineOwn = Reflect.defineProperty;
    const getOwn = Object.getOwnPropertyDescriptor;
    const protoOf = Object.getPrototypeOf;
    const freeze = Object.freeze;
    const MapConstructor = Map;
    const mapGet = Map.prototype.get;
    const mapSet = Map.prototype.set;
    const mapDelete = Map.prototype.delete;
    const mapForEach = Map.prototype.forEach;
    const arraySort = Array.prototype.sort;
    const PromiseConstructor = Promise;
    const resolved = Promise.resolve;
    const rejected = Promise.reject;
    const then = Promise.prototype.then;
    const ErrorConstructor = Error;
    const BlobConstructor = Blob;
    const blobSlice = Blob.prototype.slice;
    const blobBytes = Blob.prototype.arrayBuffer;
    const blobText = Blob.prototype.text;
    const blobSize = getOwn(Blob.prototype, 'size')!.get!;
    const createURL = URL.createObjectURL;
    const URLConstructor = URL;
    const Uint8ArrayConstructor = Uint8Array;
    const typedArrayPrototype = protoOf(Uint8Array.prototype);
    const typedSet = typedArrayPrototype.set;
    const typedBuffer = getOwn(typedArrayPrototype, 'buffer')!.get!;
    const typedOffset = getOwn(typedArrayPrototype, 'byteOffset')!.get!;
    const typedLength = getOwn(typedArrayPrototype, 'byteLength')!.get!;
    const viewBuffer = getOwn(DataView.prototype, 'buffer')!.get!;
    const viewOffset = getOwn(DataView.prototype, 'byteOffset')!.get!;
    const viewLength = getOwn(DataView.prototype, 'byteLength')!.get!;
    const bufferBytes = getOwn(ArrayBuffer.prototype, 'byteLength')!.get!;
    const isView = ArrayBuffer.isView;
    const encoder = new TextEncoder();
    const encode = TextEncoder.prototype.encode;
    const charCodeAt = String.prototype.charCodeAt;
    const numberText = Number.prototype.toString;
    // Uint8Array.fromBase64 where the engine has it (much faster), else atob and a copy loop
    const fromBase64 = (Uint8Array as unknown as { fromBase64?: (b64: string) => Uint8Array<ArrayBuffer> }).fromBase64;
    const atobFn = g.atob;
    const CAPTURE_POINT = 'nothing below reads a global, or an intrinsic guest code can replace';

    const get = <K, V>(map: Map<K, V>, key: K): V | undefined => apply(mapGet, map, [key]);
    const set = <K, V>(map: Map<K, V>, key: K, value: V) => { apply(mapSet, map, [key, value]); };
    const append = (target: unknown[], value: unknown) => defineOwn(target, target.length, { value, writable: true, enumerable: true, configurable: true });
    // A promise for what `onOk` (or `onError`) makes of `value` once it settles; see the captured list.
    const after = <T, R>(value: T | Promise<T>, onOk: (result: T) => R | Promise<R>, onError?: (error: unknown) => R | Promise<R>): Promise<R> =>
        construct(PromiseConstructor, [(resolve: (result: R | Promise<R>) => void, reject: (error: unknown) => void) => {
            apply(then, apply(resolved, PromiseConstructor, [value]), [
                (result: T) => {
                    try {
                        resolve(onOk(result));
                    } catch (error) {
                        reject(error);
                    }
                },
                (error: unknown) => {
                    if (!onError) {
                        reject(error);
                        return;
                    }
                    try {
                        resolve(onError(error));
                    } catch (failure) {
                        reject(failure);
                    }
                },
            ]);
        }]);
    const refuse = (error: unknown): Promise<never> => apply(rejected, PromiseConstructor, [error]);

    // `url` is null for a path the guest wrote: never minted (see above)
    const files = new MapConstructor() as Map<string, { blob: Blob; url: string | null }>;
    const decode = (b64: string): Uint8Array<ArrayBuffer> => {
        if (typeof fromBase64 === 'function') return apply(fromBase64, Uint8ArrayConstructor, [b64]);
        const binary = apply(atobFn, g, [b64]) as string;
        const bytes = new Uint8ArrayConstructor(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = apply(charCodeAt, binary, [i]);
        return bytes;
    };
    // A double-quoted CSS string holding `url`: every character that could end or break the string,
    // or end a <style> element, is a CSS escape, so the result never depends on the format of a blob: URL.
    const cssString = (url: string) => {
        let out = '"';
        for (let i = 0; i < url.length; i++) {
            const code = apply(charCodeAt, url, [i]) as number;
            const escaped = code <= 0x1f || code === 0x7f || code === 0x22 || code === 0x27 || code === 0x5c || code === 0x3c || code === 0x3e;
            out += escaped ? '\\' + apply(numberText, code, [16]) + ' ' : url[i];
        }
        return out + '"';
    };
    const mints = (type: string) => {
        if (!urlTypes) return true;
        for (let i = 0; i < urlTypes.length; i++) if (urlTypes[i] === type) return true;
        return false;
    };
    for (let e = 0; e < entries.length; e++) {
        const entry = entries[e]!;
        const bytes = decode(entry[2]);
        const blob = construct(BlobConstructor, [[bytes], { type: entry[1] }]) as Blob;
        const edits = entry[3];
        let loaded = blob;
        if (edits) {
            const parts: BlobPart[] = [];
            let at = 0;
            for (let i = 0; i < edits.length; i += 3) {
                const replacement = edits[i + 2];
                let text: string;
                if (typeof replacement === 'string') {
                    text = replacement;
                } else {
                    const target = get(files, (replacement as [string])[0]);
                    if (!target || target.url === null) continue; // not made yet, or given no URL: the reference keeps its registered bytes
                    text = cssString(target.url as string); // every snapshot file has one: only written files do not
                }
                append(parts, apply(blobSlice, blob, [at, edits[i] as number]));
                append(parts, text);
                at = edits[i + 1] as number;
            }
            append(parts, apply(blobSlice, blob, [at]));
            loaded = construct(BlobConstructor, [parts, { type: entry[1] }]) as Blob;
        }
        set(files, entry[0], { blob, url: mints(entry[1]) ? apply(createURL, URLConstructor, [loaded]) as string : null });
    }

    // Every failed lookup's error: a plain Error with an own `code` (defined, so no setter guest code put on a prototype
    // runs), its message naming nothing but the code.
    const coded = (message: string, code: string) => {
        const error = new ErrorConstructor(message);
        defineOwn(error, 'code', { value: code, writable: true, enumerable: true, configurable: true });
        return error;
    };
    const notFound = () => coded('[sandboxFiles] NOT_FOUND: no such file', 'NOT_FOUND');
    const notAllowed = () => coded('[sandboxFiles] FILES_NOT_ALLOWED: guest writes are off', 'FILES_NOT_ALLOWED');
    const lookup = (path: unknown) => {
        const file = typeof path === 'string' ? get(files, path) : undefined;
        if (!file) throw notFound();
        return file;
    };

    // A copy of the bytes an ArrayBuffer, a typed array or a DataView holds (copied with set(), which consults no
    // species constructor), or null for anything else.
    const VIEW_GETTERS = [[typedBuffer, typedOffset, typedLength], [viewBuffer, viewOffset, viewLength]];
    const bytesCopy = (value: unknown): Uint8Array<ArrayBuffer> | null => {
        let source: Uint8Array | null = null;
        try {
            source = construct(Uint8ArrayConstructor, [value, 0, apply(bufferBytes, value, [])]);
        } catch {
            for (let i = 0; i < VIEW_GETTERS.length && !source; i++) {
                const getters = VIEW_GETTERS[i]!;
                try {
                    source = construct(Uint8ArrayConstructor, [apply(getters[0]!, value, []), apply(getters[1]!, value, []), apply(getters[2]!, value, [])]);
                } catch {
                    source = null;
                }
            }
        }
        if (!source) return null;
        const copy = construct(Uint8ArrayConstructor, [apply(typedLength, source, [])]) as Uint8Array<ArrayBuffer>;
        apply(typedSet, copy, [source]);
        return copy;
    };
    const isBlob = (value: unknown) => {
        try {
            return typeof apply(blobSize, value, []) === 'number';
        } catch {
            return false;
        }
    };
    const isBuffer = (value: unknown) => {
        try {
            return typeof apply(bufferBytes, value, []) === 'number';
        } catch {
            return false;
        }
    };

    // The bytes of a written entry, copied now; a Promise for a Blob's; null for content the host does not
    // accept, sent as null so the host refuses it with INVALID_FILE.
    const copyOf = (content: unknown): Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>> | null => {
        if (typeof content === 'string') return apply(encode, encoder, [content]);
        if (isBuffer(content) || isView(content)) return bytesCopy(content);
        if (isBlob(content)) return after(apply(blobBytes, content, []) as Promise<ArrayBuffer>, (buffer: ArrayBuffer) => construct(Uint8ArrayConstructor, [buffer]) as Uint8Array<ArrayBuffer>);
        return null;
    };
    const isContent = (value: unknown) => typeof value !== 'object' || value === null || isBuffer(value) || isView(value) || isBlob(value);
    // Requests leave in call order: each is sent only after the one before it was (its `ready` may be a Blob's read).
    let order: Promise<unknown> = apply(resolved, PromiseConstructor, [undefined]);
    const noop = () => {};
    const inTurn = (ready: unknown, step: (value: any) => Promise<void>): Promise<void> => {
        const turn = after(order, () => ready);
        const result = after(turn, step); // registered before `order` below, so it runs first when `turn` settles
        order = after(turn, noop, noop);
        return result;
    };

    const write = (path: unknown, entry: unknown): Promise<void> => {
        if (!writeFiles) return refuse(notAllowed());
        const send = writeFiles;
        const target = typeof path === 'string' ? path : null;
        let ready: Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>> | null;
        let type: unknown;
        let wrapped: boolean;
        // Everything that inspects the guest's entry runs inside the try (focused review 2026-10-14, W4): a brand
        // check on a Proxy can throw, and write() must reject then, never throw where the caller awaits a promise.
        try {
            wrapped = !isContent(entry);
            ready = copyOf(wrapped ? (entry as { content?: unknown }).content : entry);
            if (wrapped) type = (entry as { type?: unknown }).type;
        } catch (e) {
            return refuse(e);
        }
        const typeOverride = typeof type === 'string' ? type : null;
        return inTurn(ready, (bytes: Uint8Array<ArrayBuffer> | null) => after(send({ change: 'write', path: target, entry: wrapped ? { content: bytes, type: typeOverride } : bytes }), (answer: any) => {
            // the host recorded it: its answer names the path and the type the store gave it
            if (bytes && answer && answer.change === 'write' && answer.path === target) set(files, target as string, { blob: construct(BlobConstructor, [[bytes], { type: answer.type }]) as Blob, url: null });
        }));
    };

    const remove = (path: unknown): Promise<void> => {
        if (!writeFiles) return refuse(notAllowed());
        const send = writeFiles;
        const target = typeof path === 'string' ? path : null;
        return inTurn(null, () => after(send({ change: 'remove', path: target }), (answer: any) => {
            if (answer && answer.change === 'remove' && answer.path === target) {
                apply(mapDelete, files, [target]);
                return;
            }
            throw notFound(); // 'none': in neither the host's store nor the guest's writes; nothing was recorded
        }));
    };

    const api = freeze({
        list: () => {
            // the literal is in dependency order, not path order
            const paths: string[] = [];
            apply(mapForEach, files, [(_file: unknown, path: string) => append(paths, path)]);
            apply(arraySort, paths, []);
            return paths;
        },
        url: (path: string) => {
            const url = lookup(path).url;
            if (url === null) throw notFound(); // a path the guest wrote has no URL
            return url;
        },
        read: (path: string) => {
            try {
                return after(apply(blobBytes, lookup(path).blob, []) as Promise<ArrayBuffer>, (buffer: ArrayBuffer) => construct(Uint8ArrayConstructor, [buffer]) as Uint8Array<ArrayBuffer>);
            } catch (e) {
                return refuse(e);
            }
        },
        text: (path: string) => {
            try {
                return apply(blobText, lookup(path).blob, []) as Promise<string>;
            } catch (e) {
                return refuse(e);
            }
        },
        write: (path: string, entry: unknown) => write(path, entry),
        remove: (path: string) => remove(path),
    });
    defineOwn(g, 'sandboxFiles', { value: api, writable: true, enumerable: true, configurable: true });
    // returned too, so the bootstrap's next step (inSandboxMarkup) uses this very object, never a global
    return api;
}

/**
 * Stringified into the guest document as the LAST statement of the bootstrap, when the host rewrote
 * guest markup that names registered files (markup-references.ts). Same rules as inSandboxFiles:
 * self-contained, no async/await.
 *
 * `parts` is [markup, path, markup, path, ..., markup]: the guest's markup, already parsed and
 * re-serialised by the host, cut where an attribute named a file. Each path is replaced by this
 * realm's blob: URL for it, and the whole is written with one document.write(). Called from the
 * parser-inserted bootstrap script, the write puts the markup into the parser's input right after that
 * script, so it is parsed by the guest's own parser exactly where the markup would otherwise begin:
 * its scripts are parser-inserted (sync, defer, async and module keep their ordering, and
 * document.currentScript is set), and the CSP <meta> before the bootstrap stays first (S2).
 *
 * `files` is the object inSandboxFiles just returned, never a lookup of the global: nothing the guest
 * wrote can run before this, but the bootstrap does not depend on that. A slot that is a path sits
 * inside a double-quoted attribute value (the host's serialiser quotes them so); a CSS slot,
 * [path, context], sits inside a double-quoted CSS string, in the raw text of a <style> ('css') or in
 * a double-quoted style attribute ('css-attribute'). The URL is escaped for exactly that context
 * anyway — CSS escapes for every character that could end the string or the <style>, then attribute
 * escapes — so the written markup never depends on the format of a blob: URL.
 */
export function inSandboxMarkup(files: { url(path: string): string }, parts: (string | [string, string])[]) {
    const attribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const cssStringContent = (value: string) => value.replace(/[\u0000-\u001f\u007f"'\\<>]/g, (c: string) => '\\' + c.charCodeAt(0).toString(16) + ' ');
    let markup = '';
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        if (i % 2 === 0) markup += part as string;
        else if (typeof part === 'string') markup += attribute(files.url(part));
        else markup += part[1] === 'css' ? cssStringContent(files.url(part[0])) : attribute(cssStringContent(files.url(part[0])));
    }
    document.write(markup);
}

/**
 * Stringified into the guest document after inSandboxFiles, when at least one JavaScript file is
 * registered (module graph, ADR-004 PR3). Same rules: self-contained, no async/await.
 *
 * Registers the document's one import map, before the parser reaches any guest markup and before any
 * module script or import(): Firefox honours only the first import map of a document, and none once a
 * module script was prepared (docs/research/blob-delivery-probe.md, section 3). Every registered
 * JavaScript file's virtual URL, https://vfs.invalid/<path>, maps to this realm's blob: URL for it:
 * the URL url(path) returns and markup references use, so a module named both ways is one entry in the
 * module map and is evaluated once. The host rewrote every relative specifier to such a virtual URL.
 *
 * `guestMap` is the guest's own inline import maps, merged by the host and serialised as JSON (or
 * null): those elements were removed from the markup so that this stays the only map in every engine.
 * Our entries are written after the guest's, so ours win; the host already dropped every guest entry
 * whose key could match a https://vfs.invalid/ URL (import-map.ts).
 *
 * The element is inserted through the DOM, so its text never passes through the HTML parser; the JSON
 * still has every "<" escaped. An inline import map is registered when the element is inserted, so
 * the element is removed again at once and the guest's document is not changed by it. Returns `files`,
 * for the next step of the bootstrap.
 */
export function inSandboxImportMap<T extends { url(path: string): string }>(files: T, paths: string[], guestMap: string | null): T {
    const map = guestMap ? JSON.parse(guestMap) : {};
    if (!map.imports) map.imports = {};
    for (let i = 0; i < paths.length; i++) {
        map.imports['https://vfs.invalid/' + paths[i]] = files.url(paths[i] as string);
    }
    const script = document.createElement('script');
    script.type = 'importmap';
    script.textContent = JSON.stringify(map).replace(/</g, '\\u003c');
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    return files;
}
