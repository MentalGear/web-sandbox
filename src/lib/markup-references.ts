import type { CSPDirectives } from "../csp-directives";
import { rewriteInlineModule } from "./module-specifiers";
import { cssUrlReferences, replaceRanges } from "./css-references";
import { srcsetCandidates } from "./srcset";
import { effectiveDirective } from "./csp/effective-directive";

/**
 * Markup references to registered files (ADR-004, PR2). Host-only: nothing here is stringified into
 * the guest; the guest side is inSandboxMarkup (in-sandbox-files.ts).
 *
 * Guest markup such as `<script src="app.js">` or `<img src="img/logo.svg">` names a file by a
 * relative URL. The guest itself cannot resolve it: its base URL is the wrapper's inert about:blank
 * (S15, frame-documents.ts), so every relative URL fails closed. So the host resolves it, before the
 * guest exists, against a virtual document URL, VIRTUAL_DOCUMENT_URL, the way a browser would if the
 * markup were served as index.html next to the files:
 *
 *   1. parse the markup with DOMParser (in the HOST window), find the URL-bearing attributes listed in
 *      REFERENCE_SELECTOR, and resolve each against VIRTUAL_DOCUMENT_URL;
 *   2. each one that names a registered file exactly becomes a sentinel,
 *      `vfs-slot-<per-build 128-bit nonce>-<index>`;
 *   3. serialise, and split on the sentinels into parts: [markup, path, markup, path, ..., markup].
 *
 * The bootstrap then writes the parts, each path replaced by the guest's own blob: URL, with one
 * document.write() as its last statement. The markup is still parsed by the guest's parser, from the
 * same place in the document, so parser-inserted script order (sync, defer, async, module) and
 * document.currentScript behave as if the files were served, and the CSP <meta> stays the first element
 * of <head> (S2): the write happens inside the bootstrap script, which follows it.
 *
 * If nothing matched, there are no parts and the guest document is built exactly as before (the
 * original markup verbatim). So the rewrite only ever happens to markup that names a registered file.
 *
 * With the module graph (PR3, when JavaScript files are registered) the same parse also rewrites the
 * relative specifiers of inline `<script type="module">` against VIRTUAL_DOCUMENT_URL, as for a
 * registered module, and takes the guest's inline `<script type="importmap">` elements out of the
 * markup, for the host to merge into the one import map the bootstrap registers (import-map.ts).
 * Either counts as a change, so the markup is then written by the bootstrap even with no slot.
 *
 * With CSS references (PR4) the same parse also cuts slots into `srcset` of `img` and `source` (each
 * candidate URL that names a file; srcset.ts), and into the CSS of `<style>` elements and `style=""`
 * attributes (each url() or @import that names a file; css-references.ts). A CSS slot replaces a URL
 * reference with a CSS string, `"<sentinel>"`, and its part tells the bootstrap to escape the blob: URL
 * for a CSS string (and then for the attribute, in a `style` attribute) rather than for an attribute.
 *
 * Safety of parsing untrusted markup here: DOMParser.parseFromString() creates an inert document. It
 * has no browsing context, its scripting flag is off, scripts in it never run, and nothing in it is
 * fetched (no images, styles or frames), so the host page runs nothing of the guest's. What the host
 * writes into the guest is only ever the guest's own markup (re-serialised) and the guest's own blob:
 * URLs, so the rewrite grants the guest nothing it could not already do with sandboxFiles.url().
 */

/** The URL guest markup is resolved against: a document at the root of the files. */
export const VIRTUAL_DOCUMENT_URL = 'https://vfs.invalid/index.html';
export const VIRTUAL_ROOT = 'https://vfs.invalid/';

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

// The attributes that name a file by one URL. srcset and CSS (PR4) are handled below, by their own
// parsers; <iframe src>, <embed>, <object>, <a href>, imagesrcset and anything inside <template> stay as
// written. Imports inside inline modules are the module graph's (rewriteGuestMarkup, below).
export const REFERENCES: readonly (readonly [element: string, attribute: string])[] = [
    ['script', 'src'],
    ['link', 'href'],
    ['img', 'src'],
    ['source', 'src'],
    ['video', 'src'],
    ['video', 'poster'],
    ['audio', 'src'],
    ['track', 'src'],
];
const REFERENCE_SELECTOR = REFERENCES.map(([element, attribute]) => `${element}[${attribute}]`).join(', ');
const SRCSET_SELECTOR = 'img[srcset], source[srcset]';

// A <link> loads a file only for these relations (any one of its rel tokens).
const LINK_RELATIONS = new Set(['stylesheet', 'icon', 'preload', 'modulepreload']);

const ASCII_WHITESPACE = /[\t\n\f\r ]+/;

/**
 * The path in the files' URL space that `value` names when resolved against `baseUrl`, or null when it
 * cannot name a file: empty or blank, unparsable, outside VIRTUAL_ROOT (another origin, or credentials
 * or a port in the URL), or with a query or a fragment (even an empty one). Whether a file is registered
 * at that path is the caller's question. Used for markup (against VIRTUAL_DOCUMENT_URL) and for CSS
 * (against the stylesheet's own virtual URL, files.ts).
 */
export function virtualPathOf(value: string, baseUrl: string): string | null {
    if (/^[\u0000-\u0020]*$/.test(value)) return null; // what the URL parser strips: nothing left is the base itself
    let href: string;
    try {
        href = new URL(value, baseUrl).href;
    } catch {
        return null;
    }
    if (!href.startsWith(VIRTUAL_ROOT)) return null;
    const path = href.slice(VIRTUAL_ROOT.length);
    if (path.includes('?') || path.includes('#')) return null;
    return path;
}

/**
 * The registered path that `value` names when resolved against `baseUrl` (by default
 * VIRTUAL_DOCUMENT_URL), or null.
 *
 * Resolution is the URL parser's, as a browser would do it: `logo.svg`, `./logo.svg`, `/logo.svg`,
 * `img/../logo.svg` (also spelled `img/%2e%2e/logo.svg`, a dot segment by the URL standard) and
 * `https://vfs.invalid/logo.svg` all name `logo.svg`, and nothing can resolve above the root. The
 * result must then equal a registered path exactly. Paths are validated so that the URL parser keeps
 * them unchanged (files.ts), so a spelling that the parser keeps different — another case, any other
 * percent-encoding, a query or a fragment — names no file and is left as written, where it fails
 * closed: relative, it cannot resolve against the guest's about:blank base; absolute, the policy
 * refuses it. Queries and fragments are not stripped:
 * `logo.svg?v=2` asks for something a blob: URL cannot give (a blob URL with a query names no blob).
 * An empty or whitespace-only value is never a reference (it would resolve to index.html itself): a
 * browser does not load `src=""` either.
 */
export function resolveReference(value: string, paths: ReadonlySet<string>, baseUrl: string = VIRTUAL_DOCUMENT_URL): string | null {
    const path = virtualPathOf(value, baseUrl);
    return path !== null && paths.has(path) ? path : null;
}

/** A fresh 128-bit nonce, as 32 hex characters. One per environment build. */
export function createSlotNonce(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

const slotName = (nonce: string, index: number) => `vfs-slot-${nonce}-${index}`;

/**
 * Where a slot's blob: URL lands, which decides how the bootstrap escapes it (inSandboxMarkup):
 *   a path alone             a double-quoted attribute value (src, href, poster, srcset)
 *   [path, 'css']            a double-quoted CSS string in the raw text of a <style> element
 *   [path, 'css-attribute']  a double-quoted CSS string inside a double-quoted style attribute
 */
export type CssSlot = [path: string, context: 'css' | 'css-attribute'];
/** [markup, slot, markup, slot, ..., markup]: even indexes are markup, odd indexes are slots. */
export type MarkupParts = (string | CssSlot)[];

/**
 * Rewrites the references in `markup` that name a file in `paths`. Returns the parts
 * [markup, path, markup, ..., markup] (odd indexes are paths), or null when no reference matched, in
 * which case the caller must use `markup` unchanged. The sentinels use a fresh nonce from
 * createSlotNonce() unless one is given (tests); the parts never contain it.
 *
 * Only elements in the HTML namespace count, and a <link> only for the relations in LINK_RELATIONS.
 * When something matched, the markup comes back re-serialised from the parsed tree, which normalises
 * it the way the guest's own parser would have (see ADR-004, "Markup references"): quoting and case of
 * tags and attributes, implied and closing tags, character references; the doctype is dropped (the
 * guest document has its own, and a later one is ignored by the parser anyway).
 */
export function rewriteMarkupReferences(markup: string, paths: ReadonlySet<string>, givenNonce?: string): MarkupParts | null {
    return rewriteGuestMarkup(markup, paths, { modules: false }, givenNonce).parts;
}

export interface GuestMarkupOptions {
    // The module graph is on (JavaScript files are registered and the bootstrap can register an import
    // map): rewrite inline module scripts and take out the guest's inline import maps.
    modules: boolean;
    // Called when an inline module cannot be lexed (it is then left as written); `index` counts the
    // inline module scripts in document order, from 0.
    onModuleFailure?: (index: number) => void;
}

export interface GuestMarkup {
    parts: MarkupParts | null; // as rewriteMarkupReferences returns them; null: use the markup as written
    importMaps: string[]; // the texts of the inline import maps taken out, in document order
}

// Inline scripts only: a module script with src is a markup reference, and an import map with src is
// not supported by any engine (it fires an error), so it is left as written.
const INLINE_SCRIPT_SELECTOR = 'script:not([src])';

// A script's type as the HTML standard reads it: the attribute, ASCII whitespace stripped, ASCII case-insensitive.
const scriptType = (script: Element) => (script.getAttribute('type') ?? '').replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').toLowerCase();

/**
 * rewriteMarkupReferences, plus the module graph's changes when `options.modules` is set: inline
 * module scripts (no src) get their relative specifiers rewritten against VIRTUAL_DOCUMENT_URL, and
 * inline import maps (no src) are removed and returned. `parts` is non-null when anything changed;
 * a build that only rewrote modules or took out a map returns a single part and draws no nonce.
 */
export function rewriteGuestMarkup(markup: string, paths: ReadonlySet<string>, options: GuestMarkupOptions, givenNonce?: string): GuestMarkup {
    if (givenNonce !== undefined && !/^[0-9a-f]{32}$/.test(givenNonce)) throw new Error('[Sandbox] the slot nonce must be 32 lowercase hex characters');
    const unchanged: GuestMarkup = { parts: null, importMaps: [] };
    if (paths.size === 0 || markup === '') return unchanged;
    let nonce = givenNonce; // drawn at the first match: a build that rewrites nothing draws none

    // Inert: no script runs and nothing is fetched (see the comment at the top of this file).
    const doc = new DOMParser().parseFromString(markup, 'text/html');

    const slots: (string | CssSlot)[] = [];
    for (const element of doc.querySelectorAll(REFERENCE_SELECTOR)) {
        if (element.namespaceURI !== HTML_NAMESPACE) continue;
        const tag = element.localName;
        if (tag === 'link' && !hasLoadingRelation(element)) continue;
        for (const [referenceTag, attribute] of REFERENCES) {
            if (referenceTag !== tag) continue;
            const value = element.getAttribute(attribute);
            if (value === null) continue;
            const path = resolveReference(value, paths);
            if (path === null) continue;
            nonce ??= createSlotNonce();
            element.setAttribute(attribute, slotName(nonce, slots.length));
            slots.push(path);
        }
    }

    // A slot for each reference in `refs` that names a registered file; `text` becomes the slot's
    // markup. Returns the rewritten source, or null when nothing named a file.
    const cutSlots = (source: string, refs: readonly { start: number; end: number; url: string }[], slot: (path: string) => string | CssSlot, text: (name: string) => string): string | null => {
        const edits: { start: number; end: number; text: string }[] = [];
        for (const ref of refs) {
            const path = resolveReference(ref.url, paths);
            if (path === null) continue;
            nonce ??= createSlotNonce();
            edits.push({ start: ref.start, end: ref.end, text: text(slotName(nonce, slots.length)) });
            slots.push(slot(path));
        }
        return edits.length === 0 ? null : replaceRanges(source, edits);
    };

    // srcset (PR4): each candidate URL that names a file; the others stay as written
    for (const element of doc.querySelectorAll(SRCSET_SELECTOR)) {
        if (element.namespaceURI !== HTML_NAMESPACE) continue;
        const value = element.getAttribute('srcset')!;
        const rewritten = cutSlots(value, srcsetCandidates(value), path => path, name => name);
        if (rewritten !== null) element.setAttribute('srcset', rewritten);
    }

    // CSS (PR4): url() and @import in <style> text and in style attributes. A reference becomes a CSS
    // string holding the sentinel; the bootstrap puts the URL into that string, escaped for it.
    for (const style of doc.querySelectorAll('style')) {
        if (style.namespaceURI !== HTML_NAMESPACE) continue;
        const text = style.textContent ?? '';
        const rewritten = cutSlots(text, cssUrlReferences(text), path => [path, 'css'], name => `"${name}"`);
        if (rewritten !== null) style.textContent = rewritten;
    }
    for (const element of doc.querySelectorAll('[style]')) {
        if (element.namespaceURI !== HTML_NAMESPACE) continue;
        const value = element.getAttribute('style')!;
        const rewritten = cutSlots(value, cssUrlReferences(value), path => [path, 'css-attribute'], name => `"${name}"`);
        if (rewritten !== null) element.setAttribute('style', rewritten);
    }

    let modulesChanged = false;
    const importMaps: string[] = [];
    if (options.modules) {
        let moduleIndex = 0;
        for (const script of doc.querySelectorAll(INLINE_SCRIPT_SELECTOR)) {
            if (script.namespaceURI !== HTML_NAMESPACE || scriptType(script) !== 'module') continue;
            const index = moduleIndex++;
            const rewritten = rewriteInlineModule(script.textContent ?? '', VIRTUAL_DOCUMENT_URL, () => options.onModuleFailure?.(index));
            if (rewritten === null) continue;
            script.textContent = rewritten;
            modulesChanged = true;
        }
        for (const script of doc.querySelectorAll(INLINE_SCRIPT_SELECTOR)) {
            if (script.namespaceURI !== HTML_NAMESPACE || scriptType(script) !== 'importmap') continue;
            importMaps.push(script.textContent ?? '');
            script.remove();
        }
    }
    if (slots.length === 0 && !modulesChanged && importMaps.length === 0) return unchanged;

    const serialised = serialiseDocument(doc);
    if (slots.length === 0 || nonce === undefined) return { parts: [serialised], importMaps };

    // Split on this build's sentinels. The nonce is random per build and appears nowhere else, so guest
    // markup cannot contain a sentinel; even if it could, a slot index only ever names one of the
    // guest's own files, whose URL it could already get from sandboxFiles.url().
    const parts: MarkupParts = [];
    const pattern = new RegExp(`vfs-slot-${nonce}-(\\d+)`, 'g');
    let last = 0;
    for (const match of serialised.matchAll(pattern)) {
        const path = slots[Number(match[1])];
        if (path === undefined) continue; // not one of ours: left in the markup as text
        parts.push(serialised.slice(last, match.index), path);
        last = match.index + match[0].length;
    }
    parts.push(serialised.slice(last));
    return { parts, importMaps };
}

function hasLoadingRelation(link: Element): boolean {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(ASCII_WHITESPACE);
    return rel.some(token => LINK_RELATIONS.has(token));
}

// The document's children in order, without the doctype: comments around <html>, and <html> itself.
function serialiseDocument(doc: Document): string {
    let html = '';
    for (const node of doc.childNodes) {
        if (node.nodeType === node.ELEMENT_NODE) html += (node as Element).outerHTML;
        else if (node.nodeType === node.COMMENT_NODE) html += `<!--${(node as Comment).data}-->`;
    }
    return html;
}

const tokensOf = (values: readonly unknown[]): string[] => {
    const tokens: string[] = [];
    for (const value of values) {
        if (typeof value !== 'string') continue;
        for (const token of value.trim().split(/\s+/)) if (token) tokens.push(token.toLowerCase());
    }
    return tokens;
};

/**
 * Whether the guest's inline bootstrap can run under these (final) directives. An inline <script> element is
 * checked against the directive that governs 'script-src-elem' (the one fallback table, effective-directive.ts:
 * script-src-elem, then script-src, then default-src); it must allow 'unsafe-inline', and must carry no nonce,
 * hash or 'strict-dynamic' (each makes the browser ignore 'unsafe-inline'). The markup is written by the
 * bootstrap only when it can run; otherwise it stays in the document as written. (Review A3: script-src-elem
 * used to be ignored here, so a policy that refused the bootstrap through it went unwarned.)
 */
export function inlineScriptsAllowed(directives: CSPDirectives): boolean {
    const governing = effectiveDirective(directives, 'script-src-elem');
    const values = governing === null ? undefined : directives[governing];
    if (!Array.isArray(values)) return false;
    const tokens = tokensOf(values);
    if (!tokens.includes("'unsafe-inline'")) return false;
    return !tokens.some(token => token === "'strict-dynamic'" || /^'(nonce|sha256|sha384|sha512)-/.test(token));
}
