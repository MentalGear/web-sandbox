import { inSandboxFiles } from './in-sandbox-files';
import { assertHashableScript, scriptHashSource } from './csp/script-hash';
import { escapeAttribute } from './frame-documents';
import { REFERENCES, VIRTUAL_DOCUMENT_URL, VIRTUAL_ROOT } from './markup-references';
import { admits, LINK_REL_KINDS, LOAD_KINDS, type KindRule } from './load-kinds';
import { TRUSTED_TYPES_POLICY } from './trusted-types';
import { LOG_EVENTS_PER_SECOND } from './sandbox-log';
import { KIND_DIRECTIVES } from './csp/csp-generator';

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
 *   view    host ↔ view     VIEW_READY (the check-in), VIOLATION (source 'view'), RESIZE, GUEST_ERROR, GUEST_UNCAUGHT (bounded),
 *                           GUEST_TEXT_DROPPED (once),
 *                           WORKER_REFUSED, TRUSTED_TYPES_REFUSED, VIEW_PING/VIEW_PONG, VIEW_WRITE/VIEW_WRITTEN
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

/**
 * The most milliseconds of its own time the view spends applying operations per second, their layout included (review
 * round 2, M-3): a fifth of one thread, which it shares with the host page in WebKit and Firefox (and in Chromium
 * depending on its process model). An operation past it waits, like one past VIEW_RENDER_CHARACTERS_PER_SECOND; nothing
 * is dropped. See the view's flush (inSandboxView) for why time, and not only characters, is budgeted.
 */
export const VIEW_APPLY_MS_PER_SECOND = 200;

/**
 * The most the view's time budget may owe, in ms of the view's time (review round 3, C-2): one second of it, which the
 * budget repays in 1000 / VIEW_APPLY_MS_PER_SECOND = 5 s. An operation that took longer is charged this much, so one
 * operation's own cost (which no rate can bound: ADR-005) never holds the view back for longer than that; anything
 * shorter is charged in full, so the budget holds for every operation up to it.
 */
export const VIEW_APPLY_MAX_DEBT_MS = 1000;

/**
 * The most URL-bearing attributes the view's body may hold (review round 4, M-2): RENDER_URL_ATTRIBUTES on the elements
 * the renderer keeps, after it dropped every URL the view's policy would refuse. Counted like VIEW_MAX_ELEMENTS, over the
 * document a render would leave; a render past it is refused before anything is inserted, and acknowledged.
 *
 * Why URLs have a budget of their own. What the browser does with a URL after the render (fetching, decoding, laying the
 * image out, and for a refused one its violation processing) runs on the host page's thread wherever the view does, and
 * outside the view's time budget, which charges only what the view itself does: 6500 <img> per render, re-rendered as
 * fast as the view acknowledged, kept the host page 21–45% busy for a refused source (Chromium 31%, Firefox 45%, WebKit
 * 21%, against 19%, 14% and 10% without a source), and the reviewers measured up to 67% for an admitted origin (WebKit
 * stalled 7.5 s on one render). Refused URLs are now dropped by the renderer: the browser does nothing with them. For the
 * ones it keeps, measured from a loopback server: one render of 4000 new images cost the host page about 1 ms each
 * (Chromium 52%, Firefox 46% busy over the 8 s after it). So the cap bounds what one render can make the browser do (about
 * a second of the host page's thread), and VIEW_URLS_PER_SECOND bounds the long-run share at about the view's 20%: renders
 * of 1000 new images, as fast as the view acknowledged them, kept the host page 14% (Chromium), 19% (Firefox) and 5%
 * (WebKit, which upgrades the loopback's http: and fails it) busy, and 12%, 9% and 8% served by the test itself
 * (test/e2e/review-round-4.spec.ts, "M-2"; research 16's note).
 */
export const VIEW_MAX_URLS = 1000;

/**
 * The most URL-bearing attributes the view takes per second, charged with the render that keeps them (review round 4,
 * M-2): a render past it is applied, and the next operation waits until the budget has refilled, like
 * VIEW_RENDER_CHARACTERS_PER_SECOND. Every kept URL is charged, a cached or relative one too: what it costs the browser
 * is not known when it is rendered. See VIEW_MAX_URLS.
 */
export const VIEW_URLS_PER_SECOND = 200;

/**
 * The pseudo-elements the view's stylesheet stops animations and transitions on, besides the elements themselves
 * (VIEW_STILL_STYLE): every pseudo-element a guest's stylesheet can give an `animation` or a `transition` on the elements
 * the renderer keeps, standard and engine-prefixed (the parts of form controls and media controls the engines style with
 * pseudo-elements). `*` reaches no pseudo-element, so each is named. Each has a rule of its own: a selector list with one
 * pseudo-element an engine does not know drops the whole rule (research 16), so a name an engine does not support costs
 * nothing, and a name missing here is one an engine could animate. A pseudo-element an engine ships later is outside
 * this list until it is added; the inline-style half of the switch does not depend on it.
 */
export const VIEW_STILL_PSEUDO_ELEMENTS = [
    // standard
    'before', 'after', 'marker', 'placeholder', 'selection', 'backdrop', 'file-selector-button', 'first-letter', 'first-line',
    'cue', 'details-content', 'target-text', 'spelling-error', 'grammar-error', 'search-text', 'column', 'checkmark', 'picker-icon',
    'picker(select)', 'scroll-marker', 'scroll-marker-group', 'scroll-button(*)',
    // Chromium and WebKit
    '-webkit-file-upload-button', '-webkit-input-placeholder', '-webkit-details-marker', '-webkit-textfield-decoration-container',
    '-webkit-slider-runnable-track', '-webkit-slider-thumb', '-webkit-slider-container',
    '-webkit-progress-bar', '-webkit-progress-value', '-webkit-progress-inner-element',
    '-webkit-meter-bar', '-webkit-meter-inner-element', '-webkit-meter-optimum-value', '-webkit-meter-suboptimum-value', '-webkit-meter-even-less-good-value',
    '-webkit-inner-spin-button', '-webkit-outer-spin-button', '-webkit-clear-button', '-webkit-calendar-picker-indicator', '-webkit-list-button',
    '-webkit-search-cancel-button', '-webkit-search-decoration', '-webkit-search-results-button', '-webkit-search-results-decoration',
    '-webkit-caps-lock-indicator', '-webkit-credentials-auto-fill-button', '-webkit-contacts-auto-fill-button', '-webkit-credit-card-auto-fill-button', '-webkit-strong-password-auto-fill-button',
    '-webkit-datetime-edit', '-webkit-datetime-edit-fields-wrapper', '-webkit-datetime-edit-text', '-webkit-datetime-edit-year-field',
    '-webkit-datetime-edit-month-field', '-webkit-datetime-edit-week-field', '-webkit-datetime-edit-day-field', '-webkit-datetime-edit-hour-field',
    '-webkit-datetime-edit-minute-field', '-webkit-datetime-edit-second-field', '-webkit-datetime-edit-millisecond-field', '-webkit-datetime-edit-ampm-field',
    '-webkit-datetime-edit-meridiem-field', '-webkit-color-swatch-wrapper', '-webkit-color-swatch',
    '-webkit-media-controls', '-webkit-media-controls-panel', '-webkit-media-controls-enclosure', '-webkit-media-controls-overlay-enclosure',
    '-webkit-media-controls-play-button', '-webkit-media-controls-overlay-play-button', '-webkit-media-controls-mute-button',
    '-webkit-media-controls-volume-slider', '-webkit-media-controls-volume-slider-container', '-webkit-media-controls-volume-control-container',
    '-webkit-media-controls-volume-control-hover-background', '-webkit-media-controls-timeline',
    '-webkit-media-controls-timeline-container', '-webkit-media-controls-current-time-display', '-webkit-media-controls-time-remaining-display',
    '-webkit-media-controls-fullscreen-button', '-webkit-media-controls-toggle-closed-captions-button', '-webkit-media-controls-seek-back-button',
    '-webkit-media-controls-seek-forward-button', '-webkit-media-controls-rewind-button', '-webkit-media-controls-return-to-realtime-button',
    '-webkit-media-controls-start-playback-button', '-webkit-media-controls-status-display',
    '-webkit-media-text-track-container', '-webkit-media-text-track-display', '-webkit-media-text-track-region', '-webkit-media-text-track-region-container',
    '-webkit-scrollbar', '-webkit-scrollbar-button', '-webkit-scrollbar-thumb', '-webkit-scrollbar-track', '-webkit-scrollbar-track-piece',
    '-webkit-scrollbar-corner', '-webkit-resizer',
    // Firefox
    '-moz-range-track', '-moz-range-thumb', '-moz-range-progress', '-moz-progress-bar', '-moz-meter-bar', '-moz-color-swatch',
    '-moz-focus-inner', '-moz-list-bullet', '-moz-list-number', '-moz-placeholder', '-moz-selection',
] as const;

/**
 * The view's stylesheet for `allowAnimations: false` (research 16): no animation and no transition on any element of the
 * view or any pseudo-element of VIEW_STILL_PSEUDO_ELEMENTS. Elements show their end state.
 *
 * Why it holds against anything a guest's stylesheet says, measured on Chromium, Firefox and WebKit against unlayered
 * `!important`, the guest's own anonymous and named layers, `::before`, `@starting-style`, hover transitions and
 * scroll-driven animation (`animation-timeline`):
 *   - an `!important` declaration in a cascade layer beats every `!important` in a later layer and every unlayered one
 *     (css-cascade-5), so the layer must be the first one: the view inserts this sheet as its head's first element before
 *     anything is rendered (renders reach only the body, so every guest sheet, and every sheet it `@import`s, comes after
 *     it, and so does every layer they declare);
 *   - the layer is ANONYMOUS, so no guest rule can be appended to it (a named layer can be reopened by name);
 *   - an inline `!important` (a `style` attribute) beats any layer: the renderer takes every `animation*` and
 *     `transition*` declaration out of every kept `style` attribute (sanitizeRender, `animations: false`).
 * Its text is constant, so its CSP hash is a constant of the library (docs/API.md#host-page-policy): a host page whose
 * style-src refuses inline styles must list it, or the view drops the guest's stylesheets instead (inSandboxView).
 */
export const VIEW_STILL_STYLE = '@layer{' + ['*', ...VIEW_STILL_PSEUDO_ELEMENTS.map(name => '*::' + name)]
    .map(selector => `${selector}{animation:none!important;transition:none!important}`).join('') + '}';

/**
 * The properties `allowAnimations: false` takes out of style attributes (review round 4, C-2): the animation and
 * transition longhands, prefixed ones included. The view lists the engine's own once, from a computed style (every
 * property whose name matches STILL_PROPERTY_PATTERN), and adds these: the longhands of `animation`, `transition` and
 * the scroll-driven and triggered animations every engine ships or has shipped, and the shorthands themselves. A
 * declaration names longhands only (the engine's parser expands every shorthand, alias and prefix into them), so the
 * longhands are all there is to read; a shorthand read first takes all of its longhands at once (removeProperty of a
 * shorthand removes them), and covers a CSSOM that keeps shorthands whole (jsdom's).
 */
export const STILL_PROPERTY_PATTERN = '^(-[a-z]+-)?(animation|transition)(-|$)';
export const STILL_PROPERTIES = [
    'animation', 'transition', 'animation-range', 'animation-trigger',
    'animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay', 'animation-iteration-count',
    'animation-direction', 'animation-fill-mode', 'animation-play-state', 'animation-composition', 'animation-timeline',
    'animation-range-start', 'animation-range-end', 'animation-trigger-behavior', 'animation-trigger-timeline',
    'animation-trigger-range-start', 'animation-trigger-range-end', 'animation-trigger-exit-range-start',
    'animation-trigger-exit-range-end', 'transition-property', 'transition-duration', 'transition-timing-function',
    'transition-delay', 'transition-behavior',
] as const;

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
 * right-to-left took tens of seconds in Chromium and WebKit, engine and machine dependent (ADR-005: host-page availability
 * is not protected).
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
    /** VIEW_MAX_URLS: the view's body never holds more URL-bearing attributes (rules.urls). */
    maxUrls: number;
    /** The directive of the view's policy each kind of load is checked against, by its key (csp-generator.ts). */
    directives: Readonly<Record<string, string>>;
    /**
     * The longhands `allowAnimations: false` takes out of a style attribute: every property whose name matches `pattern`
     * among the engine's own (the view reads them from a computed style, once), and `known` besides.
     */
    still: { pattern: string; known: readonly string[] };
}

/**
 * What one render's renderer is given besides the rules and the switches, and what it reports back (review round 4,
 * C-2 and M-2). The view makes one per render (inSandboxView).
 */
export interface RenderContext {
    /** The local name of the element the fragment goes into: the parent of its top-level nodes (a <source>'s loader). */
    target: string;
    /** The engine's animation and transition longhands (RenderRules.still), found once per view. */
    animating: readonly string[];
    /** The origins the view's policy admits for each kind of load, by key (`origins`): an http(s) URL outside them is refused. */
    origins: Readonly<Record<string, readonly string[]>>;
    /** Filled by the renderer: each URL it dropped because the policy refuses it, with the directive that would. */
    refused: [directive: string, url: string][];
    /** Counted by the renderer: the URL-bearing attributes it kept. */
    urls: number;
}

/**
 * What one view's renderer keeps besides RENDER_RULES, from the element's configuration (INIT_VIEW) and what the view
 * found its policy allows:
 *   animations   false (`allowAnimations: false`): every `animation*` and `transition*` declaration, prefixed ones
 *                included, is taken out of every kept `style` attribute (VIEW_STILL_STYLE says why the stylesheet
 *                alone cannot stop an inline `!important`)
 *   autoplay     false (`allowAutoplay`, false by default): the `autoplay` attribute goes, from every element (only
 *                <video> and <audio> keep it at all), so media plays only when the user starts it
 *   stylesheets  false only when VIEW_STILL_STYLE is not in force (the host page's style-src refused it): every
 *                <style> (HTML and SVG) and every <link> with the stylesheet relation goes, so no guest stylesheet can
 *                animate what the refused sheet would have stopped
 */
export interface RenderSwitches {
    animations: boolean;
    autoplay: boolean;
    stylesheets: boolean;
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
    maxUrls: VIEW_MAX_URLS,
    directives: KIND_DIRECTIVES,
    still: { pattern: STILL_PROPERTY_PATTERN, known: STILL_PROPERTIES },
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
 *      a URL the view minted (A8), a URL attribute (rules.urls) whose URL is not http(s), minted or relative, or is an
 *      http(s) URL the view's policy refuses for the load the element makes (context.origins; review round 4, M-2), and
 *      an SVG paint or clip reference that is not a fragment; referrerpolicy becomes no-referrer, and is set on
 *      rules.referrerElements; rel on <a>/<area> keeps only rules.anchorRelations (A1);
 *   7. per `switches` (RenderSwitches): autoplay goes; a style attribute loses its animations and transitions; <style>
 *      and stylesheet links go.
 * The URL attributes it keeps are counted (context.urls) against `room.urls`, what is left of VIEW_MAX_URLS: past it it
 * throws, like the element budget, a RangeError 'VIEW_MAX_URLS'. Each URL it dropped as refused is reported
 * (context.refused) with the directive that refuses it, for the view to report as the browser would have.
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
export function sanitizeRender(fragment: DocumentFragment, fileOf: (path: string) => { url: string; type: string } | null, isMinted: (url: string) => boolean, rules: RenderRules, switches: RenderSwitches, room?: { elements: number; depth: number; urls?: number }, given?: RenderContext): number {
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
    const urlRoom = limit.urls === undefined ? rules.maxUrls : limit.urls;
    // Without a context (a caller that only cleans markup), the strictest one: no origin is admitted, and the
    // still properties are the known ones.
    const context: RenderContext = given || { target: 'body', animating: rules.still.known, origins: {}, refused: [], urls: 0 };
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
    // Whether the view's policy admits an http(s) URL for a load of `kind` (review round 4, M-2): the URL's origin, read
    // by the URL parser, must be one the policy lists for that kind (context.origins, the parsed `origins`, canonical as
    // origin.ts makes them), as CSP matches a source: an http: source also matches the https: URL of its host and port,
    // and the policy's upgrade-insecure-requests may turn an http: URL into its https: form first (WebKit does for every
    // host, measured), so either form is enough to keep it. Anything else the browser would refuse, after fetching
    // nothing, and report: such a URL is dropped here, before the browser sees it, and reported by the view instead.
    // A URL that does not parse loads nothing and is kept, as a relative one is.
    const ruleOf = (kind: string): KindRule | null => (call(own, rules.kinds, [kind]) ? rules.kinds[kind]! : null);
    const admittedOrigins = (kind: string): readonly string[] => {
        const rule = ruleOf(kind);
        return rule && call(own, context.origins, [rule.key]) ? context.origins[rule.key]! : [];
    };
    const directiveOf = (kind: string): string => {
        const rule = ruleOf(kind);
        return rule && call(own, rules.directives, [rule.key]) ? rules.directives[rule.key]! : 'default-src';
    };
    // The URL a refusal names, as every engine measured reports it (without credentials or fragment), or null when the
    // policy admits it (or it does not parse).
    const refusedUrl = (value: string, kind: string): string | null => {
        let url: URL;
        try {
            url = new URL(value);
        } catch {
            return null;
        }
        const scheme = url.protocol;
        const hostAndPort = url.hostname + (url.port ? ':' + url.port : '');
        const origins = admittedOrigins(kind);
        for (let i = 0; i < origins.length; i++) {
            const origin = origins[i];
            if (origin === scheme + '//' + hostAndPort || origin === 'http://' + hostAndPort || (scheme === 'http:' && origin === 'https://' + hostAndPort)) return null;
        }
        url.username = '';
        url.password = '';
        url.hash = '';
        return url.href;
    };
    // A URL the view would load: http(s), one it minted, or relative (against the view's about:blank base it resolves
    // to nothing). The scheme is read the way the URL parser reads it: outer C0 controls and spaces stripped, tabs and
    // newlines removed. An http(s) URL the policy refuses for a load of `kind` ('' for none) is added to `refused`, and
    // is not allowed.
    const urlAllowed = (value: string, kind: string, refused: string[]) => {
        const url = value.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '');
        const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
        if (!scheme) return true;
        const name = scheme[1]!.toLowerCase();
        if (name === 'blob') return isMinted(value);
        if (name !== 'https' && name !== 'http') return false;
        const blocked = kind === '' ? null : refusedUrl(url, kind);
        if (blocked === null) return true;
        refused[refused.length] = blocked;
        return false;
    };
    // srcset: every candidate's URL starts at the start or after a comma, and its scheme holds neither, so checking the
    // first token after every comma checks every candidate (a URL that itself holds a comma is only checked more)
    const srcsetAllowed = (value: string, kind: string, refused: string[]) => {
        const pieces = value.split(',');
        for (let i = 0; i < pieces.length; i++) {
            const url = pieces[i]!.replace(/^[\t\n\f\r ]+/, '').split(/[\t\n\f\r ]/)[0]!;
            if (url !== '' && !urlAllowed(url, kind, refused)) return false;
        }
        return true;
    };
    // The kind of load a URL attribute makes (load-kinds.ts, through rules.references), or '' where it loads nothing: a
    // <source> loads only inside <picture> (srcset: an image) or <audio> and <video> (src: media), a <track> only inside
    // <audio> and <video>.
    const urlKind = (element: string, attribute: string, parent: string): string => {
        const media = parent === 'audio' || parent === 'video';
        if (element === 'source') return attribute === 'srcset' ? (parent === 'picture' ? 'image' : '') : (media ? 'media' : '');
        if (element === 'track') return media ? 'track' : '';
        if (attribute === 'srcset') return 'image';
        for (let i = 0; i < rules.references.length; i++) {
            const reference = rules.references[i]!;
            if (reference[0] === element && reference[1] === attribute) return reference[2] === 'link' ? '' : reference[2];
        }
        return '';
    };
    const attributeAllowed = (namespace: unknown, element: string, attribute: string) => {
        if (attribute.indexOf('data-') === 0 || attribute.indexOf('aria-') === 0) return true;
        if (namespace === HTML) return htmlAttributes[attribute] === true || (perElement[element] !== undefined && perElement[element]![attribute] === true);
        if (namespace === SVG) return svgAttributes[attribute] === true || (element === 'a' && svgLinkAttributes[attribute] === true);
        return namespace === MATHML && mathAttributes[attribute] === true;
    };
    // A kept style attribute without animations and transitions (switches.animations false; review round 4, C-2).
    //   1. The text decides whether there is anything to read. A declaration names its property with an identifier,
    //      matched ASCII case-insensitively and spelled with literal letters or CSS escapes, and every property that sets
    //      an animation or transition longhand has "anim" or "trans" in its name (shorthands, aliases and prefixes
    //      alike: checked against each engine's whole property list, test/e2e/review-round-4.spec.ts), but `all`, which
    //      takes nothing but a CSS-wide keyword (a var() in it resolves to one, or the declaration is invalid). So a text
    //      without "anim", "trans" (in any case) or a backslash declares no animation, and stays as the guest wrote it:
    //      nothing is read, nothing is serialized.
    //   2. Otherwise the element's own CSSOM declaration is read, so the engine's parser decides what the attribute
    //      declares (escapes, case, `!important`, var() in a shorthand: every engine stores longhands, under their own
    //      names). A declaration of more properties than the attribute has characters (`all` with an animation
    //      beside it expands into hundreds) goes whole: reading and rewriting it would be work out of proportion to
    //      what the guest sent, which the budgets charge only after it is done.
    //   3. Only the engine's animation and transition properties are read (context.animating, found once per view),
    //      each with getPropertyValue, and each that holds anything but a CSS-wide keyword is removed; one whose value
    //      only a var() decides reads '' and is removed too (removeProperty takes it, and the declaration's length says
    //      so). A CSS-wide keyword (initial, inherit, unset, revert, revert-layer) never animates: it is the property's
    //      initial value, the parent's value (every parent was cleaned, or is stopped by the still stylesheet), or a
    //      rollback to sheets the still stylesheet stops.
    //   4. When something was removed, the attribute becomes the declaration's serialization, so what the view applies
    //      is exactly what was read here (the attribute goes when nothing is left); else it stays as written.
    // The CSSOM is no CSP sink. Before, every property of every declaration was listed and the attribute written back
    // from the declaration, so `all:unset` cost hundreds of reads and a serialization of hundreds of properties per
    // element: one render of 262 000 characters of `<i style="all:unset"></i>` stalled WebKit 10.3 s and Firefox 2.7 s
    // (0.35 s and 0.27 s with animations on), and was then refused for the characters its expansion took.
    // An element whose namespace has no `style` (jsdom's MathML, an engine without MathMLElement) loses an attribute it
    // would have to read: fail closed.
    const MAY_ANIMATE = /anim|trans|\\/i;
    const CSS_WIDE_KEYWORDS = setOf(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);
    const declaration = CSSStyleDeclaration.prototype;
    const declarationLength = getter(declaration, 'length');
    const cssTextOf = getter(declaration, 'cssText');
    const propertyValue = declaration.getPropertyValue;
    const removeProperty = declaration.removeProperty;
    const animating = context.animating;
    const styleGetter = (proto: object | null) => {
        const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'style') : undefined;
        return descriptor && descriptor.get ? descriptor.get : null;
    };
    const g = globalThis as any;
    const styleGetters: Record<string, ((this: Element) => CSSStyleDeclaration) | null> = Object.create(null);
    styleGetters[HTML] = styleGetter(HTMLElement.prototype);
    styleGetters[SVG] = styleGetter(SVGElement.prototype);
    const MathMLElementFound = g.MathMLElement;
    styleGetters[MATHML] = styleGetter(typeof MathMLElementFound === 'function' ? MathMLElementFound.prototype : null);
    const stillStyle = (element: Element, namespace: unknown, written: string) => {
        if (!MAY_ANIMATE.test(written)) return;
        const styleOf = typeof namespace === 'string' ? styleGetters[namespace] : null;
        if (!styleOf) {
            drop(element, 'style');
            return;
        }
        const style = call(styleOf, element, []) as CSSStyleDeclaration;
        const before = call(declarationLength, style, []) as number;
        if (before > written.length) {
            drop(element, 'style');
            return;
        }
        for (let i = 0; i < animating.length; i++) {
            const value = String(call(propertyValue, style, [animating[i]!]));
            if (value !== '' && CSS_WIDE_KEYWORDS[value.toLowerCase()]) continue;
            call(removeProperty, style, [animating[i]!]); // nothing, when it is not declared
        }
        const after = call(declarationLength, style, []) as number;
        if (after === before) return;
        if (after === 0) drop(element, 'style');
        else set(element, 'style', String(call(cssTextOf, style, [])));
    };

    const KEEP = 0, REMOVE = 1, UNWRAP = 2;
    const verdict = (namespace: unknown, name: string) => {
        if (namespace === HTML) {
            if (removedElements[name]) return REMOVE;
            if (name === 'style' && !switches.stylesheets) return REMOVE;
            return htmlElements[name] || isCustom(name) ? KEEP : UNWRAP;
        }
        if (namespace === SVG && name === 'style' && !switches.stylesheets) return REMOVE;
        if (namespace === SVG) return svgElements[name] ? KEEP : REMOVE;
        if (namespace === MATHML) return mathElements[name] ? KEEP : REMOVE;
        return REMOVE;
    };

    // Cleans a kept element; false when it must go after all (a <link> that names no minted file). `parent`: the local
    // name of the element it is appended to (a <source> loads by its parent).
    const clean = (element: Element, namespace: unknown, name: string, parent: string): boolean => {
        const html = namespace === HTML;
        let linkKinds: string[] = [];
        if (html && name === 'link') {
            const rel = tokens(get(element, 'rel'));
            for (let t = 0; t < rel.length; t++) {
                if (rules.linkRelations.indexOf(rel[t]!) < 0) return false;
                if (rel[t] === 'stylesheet' && !switches.stylesheets) return false;
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
            const isUrl = html && isPair(rules.urls, name, attribute);
            const kind = isUrl ? urlKind(name, attribute, parent) : '';
            const refused = list<string>();
            const keep = attributeAllowed(namespace, name, attribute)
                && !(/blob:/i.test(value.replace(/[\t\n\r]/g, '')) && !(html && isPair(rules.references, name, attribute) && isMinted(value)))
                && !(isUrl && !(attribute === 'srcset' ? srcsetAllowed(value, kind, refused) : urlAllowed(value, kind, refused)))
                && !(namespace === SVG && svgLocal[attribute] && /[:\\]/.test(value))
                && !(attribute === 'autoplay' && !switches.autoplay);
            // a URL the policy refuses: reported as the browser would have reported its load (a srcset's first one)
            if (refused.length > 0) context.refused[context.refused.length] = [directiveOf(kind), refused[0]!];
            if (!keep) {
                drop(element, attribute);
                continue;
            }
            if (attribute === 'referrerpolicy') set(element, attribute, 'no-referrer');
            else if (attribute === 'style' && !switches.animations) stillStyle(element, namespace, value);
            if (!isUrl) continue;
            context.urls++;
            if (context.urls > urlRoom) throw new RangeError('VIEW_MAX_URLS');
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
        const parentName = run.parent === fragment ? context.target : String(call(localNameOf, run.parent as Element, []));
        if (decision === KEEP && !clean(element, namespace, name, parentName)) decision = REMOVE;
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
    /** VIEW_APPLY_MS_PER_SECOND */
    applyTime: number;
    /** VIEW_APPLY_MAX_DEBT_MS */
    applyDebt: number;
    /** VIEW_URLS_PER_SECOND */
    urlRate: number;
    violationLimit: number;
    events: { types: readonly string[]; maxString: number; maxIds: number; maxFields: number; maxTotal: number };
    /** The Trusted Types policy name the view creates where the host page enforces them (trusted-types.ts). */
    trustedTypesPolicy: string;
    /** VIEW_WRITE_TYPES: the only types the view mints a URL for from a guest write. */
    writeTypes: readonly string[];
    /** The guest's error texts the view relays (GUEST_ERROR, GUEST_UNCAUGHT): longest, and most per second. */
    guestText: { maxLength: number; perSecond: number };
    /** VIEW_STILL_STYLE: the view's stylesheet for `allowAnimations: false`. */
    stillStyle: string;
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
    // The renderer's own refusals go through the same counts (review round 4, M-2): a URL the view's policy refuses is
    // dropped before insertion, so the browser never processes it, and reported here as the browser reported it (its
    // directive, and the URL without credentials or fragment), within the same per-directive cap.
    const violationCounts = new Map<string, number>();
    const reportViolation = (directive: string, blockedURI: unknown, sourceFile?: unknown, lineNumber?: unknown, columnNumber?: unknown) => {
        const bucket = violationCounts.has(directive) || violationCounts.size < 32 ? directive : '';
        const count = violationCounts.get(bucket) || 0;
        if (count >= options.violationLimit) return;
        violationCounts.set(bucket, count + 1);
        toHost({ type: 'VIOLATION', directive, blockedURI, sourceFile, lineNumber, columnNumber });
    };
    addEventListener('securitypolicyviolation', (event: any) => {
        if (!event.isTrusted) return;
        reportViolation(event.effectiveDirective || event.violatedDirective, event.blockedURI, event.sourceFile, event.lineNumber, event.columnNumber);
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

    // Whether the sinks are usable: the document does not require Trusted Types, or the policy exists or could be made.
    const trustedTypesReady = () => {
        if (policy || !g.trustedTypes) return true;
        try {
            const probe = call(D.createElement, document, ['template']) as HTMLTemplateElement;
            probe.innerHTML = '';
            return true;
        } catch (error) {
            if (!(error instanceof TypeError)) return true; // not Trusted Types: the sinks' own callers handle it
        }
        try {
            const pass = (input: string) => input;
            policy = g.trustedTypes.createPolicy(options.trustedTypesPolicy, { createHTML: pass, createScriptURL: pass });
            return true;
        } catch {
            return false;
        }
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

    // What the body holds, kept as running counts (review round 2, C-4): its serialization's length (VIEW_MAX_CHARACTERS)
    // and its elements (VIEW_MAX_ELEMENTS). Every operation used to serialize the whole body (and a render counted all its
    // elements) to check the budget, so a guest that filled the view once and then sent 2-character set() operations
    // made the view do ~1 M characters of work per operation, charged 2 (Firefox's host page fell from 233 to 67 ticks
    // per second). Now an operation measures only what it changes: the target's old content, its new content, a value
    // attribute; the body's totals are updated from those. Each operation is also charged that work (`work`, on top of
    // its own text): what the view serializes, the guest pays for, at VIEW_RENDER_CHARACTERS_PER_SECOND. A piece of
    // content is serialized as old content once, when it is replaced, and it was charged when it was rendered.
    // The counts are exact: the body changes only through these operations, and a MutationObserver on it reports anything
    // else (a user opening a <details>, the browser's find-in-page revealing hidden="until-found", a translation
    // extension, or a side effect of an operation outside its target, such as an exclusive <details name> closing
    // another): then the counts are dropped and the next operation counts the whole body again, charged in full. An
    // operation's own records are taken from the observer as soon as it is done, so only foreign ones ever reach it.
    let bodyCharacters: number | null = null;
    let bodyElements: number | null = null;
    let bodyUrls: number | null = null; // the body's URL-bearing attributes (VIEW_MAX_URLS; review round 4, M-2)
    let work = 0; // characters serialized by the current flush, charged to the budget with it
    let urlWork = 0; // URL-bearing attributes the current flush kept, charged to the URL budget with it
    const innerHTMLOf = getter(Element.prototype, 'innerHTML');
    const outerHTMLOf = getter(Element.prototype, 'outerHTML');
    const innerLength = (element: Element) => {
        const length = call(innerHTMLOf, element, []).length as number;
        work += length;
        return length;
    };
    const countOf = (root: Element) => call(lengthOf, call(E.getElementsByTagName, root, ['*']), []) as number;
    // The URL-bearing attributes under `root` (options.render.urls), counted by the browser's selector engine.
    const nodeListLength = getter(NodeList.prototype, 'length');
    const URL_SELECTORS: string[] = [];
    for (let i = 0; i < options.render.urls.length; i++) URL_SELECTORS.push(options.render.urls[i]![0] + '[' + options.render.urls[i]![1] + ']');
    const urlsOf = (root: Element) => {
        let count = 0;
        for (let i = 0; i < URL_SELECTORS.length; i++) count += call(nodeListLength, call(E.querySelectorAll, root, [URL_SELECTORS[i]]), []) as number;
        return count;
    };
    const forget = () => {
        bodyCharacters = null;
        bodyElements = null;
        bodyUrls = null;
    };
    const hasRecords = typeof MutationObserver === 'function' && typeof MutationRecord === 'function';
    const observer = hasRecords ? new MutationObserver(forget) : null;
    const takeRecords = hasRecords ? MutationObserver.prototype.takeRecords : null;
    const recordTarget = hasRecords ? getter(MutationRecord.prototype, 'target') : null;
    const recordType = hasRecords ? getter(MutationRecord.prototype, 'type') : null;
    const recordAttribute = hasRecords ? getter(MutationRecord.prototype, 'attributeName') : null;
    // The body's counts, counted again where they are unknown.
    const counts = (body: Element): { characters: number; elements: number; urls: number } => {
        if (bodyCharacters === null || bodyElements === null || bodyUrls === null) {
            bodyCharacters = innerLength(body);
            bodyElements = countOf(body);
            bodyUrls = urlsOf(body);
        }
        return { characters: bodyCharacters, elements: bodyElements, urls: bodyUrls };
    };
    // After an operation on `target`: its own records (the target's children, its value attribute) are dropped, and
    // any other record means the counts no longer hold. Without an observer the counts are never trusted.
    const settle = (target: Element) => {
        if (!observer || !takeRecords || !recordTarget || !recordType || !recordAttribute) {
            forget();
            return;
        }
        const records = call(takeRecords, observer, []) as MutationRecord[];
        for (let i = 0; i < records.length; i++) {
            const type = call(recordType, records[i], []);
            const own = call(recordTarget, records[i], []) === target && (type === 'childList' || (type === 'attributes' && call(recordAttribute, records[i], []) === 'value'));
            if (!own) forget();
        }
    };
    const observeBody = () => {
        const body = call(bodyOf, document, []);
        if (observer && body) observer.observe(body, { subtree: true, childList: true, attributes: true, characterData: true });
    };

    // What the renderer keeps besides its rules (RenderSwitches): set once, at INIT_VIEW, before anything is rendered.
    // Until then the safe side of each.
    let switches: RenderSwitches = { animations: false, autoplay: false, stylesheets: true };
    // The origins the view's policy admits per kind of load (INIT_VIEW, from `origins`; review round 4, M-2), as lists of
    // strings, and nothing until then: the renderer drops an http(s) URL outside them.
    let viewOrigins: Record<string, string[]> = Object.create(null);
    const originsOf = (given: unknown) => {
        const out: Record<string, string[]> = Object.create(null);
        if (!given || typeof given !== 'object') return out;
        for (const key of Object.keys(given)) {
            const entries = (given as Record<string, unknown>)[key];
            if (!Array.isArray(entries)) continue;
            out[key] = entries.filter((entry): entry is string => typeof entry === 'string');
        }
        return out;
    };
    // The engine's animation and transition longhands, found once (review round 4, C-2): every property a computed style
    // lists whose name matches the rules' pattern, and the known ones (RenderRules.still), so `allowAnimations: false`
    // reads only these of each style attribute. A declaration holds longhands under their own names, whatever the
    // attribute wrote (a shorthand, an alias, a prefix, an escape), so these are the only names to read.
    let stillProperties: string[] | null = null;
    const animatingProperties = (): string[] => {
        if (stillProperties) return stillProperties;
        const pattern = new RegExp(options.render.still.pattern);
        const found: string[] = [];
        const root = call(rootOf, document, []);
        const computed = root ? getComputedStyle(root) : null;
        const length = computed ? call(getter(CSSStyleDeclaration.prototype, 'length'), computed, []) as number : 0;
        for (let i = 0; i < length; i++) {
            const name = String(call(CSSStyleDeclaration.prototype.item, computed, [i]));
            if (pattern.test(name) && found.indexOf(name) < 0) found.push(name);
        }
        for (let i = 0; i < options.render.still.known.length; i++) {
            const name = options.render.still.known[i]!;
            if (found.indexOf(name) < 0) found.push(name);
        }
        stillProperties = found;
        return found;
    };

    // `allowAnimations: false` (research 16): the still stylesheet (options.stillStyle, VIEW_STILL_STYLE) becomes the
    // head's first element, before anything is rendered, so its anonymous layer is the first layer of the document and
    // every guest sheet comes after it. Whether it is in force is then asked of the engine itself, not assumed: a probe
    // element with an inline transition and animation (set through the CSSOM, which no style-src governs) must compute
    // to none. The sheet is an inline style, so a host page whose style-src has neither 'unsafe-inline' nor its hash
    // refuses it (a srcdoc document inherits the host page's policy); false then.
    const headOf = getter(Document.prototype, 'head');
    const firstChildOf = getter(Node.prototype, 'firstChild');
    const styleOfElement = getter(HTMLElement.prototype, 'style');
    const stillStyleInForce = (): boolean => {
        const head = call(headOf, document, []);
        if (!head) return false;
        const sheet = call(D.createElement, document, ['style']);
        call(Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')!.set!, sheet, [options.stillStyle]);
        call(Node.prototype.insertBefore, head, [sheet, call(firstChildOf, head, [])]);
        const probe = call(D.createElement, document, ['span']);
        const inline = call(styleOfElement, probe, []) as CSSStyleDeclaration;
        call(CSSStyleDeclaration.prototype.setProperty, inline, ['transition-duration', '1s']);
        call(CSSStyleDeclaration.prototype.setProperty, inline, ['animation-name', 'probe']);
        call(Node.prototype.appendChild, head, [probe]);
        const computed = getComputedStyle(probe);
        const held = computed.getPropertyValue('transition-duration') === '0s' && computed.getPropertyValue('animation-name') === 'none';
        call(Node.prototype.removeChild, head, [probe]);
        return held;
    };

    // template.innerHTML parses into an inert fragment (no script runs, nothing loads); the renderer cleans
    // it; replaceChildren MOVES its nodes into the document (A2) — never a clone or an import. The renderer gets the
    // room the view's budget leaves (broad review ST2): the body's elements outside the target stay, the target's own
    // are replaced, and the target's depth below the body counts; past it the renderer throws before insertion.
    const apply = (html: string, into: string | null) => {
        const body = call(bodyOf, document, []);
        const target = into === null ? body : call(D.getElementById, document, [into]);
        if (!target || !body || (target !== body && !call(containsNode, body, [target]))) return;
        const template = call(D.createElement, document, ['template']) as HTMLTemplateElement;
        trusted((value) => { template.innerHTML = value as string; }, html, 'createHTML');
        const before = counts(body);
        const ownElements = target === body ? before.elements : countOf(target);
        const ownCharacters = target === body ? before.characters : innerLength(target);
        const ownUrls = target === body ? before.urls : urlsOf(target);
        let depth = 0;
        for (let n = target; n !== body; n = call(parentOf, n, [])) depth++;
        const context: RenderContext = { target: String(call(localNameOf, target, [])), animating: switches.animations ? [] : animatingProperties(), origins: viewOrigins, refused: [], urls: 0 };
        const room = { elements: options.render.maxElements - (before.elements - ownElements), depth: options.render.maxDepth - depth, urls: options.render.maxUrls - (before.urls - ownUrls) };
        const kept = sanitize(template.content, fileOf, isMinted, options.render, switches, room, context);
        // The characters the body would hold (R1-1): its serialization outside the target, plus the cleaned fragment's
        // (what the target's serialization becomes: the same nodes, moved; never more, and less only inside a raw-text
        // element, whose text is not escaped). Measured on the browser's own serializer, after the renderer, so
        // attributes it dropped and elements it unwrapped never count. Once inserted, the target is measured again, so
        // the count is what the body serializes to, exactly.
        if (before.characters - ownCharacters + innerLength(template) > options.render.maxCharacters) throw new RangeError('VIEW_MAX_CHARACTERS');
        call(E.replaceChildren, target, [template.content]);
        settle(target);
        urlWork += context.urls;
        for (let i = 0; i < context.refused.length; i++) reportViolation(context.refused[i]![0], context.refused[i]![1]);
        if (bodyCharacters === null) return;
        bodyCharacters = before.characters - ownCharacters + innerLength(target);
        bodyElements = before.elements - ownElements + kept;
        bodyUrls = before.urls - ownUrls + context.urls;
    };

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
        return innerLength(probe);
    };
    // How many characters an attribute `value="…"` adds to its element's serialization; 0 for none.
    const valueAttributeLength = (value: string | null) => {
        if (value === null) return 0;
        const probe = call(D.createElement, document, ['span']);
        call(E.setAttribute, probe, ['value', value]);
        const length = call(outerHTMLOf, probe, []).length as number;
        work += length;
        return length - '<span></span>'.length;
    };
    const assertCharacters = (total: number) => {
        if (total > options.render.maxCharacters) throw new RangeError('VIEW_MAX_CHARACTERS');
    };
    // The element's content becomes one text node holding `text`: assigned, never parsed.
    const replaceText = (target: Element, text: string) => {
        const before = counts(call(bodyOf, document, []));
        const ownCharacters = innerLength(target);
        const ownElements = countOf(target);
        const ownUrls = urlsOf(target);
        assertCharacters(before.characters - ownCharacters + textLength(text));
        call(setTextContent, target, [text]);
        settle(target);
        if (bodyCharacters === null) return;
        bodyCharacters = before.characters - ownCharacters + innerLength(target);
        bodyElements = before.elements - ownElements;
        bodyUrls = before.urls - ownUrls;
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
                const before = counts(call(bodyOf, document, []));
                const change = valueAttributeLength(value) - valueAttributeLength(call(E.getAttribute, target, ['value']));
                assertCharacters(before.characters + change);
                call(E.setAttribute, target, ['value', value]);
                call(inputValue, target, [value]);
                settle(target);
                if (bodyCharacters !== null) bodyCharacters = before.characters + change;
            } else if (name === 'textarea') {
                replaceText(target, value);
                call(textareaValue, target, [value]);
            } else if (name === 'output') {
                replaceText(target, value);
                call(outputValue, target, [value]);
                settle(target);
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
    // characters (a render's markup, a text, a value) when it is applied, refused or not, and with the characters it
    // serialized (C-4): a flush that the budget does not cover yet waits until it does.
    //
    // And at most VIEW_APPLY_MS_PER_SECOND ms of the view's own time per second (review round 2, M-3), a second token
    // bucket charged with what the view's work took, measured. Characters are a proxy of the work and the time is the
    // work: within every character budget, re-rendering 37 449 empty elements without pause, or setting a 250 000-character
    // textarea value four times a second (WebKit), kept the host page's thread 80–95% busy, where the view shares it. A
    // time budget bounds the whole class, whatever makes an operation slow (elements, layout, a control's editor), on the
    // machine it runs on. The rate is a share of one thread: what is left is the host page's. Two measures are charged:
    //   - the flush itself: its operations and the layout they cause, timed. Layout is forced at the end of the flush
    //     (`layout`), so that it is in the measure: WebKit lays a 250 000-character textarea out in 1.3–1.7 s, and does
    //     so before the next frame's callbacks, where the gap meter cannot see it. It is forced by hit testing
    //     (elementFromPoint), which needs the whole document laid out in every engine; WebKit answers body.offsetHeight
    //     and getBoundingClientRect() without laying out content that cannot change the body's box, such as a
    //     textarea's text (measured: 0–1 ms against 1.6–2 s for elementFromPoint);
    //   - the rendering update that shows them (style and paint), measured by the gap meter below.
    // Whether a flush may run is checked when it is about to run, so a charge that arrived after it was scheduled still
    // holds it back. The debt is capped at one second of the view's time (VIEW_APPLY_MAX_DEBT_MS, repaid in 5 s): one
    // operation's own cost is not something a rate can bound (ADR-005), and an uncapped debt held every later operation
    // back five times as long as that one took, however the time was counted (C-2, below).
    //
    // The gap meter (review round 3, C-2 and M-5). The rendering update that shows a flush runs after the animation-frame
    // callbacks of the frame that follows it, and the first task after that frame's callbacks runs only once the update
    // is done: the time from the end of a callback to that task is the update, measured on the machine the view runs on,
    // and charged in full. A flush that ran inside a frame callback (the usual case: `schedule` runs it there) is
    // rendered by that very frame, so the measure starts as the flush ends; one that ran from the timer (frames
    // throttled) asks for the next frame, and the measure starts at the end of its callback. The task is a zero-delay
    // timer, posted from the frame (no clamping applies at that depth). At most one measurement is outstanding:
    // a flush while one is pending is measured by the next frame it asks for when it ends. Nothing runs while the view
    // does nothing: no frame is requested without a flush, and nothing runs per frame while guest animations play
    // (research 16 measured both). The meter never charges time in which no frame ran: a hidden or off-screen view runs
    // no frame in most engines, so its one pending request runs once the view shows again, and measures that frame.
    // Before, every flush queued a frame callback that charged the wall time from the flush to it, past one frame's
    // length: a view hidden for 5 s, with one render applied meanwhile, made the next render wait 18.3 s (C-2); and one
    // frame's length went uncharged per flush (M-5). Where the view shares the host page's renderer (an in-process
    // frame), the update measured is the whole frame's: the host page's own rendering in that frame is charged to the
    // view too, which only slows the guest.
    type Job = { kind: 'render' | 'text' | 'set'; target: string | null; html: string; fields: { value?: string; checked?: boolean; focus?: boolean } | null };
    let pending: Job[] = [];
    let scheduled = false;
    let tokens = options.renderRate;
    let time = options.applyTime; // ms of the view's time the budget holds now; never below -applyDebt
    let urlTokens = options.urlRate; // URL-bearing attributes the budget holds now (VIEW_URLS_PER_SECOND; review round 4, M-2)
    let refilled = performance.now();
    const refill = () => {
        const now = performance.now();
        tokens = Math.min(options.renderRate, tokens + ((now - refilled) / 1000) * options.renderRate);
        time = Math.min(options.applyTime, time + ((now - refilled) / 1000) * options.applyTime);
        urlTokens = Math.min(options.urlRate, urlTokens + ((now - refilled) / 1000) * options.urlRate);
        refilled = now;
    };
    const charge = (ms: number) => {
        refill();
        time = Math.max(-options.applyDebt, time - ms);
    };
    const IDLE = 0, FRAME = 1, GAP = 2;
    let meter = IDLE; // FRAME: a frame is requested for the measure; GAP: the measure's task is pending
    let meterFrame = 0;
    let unmeasured = false; // a flush happened whose rendering no measure has covered yet
    const startGap = () => {
        unmeasured = false;
        meter = GAP;
        const gapStart = performance.now();
        setTimeout(() => {
            charge(performance.now() - gapStart);
            meter = IDLE;
            if (unmeasured) measureRendering(false); // a flush ran after the measure started: the next frame renders it
        }, 0);
    };
    // After a flush: `inFrame` when it ran inside a frame callback, so this frame renders it.
    const measureRendering = (inFrame: boolean) => {
        unmeasured = true;
        if (meter === GAP) return;
        if (inFrame) {
            if (meter === FRAME) cancelAnimationFrame(meterFrame); // this frame renders the earlier flush too
            startGap();
            return;
        }
        if (meter === FRAME) return;
        meter = FRAME;
        meterFrame = requestAnimationFrame(startGap);
    };
    // Lays the view out now, so that what the operations cost there is in the flush's measure (above).
    const elementFromPoint = D.elementFromPoint; // every engine has it; jsdom does not, and lays nothing out anyway
    const layout = () => {
        if (elementFromPoint) call(elementFromPoint, document, [0, 0]);
    };
    const costOf = (jobs: Job[]) => {
        let cost = 0;
        for (let i = 0; i < jobs.length; i++) cost += jobs[i]!.kind === 'set' ? (jobs[i]!.fields!.value || '').length : jobs[i]!.html.length;
        return cost;
    };
    const flush = (inFrame: boolean) => {
        const jobs = pending;
        pending = [];
        scheduled = false;
        refill();
        tokens -= costOf(jobs);
        work = 0;
        const started = performance.now();
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
                if (message === 'VIEW_MAX_ELEMENTS' || message === 'VIEW_MAX_DEPTH' || message === 'VIEW_MAX_CHARACTERS' || message === 'VIEW_MAX_URLS' || message === 'VIEW_FOCUS') refused.push(message);
            }
        }
        tokens -= work; // what the operations serialized (C-4): the next flush waits until the budget covers it
        work = 0;
        urlTokens -= urlWork; // the URL-bearing attributes they kept (M-2), likewise
        urlWork = 0;
        layout();
        charge(performance.now() - started); // what the flush took (M-3), likewise
        measureRendering(inFrame); // and what showing it takes
        if (renderPort) renderPort.postMessage(refused.length > 0 ? { type: 'VIEW_ACK', refused } : { type: 'VIEW_ACK' });
    };
    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        let ran = false;
        let frame = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const run = (inFrame: boolean) => {
            if (ran) return;
            ran = true;
            if (inFrame && timer !== null) clearTimeout(timer);
            if (!inFrame) cancelAnimationFrame(frame);
            refill();
            if (time < 0 || urlTokens < 0) {
                // charged since this was scheduled (the rendering of the last flush): wait for the budget again
                scheduled = false;
                schedule();
                return;
            }
            flush(inFrame);
        };
        refill();
        const short = costOf(pending) - tokens; // what the budget lacks now, in characters
        const late = -time; // and in ms of the view's time
        const owed = -urlTokens; // and in URL-bearing attributes (M-2)
        const wait = Math.max(short > 0 ? Math.ceil((short / options.renderRate) * 1000) : 0, late > 0 ? Math.ceil((late / options.applyTime) * 1000) : 0,
            owed > 0 ? Math.ceil((owed / options.urlRate) * 1000) : 0);
        const start = () => {
            frame = requestAnimationFrame(() => run(true));
            timer = setTimeout(() => run(false), 100);
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
        // The Trusted Types probe (review round 2, C-6), before the check-in: where this document requires Trusted Types
        // (assigning a string to a sink throws a TypeError), the policy is created now, and a host page whose
        // trusted-types directive does not name it is told so, on this port, with the reason the element gives for it.
        // The host page may never have needed the policy itself (its own default policy took the element's strings, and
        // a default policy is the host page's object, not this document's), so only this side can find out. Before,
        // the refusal surfaced later as "the guest entry failed to start", after 'ready'.
        if (!trustedTypesReady()) {
            viewPort.postMessage({ type: 'TRUSTED_TYPES_REFUSED' });
            return;
        }
        // The check-in (review round 1, R3-1): the first frame on the view port, which only this bootstrap holds. The
        // host is 'ready' on it, never on the frame's load alone, which fires also when this script did not run.
        // It carries the view's size: a host page whose style-src refuses the wrapper's style leaves it 150 px high,
        // which only this side can see (frame-documents.ts, WRAPPER_STYLE); the host warns.
        // The view's switches (RenderSwitches), from the element's configuration: anything but a literal true is false,
        // the safe side of each. With animations off, the still stylesheet goes in first (stillStyleInForce); where the
        // host page's policy refused it, the guest's stylesheets go instead, and the check-in says so (the host warns).
        switches = { animations: data.allowAnimations === true, autoplay: data.allowAutoplay === true, stylesheets: true };
        viewOrigins = originsOf(data.origins);
        const stillRefused = !switches.animations && !stillStyleInForce();
        if (stillRefused) switches.stylesheets = false;
        viewPort.postMessage(stillRefused
            ? { type: 'VIEW_READY', width: g.innerWidth, height: g.innerHeight, stillStyleRefused: true }
            : { type: 'VIEW_READY', width: g.innerWidth, height: g.innerHeight });
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
        // The guest's error texts this document relays (review round 3, C-4): GUEST_ERROR, the entry's own error, and
        // GUEST_UNCAUGHT, a later one the worker could not describe itself (above). Both are the guest's words, and every
        // one of them leaves through here, bounded before it is posted, as the console relay bounds every other guest
        // line in the guest before posting it (in-sandbox-script.ts): cut to guestText.maxLength characters, and at most
        // guestText.perSecond in any one-second window (the host's window for guest lines), past which they are dropped
        // here. Before, the text crossed whole and the host cut it after receiving it: an error thrown with a message of
        // hundreds of millions of characters stalled the host page 0.6–1.4 s, and a worker throwing in a loop posted
        // without bound. Not through the worker's relay, the same chokepoint otherwise: the entry's error can mean the
        // worker never ran (it did not parse), and GUEST_UNCAUGHT exists for the errors the worker cannot describe.
        // The window keeps the times of the last `perSecond` texts in a ring: the oldest of them is at `textsHead`.
        // The first text dropped is said, once (review round 4, M-5): GUEST_TEXT_DROPPED, which the host turns into one
        // warn line, as the console relay says its own drops. WebKit raises every later uncaught error of the worker here
        // (its script's URL is revoked, above), so a guest that threw in a loop lost lines there without a word.
        const textTimes: number[] = [];
        let textsHead = 0;
        let textDropped = false;
        const toHostGuestText = (type: 'GUEST_ERROR' | 'GUEST_UNCAUGHT', text: string) => {
            const now = performance.now();
            const limit = options.guestText.perSecond;
            if (textTimes.length < limit) {
                textTimes.push(now);
            } else {
                if (textTimes[textsHead]! > now - 1000) { // `limit` texts left in the last second already
                    if (!textDropped) viewPort!.postMessage({ type: 'GUEST_TEXT_DROPPED' });
                    textDropped = true;
                    return;
                }
                textTimes[textsHead] = now;
                textsHead = (textsHead + 1) % limit;
            }
            viewPort!.postMessage({ type, message: text.slice(0, options.guestText.maxLength) });
        };

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
                const counted = first && first.type === 'VIEW_STARTED' ? first.entryErrors : undefined;
                if (typeof counted === 'number') entryErrors = counted;
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
            if (error && error.name === 'SecurityError') viewPort.postMessage({ type: 'WORKER_REFUSED' });
            else toHostGuestText('GUEST_ERROR', String((error && error.message) || error));
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
                probe((refused) => {
                    if (refused) viewPort!.postMessage({ type: 'WORKER_REFUSED' });
                    else toHostGuestText('GUEST_ERROR', 'the entry did not parse (this browser gives no detail)');
                });
                return;
            }
            const message = String(error.message || 'the worker failed');
            if (!started || index < entryErrors) {
                toHostGuestText('GUEST_ERROR', message);
                return;
            }
            error.preventDefault();
            toHostGuestText('GUEST_UNCAUGHT', message);
        };
        worker!.postMessage({ type: 'INIT_WORKER' }, [logicPort, channel.port2]);

        observeBody();
        const initial = data.html;
        if (typeof initial === 'string' && initial !== '') {
            work = 0;
            const started = performance.now();
            try {
                tokens -= initial.length; // the initial view is charged like any render (R1-1)
                apply(initial, null);
            } catch {
                // past the budget, or anything else the renderer refused: the initial view stays empty
            }
            tokens -= work;
            work = 0;
            urlTokens -= urlWork;
            urlWork = 0;
            layout();
            charge(performance.now() - started);
            measureRendering(false);
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
export function inStrictWorker(comms: { attach(port: MessagePort): void; log(level: 'log' | 'info' | 'warn' | 'error', args: unknown[]): void }, options: { scriptUnsafe: boolean; maxRender: number; maxTarget: number; maxElements: number; maxDepth: number; maxCharacters: number; maxUrls: number; entryDoneName: string; eventTypes: readonly string[] }) {
    // ---- The captured list (review C3; review round 2, C-1): sandboxView's methods, the render port's listener and the
    // error listener run after the entry, so everything they use is taken here, and nothing below reads a global or a
    // prototype guest code can replace (a unit test scans the text). The prelude's own lists have no prototype (review
    // C3): an index written to them never reaches an inherited setter, so guest code that defines one on Array.prototype
    // (or puts a Proxy in its chain) sees none of the render queue, the handlers or the subscribed types. They are only
    // ever read by index and length.
    const g = globalThis as any;
    const apply = Reflect.apply;
    const defineOwn = Reflect.defineProperty;
    const deleteOwn = Reflect.deleteProperty;
    const getOwn = Object.getOwnPropertyDescriptor;
    const setPrototype = Object.setPrototypeOf;
    const keysOf = Object.keys;
    const freeze = Object.freeze;
    const isArray = Array.isArray;
    const addListener = EventTarget.prototype.addEventListener;
    const dataOf = getOwn(MessageEvent.prototype, 'data')!.get!;
    const portsOf = getOwn(MessageEvent.prototype, 'ports')!.get!;
    const stopImmediate = Event.prototype.stopImmediatePropagation;
    const cancel = Event.prototype.preventDefault;
    const defaultPreventedOf = getOwn(Event.prototype, 'defaultPrevented')!.get!;
    const laterMicrotask = g.queueMicrotask;
    const post = MessagePort.prototype.postMessage;
    const startPort = MessagePort.prototype.start;
    const join = Array.prototype.join; // for error texts: a patched join would otherwise receive the prelude's own list as `this`
    const slice = String.prototype.slice;
    const startsWith = String.prototype.startsWith;
    const StringConstructor = String;
    const ErrorConstructor = Error;
    const TypeErrorConstructor = TypeError;
    const RangeErrorConstructor = RangeError;
    const reportErrorFound = g.reportError;
    const reportUncaught = typeof reportErrorFound === 'function' ? reportErrorFound : null;
    const urlStatics = g.URL;
    const webkitUrlStatics = g.webkitURL;
    // The prelude's own lines go through the comms script's relay (in-sandbox-script.ts), the one chokepoint every
    // guest line goes through, never through `console`, which guest code can replace.
    const log = comms.log;
    const attach = comms.attach;
    const CAPTURE_POINT = 'nothing below reads a global, or an intrinsic guest code can replace';

    const list = <T>(): T[] => setPrototype([], null);
    // "Uncaught …" once (review round 1, R4-7): Chromium's ErrorEvent message already starts with it.
    const uncaught = (text: string) => (apply(startsWith, text, ['Uncaught ']) ? text : 'Uncaught ' + text);

    // A name that stays after its deletion is a failure, not something to carry on with (review C2): a top-level
    // declaration of the entry could once make a global non-configurable before this ran.
    const remove = (owner: any, name: string) => {
        if (owner && name in owner) deleteOwn(owner, name);
        if (owner && name in owner) throw new ErrorConstructor('[Sandbox] the strict worker could not remove ' + name);
    };
    if (!options.scriptUnsafe) remove(g, 'WebAssembly');
    remove(urlStatics, 'createObjectURL');
    remove(webkitUrlStatics, 'createObjectURL');

    // ---- render flow control: sandboxView.render, text and set ----
    // One queue of operations for the view, one in flight at a time (A4): the next is posted only after the view's
    // VIEW_ACK. render and text replace an element's content, so they share one slot per target and the latest wins:
    // a queued one of the same slot is taken out, and the new one goes to the end (review round 2, C-9: replacing the
    // queued one in place moved it before what was queued after it, so [render A into x, set y, render B into x] applied
    // the set after B). A set is merged only into a set of the same id queued right before it. So the operations that
    // are applied keep the order they were made in.
    type Operation = { slot: string; kind: 'render' | 'text' | 'set'; message: Record<string, unknown> };
    let renderPort: MessagePort | null = null;
    let inFlight: Operation | null = null;
    const queue = list<Operation>();
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
            let kept = 0;
            for (let i = 0; i < queue.length; i++) if (queue[i]!.slot !== operation.slot) queue[kept++] = queue[i]!;
            queue.length = kept;
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
        if (typeof html !== 'string') throw new TypeErrorConstructor('sandboxView.render: html must be a string');
        if (html.length > options.maxRender) throw new RangeErrorConstructor('sandboxView.render: html is longer than ' + options.maxRender + ' characters');
        const target = into === undefined || into === null ? null : into;
        if (target !== null && !isId(target)) throw new TypeErrorConstructor('sandboxView.render: into must be an element id or null');
        enqueue({ slot: target === null ? 'content' : 'content#' + target, kind: 'render', message: { type: 'VIEW_RENDER', html, into: target } });
    };
    // The text of the element with that id, as one text node: the view assigns it, so nothing in it is parsed, and the
    // guest escapes nothing (review round 1, R4-5). Bounded like a render: VIEW_RENDER_MAX_LENGTH, and the view's
    // character budget and rate.
    const text = (id: unknown, value: unknown) => {
        if (!isId(id)) throw new TypeErrorConstructor('sandboxView.text: id must be an element id');
        if (typeof value !== 'string') throw new TypeErrorConstructor('sandboxView.text: text must be a string');
        if (value.length > options.maxRender) throw new RangeErrorConstructor('sandboxView.text: text is longer than ' + options.maxRender + ' characters');
        enqueue({ slot: 'content#' + id, kind: 'text', message: { type: 'VIEW_TEXT', into: id, text: value } });
    };
    // A form control's value or checked state, or focus (R4-5). Each own enumerable field of `fields` is read once,
    // and only these three are allowed, each of its one type; what is posted is a fresh object of those primitives.
    const set = (id: unknown, fields: unknown) => {
        if (!isId(id)) throw new TypeErrorConstructor('sandboxView.set: id must be an element id');
        if (fields === null || typeof fields !== 'object' || isArray(fields)) throw new TypeErrorConstructor('sandboxView.set: the second argument must be an object: { value?, checked?, focus? }');
        const message: Record<string, unknown> = setPrototype({ type: 'VIEW_SET', id }, null); // no inherited setter for a key (C3)
        let any = false;
        const keys = keysOf(fields);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i]!;
            const value = (fields as Record<string, unknown>)[key];
            if (key === 'value') {
                if (typeof value !== 'string') throw new TypeErrorConstructor('sandboxView.set: value must be a string');
                if (value.length > options.maxRender) throw new RangeErrorConstructor('sandboxView.set: value is longer than ' + options.maxRender + ' characters');
            } else if (key === 'checked' || key === 'focus') {
                if (typeof value !== 'boolean') throw new TypeErrorConstructor('sandboxView.set: ' + key + ' must be a boolean');
            } else {
                throw new TypeErrorConstructor('sandboxView.set: unknown key "' + apply(slice, StringConstructor(key), [0, 64]) + '"; the keys are value, checked and focus');
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
        if (!isEventType(type)) throw new TypeErrorConstructor('sandboxView.on: type must be one of ' + apply(join, options.eventTypes, [', ']));
        const target = id === undefined || id === null ? null : id;
        if (target !== null && (typeof target !== 'string' || target.length === 0 || target.length > options.maxTarget)) {
            throw new TypeErrorConstructor('sandboxView.on: id must be an element id or null');
        }
        if (typeof handler !== 'function') throw new TypeErrorConstructor('sandboxView.on: handler must be a function');
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
                if (reportUncaught) apply(reportUncaught, g, [error]);
                else log('error', [uncaught(StringConstructor(error))]);
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
                        : refused[i] === 'VIEW_MAX_URLS'
                            ? 'the view would hold more than ' + options.maxUrls + ' URLs (src, srcset, poster, href)'
                            : 'the view would hold more than ' + options.maxElements + ' elements';
                log('warn', ['[Sandbox] sandboxView.' + kind + ': the view refused ' + (kind === 'render' ? 'a render' : 'it') + ': ' + why + '; nothing of it was applied.']);
            }
            inFlight = null;
            sendNext();
            return;
        }
        if (data.type === 'VIEW_EVENT') dispatch(data.detail);
    };
    defineOwn(g, 'sandboxView', { value: freeze({ render, text, set, on }), writable: true, enumerable: true, configurable: true });

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
        attach(ports[0]);
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
        log('error', [uncaught(StringConstructor(event.message))]);
    }, true]);
    defineOwn(g, options.entryDoneName, { value: () => { entryRan = true; } });
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
    applyTime: VIEW_APPLY_MS_PER_SECOND,
    applyDebt: VIEW_APPLY_MAX_DEBT_MS,
    urlRate: VIEW_URLS_PER_SECOND,
    violationLimit: 100, // VIOLATION_EVENT_LIMIT (violation.ts); a test keeps them equal
    events: { types: VIEW_EVENT_TYPES, ...VIEW_EVENT_LIMITS },
    trustedTypesPolicy: TRUSTED_TYPES_POLICY,
    writeTypes: VIEW_WRITE_TYPES,
    // the host cuts these texts to the same length again on receipt (host.ts), and dispatches at most
    // LOG_EVENTS_PER_SECOND guest lines in any one second
    guestText: { maxLength: 2048, perSecond: LOG_EVENTS_PER_SECOND },
    stillStyle: VIEW_STILL_STYLE,
};

let cachedText: string | null = null;
let cachedHash: string | null = null;

/**
 * The view bootstrap as one string literal, in the published bundle (review round 2, C-8): scripts/build-lib.ts builds
 * the text below once, from the sources, and bundles it in as this constant. The text that is hashed is then a value of
 * the package, not the text of its functions as wherever the bundle runs prints them: a consumer's bundler or minifier
 * rewrites functions and leaves a string's value alone, so the hash an embedder computes in a build step (Node or Bun,
 * importing the package) is the one the browser computes for the script the element injects. When it was the functions'
 * Function.prototype.toString(), the same source gave one hash plain and another minified, and a host page that listed
 * the build-time hash ended with "the sandbox's startup script did not run". Undefined where the sources run unbundled
 * (the dev server, the unit tests): there the text is built from the functions, as it always matches the page serving it.
 */
declare const __WEB_SANDBOX_VIEW_BOOTSTRAP__: string | undefined;

/**
 * The view bootstrap's text: constant for this page, built once. Throws if it could not be hashed as written (A3): a CR
 * or NUL, or anything that ends a script element.
 */
export function viewBootstrapText(): string {
    if (cachedText !== null) return cachedText;
    const text = typeof __WEB_SANDBOX_VIEW_BOOTSTRAP__ === 'string'
        ? __WEB_SANDBOX_VIEW_BOOTSTRAP__
        : `(${inSandboxView.toString()})(${inSandboxFiles.toString()}, ${sanitizeRender.toString()}, ${JSON.stringify(VIEW_OPTIONS).replaceAll('<', '\\u003c')});`;
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
 * The strict view bootstrap's CSP hash source, `'sha256-…'`, for this release of the package (review round 1, R4-5): the
 * very value the element puts in the view's script-src, so an embedder can allow it in the host page's own
 * Content-Security-Policy, which the view inherits (docs/API.md, "Host page policy"). The bootstrap is a string literal
 * of the bundle (above), so the hash is the same in a build step (importing the package needs no DOM) and in the browser,
 * however the embedder's app is bundled or minified; it changes only with the package's own version.
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
