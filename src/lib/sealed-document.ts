/**
 * Sealed mode's served document, `sealed-document.html` (design 03, "Inside the file"): the one static file per library
 * version that the embedder serves, generated at build time by scripts/build-lib.ts into each build's output directory,
 * and exported by the package as `./sealed-document.html`.
 *
 *   F, the file:  <meta> policy (POLICY_DIRECTIVES), the guard (its one script), the sizing sheet, then in its static markup
 *   C, the view:  <iframe sandbox="SEALED_VIEW_FLAGS" srcdoc="…">, whose document holds sealed mode's view bootstrap
 *
 * The file has no input (I12): `sealedDocument()` takes no argument and reads nothing but constants of the library, so
 * the same sources write the same bytes in the default build and in the build with the network modes. Its text is
 * sealed mode's view bootstrap, which is the view alone in every build (`sealedViewBootstrap()`: no fetch bridge frame's
 * part, whatever the build installed), wrapped in markup and a policy that are constants here. F runs no script but the
 * guard, which is synchronous and adds no listener (I13): the ports go from the host page to C.
 *
 * Not imported by the library: read by the build script and the tests (BUILD_MODULES, `data`).
 */
import { SAFE_CAPABILITIES } from '../csp-directives';
import { STRICT_VIEW_FLAGS } from './config-schema';
import { assertHashableScript, scriptHashSource } from './csp/script-hash';
import { documentDigest, VERSION_ATTRIBUTE } from './document-digest';
import { FRAME_REFERRER_POLICY, SEALED_DOCUMENT_FILE, WRAPPER_BASE, WRAPPER_STYLE } from './frame-documents';
import { VIEW_OPTIONS, VIEW_STILL_STYLE, STRICT_DIRECTIVE, viewBootstrapSource } from './in-sandbox-view';
import { HASHED_TEXTS, POLICY_ATTRIBUTE, POLICY_DIRECTIVES, policyText as policyOf, type HashedText, type PolicyDirective, type PolicyDirectiveRow, type PolicySource } from './policy-check';

export { SEALED_DOCUMENT_FILE, HASHED_TEXTS, POLICY_DIRECTIVES, type HashedText, type PolicyDirective, type PolicyDirectiveRow, type PolicySource };

/**
 * F's one script (design 03, "the guard"): a document that is not opaque, or that is the top-level document, stops
 * parsing, so C is never built where F holds an origin's authority or is not framed (I14). Synchronous, with no listener,
 * and it reports nothing.
 */
export const SEALED_DOCUMENT_GUARD = `${STRICT_DIRECTIVE}if (self.origin !== 'null' || top === self) window.stop();`;

/**
 * C's static `sandbox` attribute (design 03, "the sandbox flags"): the most the library ever grants a view, strict mode's
 * view flags and the safe capabilities, never `allow-same-origin`. A nested frame has the restrictions of every frame
 * above it, so the element narrows this per app with F's own attribute, and nothing that frames F gives C more.
 */
export const SEALED_VIEW_FLAGS: readonly string[] = [...new Set<string>([...STRICT_VIEW_FLAGS, ...SAFE_CAPABILITIES])];

/**
 * F's one stylesheet (design 03, "C's size in F"): C fills F. Without it C is 300 by 150 pixels in F on every engine: the
 * attributes `width` and `height` do not give a frame its height in a standards-mode document, and neither C (opaque to
 * F) nor the host page (F is opaque to it) can size C from outside. It is the wrapper's text (WRAPPER_STYLE), the same
 * rule for the same frame, admitted by its hash, so the policy stays one constant text.
 */
export const SEALED_DOCUMENT_STYLE = WRAPPER_STYLE;

/**
 * Sealed mode's view bootstrap: the view alone, with no fetch bridge frame's part, so it is one text in every build (I12).
 * The default build's element runs this very text (scripts/build-lib.ts checks it); the network build's element runs its
 * own bootstrap, with the bridge's branch, under the name `viewScriptHash()` hashes. Throws if the text could not be
 * hashed as written (assertHashableScript).
 */
export function sealedViewBootstrap(): string {
    const text = viewBootstrapSource(VIEW_OPTIONS, null);
    assertHashableScript(text);
    return text;
}

/** The hash source of each text the policy admits by hash, for a file whose view runs `bootstrap`. */
function hashesOf(bootstrap: string): Record<HashedText, string> {
    return {
        guard: scriptHashSource(SEALED_DOCUMENT_GUARD),
        view: scriptHashSource(bootstrap),
        still: scriptHashSource(VIEW_STILL_STYLE),
        sizing: scriptHashSource(SEALED_DOCUMENT_STYLE),
    };
}

/** The `<meta>`'s policy text for a file whose view runs `bootstrap`: POLICY_DIRECTIVES, in order (policy-check.ts). */
function policyText(bootstrap: string): string {
    return policyOf(hashesOf(bootstrap));
}

/** The file's `<meta>` policy text: constant for a library version. */
export function sealedDocumentPolicy(): string {
    return policyText(sealedViewBootstrap());
}

/**
 * Escapes a text for a double-quoted attribute of the file, `<` and `>` included, so that F's own bytes hold exactly one
 * `<script` and one `<iframe`, whatever C's document holds. The parser decodes it back to the same text, so the hash the
 * browser computes of C's script is the hash of `text`'s script.
 */
function escapeFileAttribute(text: string): string {
    return text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * C's document: the version it states (VERSION_ATTRIBUTE) and the `<meta>`'s text (POLICY_ATTRIBUTE), on its root
 * element, which the bootstrap reads (it announces the version, and holds every violation's policy to the text), the
 * bootstrap and an empty body. Its policy, base URL and referrer policy are F's, which it inherits.
 */
function viewDocument(bootstrap: string, version: string): string {
    return `<!DOCTYPE html><html ${VERSION_ATTRIBUTE}="${version}" ${POLICY_ATTRIBUTE}="${policyText(bootstrap)}"><head><script>${bootstrap}</script></head><body></body></html>`;
}

/**
 * The file for a view that runs `bootstrap`, stating its own version (design 03, "A file of another version";
 * document-digest.ts): the file is laid out with the version empty, and the digest of that text is the version written
 * into it. Only `sealedDocument()` gives it a bootstrap, and the tests, to show that another text gives other bytes and
 * states another version.
 */
export function renderSealedDocument(bootstrap: string): string {
    assertHashableScript(bootstrap);
    const version = documentDigest(new TextEncoder().encode(layOut(bootstrap, '')));
    return layOut(bootstrap, version);
}

/**
 * The file's text for `bootstrap` and the `version` its view states. In F's head, in order: the charset (a served file
 * has no other source of it), the inert base URL C inherits (WRAPPER_BASE, before the policy, whose `base-uri` is
 * `'none'`), the policy, the referrer policy C inherits, the guard, and the sizing sheet (SEALED_DOCUMENT_STYLE, by its
 * hash). Then C, which the sheet makes fill F; its presentational attributes give it the width and no border where a
 * sheet would not apply. The version is outside every hashed text, so the policy is the same whatever it states.
 */
function layOut(bootstrap: string, version: string): string {
    const head = '<meta charset="utf-8">'
        + `<base href="${WRAPPER_BASE}">`
        + `<meta http-equiv="Content-Security-Policy" content="${escapeFileAttribute(policyText(bootstrap))}">`
        + `<meta name="referrer" content="${FRAME_REFERRER_POLICY}">`
        + `<script>${SEALED_DOCUMENT_GUARD}</script>`
        + `<style>${SEALED_DOCUMENT_STYLE}</style>`;
    const view = `<iframe sandbox="${SEALED_VIEW_FLAGS.join(' ')}" referrerpolicy="${FRAME_REFERRER_POLICY}" width="100%" height="100%" frameborder="0" srcdoc="${escapeFileAttribute(viewDocument(bootstrap, version))}"></iframe>`;
    return `<!DOCTYPE html><html><head>${head}</head><body marginwidth="0" marginheight="0">${view}</body></html>\n`;
}

/** `sealed-document.html`: one text per library version, the same in both builds (I12). It takes no input. */
export function sealedDocument(): string {
    return renderSealedDocument(sealedViewBootstrap());
}
