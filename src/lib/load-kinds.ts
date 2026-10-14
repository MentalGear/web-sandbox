/**
 * Which file types each kind of load admits: the one table that both the policy and reference resolution read
 * (focused review 2026-10-14, W1). Host-side; the strict view gets the table as data (RENDER_RULES).
 *
 * A registered file reaches the guest as a blob: URL typed by the store (files.ts), and the browser decides what a
 * load of it does. For one kind it decides nothing: a classic script. Chromium, Firefox and WebKit run a
 * parser-inserted `<script src="blob:…">` whatever the blob's type (measured: Chromium and Firefox every inert type
 * we tried, WebKit text/plain, JSON, CSS and fonts), so the type does not stop a file from being run. Before this
 * table, resolution ignored the load kind: a guest-written `app.js` committed as text/plain, which needs no
 * `{ code: true }`, became a script slot in the next build's `<script src="app.js">` and ran there.
 *
 * So the library itself decides, at the one place every reference is resolved: a reference names a file only when
 * the file's type is admitted for the kind of load the referencing element or rule makes. A mismatch is not a
 * reference: it stays as written and fails closed (a relative URL against the guest's about:blank base), with one
 * warning. The same table decides which directive a registered type gets `blob:` in (kindsForTypes,
 * csp/file-sources.ts), so CSP admission and resolution cannot drift apart.
 *
 *   kind     admits                                     load                                          directive
 *   script   text/javascript, application/javascript,  <script src>, <link rel=modulepreload>,       script-src-elem
 *            text/ecmascript, application/ecmascript    preload as=script, the module graph
 *   style    text/css                                   <link rel=stylesheet>, @import, preload as=style  style-src-elem
 *   image    image/*                                    <img src>, srcset, poster, <link rel=icon>,   img-src
 *                                                       CSS url() outside @font-face, preload as=image
 *   font     font/*                                     url() inside @font-face, preload as=font      font-src
 *   media    audio/*, video/*                           <audio>, <video>, <source src>, preload as=audio|video  media-src
 *   track    text/vtt                                   <track src>, preload as=track                 media-src
 *   fetch    any type                                   preload as=fetch (and sandboxFiles.read())     connect-src
 *
 * This applies to host-registered files exactly as to committed ones: a host that registers `x.js` as text/plain
 * gets a text file, never a script. What it does not cover is code that asks for a URL itself
 * (`sandboxFiles.url(path)` handed to `importScripts()` or `new Worker()`): that is the running code's own choice.
 *
 * Self-contained module scope is fine: host-only, never stringified (the view receives LOAD_KINDS as data).
 */

export interface KindRule {
    /** The directive that governs this kind of load (CSP Level 3 effective directive, effective-directive.ts). */
    directive: 'script-src-elem' | 'style-src-elem' | 'img-src' | 'font-src' | 'media-src' | 'connect-src';
    /** Types admitted exactly. */
    types: readonly string[];
    /** Type prefixes admitted ('' admits every type). */
    prefixes: readonly string[];
}

// In this order: kindsForTypes adds directives in it, and the policy's directive order follows (fetch first, as before the table).
export const LOAD_KINDS = {
    fetch: { directive: 'connect-src', types: [], prefixes: [''] },
    script: { directive: 'script-src-elem', types: ['text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'], prefixes: [] },
    style: { directive: 'style-src-elem', types: ['text/css'], prefixes: [] },
    image: { directive: 'img-src', types: [], prefixes: ['image/'] },
    font: { directive: 'font-src', types: [], prefixes: ['font/'] },
    media: { directive: 'media-src', types: [], prefixes: ['audio/', 'video/'] },
    track: { directive: 'media-src', types: ['text/vtt'], prefixes: [] },
} as const satisfies Record<string, KindRule>;

/** A kind of load a reference can make. */
export type LoadKindName = keyof typeof LOAD_KINDS;

export const LOAD_KIND_NAMES = Object.keys(LOAD_KINDS) as LoadKindName[];

/** Whether a file of `type` (a store type: lower case, no parameters) may be the target of a load of `kind`. */
export function admits(kind: LoadKindName, type: string): boolean {
    if (!Object.hasOwn(LOAD_KINDS, kind)) return false; // not a kind: admits nothing
    const rule: KindRule = LOAD_KINDS[kind];
    return rule.types.includes(type) || rule.prefixes.some(prefix => type.startsWith(prefix));
}

/** The kinds of `<link>` load each rel token makes; `preload` takes its kind from `as` (PRELOAD_AS_KINDS). */
export const LINK_REL_KINDS: Readonly<Record<string, LoadKindName | 'preload'>> = {
    stylesheet: 'style',
    icon: 'image',
    modulepreload: 'script',
    preload: 'preload',
};

/** A preload's kind by its `as` value (ASCII case-insensitive); any other value, or none, loads nothing we resolve. */
export const PRELOAD_AS_KINDS: Readonly<Record<string, LoadKindName>> = {
    script: 'script',
    style: 'style',
    image: 'image',
    font: 'font',
    audio: 'media',
    video: 'media',
    track: 'track',
    fetch: 'fetch',
};

const ASCII_WHITESPACE = /[\t\n\f\r ]+/;

/**
 * The kinds of load a `<link>` with these `rel` and `as` values makes, one per loading rel token, or null when no
 * token is a loading relation (then the link is not a reference at all). A link with several loading relations
 * (`rel="stylesheet icon"`) names a file only if its type is admitted for every one of them. A preload whose `as`
 * is missing or unknown fetches nothing the browser would use, so it contributes no kind and the link names no file
 * (the empty list: admitsAll() is false for it).
 */
export function linkKinds(rel: string | null, as: string | null): LoadKindName[] | null {
    const kinds = new Set<LoadKindName>();
    let loads = false;
    let unusable = false;
    for (const token of (rel ?? '').toLowerCase().split(ASCII_WHITESPACE)) {
        if (!Object.hasOwn(LINK_REL_KINDS, token)) continue;
        loads = true;
        const kind = LINK_REL_KINDS[token]!;
        if (kind !== 'preload') {
            kinds.add(kind);
            continue;
        }
        const value = (as ?? '').replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').toLowerCase();
        if (Object.hasOwn(PRELOAD_AS_KINDS, value)) kinds.add(PRELOAD_AS_KINDS[value]!);
        else unusable = true;
    }
    if (!loads) return null;
    return unusable ? [] : [...kinds];
}

/** Whether `type` is admitted for every kind in `kinds` (none: never). */
export function admitsAll(kinds: readonly LoadKindName[], type: string): boolean {
    return kinds.length > 0 && kinds.every(kind => admits(kind, type));
}
