/**
 * The texts the element gives (S76): every `terminated` reason, the refusals start() throws for options it cannot take
 * as a whole, and every line it dispatches as `sandbox-log` itself, declared once, with what causes it and where it is
 * decided. host.ts, the lifecycle reducer (lifecycle.ts), start()'s reading (app-start.ts) and the config schema take
 * their texts from here; docs/API.md's reasons tables and its host lines are this registry, which
 * test/unit/api-docs.test.ts keeps equal.
 *
 * A text with `…` varies there (an error's name, a note of the library's, a reason): `reasonText()` and `hostLine()` put
 * the detail in its place, and the type system asks for one exactly where the text has a `…`. A reason's detail is a
 * LibraryDetail, which only the library's own producers make (BD5:DOC-2, class C): an error's name as `errorName()`
 * filters it, or a fixed text of the library's. A value of the config (the entry, the mode) or of the guest is a plain
 * string, which does not compile there: a reason names the problem, never the value, so `terminated.reason` is safe to
 * show as text whatever the configuration came from.
 */
import { VIEW_MAX_OPERATION_MS, VIEW_OPTIONS, VIEW_OVERRUN_WINDOW_MS, VIEW_RENDER_MAX_LENGTH } from './in-sandbox-view';
import { LOG_EVENTS_PER_SECOND } from './sandbox-log';
import { TRUSTED_TYPES_POLICY } from './trusted-types';
import { NETWORK_MODES_FLAG } from './build-flag';
import { MAX_LINK_LENGTH } from './links';
import { SEALED_DOCUMENT_FILE } from './frame-documents';

export interface ReasonRow {
    /** The reason, with `…` where it varies. */
    readonly text: string;
    /**
     * Where it is decided: the element (host.ts) or the lifecycle reducer (lifecycle.ts), as a `terminated` reason; or
     * start() or defineWebSandbox(), as the message of the TypeError it throws, which is never a termination.
     */
    readonly decidedBy: 'host' | 'lifecycle' | 'start' | 'define';
}

// The repeated-overrun rule in words (in-sandbox-view.ts, viewBudget; S72, class P).
const OVERRUN_MS = VIEW_MAX_OPERATION_MS;
const OVERRUN_MINUTES = VIEW_OVERRUN_WINDOW_MS / 60000;
const HOST_PAGE_POLICY = 'see docs/API.md#host-page-policy';
const REGISTRATION = 'see docs/API.md#registering-the-element';

export const TERMINATION_REASONS = {
    host: { text: 'terminated by the host', decidedBy: 'host' },
    watchdog: { text: 'the guest stopped responding (watchdog)', decidedBy: 'host' },
    entryFailed: { text: 'the guest entry failed to start', decidedBy: 'host' },
    startupBlocked: { text: `the sandbox's startup script did not run: the host page's Content-Security-Policy must allow it (${HOST_PAGE_POLICY})`, decidedBy: 'lifecycle' },
    // The host page's policies bind the library's frames, which inherit them as srcdoc documents (CSP3 copies the policy
    // list; Trusted Types; COEP; R1:R3-1): each reason of a refusal names the policy, so the embedder knows what to allow.
    workerRefused: { text: `the sandbox's worker could not be loaded: the host page's policy refuses blob: workers (worker-src, or a Cross-Origin-Embedder-Policy the engine applies to it; ${HOST_PAGE_POLICY})`, decidedBy: 'host' },
    trustedTypes: { text: `the host page's Trusted Types policy does not allow the policy name '${TRUSTED_TYPES_POLICY}' (trusted-types; ${HOST_PAGE_POLICY})`, decidedBy: 'host' },
    // The environment check (environment-check.ts, S74): a bootstrap found its document different from the one the library
    // built, stayed inert, and said so; one reason for each row of its table (ENVIRONMENT_CHECKS).
    environmentOrigin: { text: "the sandbox document's origin is not opaque: it is not running in the frame the library built", decidedBy: 'host' },
    environmentUrl: { text: 'the sandbox document is not an about:srcdoc document: it is not the document the library built', decidedBy: 'host' },
    environmentBase: { text: `the sandbox document's base URL is not about:blank: the host page's Content-Security-Policy must allow the library's <base> (base-uri must include about: or be omitted; ${HOST_PAGE_POLICY})`, decidedBy: 'host' },
    environmentIsolated: { text: `the host page is cross-origin isolated (COOP and COEP); a sandbox does not run there (${HOST_PAGE_POLICY})`, decidedBy: 'host' },
    entryNotRegistered: { text: 'the guest entry is not a registered JavaScript file', decidedBy: 'host' },
    entryImport: { text: 'the guest entry calls import() or a phase of it (import.source()), which loads nothing in strict and sealed mode: bundle its modules into the entry', decidedBy: 'host' },
    viewLost: { text: 'the sandbox view stopped responding', decidedBy: 'host' },
    viewOverrun: { text: `the view spent more than ${OVERRUN_MS} ms on one operation twice within ${OVERRUN_MINUTES} minutes`, decidedBy: 'host' },
    unknownMode: { text: 'unknown mode: not strict, sealed, cooperative or worker…', decidedBy: 'start' },
    networkModesOff: { text: `strict, cooperative and worker mode, origins and fetchBridge are the network modes, which this build of the package does not have: build it with ${NETWORK_MODES_FLAG.env}=${NETWORK_MODES_FLAG.on} (${NETWORK_MODES_FLAG.command})`, decidedBy: 'start' },
    sealedNetwork: { text: "origins and fetchBridge open the network, which sealed mode (the default) does not have: set `mode: 'strict'`", decidedBy: 'start' },
    sealedScriptUnsafe: { text: `scriptUnsafe runs strings as code, which sealed mode (the default) does not: set \`mode: 'strict'\`, in a build with the network modes (${NETWORK_MODES_FLAG.env}=${NETWORK_MODES_FLAG.on})`, decidedBy: 'start' },
    htmlTooLong: { text: `html is longer than ${VIEW_RENDER_MAX_LENGTH} characters, the most the view renders at once: render the rest from the entry`, decidedBy: 'start' },
    // `links` (links.ts): the rule a list breaks, in the library's words (LINK_RULES), never the URL
    linksRefused: { text: 'links is refused: …', decidedBy: 'start' },
    configRefused: { text: 'the configuration could not be used (…)', decidedBy: 'start' },
    buildFailed: { text: 'the environment could not be built (…)', decidedBy: 'host' },
    executionTimeout: { text: 'the executed code ran longer than workerExecutionTimeout', decidedBy: 'host' },
    secondLoad: { text: 'the sandbox frame loaded a second time', decidedBy: 'lifecycle' },
    secondAnnouncement: { text: 'the guest frame announced itself again (it reloaded or rewrote its document)', decidedBy: 'lifecycle' },
    loadTimeout: { text: 'the sandbox did not finish loading', decidedBy: 'lifecycle' },
    frameMissing: { text: 'the guest frame is missing', decidedBy: 'lifecycle' },
    uncaughtBudget: { text: 'the guest raised more uncaught errors or unhandled rejections in one second than their budget allows', decidedBy: 'host' },
    // Sealed mode's view is the served file (design 03): the frame of documentUrl, whose view speaks first
    documentSilent: { text: `the document at documentUrl did not answer: the file is missing, the server answers its path with another page, a header on it refuses the framing or the view's script, or the host page's frame-src does not admit it (${REGISTRATION})`, decidedBy: 'lifecycle' },
    // The check of the file (document-check.ts; design 03): what the element read of documentUrl's answer, where it could
    // read it, before it framed the file. One reason per finding, and one per refused header, by the header's name.
    documentMissing: { text: `the file at documentUrl is missing: … (${REGISTRATION})`, decidedBy: 'host' },
    documentChanged: { text: `the file at documentUrl is not this version's ${SEALED_DOCUMENT_FILE}: its bytes differ from the library's. It is another version's, or a tool rewrote it (a dev server that inserts its client's script, such as Vite's; a bundler that processes HTML, such as webpack's HTML support or Parcel; a minifier; a CDN that rewrites pages), or a cache holds an old copy: serve the package's file unchanged (${REGISTRATION})`, decidedBy: 'host' },
    documentFrameAncestors: { text: `the file at documentUrl is served with a frame-ancestors directive (in a Content-Security-Policy header): serve it without one (${REGISTRATION})`, decidedBy: 'host' },
    documentFrameOptions: { text: `the file at documentUrl is served with an X-Frame-Options header: serve it without one (${REGISTRATION})`, decidedBy: 'host' },
    documentCsp: { text: `the file at documentUrl is served with a Content-Security-Policy header, which the view would run under beside its own policy: serve it without one (${REGISTRATION})`, decidedBy: 'host' },
    documentCspReportOnly: { text: `the file at documentUrl is served with a Content-Security-Policy-Report-Only header, which would report the view's loads to its endpoint: serve it without one (${REGISTRATION})`, decidedBy: 'host' },
    noDocumentUrl: { text: `sealed mode's view is the served ${SEALED_DOCUMENT_FILE}, and this element was registered without documentUrl: pass it to defineWebSandbox() (${REGISTRATION})`, decidedBy: 'start' },
    // defineWebSandbox(): the definition, read before anything is defined or stored
    definitionRefused: { text: 'defineWebSandbox() takes one object, { tagName, documentUrl }, whose tagName is a string when given', decidedBy: 'define' },
    documentUrlMissing: { text: `documentUrl is required: the URL where the page serves ${SEALED_DOCUMENT_FILE}, the view of sealed mode (${REGISTRATION})`, decidedBy: 'define' },
    documentUrlRefused: { text: 'documentUrl is refused: …', decidedBy: 'define' },
    documentUrlChanged: { text: 'the element is already defined with another documentUrl', decidedBy: 'define' },
} as const satisfies Record<string, ReasonRow>;

export type ReasonId = keyof typeof TERMINATION_REASONS;

/** What causes each reason, as docs/API.md's reasons table says it. The docs' only: a function, so a bundle leaves it out. */
export const reasonCauses = () => ({
    host: '`terminate()` without a reason, or with an empty one (or with your own text instead).',
    watchdog: '`watchdogTimeout` expired.',
    entryFailed: 'Strict and sealed mode: the entry threw or did not parse.',
    startupBlocked: "The frame loaded but the library's startup script (strict mode's view bootstrap, cooperative and worker mode's bootstrap) never checked in: the host page's policy refused it. See [Host page policy](#host-page-policy).",
    workerRefused: "Strict, sealed and worker mode: the worker's script could not be loaded at all; nothing of the guest's ran. Worker mode is never `ready` then.",
    trustedTypes: `The host page enforces Trusted Types and its \`trusted-types\` directive does not name \`${TRUSTED_TYPES_POLICY}\`, also when the host page's own default policy takes the element's strings (the view and worker mode's frame need the policy themselves).`,
    environmentOrigin: "A bootstrap of the library's (strict mode's view, the cooperative guest's document, worker mode's frame, the fetch bridge's frame) read an origin other than `'null'`: its document is not in a frame the library sandboxed as built. It stayed inert, so nothing of the guest's ran.",
    environmentUrl: "A bootstrap of the library's read a document URL other than `about:srcdoc`: its document is not the srcdoc the library wrote. It stayed inert, so nothing of the guest's ran.",
    environmentBase: "A bootstrap of the library's read a base URL other than `about:blank`: the host page's `base-uri` refused the `<base>` the library's wrapper sets, so the sandbox would have seen the host page's URL. It stayed inert, so nothing of the guest's ran. Allow `about:` in `base-uri`, or omit the directive (see [Host page policy](#host-page-policy)).",
    environmentIsolated: "The host page reads `crossOriginIsolated === true` (it sends both `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`), and a guest never runs cross-origin isolated, on any engine. The element builds no frame (a bootstrap of the library's that reads it in its own document stays inert too), so nothing of the guest's ran. Serve the page that embeds a sandbox without COOP and COEP (see [Host page policy](#host-page-policy)).",
    entryNotRegistered: 'Strict and sealed mode: `entry` names no registered JavaScript file.',
    entryImport: "Strict and sealed mode: the entry's text holds `import` followed by `(` or `.` (after any whitespace and comments), in code, a string or a comment: an `import()`, or a phase of one (`import.source()`, `import.defer()`); a static import and `import.meta` do not compile in the worker's classic script. The worker's policy admits no module script, so an import could load nothing, and the host page's policy, which the worker inherits, would report the URL it named to the page's report endpoint; the build refuses the entry instead, and nothing of the guest's runs. Bundle the modules into the entry, and keep `import(` and `import.` out of its strings and comments.",
    viewLost: 'Strict and sealed mode: the view did not answer for `VIEW_LIVENESS_TIMEOUT_MS` (always on).',
    viewOverrun: `Strict and sealed mode: an operation of the view (a render, \`text()\` or \`set()\` applied, with its layout and the rendering update that showed it) took longer than ${OVERRUN_MS} ms, measured as the view's time budget measures it, and another one had, at most ${OVERRUN_MINUTES} minutes before it. The first such operation only logs a \`warn\` line (see [\`sandbox-log\`](#sandbox-log--sandboxlog)); see [\`sandboxView\`](#sandboxview-strict-mode).`,
    unknownMode: `\`mode\` is not \`strict\`, \`sealed\`, \`cooperative\` or \`worker\`. For \`'iframe'\` the reason goes on \` ('iframe' was renamed 'cooperative')\`, and in a build without the network modes ([Builds](#builds)) it ends \`; this build has sealed mode alone (${NETWORK_MODES_FLAG.env}=${NETWORK_MODES_FLAG.on} builds the others)\`; otherwise nothing follows.`,
    networkModesOff: `The package was built without the network modes (the default: [Builds](#builds)), and the grants name \`mode: 'strict'\`, \`'cooperative'\` or \`'worker'\`, or \`origins\` or \`fetchBridge\` (with any value but \`undefined\`). Such a build has sealed mode alone; build the package with \`${NETWORK_MODES_FLAG.env}=${NETWORK_MODES_FLAG.on}\` for the others.`,
    sealedNetwork: "In a build with the network modes: `mode` is `'sealed'` or left out (sealed mode is the default), and the grants name `origins` or `fetchBridge` (with any value but `undefined`).",
    sealedScriptUnsafe: "`mode` is `'sealed'` or left out, and `scriptUnsafe` is `true`. A string run as code is checked against the host page's policy, which the guest's worker inherits, and a refusal reports the page's policy text to the guest and the string to the page's report endpoint; sealed mode runs none, and strict mode, which runs them, is one of the network modes ([Builds](#builds)).",
    htmlTooLong: `Strict and sealed mode: the app's \`html\` is longer than \`VIEW_RENDER_MAX_LENGTH\` (${VIEW_RENDER_MAX_LENGTH}) characters, the most one render takes (the initial view is one). It is refused before anything reads it. Render the rest from the entry, in renders of that size.`,
    linksRefused: `The grant \`links\` breaks one of its rules, which the reason names after the colon: a list, of at most \`MAX_LINKS\` entries, each a string of at most ${MAX_LINK_LENGTH} characters that parses as a URL, has the scheme \`https:\`, has no user name or password and is equal to its own serialisation (\`new URL(entry).href\`), no two equal. Nothing of the list is kept.`,
    configRefused: "An option's rule failed on its value with an error that is not one of start()'s own refusals (each of which says the option and what it takes); the error's name follows, as in `(RangeError)`.",
    buildFailed: 'Building the frame failed.',
    executionTimeout: "The guest's event loop was still busy `EXECUTION_TIMEOUT_GRACE_MS` after an `execute()` deadline.",
    secondLoad: "Something navigated or reloaded the library's frame (also before its first load, once the guest had checked in).",
    secondAnnouncement: 'Cooperative and worker mode: the guest frame announced a second port (it reloaded itself, rewrote its document so the bootstrap ran again, or posted a forged announcement), or announced one where no bootstrap runs.',
    loadTimeout: 'The build was still `loading` after `LOAD_TIMEOUT_MS` of host time and its frame had not loaded (without `allow-scripts`: subresources included).',
    frameMissing: "The library's frame has no guest frame.",
    uncaughtBudget: 'Worker, strict and sealed mode: past the budget of uncaught errors and rejections (see [`sandbox-log`](#sandbox-log--sandboxlog) and [Limits](#limits)).',
    documentSilent: "Sealed mode: no view announced itself from the first frame of the element's frame within `LOAD_TIMEOUT_MS`, or the frame loaded a document with no frame in it. From outside the frame the causes look alike: the file is not at `documentUrl`, the server answers that path with another page (an app's fallback page), a header on the file refuses the framing (`X-Frame-Options`, `frame-ancestors`) or the view's script, or the host page's own `frame-src` does not admit `documentUrl` (see [Registering the element](#registering-the-element) and [Host page policy](#host-page-policy)). Where the element could read the file's answer, the check of the file names the first four causes instead (the reasons below); this reason is what is left where it could not: another origin that does not allow the read, a host page whose `connect-src` refuses the request, a network failure, or a server that answers the frame otherwise than the check.",
    documentMissing: "Sealed mode, the check of the file: the element's own request for `documentUrl` was answered with a status that is not 2xx, or with a `Content-Type` that is not `text/html` (none counts as not HTML); the text after the colon says which. Nothing was framed.",
    documentChanged: "Sealed mode, the check of the file: `documentUrl` answered with bytes that are not this version's `sealed-document.html`, compared whole, by their SHA-256. Every change counts: a script a dev server inserts, a minified or reformatted copy, a copy without the guard or whose view lost its `sandbox` attribute, an app's own page, another version's file. Nothing was framed.",
    documentFrameAncestors: 'Sealed mode, the check of the file: a `Content-Security-Policy` or `Content-Security-Policy-Report-Only` header on the file has a `frame-ancestors` directive. Nothing was framed.',
    documentFrameOptions: 'Sealed mode, the check of the file: the file is served with `X-Frame-Options`, whatever its value. Nothing was framed.',
    documentCsp: 'Sealed mode, the check of the file: the file is served with `Content-Security-Policy`, whatever its text: the view and its worker would run under it beside the file\'s own `<meta>` policy. Nothing was framed.',
    documentCspReportOnly: "Sealed mode, the check of the file: the file is served with `Content-Security-Policy-Report-Only`, whatever its text: the view's loads would be reported to its endpoint. Nothing was framed.",
    noDocumentUrl: "In a build with the network modes: `mode` is `'sealed'` or left out, and the element was registered without `documentUrl`. Sealed mode has no view but the served file; strict, cooperative and worker mode need none.",
    definitionRefused: '`defineWebSandbox()` was given something other than an object, or a `tagName` that is not a string.',
    documentUrlMissing: 'In the default build, `defineWebSandbox()` was given no `documentUrl`: sealed mode, the only mode of that build, has no view without it.',
    documentUrlRefused: "`documentUrl` breaks one of its rules, which the message names after the colon: a string or a `URL`, resolved against the document's own URL (`document.URL`, never a `<base>`), with the scheme `http:` or `https:`, no user name or password, and no fragment. A query and any path are the embedder's.",
    documentUrlChanged: 'The tag is already defined by this element with another `documentUrl` (or without one). A second definition with the same one does nothing.',
}) as const satisfies Record<ReasonId, string>;

/** The reasons the lifecycle reducer decides. */
export type LifecycleReasonId = { [K in ReasonId]: (typeof TERMINATION_REASONS)[K]['decidedBy'] extends 'lifecycle' ? K : never }[ReasonId];

export interface HostLineRow {
    /** The line, with `…` where it varies. */
    readonly text: string;
    readonly level: 'error' | 'warn';
    /** 'host' for the element's own lines; 'guest' for one it writes in the guest relay's name (counted as the relay's own). */
    readonly source: 'host' | 'guest';
}

export const HOST_LINES = {
    executionTimeout: { text: 'Execution Timeout', level: 'error', source: 'host' },
    entryFailed: { text: `[Sandbox] ${TERMINATION_REASONS.entryFailed.text}`, level: 'error', source: 'host' },
    refusedByHostPage: { text: '[Sandbox] …', level: 'error', source: 'host' },
    logLimit: { text: `[Sandbox] the guest logged more than ${LOG_EVENTS_PER_SECOND} lines in one second; lines past that rate are not dispatched as 'sandbox-log' events.`, level: 'warn', source: 'host' },
    viewFirstOverrun: { text: `[Sandbox] the view spent more than ${OVERRUN_MS} ms on one operation; a second such operation within ${OVERRUN_MINUTES} minutes ends the sandbox.`, level: 'warn', source: 'host' },
    viewTextDropped: { text: `[Sandbox] the guest raised more than ${VIEW_OPTIONS.guestText.perSecond} uncaught errors in one second that only the view could describe; errors past that are dropped in the view.`, level: 'warn', source: 'guest' },
} as const satisfies Record<string, HostLineRow>;

export type HostLineId = keyof typeof HOST_LINES;

/** When the element dispatches each line. The docs' only: a bundle leaves it out. */
export const HOST_LINE_OCCASIONS = {
    executionTimeout: "workerExecutionTimeout: the event loop was still busy past an execute()'s deadline; the termination follows",
    entryFailed: "strict mode: the entry failed to start; the entry's own error text follows as a guest line, then the termination",
    refusedByHostPage: "the host page's policy refused a frame of the library's, or a bootstrap of the library found its document not the one the library built: … is the termination's reason, which follows",
    logLimit: 'once per environment, when the element first drops guest lines past LOG_EVENTS_PER_SECOND',
    viewFirstOverrun: "strict mode, once per environment: the view's first overrun (VIEW_FIRST_OVERRUN)",
    viewTextDropped: 'strict mode, once per environment: the view dropped a guest error text past its window (GUEST_TEXT_DROPPED)',
} as const satisfies Record<HostLineId, string>;

type Varying<Texts extends Record<string, { readonly text: string }>> = { [K in keyof Texts]: Texts[K]['text'] extends `${string}…${string}` ? K : never }[keyof Texts];
type Templated = Varying<typeof TERMINATION_REASONS>;

declare const LIBRARY_DETAIL: unique symbol;
/**
 * The detail of a reason (BD5:DOC-2): a text the library chose, never a value of the configuration or the guest's. Only
 * the producers below make one (`errorName`, `fixedDetail`, `joinDetails`); test/unit/reasons.test.ts keeps the cast
 * that brands it in this file alone, and feeds every templated reason hostile entries, modes and error names.
 */
export type LibraryDetail = string & { readonly [LIBRARY_DETAIL]: true };

// the one cast to LibraryDetail (a declaration, so a module that imports this one in a cycle can call it at once)
function branded(text: string): LibraryDetail {
    return text as LibraryDetail;
}

/**
 * A fixed text of the library's, as a reason's detail: the argument's type must be a literal (or a union of literals,
 * such as a template over a closed list), so a string read from a configuration or a guest does not compile.
 */
export function fixedDetail<const T extends string>(text: string extends T ? never : T): LibraryDetail {
    return branded(text);
}

/** Several details, in order, as one. */
export function joinDetails(...parts: readonly LibraryDetail[]): LibraryDetail {
    let out = '';
    for (const part of parts) out += part;
    return branded(out);
}

// What a reason or a host line says about an error the element caught (FR:F3): a fixed
// text of the element's own plus the error's name, never its message. The message is whatever the thrower put
// there: Chromium's DataCloneError quotes the source of the function it could not clone, a throwing getter's
// error carries any text, a guest's error is the guest's text. A reason reaches 'terminated' listeners, the
// console warning and every log an embedder keeps, so it carries none of that. The name is checked too (a thrown
// object can name itself anything): a short identifier, else "Error"; a thrown primitive is named by its type.
// The one rule for every caught error: build failures, unusable configs, an entry that failed (whose text
// arrives as a 'guest' line instead, the guest's own words labelled as such).
export function errorName(error: unknown): LibraryDetail {
    if (error === null) return fixedDetail('null');
    if (typeof error !== 'object' && typeof error !== 'function') return branded(typeof error);
    try {
        const name = (error as { name?: unknown }).name;
        if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name)) return branded(name);
    } catch {
        // a name that throws: named below
    }
    return fixedDetail('Error');
}

/** The reason `id` gives; one whose text varies takes the detail, a LibraryDetail, that goes in place of its `…`. */
export function reasonText(id: Exclude<ReasonId, Templated>): string;
export function reasonText(id: Templated, detail: LibraryDetail): string;
export function reasonText(id: ReasonId, detail?: LibraryDetail): string {
    return fill(TERMINATION_REASONS[id].text, detail);
}

/** The text of the line `id`; one whose text varies takes the detail that goes in place of its `…`. */
export function hostLine(id: Exclude<HostLineId, Varying<typeof HOST_LINES>>): string;
export function hostLine(id: Varying<typeof HOST_LINES>, detail: string): string;
export function hostLine(id: HostLineId, detail?: string): string {
    return fill(HOST_LINES[id].text, detail);
}

const fill = (text: string, detail: string | undefined) => (detail === undefined ? text : text.replace('…', () => detail));
