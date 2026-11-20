/**
 * Sealed mode's served file and its digest, as every loader of the library gets them (design 03, "The check of the
 * file"; src/lib/document-digest.ts). One function, `servedDocument()`, generates the file the way the build writes it:
 * `sealedDocument()` (src/lib/sealed-document.ts) run by Bun from the sources on disk, in a process of its own, so the
 * view's functions are printed by Bun whoever asks. The build (scripts/build-lib.ts) writes its text into dist/ and
 * defines its digest in the bundle; Vite's server and vitest put the same digest into src/lib/document-digest.ts as
 * they serve it (`servedDocumentDigestPlugin`, in vite.config.ts and vitest.config.ts). So the digest the library
 * compares with and the bytes the build writes come from one generation, in every way the library is loaded.
 *
 * Run as a script (`bun scripts/served-document.ts`), it prints the file's text: that is the process `servedDocument()`
 * starts.
 */
import { execFileSync, execFile } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { statedDigest } from '../src/lib/document-digest';

/** The identifier src/lib/document-digest.ts declares, which every loader replaces with the digest's string literal. */
export const DOCUMENT_DIGEST_DEFINE = '__WEB_SANDBOX_DOCUMENT_DIGEST__';

// (vitest gives a module its directory, and its URL in a scheme of its own)
const ROOT = typeof import.meta.dirname === 'string' ? resolve(import.meta.dirname, '..') : fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'served-document.ts');
// the bootstrap is a few hundred kilobytes of text: room for it on stdout
const MAX_BUFFER = 64 * 1024 * 1024;

/** The served file and its digest, which the file states as its version. */
export interface ServedDocument {
    readonly text: string;
    readonly digest: string;
}

// The digest the file states of itself, which is its version (src/lib/document-digest.ts): a generation whose file states
// none, or one that does not hold, gives no loader a digest.
function withDigest(text: string): ServedDocument {
    const digest = statedDigest(text);
    if (digest === null) throw new Error('scripts/served-document.ts: the generated file does not state its own digest');
    return { text, digest };
}

/** The file as the build writes it, from the sources on disk now, and its digest. */
export function servedDocument(): ServedDocument {
    return withDigest(execFileSync('bun', [SCRIPT], { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER }));
}

/** The same, without blocking the caller (Vite's server, while it answers other requests). */
export async function servedDocumentAsync(): Promise<ServedDocument> {
    const { stdout } = await promisify(execFile)('bun', [SCRIPT], { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER });
    return withDigest(stdout);
}

// What the plugin uses of a Vite server: written out, as Vite and vitest's own copy of Vite each type it their way.
interface DevServer {
    readonly watcher: { on(event: string, listener: (file: string) => void): unknown };
    readonly moduleGraph: { getModulesByFile(file: string): Set<any> | undefined; invalidateModule(module: any): void };
}

/** The plugin, as Vite and vitest take it. */
export interface DigestPlugin {
    readonly name: string;
    readonly enforce: 'post';
    transform(code: string, id: string): Promise<{ code: string; map: null } | null>;
    configureServer(server: DevServer): void;
}

/** The module whose identifier the digest replaces. */
const DIGEST_MODULE = join(ROOT, 'src', 'lib', 'document-digest.ts');
const SOURCES = join(ROOT, 'src') + sep;

// A module id as Vite gives it: a path, with a query after `?` where there is one.
const pathOf = (id: string) => id.split('?')[0]!;

/**
 * The Vite plugin (Vite's server, its build of the playground, and vitest): src/lib/document-digest.ts is served with
 * the digest in place of its identifier, as the bundle has it. The digest is made once, and again after any file of src/
 * changed (the server's watcher), when the module is next asked for: a page loaded after the sources changed compares
 * with the file the build would write from them now, so dist/ rebuilt from them passes and one older than them does not.
 */
export function servedDocumentDigestPlugin(): DigestPlugin {
    let digest: Promise<string> | null = null;
    const current = () => (digest ??= servedDocumentAsync().then(served => served.digest));
    return {
        name: 'web-sandbox-served-document-digest',
        enforce: 'post' as const,
        async transform(code: string, id: string) {
            if (pathOf(id) !== DIGEST_MODULE) return null;
            const literal = JSON.stringify(await current());
            return { code: code.replaceAll(DOCUMENT_DIGEST_DEFINE, literal), map: null };
        },
        configureServer(server: DevServer) {
            const changed = (file: string) => {
                if (!resolve(file).startsWith(SOURCES)) return;
                digest = null;
                for (const module of server.moduleGraph.getModulesByFile(DIGEST_MODULE) ?? []) server.moduleGraph.invalidateModule(module);
            };
            server.watcher.on('add', changed);
            server.watcher.on('change', changed);
            server.watcher.on('unlink', changed);
        },
    };
}

if (import.meta.main) {
    const { sealedDocument } = await import('../src/lib/sealed-document');
    process.stdout.write(sealedDocument());
}
