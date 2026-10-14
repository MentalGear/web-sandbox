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
export function inSandboxFiles(entries: FileSnapshotEntry[], writeFiles?: ((request: unknown) => Promise<unknown>) | null) {
    // `url` is null for a path the guest wrote: never minted (see above)
    const files = new Map<string, { blob: Blob; url: string | null }>();
    // Uint8Array.fromBase64 where the engine has it (much faster), else atob and a copy loop
    const fromBase64 = (Uint8Array as unknown as { fromBase64?: (b64: string) => Uint8Array<ArrayBuffer> }).fromBase64;
    const decode = (b64: string) => {
        if (typeof fromBase64 === 'function') return fromBase64.call(Uint8Array, b64);
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    };
    // A double-quoted CSS string holding `url`: every character that could end or break the string,
    // or end a <style> element, is a CSS escape, so the result never depends on the format of a blob: URL.
    const cssString = (url: string) => '"' + url.replace(/[\u0000-\u001f\u007f"'\\<>]/g, (c: string) => '\\' + c.charCodeAt(0).toString(16) + ' ') + '"';
    for (const entry of entries) {
        const bytes = decode(entry[2]);
        const blob = new Blob([bytes], { type: entry[1] });
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
                    const target = files.get((replacement as [string])[0]);
                    if (!target) continue; // not made yet: the reference keeps its registered bytes
                    text = cssString(target.url as string); // every snapshot file has one: only written files do not
                }
                parts.push(blob.slice(at, edits[i] as number), text);
                at = edits[i + 1] as number;
            }
            parts.push(blob.slice(at));
            loaded = new Blob(parts, { type: entry[1] });
        }
        files.set(entry[0], { blob, url: URL.createObjectURL(loaded) });
    }

    const notFound = () => {
        const error = new Error('[sandboxFiles] NOT_FOUND: no such file') as Error & { code: string };
        error.code = 'NOT_FOUND';
        return error;
    };
    const notAllowed = () => {
        const error = new Error('[sandboxFiles] FILES_NOT_ALLOWED: guest writes are off') as Error & { code: string };
        error.code = 'FILES_NOT_ALLOWED';
        return error;
    };
    const lookup = (path: unknown) => {
        const file = typeof path === 'string' ? files.get(path) : undefined;
        if (!file) throw notFound();
        return file;
    };

    // The bytes of a written entry, copied now; a Promise for a Blob's; null for content the host does not
    // accept, sent as null so the host refuses it with INVALID_FILE.
    const copyOf = (content: unknown): Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>> | null => {
        if (typeof content === 'string') return new TextEncoder().encode(content);
        if (content instanceof ArrayBuffer) return new Uint8Array(content.slice(0));
        if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength).slice();
        if (typeof Blob === 'function' && content instanceof Blob) return content.arrayBuffer().then((buffer: ArrayBuffer) => new Uint8Array(buffer));
        return null;
    };
    const isContent = (value: unknown) => typeof value !== 'object' || value === null || value instanceof ArrayBuffer || ArrayBuffer.isView(value) || (typeof Blob === 'function' && value instanceof Blob);
    // Requests leave in call order: each is sent only after the one before it was (its `ready` may be a Blob's read).
    let order: Promise<unknown> = Promise.resolve();
    const noop = () => {};
    const inTurn = (ready: unknown, send: (value: any) => Promise<void>): Promise<void> => {
        const turn = order.then(() => ready);
        const result = turn.then(send); // registered before `order` below, so it runs first when `turn` settles
        order = turn.then(noop, noop);
        return result;
    };

    const write = (path: unknown, entry: unknown): Promise<void> => {
        if (!writeFiles) return Promise.reject(notAllowed());
        const send = writeFiles;
        const target = typeof path === 'string' ? path : null;
        let ready: Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>> | null;
        let type: unknown;
        let wrapped: boolean;
        // Everything that inspects the guest's entry runs inside the try (focused review 2026-10-14, W4): an
        // instanceof on a Proxy runs its getPrototypeOf trap, which can throw, and write() must reject then,
        // never throw where the caller awaits a promise.
        try {
            wrapped = !isContent(entry);
            ready = copyOf(wrapped ? (entry as { content?: unknown }).content : entry);
            if (wrapped) type = (entry as { type?: unknown }).type;
        } catch (e) {
            return Promise.reject(e);
        }
        const typeOverride = typeof type === 'string' ? type : null;
        return inTurn(ready, (bytes: Uint8Array<ArrayBuffer> | null) => send({ change: 'write', path: target, entry: wrapped ? { content: bytes, type: typeOverride } : bytes }).then((answer: any) => {
            // the host recorded it: its answer names the path and the type the store gave it
            if (bytes && answer && answer.change === 'write' && answer.path === target) files.set(target as string, { blob: new Blob([bytes], { type: answer.type }), url: null });
        }));
    };

    const remove = (path: unknown): Promise<void> => {
        if (!writeFiles) return Promise.reject(notAllowed());
        const send = writeFiles;
        const target = typeof path === 'string' ? path : null;
        return inTurn(null, () => send({ change: 'remove', path: target }).then((answer: any) => {
            if (answer && answer.change === 'remove' && answer.path === target) {
                files.delete(target as string);
                return;
            }
            throw notFound(); // 'none': in neither the host's store nor the guest's writes; nothing was recorded
        }));
    };

    const api = Object.freeze({
        list: () => Array.from(files.keys()).sort(), // the literal is in dependency order, not path order
        url: (path: string) => {
            const url = lookup(path).url;
            if (url === null) throw notFound(); // a path the guest wrote has no URL
            return url;
        },
        read: (path: string) => {
            try {
                return lookup(path).blob.arrayBuffer().then((buffer: ArrayBuffer) => new Uint8Array(buffer));
            } catch (e) {
                return Promise.reject(e);
            }
        },
        text: (path: string) => {
            try {
                return lookup(path).blob.text();
            } catch (e) {
                return Promise.reject(e);
            }
        },
        write: (path: string, entry: unknown) => write(path, entry),
        remove: (path: string) => remove(path),
    });
    (globalThis as any).sandboxFiles = api;
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
