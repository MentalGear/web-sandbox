/**
 * The texts the element gives (S76): every `terminated` reason, and every line it dispatches as `sandbox-log` itself,
 * declared once, with what causes it and where it is decided. host.ts, the lifecycle reducer (lifecycle.ts) and the
 * config schema take their texts from here; docs/API.md's reasons table and its host lines are this registry, which
 * test/unit/api-docs.test.ts keeps equal.
 *
 * A text with `…` varies there (an error's name, a note of the library's, a reason): `reasonText()` and `hostLine()` put
 * the detail in its place, and the type system asks for one exactly where the text has a `…`. A reason's detail is a
 * LibraryDetail, which only the library's own producers make (BD5:DOC-2, class C): an error's name as `errorName()`
 * filters it, or a fixed text of the library's. A value of the config (the entry, the mode) or of the guest is a plain
 * string, which does not compile there: a reason names the problem, never the value, so `terminated.reason` is safe to
 * show as text whatever the configuration came from.
 */
import { VIEW_MAX_OPERATION_MS, VIEW_OPTIONS, VIEW_OVERRUN_WINDOW_MS } from './in-sandbox-view';
import { LOG_EVENTS_PER_SECOND } from './sandbox-log';
import { TRUSTED_TYPES_POLICY } from './trusted-types';

export interface ReasonRow {
    /** The reason, with `…` where it varies. */
    readonly text: string;
    /** Where it is decided: the element (host.ts), the lifecycle reducer (lifecycle.ts), or the config schema. */
    readonly decidedBy: 'host' | 'lifecycle' | 'config';
}

// The repeated-overrun rule in words (in-sandbox-view.ts, viewBudget; S72, class P).
const OVERRUN_MS = VIEW_MAX_OPERATION_MS;
const OVERRUN_MINUTES = VIEW_OVERRUN_WINDOW_MS / 60000;
const HOST_PAGE_POLICY = 'see docs/API.md#host-page-policy';

export const TERMINATION_REASONS = {
    host: { text: 'terminated by the host', decidedBy: 'host' },
    watchdog: { text: 'the guest stopped responding (watchdog)', decidedBy: 'host' },
    entryFailed: { text: 'the guest entry failed to start', decidedBy: 'host' },
    startupBlocked: { text: `the sandbox's startup script did not run: the host page's Content-Security-Policy must allow it (${HOST_PAGE_POLICY})`, decidedBy: 'lifecycle' },
    // The host page's policies bind the library's frames, which inherit them as srcdoc documents (CSP3 copies the policy
    // list; Trusted Types; COEP; R1:R3-1): each reason of a refusal names the policy, so the embedder knows what to allow.
    workerRefused: { text: `the sandbox's worker could not be loaded: the host page's policy refuses blob: workers (worker-src; WebKit also under Cross-Origin-Embedder-Policy; ${HOST_PAGE_POLICY})`, decidedBy: 'host' },
    trustedTypes: { text: `the host page's Trusted Types policy does not allow the policy name '${TRUSTED_TYPES_POLICY}' (trusted-types; ${HOST_PAGE_POLICY})`, decidedBy: 'host' },
    // The environment check (environment-check.ts, S74): a bootstrap found its document different from the one the library
    // built, stayed inert, and said so; one reason for each row of its table (ENVIRONMENT_CHECKS).
    environmentOrigin: { text: "the sandbox document's origin is not opaque: it is not running in the frame the library built", decidedBy: 'host' },
    environmentUrl: { text: 'the sandbox document is not an about:srcdoc document: it is not the document the library built', decidedBy: 'host' },
    environmentBase: { text: `the sandbox document's base URL is not about:blank: the host page's Content-Security-Policy must allow the library's <base> (base-uri must include about: or be omitted; ${HOST_PAGE_POLICY})`, decidedBy: 'host' },
    environmentIsolated: { text: `the host page is cross-origin isolated (COOP and COEP); a sandbox does not run there (${HOST_PAGE_POLICY})`, decidedBy: 'host' },
    entryNotRegistered: { text: 'the guest entry is not a registered JavaScript file', decidedBy: 'host' },
    viewLost: { text: 'the sandbox view stopped responding', decidedBy: 'host' },
    viewOverrun: { text: `the view spent more than ${OVERRUN_MS} ms on one operation twice within ${OVERRUN_MINUTES} minutes`, decidedBy: 'host' },
    unknownMode: { text: 'unknown mode: not strict, sealed, cooperative or worker…', decidedBy: 'config' },
    sealedNetwork: { text: "origins and fetchBridge open the network, which sealed mode (the default) does not have: set `mode: 'strict'`", decidedBy: 'config' },
    configRefused: { text: 'the configuration could not be used (…)', decidedBy: 'host' },
    buildFailed: { text: 'the environment could not be built (…)', decidedBy: 'host' },
    executionTimeout: { text: 'the executed code ran longer than workerExecutionTimeout', decidedBy: 'host' },
    secondLoad: { text: 'the sandbox frame loaded a second time', decidedBy: 'lifecycle' },
    secondAnnouncement: { text: 'the guest frame announced itself again (it reloaded or rewrote its document)', decidedBy: 'lifecycle' },
    loadTimeout: { text: 'the sandbox did not finish loading', decidedBy: 'lifecycle' },
    frameMissing: { text: 'the guest frame is missing', decidedBy: 'lifecycle' },
    uncaughtBudget: { text: 'the guest raised more uncaught errors or unhandled rejections in one second than their budget allows', decidedBy: 'host' },
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
    viewLost: 'Strict and sealed mode: the view did not answer for `VIEW_LIVENESS_TIMEOUT_MS` (always on).',
    viewOverrun: `Strict and sealed mode: an operation of the view (a render, \`text()\` or \`set()\` applied, with its layout and the rendering update that showed it) took longer than ${OVERRUN_MS} ms, measured as the view's time budget measures it, and another one had, at most ${OVERRUN_MINUTES} minutes before it. The first such operation only logs a \`warn\` line (see [\`sandbox-log\`](#sandbox-log--sandboxlog)); see [\`sandboxView\`](#sandboxview-strict-mode).`,
    unknownMode: "`mode` is not `strict`, `sealed`, `cooperative` or `worker`. For `'iframe'` the reason ends ` ('iframe' was renamed 'cooperative')`; otherwise nothing follows.",
    sealedNetwork: "`mode` is `'sealed'` or left out (sealed mode is the default), and the config names `origins` or `fetchBridge` (with any value but `undefined`). Nothing of the config is applied, as for one that could not be used; the sandbox stays terminated until a usable config is set.",
    configRefused: "`setConfig()` got something that is not an object or cannot be cloned (the error's name follows, as in `(DataCloneError)`), an `origins` that is not an object (`(TypeError: origins is not an object)`), or a kind of it that is not a list (`(TypeError: origins.connect is not a list)`, naming the kind).",
    buildFailed: 'Building the frame failed.',
    executionTimeout: "The guest's event loop was still busy `EXECUTION_TIMEOUT_GRACE_MS` after an `execute()` deadline.",
    secondLoad: "Something navigated or reloaded the library's frame (also before its first load, once the guest had checked in).",
    secondAnnouncement: 'Cooperative and worker mode: the guest frame announced a second port (it reloaded itself, rewrote its document so the bootstrap ran again, or posted a forged announcement), or announced one where no bootstrap runs.',
    loadTimeout: 'The build was still `loading` after `LOAD_TIMEOUT_MS` of host time and its frame had not loaded (without `allow-scripts`: subresources included).',
    frameMissing: "The library's frame has no guest frame.",
    uncaughtBudget: 'Worker, strict and sealed mode: past the budget of uncaught errors and rejections (see [`sandbox-log`](#sandbox-log--sandboxlog) and [Limits](#limits)).',
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
