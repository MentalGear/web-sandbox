import { inSandboxFiles } from './in-sandbox-files';
import { BRIDGE_FRAME_OPTIONS, inBridgeFrame } from './in-bridge-frame';
import { checkSandboxEnvironment, ENVIRONMENT_EXPECTED } from './environment-check';
import { assertHashableScript, scriptHashSource } from './csp/script-hash';
import { escapeAttribute } from './frame-documents';
import { REFERENCES, VIRTUAL_DOCUMENT_URL, VIRTUAL_ROOT } from './markup-references';
import { admits, LINK_REL_KINDS, LOAD_KINDS, type KindRule } from './load-kinds';
import { TRUSTED_TYPES_POLICY } from './trusted-types';
import { LOG_EVENTS_PER_SECOND } from './sandbox-log';
import { UNCAUGHT_CHARACTERS_PER_SECOND } from './egress';
import { KIND_DIRECTIVES } from './csp/csp-generator';
import { VIOLATION_DIRECTIVES } from './violation';
import { cssReferences, withoutNetworkReferences } from './css-references';

/**
 * Strict mode's view and worker prelude (ADR-005).
 *
 * Guest logic runs only in a worker, and the DOM frame — the "view" — runs exactly one script, the library's own
 * bootstrap, admitted by its SHA-256 hash.
 *
 *   host page
 *   └─ wrapper  (unchanged: frame-src 'none', inert base, no-referrer; frame-documents.ts)
 *      └─ view  srcdoc = CSP <meta> + referrer <meta> + ONE <script> (this file's bootstrap), no guest bytes
 *         └─ worker  new Worker(blob:) spawned by the view: the guest's logic, the bridge, sandboxView
 *
 * Three ports, all MessageChannels created per environment: logic (host ↔ worker, as in worker mode), view (host ↔
 * view) and render (view ↔ worker; the host is not on this path). The frames each carries, with their fields and
 * bounds, are the frame table's (src/lib/frames.ts, FRAMES).
 * The render port is created by the view and handed to the library's worker prelude, which keeps it in a
 * closure and only ever uses primitives it captured before any guest code ran (A4): guest code cannot post
 * on it, so it cannot get past the flow control below.
 *
 * Three self-contained functions here are stringified (same rules as in-sandbox-script.ts: no module
 * scope, no async/await): inSandboxView (the view's bootstrap), sanitizeRender (the renderer it calls) and
 * inStrictWorker (the worker's prelude); the view also runs css-references.ts's cssReferences and
 * withoutNetworkReferences. The rest is host-only.
 */

/**
 * The most characters (UTF-16 code units, 256 Ki) one strict-mode view operation may carry: the `html` of
 * `sandboxView.render()`, the string of `text()` and the value of `set()`. A longer one makes the call throw a
 * `RangeError` in the guest.
 */
export const VIEW_RENDER_MAX_LENGTH = 262144;

/** The longest element id a render may target. */
export const VIEW_TARGET_MAX_LENGTH = 1024;

/**
 * The most elements the view's body may hold, and how deep they may nest below it (BR:ST2).
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
 * (R1:R1-1): the length of the body's serialization, so text, comments, attributes and markup alike. Text would
 * otherwise escape every other budget: renders of 261 Ki characters of text into 200 targets every 20 ms keep the host
 * page busy 95–100% on all three engines, and the document grows without bound (50 000 targets × 256 Ki characters).
 * A render past it is refused before anything is inserted, and acknowledged, like one past VIEW_MAX_ELEMENTS.
 */
export const VIEW_MAX_CHARACTERS = 4 * VIEW_RENDER_MAX_LENGTH;

/**
 * The most characters of markup the view parses per second, renders refused included (R1:R1-1): flow
 * control alone (one render in flight) lets a worker keep the host busy with renders that each fit every budget. A
 * render past it waits until the budget has refilled, and the worker's next render waits for that one's VIEW_ACK, so
 * nothing is dropped: renders are slowed to this rate. At least VIEW_RENDER_MAX_LENGTH, so every render is applied.
 */
export const VIEW_RENDER_CHARACTERS_PER_SECOND = 4 * VIEW_RENDER_MAX_LENGTH;

/**
 * The most milliseconds of its own time the view spends applying operations per second, their layout and rendering
 * included (R2:M-3): a fifth of one thread, which it shares with the host page in WebKit and Firefox (and in
 * Chromium depending on its process model). An operation past it waits, like one past VIEW_RENDER_CHARACTERS_PER_SECOND;
 * nothing is dropped. Every operation is charged all it took, measured, however long (R5:M-2), so the
 * budget bounds the view's long-run share of the thread at this rate: one that took 1.5 s holds the next one back for
 * 1.5 s × 1000 / VIEW_APPLY_MS_PER_SECOND (7.5 s), less what the budget held. See the view's flush (inSandboxView) for
 * why time, and not only characters, is budgeted, and VIEW_MAX_OPERATION_MS for what bounds one operation. The bound these
 * budgets make up, and what is outside it, is stated once: docs/API.md, "The view's cost to the host page" (backlog S68).
 */
export const VIEW_APPLY_MS_PER_SECOND = 200;

/**
 * The most milliseconds one operation of the view may take before it counts as an overrun: a flush and the rendering
 * update that shows it, measured as the time budget measures them (R5:M-2). An overrun is charged in full,
 * like every operation, and the view goes on; the second overrun within VIEW_OVERRUN_WINDOW_MS ends the sandbox ("the
 * view spent more than 2000 ms on one operation twice within 5 minutes"; viewBudget decides). No rate can bound one
 * operation's own cost (ADR-005), and a time budget that charged only part of it would let an operation of 7.5 s
 * (Chromium's layout of 30 000 restyled elements) run again every few seconds, 53% of the thread, while a budget that charges all of
 * it holds the view back five times as long as the operation took. So the budget charges all of it, and this bounds how
 * often it may charge that much. Two seconds: an order of magnitude above what the view's budgets admit per render on
 * every engine measured (a render of VIEW_MAX_ELEMENTS elements takes 0.2–0.3 s). Time in which no frame ran (a hidden or
 * off-screen view) is never part of it (inSandboxView, the gap meter).
 */
export const VIEW_MAX_OPERATION_MS = 2000;

/**
 * The window of the repeated-overrun rule (S72, the owner's decision; class P, a budget that counts
 * a proxy): an overrun (an operation past VIEW_MAX_OPERATION_MS) ends the sandbox only when another overrun came at most
 * this long before it; the window runs from the first of the two. Not a public name (src/index.ts does not export it).
 *
 * Why not the first overrun. The meter measures wall time on a thread the view shares with the host page, the machine's
 * other processes, and the host page's own tasks (the gap meter, inSandboxView): a stand-in for the view's own cost, which
 * the meter cannot see apart from what else ran. Under load the stand-in passes the limit for operations that are
 * healthy: a large initial view on a loaded CI runner can pass it (S72), and WebKit's first set() of a
 * 250 000-character textarea always takes more than 2 s. One overrun says little
 * about the guest; two within minutes, each after a debt of at least 9 s repaid, say that its operations are that slow.
 * What it costs the host page: at most one stall past 2 s per window beyond the first, each still bounded only by the
 * caps on what the document holds, and the long-run share (VIEW_APPLY_MS_PER_SECOND) is unchanged, since every overrun is
 * charged in full. Five minutes: long against the 9–10 s of debt an overrun leaves (so a guest whose operations are all
 * slow meets the second within seconds of repaying), short against a session (so a load spike now and another one an
 * hour later are two first overruns, not a second).
 */
export const VIEW_OVERRUN_WINDOW_MS = 300000;

/**
 * The most URL-bearing attributes the view's body may hold (R4:M-2): RENDER_URL_ATTRIBUTES on the elements
 * the renderer keeps, after it has dropped every URL the view's policy would refuse. Counted like VIEW_MAX_ELEMENTS, over the
 * document a render would leave; a render past it is refused before anything is inserted, and acknowledged.
 *
 * Why URLs have a budget of their own. What the browser does with a URL after the render (fetching, decoding, laying the
 * image out, and for a refused one its violation processing) runs on the host page's thread wherever the view does, and
 * outside the view's time budget, which charges only what the view itself does: 6500 <img> per render, re-rendered as
 * fast as the view acknowledged, kept the host page 21–45% busy for a refused source (Chromium 31%, Firefox 45%, WebKit
 * 21%, against 19%, 14% and 10% without a source), and the reviewers measured up to 67% for an admitted origin (WebKit
 * stalled 7.5 s on one render). The renderer drops refused URLs, so the browser does nothing with them. For the
 * ones it keeps, measured from a loopback server: one render of 4000 new images cost the host page about 1 ms each
 * (Chromium 52%, Firefox 46% busy over the 8 s after it). So the cap bounds what one render can make the browser do (about
 * a second of the host page's thread), and VIEW_URLS_PER_SECOND bounds the long-run share at about the view's 20%: renders
 * of 1000 new images, as fast as the view acknowledged them, kept the host page 14% (Chromium), 19% (Firefox) and 5%
 * (WebKit, which upgrades the loopback's http: and fails it) busy, and 12%, 9% and 8% served by the test itself
 * (the R4:M-2 e2e test; research 16's note).
 */
export const VIEW_MAX_URLS = 1000;

/**
 * The most loads the view's document makes per second, refused ones included (R4:M-2, R5:M-3, S73: class P, a budget
 * that counts a proxy, and E-net). Every load is charged before the browser can start it: every
 * URL-bearing attribute a render keeps (a cached, relative or failing one too: what it costs the browser is not known
 * then), and an upper bound of what the CSS an operation applies can load (cssLoadBound: its url(), image-set(),
 * image(), cross-fade() and src() tokens, and a second's worth per @import and stylesheet link), both when the operation
 * is applied. The CSS's share is prepaid credit: every load the platform reports that no render's URL attribute charged
 * (the document's resource timing: a CSS background, a font, an @import, whatever named it; and every violation of its
 * policy the view observes) takes from the credit first, and is charged when none is left; the credit holds at most a
 * second's worth (viewBudget). So the charge does not depend on the renderer's model of what loads: CSS-borne loads,
 * which the renderer never parses, would let Firefox issue 1400 requests per second (7 times this budget). An
 * operation past it is applied, and the next one waits until the budget has refilled, like
 * VIEW_RENDER_CHARACTERS_PER_SECOND, however far past it the charges took it. See VIEW_MAX_URLS.
 *
 * The bound (R this rate, t seconds): the loads the view's document starts over any t seconds number at most
 *   R·t + R + P + R + S
 *   - R·t + R + P: what the operations applied in the interval can load. An operation is applied only while the load
 *     budget is not in debt (viewBudget's `owes`); the budget holds at most R, refills at R per second, and every
 *     charge takes from it. So the charges made before the last operation of the interval total at most R·t + R, and
 *     that last one adds its own, P: at most VIEW_MAX_URLS URL attributes and its CSS's count. Each operation is charged
 *     at least what it can load, and before the browser can start any of it (the browser starts a CSS load when it
 *     styles what was inserted, in the rendering update after the flush, and the flush has charged it by then). An
 *     operation applied just before the interval whose loads start in it is in this too: what it was charged is what
 *     the budget lacks at the interval's start;
 *   - R: the credit carried into the interval, which loads reported in it take before they are charged;
 *   - S: what CSS already in the view loads past what was prepaid for it: a rule that matches only later (elements a
 *     later render inserts, a media query, a state such as :hover), an image-set() that picks another image when the
 *     resolution changes, a linked or imported sheet past its allowance. Each such load is charged when it is
 *     reported, as before, so it is bounded only by that CSS's text: VIEW_MAX_CHARACTERS for the view's own, the
 *     registered files, an admitted origin's sheets.
 * The prepayment is what holds behind a slow server (R5:M-3, S73): a CSS-borne load charged only when its response had
 * ended would let every render the view applied before the first charge arrived get through, so the first burst would
 * grow with the server's latency times the render rate. A load the browser defers past that rendering update (an image
 * with loading=lazy until it is scrolled to, media until it plays) is charged when it is rendered, and starts later: at
 * most what the body holds of them (VIEW_MAX_URLS).
 */
export const VIEW_URLS_PER_SECOND = 200;

/**
 * The most distinct URLs one view may load, over its whole life (R5:M-4: class P, a per-second rate standing
 * in for a cumulative cost). Each distinct URL a document loads stays in the engine's caches while the document lives,
 * and the URL budget bounds only the rate: renders of 1000 new images, as fast as VIEW_URLS_PER_SECOND let them, made
 * WebKit's host page stall for longer and longer as the count grew (measured: 1.2 s near 8 000, 2.4 s near 18 000,
 * 3.5 s near 33 000, 8.8 s near 43 000; the reviewers 13–28 s after about two minutes). So a view loads at most this
 * many: about where the stalls begin, and well below where they pass a second or two. Counted, and refused past it, in
 * inSandboxView (`newLoads`); `reset()` starts a new view.
 */
export const VIEW_MAX_DISTINCT_URLS = 10000;

/**
 * The pseudo-elements the view's still stylesheet may stop animations and transitions on, besides the elements themselves
 * (VIEW_STILL_STYLE; R4:C-7, R5:M-1): every pseudo-element a guest's stylesheet can give an
 * `animation` or a `transition` on the elements the renderer keeps, standard and engine-prefixed (the parts of form
 * controls and media controls the engines style with pseudo-elements). `*` reaches no pseudo-element, so each is named.
 * The view gives a name a rule of its own only where the engine supports it, and only once guest CSS it applies names
 * it (inSandboxView, `stillNamed`): every rule costs style work for every element of the view. A pseudo-element an
 * engine ships later is outside this list until it is added; the inline-style half of the switch does not depend on it.
 * Left out, as no animation applies to them (R5:M-1):
 *   - ::first-letter and ::first-line: only typographic properties apply; with their rules, replacing 37 449 elements
 *     took Firefox 22–30 s instead of 0.1–0.5 s, on the host page's thread;
 *   - the highlight pseudo-elements (::selection, ::target-text, ::spelling-error, ::grammar-error, ::search-text,
 *     ::-moz-selection): only colours, text decorations and shadows apply (css-pseudo-4);
 *   - ::column (only scroll snapping applies), ::-webkit-scrollbar and its parts, and ::-webkit-resizer: an infinite
 *     animation on them changed no pixel in Chromium or WebKit (measured), and each of their rules made a replacement
 *     2–3 times as expensive in Chromium.
 */
export const VIEW_STILL_PSEUDO_ELEMENTS = [
    // standard
    'before', 'after', 'marker', 'placeholder', 'backdrop', 'file-selector-button',
    'cue', 'details-content', 'checkmark', 'picker-icon',
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
    // Firefox
    '-moz-range-track', '-moz-range-thumb', '-moz-range-progress', '-moz-progress-bar', '-moz-meter-bar', '-moz-color-swatch',
    '-moz-focus-inner', '-moz-list-bullet', '-moz-list-number', '-moz-placeholder',
] as const;

/** What the still stylesheet sets, on every element and on each pseudo-element the view gives a rule (VIEW_STILL_STYLE). */
export const VIEW_STILL_DECLARATIONS = 'animation:none!important;transition:none!important';

/**
 * The view's stylesheet for `allowAnimations: false` (research 16): no animation and no transition on any element of the
 * view, and, by the rules the view adds to its layer at its start, on any pseudo-element of VIEW_STILL_PSEUDO_ELEMENTS
 * the engine supports. Elements show their end state.
 *
 * Why it holds against anything a guest's stylesheet says (checked on Chromium, Firefox and WebKit against unlayered
 * `!important`, the guest's own anonymous and named layers, `::before`, `@starting-style`, hover transitions and
 * scroll-driven animation (`animation-timeline`)):
 *   - an `!important` declaration in a cascade layer beats every `!important` in a later layer and every unlayered one
 *     (css-cascade-5), so the layer must be the first one: the view inserts this sheet as its head's first element before
 *     anything is rendered (renders reach only the body, so every guest sheet, and every sheet it `@import`s, comes after
 *     it, and so does every layer they declare);
 *   - the layer is ANONYMOUS, so no guest rule can be appended to it (a named layer can be reopened by name); the view's
 *     own rules for pseudo-elements go into it through the CSSOM (insertRule on the layer's rule), which no style-src
 *     governs, before anything is rendered;
 *   - an inline `!important` (a `style` attribute) beats any layer: the renderer takes every `animation*` and
 *     `transition*` declaration out of every kept `style` attribute (sanitizeRender, `animations: false`).
 * Its text is constant, whatever the engine supports, so its CSP hash is a constant of the library
 * (docs/API.md#host-page-policy): a host page whose style-src refuses inline styles must list it, or the view drops the
 * guest's stylesheets instead (inSandboxView).
 */
export const VIEW_STILL_STYLE = `@layer{*{${VIEW_STILL_DECLARATIONS}}}`;

/**
 * The properties `allowAnimations: false` takes out of style attributes (R4:C-2): the animation and
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
 * strings together (BR:ST3: each bound alone would let 1000 fields of 64 Ki characters through). A detail cut by any of
 * them says so: `truncated: true`.
 */
export const VIEW_EVENT_LIMITS = { maxString: 65536, maxIds: 32, maxFields: 1000, maxTotal: VIEW_RENDER_MAX_LENGTH } as const;

/** The prefix of the worker's one-time "the entry ran to its end" marker; each build appends 128 random bits (entryDoneName). */
export const ENTRY_DONE_PREFIX = '__sandboxEntryRan_';

/**
 * The marker's name for one build (BR:ST4). The line after the entry calls it; the prelude defines it on the
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
 * The only file types the view mints a URL for (BR:ST1). A user can open whatever a rendered element
 * shows in a new tab ("open image in new tab", "open video in new tab"): a browser-initiated navigation the view
 * cannot cancel, to a top-level document outside the sandbox and its policy. A registered SVG shown as an image
 * opens there as an SVG document and runs its script (Chromium, Firefox), and so would any type an engine renders as
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
 * The only types the view mints a URL for from a guest write (R1:R4-4, the owner's decision): the files
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
 * The renderer is an allowlist: an element or attribute it does not list is gone before
 * insertion. A list of what to remove would have to know every mechanism a document has (SMIL's animate attributes,
 * FR:F1, and SVG <use>, BR:ST2, came from what such a list left open); this one has to know only what a guest's UI needs.
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
 *           (use, marker, image, feImage, foreignObject), animate attributes (FR:F1), or cost what their parameters say
 *           rather than what the markup weighs (filter primitives: one feMorphology of 150 characters stalled WebKit's
 *           host thread for 6 s, measured). use and marker instance referenced content per reference and nest: 1–1.5 KB
 *           of either stalls the host page for 3–17 s on all three engines (BR:ST2).
 *   MathML  the MathML Core presentation elements; others are removed with their content (annotation-xml can hold
 *           HTML).
 *
 * Not listed for what their layout costs (R1:R1-2; costs taken from render to layout, one render within every
 * budget): wbr, whose line breaking Firefox does in super-linear time (43 000 in one paragraph stall its host page
 * 23 s), and ruby with rt and rp (10 000 rubies: WebKit 10.7 s, Chromium 1.4 s). They are unwrapped, so their text
 * stays. Every other listed element is linear (br, span, bdi, bdo, nested inline formatting 200 deep, tables of
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
 * The elements the renderer gives `crossorigin="anonymous"`, every one it keeps, whatever the guest wrote there (S74,
 * BD2:ISO-2, docs/research/21_crossorigin_loads/README.md; class A, a browser choice taken by construction): the engine attaches no cookie of any SameSite kind,
 * no HTTP authentication and no client certificate to a load in CORS `anonymous` mode, on every engine and to every
 * target, where a `no-cors` load would carry the listed origin's own cookies (Firefox, WebKit) and the host site's
 * (WebKit). Each is the element whose own attribute governs what loads for it: an `<img>` its `src`, its `srcset` and
 * the `srcset` of its `<picture>`'s `<source>` elements; a `<video>` or `<audio>` its `src`, its `<source>` and `<track>`
 * children (which have no such attribute: theirs would be ignored); a `<link>` its `href` (a URL the view minted only,
 * where the attribute changes nothing). The renderer sets it in the inert template, before the element is first
 * connected: set on an element in the document after its URL, the engine would already have started a `no-cors` load.
 * A load from a listed origin is a CORS request, so the origin must answer with `Access-Control-Allow-Origin` (`*`,
 * or `null`: the view's origin is opaque); without it the load fails, and the view reports it (inSandboxView).
 */
export const RENDER_CROSSORIGIN_ELEMENTS = ['img', 'video', 'audio', 'link'] as const;

/**
 * The [element, attribute] pairs of RENDER_URL_ATTRIBUTES whose http(s) URL the renderer drops, reported like a URL the
 * policy refuses: no attribute takes away the credentials of their load on every engine. Firefox loads a `<video>`'s
 * `poster` in `no-cors` mode whatever the video's crossorigin says. A poster that names a registered file (a URL the view
 * minted) stays. The loads CSS makes take no attribute at all, so the renderer drops every network URL in CSS too (a
 * `style` attribute, a `<style>`: withoutNetworkReferences, css-references.ts).
 */
export const RENDER_NETWORK_DROPPED = [['video', 'poster']] as const;

/**
 * The value of every hyperlink href in the strict view (S24, option B): the guest's URL is discarded before
 * insertion, so a user's own browser actions on a rendered link ("copy link address", "open in new tab", hover,
 * dragging it) can carry nothing of the guest's. The view already cancels clicks, auxclicks and Enter (G4), and the
 * worker never had the URL (events carry ids), so routing is unchanged.
 *
 * Why 'about:blank#', checked on Chromium, Firefox and WebKit against '#', '' , 'about:blank', 'about:invalid',
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
    /** The HTML elements that always get crossorigin="anonymous" (RENDER_CROSSORIGIN_ELEMENTS). */
    crossOrigin: readonly string[];
    /** The pairs of `urls` that keep no http(s) URL (RENDER_NETWORK_DROPPED). */
    networkDropped: readonly (readonly [string, string])[];
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
 * What one render's renderer is given besides the rules and the switches, and what it reports back (R4:C-2, R4:M-2).
 * The view makes one per render (inSandboxView).
 */
export interface RenderContext {
    /** The local name of the element the fragment goes into: the parent of its top-level nodes (a <source>'s loader). */
    target: string;
    /** The engine's animation and transition longhands (RenderRules.still), found once per view. */
    animating: readonly string[];
    /**
     * The origins the view's policy admits for each kind of load, by key (`origins`): an http(s) URL outside them is
     * refused. Its `withoutCors` list (`origins.withoutCors`) names the origins the view loads without CORS.
     */
    origins: Readonly<Record<string, readonly string[]>>;
    /**
     * Whether the element the fragment goes into has crossorigin="anonymous": what a top-level <source> or <track> loads
     * through. Unknown (absent) counts as without it.
     */
    targetAnonymous?: boolean;
    /** Filled by the renderer: each URL it dropped because the policy refuses it, with the directive that would. */
    refused: [directive: string, url: string][];
    /** Counted by the renderer: the URL-bearing attributes it kept. */
    urls: number;
    /** Filled by the renderer: each http(s) URL it kept for a load, parsed, without its fragment (VIEW_MAX_DISTINCT_URLS). */
    loads: string[];
    /**
     * Filled by the renderer when given: the text of every style attribute it kept, as written, before the still rules
     * took anything out of it (backlog S73: what it can load, counted by cssLoadBound, is at least what is left can).
     */
    css?: string[];
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
    crossOrigin: RENDER_CROSSORIGIN_ELEMENTS,
    networkDropped: RENDER_NETWORK_DROPPED,
    // derived, not copied: the table markup-references.ts resolves in cooperative mode. Scripts never survive
    // the renderer, so <script src> names nothing here.
    references: REFERENCES.filter(([element]) => element !== 'script'),
    // the view's kinds, derived from the one table (load-kinds.ts; FR:W1, BR:ST1)
    kinds: VIEW_LOAD_KINDS,
    // derived from load-kinds.ts's LINK_REL_KINDS (BR:I1): a kept <link> has only these rel tokens
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
 * The renderer (A1, A8; an allowlist, see RENDER_ELEMENTS), run by the view on a freshly parsed template fragment
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
 *   5. a <style> (HTML or SVG) keeps its child text only, without its network URLs (`dropNetworkCss`, below);
 *   6. every href that makes a hyperlink becomes rules.inertHref (S24): HTML <a> and <area>, SVG <a> (href and
 *      xlink:href) and any MathML element;
 *   7. every attribute outside rules.attributes goes; so does any attribute whose value contains "blob:" (after
 *      removing the tabs and newlines the URL parser ignores) unless it is a file-reference attribute holding exactly
 *      a URL the view minted (A8), a URL attribute (rules.urls) whose URL is not http(s), minted or relative, or is an
 *      http(s) URL the view's policy refuses for the load the element makes (context.origins; R4:M-2), or is any
 *      http(s) URL where rules.networkDropped says so (a poster), and an SVG paint or clip reference that is not a
 *      fragment; a style attribute loses its network URLs (`dropNetworkCss`); referrerpolicy becomes no-referrer, and
 *      is set on rules.referrerElements; rel on <a>/<area> keeps only rules.anchorRelations (A1);
 *   8. every kept element of rules.crossOrigin gets crossorigin="anonymous", the guest's own value replaced (S74), so
 *      that it is never connected without it: none of its loads carries credentials (RENDER_CROSSORIGIN_ELEMENTS);
 *   9. per `switches` (RenderSwitches): autoplay goes; a style attribute loses its animations and transitions; <style>
 *      and stylesheet links go.
 * `dropNetworkCss` is withoutNetworkReferences (css-references.ts) over cssReferences: the CSS without a network URL,
 * each one it dropped added to the list it is given, with its kind of load.
 * The URL attributes it keeps are counted (context.urls) against `room.urls`, what is left of VIEW_MAX_URLS: past it it
 * throws, like the element budget, a RangeError 'VIEW_MAX_URLS'. Each URL it dropped as refused, or as a network URL
 * of a poster or of CSS, is reported (context.refused) with the directive of its load, for the view to report as the
 * browser would report a refusal.
 * Text is kept, each run of adjacent text joined into one node; comments and processing instructions are dropped. The
 * walk is linear in the fragment's size on every engine (R1:R1-2; see the walk below).
 * Kept elements are counted against `room` (what is left of VIEW_MAX_ELEMENTS and VIEW_MAX_DEPTH once the elements
 * outside the target and the target's own depth are accounted for): past either it throws, before anything was
 * inserted, a RangeError whose message names the limit (VIEW_MAX_ELEMENTS or VIEW_MAX_DEPTH). Returns the number of
 * elements kept.
 *
 * Every node is read and changed through the prototypes' own methods and getters, never through the node: a <form>
 * exposes its controls as named properties that override built-ins, so in `<form><input name="getAttribute">` the
 * form's getAttribute is the input. Should anything still throw, the caller inserts nothing (fail closed).
 */
export function sanitizeRender(fragment: DocumentFragment, fileOf: (path: string) => { url: string; type: string } | null, isMinted: (url: string) => boolean, dropNetworkCss: (css: string, dropped: [kind: string, url: string][], keep: readonly string[]) => string, rules: RenderRules, switches: RenderSwitches, room?: { elements: number; depth: number; urls?: number }, given?: RenderContext): number {
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
    const context: RenderContext = given || { target: 'body', animating: rules.still.known, origins: {}, refused: [], urls: 0, loads: [] };
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
    // Whether every engine's policy check admits an http(s) URL for a load of `kind` (R4:M-2, R5:N-3:
    // class B, a browser decision re-derived). This is a prediction of the browser's CSP source matching, and it is
    // one-sided by construction: it keeps a URL only where every engine is known to admit it, and drops everything else,
    // so where it is wrong it drops a URL some engine would have loaded (a functional loss: write URLs in the exact form
    // you list), never keeps one the browser then refuses. Nothing is bounded by it either: what the browser refuses is
    // charged where the view observes it (inSandboxView, the URL budget). A URL is kept when:
    //   - its scheme, host and port, read by the URL parser, are exactly those of an origin the policy lists for that
    //     kind (context.origins, the parsed `origins`, canonical as origin.ts makes them).
    // The policy carries no upgrade-insecure-requests, so an http: URL of a listed https: origin is refused by every engine
    // and is not kept. The forms CSP itself would also match are not relied on: an http: source matching an https: URL
    // fails for a loopback host in Chromium. Anything dropped is reported by the view, as a violation of the kind's directive.
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
    // A URL as every engine reports a refused one: without credentials or fragment.
    const reported = (url: URL): string => {
        url.username = '';
        url.password = '';
        url.hash = '';
        return url.href;
    };
    // The URL a refusal names (reported), or null when the policy admits it (or it does not parse).
    const refusedUrl = (value: string, kind: string): string | null => {
        let url: URL;
        try {
            url = new URL(value);
        } catch {
            return null;
        }
        const exact = url.protocol + '//' + url.hostname + (url.port ? ':' + url.port : '');
        const origins = admittedOrigins(kind);
        for (let i = 0; i < origins.length; i++) {
            if (origins[i] === exact) return null;
        }
        return reported(url);
    };
    // A network URL dropped whatever the policy says (RENDER_NETWORK_DROPPED, CSS): reported, or as written where it does
    // not parse (it would have loaded nothing, but it is still what the guest named).
    const droppedUrl = (value: string): string => {
        try {
            return reported(new URL(value));
        } catch {
            return value;
        }
    };
    // `origins.withoutCors`: the origins the view loads the classic way, without CORS (and, on some engines, with that
    // origin's own cookies: the embedder's choice, per origin). A URL of one is kept where a network URL would otherwise go
    // (a poster, CSS), and an element whose loads are all of such origins gets no crossorigin attribute.
    const corsFreeOrigins: readonly string[] = call(own, context.origins, ['withoutCors']) ? context.origins.withoutCors! : [];
    const corsFree = (value: string): boolean => {
        if (corsFreeOrigins.length === 0) return false;
        try {
            const url = new URL(value);
            return corsFreeOrigins.indexOf(url.protocol + '//' + url.hostname + (url.port ? ':' + url.port : '')) >= 0;
        } catch {
            return false;
        }
    };
    // What a kept http(s) URL loads, for the count of distinct loads: the parsed URL without its fragment.
    const loadOf = (value: string): string | null => {
        try {
            const url = new URL(value);
            url.hash = '';
            return url.href;
        } catch {
            return null;
        }
    };
    // A URL the view would load: http(s), one it minted, or relative (against the view's about:blank base it resolves
    // to nothing). The scheme is read the way the URL parser reads it: outer C0 controls and spaces stripped, tabs and
    // newlines removed. Any other scheme is dropped, and nothing is reported: no engine would have made a request for it.
    // An http(s) URL the policy refuses for a load of `kind` ('' for none) is added to `refused`, and is not allowed;
    // one it admits is added to `loads`. With `corsFreeOnly` (RENDER_NETWORK_DROPPED, or a <source> or <track> whose
    // loader has no crossorigin) an http(s) URL is allowed only of an origin in `origins.withoutCors`, and every other
    // is added to `refused` all the same.
    const urlAllowed = (value: string, kind: string, refused: string[], loads: string[], corsFreeOnly: boolean) => {
        const url = value.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '');
        const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
        if (!scheme) return true;
        const name = scheme[1]!.toLowerCase();
        if (name === 'blob') return isMinted(value);
        if (name !== 'https' && name !== 'http') return false;
        if (corsFreeOnly && !corsFree(url)) {
            refused[refused.length] = droppedUrl(url);
            return false;
        }
        if (kind === '') return true;
        const blocked = refusedUrl(url, kind);
        if (blocked !== null) {
            refused[refused.length] = blocked;
            return false;
        }
        const load = loadOf(url);
        if (load !== null) loads[loads.length] = load;
        return true;
    };
    // srcset: every candidate's URL starts at the start or after a comma, and its scheme holds neither, so checking the
    // first token after every comma checks every candidate (a URL that itself holds a comma is only checked more)
    const srcsetAllowed = (value: string, kind: string, refused: string[], loads: string[]) => {
        const pieces = value.split(',');
        for (let i = 0; i < pieces.length; i++) {
            const url = pieces[i]!.replace(/^[\t\n\f\r ]+/, '').split(/[\t\n\f\r ]/)[0]!;
            if (url !== '' && !urlAllowed(url, kind, refused, loads, false)) return false;
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
    // A kept style attribute without animations and transitions (switches.animations false; R4:C-2, R5:L-2, R5:N-7).
    // What happens to an attribute depends on its text alone, never on how an engine stores it:
    //   1. The text decides whether there is anything to read. A declaration names its property with an identifier,
    //      matched ASCII case-insensitively and spelled with literal letters or CSS escapes, and every property that sets
    //      an animation or transition longhand has "animation" or "transition" in its name (shorthands, aliases and
    //      prefixes alike: checked against each engine's whole property list in the R4:C-2 e2e test), but
    //      `all`, which takes nothing but a CSS-wide keyword (a var() in it resolves to one, or the declaration is
    //      invalid). So a text without "animation", "transition" (in any case) or a backslash declares no animation, and
    //      stays as the guest wrote it: nothing is read, nothing is serialized. "transform", "transparent" or
    //      "text-transform" alone never take the slower path (a test for "anim" or "trans" would send them there).
    //   2. A text that does, and has a backslash (an escape the engine's parser would read as any name), or declares
    //      `all` (the word as a property name: after the start, a `;`, whitespace or a comment, before an optional
    //      whitespace and a colon; comments are skipped), goes whole. `all` expands into hundreds of longhands in Firefox
    //      and WebKit and into one in Chromium, so reading and rewriting it would be work out of proportion to what the
    //      guest sent, and its result would differ per engine. Either errs only toward removing.
    //   3. Otherwise the element's own CSSOM declaration is read, so the engine's parser decides what the attribute
    //      declares (case, `!important`, var() in a shorthand: every engine stores longhands, under their own names).
    //      Without `all` a declaration holds at most a few longhands per character of its text (`font` the most), so
    //      the work is linear in what the guest sent. Only the engine's animation and transition properties are read
    //      (context.animating, found once per view), each with getPropertyValue, and each that holds anything but a
    //      CSS-wide keyword is removed; one whose value only a var() decides reads '' and is removed too (removeProperty
    //      takes it, and the declaration's length says so). A CSS-wide keyword (initial, inherit, unset, revert,
    //      revert-layer) never animates: it is the property's initial value, the parent's value (every parent was
    //      cleaned, or is stopped by the still stylesheet), or a rollback to sheets the still stylesheet stops.
    //   4. When something was removed, the attribute becomes the declaration's serialization, so what the view applies
    //      is exactly what was read here (the attribute goes when nothing is left); else it stays as written.
    // The CSSOM is no CSP sink. Only the animation properties are read, because listing every property of every
    // declaration and writing the attribute back from it would make `all:unset` cost hundreds of reads and a
    // serialization of hundreds of properties per element (R4:C-2): one render of 262 000 characters of
    // `<i style="all:unset"></i>` would stall WebKit 10.3 s and Firefox 2.7 s (0.35 s and 0.27 s with animations on), and
    // then be refused for the characters its expansion takes.
    // An element whose namespace has no `style` (jsdom's MathML, an engine without MathMLElement) loses an attribute it
    // would have to read: fail closed.
    const MAY_ANIMATE = /animation|transition|\\/i;
    const ALL_PROPERTY = /(^|[^a-z0-9_-])all[\t\n\f\r ]*:/i;
    // The text without its comments and strings, each a space, in one pass: a comment runs to its "*/" or the end of
    // the text, a string to its closing quote, a newline or the end (no escape is left to read: a text with a backslash
    // goes before this). So neither a comment nor a quote can hide `all` from ALL_PROPERTY, nor show it one.
    const outsideCommentsAndStrings = (text: string) => {
        const parts = list<string>();
        let from = 0;
        let i = 0;
        while (i < text.length) {
            const c = text[i]!;
            let end = -1;
            if (c === '/' && text[i + 1] === '*') {
                const close = text.indexOf('*/', i + 2);
                end = close < 0 ? text.length : close + 2;
            } else if (c === '"' || c === "'") {
                end = i + 1;
                while (end < text.length && text[end] !== c && text[end] !== '\n' && text[end] !== '\r' && text[end] !== '\f') end++;
                end = end < text.length ? end + 1 : end;
            }
            if (end < 0) {
                i++;
                continue;
            }
            parts[parts.length] = call(String.prototype.slice, text, [from, i]) as string;
            parts[parts.length] = ' ';
            from = end;
            i = end;
        }
        parts[parts.length] = call(String.prototype.slice, text, [from]) as string;
        return call(joinList, parts, ['']) as string;
    };
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
        if (!styleOf || written.indexOf('\\') >= 0 || ALL_PROPERTY.test(outsideCommentsAndStrings(written))) {
            drop(element, 'style');
            return;
        }
        const style = call(styleOf, element, []) as CSSStyleDeclaration;
        const before = call(declarationLength, style, []) as number;
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

    // CSS without its network URLs (S74, BD2:ISO-2; docs/research/21_crossorigin_loads/README.md): no attribute reaches a load that CSS makes, so a kept style attribute
    // or <style> holds no http(s) URL at all (dropNetworkCss: withoutNetworkReferences, css-references.ts; what it finds
    // errs toward more), and each one dropped is reported with the directive of its kind of load: an @import's style-src,
    // a url() in @font-face font-src, any other img-src. A reference to a file the view minted is a blob: URL, and stays.
    const withoutNetwork = (css: string): string => {
        const dropped = list<[string, string]>();
        const kept = dropNetworkCss(css, dropped, corsFreeOrigins);
        for (let i = 0; i < dropped.length; i++) context.refused[context.refused.length] = [directiveOf(dropped[i]![0]), droppedUrl(dropped[i]![1])];
        return kept;
    };
    // A kept <style> (HTML or SVG) holds one text only: its child text, which is what a sheet reads, without network URLs.
    // Anything else in it goes (SVG parses elements into one), so no element is ever inside a style, and no later text()
    // or set() can reach a sheet but through the view's own filter (inSandboxView, `cssInto`).
    const nextSiblingOf = getter(N, 'nextSibling');
    const setTextContent = Object.getOwnPropertyDescriptor(N, 'textContent')!.set!;
    const cleanSheet = (element: Element) => {
        const parts = list<string>();
        for (let child: Node | null = call(firstChildOf, element, []); child; child = call(nextSiblingOf, child, [])) {
            const type = call(nodeTypeOf, child, []);
            if (type === 3 || type === 4) parts[parts.length] = call(dataOf, child, []);
        }
        call(setTextContent, element, [withoutNetwork(call(joinList, parts, ['']) as string)]);
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
    // name of the element it is appended to (a <source> loads by its parent), `parentNode` that element, null for the
    // fragment's own children (whose parent is the target).
    const clean = (element: Element, namespace: unknown, name: string, parent: string, parentNode: Element | null): boolean => {
        const html = namespace === HTML;
        // a <source> or <track> of a media element loads through it: through one without crossorigin (all its own loads
        // of origins.withoutCors), only a URL of such an origin may load
        const loaderAnonymous = parentNode ? get(parentNode, 'crossorigin') === 'anonymous' : context.targetAnonymous === true;
        const bareLoader = html && (name === 'source' || name === 'track') && (parent === 'video' || parent === 'audio') && corsFreeOrigins.length > 0 && !loaderAnonymous;
        const elementLoads = list<string>();
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
        if ((html || namespace === SVG) && name === 'style') cleanSheet(element);
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
            const loads = list<string>();
            const keep = attributeAllowed(namespace, name, attribute)
                && !(/blob:/i.test(value.replace(/[\t\n\r]/g, '')) && !(html && isPair(rules.references, name, attribute) && isMinted(value)))
                && !(isUrl && !(attribute === 'srcset' ? srcsetAllowed(value, kind, refused, loads) : urlAllowed(value, kind, refused, loads, bareLoader || isPair(rules.networkDropped, name, attribute))))
                && !(namespace === SVG && svgLocal[attribute] && /[:\\]/.test(value))
                && !(attribute === 'autoplay' && !switches.autoplay);
            // a URL the policy refuses: reported as the browser would have reported its load (a srcset's first one)
            if (refused.length > 0) context.refused[context.refused.length] = [directiveOf(kind), refused[0]!];
            if (!keep) {
                drop(element, attribute);
                continue;
            }
            if (attribute === 'referrerpolicy') set(element, attribute, 'no-referrer');
            if (attribute === 'style') {
                const css = withoutNetwork(value);
                if (css !== value) set(element, 'style', css);
                if (!switches.animations) stillStyle(element, namespace, css);
                if (context.css) context.css[context.css.length] = css; // before the still rules (cssLoadsOf)
            }
            if (!isUrl) continue;
            for (let l = 0; l < loads.length; l++) {
                context.loads[context.loads.length] = loads[l]!;
                elementLoads[elementLoads.length] = loads[l]!;
            }
            context.urls++;
            if (context.urls > urlRoom) throw new RangeError('VIEW_MAX_URLS');
        }
        if (rules.referrerElements.indexOf(name) >= 0) set(element, 'referrerpolicy', 'no-referrer');
        // whatever the guest wrote (its own crossorigin is on no allowlist and went above), before the element is connected;
        // not on an element whose every load is of origins.withoutCors (an <img> in a <picture> loads its sources too: never)
        let corsFreeElement = name !== 'link' && !(name === 'img' && parent === 'picture') && elementLoads.length > 0;
        for (let l = 0; corsFreeElement && l < elementLoads.length; l++) corsFreeElement = corsFree(elementLoads[l]!);
        if (html && rules.crossOrigin.indexOf(name) >= 0 && !corsFreeElement) set(element, 'crossorigin', 'anonymous');
        if ((name === 'a' || name === 'area') && has(element, 'rel')) {
            set(element, 'rel', tokens(get(element, 'rel')).filter((token) => rules.anchorRelations.indexOf(token) >= 0).join(' '));
        }
        return true;
    };

    // The walk (R1:R1-2: linear by construction): each parent's children are taken out from the front
    // (`drain`: removing a first child costs the same at any size in every engine), decided in document order, and the
    // kept ones appended back at the end. Removing children one by one from the middle costs time in
    // the number of siblings in Chromium and WebKit (measured: 38 000 removals among 86 000 siblings, Chromium 13 s,
    // WebKit over 3 s, on the host page's thread where the view shares it). A kept element is appended and its own
    // children walked next, one level deeper; an unwrapped element's children are walked in its place, at its depth,
    // into the same parent; a removed element is dropped with its subtree. Text between them is joined into one node
    // (the first of the run, its data set once): unwrapping or removing elements leaves runs of adjacent text, which
    // WebKit lays out in super-linear time (43 000 one-letter nodes stall its host page). Comments and processing
    // instructions are dropped: nothing in a view needs them. `depth` is an element's depth below the fragment.
    const nodeTypeOf = getter(N, 'nodeType');
    const dataOf = getter(CharacterData.prototype, 'data');
    const setData = Object.getOwnPropertyDescriptor(CharacterData.prototype, 'data')!.set!;
    const list = <T>(): T[] => Object.setPrototypeOf([], null); // read by index and length only (AR:C3)
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
        if (decision === KEEP && !clean(element, namespace, name, parentName, run.parent === fragment ? null : run.parent as Element)) decision = REMOVE;
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

/**
 * An upper bound of the loads `css` can make (S73, R5:M-3; class E-net and P): the view charges it
 * to the load budget when it applies the CSS, before the browser can start any of them (inSandboxView, `cssLoadsOf`).
 * Every CSS load is named by a function token whose name is `url` (a url token too: `url(` unquoted), `image-set`,
 * `-webkit-image-set`, `image`, `cross-fade` or `src`, or by an `@import`; each counts 1, and each `@import` counts
 * `perSheet` (VIEW_URLS_PER_SECOND), for what the sheet it imports can name, which the view cannot read when it applies
 * the CSS. An `image-set()` counts once besides the url() in it: it loads one of its images, and a string in it names
 * one too. A load the count missed is charged all the same once the platform reports it (observeLoads); the count only
 * moves the charge to before the load.
 *
 * The minimal subset of the CSS tokenizer (css-syntax-3, 4.3) this needs: a name is an identifier, matched ASCII
 * case-insensitively, and the function's `(` follows it at once. Each code point of an identifier is written in one of
 * three ways: the code point itself; a backslash and the code point, where it is no hex digit (and no newline); or a
 * backslash and 1–6 hex digits giving its value, then one optional whitespace (CR LF one), where the digits end at six
 * or before a code point that is no hex digit. So the count is of every match of a pattern that spells each code point
 * of a name in each of those ways, in either case (`spell`), followed by `(`; and of `@` then `import`, spelled alike.
 * Why that counts every token that loads, and errs only toward counting more:
 *   - the pattern is tried at every position of the text, comments, strings and the middle of other identifiers
 *     included, so it assumes no token boundary: wherever the tokenizer starts a token that loads, the pattern matches
 *     there what the tokenizer reads;
 *   - each match ends at a `(`, and a name holds none, so no match that starts before a token can end inside it: it
 *     ends before the token, or at its `(` (`-webkit-image-set(`, once), and the token is counted;
 *   - what else matches only counts more: a name in a comment or a string, inside a longer identifier (`xurl(`), a
 *     dimension (`5url(`), or after a backslash the tokenizer reads otherwise (`\\75 rl(`, an escaped backslash).
 *     Skipping comments and strings would count less, but a skip that ends one where the tokenizer does not (an
 *     escape's whitespace that is a newline, a bad url's quote) hides what follows, which errs toward counting less: not
 *     worth what it saves.
 * One native match of each pattern: linear in the text, and small next to the parse that every render does anyway
 * (the S73 e2e test). Stringified into the view bootstrap; self-contained.
 */
export function cssLoadBound(css: string, perSheet: number): number {
    // One code point of a name (lower case), in each way it can be written, either case (the pattern is /i).
    const spell = (c: string) => {
        const literal = /[a-z]/.test(c) ? c : '\\' + c; // `-`, the one code point of a name that is no letter
        const ways: string[] = [/[0-9a-f]/.test(c) ? literal : '\\\\?' + literal];
        const codes = c === c.toUpperCase() ? [c] : [c, c.toUpperCase()];
        for (let i = 0; i < codes.length; i++) {
            const hex = codes[i]!.charCodeAt(0).toString(16);
            ways.push('\\\\(?:0{' + (6 - hex.length) + '}' + hex + '|0{0,' + (5 - hex.length) + '}' + hex + '(?![0-9a-f]))(?:\\r\\n|[\\t\\n\\f\\r ])?');
        }
        return '(?:' + ways.join('|') + ')';
    };
    // a text without a backslash holds no escape: each code point is itself, and the pattern that says so is faster
    const escapes = css.indexOf('\\') >= 0;
    const name = (word: string) => (escapes ? word.split('').map(spell).join('') : word);
    const functions = new RegExp('(?:' + ['url', '-webkit-image-set', 'image-set', 'image', 'cross-fade', 'src'].map(name).join('|') + ')\\(', 'gi');
    const imports = new RegExp('@' + name('import'), 'gi');
    const loads = css.match(functions);
    const sheets = css.match(imports);
    return (loads ? loads.length : 0) + (sheets ? sheets.length : 0) * perSheet;
}

/** The view's budgets per second (ViewOptions): characters of markup, ms of its own time, loads. */
export interface ViewRates {
    /** VIEW_RENDER_CHARACTERS_PER_SECOND */
    characters: number;
    /** VIEW_APPLY_MS_PER_SECOND */
    time: number;
    /** VIEW_URLS_PER_SECOND */
    urls: number;
}

/** What bounds one operation of the view (ViewOptions has both; viewBudget's `measured`). */
export interface ViewOperationLimits {
    /** VIEW_MAX_OPERATION_MS */
    maxOperation: number;
    /** VIEW_OVERRUN_WINDOW_MS */
    overrunWindow: number;
}

/** What one measure of an operation means (viewBudget's `measured`). */
export type ViewVerdict = 'within' | 'uncounted' | 'overrun' | 'second-overrun';

/**
 * The view's budgets, as arithmetic and nothing else (R1:R1-1, R2:M-3, R4:M-2, R5:M-2, R5:M-3, S72): one token bucket per measure of ViewRates, each holding at most one second's worth, refilled at its
 * rate as time passes (`now`, ms, given by the caller: the view passes performance.now()). The view charges each bucket
 * what it measured or observed, in full, never capped: an operation of 1.5 s leaves the time budget 1.3 s in debt, which
 * it repays in 6.5 s, so the time budget bounds the view's long-run share of the thread at `time` per second (R5:M-2: a
 * debt floored at 1 s would let operations of 7.5 s run every 12.5 s). One operation's own cost is bounded by
 * the repeated-overrun rule instead (`measured`, below).
 *   charge(kind, amount, now)             takes `amount` from that bucket;
 *   prepay(loads, now)                    takes `loads` from the load bucket, before they can start, and keeps them as
 *                                         credit, at most a second's worth (`urls`); what passes it is forfeited;
 *   observed(loads, now)                  loads the platform reported that no render's URL attribute charged: each
 *                                         takes one of the credit, and those past it are charged;
 *   measured(ms, operation, now, shown)   one measure of the view's own time: charged, and its operation judged;
 *   owes(now)                             whether the time or the load budget is in debt: an operation waits until neither is;
 *   wait(characters, now)                 the ms until neither owes and the characters budget covers `characters`.
 *
 * The repeated-overrun rule (S72, the owner's decision; class P, a budget that counts a proxy). `ms`
 * is what this measure took (a flush, or the rendering update after one); `operation` the whole operation it belongs to,
 * as measured so far (the flush, plus its rendering update), or 0 when the caller has judged that operation already; and
 * `shown` false when the measure spans time in which the document was hidden. The verdict:
 *   - 'uncounted': not shown. Neither charged nor counted: a hidden document's timers are throttled (Chromium runs a
 *     background page's timers once a second), so the measure holds time in which nothing rendered;
 *   - 'within': charged; the operation took at most `maxOperation`;
 *   - 'overrun': charged in full, like any operation, so the next one waits until the debt is repaid (at least 9 s at
 *     VIEW_APPLY_MS_PER_SECOND), and remembered; the view goes on;
 *   - 'second-overrun': charged, and the last overrun's measure ended at most `overrunWindow` ms before this one's: the
 *     view ends the sandbox.
 * An overrun later than that is a first overrun again, and the window runs from it. So the rule is a function of the
 * time of the last overrun alone: any two earlier ones that did not end the sandbox were more than a window apart. Why a
 * second overrun and not the first: VIEW_OVERRUN_WINDOW_MS.
 *
 * The load budget's credit (S73, R5:M-3; class E-net and P). The view prepays the loads of the CSS
 * an operation applies (cssLoadBound), and the platform reports each of them again once its response has ended
 * (observeLoads): the credit makes that report take from what was prepaid instead of charging the load twice. It is
 * capped at one second's worth (`urls`), so an operation whose count was far above what it loaded (url( in comments,
 * an @import's allowance) cannot store up a burst of uncharged loads for later: past the cap the prepayment is
 * forfeited, and its loads, when they come, are charged like any other. A load the credit does not cover is charged
 * when it is reported. So every load is charged at least once, and none twice while the credit lasts.
 * Stringified into the view bootstrap; self-contained.
 */
export function viewBudget(rates: ViewRates, start: number, limits: ViewOperationLimits) {
    const held = { characters: rates.characters, time: rates.time, urls: rates.urls };
    let refilled = start;
    let lastOverrun: number | null = null; // where the last overrun's measure ended (`now`)
    const refill = (now: number) => {
        const seconds = now > refilled ? (now - refilled) / 1000 : 0;
        held.characters = Math.min(rates.characters, held.characters + seconds * rates.characters);
        held.time = Math.min(rates.time, held.time + seconds * rates.time);
        held.urls = Math.min(rates.urls, held.urls + seconds * rates.urls);
        if (now > refilled) refilled = now;
    };
    // ms until `owed` units are repaid at `rate` per second
    const repaid = (owed: number, rate: number) => (owed > 0 ? Math.ceil((owed / rate) * 1000) : 0);
    const charge = (kind: keyof ViewRates, amount: number, now: number) => {
        refill(now);
        held[kind] -= amount;
    };
    let credit = 0; // loads prepaid and not reported yet, at most `rates.urls`
    return {
        charge,
        prepay(loads: number, now: number) {
            charge('urls', loads, now);
            credit = Math.min(rates.urls, credit + loads);
        },
        observed(loads: number, now: number) {
            const covered = Math.min(credit, loads);
            credit -= covered;
            charge('urls', loads - covered, now);
        },
        credit(): number {
            return credit;
        },
        measured(ms: number, operation: number, now: number, shown: boolean): ViewVerdict {
            if (!shown) return 'uncounted';
            charge('time', ms, now);
            if (!(operation > limits.maxOperation)) return 'within';
            const second = lastOverrun !== null && now - lastOverrun <= limits.overrunWindow;
            if (!second) lastOverrun = now;
            return second ? 'second-overrun' : 'overrun';
        },
        owes(now: number): boolean {
            refill(now);
            return held.time < 0 || held.urls < 0;
        },
        wait(characters: number, now: number): number {
            refill(now);
            return Math.max(repaid(characters - held.characters, rates.characters), repaid(-held.time, rates.time), repaid(-held.urls, rates.urls));
        },
        held(kind: keyof ViewRates, now: number): number {
            refill(now);
            return held[kind];
        },
    };
}

/** What the view bootstrap is given, as one literal in its (constant) text. */
export interface ViewOptions {
    render: RenderRules;
    maxRender: number;
    maxTarget: number;
    /** The budgets per second (viewBudget). */
    rates: ViewRates;
    /** VIEW_MAX_OPERATION_MS */
    maxOperation: number;
    /** VIEW_OVERRUN_WINDOW_MS */
    overrunWindow: number;
    /** VIEW_MAX_DISTINCT_URLS */
    maxDistinctUrls: number;
    violationLimit: number;
    /** VIOLATION_DIRECTIVES: the directive names counted apart; every other name shares one count (violationBucket, violation.ts). */
    violationDirectives: readonly string[];
    /** VIOLATION_MAX_STRING: the longest string of a violation report the view posts. */
    violationMaxString: number;
    events: { types: readonly string[]; maxString: number; maxIds: number; maxFields: number; maxTotal: number };
    /** The Trusted Types policy name the view creates where the host page enforces them (trusted-types.ts). */
    trustedTypesPolicy: string;
    /** VIEW_WRITE_TYPES: the only types the view mints a URL for from a guest write. */
    writeTypes: readonly string[];
    /**
     * The guest's error texts the view relays (GUEST_ERROR, GUEST_UNCAUGHT): longest, and most per second; and the characters
     * of the uncaught ones the view counts in any one second (UNCAUGHT_CHARACTERS_PER_SECOND), past which the sandbox ends.
     */
    guestText: { maxLength: number; perSecond: number; uncaughtCharacters: number };
    /** VIEW_STILL_STYLE: the view's stylesheet for `allowAnimations: false`. */
    stillStyle: string;
    /** VIEW_STILL_PSEUDO_ELEMENTS and VIEW_STILL_DECLARATIONS: the rules the view adds to it, where the engine supports them. */
    still: { pseudoElements: readonly string[]; declarations: string };
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
export function inSandboxView(installFiles: typeof inSandboxFiles, sanitize: typeof sanitizeRender, makeBudget: typeof viewBudget, countLoads: typeof cssLoadBound, scanCss: typeof cssReferences, dropCss: typeof withoutNetworkReferences, options: ViewOptions) {
    const g = globalThis as any;
    const runs = (g.__sandboxViewRuns || 0) + 1;
    g.__sandboxViewRuns = runs;
    if (runs > 1) return;
    const budget = makeBudget(options.rates, performance.now(), options); // the view's budgets (viewBudget; the flush, below)

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
    const namespaceOfElement = getter(Element.prototype, 'namespaceURI');
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
    // The one cut of the strings the view posts that the guest can choose (a violation report's, a guest error text): a
    // string longer than `most` is cut to it; anything else is returned as it is, for the receiver to validate.
    const cutText = (value: unknown, most: number): unknown => (typeof value === 'string' && value.length > most ? value.slice(0, most) : value);
    const toHost = (frame: unknown) => {
        if (viewPort) viewPort.postMessage(frame);
        else if (outbox.length < options.violationLimit) outbox.push(frame);
    };

    // The view document's own CSP violations (G6): complete and unforgeable, since no guest code runs in this
    // document and the host labels whatever arrives on the view port as source 'view'. Capped per directive
    // (VIOLATION_EVENT_LIMIT each; the host keeps the same buckets, AR:C4): the view's reports include
    // refusals of the guest's own rendered markup, so one shared cap would let a guest that rendered 100 refused
    // images hide a later script-src-attr report. The directive is the browser's, so the buckets are the
    // browser's directive names, the ones of options.violationDirectives (VIOLATION_DIRECTIVES, which the host counts by
    // too: violationBucket, violation.ts) and one more bucket for every other name (BD3:LIM-3).
    // The renderer's own refusals go through the same counts (R4:M-2): a URL the view's policy refuses is
    // dropped before insertion, so the browser never processes it, and reported here as the browser would report it (its
    // directive, and the URL without credentials or fragment), within the same per-directive cap.
    // Its strings are cut before they are posted (S61; class E-cpu, "cut before posting"), at
    // options.violationMaxString, the length the host keeps (violation.ts, which cuts them again on receipt): a refused
    // URL of the guest's markup or CSS is the guest's to choose, up to what one render holds, and every engine reports an
    // https URL whole, so a render of one 100 000-character image URL would cross whole to the host page
    // (test/e2e/violation-strings.spec.ts). The bucket is the cut directive's, so it is bounded as well.
    const violationCounts = new Map<string, number>();
    const reportViolation = (directive: unknown, blockedURI: unknown, sourceFile?: unknown, lineNumber?: unknown, columnNumber?: unknown) => {
        const name = String(cutText(directive, options.violationMaxString));
        const bucket = options.violationDirectives.indexOf(name) >= 0 ? name : '';
        const count = violationCounts.get(bucket) || 0;
        if (count >= options.violationLimit) return;
        violationCounts.set(bucket, count + 1);
        toHost({ type: 'VIOLATION', directive: name, blockedURI: cutText(blockedURI, options.violationMaxString), sourceFile: cutText(sourceFile, options.violationMaxString), lineNumber, columnNumber });
    };
    // Each one is charged to the load budget too (R5:M-3; VIEW_URLS_PER_SECOND): what the browser did to
    // refuse a load, whatever named it (CSS too), unless it is a URL a render kept, which was charged when it was
    // rendered (the renderer expected the browser to admit it). WebKit reports some refusals twice: each report is
    // work, and each is charged. Like a load the platform reports (observeLoads), it takes from the credit of the CSS
    // the view prepaid first (S73; viewBudget), and is charged once that is spent.
    // Each field is read once (the view runs no guest code, so its getters are the platform's).
    addEventListener('securitypolicyviolation', (event: any) => {
        if (!event.isTrusted) return;
        const blockedURI = event.blockedURI;
        if (!renderedLoads.has(String(blockedURI))) budget.observed(1, performance.now());
        reportViolation(event.effectiveDirective || event.violatedDirective, blockedURI, event.sourceFile, event.lineNumber, event.columnNumber);
    }, true);

    // The directive of a kind of load (options.render.kinds and directives), as the renderer reports its refusals.
    const directiveOfKind = (kind: string): string => {
        const rule = Object.prototype.hasOwnProperty.call(options.render.kinds, kind) ? options.render.kinds[kind]! : null;
        return rule && Object.prototype.hasOwnProperty.call(options.render.directives, rule.key) ? options.render.directives[rule.key]! : 'default-src';
    };
    // A URL as a report names it: without credentials or fragment, or as written where it does not parse.
    const reportedUrl = (value: string): string => {
        try {
            const url = new URL(value);
            url.username = '';
            url.password = '';
            url.hash = '';
            return url.href;
        } catch {
            return value;
        }
    };

    // A load the view kept that fails (S74, BD2:ISO-2; docs/research/21_crossorigin_loads/README.md). Every element load is a CORS request without credentials
    // (RENDER_CROSSORIGIN_ELEMENTS), so a listed origin that sends no Access-Control-Allow-Origin fails it, as a missing or
    // undecodable file does: the page cannot tell which, and the browser fires `error` and reports nothing. Each is
    // reported as a violation of its load's directive, with the URL that failed (an image's current source, a media
    // element's, a <source>'s or a <track>'s src; without credentials or fragment), within the same per-directive cap.
    // Only an http(s) URL counts: the view's own files are blob: URLs. Charged nothing: its URL attribute was charged when
    // it was rendered.
    const FAILED_LOAD_KINDS: Record<string, string> = { img: 'image', video: 'media', audio: 'media', source: 'media', track: 'track' };
    const currentSrcOf = (constructor: unknown) => {
        const descriptor = typeof constructor === 'function' ? Object.getOwnPropertyDescriptor(constructor.prototype, 'currentSrc') : undefined;
        return descriptor && descriptor.get ? descriptor.get as (this: Element) => string : undefined;
    };
    const mediaCurrentSrc = currentSrcOf(g.HTMLMediaElement);
    const currentSourceOf: Record<string, ((this: Element) => string) | undefined> = { img: currentSrcOf(g.HTMLImageElement), video: mediaCurrentSrc, audio: mediaCurrentSrc };
    addEventListener('error', (event: Event) => {
        if (!event.isTrusted) return;
        const target = event.target;
        if (!(target instanceof Element) || call(namespaceOfElement, target, []) !== 'http://www.w3.org/1999/xhtml') return;
        const name = String(call(localNameOf, target, []));
        if (!Object.prototype.hasOwnProperty.call(FAILED_LOAD_KINDS, name)) return;
        const current = Object.prototype.hasOwnProperty.call(currentSourceOf, name) ? currentSourceOf[name] : undefined;
        const url = String((current ? call(current, target, []) : '') || call(E.getAttribute, target, ['src']) || '');
        if (!/^https?:/i.test(url)) return;
        reportViolation(directiveOfKind(FAILED_LOAD_KINDS[name]!), reportedUrl(url));
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
    // (BR:ST3): a detail cut anywhere carries `truncated: true`. Link and submit defaults are
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

    // The view's two sinks under a host page's Trusted Types (R1:R3-1): the view inherits the host page's
    // `require-trusted-types-for 'script'`, which makes the template's innerHTML and the Worker constructor throw a
    // TypeError for a string, and reports every such string to the host page (a violation, a console error, its
    // report-uri), caught or not. A document cannot be asked whether it enforces Trusted Types, so where the view has
    // Trusted Types both sinks go through the one policy of the view's own from the first write: created once (by
    // trustedTypesReady, before the check-in), named like the element's (trusted-types.ts: the host page's trusted-types
    // directive admits it already). Its rules pass the value through: the markup goes into an inert template and through
    // the renderer, and the URL is the worker's own. Without the policy (no Trusted Types here, or the name refused,
    // which trustedTypesReady has told the host about where the document requires them) the value is written as it is.
    let policy: { createHTML(value: string): unknown; createScriptURL(value: string): unknown } | null = null;
    const trusted = (sink: (value: unknown) => void, value: string, kind: 'createHTML' | 'createScriptURL') => {
        sink(policy ? policy[kind](value) : value);
    };

    // Whether the sinks are usable: the document has no Trusted Types, or the policy exists or could be made, or the
    // policy was refused and the document does not require Trusted Types (a string takes: only then is the name's refusal harmless).
    const trustedTypesReady = () => {
        if (policy || !g.trustedTypes) return true;
        try {
            const pass = (input: string) => input;
            policy = g.trustedTypes.createPolicy(options.trustedTypesPolicy, { createHTML: pass, createScriptURL: pass });
            return true;
        } catch {
            // refused: the sinks are written as strings, which a document that requires Trusted Types refuses
        }
        try {
            const probe = call(D.createElement, document, ['template']) as HTMLTemplateElement;
            probe.innerHTML = '';
            return true;
        } catch (error) {
            return !(error instanceof TypeError); // not Trusted Types: the sinks' own callers handle it
        }
    };

    let viewFiles = new Map<string, { url: string; type: string }>();
    let minted = new Set<string>();
    // The guest's writes as the host recorded them (R1:R4-4): path → the URL this view minted from the host's bytes, or null
    // where the path names nothing (a removal, or a write of a type the view does not mint for). A path the
    // guest changed resolves as the guest's own sandboxFiles lists it, so a registered file it replaced or removed is
    // gone from here too. Only VIEW_WRITE_TYPES are minted, whatever the message says: this is the chokepoint.
    const written = new Map<string, { url: string; type: string } | null>();
    const fileOf = (path: string) => (written.has(path) ? written.get(path)! : viewFiles.get(path) || null);
    const isMinted = (url: string) => minted.has(url);
    const showWrite = (path: unknown, mime: unknown, bytes: unknown) => {
        if (typeof path !== 'string') return;
        const previous = written.get(path);
        if (previous) {
            // A later write or a removal replaces the URL: the old one is revoked, so it is not the view's, and
            // rendered markup cannot name it (A8); an image that already shows it keeps what it decoded.
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

    // What the body holds, kept as running counts (R2:C-4): its serialization's length (VIEW_MAX_CHARACTERS)
    // and its elements (VIEW_MAX_ELEMENTS). Serializing the whole body (and counting all its elements) on every
    // operation to check the budget would make a guest that filled the view once and then sent 2-character set()
    // operations cost the view ~1 M characters of work per operation, charged 2 (Firefox's host page fell from 233 to 67
    // ticks per second). So an operation measures only what it changes: the target's old content, its new content, a value
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
    let bodyUrls: number | null = null; // the body's URL-bearing attributes (VIEW_MAX_URLS; R4:M-2)
    let work = 0; // characters serialized by the current flush, charged to the budget with it
    let urlWork = 0; // URL-bearing attributes the current flush kept, charged to the load budget with it
    let cssWork = 0; // the loads the CSS the current flush applied can make (cssLoadsOf), prepaid with it
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
    // any other record means the counts do not hold. Without an observer the counts are never trusted.
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
    // The origins the view's policy admits per kind of load (INIT_VIEW, from `origins`; R4:M-2), as lists of
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
    // The engine's animation and transition longhands, found once (R4:C-2): every property a computed style
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
    //
    // Its rules for pseudo-elements (R5:M-1; VIEW_STILL_PSEUDO_ELEMENTS) are appended to its anonymous layer
    // through the CSSOM, one per name, and only for what can need one. Every such rule costs style work for every element
    // of the view, whatever the elements carry (Chromium: one more style resolution per element for most names, and for
    // ::scroll-button(*) 2.5–8 times a whole replacement, growing faster than the elements), so a rule for every name
    // in the library's own sheet would make every render of every guest two to eight times as expensive. A rule is needed only where an animation could
    // reach the pseudo-element, and only a guest stylesheet can give a pseudo-element anything (a style attribute cannot
    // name one, and the user agent's own sheet animates none). So:
    //   - a name gets a rule only where the engine supports it (CSS.supports('selector(*::name)')): a name the engine does
    //     not know matches nothing, and its rule would cost all the same; but a ::-webkit- name gets one wherever the
    //     engine's parser keeps it (every engine keeps any): Chromium matches the parts of its controls by name, and
    //     denies two of them in CSS.supports (-webkit-media-controls-volume-control-container and its hover background,
    //     found by enumerating its parts in the R4:C-7 e2e test);
    //   - and only once guest CSS that the view is about to apply names it (stillNamed): the text of every registered
    //     stylesheet at INIT_VIEW, of every <style> a render keeps (HTML or SVG) before it is inserted, and of every
    //     text() into a <style> before it is set. A name that appears anywhere in the text, comments and strings
    //     included, gets its rule (a selector can name a pseudo-element only by its name: `::before`, `:before`, nested
    //     or not); a text with a backslash (an escape spells any name) or an `@import` (of a sheet the view cannot read)
    //     gives every supported name its rule. That errs only toward adding rules, and each is added before the CSS that
    //     named it applies.
    // So a guest that names no pseudo-element pays for the `*` rule alone, and one that does pays for what it named, as
    // its own work, in the view's time budget. A rule once added stays for the view's life. A sheet the host page's
    // policy refused has no rules to append to (the guest's stylesheets are dropped then, inSandboxView below).
    let stillLayer: CSSGroupingRule | null = null;
    let stillPending: string[] = []; // the supported names without a rule yet
    const cssFound = g.CSS;
    const describedGetter = (proto: object | undefined, name: string) => {
        const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, name) : undefined;
        return descriptor && descriptor.get ? descriptor.get : null;
    };
    const groupRulesOf = describedGetter(g.CSSGroupingRule && g.CSSGroupingRule.prototype, 'cssRules');
    const ruleListLength = describedGetter(g.CSSRuleList && g.CSSRuleList.prototype, 'length');
    const stillLayerOf = (sheet: HTMLStyleElement): CSSGroupingRule | null => {
        const sheetOf = describedGetter(HTMLStyleElement.prototype, 'sheet');
        const rulesOf = describedGetter(g.CSSStyleSheet && g.CSSStyleSheet.prototype, 'cssRules');
        if (!sheetOf || !rulesOf || !groupRulesOf || !ruleListLength || !cssFound) return null; // jsdom
        const styleSheet = call(sheetOf, sheet, []) as CSSStyleSheet | null;
        const rules = styleSheet ? call(rulesOf, styleSheet, []) as CSSRuleList : null;
        const layer = rules && call(ruleListLength, rules, []) > 0 ? call(CSSRuleList.prototype.item, rules, [0]) : null;
        return layer instanceof CSSGroupingRule ? layer : null;
    };
    const addStillRule = (name: string) => {
        try {
            const length = call(ruleListLength!, call(groupRulesOf!, stillLayer, []), []);
            call(CSSGroupingRule.prototype.insertRule, stillLayer, ['*::' + name + '{' + options.still.declarations + '}', length]);
        } catch {
            // a name the engine claims and then refuses in a rule: nothing to stop there
        }
    };
    // Guest CSS the view is about to apply: every supported name it could reach gets its rule now.
    const stillNamed = (css: string) => {
        if (!stillLayer || stillPending.length === 0) return;
        const text = css.toLowerCase();
        const all = text.indexOf('\\') >= 0 || text.indexOf('@import') >= 0;
        const left: string[] = [];
        for (let i = 0; i < stillPending.length; i++) {
            const name = stillPending[i]!;
            const open = name.indexOf('(');
            if (all || text.indexOf(open < 0 ? name : name.slice(0, open)) >= 0) addStillRule(name);
            else left.push(name);
        }
        stillPending = left;
    };
    // Every kept <style> of a fragment about to be inserted (HTML and SVG alike).
    const stylesOf = (fragment: DocumentFragment) => call(DocumentFragment.prototype.querySelectorAll, fragment, ['style']) as NodeListOf<Element>;
    const textContentOf = getter(Node.prototype, 'textContent');
    const stillNamedIn = (fragment: DocumentFragment) => {
        if (!stillLayer || stillPending.length === 0) return;
        const styles = stylesOf(fragment);
        const length = call(getter(NodeList.prototype, 'length'), styles, []) as number;
        for (let i = 0; i < length; i++) stillNamed(String(call(textContentOf, call(NodeList.prototype.item, styles, [i]), [])));
    };
    const headOf = getter(Document.prototype, 'head');
    const firstChildOf = getter(Node.prototype, 'firstChild');
    const styleOfElement = getter(HTMLElement.prototype, 'style');
    const stillStyleInForce = (): boolean => {
        const head = call(headOf, document, []);
        if (!head) return false;
        const sheet = call(D.createElement, document, ['style']);
        call(Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')!.set!, sheet, [options.stillStyle]);
        call(Node.prototype.insertBefore, head, [sheet, call(firstChildOf, head, [])]);
        stillLayer = stillLayerOf(sheet as HTMLStyleElement);
        stillPending = [];
        const names = options.still.pseudoElements;
        for (let i = 0; stillLayer && i < names.length; i++) {
            if (cssFound.supports('selector(*::' + names[i] + ')') || names[i]!.indexOf('-webkit-') === 0) stillPending.push(names[i]!);
        }
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

    // The distinct URLs this view has loaded or holds (R5:M-4; VIEW_MAX_DISTINCT_URLS), without their
    // fragment: every one the document's resource timing reported (loadsObserved, below), and every http(s) URL a render
    // kept in a URL attribute. Each distinct URL a document loads stays in the engine's caches for the document's life:
    // past a few tens of thousands WebKit's host page stalls for 13–28 s while its memory grows without bound, though
    // the URL budget held the rate. A render whose URL attributes would take the count past the limit is refused before
    // anything is inserted (VIEW_MAX_DISTINCT_URLS); one that carries CSS (a <style>, a stylesheet <link>, a style
    // attribute that can name a URL) is refused once the count has reached it, since what CSS loads is known only once
    // it has loaded: that errs only toward refusing. A stylesheet already in the view still loads what its rules name for
    // the elements they match, which only its own text bounds (VIEW_MAX_CHARACTERS); each load is charged to the rate.
    const distinctLoads = new Set<string>();
    // The http(s) URLs a render kept, which the load budget was charged with when they were rendered: what the platform
    // reports of one of them is not charged again (below). A subset of distinctLoads.
    const renderedLoads = new Set<string>();
    const CSS_URL = /url\(|image-set\(|@import|\\/i;
    const styleAttributeOf = (element: Element) => call(E.getAttribute, element, ['style']) as string | null;
    const cssMayLoad = (fragment: DocumentFragment) => {
        const sheets = call(DocumentFragment.prototype.querySelectorAll, fragment, ['style, link']) as NodeListOf<Element>;
        if (call(nodeListLength, sheets, []) as number > 0) return true;
        const styled = call(DocumentFragment.prototype.querySelectorAll, fragment, ['[style]']) as NodeListOf<Element>;
        const length = call(nodeListLength, styled, []) as number;
        for (let i = 0; i < length; i++) if (CSS_URL.test(styleAttributeOf(call(NodeList.prototype.item, styled, [i]) as Element) || '')) return true;
        return false;
    };
    // The URLs of `loads` this view has not loaded yet, once each; throws, before anything is inserted, when they would
    // take the count past the limit, or when the count has reached it and `fragment` carries CSS that can load.
    const newLoads = (loads: readonly string[], fragment: DocumentFragment): string[] => {
        const fresh: string[] = [];
        const seen = new Set<string>();
        for (let i = 0; i < loads.length; i++) {
            if (distinctLoads.has(loads[i]!) || seen.has(loads[i]!)) continue;
            seen.add(loads[i]!);
            fresh.push(loads[i]!);
        }
        if (distinctLoads.size + fresh.length > options.maxDistinctUrls) throw new RangeError('VIEW_MAX_DISTINCT_URLS');
        if (distinctLoads.size >= options.maxDistinctUrls && cssMayLoad(fragment)) throw new RangeError('VIEW_MAX_DISTINCT_URLS');
        return fresh;
    };
    // The loads the CSS an operation applies can make, at most (S73, R5:M-3; class E-net and P), prepaid to the load
    // budget with the operation (viewBudget's `prepay`), as its URL attributes are charged: before the browser can start
    // any of them, which it does when it styles what was inserted. A CSS-borne load charged only when the platform
    // reports it (observeLoads), once its response has ended, would let every render the view applied behind a slow
    // server before the first charge arrived get through, so the first burst would be bounded by the server's latency
    // times the view's render rate, not by the budget.
    // What an operation can add CSS with, and so what is counted (cssLoadBound):
    //   - a render: every style attribute the renderer kept (HTML, SVG and MathML), as written, which it reads as it
    //     walks them (RenderContext.css: no second walk of the fragment), the text of every <style> in the fragment
    //     (HTML and SVG; an SVG one's whole text, its elements' included), every <link> with the stylesheet relation
    //     (the renderer keeps only those that name a registered stylesheet, minted: `perSheet`, like an @import, for
    //     what the sheet and its imports name), and, when the target is a <style> or inside one, the fragment's whole
    //     text (a sheet reads its own text children; the rest only counts more);
    //   - a text(): its text, when the target is a <style> or inside one;
    //   - a set(): a textarea's or an output's text, likewise (no sheet reads a grandchild's text, but nothing assumes
    //     that); an input's value is an attribute, never CSS, and a select's is a choice.
    // `perSheet` is VIEW_URLS_PER_SECOND, one second's worth: what an imported or linked sheet names is not known when
    // the operation applies (an admitted origin's sheet is not read at all), and is bounded only by that sheet's text.
    // A second's worth holds the next operation back for at least a second, by when the sheet has loaded and its loads
    // have started and are being reported, so they are charged before the operation after it; and it is as much credit
    // as the budget keeps (viewBudget), so it covers that many of them without a second charge. More would hold back
    // every guest that links a stylesheet for longer, and none of it could be kept as credit; what the sheet loads past
    // it is charged when it is reported, and is the one part of the bound its text alone bounds (VIEW_URLS_PER_SECOND).
    const STYLESHEET_LINK = /(^|[\t\n\f\r ])stylesheet($|[\t\n\f\r ])/i;
    const relOf = (element: Element) => call(E.getAttribute, element, ['rel']) as string | null;
    const inStyle = (target: Element) => {
        const body = call(bodyOf, document, []);
        for (let n: Element | null = target; n && n !== body; n = call(parentOf, n, [])) if (call(localNameOf, n, []) === 'style') return true;
        return false;
    };
    // The texts are counted as one, joined by newlines, which counts at least what counting each would (a match holds
    // one `(`, at its end, so one that runs across a newline, an escape's whitespace, ends at the next text's first `(`,
    // in place of at most one match of that text), and one count of a long text costs far less than thousands of short.
    const cssLoadsOf = (fragment: DocumentFragment, target: Element, styleAttributes: string[]) => {
        const perSheet = options.rates.urls;
        const texts = styleAttributes; // every style attribute the renderer kept, as written (RenderContext.css)
        const styles = stylesOf(fragment);
        const stylesLength = call(nodeListLength, styles, []) as number;
        for (let i = 0; i < stylesLength; i++) texts.push(String(call(textContentOf, call(NodeList.prototype.item, styles, [i]), [])));
        if (inStyle(target)) texts.push(String(call(textContentOf, fragment, [])));
        let bound = texts.length > 0 ? countLoads(texts.join('\n'), perSheet) : 0;
        const links = call(DocumentFragment.prototype.querySelectorAll, fragment, ['link']) as NodeListOf<Element>;
        const linksLength = call(nodeListLength, links, []) as number;
        for (let i = 0; i < linksLength; i++) if (STYLESHEET_LINK.test(relOf(call(NodeList.prototype.item, links, [i]) as Element) || '')) bound += perSheet;
        return bound;
    };
    // Every load the view's document makes, as the platform reports it (R5:M-3: class P and E-net): its
    // resource timing, which every engine keeps per document and reports for every fetch the document made, whatever
    // named the URL (markup, a stylesheet's url() or image-set(), @import, a style attribute, a font), once its response
    // ended (Chromium and Firefox report failed loads too, WebKit does not). A load the policy refused makes a
    // violation, which the listener above charges (Chromium reports an entry too: such a load is reported twice). Each
    // URL is counted among the distinct ones (VIEW_MAX_DISTINCT_URLS), and each entry but that of a URL a render kept
    // (whose URL attribute was charged when it was rendered) goes to the load budget (VIEW_URLS_PER_SECOND): it takes
    // from the credit of the CSS the view prepaid first (cssLoadsOf; S73), and is charged once that is spent.
    // So every load is charged at least once whether or not the renderer's model of what loads is right: what it kept
    // is charged when it is rendered (a relative URL, or one that fails in WebKit, too), what CSS it applied can load
    // is prepaid then, and what neither covered (a stylesheet's loads past its allowance, a rule of one already in the
    // view) or what it wrongly expected to be refused is charged when the platform reports it. A report arrives once
    // the response has ended, so only the prepayment holds a render back before its loads start: a report alone would
    // let the renders made meanwhile behind a slow server go through (R5:M-3, S73). The renderer's
    // drop of the URLs the policy would refuse saves the browser that work, and is no part of the bound. The observer
    // runs only when there are entries: nothing per frame, nothing while the view loads nothing. The document's own
    // buffer is emptied as entries arrive (nothing here reads it), so it holds none of them.
    const httpUrl = /^https?:/i;
    const observeLoads = () => {
        const named = typeof PerformanceEntry === 'function' ? Object.getOwnPropertyDescriptor(PerformanceEntry.prototype, 'name') : undefined;
        if (typeof PerformanceObserver !== 'function' || !named || !named.get) return; // all three engines have them (Node's, under jsdom, not)
        const clearTimings = Performance.prototype.clearResourceTimings;
        const entriesOf = PerformanceObserverEntryList.prototype.getEntries;
        const nameOf = named.get;
        const observer = new PerformanceObserver((list) => {
            const entries = call(entriesOf, list, []) as PerformanceEntry[];
            let unrendered = 0;
            for (let i = 0; i < entries.length; i++) {
                const name = String(call(nameOf, entries[i], []));
                const hash = name.indexOf('#');
                const load = hash < 0 ? name : name.slice(0, hash);
                if (renderedLoads.has(load)) continue;
                unrendered++;
                if (httpUrl.test(load)) distinctLoads.add(load);
            }
            budget.observed(unrendered, performance.now());
            if (clearTimings) call(clearTimings, performance, []);
        });
        observer.observe({ type: 'resource', buffered: true });
    };

    // CSS without its network URLs (sanitizeRender, `dropNetworkCss`; S74), for the renderer and for what an operation
    // puts into a <style> or inside one: each one dropped goes to `refused` with its directive, as the renderer's own.
    const dropNetworkCss = (css: string, dropped: [kind: string, url: string][], keep: readonly string[]) => dropCss(css, scanCss, dropped as [kind: 'style' | 'font' | 'image', url: string][], keep);
    const cssInto = (text: string, refused: [directive: string, url: string][]): string => {
        const dropped: [string, string][] = [];
        const kept = dropNetworkCss(text, dropped, viewOrigins.withoutCors || []);
        for (let i = 0; i < dropped.length; i++) refused.push([directiveOfKind(dropped[i]![0]), reportedUrl(dropped[i]![1])]);
        return kept;
    };
    const reportAll = (refused: [directive: string, url: string][]) => {
        for (let i = 0; i < refused.length; i++) reportViolation(refused[i]![0], refused[i]![1]);
    };

    // template.innerHTML parses into an inert fragment (no script runs, nothing loads); the renderer cleans
    // it; replaceChildren MOVES its nodes into the document (A2) — never a clone or an import. The renderer gets the
    // room the view's budget leaves (BR:ST2): the body's elements outside the target stay, the target's own
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
        const context: RenderContext = { target: String(call(localNameOf, target, [])), targetAnonymous: call(E.getAttribute, target, ['crossorigin']) === 'anonymous', animating: switches.animations ? [] : animatingProperties(), origins: viewOrigins, refused: [], urls: 0, loads: [], css: [] };
        const room = { elements: options.render.maxElements - (before.elements - ownElements), depth: options.render.maxDepth - depth, urls: options.render.maxUrls - (before.urls - ownUrls) };
        let kept = sanitize(template.content, fileOf, isMinted, dropNetworkCss, options.render, switches, room, context);
        if (inStyle(target)) {
            // into a <style>: what the sheet reads is text, so the render puts its text there, without network URLs, and
            // nothing else (the renderer leaves no element inside a style; S74)
            call(setTextContent, template.content, [cssInto(String(call(textContentOf, template.content, [])), context.refused)]);
            kept = 0;
            context.urls = 0;
            context.loads.length = 0;
            context.css!.length = 0;
        }
        const fresh = newLoads(context.loads, template.content);
        // The characters the body would hold (R1:R1-1): its serialization outside the target, plus the cleaned fragment's
        // (what the target's serialization becomes: the same nodes, moved; never more, and less only inside a raw-text
        // element, whose text is not escaped). Counted on the browser's own serializer, after the renderer, so
        // attributes it dropped and elements it unwrapped never count. Once inserted, the target is measured again, so
        // the count is what the body serializes to, exactly.
        if (before.characters - ownCharacters + innerLength(template) > options.render.maxCharacters) throw new RangeError('VIEW_MAX_CHARACTERS');
        if (!switches.animations) stillNamedIn(template.content); // the still rules its stylesheets need, before they apply
        const css = cssLoadsOf(template.content, target, context.css!); // before the move empties the fragment
        call(E.replaceChildren, target, [template.content]);
        settle(target);
        urlWork += context.urls;
        cssWork += css;
        for (let i = 0; i < context.loads.length; i++) renderedLoads.add(context.loads[i]!);
        for (let i = 0; i < fresh.length; i++) distinctLoads.add(fresh[i]!);
        reportAll(context.refused);
        if (bodyCharacters === null) return;
        bodyCharacters = before.characters - ownCharacters + innerLength(target);
        bodyElements = before.elements - ownElements + kept;
        bodyUrls = before.urls - ownUrls + context.urls;
    };

    // sandboxView.text() and set() (R1:R4-5). The element is found as a render's target is, by id inside
    // the body (never the body itself, never the bootstrap's own head), and an id that names nothing is dropped, like a
    // render to a missing target. What either leaves in the body is counted against the view's characters as the
    // browser serializes it, over the document it would leave (R1:R1-1), before anything changes.
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
    const applyText = (given: string, into: string) => {
        const target = elementInBody(into);
        if (!target) return;
        const refused: [string, string][] = [];
        const text = inStyle(target) ? cssInto(given, refused) : given; // a stylesheet's new text, without network URLs (S74)
        if (!switches.animations && call(localNameOf, target, []) === 'style') stillNamed(text); // a stylesheet's new text
        const css = inStyle(target) ? countLoads(text, options.rates.urls) : 0; // a stylesheet's new text (S73)
        replaceText(target, text);
        cssWork += css;
        reportAll(refused);
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
        const refused: [string, string][] = [];
        // a text a sheet could read (see inStyle), without network URLs (S74); the renderer leaves no control inside a style
        const value = fields.value !== undefined && (name === 'textarea' || name === 'output') && inStyle(target) ? cssInto(fields.value, refused) : fields.value;
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
                const css = inStyle(target) ? countLoads(value, options.rates.urls) : 0; // see inStyle
                replaceText(target, value);
                call(textareaValue, target, [value]);
                cssWork += css;
            } else if (name === 'output') {
                const css = inStyle(target) ? countLoads(value, options.rates.urls) : 0;
                replaceText(target, value);
                call(outputValue, target, [value]);
                settle(target);
                cssWork += css;
            } else if (name === 'select') {
                call(selectValue, target, [value]);
            }
        }
        if (fields.checked !== undefined && name === 'input') call(inputChecked, target, [fields.checked]);
        reportAll(refused);
        if (fields.focus !== true) return;
        if (!call(hasFocus, document, [])) throw new RangeError('VIEW_FOCUS');
        call(focusElement, target, []);
    };

    // At most one flush per animation frame (a timer stands in where frames are throttled), the latest render or text
    // per target; one VIEW_ACK per flush releases the worker's next operation (A4). And at most
    // VIEW_RENDER_CHARACTERS_PER_SECOND characters per second (R1:R1-1), a token bucket charged with each operation's
    // characters (a render's markup, a text, a value) when it is applied, refused or not, and with the characters it
    // serialized (R2:C-4): a flush that the budget does not cover yet waits until it does.
    //
    // And at most VIEW_APPLY_MS_PER_SECOND ms of the view's own time per second (R2:M-3), a second token
    // bucket charged with what the view's work took, measured. Characters are a proxy of the work and the time is the
    // work: within every character budget, re-rendering 37 449 empty elements without pause, or setting a 250 000-character
    // textarea value four times a second (WebKit), keeps the host page's thread 80–95% busy, where the view shares it. A
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
    // holds it back. Each is charged in full, however long it took (R5:M-2; viewBudget): a debt floored at one second
    // of the view's time would let an operation of 7.5 s (Chromium's layout of 30 000 restyled elements) be charged
    // 1.2 s and run again every 12.5 s, 53% of the thread, against a budget documented as a long-run share. One
    // operation's own cost is not something a rate can bound (ADR-005); the repeated-overrun rule bounds how often it
    // may be large instead (S72; `judge`, below): an operation, a flush and the rendering update measured after
    // it, that took longer than VIEW_MAX_OPERATION_MS is an overrun, charged in full like any other (one of 9 s holds the
    // view back 45 s), and the second overrun within VIEW_OVERRUN_WINDOW_MS ends the sandbox. So past the first, at most
    // one operation per window costs the thread more than VIEW_MAX_OPERATION_MS, and the long-run share is the rate's.
    //
    // The gap meter (R3:C-2, R3:M-5). The rendering update that shows a flush runs after the animation-frame
    // callbacks of the frame that follows it, and the first task after that frame's callbacks runs only once the update
    // is done: the time from the end of a callback to that task is the update, taken on the machine the view runs on,
    // and charged in full. A flush that ran inside a frame callback (the usual case: `schedule` runs it there) is
    // rendered by that very frame, so the measure starts as the flush ends; one that ran from the timer (frames
    // throttled) asks for the next frame, and the measure starts at the end of its callback. The task is a zero-delay
    // timer, posted from the frame (no clamping applies at that depth). At most one measurement is outstanding:
    // a flush while one is pending is measured by the next frame it asks for when it ends, and the time it took itself,
    // which it charges, is taken out of the measure it ran inside. Nothing runs while the view does nothing: no frame is
    // requested without a flush, and nothing runs per frame while guest animations play (research 16 measured both).
    // The meter never charges time in which no frame ran: a hidden or off-screen view runs no frame in most engines, so
    // its one pending request runs once the view shows again, and measures that frame. A measure across which the
    // document's visibility changed is dropped, neither charged nor counted towards an operation (R5:M-2):
    // a page hidden between the frame and the task throttles the task (Chromium runs a background page's timers once a
    // second), so the measure would hold time in which nothing rendered. Charging the wall time from the flush to a
    // frame callback, past one frame's length, would make a view hidden for 5 s, with one render applied meanwhile,
    // make the next render wait 18.3 s (R3:C-2), and would leave one frame's length uncharged per flush (R3:M-5). Where the
    // view shares the host page's renderer (an in-process frame), the update measured is the whole frame's, and a task of
    // the host page's that the event loop runs before the meter's task is in it too: both are charged to the view and
    // count towards its operation, which slows the guest, and makes it an overrun only past VIEW_MAX_OPERATION_MS: one
    // reason why one overrun does not end the sandbox (VIEW_OVERRUN_WINDOW_MS).
    type Job = { kind: 'render' | 'text' | 'set'; target: string | null; html: string; fields: { value?: string; checked?: boolean; focus?: boolean } | null };
    let pending: Job[] = [];
    let scheduled = false;
    // What a measure's verdict does (viewBudget, the repeated-overrun rule; S72, class P). An overrun that is not
    // the second in its window: the view goes on, its debt holding the next operation back, and says so on its port
    // (VIEW_FIRST_OVERRUN), for the host's one warning per environment (host.ts). The frame needs no budget of its own: one
    // overrun leaves at least 9 s of debt, so at most one is posted per 9 s. The second within the window: the view says
    // so on its port (VIEW_OVERRUN), once, and applies nothing more; the host ends the sandbox with the reason.
    let overran = false;
    const judge = (verdict: ViewVerdict) => {
        if (overran) return;
        if (verdict === 'overrun') {
            if (viewPort) viewPort.postMessage({ type: 'VIEW_FIRST_OVERRUN' });
            return;
        }
        if (verdict !== 'second-overrun') return;
        overran = true;
        pending = [];
        if (viewPort) viewPort.postMessage({ type: 'VIEW_OVERRUN' });
    };
    const hiddenOf = getter(Document.prototype, 'hidden');
    let visibilityChanges = 0;
    addEventListener('visibilitychange', () => { visibilityChanges++; }, true);
    const IDLE = 0, FRAME = 1, GAP = 2;
    let meter = IDLE; // FRAME: a frame is requested for the measure; GAP: the measure's task is pending
    let meterFrame = 0;
    let unmeasured = false; // a flush happened whose rendering no measure has covered yet
    let unmeasuredFlush = 0; // the longest of those flushes, in ms: the first part of their operation
    let inGap = 0; // ms of flushes that ran while the measure's task was pending, which they charged themselves
    const startGap = () => {
        unmeasured = false;
        const flushed = unmeasuredFlush;
        unmeasuredFlush = 0;
        inGap = 0;
        meter = GAP;
        const gapStart = performance.now();
        const visibility = visibilityChanges;
        setTimeout(() => {
            meter = IDLE;
            const now = performance.now();
            const rendering = now - gapStart - inGap;
            // the operation is the flush and this update; one whose flush alone overran was judged then (settleOperations),
            // and one operation is one overrun, so it is charged here and not judged again
            const shown = visibility === visibilityChanges && !call(hiddenOf, document, []);
            judge(budget.measured(rendering, flushed > options.maxOperation ? 0 : flushed + rendering, now, shown));
            if (unmeasured) measureRendering(false, 0); // a flush ran after the measure started: the next frame renders it
        }, 0);
    };
    // After a flush that took `ms`: `inFrame` when it ran inside a frame callback, so this frame renders it.
    const measureRendering = (inFrame: boolean, ms: number) => {
        unmeasured = true;
        if (ms > unmeasuredFlush) unmeasuredFlush = ms;
        if (meter === GAP) {
            inGap += ms;
            return;
        }
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
    // After operations that started at `started`: what they serialized and the time they took, layout included, are
    // charged, the operation checked against its limit, and its rendering measured next.
    const settleOperations = (started: number, inFrame: boolean) => {
        budget.charge('characters', work, performance.now()); // what the operations serialized (R2:C-4)
        work = 0;
        budget.charge('urls', urlWork, performance.now()); // the URL-bearing attributes they kept (R4:M-2)
        urlWork = 0;
        budget.prepay(cssWork, performance.now()); // what the CSS they applied can load (S73), before layout starts it
        cssWork = 0;
        layout();
        const now = performance.now();
        const spent = now - started;
        // what the flush took (R2:M-3), judged as soon as it is known: a flush past the limit is an overrun whether or not
        // its rendering is ever measured (a document hidden right after it)
        judge(budget.measured(spent, spent, now, true));
        measureRendering(inFrame, spent); // and what showing it takes
    };
    const flush = (inFrame: boolean) => {
        const jobs = pending;
        pending = [];
        scheduled = false;
        budget.charge('characters', costOf(jobs), performance.now());
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
                if (message === 'VIEW_MAX_ELEMENTS' || message === 'VIEW_MAX_DEPTH' || message === 'VIEW_MAX_CHARACTERS' || message === 'VIEW_MAX_URLS' || message === 'VIEW_MAX_DISTINCT_URLS' || message === 'VIEW_FOCUS') refused.push(message);
            }
        }
        settleOperations(started, inFrame);
        if (renderPort) renderPort.postMessage(refused.length > 0 ? { type: 'VIEW_ACK', refused } : { type: 'VIEW_ACK' });
    };
    const schedule = () => {
        if (scheduled || overran) return;
        scheduled = true;
        let ran = false;
        let frame = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const run = (inFrame: boolean) => {
            if (ran) return;
            ran = true;
            if (inFrame && timer !== null) clearTimeout(timer);
            if (!inFrame) cancelAnimationFrame(frame);
            if (overran) return;
            if (budget.owes(performance.now())) {
                // charged since this was scheduled (the rendering of the last flush, a load): wait for the budget again
                scheduled = false;
                schedule();
                return;
            }
            flush(inFrame);
        };
        const wait = budget.wait(costOf(pending), performance.now()); // what the budgets lack now, as a delay
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
            // A guest write the host recorded (R1:R4-4), answered once shown: the host tells the guest its write stands only
            // then, so a render after `await sandboxFiles.write()` finds the URL here.
            if (m && m.type === 'VIEW_WRITE' && typeof m.id === 'number') {
                showWrite(m.path, m.mime, m.bytes);
                viewPort!.postMessage({ type: 'VIEW_WRITTEN', id: m.id });
            }
        };
        // The Trusted Types probe (R2:C-6), before the check-in: where this document requires Trusted Types
        // (assigning a string to a sink throws a TypeError), the policy is created now, and a host page whose
        // trusted-types directive does not name it is told so, on this port, with the reason the element gives for it.
        // The host page may never have needed the policy itself (its own default policy took the element's strings, and
        // a default policy is the host page's object, not this document's), so only this side can find out. Without the
        // probe the refusal would surface later as "the guest entry failed to start", after 'ready'.
        if (!trustedTypesReady()) {
            viewPort.postMessage({ type: 'TRUSTED_TYPES_REFUSED' });
            return;
        }
        // The check-in (R1:R3-1): the first frame on the view port, which only this bootstrap holds. The
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
        // mints for raster-image guest writes (showWrite, R1:R4-4), the only blob: URLs the renderer keeps (A8).
        const entries = Array.isArray(data.viewFiles) ? data.viewFiles : [];
        const files = installFiles(entries);
        // the registered stylesheets a render can link or import: the still rules their text names (stillNamed)
        for (let i = 0; !switches.animations && i < entries.length; i++) {
            if (entries[i][1] !== 'text/css' || typeof entries[i][2] !== 'string') continue;
            try {
                const bytes = Uint8Array.from(atob(entries[i][2]), (c: string) => c.charCodeAt(0));
                stillNamed(new TextDecoder().decode(bytes));
            } catch {
                stillNamed('\\'); // not readable here: every rule
            }
        }
        viewFiles = new Map();
        minted = new Set();
        for (let i = 0; i < entries.length; i++) {
            const path = entries[i][0];
            const url = files.url(path);
            viewFiles.set(path, { url, type: String(entries[i][1]) }); // the type the store gave it, which its blob carries
            minted.add(url);
        }

        // The worker's source URL is revoked on the first message the worker sends on the render port (AR:C1).
        // Only the worker prelude can post there, and it first does so (VIEW_STARTED)
        // when it takes INIT_WORKER, which a worker handles only after its whole script (prelude, entry, marker)
        // has run: the source has been read and evaluated by then, and the entry's own errors have been raised.
        // From then on the URL resolves nowhere, so the view cannot load or fetch the worker's source: the
        // only blob: URLs left that rendered markup could name are the worker's copies of registered files and the
        // view's own, and the narrowed A8 guarantee, "the view renders no blob: content but registered files and
        // raster-image guest writes, decoded only" (R1:R4-4 adds the writes), holds by construction.
        // Revoking earlier (once the Worker object exists) is not possible: in WebKit the worker's
        // script has not been read yet, and every blob: URL it then minted is unreadable (sandboxFiles fails
        // with NotReadableError). Revoked at this point, Blob reads, fetches of the worker's own URLs, sandboxFiles and
        // execute() keep working on all three engines (test/e2e/strict-entry-scope-and-links.spec.ts).
        //
        // One thing is different, in WebKit only: inside the worker, an uncaught error thrown later by code from the
        // revoked script is muted ("Script error.", no error object), since WebKit cannot resolve the
        // script's URL to its origin; here, on the Worker object, the same error keeps its text. So the prelude
        // logs every later error it can describe itself and leaves a muted one to this document, which logs it
        // (GUEST_UNCAUGHT). WebKit mutes there the errors of code compiled from a string too (Function, eval:
        // execute() runs code so), and those from the first moment, before any revocation (measured).
        //
        // Which errors are the entry's own (they end the sandbox: GUEST_ERROR) is read from the order of one channel,
        // the Worker object's error events, which arrive in the order they were raised (S75, class B). The
        // line after the entry, once the entry ran to its end, raises the build's marker error (inStrictWorker), and
        // the prelude leaves it to reach this document: every error before it is the entry's, every error after it is
        // later. The end of the entry is not read from VIEW_STARTED, on the render port, a second channel: that would
        // predict that an error which reaches this document before it can only be the entry's (a muted one
        // needs the revocation, which follows VIEW_STARTED), and WebKit refutes the prediction: a muted error of code
        // compiled from a string reaches the Worker object before VIEW_STARTED reaches the render port, on a loaded
        // machine (execute()'s `setTimeout(() => { throw … })`, 2–3 runs in 100–200) and always (an entry's
        // queueMicrotask of such code, 8 in 8), and the sandbox would end with "the guest entry failed to start"
        // although the entry had run to its end.
        // A guest that throws the marker's text itself (it can read the marker's name, as it could always call the
        // marker early: BR:ST4) only spares its own entry the end it would have had; it can make no later error end
        // the sandbox, since an error it raises after the marker is later whatever its text.
        // The guest's error texts this document relays (R3:C-4): GUEST_ERROR, the entry's own error, and
        // GUEST_UNCAUGHT, a later one the worker could not describe itself (above). Both are the guest's words, and every
        // one of them leaves through here, bounded before it is posted, as the console relay bounds every other guest
        // line in the guest before posting it (in-sandbox-script.ts): cut to guestText.maxLength characters, and at most
        // guestText.perSecond in any one-second window (the host's window for guest lines), past which they are dropped
        // here. Crossing whole, to be cut by the host after receiving it, would let an error thrown with a message of
        // hundreds of millions of characters stall the host page 0.6–1.4 s, and a worker throwing in a loop post
        // without bound. Not through the worker's relay, the same chokepoint otherwise: the entry's error can mean the
        // worker never ran (it did not parse), and GUEST_UNCAUGHT exists for the errors the worker cannot describe.
        // The window keeps the times of the last `perSecond` texts in a ring: the oldest of them is at `textsHead`.
        // The first text dropped is said, once (R4:M-5): GUEST_TEXT_DROPPED, which the host turns into one
        // warn line, as the console relay says its own drops. WebKit raises every later uncaught error of the worker here
        // (its script's URL is revoked, above), so without the line a guest that throws in a loop would lose lines there
        // without a word.
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
            viewPort!.postMessage({ type, message: cutText(text, options.guestText.maxLength) });
        };

        // The characters of the uncaught errors that reach this document, in any one-second window, against the budget the
        // worker keeps of the ones it sees (egress.ts, UNCAUGHT_CHARACTERS_PER_SECOND; in-sandbox-script.ts). The worker
        // counts what its own error event says, and WebKit mutes there the error of a revoked script or of code compiled
        // from a string ("Script error."), so the text of such an error is counted here, where it is visible, in the same
        // window: an error is charged by the length of its text on every engine. Past the window the view tells the host
        // once (UNCAUGHT_PAST_BUDGET), which ends the sandbox with the reason of the worker's own count.
        const uncaughtTimes: number[] = [];
        const uncaughtSizes: number[] = [];
        let uncaughtHead = 0;
        let uncaughtTotal = 0;
        let uncaughtPast = false;
        const countUncaught = (characters: number) => {
            if (uncaughtPast) return;
            const now = performance.now();
            while (uncaughtHead < uncaughtTimes.length && uncaughtTimes[uncaughtHead]! <= now - 1000) {
                uncaughtTotal -= uncaughtSizes[uncaughtHead]!;
                uncaughtHead++;
            }
            if (uncaughtTotal + characters <= options.guestText.uncaughtCharacters) {
                uncaughtTimes.push(now);
                uncaughtSizes.push(characters);
                uncaughtTotal += characters;
                if (uncaughtHead > 64 && uncaughtHead * 2 > uncaughtTimes.length) { // drop what left the window, now and then
                    uncaughtTimes.splice(0, uncaughtHead);
                    uncaughtSizes.splice(0, uncaughtHead);
                    uncaughtHead = 0;
                }
                return;
            }
            uncaughtPast = true;
            viewPort!.postMessage({ type: 'UNCAUGHT_PAST_BUDGET' });
        };

        let sourceUrl: string | null = null;
        let started = false;
        // The build's marker (entryDoneName), whose error says the entry ran to its end; '' (a malformed INIT_VIEW)
        // matches no error, so then every error is the entry's, the side that ends the sandbox.
        const entryDoneGiven = data.entryDone;
        const entryDone = typeof entryDoneGiven === 'string' ? entryDoneGiven : '';
        let entryRan = false;
        const channel = new MessageChannel();
        renderPort = channel.port1;
        renderPort.onmessage = (event: MessageEvent) => {
            if (!started) {
                started = true;
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
        // the sandbox, and later ones the worker could not describe (muted, above), which are logged; the marker
        // between them (above) is neither. An error event with no message before the marker says only that its
        // script did not run: either it was not loaded
        // at all (all three engines, for a host page's worker-src without blob:; WebKit under the host page's
        // Cross-Origin-Embedder-Policy) or it did not parse (Firefox gives a syntax error no message). A probe worker
        // of one statement tells which (R1:R3-1): if it cannot run either, the policy refuses blob: workers and nothing of
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
            const text = error.message;
            // The marker, looked for only until it came, and only where the engines put it (`Uncaught Error: <name>`,
            // `Error: <name>`): a later error of 16 Mi characters is not searched (an error flood is the guest's, and this
            // runs on the thread the view shares with the host page; R4:M-1 measures it on WebKit).
            if (!entryRan && entryDone !== '' && typeof text === 'string' && text.slice(0, entryDone.length + 64).indexOf(entryDone) !== -1) {
                entryRan = true; // the marker: the entry ran to its end; not a guest error, so not logged
                error.preventDefault();
                return;
            }
            if (!entryRan && !text) {
                probe((refused) => {
                    if (refused) viewPort!.postMessage({ type: 'WORKER_REFUSED' });
                    else toHostGuestText('GUEST_ERROR', 'the entry did not parse (this browser gives no detail)');
                });
                return;
            }
            const message = String(text || 'the worker failed');
            if (!entryRan) {
                toHostGuestText('GUEST_ERROR', message);
                return;
            }
            error.preventDefault();
            toHostGuestText('GUEST_UNCAUGHT', message);
            countUncaught(message.length);
        };
        worker!.postMessage({ type: 'INIT_WORKER' }, [logicPort, channel.port2]);

        observeBody();
        observeLoads();
        const initial = data.html;
        if (typeof initial === 'string' && initial !== '') {
            budget.charge('characters', initial.length, performance.now()); // the initial view is charged like any render (R1:R1-1)
            work = 0;
            const started = performance.now();
            try {
                apply(initial, null);
            } catch {
                // past the budget, or anything else the renderer refused: the initial view stays empty
            }
            settleOperations(started, false);
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
export function inStrictWorker(comms: { attach(port: MessagePort): void; log(level: 'log' | 'info' | 'warn' | 'error', args: unknown[]): void }, options: { scriptUnsafe: boolean; maxRender: number; maxTarget: number; maxElements: number; maxDepth: number; maxCharacters: number; maxUrls: number; maxDistinctUrls: number; entryDoneName: string; eventTypes: readonly string[] }) {
    // ---- The captured list (AR:C3, R2:C-1): sandboxView's methods, the render port's listener and the
    // error listener run after the entry, so everything they use is taken here, and nothing below reads a global or a
    // prototype guest code can replace (a unit test scans the text). The prelude's own lists have no prototype
    // (AR:C3): an index written to them never reaches an inherited setter, so guest code that defines one on Array.prototype
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
    // The error event's own fields, read through the getters of ErrorEvent.prototype as they are at the capture point
    // (R5:N-2; class G): guest code can replace the prototype's accessors, so the listener below never reads them through
    // the event. A captured getter returns what the browser stored in the event, and runs no guest code.
    const errorEventError = getOwn(ErrorEvent.prototype, 'error')!.get!;
    const errorEventMessage = getOwn(ErrorEvent.prototype, 'message')!.get!;
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
    // "Uncaught …" once (R1:R4-7): Chromium's ErrorEvent message already starts with it.
    const uncaught = (text: string) => (apply(startsWith, text, ['Uncaught ']) ? text : 'Uncaught ' + text);

    // A name that stays after its deletion is a failure, not something to carry on with (AR:C2): a top-level
    // declaration of the entry could make a global non-configurable before this runs.
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
    // a queued one of the same slot is taken out, and the new one goes to the end (R2:C-9: replacing the
    // queued one in place would put the new one ahead of what was queued after it, so [render A into x, set y, render B
    // into x] would apply the set after B). A set is merged only into a set of the same id queued right before it. So the operations that
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
            const keys = keysOf(operation.message); // indexed, never iterated: guest code can replace the array iterator (AR:C3)
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
    // guest escapes nothing (R1:R4-5). Bounded like a render: VIEW_RENDER_MAX_LENGTH, and the view's
    // character budget and rate.
    const text = (id: unknown, value: unknown) => {
        if (!isId(id)) throw new TypeErrorConstructor('sandboxView.text: id must be an element id');
        if (typeof value !== 'string') throw new TypeErrorConstructor('sandboxView.text: text must be a string');
        if (value.length > options.maxRender) throw new RangeErrorConstructor('sandboxView.text: text is longer than ' + options.maxRender + ' characters');
        enqueue({ slot: 'content#' + id, kind: 'text', message: { type: 'VIEW_TEXT', into: id, text: value } });
    };
    // A form control's value or checked state, or focus (R1:R4-5). Each own enumerable field of `fields` is read once,
    // and only these three are allowed, each of its one type; what is posted is a fresh object of those primitives.
    const set = (id: unknown, fields: unknown) => {
        if (!isId(id)) throw new TypeErrorConstructor('sandboxView.set: id must be an element id');
        if (fields === null || typeof fields !== 'object' || isArray(fields)) throw new TypeErrorConstructor('sandboxView.set: the second argument must be an object: { value?, checked?, focus? }');
        const message: Record<string, unknown> = setPrototype({ type: 'VIEW_SET', id }, null); // no inherited setter for a key (AR:C3)
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
            // what the view refused of the one operation in flight (an operation past the view's budget, BR:ST2;
            // focus without the user's focus, R1:R4-5): said here, to the guest's own log
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
                            : refused[i] === 'VIEW_MAX_DISTINCT_URLS'
                                ? 'the view would load more than ' + options.maxDistinctUrls + ' distinct URLs in this environment'
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
        // Always the first frame on the render port: the view revokes the worker's source URL on it (AR:C1).
        // Before attach(), so it precedes everything. Which errors were the entry's is not said here: the marker
        // error says it in the order of the errors themselves (the entry failure, below).
        apply(post, renderPort, [{ type: 'VIEW_STARTED' }]);
        attach(ports[0]);
        syncListen();
        sendNext();
    }, true]);

    // ---- entry failure ----
    // An uncaught error while the entry runs (before the line after it calls the marker) is left alone: it
    // reaches the Worker object in the view, which reports GUEST_ERROR, and the host ends the sandbox. The marker
    // ends the entry with an error of its own, the build's marker error (its message is the marker's name, which the
    // view is given in INIT_VIEW), and leaves it alone too: on the Worker object, whose errors arrive in the order they
    // were raised, it is the line between the entry's errors and the later ones (S75, class B; the view's
    // comment on the worker's errors says why not VIEW_STARTED). It is stopped here, so no listener of the guest's sees
    // it. If the entry threw, the marker never runs: every error then is the entry's, and ends the sandbox.
    // Every later uncaught error is cancelled here and logged, so it never ends the sandbox, except one the browser
    // muted here: in WebKit, once the view has revoked the worker's source URL (AR:C1), an error thrown by code
    // from that script reads "Script error." in the worker, while the Worker object in the view still gets its text;
    // and so, from the start, does one thrown by code compiled from a string (Function, eval: execute()). Such an
    // error is left to the view, which logs it.
    // The event's fields are read only through the getters captured above (R5:N-2): the event's own
    // accessors are the guest's to replace, and a replaced one could make any error look muted, so that it reached the
    // view uncancelled, or throw, so that the listener stopped before it cancelled (Firefox then ended the sandbox as
    // if the entry had failed). The captured getters cannot be replaced, cannot throw for a trusted ErrorEvent, and the
    // reads are in a try/catch besides: anything unexpected is not muted, so it is cancelled. The one decision taken
    // before cancelling, "is it muted", reads nothing guest code can change; everything else is read after it.
    let entryRan = false;
    // Its text on the Worker object is the engine's "name: message"; both are its own, so no prototype the guest can
    // change takes part in it.
    const marker = new ErrorConstructor(options.entryDoneName);
    defineOwn(marker, 'name', { value: 'Error' });
    const isMarker = (event: ErrorEvent) => {
        try {
            return apply(errorEventError, event, []) === marker;
        } catch {
            return false;
        }
    };
    const isMuted = (event: ErrorEvent) => {
        try {
            return apply(errorEventError, event, []) === null && apply(errorEventMessage, event, []) === 'Script error.';
        } catch {
            return false;
        }
    };
    const messageOf = (event: ErrorEvent) => {
        try {
            return StringConstructor(apply(errorEventMessage, event, []));
        } catch {
            return 'an error';
        }
    };
    apply(addListener, g, ['error', (event: ErrorEvent) => {
        if (!event.isTrusted) return; // isTrusted is an own, unforgeable property; only trusted errors reach the view
        if (!entryRan) return;
        if (isMarker(event)) {
            apply(stopImmediate, event, []);
            return;
        }
        if (isMuted(event)) return;
        apply(cancel, event, []);
        log('error', [uncaught(messageOf(event))]);
    }, true]);
    // Reported at once (reportError): an error thrown at the end of the script is reported only after the microtasks
    // the entry queued have run in Firefox and WebKit (measured), so an error of theirs reached the view before it.
    defineOwn(g, options.entryDoneName, {
        value: () => {
            entryRan = true;
            if (reportUncaught) apply(reportUncaught, g, [marker]);
            else throw marker;
        },
    });
}

/**
 * The first thing the strict worker runs (AR:C2). Stringified; self-contained.
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
 * marker the line after the entry calls, which is why the marker's name is drawn per build (entryDoneName, BR:ST4):
 * the entry's text, fixed before the build, cannot name it.
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
    rates: { characters: VIEW_RENDER_CHARACTERS_PER_SECOND, time: VIEW_APPLY_MS_PER_SECOND, urls: VIEW_URLS_PER_SECOND },
    maxOperation: VIEW_MAX_OPERATION_MS,
    overrunWindow: VIEW_OVERRUN_WINDOW_MS,
    maxDistinctUrls: VIEW_MAX_DISTINCT_URLS,
    violationLimit: 100, // VIOLATION_EVENT_LIMIT (violation.ts); a test keeps them equal
    violationDirectives: VIOLATION_DIRECTIVES,
    violationMaxString: 2048, // VIOLATION_MAX_STRING (violation.ts); a test keeps them equal
    events: { types: VIEW_EVENT_TYPES, ...VIEW_EVENT_LIMITS },
    trustedTypesPolicy: TRUSTED_TYPES_POLICY,
    writeTypes: VIEW_WRITE_TYPES,
    // the host cuts these texts to the same length again on receipt (host.ts), and dispatches at most
    // LOG_EVENTS_PER_SECOND guest lines in any one second
    guestText: { maxLength: 2048, perSecond: LOG_EVENTS_PER_SECOND, uncaughtCharacters: UNCAUGHT_CHARACTERS_PER_SECOND },
    stillStyle: VIEW_STILL_STYLE,
    still: { pseudoElements: VIEW_STILL_PSEUDO_ELEMENTS, declarations: VIEW_STILL_DECLARATIONS },
};

let cachedText: string | null = null;
let cachedHash: string | null = null;

/**
 * What viewScriptHash() warns, once, when the library runs from its sources and not from the built package (BD3:NEW-1):
 * the bootstrap's text is then the functions as the bundler or runtime prints them, so the hash differs between a build
 * step and the page's bundle of the same sources, and the page's policy would refuse the view's startup script.
 */
export const SOURCES_HASH_WARNING = "viewScriptHash() was computed from the library's sources, not from the built package: a bundler prints the bootstrap's functions its own way, so a build step that imports the sources gets another hash than the page that runs them, and a host policy that lists it refuses the view's startup script. Import the built package (dist/index.js, `bun run build:lib`), or read this value in the page that runs the sources (docs/API.md#host-page-policy).";
let warnedSourcesHash = false;

/**
 * The role attribute of the bootstrap's script element in the fetch bridge's frame (bridge-frame.ts,
 * buildBridgeDocument). The library has one hashed bootstrap, so one hash in the host page's policy admits both of its
 * documents (BD1:ISO-1): in a script element with this attribute it runs the bridge's frame (in-bridge-frame.ts), in any
 * other the view. The attribute is outside the hashed text, and both documents are the library's own, built before any
 * guest byte exists.
 */
export const BRIDGE_ROLE = 'fetch-bridge';

/**
 * The environment gate (S74, environment-check.ts): `body` wrapped so that it runs only in the document the library
 * built. The gate is the one statement of the text it starts: the check first, given the expected values as one literal,
 * `host` (the expression for the host page's window, which a refusal is posted to) and whether to stop the document's
 * parser on a refusal; everything else of the bootstrap is inside the block.
 */
export function environmentGate(host: string, stopParsing: boolean, body: string): string {
    return `if ((${checkSandboxEnvironment.toString()})(${JSON.stringify(ENVIRONMENT_EXPECTED)}, ${host}, ${stopParsing}) === null) {${body}}`;
}

/**
 * The bootstrap's text for `options`, built from the functions it runs (the tests build it with other options): strict
 * mode's view, or the fetch bridge's frame where its script element has the bridge's role (BRIDGE_ROLE).
 */
export function viewBootstrapSource(options: ViewOptions): string {
    const script = 'var s = document.currentScript;';
    const bridge = `(${inBridgeFrame.toString()})(${JSON.stringify(BRIDGE_FRAME_OPTIONS).replaceAll('<', '\\u003c')});`;
    const view = `(${inSandboxView.toString()})(${inSandboxFiles.toString()}, ${sanitizeRender.toString()}, ${viewBudget.toString()}, ${cssLoadBound.toString()}, ${cssReferences.toString()}, ${withoutNetworkReferences.toString()}, ${JSON.stringify(options).replaceAll('<', '\\u003c')});`;
    // The gate first (environment-check.ts): a refusal goes to the host page's window, which is the bridge frame's parent and
    // the view's grandparent.
    const host = `(document.currentScript && document.currentScript.getAttribute('data-role') === '${BRIDGE_ROLE}' ? parent : parent.parent)`;
    return `(function () {${environmentGate(host, false, `${script} if (s && s.getAttribute('data-role') === '${BRIDGE_ROLE}') {${bridge}} else {${view}}`)}})();`;
}

/**
 * The view bootstrap as one string literal, in the published bundle (R2:C-8): scripts/build-lib.ts builds
 * the text below once, from the sources, and bundles it in as this constant. The text that is hashed is then a value of
 * the package, not the text of its functions as wherever the bundle runs prints them: a consumer's bundler or minifier
 * rewrites functions and leaves a string's value alone, so the hash an embedder computes in a build step (Node or Bun,
 * importing the package) is the one the browser computes for the script the element injects. Hashing the functions'
 * Function.prototype.toString() would give one hash plain and another minified, and a host page that listed
 * the build-time hash would end with "the sandbox's startup script did not run". Undefined where the sources run unbundled
 * (the dev server, the unit tests): there the text is built from the functions, as it always matches the page serving it. A consumer that
 * bundles the sources has no literal either: its transpiler prints the functions its own way, so a build step that
 * imports the sources computes another hash than the page's bundle does. viewScriptHash() says so (BD3:NEW-1).
 */
declare const __WEB_SANDBOX_VIEW_BOOTSTRAP__: string | undefined;

/**
 * The view bootstrap's text: constant for this page, built once. Throws if it could not be hashed as written (A3): a CR
 * or NUL, or anything that ends a script element.
 */
export function viewBootstrapText(): string {
    if (cachedText !== null) return cachedText;
    const text = typeof __WEB_SANDBOX_VIEW_BOOTSTRAP__ === 'string' ? __WEB_SANDBOX_VIEW_BOOTSTRAP__ : viewBootstrapSource(VIEW_OPTIONS);
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
 * The CSP hash source of the library's bootstrap for this release of the package, to allow in the host page's own
 * Content-Security-Policy (R1:R4-5): strict mode's view runs it, and so does the fetch bridge's frame.
 *
 * @remarks
 * It is the very value the element puts in the `script-src` of both documents, and both inherit the host page's policy
 * (docs/API.md#host-page-policy), so one hash admits them both: the view in strict mode, and with `fetchBridge` the
 * frame that makes the bridge's requests, in every mode (BD1:ISO-1). In the built package the bootstrap is a string
 * literal of the bundle, so the hash is the same in a build step (importing the package needs no DOM) and in the browser,
 * however the embedder's app is bundled or minified. It changes only with the package's version.
 *
 * The sources have no such literal: a project that bundles `src/index.ts` (not the built package) gets the hash of the
 * functions as its own transpiler prints them, which a build step that imports the sources does not compute. There the
 * value is right only where it is read, in the page that runs the sources, and the first call in a process or page
 * warns (BD3:NEW-1).
 *
 * @returns The hash source, `'sha256-…'`, quotes included.
 */
export function viewScriptHash(): string {
    if (typeof __WEB_SANDBOX_VIEW_BOOTSTRAP__ !== 'string' && !warnedSourcesHash) {
        warnedSourcesHash = true;
        console.warn(SOURCES_HASH_WARNING);
    }
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
