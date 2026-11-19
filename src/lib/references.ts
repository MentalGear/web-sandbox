/**
 * What names a registered file in markup and in CSS (ADR-004): the files' virtual URL space, the attributes that hold a
 * reference, and the path a reference resolves to. Read by the view's renderer (in-sandbox-view.ts) and the file store
 * (files.ts) in every build; cooperative mode's rewrite of the guest's markup is built on it (markup-references.ts).
 *
 * Host-side values, never stringified into a guest as functions.
 */
import type { LoadKindName } from './load-kinds';

/** The URL guest markup is resolved against: a document at the root of the files. */
export const VIRTUAL_DOCUMENT_URL = 'https://vfs.invalid/index.html';
export const VIRTUAL_ROOT = 'https://vfs.invalid/';

// The attributes that name a file by one URL, with the kind of load each makes (load-kinds.ts): 'link' takes its
// kinds from the link's rel and as (linkKinds). srcset (always images) and CSS are handled by their
// own parsers; <iframe src>, <embed>, <object>, <a href>, imagesrcset and anything inside <template> stay as
// written. Imports inside inline modules are the module graph's (rewriteGuestMarkup, markup-references.ts).
export const REFERENCES: readonly (readonly [element: string, attribute: string, kind: LoadKindName | 'link'])[] = [
    ['script', 'src', 'script'],
    ['link', 'href', 'link'],
    ['img', 'src', 'image'],
    ['source', 'src', 'media'], // <source src> belongs to <audio> and <video>; <picture> sources use srcset
    ['video', 'src', 'media'],
    ['video', 'poster', 'image'],
    ['audio', 'src', 'media'],
    ['track', 'src', 'track'],
];

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
