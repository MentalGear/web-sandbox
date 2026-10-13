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
 * A lookup is an exact Map lookup of the given string: nothing is resolved, decoded or normalised,
 * so `../x`, `%2e%2e/x`, `/x` or another instance's path is simply absent. Every failed lookup is the
 * same plain Error with an own `code: 'NOT_FOUND'` (the B7 shape), minted here, and its message
 * names nothing but the code.
 */
export function inSandboxFiles(entries: FileSnapshotEntry[]) {
    const files = new Map<string, { blob: Blob; url: string }>();
    // Uint8Array.fromBase64 where the engine has it (much faster), else atob and a copy loop
    const fromBase64 = (Uint8Array as unknown as { fromBase64?: (b64: string) => Uint8Array<ArrayBuffer> }).fromBase64;
    const decode = (b64: string) => {
        if (typeof fromBase64 === 'function') return fromBase64.call(Uint8Array, b64);
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    };
    for (const entry of entries) {
        const bytes = decode(entry[2]);
        const blob = new Blob([bytes], { type: entry[1] });
        files.set(entry[0], { blob, url: URL.createObjectURL(blob) });
    }

    const notFound = () => {
        const error = new Error('[sandboxFiles] NOT_FOUND: no such file') as Error & { code: string };
        error.code = 'NOT_FOUND';
        return error;
    };
    const lookup = (path: unknown) => {
        const file = typeof path === 'string' ? files.get(path) : undefined;
        if (!file) throw notFound();
        return file;
    };

    (globalThis as any).sandboxFiles = Object.freeze({
        list: () => Array.from(files.keys()),
        url: (path: string) => lookup(path).url,
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
    });
}
