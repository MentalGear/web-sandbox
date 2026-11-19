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
import { FRAME_REFERRER_POLICY, WRAPPER_BASE, WRAPPER_STYLE } from './frame-documents';
import { VIEW_OPTIONS, VIEW_STILL_STYLE, STRICT_DIRECTIVE, viewBootstrapSource } from './in-sandbox-view';

/** The file's name, in each build's output directory and in the package's `exports`. */
export const SEALED_DOCUMENT_FILE = 'sealed-document.html';

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

/** The texts of the file that its policy admits by hash. */
export const HASHED_TEXTS = ['guard', 'view', 'still', 'sizing'] as const;
export type HashedText = (typeof HASHED_TEXTS)[number];

/** A source of the file's policy: `blob:`, or the hash of one of the file's own texts. */
export type PolicySource = 'blob:' | { readonly hash: HashedText };

export interface PolicyDirectiveRow {
    /** The directive's sources, in order; with none, the directive is `'none'`. */
    readonly sources: readonly PolicySource[];
    /** Why the directive has these sources. */
    readonly why: string;
}

/**
 * The file's constant policy, one row per directive, in the order of the `<meta>`'s text (design 03, "A constant
 * policy"): scripts by hash, the still stylesheet by hash, `blob:` for the four kinds of file, `worker-src blob:`,
 * `connect-src 'none'`, everything else `'none'`. No `'unsafe-inline'`, no `'unsafe-eval'`, no report directive, and no
 * input: the generator reads this table and the hashes of the library's own texts, nothing else.
 */
export const POLICY_DIRECTIVES = {
    'default-src': { sources: [], why: 'every fetch directive not listed here falls back to it' },
    'script-src': { sources: [{ hash: 'guard' }, { hash: 'view' }], why: "F's guard and C's bootstrap, by hash: no other script runs in F, C or a document either makes" },
    'script-src-attr': { sources: [], why: 'no event handler attribute runs' },
    'style-src': { sources: [{ hash: 'still' }, { hash: 'sizing' }, 'blob:'], why: "the still stylesheet the view inserts for `allowAnimations: false` (VIEW_STILL_STYLE), F's sizing sheet (SEALED_DOCUMENT_STYLE), and the guest's stylesheets as the blob: URLs the view mints; guest styles otherwise go through the CSSOM" },
    'img-src': { sources: ['blob:'], why: "images, from the blob: URLs the view mints for the app's files and writes" },
    'font-src': { sources: ['blob:'], why: "fonts, from the blob: URLs the view mints for the app's files" },
    'media-src': { sources: ['blob:'], why: "media, from the blob: URLs the view mints for the app's files" },
    'connect-src': { sources: [], why: 'sealed mode has no network: the worker reads its files with sandboxFiles.read(), which makes no request' },
    'worker-src': { sources: ['blob:'], why: "the guest's worker, which C starts from a blob: URL" },
    'frame-src': { sources: [], why: 'no frame of the view loads a URL (C itself is a srcdoc)' },
    'object-src': { sources: [], why: 'no plugin content' },
    'base-uri': { sources: [], why: "no <base> after the policy: F's own, about:blank, precedes it, and C inherits that base URL" },
    'form-action': { sources: [], why: 'no form submits anywhere' },
    'manifest-src': { sources: [], why: 'no manifest' },
} as const satisfies Record<string, PolicyDirectiveRow>;

export type PolicyDirective = keyof typeof POLICY_DIRECTIVES;

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

/** A source of the table as it is written in the policy's text. */
function sourceText(source: PolicySource, hashes: Record<HashedText, string>): string {
    return typeof source === 'string' ? source : hashes[source.hash];
}

/** The `<meta>`'s policy text for a file whose view runs `bootstrap`: POLICY_DIRECTIVES, in order. */
function policyText(bootstrap: string): string {
    const hashes = hashesOf(bootstrap);
    const parts: string[] = [];
    for (const [name, row] of Object.entries(POLICY_DIRECTIVES) as [PolicyDirective, PolicyDirectiveRow][]) {
        const sources: string[] = [];
        for (const source of row.sources) sources.push(sourceText(source, hashes));
        parts.push(`${name} ${sources.length === 0 ? "'none'" : sources.join(' ')}`);
    }
    return parts.join('; ');
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

/** C's document: the bootstrap and an empty body. Its policy, base URL and referrer policy are F's, which it inherits. */
function viewDocument(bootstrap: string): string {
    return `<!DOCTYPE html><html><head><script>${bootstrap}</script></head><body></body></html>`;
}

/**
 * The file for a view that runs `bootstrap`. Only `sealedDocument()` gives it a bootstrap, and the tests, to show that
 * another text gives other bytes. In F's head, in order: the charset (a served file has no other source of it), the
 * inert base URL C inherits (WRAPPER_BASE, before the policy, whose `base-uri` is `'none'`), the policy, the referrer
 * policy C inherits, the guard, and the sizing sheet (SEALED_DOCUMENT_STYLE, by its hash). Then C, which the sheet makes
 * fill F; its presentational attributes give it the width and no border where a sheet would not apply.
 */
export function renderSealedDocument(bootstrap: string): string {
    assertHashableScript(bootstrap);
    const head = '<meta charset="utf-8">'
        + `<base href="${WRAPPER_BASE}">`
        + `<meta http-equiv="Content-Security-Policy" content="${escapeFileAttribute(policyText(bootstrap))}">`
        + `<meta name="referrer" content="${FRAME_REFERRER_POLICY}">`
        + `<script>${SEALED_DOCUMENT_GUARD}</script>`
        + `<style>${SEALED_DOCUMENT_STYLE}</style>`;
    const view = `<iframe sandbox="${SEALED_VIEW_FLAGS.join(' ')}" referrerpolicy="${FRAME_REFERRER_POLICY}" width="100%" height="100%" frameborder="0" srcdoc="${escapeFileAttribute(viewDocument(bootstrap))}"></iframe>`;
    return `<!DOCTYPE html><html><head>${head}</head><body marginwidth="0" marginheight="0">${view}</body></html>\n`;
}

/** `sealed-document.html`: one text per library version, the same in both builds (I12). It takes no input. */
export function sealedDocument(): string {
    return renderSealedDocument(sealedViewBootstrap());
}
