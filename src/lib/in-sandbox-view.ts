import { inSandboxFiles } from './in-sandbox-files';
import { assertHashableScript, scriptHashSource } from './csp/script-hash';
import { escapeAttribute } from './frame-documents';
import { REFERENCES, VIRTUAL_DOCUMENT_URL, VIRTUAL_ROOT } from './markup-references';
import { admits, LINK_REL_KINDS, LOAD_KINDS, type KindRule } from './load-kinds';
import { TRUSTED_TYPES_POLICY } from './trusted-types';

/**
 * Strict mode (backlog S6, S13, S17; ADR-005): guest logic runs only in a worker, and the DOM frame — the
 * "view" — runs exactly one script, the library's own bootstrap, admitted by its SHA-256 hash.
 *
 *   host page
 *   └─ wrapper  (unchanged: frame-src 'none', inert base, no-referrer; frame-documents.ts)
 *      └─ view  srcdoc = CSP <meta> + referrer <meta> + ONE <script> (this file's bootstrap), no guest bytes
 *         └─ worker  new Worker(blob:) spawned by the view: the guest's logic, the bridge, sandboxView
 *
 * Three ports, all MessageChannels created per environment:
 *   logic   host ↔ worker   RPC, LOG, PING/PONG, VIOLATION (source 'logic'), EXECUTE — as in worker mode
 *   view    host ↔ view     VIOLATION (source 'view'), RESIZE, GUEST_ERROR, GUEST_UNCAUGHT, VIEW_PING/VIEW_PONG, VIEW_WRITE/VIEW_WRITTEN
 *   render  view ↔ worker   VIEW_STARTED, VIEW_RENDER, VIEW_TEXT, VIEW_SET, VIEW_ACK, VIEW_LISTEN, VIEW_EVENT — the host is not on this path
 * The render port is created by the view and handed to the library's worker prelude, which keeps it in a
 * closure and only ever uses primitives it captured before any guest code ran (A4): guest code cannot post
 * on it, so it cannot get past the flow control below.
 *
 * Three self-contained functions here are stringified (same rules as in-sandbox-script.ts: no module
 * scope, no async/await): inSandboxView (the view's bootstrap), sanitizeRender (the renderer it calls) and
 * inStrictWorker (the worker's prelude). The rest is host-only.
 */

/** The largest html one render may carry, in UTF-16 code units (256 Ki characters; A4). */
export const VIEW_RENDER_MAX_LENGTH = 262144;

/** The longest element id a render may target. */
export const VIEW_TARGET_MAX_LENGTH = 1024;

/**
 * The most elements the view's body may hold, and how deep they may nest below it (broad review 2026-10-14, ST2).
 * A render that would leave the body with more, counted over the resulting document (the elements outside the target
 * stay, the target's own are replaced), or nest deeper, counting the target's own depth, is refused before anything is
 * inserted: dropped, and still acknowledged, so the next render applies. Renders accumulate across targets, so a
 * per-render bound alone would not bound the document. Measured: one render of 45 000 elements stalls the host page
 * 0.2–0.3 s on all three engines.
 */
export const VIEW_MAX_ELEMENTS = 50000;
export const VIEW_MAX_DEPTH = 256;

/**
 * The most characters the view's body may hold, counted like its elements over the document a render would leave
 * (review round 1, R1-1): the length of the body's serialization, so text, comments, attributes and markup alike. Text
 * was outside every budget before: renders of 261 Ki characters of text into 200 targets every 20 ms kept the host
 * page busy 95–100% on all three engines, and the document grew without bound (50 000 targets × 256 Ki characters).
 * A render past it is refused before anything is inserted, and acknowledged, like one past VIEW_MAX_ELEMENTS.
 */
export const VIEW_MAX_CHARACTERS = 4 * VIEW_RENDER_MAX_LENGTH;

/**
 * The most characters of markup the view parses per second, renders refused included (review round 1, R1-1): flow
 * control alone (one render in flight) let a worker keep the host busy with renders that each fit every budget. A
 * render past it waits until the budget has refilled, and the worker's next render waits for that one's VIEW_ACK, so
 * nothing is dropped: renders are slowed to this rate. At least VIEW_RENDER_MAX_LENGTH, so every render is applied.
 */
export const VIEW_RENDER_CHARACTERS_PER_SECOND = 4 * VIEW_RENDER_MAX_LENGTH;

/** The events sandboxView.on() can subscribe to (ADR-005). */
export const VIEW_EVENT_TYPES = ['click', 'input', 'change', 'submit', 'keydown'] as const;

/**
 * Limits of one event's detail: every string, the ids of the target and its ancestors, the form fields, and all its
 * strings together (broad review ST3: each bound alone let 1000 fields of 64 Ki characters through). A detail that was
 * cut by any of them says so: `truncated: true`.
 */
export const VIEW_EVENT_LIMITS = { maxString: 65536, maxIds: 32, maxFields: 1000, maxTotal: VIEW_RENDER_MAX_LENGTH } as const;

/** The prefix of the worker's one-time "the entry ran to its end" marker; each build appends 128 random bits (entryDoneName). */
export const ENTRY_DONE_PREFIX = '__sandboxEntryRan_';

/**
 * The marker's name for one build (broad review ST4). The line after the entry calls it; the prelude defines it on the
 * global object. An entry that closes its own function scope could declare a top-level `let` or `const` of the marker's
 * name, which the trailer's call would then resolve to; with a name drawn at build time, after the entry's text was
 * fixed, it cannot name it.
 */
export function entryDoneName(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    let hex = '';
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
    return ENTRY_DONE_PREFIX + hex;
}

/**
 * The only file types the view mints a URL for (broad review ST1). A user can open whatever a rendered element
 * shows in a new tab ("open image in new tab", "open video in new tab"): a browser-initiated navigation the view
 * cannot cancel, to a top-level document outside the sandbox and its policy. A registered SVG shown as an image
 * opened there as an SVG document and ran its script (Chromium, Firefox), and so would any type an engine renders as
 * a document: HTML, XML, and every `+xml` type, which cooperative mode's prefixes (`image/`, `audio/`, `video/`,
 * `font/`) admit. So strict mode lists, per kind of load the view makes, the types that are never a document; a
 * file of any other type gets no URL in the view, wherever it is named (markup, a stylesheet's url()), and its
 * references stay as written, failing closed. Inline <svg> is the way to show vector graphics.
 */
export const VIEW_FILE_TYPES = [
    'text/css',
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/apng', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon',
    'font/woff', 'font/woff2', 'font/ttf', 'font/otf', 'font/collection', 'font/sfnt',
    'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/flac', 'audio/webm', 'audio/aac',
    'video/mp4', 'video/webm', 'video/ogg',
    'text/vtt',
] as const;

/** The raster image types: the browser only decodes them, and opened on their own they are an image, never a document. */
export const RASTER_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'] as const;

/**
 * The only types the view mints a URL for from a guest write (review round 1, R4-4, the owner's decision): the files
 * the view shows (VIEW_FILE_TYPES) that are raster images. A plugin can show an image it made (a chart drawn on an
 * OffscreenCanvas) without a rebuild. The host sends the view the bytes of every write it recorded whose store type is
 * one of these, and the view, the chokepoint, mints a URL only for them (inSandboxView, `showWrite`): the guest never
 * supplies a URL, and what it can name is decoded only, as an image (the view's load kinds admit these types for image
 * loads alone: img, srcset, poster, icon links). Never SVG, which is a document that can hold script.
 */
export const VIEW_WRITE_TYPES: readonly string[] = VIEW_FILE_TYPES.filter(type => (RASTER_IMAGE_TYPES as readonly string[]).includes(type));

/** Whether the view mints a URL for a file of `type` (VIEW_FILE_TYPES). */
export function isViewFileType(type: string): boolean {
    return (VIEW_FILE_TYPES as readonly string[]).includes(type);
}

/**
 * The view's own table of load kinds: derived from the one table (load-kinds.ts) for the kinds of load the view makes
 * (no script, no fetch), each admitting exactly the VIEW_FILE_TYPES the table admits for it, and no prefix.
 */
export const VIEW_LOAD_KINDS: Readonly<Record<string, KindRule>> = Object.fromEntries((['style', 'image', 'font', 'media', 'track'] as const)
    .map(kind => [kind, { key: LOAD_KINDS[kind].key, types: VIEW_FILE_TYPES.filter(type => admits(kind, type)), prefixes: [] }]));

/**
 * The renderer is an allowlist (broad review 2026-10-14): an element or attribute it does not list is gone before
 * insertion. A list of what to remove had to know every mechanism a document has (F1, SMIL, and ST2, SVG <use>, came
 * from what such a list left open); this one has to know only what a guest's UI needs.
 *
 *   HTML    the elements below; any other HTML element is UNWRAPPED (its children take its place and are checked in
 *           turn), except RENDER_REMOVED_ELEMENTS, which go with everything inside them: nested browsing contexts,
 *           scripts, document-level controls, and the elements whose content is raw text or a template. Unwrapping
 *           keeps the text of an unknown or obsolete element (center, font, marquee …) and loses nothing a guest could
 *           not render with listed elements; it never reparses (no serialisation happens), so it cannot change what
 *           the children are. A valid custom element name (with a hyphen) is kept as the inert unknown element it is:
 *           no script can define it in the view.
 *   SVG     shapes, text, structure, gradients, clip paths, masks and patterns. Any other SVG element is REMOVED with its
 *           content: nothing in an unknown SVG element renders anyway, and the ones left out instance or load content
 *           (use, marker, image, feImage, foreignObject), animate attributes (F1), or cost what their parameters say
 *           rather than what the markup weighs (filter primitives: one feMorphology of 150 characters stalled WebKit's
 *           host thread for 6 s, measured). use and marker instance referenced content per reference and nest: 1–1.5 KB
 *           of either stalled the host page for 3–17 s on all three engines (ST2).
 *   MathML  the MathML Core presentation elements; others are removed with their content (annotation-xml can hold
 *           HTML).
 *
 * Not listed for what their layout costs (review round 1, R1-2; measured from render to layout, one render within every
 * budget): wbr, whose line breaking Firefox does in super-linear time (43 000 in one paragraph stalled its host page
 * 23 s), and ruby with rt and rp (10 000 rubies: WebKit 10.7 s, Chromium 1.4 s). They are unwrapped, so their text
 * stays. Every other listed element measured linear (br, span, bdi, bdo, nested inline formatting 200 deep, tables of
 * 25 000 cells, inline blocks: under 0.4 s per render on all three engines, br 1.4 s in Firefox for 43 000 lines).
 * Text itself is not bounded by layout cost: one paragraph of 240 000 characters alternating left-to-right and
 * right-to-left took 10 s in Chromium and 20 s in WebKit (ADR-005: host-page availability is not protected).
 *
 * Attributes: the global ones of each namespace, data-* and aria-*, and per HTML element the ones it needs. Never an
 * event handler, a form target (action, formaction, method, target), popover or command invokers, autofocus, or a
 * URL attribute other than the ones below; SVG paint and clip references (fill, stroke, clip-path, mask) name only
 * fragments of this document (no ':' and no CSS escape). The URL attributes the view loads (RENDER_URL_ATTRIBUTES) keep
 * only an http(s) URL, a URL the view minted, or a relative one (which resolves against the view's about:blank base to
 * nothing): never data:, javascript: or another scheme.
 */
export const RENDER_ELEMENTS = {
    html: [
        'address', 'article', 'aside', 'footer', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup', 'main', 'nav', 'section', 'search',
        'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'hr', 'li', 'menu', 'ol', 'p', 'pre', 'ul',
        'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q',
        's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'del', 'ins',
        'img', 'picture', 'source', 'video', 'audio', 'track', 'map', 'area',
        'table', 'caption', 'colgroup', 'col', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th',
        'form', 'label', 'input', 'button', 'select', 'datalist', 'optgroup', 'option', 'textarea', 'output', 'progress', 'meter',
        'fieldset', 'legend', 'details', 'summary', 'dialog',
        'style', 'link',
    ],
    svg: [
        'svg', 'g', 'defs', 'symbol', 'title', 'desc', 'style', 'a',
        'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'tspan',
        'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern',
    ],
    mathml: [
        'math', 'semantics', 'annotation', 'merror', 'mfrac', 'mi', 'mmultiscripts', 'mn', 'mo', 'mover', 'mpadded', 'mphantom', 'mprescripts',
        'mroot', 'mrow', 'ms', 'mspace', 'msqrt', 'mstyle', 'msub', 'msubsup', 'msup', 'mtable', 'mtd', 'mtext', 'mtr', 'munder', 'munderover', 'none',
    ],
} as const;

/**
 * HTML elements removed with everything inside them (A1): every nested browsing context and plugin, every script,
 * every document-level control (meta, base, title) and every element whose content is raw text or inert markup that
 * could later become live (noscript, noembed, noframes, template). Every other HTML element outside RENDER_ELEMENTS is
 * unwrapped; every SVG or MathML element outside it is removed with its content.
 */
export const RENDER_REMOVED_ELEMENTS = [
    'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal', 'fencedframe',
    'script', 'noscript', 'noembed', 'noframes', 'template', 'meta', 'base', 'title',
] as const;

export const RENDER_ATTRIBUTES = {
    /** On every HTML element, besides data-* and aria-*. */
    html: ['id', 'class', 'style', 'title', 'lang', 'dir', 'hidden', 'tabindex', 'role', 'translate', 'inert', 'spellcheck', 'inputmode', 'enterkeyhint', 'autocapitalize'],
    /** Per HTML element. */
    htmlElements: {
        a: ['href', 'rel', 'referrerpolicy', 'hreflang', 'type'],
        area: ['href', 'rel', 'referrerpolicy', 'alt', 'shape', 'coords'],
        img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding', 'fetchpriority', 'usemap', 'ismap', 'referrerpolicy'],
        source: ['src', 'srcset', 'sizes', 'media', 'type', 'width', 'height'],
        video: ['src', 'poster', 'controls', 'autoplay', 'loop', 'muted', 'playsinline', 'preload', 'width', 'height', 'controlslist', 'disablepictureinpicture', 'disableremoteplayback'],
        audio: ['src', 'controls', 'autoplay', 'loop', 'muted', 'preload', 'controlslist', 'disableremoteplayback'],
        track: ['src', 'kind', 'srclang', 'label', 'default'],
        map: ['name'],
        link: ['rel', 'href', 'type', 'media', 'sizes', 'referrerpolicy'],
        style: ['media'],
        ol: ['reversed', 'start', 'type'],
        li: ['value'],
        td: ['colspan', 'rowspan', 'headers'],
        th: ['colspan', 'rowspan', 'headers', 'scope', 'abbr'],
        col: ['span'],
        colgroup: ['span'],
        time: ['datetime'],
        data: ['value'],
        del: ['datetime'],
        ins: ['datetime'],
        form: ['name', 'autocomplete', 'novalidate'],
        label: ['for'],
        input: ['type', 'name', 'value', 'checked', 'disabled', 'readonly', 'required', 'placeholder', 'min', 'max', 'step', 'minlength', 'maxlength', 'pattern', 'size', 'multiple', 'accept', 'autocomplete', 'list', 'form', 'dirname', 'alt'],
        button: ['type', 'name', 'value', 'disabled', 'form'],
        select: ['name', 'multiple', 'size', 'disabled', 'required', 'form', 'autocomplete'],
        option: ['value', 'selected', 'disabled', 'label'],
        optgroup: ['label', 'disabled'],
        textarea: ['name', 'rows', 'cols', 'placeholder', 'disabled', 'readonly', 'required', 'maxlength', 'minlength', 'wrap', 'form', 'autocomplete', 'dirname'],
        fieldset: ['name', 'disabled', 'form'],
        output: ['for', 'name', 'form'],
        progress: ['value', 'max'],
        meter: ['value', 'min', 'max', 'low', 'high', 'optimum'],
        details: ['open', 'name'],
        dialog: ['open'],
    } as Readonly<Record<string, readonly string[]>>,
    /** On every SVG element, besides data-* and aria-*: structure, geometry and presentation. */
    svg: [
        'id', 'class', 'style', 'lang', 'tabindex', 'role', 'xml:lang', 'xml:space', 'xmlns', 'xmlns:xlink', 'transform', 'transform-origin',
        'x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'd', 'points', 'pathLength', 'viewBox', 'preserveAspectRatio',
        'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust',
        'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
        'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'color', 'display', 'visibility', 'overflow',
        'font-family', 'font-size', 'font-size-adjust', 'font-weight', 'font-style', 'font-variant', 'font-stretch', 'text-anchor', 'dominant-baseline',
        'alignment-baseline', 'baseline-shift', 'letter-spacing', 'word-spacing', 'text-decoration', 'writing-mode', 'direction', 'unicode-bidi',
        'clip-path', 'clip-rule', 'mask', 'stop-color', 'stop-opacity', 'color-interpolation', 'shape-rendering', 'text-rendering', 'vector-effect',
        'paint-order', 'pointer-events', 'mix-blend-mode', 'isolation',
        'gradientUnits', 'gradientTransform', 'spreadMethod', 'fx', 'fy', 'fr', 'offset',
        'clipPathUnits', 'maskUnits', 'maskContentUnits', 'patternUnits', 'patternContentUnits', 'patternTransform', 'media', 'type',
    ],
    /** Only on SVG <a>: the link (its href becomes INERT_HREF) and its referrer and rel rules. */
    svgLink: ['href', 'xlink:href', 'rel', 'referrerpolicy'],
    /** SVG attributes that may reference a paint server, clip path or mask: only a fragment of this document. */
    svgLocalReferences: ['fill', 'stroke', 'clip-path', 'mask'],
    /** On every MathML element, besides data-* and aria-*. An href makes any MathML element a link (it becomes INERT_HREF). */
    mathml: [
        'id', 'class', 'style', 'dir', 'tabindex', 'href', 'xmlns', 'displaystyle', 'mathbackground', 'mathcolor', 'mathsize', 'mathvariant', 'scriptlevel',
        'display', 'alttext', 'fence', 'form', 'largeop', 'lspace', 'maxsize', 'minsize', 'movablelimits', 'rspace', 'separator', 'stretchy',
        'symmetric', 'accent', 'accentunder', 'linethickness', 'depth', 'height', 'width', 'voffset', 'columnspan', 'rowspan', 'encoding',
    ],
} as const;

/** [element, attribute] pairs (HTML) that hold a URL the view loads: http(s), a URL the view minted, or relative only. srcset is a list. */
export const RENDER_URL_ATTRIBUTES = [
    ['img', 'src'], ['img', 'srcset'], ['source', 'src'], ['source', 'srcset'], ['video', 'src'], ['video', 'poster'],
    ['audio', 'src'], ['track', 'src'], ['link', 'href'],
] as const;

/**
 * The value of every hyperlink href in the strict view (backlog S24, option B): the guest's URL is discarded before
 * insertion, so a user's own browser actions on a rendered link ("copy link address", "open in new tab", hover,
 * dragging it) can carry nothing of the guest's. The view already cancels clicks, auxclicks and Enter (G4), and the
 * worker never had the URL (events carry ids), so routing is unchanged.
 *
 * Why 'about:blank#', measured on Chromium, Firefox and WebKit against '#', '' , 'about:blank', 'about:invalid',
 * 'javascript:void(0)' and 'data:,': it is absolute, so it means the same in every document whatever its base
 * ('#' resolves to the same 'about:blank#' only because the view inherits an about:blank base; '' fails to resolve
 * only because that base has an opaque path, and then behaves differently per engine: no drag in Chromium, an empty
 * one in Firefox and WebKit); every engine reports it unchanged as the link's href and its drag data, so the only
 * string the user agent can show, copy or drop is this constant; and opening it loads the empty about:blank document:
 * no request, nothing of the guest's. 'about:invalid' and 'javascript:' differ per engine, and 'data:,' opens a
 * document. The link stays a link: an <a href> matches :link and :any-link, is focusable by Tab and has the role
 * link, which removing the href or rewriting the element would lose. The fragment keeps it from naming a resource
 * and makes it what a guest's own href="#" already resolves to.
 */
export const INERT_HREF = 'about:blank#';

/** The only rel tokens a kept <link> may have. */
const LINK_RELATIONS = ['stylesheet', 'icon'] as const;

export interface RenderRules {
    /** The elements kept, per namespace (RENDER_ELEMENTS). */
    elements: { readonly html: readonly string[]; readonly svg: readonly string[]; readonly mathml: readonly string[] };
    /** HTML elements removed with their subtree (RENDER_REMOVED_ELEMENTS); other unlisted HTML elements are unwrapped. */
    removed: readonly string[];
    /** The attributes kept (RENDER_ATTRIBUTES). */
    attributes: typeof RENDER_ATTRIBUTES;
    /** [element, attribute] pairs that hold a URL the view loads (RENDER_URL_ATTRIBUTES). */
    urls: readonly (readonly [string, string])[];
    /** [element, attribute, kind] triples that may name a registered file (markup-references.ts, minus <script src>). */
    references: readonly (readonly [string, string, string])[];
    /** Which file types each kind of load admits in the view (VIEW_LOAD_KINDS, derived from load-kinds.ts). */
    kinds: Readonly<Record<string, KindRule>>;
    /** The kind of load of each rel token a kept <link> may have (load-kinds.ts's LINK_REL_KINDS for linkRelations). */
    linkRelKinds: Readonly<Record<string, string>>;
    /** The only rel tokens a kept <link> may have. */
    linkRelations: readonly string[];
    /** The only rel tokens an <a> or <area> keeps. */
    anchorRelations: readonly string[];
    /** Elements that always get referrerpolicy="no-referrer" (A1). */
    referrerElements: readonly string[];
    /** The one value every hyperlink's href becomes (INERT_HREF). */
    inertHref: string;
    /** The URL references resolve against, and the root of the files' URL space (markup-references.ts). */
    documentUrl: string;
    virtualRoot: string;
    /** VIEW_MAX_ELEMENTS and VIEW_MAX_DEPTH: the view's body never holds more, nor nests deeper. */
    maxElements: number;
    maxDepth: number;
    /** VIEW_MAX_CHARACTERS: the view's body never serializes to more (checked by the view, after the renderer). */
    maxCharacters: number;
}

export const RENDER_RULES: RenderRules = {
    elements: RENDER_ELEMENTS,
    removed: RENDER_REMOVED_ELEMENTS,
    attributes: RENDER_ATTRIBUTES,
    urls: RENDER_URL_ATTRIBUTES,
    // derived, not copied: the table markup-references.ts resolves in cooperative mode. Scripts never survive
    // the renderer, so <script src> names nothing here.
    references: REFERENCES.filter(([element]) => element !== 'script'),
    // the view's kinds, derived from the one table (load-kinds.ts, focused review W1; broad review ST1)
    kinds: VIEW_LOAD_KINDS,
    // derived from load-kinds.ts's LINK_REL_KINDS (broad review I1): a kept <link> has only these rel tokens
    linkRelKinds: Object.fromEntries(LINK_RELATIONS.map(rel => [rel, LINK_REL_KINDS[rel]!])),
    linkRelations: LINK_RELATIONS,
    anchorRelations: ['noopener', 'noreferrer', 'nofollow'],
    referrerElements: ['a', 'area', 'img', 'link'],
    inertHref: INERT_HREF,
    documentUrl: VIRTUAL_DOCUMENT_URL,
    virtualRoot: VIRTUAL_ROOT,
    maxElements: VIEW_MAX_ELEMENTS,
    maxDepth: VIEW_MAX_DEPTH,
    maxCharacters: VIEW_MAX_CHARACTERS,
};

/**
 * The renderer (A1, A8; broad review 2026-10-14: an allowlist), run by the view on a freshly parsed template fragment
 * BEFORE any of it is inserted. Stringified into the view bootstrap; self-contained. It never clones or imports a node
 * (A2): it moves the fragment's own nodes when it unwraps an element, and the caller moves the fragment into the
 * document, which never runs or even prepares a script (research 15, P6) — and there are none left anyway.
 *
 * One walk, in document order, decides each element once:
 *   1. an element outside rules.elements goes: an HTML one is unwrapped (its children take its place and are walked
 *      next), unless it is in rules.removed or is not HTML at all, which go with their subtree; a valid custom
 *      element name is kept;
 *   2. a kept <link> must have rel tokens, all in rules.linkRelations (else it goes);
 *   3. an HTML element's file reference (rules.references) that names a registered file, resolved like a browser
 *      would against rules.documentUrl, becomes the view's own blob: URL for it (`fileOf`), but only when the file's
 *      type is admitted for the kind of load the element makes (rules.kinds; a <link> by its rel tokens);
 *   4. a <link> stays only if its href is a URL the view minted;
 *   5. every href that makes a hyperlink becomes rules.inertHref (S24): HTML <a> and <area>, SVG <a> (href and
 *      xlink:href) and any MathML element;
 *   6. every attribute outside rules.attributes goes; so does any attribute whose value contains "blob:" (after
 *      removing the tabs and newlines the URL parser ignores) unless it is a file-reference attribute holding exactly
 *      a URL the view minted (A8), a URL attribute (rules.urls) whose URL is not http(s), minted or relative, and an
 *      SVG paint or clip reference that is not a fragment; referrerpolicy becomes no-referrer, and is set on
 *      rules.referrerElements; rel on <a>/<area> keeps only rules.anchorRelations (A1).
 * Text is kept, each run of adjacent text joined into one node; comments and processing instructions are dropped. The
 * walk is linear in the fragment's size on every engine (review round 1, R1-2; see the walk below).
 * Kept elements are counted against `room` (what is left of VIEW_MAX_ELEMENTS and VIEW_MAX_DEPTH once the elements
 * outside the target and the target's own depth are accounted for): past either it throws, before anything was
 * inserted, a RangeError whose message names the limit (VIEW_MAX_ELEMENTS or VIEW_MAX_DEPTH). Returns the number of
 * elements kept.
 *
 * Every node is read and changed through the prototypes' own methods and getters, never through the node: a <form>
 * exposes its controls as named properties that override built-ins, so in `<form><input name="getAttribute">` the
 * form's getAttribute is the input. Should anything still throw, the caller inserts nothing (fail closed).
 */
export function sanitizeRender(fragment: DocumentFragment, fileOf: (path: string) => { url: string; type: string } | null, isMinted: (url: string) => boolean, rules: RenderRules, room?: { elements: number; depth: number }): number {
    const HTML = 'http://www.w3.org/1999/xhtml';
    const SVG = 'http://www.w3.org/2000/svg';
    const MATHML = 'http://www.w3.org/1998/Math/MathML';
    const XLINK = 'http://www.w3.org/1999/xlink';
    const call = Reflect.apply;
    const E = Element.prototype;
    const N = Node.prototype;
    const getter = (proto: object, name: string) => Object.getOwnPropertyDescriptor(proto, name)!.get!;
    const localNameOf = getter(E, 'localName');
    const namespaceOf = getter(E, 'namespaceURI');
    const firstChildOf = getter(N, 'firstChild');
    const has = (element: Element, name: string): boolean => call(E.hasAttribute, element, [name]);
    const get = (element: Element, name: string): string | null => call(E.getAttribute, element, [name]);
    const set = (element: Element, name: string, value: string) => call(E.setAttribute, element, [name, value]);
    const drop = (element: Element, name: string) => call(E.removeAttribute, element, [name]);
    const own = Object.prototype.hasOwnProperty;
    const limit = room || { elements: rules.maxElements, depth: rules.maxDepth };
    // lookups without a prototype: an element or attribute name is never an inherited key
    const setOf = (names: readonly string[]) => {
        const out: Record<string, true> = Object.create(null);
        for (let i = 0; i < names.length; i++) out[names[i]!] = true;
        return out;
    };
    const htmlElements = setOf(rules.elements.html);
    const svgElements = setOf(rules.elements.svg);
    const mathElements = setOf(rules.elements.mathml);
    const removedElements = setOf(rules.removed);
    const htmlAttributes = setOf(rules.attributes.html);
    const svgAttributes = setOf(rules.attributes.svg);
    const svgLinkAttributes = setOf(rules.attributes.svgLink);
    const svgLocal = setOf(rules.attributes.svgLocalReferences);
    const mathAttributes = setOf(rules.attributes.mathml);
    const perElement: Record<string, Record<string, true>> = Object.create(null);
    for (const name in rules.attributes.htmlElements) {
        if (call(own, rules.attributes.htmlElements, [name])) perElement[name] = setOf(rules.attributes.htmlElements[name]!);
    }
    const customReserved = setOf(['annotation-xml', 'color-profile', 'font-face', 'font-face-src', 'font-face-uri', 'font-face-format', 'font-face-name', 'missing-glyph']);
    const isCustom = (name: string) => /^[a-z][a-z0-9._-]*-[a-z0-9._-]*$/.test(name) && !customReserved[name];

    const tokens = (value: string | null) => (value || '').toLowerCase().split(/[\t\n\f\r ]+/).filter((token) => token !== '');
    // admitsAll of load-kinds.ts over the table the rules carry: every kind admits the type, and there is one
    const admitted = (kinds: string[], type: string) => {
        if (kinds.length === 0) return false;
        for (let k = 0; k < kinds.length; k++) {
            const rule = call(own, rules.kinds, [kinds[k]!]) ? rules.kinds[kinds[k]!]! : null;
            if (!rule) return false;
            let ok = rule.types.indexOf(type) >= 0;
            for (let p = 0; !ok && p < rule.prefixes.length; p++) ok = type.indexOf(rule.prefixes[p]!) === 0;
            if (!ok) return false;
        }
        return true;
    };
    const resolve = (value: string, kinds: string[]): string | null => {
        if (/^[\u0000- ]*$/.test(value)) return null;
        let href: string;
        try {
            href = new URL(value, rules.documentUrl).href;
        } catch {
            return null;
        }
        if (href.indexOf(rules.virtualRoot) !== 0) return null;
        const path = href.slice(rules.virtualRoot.length);
        if (path.indexOf('?') >= 0 || path.indexOf('#') >= 0) return null;
        const file = fileOf(path);
        return file && admitted(kinds, file.type) ? file.url : null;
    };
    const isPair = (list: readonly (readonly string[])[], element: string, attribute: string) => {
        for (let i = 0; i < list.length; i++) {
            if (list[i]![0] === element && list[i]![1] === attribute) return true;
        }
        return false;
    };
    // A URL the view would load: http(s), one it minted, or relative (against the view's about:blank base it resolves
    // to nothing). The scheme is read the way the URL parser reads it: outer C0 controls and spaces stripped, tabs and
    // newlines removed.
    const urlAllowed = (value: string) => {
        const url = value.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '');
        const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
        if (!scheme) return true;
        const name = scheme[1]!.toLowerCase();
        return name === 'https' || name === 'http' || (name === 'blob' && isMinted(value));
    };
    // srcset: every candidate's URL starts at the start or after a comma, and its scheme holds neither, so checking the
    // first token after every comma checks every candidate (a URL that itself holds a comma is only checked more)
    const srcsetAllowed = (value: string) => {
        const pieces = value.split(',');
        for (let i = 0; i < pieces.length; i++) {
            const url = pieces[i]!.replace(/^[\t\n\f\r ]+/, '').split(/[\t\n\f\r ]/)[0]!;
            if (url !== '' && !urlAllowed(url)) return false;
        }
        return true;
    };
    const attributeAllowed = (namespace: unknown, element: string, attribute: string) => {
        if (attribute.indexOf('data-') === 0 || attribute.indexOf('aria-') === 0) return true;
        if (namespace === HTML) return htmlAttributes[attribute] === true || (perElement[element] !== undefined && perElement[element]![attribute] === true);
        if (namespace === SVG) return svgAttributes[attribute] === true || (element === 'a' && svgLinkAttributes[attribute] === true);
        return namespace === MATHML && mathAttributes[attribute] === true;
    };
    const KEEP = 0, REMOVE = 1, UNWRAP = 2;
    const verdict = (namespace: unknown, name: string) => {
        if (namespace === HTML) {
            if (removedElements[name]) return REMOVE;
            return htmlElements[name] || isCustom(name) ? KEEP : UNWRAP;
        }
        if (namespace === SVG) return svgElements[name] ? KEEP : REMOVE;
        if (namespace === MATHML) return mathElements[name] ? KEEP : REMOVE;
        return REMOVE;
    };

    // Cleans a kept element; false when it must go after all (a <link> that names no minted file).
    const clean = (element: Element, namespace: unknown, name: string): boolean => {
        const html = namespace === HTML;
        let linkKinds: string[] = [];
        if (html && name === 'link') {
            const rel = tokens(get(element, 'rel'));
            for (let t = 0; t < rel.length; t++) {
                if (rules.linkRelations.indexOf(rel[t]!) < 0) return false;
                const kind = rules.linkRelKinds[rel[t]!]!;
                if (linkKinds.indexOf(kind) < 0) linkKinds.push(kind);
            }
            if (rel.length === 0) return false;
        }
        if (html) {
            for (let r = 0; r < rules.references.length; r++) {
                const [tag, attribute, kind] = rules.references[r]!;
                if (tag !== name || !has(element, attribute)) continue;
                const url = resolve(get(element, attribute) || '', kind === 'link' ? linkKinds : [kind]);
                if (url) set(element, attribute, url);
            }
            if (name === 'link' && !isMinted(get(element, 'href') || '')) return false;
        }
        // a hyperlink keeps being a link, but its href is the constant, never the guest's URL (S24)
        if ((html && (name === 'a' || name === 'area')) || (namespace === SVG && name === 'a') || namespace === MATHML) {
            if (has(element, 'href')) set(element, 'href', rules.inertHref);
            if (namespace === SVG && call(E.hasAttributeNS, element, [XLINK, 'href'])) call(E.setAttributeNS, element, [XLINK, 'xlink:href', rules.inertHref]);
        }
        const names: string[] = call(E.getAttributeNames, element, []);
        for (let a = 0; a < names.length; a++) {
            const attribute = names[a]!;
            const value = get(element, attribute) || '';
            const keep = attributeAllowed(namespace, name, attribute)
                && !(/blob:/i.test(value.replace(/[\t\n\r]/g, '')) && !(html && isPair(rules.references, name, attribute) && isMinted(value)))
                && !(html && isPair(rules.urls, name, attribute) && !(attribute === 'srcset' ? srcsetAllowed(value) : urlAllowed(value)))
                && !(namespace === SVG && svgLocal[attribute] && /[:\\]/.test(value));
            if (!keep) drop(element, attribute);
            else if (attribute === 'referrerpolicy') set(element, attribute, 'no-referrer');
        }
        if (rules.referrerElements.indexOf(name) >= 0) set(element, 'referrerpolicy', 'no-referrer');
        if ((name === 'a' || name === 'area') && has(element, 'rel')) {
            set(element, 'rel', tokens(get(element, 'rel')).filter((token) => rules.anchorRelations.indexOf(token) >= 0).join(' '));
        }
        return true;
    };

    // The walk (review round 1, R1-2: linear by construction): each parent's children are taken out from the front
    // (`drain`: removing a first child costs the same at any size in every engine), decided in document order, and the
    // kept ones appended back at the end. Removing children one by one from the middle, as the walk did, costs time in
    // the number of siblings in Chromium and WebKit (measured: 38 000 removals among 86 000 siblings, Chromium 13 s,
    // WebKit over 3 s, on the host page's thread where the view shares it). A kept element is appended and its own
    // children walked next, one level deeper; an unwrapped element's children are walked in its place, at its depth,
    // into the same parent; a removed element is dropped with its subtree. Text between them is joined into one node
    // (the first of the run, its data set once): unwrapping or removing elements leaves runs of adjacent text, which
    // WebKit lays out in super-linear time (43 000 one-letter nodes stalled its host page). Comments and processing
    // instructions are dropped: nothing in a view needs them. `depth` is an element's depth below the fragment.
    const nodeTypeOf = getter(N, 'nodeType');
    const dataOf = getter(CharacterData.prototype, 'data');
    const setData = Object.getOwnPropertyDescriptor(CharacterData.prototype, 'data')!.set!;
    const list = <T>(): T[] => Object.setPrototypeOf([], null); // read by index and length only (review C3)
    const joinList = Array.prototype.join;
    const drain = (parent: Node): Node[] => {
        const out = list<Node>();
        for (let child: Node | null = call(firstChildOf, parent, []); child; child = call(firstChildOf, parent, [])) {
            call(N.removeChild, parent, [child]);
            out[out.length] = child;
        }
        return out;
    };
    // One sequence of nodes being walked into `parent`. An unwrapped element's sequence shares its parent's text run.
    type Run = { parent: Node; input: Node[]; index: number; depth: number; text: { first: Node | null; parts: string[] }; own: boolean };
    const flushText = (run: Run) => {
        const text = run.text;
        if (!text.first) return;
        if (text.parts.length > 1) call(setData, text.first, [call(joinList, text.parts, [''])]);
        call(N.appendChild, run.parent, [text.first]);
        text.first = null;
        text.parts = list<string>();
    };
    let kept = 0;
    const runs = list<Run>();
    runs[0] = { parent: fragment, input: drain(fragment), index: 0, depth: 1, text: { first: null, parts: list<string>() }, own: true };
    while (runs.length > 0) {
        const run = runs[runs.length - 1]!;
        if (run.index >= run.input.length) {
            if (run.own) flushText(run);
            runs.length = runs.length - 1;
            continue;
        }
        const node = run.input[run.index]!;
        run.index++;
        const type = call(nodeTypeOf, node, []);
        if (type === 3 || type === 4) { // text, and CDATA in SVG or MathML: its text
            if (!run.text.first) run.text.first = node;
            run.text.parts[run.text.parts.length] = call(dataOf, node, []);
            continue;
        }
        if (type !== 1) continue; // a comment or a processing instruction: dropped
        const element = node as Element;
        const namespace = call(namespaceOf, element, []);
        const name = String(call(localNameOf, element, []));
        let decision = verdict(namespace, name);
        if (decision === KEEP && !clean(element, namespace, name)) decision = REMOVE;
        if (decision === REMOVE) continue;
        if (decision === UNWRAP) {
            runs[runs.length] = { parent: run.parent, input: drain(element), index: 0, depth: run.depth, text: run.text, own: false };
            continue;
        }
        kept++;
        if (kept > limit.elements) throw new RangeError('VIEW_MAX_ELEMENTS');
        if (run.depth > limit.depth) throw new RangeError('VIEW_MAX_DEPTH');
        flushText(run);
        call(N.appendChild, run.parent, [element]);
        runs[runs.length] = { parent: element, input: drain(element), index: 0, depth: run.depth + 1, text: { first: null, parts: list<string>() }, own: true };
    }
    return kept;
}

/** What the view bootstrap is given, as one literal in its (constant) text. */
export interface ViewOptions {
    render: RenderRules;
    maxRender: number;
    maxTarget: number;
    /** VIEW_RENDER_CHARACTERS_PER_SECOND */
    renderRate: number;
    violationLimit: number;
    events: { types: readonly string[]; maxString: number; maxIds: number; maxFields: number; maxTotal: number };
    /** The Trusted Types policy name the view creates where the host page enforces them (trusted-types.ts). */
    trustedTypesPolicy: string;
    /** VIEW_WRITE_TYPES: the only types the view mints a URL for from a guest write. */
    writeTypes: readonly string[];
}

/**
 * The view's bootstrap: the only script the view document has, and the only one its policy admits (by
 * hash). Stringified with its arguments into one constant text per page (viewBootstrapText). Self-contained.
 *
 * Before INIT_VIEW it only listens: violation reports wait in a bounded outbox, and link clicks and form
 * submissions have their default cancelled from the start. It accepts exactly one INIT_VIEW, from the host
 * page (event.source === parent.parent), in a capture listener that stops the event there; any other
 * message is ignored. A copy of this text that ever ran a second time in the same document would return
 * at once (the run counter), and a copy elsewhere would never receive INIT_VIEW (research 15, P1).
 */
export function inSandboxView(installFiles: typeof inSandboxFiles, sanitize: typeof sanitizeRender, options: ViewOptions) {
    const g = globalThis as any;
    const runs = (g.__sandboxViewRuns || 0) + 1;
    g.__sandboxViewRuns = runs;
    if (runs > 1) return;

    // DOM access through the prototypes' own methods and getters, captured now, before any rendered markup
    // exists: Document and HTMLFormElement expose named elements as properties that override built-ins
    // (`<img name="body">` is document.body, `<form><input name="hasAttribute">` is form.hasAttribute), so
    // reading through the instance would let rendered markup change what this script sees. No guest script
    // runs here, so the prototypes themselves are the browser's.
    const call = Reflect.apply;
    const getter = (proto: object, name: string) => Object.getOwnPropertyDescriptor(proto, name)!.get!;
    const nodeTypeOf = getter(Node.prototype, 'nodeType');
    const parentOf = getter(Node.prototype, 'parentNode');
    const localNameOf = getter(Element.prototype, 'localName');
    const idOf = getter(Element.prototype, 'id');
    const bodyOf = getter(Document.prototype, 'body');
    const rootOf = getter(Document.prototype, 'documentElement');
    const E = Element.prototype;
    const D = Document.prototype;
    const containsNode = Node.prototype.contains;
    const lengthOf = getter(HTMLCollection.prototype, 'length');

    let viewPort: MessagePort | null = null;
    let renderPort: MessagePort | null = null;
    let initialised = false;
    const outbox: unknown[] = [];
    const toHost = (frame: unknown) => {
        if (viewPort) viewPort.postMessage(frame);
        else if (outbox.length < options.violationLimit) outbox.push(frame);
    };

    // The view document's own CSP violations (G6): complete and unforgeable, since no guest code runs in this
    // document and the host labels whatever arrives on the view port as source 'view'. Capped per directive
    // (VIOLATION_EVENT_LIMIT each; the host keeps the same buckets, review C4): the view's reports include
    // refusals of the guest's own rendered markup, so one shared cap let a guest that rendered 100 refused
    // images hide a later script-src-attr report. The directive is the browser's, so the buckets are the
    // browser's directive names; past 32 distinct names everything shares one more bucket.
    const violationCounts = new Map<string, number>();
    addEventListener('securitypolicyviolation', (event: any) => {
        if (!event.isTrusted) return;
        const directive = event.effectiveDirective || event.violatedDirective;
        const bucket = violationCounts.has(directive) || violationCounts.size < 32 ? directive : '';
        const count = violationCounts.get(bucket) || 0;
        if (count >= options.violationLimit) return;
        violationCounts.set(bucket, count + 1);
        toHost({
            type: 'VIOLATION',
            directive,
            blockedURI: event.blockedURI,
            sourceFile: event.sourceFile,
            lineNumber: event.lineNumber,
            columnNumber: event.columnNumber,
        });
    }, true);

    // No navigation from rendered markup (G4, A5): the default of every click or auxclick on or inside a link
    // (HTML and SVG <a>, <area>, anything with an href) and of every submit is cancelled. Fragment links are
    // no exception: the view inherits the wrapper's about:blank base, so "#x" names about:blank#x, a navigation.
    const XLINK = 'http://www.w3.org/1999/xlink';
    const insideLink = (node: any) => {
        for (let n = node; n && call(nodeTypeOf, n, []) === 1; n = call(parentOf, n, [])) {
            const name = call(localNameOf, n, []);
            if (name === 'a' || name === 'area' || call(E.hasAttribute, n, ['href']) || call(E.hasAttributeNS, n, [XLINK, 'href'])) return true;
        }
        return false;
    };
    const cancelLink = (event: Event) => {
        let link = true; // anything unexpected cancels: fail closed
        try {
            link = insideLink(event.target);
        } catch {}
        if (link) event.preventDefault();
    };
    addEventListener('click', cancelLink, true);
    addEventListener('auxclick', cancelLink, true);
    addEventListener('submit', (event: Event) => event.preventDefault(), true);

    // Events for the worker's sandboxView.on() handlers: only the types it subscribed to (VIEW_LISTEN), only
    // trusted ones (no guest code runs here, but the rule is stated, not assumed), capture-delegated on the
    // window. The detail describes the target and its ancestors' ids, the key, the form's fields — never a
    // URL: no href, src or action is read. Every string is clamped, and all of them together share one budget
    // (broad review ST3): a detail that was cut anywhere carries `truncated: true`. Link and submit defaults are
    // cancelled above whether or not anyone listens.
    let subscribed: string[] = [];
    const forward = (event: any) => {
        if (!event.isTrusted || !renderPort || subscribed.indexOf(event.type) < 0) return;
        let target = event.target;
        if (!target || !(target instanceof Element)) target = call(bodyOf, document, []);
        if (!target) return;
        let budget = options.events.maxTotal;
        let truncated = false;
        const clamp = (input: unknown) => {
            let text = String(input);
            const most = Math.min(options.events.maxString, budget);
            if (text.length > most) {
                text = text.slice(0, most);
                truncated = true;
            }
            budget -= text.length;
            return text;
        };
        const tag = clamp(call(localNameOf, target, []));
        const value = tag === 'form' ? undefined : target.value; // a form's "value" could be a named control
        const detail: any = {
            type: event.type,
            ids: [] as string[],
            target: {
                tag,
                id: clamp(call(idOf, target, [])),
                name: clamp(call(E.getAttribute, target, ['name']) || ''),
                value: typeof value === 'string' ? clamp(value) : '',
                checked: tag !== 'form' && target.checked === true,
            },
        };
        if (event.type === 'keydown') detail.key = clamp(event.key || '');
        for (let n = target; n && call(nodeTypeOf, n, []) === 1; n = call(parentOf, n, [])) {
            const id = call(idOf, n, []);
            if (!id) continue;
            if (detail.ids.length === options.events.maxIds) {
                truncated = true;
                break;
            }
            detail.ids.push(clamp(id));
        }
        if (event.type === 'submit' && tag === 'form') {
            const fields: [string, string][] = [];
            let data: FormData;
            try {
                data = new FormData(target, event.submitter || undefined);
            } catch {
                data = new FormData(target);
            }
            data.forEach((value, name) => {
                if (typeof value !== 'string') return;
                if (fields.length === options.events.maxFields || budget === 0) {
                    truncated = true;
                    return;
                }
                fields.push([clamp(name), clamp(value)]);
            });
            detail.form = fields;
        }
        if (truncated) detail.truncated = true;
        renderPort.postMessage({ type: 'VIEW_EVENT', detail });
    };
    for (let i = 0; i < options.events.types.length; i++) addEventListener(options.events.types[i]!, forward, true);

    // The view's two sinks under a host page's Trusted Types (review round 1, R3-1): the view inherits the host page's
    // `require-trusted-types-for 'script'`, which makes the template's innerHTML and the Worker constructor throw a
    // TypeError for a string. Each is tried with the string first; only when that throws a TypeError and the view has
    // Trusted Types is the operation repeated through the one policy of the view's own, created once, named like the
    // element's (trusted-types.ts: the host page's trusted-types directive admits it already). Its rules pass the
    // value through: the markup goes into an inert template and through the renderer, and the URL is the worker's own.
    let policy: { createHTML(value: string): unknown; createScriptURL(value: string): unknown } | null = null;
    const trusted = (sink: (value: unknown) => void, value: string, kind: 'createHTML' | 'createScriptURL') => {
        try {
            sink(value);
            return;
        } catch (error) {
            const factory = g.trustedTypes;
            if (!(error instanceof TypeError) || !factory) throw error;
        }
        if (!policy) {
            const pass = (input: string) => input;
            policy = g.trustedTypes.createPolicy(options.trustedTypesPolicy, { createHTML: pass, createScriptURL: pass });
        }
        sink(policy![kind](value));
    };

    let viewFiles = new Map<string, { url: string; type: string }>();
    let minted = new Set<string>();
    // The guest's writes as the host recorded them (R4-4): path → the URL this view minted from the host's bytes, or null
    // where the path names nothing any more (a removal, or a write of a type the view does not mint for). A path the
    // guest changed resolves as the guest's own sandboxFiles lists it, so a registered file it replaced or removed is
    // gone from here too. Only VIEW_WRITE_TYPES are minted, whatever the message says: this is the chokepoint.
    const written = new Map<string, { url: string; type: string } | null>();
    const fileOf = (path: string) => (written.has(path) ? written.get(path)! : viewFiles.get(path) || null);
    const isMinted = (url: string) => minted.has(url);
    const showWrite = (path: unknown, mime: unknown, bytes: unknown) => {
        if (typeof path !== 'string') return;
        const previous = written.get(path);
        if (previous) {
            // A later write or a removal replaces the URL: the old one is revoked and no longer the view's, so rendered
            // markup can no longer name it (A8); an image that already shows it keeps what it decoded.
            minted.delete(previous.url);
            URL.revokeObjectURL(previous.url);
        }
        if (typeof mime !== 'string' || options.writeTypes.indexOf(mime) < 0 || !ArrayBuffer.isView(bytes)) {
            written.set(path, null);
            return;
        }
        const url = URL.createObjectURL(new Blob([bytes as ArrayBufferView<ArrayBuffer>], { type: mime }));
        written.set(path, { url, type: mime });
        minted.add(url);
    };

    // template.innerHTML parses into an inert fragment (no script runs, nothing loads); the renderer cleans
    // it; replaceChildren MOVES its nodes into the document (A2) — never a clone or an import. The renderer gets the
    // room the view's budget leaves (broad review ST2): the body's elements outside the target stay, the target's own
    // are replaced, and the target's depth below the body counts; past it the renderer throws before insertion.
    const countOf = (root: Element) => call(lengthOf, call(E.getElementsByTagName, root, ['*']), []) as number;
    const apply = (html: string, into: string | null) => {
        const body = call(bodyOf, document, []);
        const target = into === null ? body : call(D.getElementById, document, [into]);
        if (!target || !body || (target !== body && !call(containsNode, body, [target]))) return;
        const template = call(D.createElement, document, ['template']) as HTMLTemplateElement;
        trusted((value) => { template.innerHTML = value as string; }, html, 'createHTML');
        const inBody = countOf(body);
        const outside = target === body ? 0 : inBody - countOf(target);
        let depth = 0;
        for (let n = target; n !== body; n = call(parentOf, n, [])) depth++;
        sanitize(template.content, fileOf, isMinted, options.render, { elements: options.render.maxElements - outside, depth: options.render.maxDepth - depth });
        // The characters the body would hold (R1-1): its serialization outside the target, plus the cleaned fragment's
        // (which is what the target's serialization becomes: the same nodes, moved). Measured on the browser's own
        // serializer, after the renderer, so attributes it dropped and elements it unwrapped never count.
        const bodyLength = call(innerHTMLOf, body, []).length as number;
        const charactersOutside = target === body ? 0 : bodyLength - (call(innerHTMLOf, target, []).length as number);
        if (charactersOutside + (call(innerHTMLOf, template, []).length as number) > options.render.maxCharacters) throw new RangeError('VIEW_MAX_CHARACTERS');
        call(E.replaceChildren, target, [template.content]);
    };
    const innerHTMLOf = getter(Element.prototype, 'innerHTML');

    // sandboxView.text() and set() (review round 1, R4-5). The element is found as a render's target is, by id inside
    // the body (never the body itself, never the bootstrap's own head), and an id that names nothing is dropped, like a
    // render to a missing target. What either leaves in the body is counted against the view's characters as the
    // browser serializes it, over the document it would leave (R1-1), before anything changes.
    const elementInBody = (id: string): Element | null => {
        const body = call(bodyOf, document, []);
        const target = call(D.getElementById, document, [id]);
        return target && body && target !== body && call(containsNode, body, [target]) ? target : null;
    };
    const HTML_NS = 'http://www.w3.org/1999/xhtml';
    const namespaceOf = getter(Element.prototype, 'namespaceURI');
    const setTextContent = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')!.set!;
    const setter = (proto: object, name: string) => Object.getOwnPropertyDescriptor(proto, name)!.set!;
    const inputValue = setter(HTMLInputElement.prototype, 'value');
    const inputChecked = setter(HTMLInputElement.prototype, 'checked');
    const inputType = getter(HTMLInputElement.prototype, 'type');
    const textareaValue = setter(HTMLTextAreaElement.prototype, 'value');
    const selectValue = setter(HTMLSelectElement.prototype, 'value');
    const outputValue = setter(HTMLOutputElement.prototype, 'value');
    const focusElement = HTMLElement.prototype.focus;
    const hasFocus = D.hasFocus;
    // How many characters `text` is as an element's content, serialized (escaped, as in every element the renderer
    // keeps but <style>, where it is raw text and so shorter: the count is an upper bound there).
    const textLength = (text: string) => {
        const probe = call(D.createElement, document, ['template']) as HTMLTemplateElement;
        call(setTextContent, probe.content, [text]);
        return call(innerHTMLOf, probe, []).length as number;
    };
    // How many characters an attribute `value="…"` adds to its element's serialization; 0 for none.
    const valueAttributeLength = (value: string | null) => {
        if (value === null) return 0;
        const probe = call(D.createElement, document, ['span']);
        call(E.setAttribute, probe, ['value', value]);
        return (call(outerHTMLOf, probe, []).length as number) - '<span></span>'.length;
    };
    const outerHTMLOf = getter(Element.prototype, 'outerHTML');
    const bodyCharacters = () => call(innerHTMLOf, call(bodyOf, document, []), []).length as number;
    const assertCharacters = (total: number) => {
        if (total > options.render.maxCharacters) throw new RangeError('VIEW_MAX_CHARACTERS');
    };
    // The element's content becomes one text node holding `text`: assigned, never parsed.
    const replaceText = (target: Element, text: string) => {
        assertCharacters(bodyCharacters() - (call(innerHTMLOf, target, []).length as number) + textLength(text));
        call(setTextContent, target, [text]);
    };
    const applyText = (text: string, into: string) => {
        const target = elementInBody(into);
        if (target) replaceText(target, text);
    };
    // value: an input's (shown, and its value attribute, so the characters it holds are in the serialization and the
    // budget), a textarea's (shown, and its text), a select's (which option), an output's (its text); any other element,
    // or a file input, is left as it is. checked: an input's. focus: only while this document has the user's focus, so
    // a guest can move focus within the sandbox but never take it from the host page (VIEW_FOCUS, refused); a value or
    // checked state in the same set still applies.
    const applySet = (id: string, fields: { value?: string; checked?: boolean; focus?: boolean }) => {
        const target = elementInBody(id);
        if (!target || call(namespaceOf, target, []) !== HTML_NS) return;
        const name = call(localNameOf, target, []);
        const value = fields.value;
        if (value !== undefined) {
            if (name === 'input' && call(inputType, target, []) !== 'file') {
                assertCharacters(bodyCharacters() - valueAttributeLength(call(E.getAttribute, target, ['value'])) + valueAttributeLength(value));
                call(E.setAttribute, target, ['value', value]);
                call(inputValue, target, [value]);
            } else if (name === 'textarea') {
                replaceText(target, value);
                call(textareaValue, target, [value]);
            } else if (name === 'output') {
                replaceText(target, value);
                call(outputValue, target, [value]);
            } else if (name === 'select') {
                call(selectValue, target, [value]);
            }
        }
        if (fields.checked !== undefined && name === 'input') call(inputChecked, target, [fields.checked]);
        if (fields.focus !== true) return;
        if (!call(hasFocus, document, [])) throw new RangeError('VIEW_FOCUS');
        call(focusElement, target, []);
    };

    // At most one flush per animation frame (a timer stands in where frames are throttled), the latest render or text
    // per target; one VIEW_ACK per flush releases the worker's next operation (A4). And at most
    // VIEW_RENDER_CHARACTERS_PER_SECOND characters per second (R1-1), a token bucket charged with each operation's
    // characters (a render's markup, a text, a value) when it is applied, refused or not: a flush that the budget does
    // not cover yet waits until it does.
    type Job = { kind: 'render' | 'text' | 'set'; target: string | null; html: string; fields: { value?: string; checked?: boolean; focus?: boolean } | null };
    let pending: Job[] = [];
    let scheduled = false;
    let tokens = options.renderRate;
    let refilled = performance.now();
    const refill = () => {
        const now = performance.now();
        tokens = Math.min(options.renderRate, tokens + ((now - refilled) / 1000) * options.renderRate);
        refilled = now;
    };
    const costOf = (jobs: Job[]) => {
        let cost = 0;
        for (let i = 0; i < jobs.length; i++) cost += jobs[i]!.kind === 'set' ? (jobs[i]!.fields!.value || '').length : jobs[i]!.html.length;
        return cost;
    };
    const flush = () => {
        const jobs = pending;
        pending = [];
        scheduled = false;
        refill();
        tokens -= costOf(jobs);
        const refused: string[] = [];
        for (let i = 0; i < jobs.length; i++) {
            const job = jobs[i]!;
            try {
                if (job.kind === 'render') apply(job.html, job.target);
                else if (job.kind === 'text') applyText(job.html, job.target!);
                else applySet(job.target!, job.fields!);
            } catch (error: any) {
                // refused before anything was changed (the renderer, or a budget): this operation is dropped, and the ack
                // below still releases the next one; one past the view's budget, or a focus the view refused, is named to
                // the worker, which says so
                const message = error && error.message;
                if (message === 'VIEW_MAX_ELEMENTS' || message === 'VIEW_MAX_DEPTH' || message === 'VIEW_MAX_CHARACTERS' || message === 'VIEW_FOCUS') refused.push(message);
            }
        }
        if (renderPort) renderPort.postMessage(refused.length > 0 ? { type: 'VIEW_ACK', refused } : { type: 'VIEW_ACK' });
    };
    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        let ran = false;
        const run = () => {
            if (ran) return;
            ran = true;
            flush();
        };
        refill();
        const short = costOf(pending) - tokens; // what the budget lacks now, in characters
        const wait = short > 0 ? Math.ceil((short / options.renderRate) * 1000) : 0;
        const start = () => {
            requestAnimationFrame(run);
            setTimeout(run, 100);
        };
        if (wait > 0) setTimeout(start, wait);
        else start();
    };
    const isTarget = (id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= options.maxTarget;
    const isText = (text: unknown) => typeof text === 'string' && text.length <= options.maxRender;
    // A VIEW_SET's fields, each of its type, or null for a malformed one.
    const fieldsOf = (data: any): Job['fields'] => {
        const fields: Job['fields'] = {};
        if (data.value !== undefined) {
            if (!isText(data.value)) return null;
            fields.value = data.value;
        }
        for (const key of ['checked', 'focus'] as const) {
            if (data[key] === undefined) continue;
            if (typeof data[key] !== 'boolean') return null;
            fields[key] = data[key];
        }
        return fields;
    };
    const onRender = (event: MessageEvent) => {
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'VIEW_LISTEN') {
            subscribed = Array.isArray(data.types) ? data.types.filter((type: unknown) => options.events.types.indexOf(type as string) >= 0) : [];
            return;
        }
        let job: Job | null = null;
        if (data.type === 'VIEW_RENDER') {
            if (isText(data.html) && (data.into === null || isTarget(data.into))) job = { kind: 'render', target: data.into, html: data.html, fields: null };
        } else if (data.type === 'VIEW_TEXT') {
            if (isText(data.text) && isTarget(data.into)) job = { kind: 'text', target: data.into, html: data.text, fields: null };
        } else if (data.type === 'VIEW_SET') {
            const fields = isTarget(data.id) ? fieldsOf(data) : null;
            if (fields) job = { kind: 'set', target: data.id, html: '', fields };
        } else {
            return;
        }
        if (!job) {
            renderPort!.postMessage({ type: 'VIEW_ACK' }); // refused, but never a stall
            return;
        }
        // a render or a text replaces what is pending for its target: the latest wins
        if (job.kind !== 'set') {
            for (let i = 0; i < pending.length; i++) {
                if (pending[i]!.kind !== 'set' && pending[i]!.target === job.target) {
                    pending[i] = job;
                    schedule();
                    return;
                }
            }
        }
        pending.push(job);
        schedule();
    };

    // Content auto-sizing (B6), when the host asks for it: the view has the document, so it measures, exactly
    // as the default bootstrap does, and reports on the view port, which no guest code can reach.
    const startAutoResize = () => {
        if (typeof ResizeObserver !== 'function') return;
        let lastHeight = -1;
        const measure = () => {
            const root = call(rootOf, document, []);
            if (!root) return;
            const box = Math.ceil(root.getBoundingClientRect().height);
            const height = root.scrollHeight > root.clientHeight ? Math.max(box, root.scrollHeight) : box;
            if (height === lastHeight) return;
            lastHeight = height;
            toHost({ type: 'RESIZE', height });
        };
        const observer = new ResizeObserver(measure);
        observer.observe(call(rootOf, document, []));
        const body = call(bodyOf, document, []);
        if (body) observer.observe(body);
    };

    addEventListener('message', (event: MessageEvent) => {
        if (initialised || event.source !== parent.parent) return;
        const data = event.data;
        if (!data || data.type !== 'INIT_VIEW' || typeof data.workerSource !== 'string' || event.ports.length !== 2) return;
        event.stopImmediatePropagation();
        initialised = true;
        const logicPort = event.ports[0]!;
        viewPort = event.ports[1]!;
        viewPort.onmessage = (message: MessageEvent) => {
            const m = message.data;
            if (m && m.type === 'VIEW_PING' && typeof m.n === 'number') viewPort!.postMessage({ type: 'VIEW_PONG', n: m.n });
            // A guest write the host recorded (R4-4), answered once shown: the host tells the guest its write stands only
            // then, so a render after `await sandboxFiles.write()` finds the URL here.
            if (m && m.type === 'VIEW_WRITE' && typeof m.id === 'number') {
                showWrite(m.path, m.mime, m.bytes);
                viewPort!.postMessage({ type: 'VIEW_WRITTEN', id: m.id });
            }
        };
        // The check-in (review round 1, R3-1): the first frame on the view port, which only this bootstrap holds. The
        // host is 'ready' on it, never on the frame's load alone, which fires also when this script did not run.
        // It carries the view's size: a host page whose style-src refuses the wrapper's style leaves it 150 px high,
        // which only this side can see (frame-documents.ts, WRAPPER_STYLE); the host warns.
        viewPort.postMessage({ type: 'VIEW_READY', width: g.innerWidth, height: g.innerHeight });
        for (let i = 0; i < outbox.length; i++) viewPort.postMessage(outbox[i]);
        outbox.length = 0;

        // The view's own blob: URLs for the registered files it may show (no JavaScript among them): with the ones it
        // mints for raster-image guest writes (showWrite, R4-4), the only blob: URLs the renderer keeps (A8).
        const entries = Array.isArray(data.viewFiles) ? data.viewFiles : [];
        const files = installFiles(entries);
        viewFiles = new Map();
        minted = new Set();
        for (let i = 0; i < entries.length; i++) {
            const path = entries[i][0];
            const url = files.url(path);
            viewFiles.set(path, { url, type: String(entries[i][1]) }); // the type the store gave it, which its blob carries
            minted.add(url);
        }

        // The worker's source URL is revoked on the first message the worker sends on the render port (review C1,
        // follow-up audit 2026-10-14). Only the worker prelude can post there, and it first does so (VIEW_STARTED)
        // when it takes INIT_WORKER, which a worker handles only after its whole script (prelude, entry, marker)
        // has run: the source has been read and evaluated by then, and the entry's own errors have been raised.
        // From then on the URL resolves nowhere, so the view can no longer load or fetch the worker's source: the
        // only blob: URLs left that rendered markup could name are the worker's copies of registered files and the
        // view's own, and the narrowed A8 guarantee, "the view renders no blob: content but registered files and
        // raster-image guest writes, decoded only" (R4-4 added the writes), holds by construction.
        // Revoking earlier (once the Worker object exists) was rejected in the review: in WebKit the worker's
        // script had not been read yet, and every blob: URL it then minted was unreadable (sandboxFiles failed
        // with NotReadableError). Measured at this point on all three engines: Blob reads, fetches of the
        // worker's own URLs, sandboxFiles and execute() keep working (test/e2e/review-strict.spec.ts, "C1").
        //
        // One thing does change, in WebKit only: inside the worker, an uncaught error thrown later by code from the
        // revoked script is muted ("Script error.", no error object), since WebKit can no longer resolve the
        // script's URL to its origin; here, on the Worker object, the same error keeps its text. So the prelude
        // logs every later error it can describe itself and leaves a muted one to this document, which logs it
        // (GUEST_UNCAUGHT). Which errors are the entry's own (they end the sandbox: GUEST_ERROR) is decided without
        // relying on the order of two channels: an error before VIEW_STARTED can only be the entry's (a later one
        // the worker can describe never reaches here, and a muted one needs the revocation, which follows
        // VIEW_STARTED); after it, VIEW_STARTED says how many of the Worker object's errors were the entry's, and
        // errors on one Worker object arrive in the order they were raised.
        let sourceUrl: string | null = null;
        let started = false;
        let entryErrors = 0; // from VIEW_STARTED: how many of the worker's first error events are the entry's
        let errorsSeen = 0;
        const channel = new MessageChannel();
        renderPort = channel.port1;
        renderPort.onmessage = (event: MessageEvent) => {
            if (!started) {
                started = true;
                const first = event.data;
                if (first && first.type === 'VIEW_STARTED' && typeof first.entryErrors === 'number') entryErrors = first.entryErrors;
                if (sourceUrl !== null) URL.revokeObjectURL(sourceUrl);
                sourceUrl = null;
            }
            onRender(event);
        };
        let worker: Worker | null = null;
        try {
            const url = URL.createObjectURL(new Blob([data.workerSource], { type: 'text/javascript' }));
            sourceUrl = url;
            trusted((value) => { worker = new Worker(value as string); }, url, 'createScriptURL');
        } catch (error: any) {
            // A SecurityError is the policy refusing the worker's URL (Chromium can throw it here): no guest code ran.
            viewPort.postMessage(error && error.name === 'SecurityError' ? { type: 'WORKER_REFUSED' } : { type: 'GUEST_ERROR', message: String((error && error.message) || error) });
            return;
        }
        // Errors the worker did not cancel: the entry's own (a syntax error, a throw at its top level), which end
        // the sandbox, and later ones the worker could not describe (muted, above), which are logged. An error event
        // with no message before the worker started says only that its script did not run: either it was not loaded
        // at all (all three engines, for a host page's worker-src without blob:; WebKit under the host page's
        // Cross-Origin-Embedder-Policy) or it did not parse (Firefox gives a syntax error no message). A probe worker
        // of one statement tells which (R3-1): if it cannot run either, the policy refuses blob: workers and nothing of
        // the guest's ran; if it runs, the entry did not parse. Only on that path, so a build pays nothing for it.
        const probe = (decide: (refused: boolean) => void) => {
            let probeWorker: Worker | null = null;
            let url = '';
            const done = (refused: boolean) => {
                if (probeWorker) probeWorker.terminate();
                URL.revokeObjectURL(url);
                decide(refused);
            };
            try {
                url = URL.createObjectURL(new Blob(['postMessage(0)'], { type: 'text/javascript' }));
                trusted((value) => { probeWorker = new Worker(value as string); }, url, 'createScriptURL');
            } catch {
                done(true);
                return;
            }
            probeWorker!.onmessage = () => done(false);
            probeWorker!.onerror = () => done(true);
        };
        worker!.onerror = (error: ErrorEvent) => {
            const index = errorsSeen++;
            if (!started && !error.message) {
                probe((refused) => viewPort!.postMessage(refused ? { type: 'WORKER_REFUSED' } : { type: 'GUEST_ERROR', message: 'the entry did not parse (this browser gives no detail)' }));
                return;
            }
            const message = String(error.message || 'the worker failed');
            if (!started || index < entryErrors) {
                viewPort!.postMessage({ type: 'GUEST_ERROR', message });
                return;
            }
            error.preventDefault();
            viewPort!.postMessage({ type: 'GUEST_UNCAUGHT', message });
        };
        worker!.postMessage({ type: 'INIT_WORKER' }, [logicPort, channel.port2]);

        if (typeof data.html === 'string' && data.html !== '') {
            try {
                tokens -= data.html.length; // the initial view is charged like any render (R1-1)
                apply(data.html, null);
            } catch {
                // past the budget, or anything else the renderer refused: the initial view stays empty
            }
        }
        if (data.autoResize === true) startAutoResize();
    }, true);
}

/**
 * The worker's prelude in strict mode, after the comms script and sandboxFiles, before the guest's entry.
 * Stringified; self-contained.
 *
 * Hardening before any guest code (A7), beyond the globals allowlist the worker's source applies first
 * (worker-globals.ts: no Worker or SharedWorker, whose nested worker worker-src blob: would admit, research 15 P3; no
 * EventSource; nothing else that requests): no WebAssembly unless scriptUnsafe (WebKit compiles it without
 * 'unsafe-eval', P3), and no URL.createObjectURL — the files' URLs are minted before this runs, and a URL
 * guest code minted could otherwise name unregistered media to the view through CSS (A8). RTCPeerConnection
 * is never there in a worker, and the comms script deletes it anyway.
 *
 * The render port (A4): taken from the one trusted INIT_WORKER message by a capture listener registered
 * before guest code, which stops every trusted message on the global (there is no other: only the view
 * posts to this worker), so guest listeners never see it. Every operation on the port and on the message
 * goes through primitives captured here, called with a captured Reflect.apply, so patching
 * MessagePort.prototype, MessageEvent.prototype or Function.prototype cannot reach the port. Guest code
 * gets only `sandboxView.render`, `text` and `set`, which queue operations for the view and post one at a time, the
 * next only after the view's VIEW_ACK, and `sandboxView.on`, which registers handlers for the events the view forwards
 * (the port itself is never handed to a handler).
 */
export function inStrictWorker(comms: { attach(port: MessagePort): void; log(level: 'log' | 'info' | 'warn' | 'error', args: unknown[]): void }, options: { scriptUnsafe: boolean; maxRender: number; maxTarget: number; maxElements: number; maxDepth: number; maxCharacters: number; entryDoneName: string; eventTypes: readonly string[] }) {
    const g = globalThis as any;
    const apply = Reflect.apply;
    // The prelude's own lists have no prototype (review C3): an index written to them never reaches an inherited
    // setter, so guest code that defines one on Array.prototype (or puts a Proxy in its chain) sees none of the
    // render queue, the handlers or the subscribed types. They are only ever read by index and length.
    const setPrototype = Object.setPrototypeOf;
    const list = <T>(): T[] => setPrototype([], null);
    const addListener = EventTarget.prototype.addEventListener;
    const dataOf = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')!.get!;
    const portsOf = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'ports')!.get!;
    const stopImmediate = Event.prototype.stopImmediatePropagation;
    const cancel = Event.prototype.preventDefault;
    const defaultPreventedOf = Object.getOwnPropertyDescriptor(Event.prototype, 'defaultPrevented')!.get!;
    const laterMicrotask = g.queueMicrotask;
    const post = MessagePort.prototype.postMessage;
    const startPort = MessagePort.prototype.start;
    const join = Array.prototype.join; // for error texts: a patched join would otherwise receive the prelude's own list as `this`
    // The prelude's own lines go through the comms script's relay (in-sandbox-script.ts), the one chokepoint every
    // guest line goes through, never through `console`, which guest code can replace.
    const log = comms.log;
    const startsWith = String.prototype.startsWith;
    // "Uncaught …" once (review round 1, R4-7): Chromium's ErrorEvent message already starts with it.
    const uncaught = (text: string) => (apply(startsWith, text, ['Uncaught ']) ? text : 'Uncaught ' + text);
    const reportError = typeof g.reportError === 'function' ? g.reportError : null;

    // A name that stays after its deletion is a failure, not something to carry on with (review C2): a top-level
    // declaration of the entry could once make a global non-configurable before this ran.
    const remove = (owner: any, name: string) => {
        if (owner && name in owner) Reflect.deleteProperty(owner, name);
        if (owner && name in owner) throw new Error('[Sandbox] the strict worker could not remove ' + name);
    };
    if (!options.scriptUnsafe) remove(g, 'WebAssembly');
    remove(g.URL, 'createObjectURL');
    remove(g.webkitURL, 'createObjectURL');

    // ---- render flow control: sandboxView.render, text and set ----
    // One queue of operations for the view, one in flight at a time (A4): the next is posted only after the view's
    // VIEW_ACK. render and text replace an element's content, so they share one slot per target and the latest wins
    // where it is queued; a set is merged only into a set of the same id queued right before it, so no operation ever
    // moves past another (a set queued after the render that creates its element stays after it).
    type Operation = { slot: string; kind: 'render' | 'text' | 'set'; message: Record<string, unknown> };
    let renderPort: MessagePort | null = null;
    let inFlight: Operation | null = null;
    const queue = list<Operation>();
    const keysOf = Object.keys;
    const sendNext = () => {
        if (!renderPort || inFlight || queue.length === 0) return;
        const next = queue[0]!;
        for (let i = 1; i < queue.length; i++) queue[i - 1] = queue[i]!;
        queue.length = queue.length - 1;
        inFlight = next;
        apply(post, renderPort, [next.message]);
    };
    const enqueue = (operation: Operation) => {
        if (operation.kind !== 'set') {
            for (let i = 0; i < queue.length; i++) {
                if (queue[i]!.slot === operation.slot) {
                    queue[i] = operation;
                    return;
                }
            }
        } else if (queue.length > 0 && queue[queue.length - 1]!.slot === operation.slot) {
            const merged = queue[queue.length - 1]!.message;
            const keys = keysOf(operation.message); // indexed, never iterated: guest code can replace the array iterator (C3)
            for (let i = 0; i < keys.length; i++) merged[keys[i]!] = operation.message[keys[i]!];
            return;
        }
        queue[queue.length] = operation;
        sendNext();
    };
    const isId = (id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= options.maxTarget;
    const render = (html: unknown, into?: unknown) => {
        if (typeof html !== 'string') throw new TypeError('sandboxView.render: html must be a string');
        if (html.length > options.maxRender) throw new RangeError('sandboxView.render: html is longer than ' + options.maxRender + ' characters');
        const target = into === undefined || into === null ? null : into;
        if (target !== null && !isId(target)) throw new TypeError('sandboxView.render: into must be an element id or null');
        enqueue({ slot: target === null ? 'content' : 'content#' + target, kind: 'render', message: { type: 'VIEW_RENDER', html, into: target } });
    };
    // The text of the element with that id, as one text node: the view assigns it, so nothing in it is parsed, and the
    // guest escapes nothing (review round 1, R4-5). Bounded like a render: VIEW_RENDER_MAX_LENGTH, and the view's
    // character budget and rate.
    const text = (id: unknown, value: unknown) => {
        if (!isId(id)) throw new TypeError('sandboxView.text: id must be an element id');
        if (typeof value !== 'string') throw new TypeError('sandboxView.text: text must be a string');
        if (value.length > options.maxRender) throw new RangeError('sandboxView.text: text is longer than ' + options.maxRender + ' characters');
        enqueue({ slot: 'content#' + id, kind: 'text', message: { type: 'VIEW_TEXT', into: id, text: value } });
    };
    // A form control's value or checked state, or focus (R4-5). Each own enumerable field of `fields` is read once,
    // and only these three are allowed, each of its one type; what is posted is a fresh object of those primitives.
    const set = (id: unknown, fields: unknown) => {
        if (!isId(id)) throw new TypeError('sandboxView.set: id must be an element id');
        if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw new TypeError('sandboxView.set: the second argument must be an object: { value?, checked?, focus? }');
        const message: Record<string, unknown> = setPrototype({ type: 'VIEW_SET', id }, null); // no inherited setter for a key (C3)
        let any = false;
        const keys = keysOf(fields);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i]!;
            const value = (fields as Record<string, unknown>)[key];
            if (key === 'value') {
                if (typeof value !== 'string') throw new TypeError('sandboxView.set: value must be a string');
                if (value.length > options.maxRender) throw new RangeError('sandboxView.set: value is longer than ' + options.maxRender + ' characters');
            } else if (key === 'checked' || key === 'focus') {
                if (typeof value !== 'boolean') throw new TypeError('sandboxView.set: ' + key + ' must be a boolean');
            } else {
                throw new TypeError('sandboxView.set: unknown key "' + String(key).slice(0, 64) + '"; the keys are value, checked and focus');
            }
            message[key] = value;
            any = true;
        }
        if (any) enqueue({ slot: 'set#' + id, kind: 'set', message });
    };
    // ---- events: sandboxView.on(type, id | null, handler) → off ----
    // The view forwards only the types some handler listens to (VIEW_LISTEN, sent whenever that set changes).
    // A handler with an id runs for events on that element or inside it (the detail's ids); with null, for all.
    const isEventType = (type: unknown) => {
        for (let i = 0; i < options.eventTypes.length; i++) if (options.eventTypes[i] === type) return true;
        return false;
    };
    type Handler = { type: string; id: string | null; handler: (detail: unknown) => void; active: boolean };
    const handlers = list<Handler>();
    let listened = '';
    const syncListen = () => {
        if (!renderPort) return;
        const types = list<string>();
        let key = '';
        for (let t = 0; t < options.eventTypes.length; t++) {
            for (let h = 0; h < handlers.length; h++) {
                if (handlers[h]!.type === options.eventTypes[t]) {
                    types[types.length] = options.eventTypes[t]!;
                    key += options.eventTypes[t] + ',';
                    break;
                }
            }
        }
        if (key === listened) return;
        listened = key;
        apply(post, renderPort, [{ type: 'VIEW_LISTEN', types }]);
    };
    const on = (type: unknown, id: unknown, handler: unknown) => {
        if (!isEventType(type)) throw new TypeError('sandboxView.on: type must be one of ' + apply(join, options.eventTypes, [', ']));
        const target = id === undefined || id === null ? null : id;
        if (target !== null && (typeof target !== 'string' || target.length === 0 || target.length > options.maxTarget)) {
            throw new TypeError('sandboxView.on: id must be an element id or null');
        }
        if (typeof handler !== 'function') throw new TypeError('sandboxView.on: handler must be a function');
        const entry: Handler = { type: type as string, id: target as string | null, handler: handler as (detail: unknown) => void, active: true };
        handlers[handlers.length] = entry;
        syncListen();
        return () => {
            if (!entry.active) return;
            entry.active = false;
            let kept = 0;
            for (let i = 0; i < handlers.length; i++) if (handlers[i] !== entry) handlers[kept++] = handlers[i]!;
            handlers.length = kept;
            syncListen();
        };
    };
    const dispatch = (detail: any) => {
        if (!detail || typeof detail !== 'object' || !isEventType(detail.type)) return;
        const ids = detail.ids;
        const current = list<Handler>();
        for (let i = 0; i < handlers.length; i++) current[i] = handlers[i]!;
        for (let i = 0; i < current.length; i++) {
            const entry = current[i]!;
            if (!entry.active || entry.type !== detail.type) continue;
            if (entry.id !== null) {
                let found = false;
                for (let k = 0; ids && k < ids.length; k++) if (ids[k] === entry.id) found = true;
                if (!found) continue;
            }
            try {
                entry.handler(detail);
            } catch (error) {
                // reported like any uncaught error (logged by the listener below), without stopping the others
                if (reportError) apply(reportError, g, [error]);
                else log('error', [uncaught(String(error))]);
            }
        }
    };

    const onRenderMessage = (event: MessageEvent) => {
        const data = apply(dataOf, event, []);
        if (!data || typeof data !== 'object') return;
        if (data.type === 'VIEW_ACK') {
            // what the view refused of the one operation in flight (an operation past the view's budget, broad review
            // ST2; focus without the user's focus, R4-5): said here, to the guest's own log
            const refused = data.refused;
            const kind = inFlight ? inFlight.kind : 'render';
            for (let i = 0; refused && i < refused.length; i++) {
                if (refused[i] === 'VIEW_FOCUS') {
                    log('warn', ["[Sandbox] sandboxView.set: the view refused focus: the user's focus is not in the sandbox (they last interacted with the host page, or the window is not focused); the rest was applied."]);
                    continue;
                }
                const why = refused[i] === 'VIEW_MAX_DEPTH'
                    ? 'it would nest elements more than ' + options.maxDepth + ' deep'
                    : refused[i] === 'VIEW_MAX_CHARACTERS'
                        ? 'the view would hold more than ' + options.maxCharacters + ' characters'
                        : 'the view would hold more than ' + options.maxElements + ' elements';
                log('warn', ['[Sandbox] sandboxView.' + kind + ': the view refused ' + (kind === 'render' ? 'a render' : 'it') + ': ' + why + '; nothing of it was applied.']);
            }
            inFlight = null;
            sendNext();
            return;
        }
        if (data.type === 'VIEW_EVENT') dispatch(data.detail);
    };
    g.sandboxView = Object.freeze({ render, text, set, on });

    // ---- the one INIT_WORKER ----
    let initialised = false;
    apply(addListener, g, ['message', (event: MessageEvent) => {
        if (!event.isTrusted) return; // isTrusted is an own, unforgeable property
        apply(stopImmediate, event, []);
        if (initialised) return;
        const data = apply(dataOf, event, []);
        if (!data || data.type !== 'INIT_WORKER') return;
        const ports = apply(portsOf, event, []);
        if (!ports || ports.length !== 2) return;
        initialised = true;
        renderPort = ports[1];
        apply(addListener, renderPort, ['message', onRenderMessage]);
        apply(startPort, renderPort, []);
        // Always the first frame on the render port: it tells the view that this script ran to its end, and how
        // many of the errors that reach the Worker object were the entry's (the view ends the sandbox for those);
        // the view revokes the worker's source URL on it (review C1). Before attach(), so it precedes everything.
        apply(post, renderPort, [{ type: 'VIEW_STARTED', entryErrors }]);
        comms.attach(ports[0]);
        syncListen();
        sendNext();
    }, true]);

    // ---- entry failure ----
    // An uncaught error while the entry runs (before the line after it calls the marker) is left alone: it
    // reaches the Worker object in the view, which reports GUEST_ERROR, and the host ends the sandbox. It is
    // counted once its dispatch is over, if nothing cancelled it, since only then does it reach the view;
    // VIEW_STARTED carries the count. Every later uncaught error is cancelled here and logged, so it never ends
    // the sandbox, except one the browser muted here: in WebKit, once the view has revoked the worker's source
    // URL (review C1), an error thrown by code from that script reads "Script error." in the worker, while the
    // Worker object in the view still gets its text. Such an error is left to the view, which logs it.
    let entryRan = false;
    let entryErrors = 0;
    const isMuted = (event: ErrorEvent) => event.error === null && event.message === 'Script error.';
    apply(addListener, g, ['error', (event: ErrorEvent) => {
        if (!event.isTrusted) return; // isTrusted is an own, unforgeable property; only trusted errors reach the view
        if (!entryRan) {
            apply(laterMicrotask, g, [() => { if (!apply(defaultPreventedOf, event, [])) entryErrors++; }]);
            return;
        }
        if (isMuted(event)) return;
        apply(cancel, event, []);
        log('error', [uncaught(String(event.message))]);
    }, true]);
    Object.defineProperty(g, options.entryDoneName, { value: () => { entryRan = true; } });
}

/**
 * The first thing the strict worker runs (review C2). Stringified; self-contained.
 *
 * The worker's source is one classic script: the prelude, then the entry. The host evaluates the entry in its
 * own function scope, so its top-level declarations are local and cannot touch the globals the prelude
 * captures and deletes. But the entry's text could close that function early and declare at the top level of
 * the script, and a script's declarations are instantiated before any of it runs, so before the prelude. A
 * top-level function declaration always leaves an own, non-configurable property whose value is a function;
 * no global of the platform is one (measured in Chromium, Firefox and WebKit workers: only Infinity, NaN and
 * undefined are non-configurable). So any such property means the entry escaped its scope, and the worker
 * refuses to start: the error ends the sandbox with "the guest entry failed to start". `g` is the script's
 * `this`, the global object, and Object is reached through an object literal: neither depends on a global
 * name a declaration could have replaced. This catches escaped functions only. A top-level let, const or class is in
 * its temporal dead zone while the prelude runs, so one that shadows a global the prelude reads fails it with a
 * ReferenceError, which ends the sandbox the same way; once the entry ran, such a binding would shadow the global
 * marker the line after the entry calls, which is why the marker's name is drawn per build (entryDoneName, broad
 * review ST4): the entry's text, fixed before the build, cannot name it.
 */
export function assertEntryScoped(g: object) {
    const O = ({}).constructor as ObjectConstructor;
    const names = O.getOwnPropertyNames(g);
    for (let i = 0; i < names.length; i++) {
        const descriptor = O.getOwnPropertyDescriptor(g, names[i]!);
        if (descriptor && descriptor.configurable === false && typeof descriptor.value === 'function') {
            throw new Error('[Sandbox] the entry declares "' + String(names[i]).slice(0, 64) + '" at the top level of the worker script, outside its own scope; the worker did not start');
        }
    }
}

// ---- host side ---------------------------------------------------------------------------------

/** The literal the view bootstrap is given (in its text). */
export const VIEW_OPTIONS: ViewOptions = {
    render: RENDER_RULES,
    maxRender: VIEW_RENDER_MAX_LENGTH,
    maxTarget: VIEW_TARGET_MAX_LENGTH,
    renderRate: VIEW_RENDER_CHARACTERS_PER_SECOND,
    violationLimit: 100, // VIOLATION_EVENT_LIMIT (violation.ts); a test keeps them equal
    events: { types: VIEW_EVENT_TYPES, ...VIEW_EVENT_LIMITS },
    trustedTypesPolicy: TRUSTED_TYPES_POLICY,
    writeTypes: VIEW_WRITE_TYPES,
};

let cachedText: string | null = null;
let cachedHash: string | null = null;

/**
 * The view bootstrap's text: constant for this page (it is the text of library functions), built once.
 * Throws if it could not be hashed as written (A3): a CR or NUL, or anything that ends a script element.
 */
export function viewBootstrapText(): string {
    if (cachedText !== null) return cachedText;
    const text = `(${inSandboxView.toString()})(${inSandboxFiles.toString()}, ${sanitizeRender.toString()}, ${JSON.stringify(VIEW_OPTIONS).replaceAll('<', '\\u003c')});`;
    assertHashableScript(text);
    cachedText = text;
    return text;
}

/** The hash-source of the view bootstrap, computed once per page (script-hash.ts). */
export function viewBootstrapHash(): string {
    if (cachedHash === null) cachedHash = scriptHashSource(viewBootstrapText());
    return cachedHash;
}

/**
 * The strict view bootstrap's CSP hash source, `'sha256-…'`, for this build of the library (review round 1, R4-5): the
 * very value the element puts in the view's script-src, so an embedder can allow it in the host page's own
 * Content-Security-Policy, which the view inherits (docs/API.md, "Host page policy"). It is the hash of the library's
 * own function text, so it changes with the build (a bundler or minifier can change it): read it from the build you
 * serve, for example in a build step.
 */
export function viewScriptHash(): string {
    return viewBootstrapHash();
}

/**
 * The view document: the policy, the inherited referrer policy restated, the bootstrap, and an empty
 * body. No guest byte is ever part of it: rendered markup arrives later, through the renderer.
 */
export function buildViewDocument(csp: string, bootstrap: string): string {
    return '<!DOCTYPE html><html><head>'
        + `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`
        + '<meta name="referrer" content="no-referrer">'
        + `<script>${bootstrap}</script>`
        + '</head><body></body></html>';
}
