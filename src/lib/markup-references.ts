import type { CSPDirectives } from "../csp-directives";
import { rewriteInlineModule } from "./module-specifiers";

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
 * Safety of parsing untrusted markup here: DOMParser.parseFromString() creates an inert document. It
 * has no browsing context, its scripting flag is off, scripts in it never run, and nothing in it is
 * fetched (no images, styles or frames), so the host page runs nothing of the guest's. What the host
 * writes into the guest is only ever the guest's own markup (re-serialised) and the guest's own blob:
 * URLs, so the rewrite grants the guest nothing it could not already do with sandboxFiles.url().
 */

/** The URL guest markup is resolved against: a document at the root of the files. */
export const VIRTUAL_DOCUMENT_URL = 'https://vfs.invalid/index.html';
const VIRTUAL_ROOT = 'https://vfs.invalid/';

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

// The attributes that name a file, and nothing else: srcset (PR4), CSS url() (PR4), <iframe src>,
// <embed>, <object>, <a href> and anything inside <template> stay as written. Imports inside inline
// modules are the module graph's (rewriteGuestMarkup, below).
const REFERENCES: readonly (readonly [element: string, attribute: string])[] = [
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

// A <link> loads a file only for these relations (any one of its rel tokens).
const LINK_RELATIONS = new Set(['stylesheet', 'icon', 'preload', 'modulepreload']);

const ASCII_WHITESPACE = /[\t\n\f\r ]+/;

/**
 * The registered path that `value` names when resolved against VIRTUAL_DOCUMENT_URL, or null.
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
export function resolveReference(value: string, paths: ReadonlySet<string>): string | null {
    if (/^[\u0000-\u0020]*$/.test(value)) return null; // what the URL parser strips: nothing left is the document itself
    let href: string;
    try {
        href = new URL(value, VIRTUAL_DOCUMENT_URL).href;
    } catch {
        return null;
    }
    if (!href.startsWith(VIRTUAL_ROOT)) return null; // another origin, or credentials or a port in the URL
    const path = href.slice(VIRTUAL_ROOT.length);
    if (path.includes('?') || path.includes('#')) return null; // a query or fragment, even an empty one
    return paths.has(path) ? path : null;
}

/** A fresh 128-bit nonce, as 32 hex characters. One per environment build. */
export function createSlotNonce(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

const slotName = (nonce: string, index: number) => `vfs-slot-${nonce}-${index}`;

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
export function rewriteMarkupReferences(markup: string, paths: ReadonlySet<string>, givenNonce?: string): string[] | null {
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
    parts: string[] | null; // as rewriteMarkupReferences returns them; null: use the markup as written
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

    const slots: string[] = [];
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
    const parts: string[] = [];
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
 * Whether the guest's inline bootstrap can run under these (final) directives: script-src, or
 * default-src when script-src is left out, must allow 'unsafe-inline', and must carry no nonce, hash
 * or 'strict-dynamic' (each makes the browser ignore 'unsafe-inline'). The markup is written by the
 * bootstrap only when it can run; otherwise it stays in the document as written.
 */
export function inlineScriptsAllowed(directives: CSPDirectives): boolean {
    const values = directives['script-src'] ?? directives['default-src'];
    if (!Array.isArray(values)) return false;
    const tokens = tokensOf(values);
    if (!tokens.includes("'unsafe-inline'")) return false;
    return !tokens.some(token => token === "'strict-dynamic'" || /^'(nonce|sha256|sha384|sha512)-/.test(token));
}
