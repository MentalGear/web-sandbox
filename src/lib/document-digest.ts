/**
 * The digest of `sealed-document.html` this copy of the library was built with (design 03, "The check of the file"):
 * what the check of the file (document-check.ts) compares the served bytes with.
 *
 * The file's bytes depend on how the view's functions are printed (in-sandbox-view.ts, viewBootstrapSource), which is the
 * printing of whatever loaded the sources: Bun's for the build, Vite's for the e2e server's pages, vitest's for the unit
 * tests. So the library never computes the digest from its own sources: every loader is given it, as the value of one
 * identifier, by one function, `servedDocument()` of scripts/served-document.ts, which generates the file the way the
 * build writes it (Bun, from the sources on disk) and hashes it with {@link documentDigest}:
 *
 * - the build (scripts/build-lib.ts) writes those very bytes into dist/ and defines their digest in the bundle, so the
 *   bundle carries a constant and none of the file's text (design 03, "A thinner host");
 * - Vite's server and vitest put the digest in this module as they serve it (scripts/served-document.ts,
 *   `servedDocumentDigestPlugin`), again whenever a source changes, so a reused e2e server whose dist/ was rebuilt from
 *   the same sources accepts that file, and one whose dist/ is older than the sources refuses it.
 *
 * A loader that gives none (the sources run some other way) has no digest, and the check ends the build rather than
 * pass a file it cannot compare.
 */
import { sha256Base64 } from './csp/script-hash';
import { mintUncodedError } from './minted-errors';

// The identifier every loader replaces with the digest's string literal (scripts/served-document.ts names it).
declare const __WEB_SANDBOX_DOCUMENT_DIGEST__: string | undefined;

/** The digest of a served file's bytes: SHA-256, in base64. The one hash the build, the loaders and the check use. */
export function documentDigest(bytes: Uint8Array): string {
    return sha256Base64(bytes);
}

/** The digest of the file this library was built with. Throws where the loader gave none. */
export function sealedDocumentDigest(): string {
    if (typeof __WEB_SANDBOX_DOCUMENT_DIGEST__ === 'string') return __WEB_SANDBOX_DOCUMENT_DIGEST__;
    throw mintUncodedError(Error, "[Sandbox] this copy of the library was loaded without the digest of its sealed-document.html, so the served file cannot be checked: import the built package (dist/index.js)");
}
