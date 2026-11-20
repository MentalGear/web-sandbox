/**
 * The digest of `sealed-document.html` this copy of the library was built with (design 03, "The check of the file" and
 * "A file of another version"): what the check of the file (document-check.ts) compares the served bytes with, and what
 * the view announces as its version. One value for both: the file states its own digest, and the digest is taken of the
 * file with that statement left out.
 *
 * - **The file states it.** The view's document carries it in one attribute of its root element
 *   ({@link VERSION_ATTRIBUTE}), outside every text the file's policy admits by hash, so the file can hold the digest of
 *   the rest of itself: the generator (sealed-document.ts, renderSealedDocument) writes the file with the attribute
 *   empty, takes that text's SHA-256, and writes it into the attribute. The view reads the attribute and announces it
 *   (in-sandbox-view.ts): a copy states the version it was generated as, and nothing more, since a document can say
 *   whatever it likes about itself.
 * - **The check reads it.** The served bytes are this version's file exactly when they state this digest, once, in that
 *   attribute, and the bytes without it hash to it ({@link holdsDigest}): every other byte is compared, the stated
 *   version and its place among them.
 *
 * The file's bytes depend on how the view's functions are printed (in-sandbox-view.ts, viewBootstrapSource), which is the
 * printing of whatever loaded the sources: Bun's for the build, Vite's for the e2e server's pages, vitest's for the unit
 * tests. So the library never computes the digest from its own sources: every loader is given it, as the value of one
 * identifier, by one function, `servedDocument()` of scripts/served-document.ts, which generates the file the way the
 * build writes it (Bun, from the sources on disk) and reads the digest the file states ({@link statedDigest}):
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

/**
 * The attribute of the view document's root element that states the file's digest, its version. Outside every hashed
 * text of the file, so the digest it holds does not change what the policy admits.
 */
export const VERSION_ATTRIBUTE = 'data-web-sandbox-version';

/** SHA-256, in base64: the one hash the generator, the loaders and the check use. */
export function documentDigest(bytes: Uint8Array): string {
    return sha256Base64(bytes);
}

// Where `needle` occurs in `bytes`: the index of its one occurrence, or -1 where it occurs never or more than once.
function onlyOccurrence(bytes: Uint8Array, needle: Uint8Array): number {
    let found = -1;
    for (let start = 0; start + needle.length <= bytes.length; start++) {
        let matches = true;
        for (let offset = 0; offset < needle.length && matches; offset++) matches = bytes[start + offset] === needle[offset];
        if (!matches) continue;
        if (found !== -1) return -1;
        found = start;
    }
    return found;
}

// The file's statement of a digest, as its text holds it: the attribute inside the view's `srcdoc`, its quotes escaped.
const STATEMENT_OPEN = `${VERSION_ATTRIBUTE}=&quot;`;
const STATEMENT_CLOSE = '&quot;';

/**
 * Whether `bytes` are the file whose digest is `digest`: the file states it, in its one statement of a version, exactly
 * once, and the bytes without the digest hash to it. So the stated version is compared with every other byte of the
 * file, and with where it stands: the same bytes with the digest anywhere else are another file.
 */
export function holdsDigest(bytes: Uint8Array, digest: string): boolean {
    if (digest === '') return false;
    const encoder = new TextEncoder();
    const statement = encoder.encode(STATEMENT_OPEN + digest + STATEMENT_CLOSE);
    const at = onlyOccurrence(bytes, statement);
    if (at === -1) return false;
    const from = at + encoder.encode(STATEMENT_OPEN).length;
    const length = encoder.encode(digest).length;
    const rest = new Uint8Array(bytes.length - length);
    rest.set(bytes.subarray(0, from), 0);
    rest.set(bytes.subarray(from + length), from);
    return documentDigest(rest) === digest;
}

/**
 * The digest a generated file states of itself, read from its text: the value of {@link VERSION_ATTRIBUTE}, as the file
 * writes it inside the view's `srcdoc` (its quotes escaped). Null where the text states none, or states one that does
 * not hold ({@link holdsDigest}).
 */
export function statedDigest(text: string): string | null {
    const found = new RegExp(`${STATEMENT_OPEN}([A-Za-z0-9+/=]*)${STATEMENT_CLOSE}`).exec(text);
    if (found === null) return null;
    const digest = found[1]!;
    return holdsDigest(new TextEncoder().encode(text), digest) ? digest : null;
}

/** The digest of the file this library was built with: its version. Throws where the loader gave none. */
export function sealedDocumentDigest(): string {
    if (typeof __WEB_SANDBOX_DOCUMENT_DIGEST__ === 'string') return __WEB_SANDBOX_DOCUMENT_DIGEST__;
    throw mintUncodedError(Error, "[Sandbox] this copy of the library was loaded without the digest of its sealed-document.html, so the served file cannot be checked: import the built package (dist/index.js)");
}
