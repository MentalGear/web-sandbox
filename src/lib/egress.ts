/**
 * The egress table (class E-cpu, docs/research/18_finding_classes/README.md, design 1; R5:N-1): every
 * platform surface through which guest activity can cause work on the host page's thread, in every realm the library
 * runs in or hears from, each with its handling and its bound. One list, so that a surface nobody thought about is a
 * missing row, which a test sees, rather than a finding.
 *
 * Why a list. A fix per surface leaves the next surface unnamed: the view's error texts (R3:C-4), the worker's own
 * postMessage and its uncancelled errors (R4:M-1) and its uncancelled rejections (R5:N-1) were each such a surface. A
 * class is closed by a list of what is allowed and a test that enumerates the domain (the worker-globals allowlist is
 * this table for network egress). Here:
 *   - test/e2e/egress.spec.ts enumerates, on every engine, the event-handler surfaces (`on*` names, and the event types
 *     the platform reports without one) of the guest's worker, of worker mode's frame, of the strict view, of the Worker
 *     object and of MessagePort, and fails on any this table does not list for that realm;
 *   - test/unit/egress.test.ts fails on a row without a bound or a test, and checks that the bootstrap installs exactly
 *     the listeners of its rows (bootstrapListeners, below), and no other.
 *
 * The bootstrap's listeners come from here (in-sandbox-script.ts): the host hands it bootstrapListeners(mode), one
 * literal, and the bootstrap installs those and nothing else, each doing what its row says (relay, cancel, count). The
 * rows of the strict view and its worker prelude (owner 'view') are kept in in-sandbox-view.ts, by its own code; they are
 * listed here so that the enumeration covers them.
 *
 * Host-side only, never stringified into the guest, so it may use module scope freely.
 */

/** Where the surface is. */
export type EgressRealm =
    /** The guest's worker global, worker and strict mode. */
    | 'worker'
    /** Cooperative mode's guest document (its window and document): the guest's own realm, on the host page's thread. */
    | 'cooperative'
    /** The Worker object of the guest's worker, in worker mode's frame or in strict mode's view. */
    | 'worker-object'
    /** A MessagePort: the library's port, whose host end the element listens to. */
    | 'port'
    /** Worker mode's frame document, which spawns the worker and runs no guest code or markup. */
    | 'frame'
    /** Strict mode's view document, which renders the guest's markup and runs no guest code. */
    | 'view'
    /** The host page's window, where the element hears the guest frame's announcement. */
    | 'host';

/** The library code that installs the listener, or decides what happens to the surface. */
export type EgressOwner = 'guest-script' | 'worker-bootstrap' | 'view' | 'host';

/**
 * What happens to the surface:
 *   relayed      turned into a line or a frame through a chokepoint that bounds it before it is posted
 *   cancelled    its default action, the browser's own report, is prevented at the source
 *   budgeted     counted against a per-second budget that ends the sandbox past it (the browser's own work cannot be
 *                stopped, only the guest that causes it)
 *   capped       at most a fixed number per environment
 *   removed      the API that raises it is gone from the guest's realm before guest code runs
 *   unreachable  guest activity cannot raise it there (the bound says why)
 *   unheard      no library listener hears it there; what raises it is bounded where it is caused (the bound says where)
 *   own          the library's own message or gate: one only library code can raise is acted on, once; one the guest
 *                raises is not trusted, or comes from no window of the library's, and is ignored at once
 */
export type EgressHandling = 'relayed' | 'cancelled' | 'budgeted' | 'capped' | 'removed' | 'unreachable' | 'unheard' | 'own';

export type EgressMode = 'strict' | 'worker' | 'cooperative';

export interface EgressRow {
    readonly realm: EgressRealm;
    /** An event type, or a kind of browser work started by what the guest rendered (the view's rows). */
    readonly surface: string;
    readonly modes: readonly EgressMode[];
    readonly owner: EgressOwner;
    readonly handling: readonly EgressHandling[];
    /** The bound, in words, naming its constants. */
    readonly bound: string;
    /** The test that measures or checks it. */
    readonly test: string;
}

/**
 * Most uncaught errors and unhandled rejections, and rejections handled later (`rejectionhandled`), in any one-second
 * window, per environment, in worker and strict mode; past it the sandbox ends (the reason `uncaughtBudget`, reasons.ts).
 * Why that bound (R5:N-1, whose e2e spec is in test/e2e/): Firefox reports every unhandled rejection of a worker to
 * the host page's thread, cancelled or not. A flood of small ones (about 25 000 a second) keeps it 99% busy; 1000
 * cancelled rejections a second leave it idle, and 1000 a second each handled a tick later, 4–7% busy. Chromium's cost
 * goes with the reports it is not told to skip, which cancelling removes. Past the budget the worker stops itself as
 * well (in-sandbox-script.ts), so the reports end there, not when the element's message gets through a busy host page:
 * with both, a flood ends the sandbox with the host page 0–3% busy on all three engines, and 300 rejections a second,
 * each handled a tick later, keep it 0–2% busy, the sandbox ready.
 */
export const UNCAUGHT_PER_SECOND = 1000;

/**
 * Most characters of those errors and rejections in any one-second window, per environment, in worker and strict mode:
 * what the browser reports of each, its name and message (an error), or the string (a rejected string); past it the
 * sandbox ends. Measured in Firefox, with every rejection cancelled: the cost follows the characters of the message
 * and name it reads (data properties only: a getter, a stack or a toString cost nothing), about 0.5 s of the host page
 * per 16 Mi characters, so one rejection of 16 Mi characters a second kept it 50% busy, three 98%, and 1 Mi characters a
 * second 6%. Not bounded: a single error or rejection, whose report the browser makes before anything can end the
 * sandbox; the sandbox ends right after it.
 */
export const UNCAUGHT_CHARACTERS_PER_SECOND = 1048576;

// The event types each realm's own window has. No library listener hears them in worker mode's frame (it holds nothing
// of the guest's), and the view's own listeners are their own rows below. The union of what Chromium, Firefox and WebKit
// enumerate on a frame's window (test/e2e/egress.spec.ts): a new one fails that test until it is listed here.
export const WINDOW_EVENT_TYPES: readonly string[] = [
    'abort', 'afterprint', 'animationcancel', 'animationend', 'animationiteration', 'animationstart', 'appinstalled',
    'auxclick', 'beforeinput', 'beforeinstallprompt', 'beforematch', 'beforeprint', 'beforetoggle', 'beforeunload',
    'beforexrselect', 'blur', 'cancel', 'canplay', 'canplaythrough', 'change', 'click', 'close', 'command',
    'contentvisibilityautostatechange', 'contextlost', 'contextmenu', 'contextrestored', 'copy', 'cuechange', 'cut',
    'dblclick', 'devicemotion', 'deviceorientation', 'deviceorientationabsolute', 'drag', 'dragend', 'dragenter',
    'dragexit', 'dragleave', 'dragover', 'dragstart', 'drop', 'durationchange', 'emptied', 'ended', 'error', 'focus',
    'formdata', 'gamepadconnected', 'gamepaddisconnected', 'gotpointercapture', 'hashchange', 'input', 'invalid',
    'keydown', 'keypress', 'keyup', 'languagechange', 'load', 'loadeddata', 'loadedmetadata', 'loadstart',
    'lostpointercapture', 'message', 'messageerror', 'mousedown', 'mouseenter', 'mouseleave', 'mousemove', 'mouseout',
    'mouseover', 'mouseup', 'mousewheel', 'mozfullscreenchange', 'mozfullscreenerror', 'offline', 'online',
    'orientationchange', 'pagehide', 'pagereveal', 'pageshow', 'pageswap', 'paste', 'pause', 'play', 'playing',
    'pointercancel', 'pointerdown', 'pointerenter', 'pointerleave', 'pointermove', 'pointerout', 'pointerover',
    'pointerrawupdate', 'pointerup', 'popstate', 'progress', 'ratechange', 'rejectionhandled', 'reset', 'resize',
    'scroll', 'scrollend', 'scrollsnapchange', 'scrollsnapchanging', 'search', 'securitypolicyviolation', 'seeked',
    'seeking', 'select', 'selectionchange', 'selectstart', 'slotchange', 'stalled', 'storage', 'submit', 'suspend',
    'timeupdate', 'toggle', 'transitioncancel', 'transitionend', 'transitionrun', 'transitionstart',
    'unhandledrejection', 'unload', 'volumechange', 'waiting', 'webkitanimationend', 'webkitanimationiteration',
    'webkitanimationstart', 'webkitmouseforcechanged', 'webkitmouseforcedown', 'webkitmouseforceup',
    'webkitmouseforcewillbegin', 'webkittransitionend', 'wheel',
];

/**
 * The event types a realm can be sent without an `on*` property naming them: what the platform reports (errors,
 * rejections, policy violations) and the channels' own (messages). The enumeration test adds them to every realm's
 * `on*` names.
 */
export const REPORTED_EVENT_TYPES: readonly string[] = ['error', 'unhandledrejection', 'rejectionhandled', 'messageerror', 'securitypolicyviolation', 'message'];

const UNCAUGHT_BOUND = `UNCAUGHT_PER_SECOND (${UNCAUGHT_PER_SECOND}) and UNCAUGHT_CHARACTERS_PER_SECOND (${UNCAUGHT_CHARACTERS_PER_SECOND}) in any one second, with the other uncaught errors and rejections; past either the sandbox ends`;
const RELAY_BOUND = 'one guest line each, through the console relay: LOG_EVENTS_PER_SECOND lines and 4 MiB per second, cut at LOG_MAX_STRING';
const N1 = 'test/e2e/error-cost-and-queued-calls.spec.ts (N-1); test/unit/egress.test.ts';
const WORKER_MODES: readonly EgressMode[] = ['strict', 'worker'];

const own: EgressRow[] = [
    // ---- the guest's worker (worker and strict mode): its global's own surfaces, as the allowlist leaves them
    { realm: 'worker', surface: 'error', modes: ['worker'], owner: 'guest-script', handling: ['relayed', 'cancelled', 'budgeted'],
        bound: `${RELAY_BOUND}; cancelled once the port is attached, so it never reaches the Worker object; ${UNCAUGHT_BOUND}`, test: `${N1}; test/e2e/worker-port-and-view-cost.spec.ts (M-1's class)` },
    { realm: 'worker', surface: 'error', modes: ['strict'], owner: 'guest-script', handling: ['budgeted'],
        bound: `${UNCAUGHT_BOUND}; relayed and cancelled by the strict prelude (the view's row)`, test: N1 },
    { realm: 'worker', surface: 'error', modes: ['strict'], owner: 'view', handling: ['relayed', 'cancelled'],
        bound: 'the strict prelude (in-sandbox-view.ts): the entry\'s own error ends the sandbox; a later one is cancelled and relayed as a guest line', test: 'test/e2e/worker-port-and-view-cost.spec.ts (M-1\'s class)' },
    { realm: 'worker', surface: 'unhandledrejection', modes: WORKER_MODES, owner: 'guest-script', handling: ['relayed', 'cancelled', 'budgeted'],
        bound: `${RELAY_BOUND}; cancelled once relayed (Chromium then reports nothing to the page; Firefox reports it all the same, hence the budget); ${UNCAUGHT_BOUND}`, test: N1 },
    { realm: 'worker', surface: 'rejectionhandled', modes: WORKER_MODES, owner: 'guest-script', handling: ['budgeted'],
        bound: `counted with the rejections (Firefox's host page: 4–7% busy at 1000 a second); ${UNCAUGHT_BOUND}`, test: N1 },
    { realm: 'worker', surface: 'securitypolicyviolation', modes: WORKER_MODES, owner: 'guest-script', handling: ['relayed', 'capped'],
        bound: 'one VIOLATION frame each, at most VIOLATION_EVENT_LIMIT per environment (the element counts them again)', test: 'src/lib/in-sandbox-script.test.ts (S5); test/e2e/violations.spec.ts' },
    { realm: 'worker', surface: 'message', modes: ['worker'], owner: 'guest-script', handling: ['own'],
        bound: 'the one INIT_PORT: only the frame that made the worker can post to it, and only the library\'s frame does', test: 'test/unit/guest-realm-hardening.test.ts (B1)' },
    { realm: 'worker', surface: 'message', modes: ['strict'], owner: 'view', handling: ['own'],
        bound: 'the one INIT_WORKER: only the view posts to the worker (the strict prelude)', test: 'test/e2e/strict-entry-scope-and-links.spec.ts' },
    { realm: 'worker', surface: 'messageerror', modes: WORKER_MODES, owner: 'guest-script', handling: ['unreachable'],
        bound: 'no listener; only the library\'s frame or view posts to the worker, its own messages', test: 'test/e2e/egress.spec.ts' },
    { realm: 'worker', surface: 'languagechange', modes: WORKER_MODES, owner: 'guest-script', handling: ['unreachable'],
        bound: 'raised by the user agent, never by the guest; no listener of the library', test: 'test/e2e/egress.spec.ts' },
    { realm: 'worker', surface: 'online', modes: WORKER_MODES, owner: 'guest-script', handling: ['unreachable'],
        bound: 'raised by the user agent, never by the guest; no listener of the library', test: 'test/e2e/egress.spec.ts' },
    { realm: 'worker', surface: 'offline', modes: WORKER_MODES, owner: 'guest-script', handling: ['unreachable'],
        bound: 'raised by the user agent, never by the guest; no listener of the library', test: 'test/e2e/egress.spec.ts' },

    // ---- the Worker object its parent holds
    { realm: 'worker-object', surface: 'error', modes: ['worker'], owner: 'worker-bootstrap', handling: ['cancelled'],
        bound: 'before the worker started, its one refusal; after, none arrives: the worker cancels every error once its port is attached (the worker\'s row)', test: 'test/e2e/worker-port-and-view-cost.spec.ts (M-1\'s class)' },
    { realm: 'worker-object', surface: 'error', modes: ['strict'], owner: 'view', handling: ['relayed', 'capped'],
        bound: 'the entry\'s own error ends the sandbox; a later one only the view can describe is cut and rate-limited in the view (guestText)', test: 'test/e2e/worker-port-and-view-cost.spec.ts (M-5)' },
    { realm: 'worker-object', surface: 'message', modes: WORKER_MODES, owner: 'worker-bootstrap', handling: ['removed'],
        bound: 'the worker\'s postMessage is gone (worker-globals.ts); worker mode\'s frame hears one WORKER_STARTED and then nothing', test: 'test/e2e/worker-port-and-view-cost.spec.ts (M-1)' },
    { realm: 'worker-object', surface: 'messageerror', modes: WORKER_MODES, owner: 'worker-bootstrap', handling: ['removed'],
        bound: 'the worker\'s postMessage is gone (worker-globals.ts)', test: 'test/e2e/worker-port-and-view-cost.spec.ts (M-1)' },

    // ---- the library's port, the host's end
    { realm: 'port', surface: 'message', modes: ['strict', 'worker', 'cooperative'], owner: 'host', handling: ['relayed', 'budgeted', 'capped'],
        bound: 'the logic port: only the bootstrap posts on it, through its chokepoints: log lines (LOG_EVENTS_PER_SECOND), calls (callLimits), violations (VIOLATION_EVENT_LIMIT), heights (AUTO_RESIZE_MAX_UPDATES_PER_SECOND), PONG, the budget of uncaught errors; strict mode\'s view port: only the view posts on it, its own frames, bounded in the view (guestText, VIOLATION_EVENT_LIMIT per directive, heights, a first overrun\'s notice at most once per 9 s of its debt and one host line per environment)', test: 'test/unit/relay-and-rpc-budgets.test.ts; test/e2e/worker-port-and-view-cost.spec.ts (M-6, M-5)' },
    { realm: 'port', surface: 'messageerror', modes: ['strict', 'worker', 'cooperative'], owner: 'host', handling: ['unreachable'],
        bound: 'only the bootstrap posts on the port, frames it built from clones, which deserialize', test: 'test/e2e/egress.spec.ts' },

    // ---- cooperative mode's guest document: the guest's own realm on the host page's thread (README, cooperative-mode limits)
    { realm: 'cooperative', surface: 'error', modes: ['cooperative'], owner: 'guest-script', handling: ['relayed'],
        bound: `${RELAY_BOUND}; not cancelled: the browser's console is the guest document's own, for debugging (a cooperative-mode limit)`, test: 'test/unit/relay-and-rpc-budgets.test.ts (R4-2)' },
    { realm: 'cooperative', surface: 'unhandledrejection', modes: ['cooperative'], owner: 'guest-script', handling: ['relayed'],
        bound: `${RELAY_BOUND}; not cancelled, as errors are not`, test: 'test/unit/relay-and-rpc-budgets.test.ts (R4-2)' },
    { realm: 'cooperative', surface: 'securitypolicyviolation', modes: ['cooperative'], owner: 'guest-script', handling: ['relayed', 'capped'],
        bound: 'one VIOLATION frame each, at most VIOLATION_EVENT_LIMIT per environment', test: 'src/lib/in-sandbox-script.test.ts (S5)' },
    { realm: 'cooperative', surface: 'DOMContentLoaded', modes: ['cooperative'], owner: 'guest-script', handling: ['own'],
        bound: 'the startup gate: a trusted one opens it, once, and a guest\'s own is not trusted; with autoResize, the body is observed once it exists', test: 'test/unit/guest-realm-hardening.test.ts (S46); src/lib/in-sandbox-script.test.ts (B6)' },
    { realm: 'cooperative', surface: 'every other event of the guest document', modes: ['cooperative'], owner: 'guest-script', handling: ['unheard'],
        bound: 'the guest\'s own document on the host page\'s thread: same-thread execution is a cooperative-mode limit (README)', test: 'README (cooperative-mode limits)' },

    // ---- the strict view: what it renders, and its own listeners (owner: the view, in-sandbox-view.ts)
    { realm: 'view', surface: 'securitypolicyviolation', modes: ['strict'], owner: 'view', handling: ['relayed', 'capped'],
        bound: 'one VIOLATION frame each, at most VIOLATION_EVENT_LIMIT per directive', test: 'test/e2e/violations.spec.ts' },
    { realm: 'view', surface: 'resource loads', modes: ['strict'], owner: 'view', handling: ['budgeted'],
        bound: 'VIEW_MAX_URLS and VIEW_URLS_PER_SECOND', test: 'test/e2e/worker-port-and-view-cost.spec.ts (M-2)' },
    { realm: 'view', surface: 'rendering', modes: ['strict'], owner: 'view', handling: ['budgeted'],
        bound: 'the view\'s budgets: VIEW_RENDER_CHARACTERS_PER_SECOND, VIEW_APPLY_MS_PER_SECOND, VIEW_MAX_ELEMENTS, VIEW_MAX_CHARACTERS; one operation: the second past VIEW_MAX_OPERATION_MS within VIEW_OVERRUN_WINDOW_MS ends the sandbox (S72)', test: 'test/e2e/view-budget.spec.ts; test/e2e/view-bound.spec.ts (b)' },
    { realm: 'view', surface: 'click', modes: ['strict'], owner: 'view', handling: ['cancelled', 'relayed'],
        bound: 'a link\'s navigation cancelled; forwarded to sandboxView.on within VIEW_EVENT_LIMITS', test: 'test/e2e/strict-events.spec.ts' },
    { realm: 'view', surface: 'auxclick', modes: ['strict'], owner: 'view', handling: ['cancelled'],
        bound: 'a link\'s navigation cancelled', test: 'test/e2e/strict-events.spec.ts' },
    { realm: 'view', surface: 'submit', modes: ['strict'], owner: 'view', handling: ['cancelled', 'relayed'],
        bound: 'cancelled; forwarded to sandboxView.on within VIEW_EVENT_LIMITS', test: 'test/e2e/strict-events.spec.ts' },
    { realm: 'view', surface: 'input', modes: ['strict'], owner: 'view', handling: ['relayed'],
        bound: 'forwarded to sandboxView.on within VIEW_EVENT_LIMITS', test: 'test/e2e/strict-events.spec.ts' },
    { realm: 'view', surface: 'change', modes: ['strict'], owner: 'view', handling: ['relayed'],
        bound: 'forwarded to sandboxView.on within VIEW_EVENT_LIMITS', test: 'test/e2e/strict-events.spec.ts' },
    { realm: 'view', surface: 'keydown', modes: ['strict'], owner: 'view', handling: ['relayed'],
        bound: 'forwarded to sandboxView.on within VIEW_EVENT_LIMITS', test: 'test/e2e/strict-events.spec.ts' },
    { realm: 'view', surface: 'message', modes: ['strict'], owner: 'view', handling: ['own'],
        bound: 'the one INIT_VIEW, from the host page; the guest has no window to post from', test: 'test/e2e/strict-entry-scope-and-links.spec.ts' },

    // ---- the host page's window, and the element's frame in it
    { realm: 'host', surface: 'load', modes: ['strict', 'worker', 'cooperative'], owner: 'host', handling: ['own'],
        bound: 'the wrapper frame\'s load: it loads once; a guest that navigates or reloads it ends the sandbox at the second', test: 'test/unit/fetch-and-csp-guarantees.test.ts; test/e2e/lifecycle.spec.ts' },
    { realm: 'host', surface: 'message', modes: ['strict', 'worker', 'cooperative'], owner: 'host', handling: ['own'],
        bound: 'the element takes the guest frame\'s one announcement; anything else a cooperative guest posts to the host window is the host page\'s to read (a cooperative-mode limit: messages to the host window), and strict and worker mode run no guest code in a window', test: 'test/unit/fetch-and-csp-guarantees.test.ts (CB1)' },
];

// The listeners a realm's own window has and nothing of the library hears: one row per event type, so a new type an
// engine adds is a missing row (above).
const heardInView = new Set(own.filter(row => row.realm === 'view').map(row => row.surface));
const windowRows: EgressRow[] = [];
for (const type of WINDOW_EVENT_TYPES) {
    windowRows.push({ realm: 'frame', surface: type, modes: ['worker'], owner: 'worker-bootstrap', handling: ['unreachable'],
        bound: 'worker mode\'s frame holds no guest code and no guest markup, and the worker cannot reach its window', test: 'test/e2e/egress.spec.ts' });
    if (heardInView.has(type)) continue;
    windowRows.push({ realm: 'view', surface: type, modes: ['strict'], owner: 'view', handling: ['unheard'],
        bound: 'no listener of the library in the view; what the guest renders to raise it is bounded by the view\'s budgets (the rendering row)', test: 'test/e2e/egress.spec.ts' });
}

/** Every row. */
export const EGRESS: readonly EgressRow[] = Object.freeze([...own, ...windowRows].map(row => Object.freeze(row)));

/** One listener the bootstrap (in-sandbox-script.ts) installs, and what it does: the rows of owner 'guest-script' that are heard. */
export interface BootstrapListener {
    /** The event type. */
    type: string;
    /** On the global (capture), or on the document (cooperative mode's startup gate). */
    target: 'global' | 'document';
    relay: boolean;
    cancel: boolean;
    budget: boolean;
}

/**
 * The listeners the bootstrap installs in `mode`, from the rows: every row the guest script owns for that mode whose
 * handling makes it listen (relayed, cancelled, budgeted). The host hands these to the bootstrap as one literal; the
 * bootstrap installs exactly these (in-sandbox-script.ts). The INIT_PORT listener of worker mode and the startup gate's
 * DOMContentLoaded are rows of their own, installed by their own code, which hands nothing to guest code.
 */
export function bootstrapListeners(mode: EgressMode): BootstrapListener[] {
    const listeners: BootstrapListener[] = [];
    for (const row of EGRESS) {
        if (row.owner !== 'guest-script' || !row.modes.includes(mode)) continue;
        const relay = row.handling.includes('relayed');
        const cancel = row.handling.includes('cancelled');
        const budget = row.handling.includes('budgeted');
        if (!relay && !cancel && !budget) continue;
        listeners.push({ type: row.surface, target: 'global', relay, cancel, budget });
    }
    return listeners;
}

/** The per-second budget of uncaught errors and rejections the bootstrap keeps (worker and strict mode). */
export const UNCAUGHT_BUDGET = Object.freeze({ count: UNCAUGHT_PER_SECOND, characters: UNCAUGHT_CHARACTERS_PER_SECOND });

/**
 * The budgets of every channel of guest activity (backlog S61.4; classes E-cpu and P): what the guest can make the host
 * page, the view or the network do through it, with its count, byte and time bounds, each naming the constant behind it,
 * the cost to the host page where one is measured, and the test that checks it. A row of the table above says how a
 * surface is handled; a channel here is what crosses it and how much of it may. docs/API.md, "Budgets", is this list
 * rendered (budgetsTable), and test/unit/budgets.test.ts keeps the two equal, resolves every constant named to the value
 * the code has, checks that every test named exists, and that every row above that relays, budgets or caps a surface is
 * the surface of some channel here. So a bound is written down before a review has to find it missing: a dimension a
 * channel has no bound in says why in its cell, and a new surface that relays is a missing channel, which the test sees.
 *
 * The cost column states the bound on the cost to the host page, and only the bound: a share, a cap or a constant, with
 * the constant's value where there is one (CONTRIBUTING, availability findings). Measured figures are never in a cell:
 * they stand in a dated note under the table, naming the engines. The view's bound is stated in full in its own section
 * of API.md, which its rows link.
 * In a cell, `{NAME}` is a constant, rendered with its value, and `{NAME.field}` a field of one.
 */
export interface ChannelBudget {
    /** What the guest does, and where it goes. */
    readonly channel: string;
    /** The rows of EGRESS (realm, surface) whose surface this channel crosses. */
    readonly surfaces: readonly (readonly [EgressRealm, string])[];
    readonly count: string;
    readonly bytes: string;
    readonly time: string;
    /** The bound on what it costs the host page: a share, a cap or a constant, or that the columns above are the bound. */
    readonly cost: string;
    readonly test: string;
}

const VIEW_COST = "see [The view's cost to the host page](#the-views-cost-to-the-host-page)";

export const CHANNEL_BUDGETS: readonly ChannelBudget[] = Object.freeze(([
    { channel: 'Guest log lines, to `sandbox-log`: the console relay, and the uncaught errors and rejections it relays',
        surfaces: [['port', 'message'], ['worker', 'error'], ['worker', 'unhandledrejection'], ['cooperative', 'error'], ['cooperative', 'unhandledrejection']],
        count: '{LOG_EVENTS_PER_SECOND} lines in any second, counted by the guest and again by the host; {LOG_MAX_ARGS} arguments a line',
        bytes: '{LOG_MAX_BYTES} a line, measured by both ends, placeholders included; {LOG_BYTES_PER_SECOND} a second, by the guest; a string argument cut at {LOG_MAX_STRING} characters',
        time: 'none of its own: one event a line',
        cost: 'none beyond the count and the bytes',
        test: 'test/unit/relay-and-rpc-budgets.test.ts (R3-3); test/unit/structural.test.ts' },
    { channel: "Uncaught errors and unhandled rejections of the guest's worker, which the browser reports (worker and strict mode)",
        surfaces: [['worker', 'error'], ['worker', 'unhandledrejection'], ['worker', 'rejectionhandled']],
        count: '{UNCAUGHT_PER_SECOND} in any second, rejections handled later included; past it the sandbox ends',
        bytes: '{UNCAUGHT_CHARACTERS_PER_SECOND} characters of their names and messages in any second; past it the sandbox ends',
        time: 'none of its own: the count and the characters',
        cost: "Firefox reports each on the host page's thread, cancelled or not: bounded by the count and the characters, and past them the sandbox ends; one report is not bounded, since the browser makes it before the sandbox can end",
        test: 'test/e2e/error-cost-and-queued-calls.spec.ts (N-1); test/unit/egress.test.ts' },
    { channel: "Calls the guest makes (`bridge.call`), to the embedder's methods",
        surfaces: [['port', 'message']],
        count: '`callLimits.maxPerSecond` in any second, by default {GUEST_CALLS_PER_SECOND}, counted by the guest and again by the host; {MAX_INBOUND_IN_FLIGHT} running at once',
        bytes: '{RPC_MAX_BYTES} a call, its whole frame measured by both ends; `callLimits.maxBytesPerSecond` a second, by default {GUEST_CALL_BYTES_PER_SECOND}; {RPC_MAX_INBOUND_BYTES} of arguments running at once; a method name of at most {MAX_NAME_LENGTH} characters',
        time: "none of its own: the embedder's methods run as long as they take",
        cost: 'none beyond the count and the bytes',
        test: 'test/unit/rpc-bounds-and-call-limits.test.ts (M-2, C-1); test/unit/config-schema.test.ts; test/unit/rate-limit.prop.test.ts' },
    { channel: "Answers to the host's calls (`bridge.expose`)",
        surfaces: [['port', 'message']],
        count: "one a call the host made: the host's pending calls",
        bytes: '{RPC_MAX_BYTES} an answer, measured by both ends; an error text cut at {MAX_TEXT_LENGTH} characters by both ends',
        time: "the host's call timeout (`callWithTimeout`; by default {DEFAULT_TIMEOUT_MS} ms)",
        cost: "none beyond the host's pending calls and the bytes",
        test: 'test/unit/rpc-bounds-and-call-limits.test.ts (C-1); test/unit/structural.test.ts' },
    { channel: 'Guest writes (`sandboxFiles.write`, `remove`)',
        surfaces: [['port', 'message']],
        count: '{GUEST_WRITES_PER_SECOND} requests in any second, and each as a call; what is kept, at most {MAX_FILES} files with the registered ones',
        bytes: '{GUEST_WRITE_BYTES_PER_SECOND} in any second; what is kept, at most {MAX_TOTAL_BYTES} with the registered files',
        time: 'none of its own: the count and the bytes',
        cost: 'none beyond the count and the bytes',
        test: 'test/unit/guest-writes.test.ts; test/e2e/guest-writes.spec.ts' },
    { channel: "`sandboxFetch()`: the host page's fetch, on the guest's behalf",
        surfaces: [['port', 'message']],
        count: '`fetchBridge.maxConcurrent` at once, at most {MAX_MAX_CONCURRENT}; and each as a call',
        bytes: '`fetchBridge.maxBytes` a response, at most {MAX_MAX_BYTES}',
        time: '`fetchBridge.timeoutMs` a request, at most {MAX_TIMEOUT_MS} ms',
        cost: "none beyond the count, the bytes and the time: each request is the host page's own fetch",
        test: 'src/lib/fetch-bridge.test.ts; test/e2e/fetch-bridge.spec.ts' },
    { channel: 'CSP violation reports, to `violation`',
        surfaces: [['port', 'message'], ['worker', 'securitypolicyviolation'], ['cooperative', 'securitypolicyviolation'], ['view', 'securitypolicyviolation']],
        count: '{VIOLATION_EVENT_LIMIT} events an environment (strict mode: per source, and per directive for the view)',
        bytes: 'each string cut at {VIOLATION_MAX_STRING} characters before it is posted, by the bootstrap and by the view, and again by the host on receipt',
        time: 'none of its own: the count',
        cost: 'none beyond the count',
        test: 'src/lib/in-sandbox-script.test.ts (violation reports); test/e2e/violations.spec.ts; test/unit/structural.test.ts' },
    { channel: "Content heights (`autoResize`), to the frame's height",
        surfaces: [['port', 'message']],
        count: '{AUTO_RESIZE_MAX_UPDATES_PER_SECOND} a second, and one a frame',
        bytes: 'a number, at most {AUTO_RESIZE_MAX_HEIGHT} px',
        time: "none of its own: one relayout of the host page's frame a change",
        cost: "a cap: {AUTO_RESIZE_MAX_UPDATES_PER_SECOND} relayouts of the host page's frame a second",
        test: 'src/lib/auto-resize.test.ts; test/e2e/auto-resize.spec.ts' },
    { channel: "Liveness answers (PONG, VIEW_PONG), to the host's probes",
        surfaces: [['port', 'message']],
        count: "one a probe of the host's",
        bytes: 'a number',
        time: '{VIEW_LIVENESS_TIMEOUT_MS} ms for the view to answer; {EXECUTION_TIMEOUT_GRACE_MS} ms past a deadline for the worker (`workerExecutionTimeout`)',
        cost: "none: the library's own",
        test: 'src/lib/watchdog.test.ts; test/e2e/watchdog.spec.ts' },
    { channel: "Strict: the guest's error texts the view relays (GUEST_ERROR, GUEST_UNCAUGHT), to `sandbox-log`",
        surfaces: [['worker-object', 'error']],
        count: '{LOG_EVENTS_PER_SECOND} a second, counted in the view',
        bytes: 'each cut at {VIEW_OPTIONS.guestText.maxLength} characters in the view, before it is posted',
        time: 'none of its own: one line each',
        cost: 'none beyond the count and the bytes',
        test: 'test/unit/rpc-bounds-and-call-limits.test.ts (C-4); test/e2e/worker-port-and-view-cost.spec.ts (M-5)' },
    { channel: "Strict: the view's operations (`sandboxView.render`, `text`, `set`)",
        surfaces: [['view', 'rendering']],
        count: 'one at a time; the body holds at most {VIEW_MAX_ELEMENTS} elements, {VIEW_MAX_DEPTH} deep',
        bytes: '{VIEW_RENDER_MAX_LENGTH} characters an operation; {VIEW_RENDER_CHARACTERS_PER_SECOND} a second; {VIEW_MAX_CHARACTERS} in the body',
        time: '{VIEW_APPLY_MS_PER_SECOND} ms a second on average, each operation charged in full; the second operation past {VIEW_MAX_OPERATION_MS} ms within {VIEW_OVERRUN_WINDOW_MS} ms ends the sandbox',
        cost: `a share: at most {VIEW_APPLY_MS_PER_SECOND} ms of each second, averaged; ${VIEW_COST}`,
        test: 'test/e2e/view-bound.spec.ts; test/e2e/view-budget.spec.ts; test/unit/view-budget.prop.test.ts' },
    { channel: "Strict: the view's loads (URL attributes, CSS, and what the browser reports)",
        surfaces: [['view', 'resource loads']],
        count: "{VIEW_URLS_PER_SECOND} a second, each charged before it can start; {VIEW_MAX_URLS} URL attributes in the body; {VIEW_MAX_DISTINCT_URLS} distinct URLs over the view's life",
        bytes: "what the policy's origins serve: no budget of the library's",
        time: 'none of its own: the rate',
        cost: `a rate: at most {VIEW_URLS_PER_SECOND} loads a second; ${VIEW_COST}`,
        test: 'test/e2e/worker-port-and-view-cost.spec.ts (M-2); test/e2e/strict-view-budget.spec.ts; test/unit/view-css-loads.test.ts; test/unit/view-budget.prop.test.ts' },
    { channel: "Strict: the view's events, to the guest's `sandboxView.on` handlers",
        surfaces: [['view', 'click'], ['view', 'submit'], ['view', 'input'], ['view', 'change'], ['view', 'keydown']],
        count: 'as the user raises them, of the types a handler listens to; {VIEW_EVENT_LIMITS.maxIds} ids and {VIEW_EVENT_LIMITS.maxFields} form fields a detail',
        bytes: 'each string cut at {VIEW_EVENT_LIMITS.maxString} characters, all of one detail at {VIEW_EVENT_LIMITS.maxTotal}',
        time: "none of its own: the user's input",
        cost: "none beyond the user's own input",
        test: 'test/e2e/strict-events.spec.ts' },
    { channel: "Strict: the view's overrun notices (VIEW_FIRST_OVERRUN, VIEW_OVERRUN), to `sandbox-log` and `terminated`",
        surfaces: [['port', 'message']],
        count: "a first overrun's at most once per 9 s of its debt, and one host line an environment; the second ends the sandbox",
        bytes: 'none: no field',
        time: 'none of its own: the count',
        cost: `a stall past {VIEW_MAX_OPERATION_MS} ms at most once per {VIEW_OVERRUN_WINDOW_MS} ms beyond the first; ${VIEW_COST}`,
        test: 'test/unit/strict-view-budget.test.ts (the repeated-overrun rule); test/e2e/view-bound.spec.ts' },
    { channel: "Cooperative: the guest's own document",
        surfaces: [['cooperative', 'every other event of the guest document']],
        count: "none: the guest runs on the host page's thread wherever the engine puts its frame there",
        bytes: 'none',
        time: 'none: one loop can freeze the host page ([Modes](#modes))',
        cost: 'unbounded: a cooperative-mode limit',
        test: 'README (cooperative-mode limits)' },
] as ChannelBudget[]).map(row => Object.freeze(row)));

/**
 * CHANNEL_BUDGETS as docs/API.md's table. `values` gives each `{NAME}` its value: the limits registry's (limits.ts,
 * limitValues), whose keys are the names a cell may use; a name it does not give throws.
 */
export function budgetsTable(values: Readonly<Record<string, number>>): string {
    const cell = (text: string) => text.replace(/\{([A-Za-z_.]+)\}/g, (_, name: string) => {
        if (!(name in values)) throw new Error(`budgetsTable: no value for ${name}`);
        return `\`${name}\` (${values[name]})`;
    }).replace(/\|/g, '\\|');
    const lines = ['| Channel | Count | Bytes | Time | Bound on the cost to the host page | Test |', '| :--- | :--- | :--- | :--- | :--- | :--- |'];
    for (const row of CHANNEL_BUDGETS) lines.push(`| ${[row.channel, row.count, row.bytes, row.time, row.cost, row.test].map(cell).join(' | ')} |`);
    return lines.join('\n');
}
