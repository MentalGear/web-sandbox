/**
 * The egress table (class E-cpu, docs/research/18_finding_classes/README.md, design 1; review round 5, N-1): every
 * platform surface through which guest activity can cause work on the host page's thread, in every realm the library
 * runs in or hears from, each with its handling and its bound. One list, so that a surface nobody thought about is a
 * missing row, which a test sees, rather than a finding.
 *
 * Why a list. Each round from round 3 on found a surface no list named: the view's error texts (3:C-4), the worker's own
 * postMessage and its uncancelled errors (4:M-1), its uncancelled rejections (5:N-1). The fixes were per surface, and the
 * next surface was found the round after. The classes that stopped producing findings were closed the same way as this
 * one: a list of what is allowed, and a test that enumerates the domain (the worker-globals allowlist is this table for
 * network egress). Here:
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
 * window, per environment, in worker and strict mode; past it the sandbox ends (UNCAUGHT_BUDGET_REASON, host.ts).
 * Measured (test/e2e/review-round-5.spec.ts, "N-1"): Firefox reports every unhandled rejection of a worker to the host
 * page's thread, cancelled or not, and a flood of small ones (about 25 000 a second) kept it 99% busy; 1000 cancelled
 * rejections a second left it idle, and 1000 a second each handled a tick later, 4–7% busy. Chromium's cost went with
 * the reports it was not told to skip, which cancelling removes. Past the budget the worker stops itself as well
 * (in-sandbox-script.ts), so the reports end there, not when the element's message gets through a busy host page:
 * with both, every flood of the review-round-5 spec ended the sandbox with the host page 0–3% busy on all three
 * engines, and 300 rejections a second, each handled a tick later, kept it 0–2% busy, the sandbox ready.
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
const N1 = 'test/e2e/review-round-5.spec.ts (N-1); test/unit/egress.test.ts';
const WORKER_MODES: readonly EgressMode[] = ['strict', 'worker'];

const own: EgressRow[] = [
    // ---- the guest's worker (worker and strict mode): its global's own surfaces, as the allowlist leaves them
    { realm: 'worker', surface: 'error', modes: ['worker'], owner: 'guest-script', handling: ['relayed', 'cancelled', 'budgeted'],
        bound: `${RELAY_BOUND}; cancelled once the port is attached, so it never reaches the Worker object; ${UNCAUGHT_BOUND}`, test: `${N1}; test/e2e/review-round-4.spec.ts (M-1's class)` },
    { realm: 'worker', surface: 'error', modes: ['strict'], owner: 'guest-script', handling: ['budgeted'],
        bound: `${UNCAUGHT_BOUND}; relayed and cancelled by the strict prelude (the view's row)`, test: N1 },
    { realm: 'worker', surface: 'error', modes: ['strict'], owner: 'view', handling: ['relayed', 'cancelled'],
        bound: 'the strict prelude (in-sandbox-view.ts): the entry\'s own error ends the sandbox; a later one is cancelled and relayed as a guest line', test: 'test/e2e/review-round-4.spec.ts (M-1\'s class)' },
    { realm: 'worker', surface: 'unhandledrejection', modes: WORKER_MODES, owner: 'guest-script', handling: ['relayed', 'cancelled', 'budgeted'],
        bound: `${RELAY_BOUND}; cancelled once relayed (Chromium then reports nothing to the page; Firefox reports it all the same, hence the budget); ${UNCAUGHT_BOUND}`, test: N1 },
    { realm: 'worker', surface: 'rejectionhandled', modes: WORKER_MODES, owner: 'guest-script', handling: ['budgeted'],
        bound: `counted with the rejections (Firefox's host page: 4–7% busy at 1000 a second); ${UNCAUGHT_BOUND}`, test: N1 },
    { realm: 'worker', surface: 'securitypolicyviolation', modes: WORKER_MODES, owner: 'guest-script', handling: ['relayed', 'capped'],
        bound: 'one VIOLATION frame each, at most VIOLATION_EVENT_LIMIT per environment (the element counts them again)', test: 'src/lib/in-sandbox-script.test.ts (S5); test/e2e/violations.spec.ts' },
    { realm: 'worker', surface: 'message', modes: ['worker'], owner: 'guest-script', handling: ['own'],
        bound: 'the one INIT_PORT: only the frame that made the worker can post to it, and only the library\'s frame does', test: 'test/unit/broad-review-bootstrap.test.ts (B1)' },
    { realm: 'worker', surface: 'message', modes: ['strict'], owner: 'view', handling: ['own'],
        bound: 'the one INIT_WORKER: only the view posts to the worker (the strict prelude)', test: 'test/e2e/review-strict.spec.ts' },
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
        bound: 'before the worker started, its one refusal; after, none arrives: the worker cancels every error once its port is attached (the worker\'s row)', test: 'test/e2e/review-round-4.spec.ts (M-1\'s class)' },
    { realm: 'worker-object', surface: 'error', modes: ['strict'], owner: 'view', handling: ['relayed', 'capped'],
        bound: 'the entry\'s own error ends the sandbox; a later one only the view can describe is cut and rate-limited in the view (guestText)', test: 'test/e2e/review-round-4.spec.ts (M-5)' },
    { realm: 'worker-object', surface: 'message', modes: WORKER_MODES, owner: 'worker-bootstrap', handling: ['removed'],
        bound: 'the worker\'s postMessage is gone (worker-globals.ts); worker mode\'s frame hears one WORKER_STARTED and then nothing', test: 'test/e2e/review-round-4.spec.ts (M-1)' },
    { realm: 'worker-object', surface: 'messageerror', modes: WORKER_MODES, owner: 'worker-bootstrap', handling: ['removed'],
        bound: 'the worker\'s postMessage is gone (worker-globals.ts)', test: 'test/e2e/review-round-4.spec.ts (M-1)' },

    // ---- the library's port, the host's end
    { realm: 'port', surface: 'message', modes: ['strict', 'worker', 'cooperative'], owner: 'host', handling: ['relayed', 'budgeted', 'capped'],
        bound: 'the logic port: only the bootstrap posts on it, through its chokepoints: log lines (LOG_EVENTS_PER_SECOND), calls (callLimits), violations (VIOLATION_EVENT_LIMIT), heights (AUTO_RESIZE_MAX_UPDATES_PER_SECOND), PONG, the budget of uncaught errors; strict mode\'s view port: only the view posts on it, its own frames, bounded in the view (guestText, VIOLATION_EVENT_LIMIT per directive, heights, a first overrun\'s notice at most once per 9 s of its debt and one host line per environment)', test: 'test/unit/review-round-1.test.ts; test/e2e/review-round-4.spec.ts (M-6, M-5)' },
    { realm: 'port', surface: 'messageerror', modes: ['strict', 'worker', 'cooperative'], owner: 'host', handling: ['unreachable'],
        bound: 'only the bootstrap posts on the port, frames it built from clones, which deserialize', test: 'test/e2e/egress.spec.ts' },

    // ---- cooperative mode's guest document: the guest's own realm on the host page's thread (README, cooperative-mode limits)
    { realm: 'cooperative', surface: 'error', modes: ['cooperative'], owner: 'guest-script', handling: ['relayed'],
        bound: `${RELAY_BOUND}; not cancelled: the browser's console is the guest document's own, for debugging (a cooperative-mode limit)`, test: 'test/unit/review-round-1.test.ts (R4-2)' },
    { realm: 'cooperative', surface: 'unhandledrejection', modes: ['cooperative'], owner: 'guest-script', handling: ['relayed'],
        bound: `${RELAY_BOUND}; not cancelled, as errors are not`, test: 'test/unit/review-round-1.test.ts (R4-2)' },
    { realm: 'cooperative', surface: 'securitypolicyviolation', modes: ['cooperative'], owner: 'guest-script', handling: ['relayed', 'capped'],
        bound: 'one VIOLATION frame each, at most VIOLATION_EVENT_LIMIT per environment', test: 'src/lib/in-sandbox-script.test.ts (S5)' },
    { realm: 'cooperative', surface: 'DOMContentLoaded', modes: ['cooperative'], owner: 'guest-script', handling: ['own'],
        bound: 'the startup gate: a trusted one opens it, once, and a guest\'s own is not trusted; with autoResize, the body is observed once it exists', test: 'test/unit/broad-review-bootstrap.test.ts (S46); src/lib/in-sandbox-script.test.ts (B6)' },
    { realm: 'cooperative', surface: 'every other event of the guest document', modes: ['cooperative'], owner: 'guest-script', handling: ['unheard'],
        bound: 'the guest\'s own document on the host page\'s thread: same-thread execution is a cooperative-mode limit (README)', test: 'README (cooperative-mode limits)' },

    // ---- the strict view: what it renders, and its own listeners (owner: the view, in-sandbox-view.ts)
    { realm: 'view', surface: 'securitypolicyviolation', modes: ['strict'], owner: 'view', handling: ['relayed', 'capped'],
        bound: 'one VIOLATION frame each, at most VIOLATION_EVENT_LIMIT per directive', test: 'test/e2e/violations.spec.ts' },
    { realm: 'view', surface: 'resource loads', modes: ['strict'], owner: 'view', handling: ['budgeted'],
        bound: 'VIEW_MAX_URLS and VIEW_URLS_PER_SECOND', test: 'test/e2e/review-round-4.spec.ts (M-2)' },
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
        bound: 'the one INIT_VIEW, from the host page; the guest has no window to post from', test: 'test/e2e/review-strict.spec.ts' },

    // ---- the host page's window, and the element's frame in it
    { realm: 'host', surface: 'load', modes: ['strict', 'worker', 'cooperative'], owner: 'host', handling: ['own'],
        bound: 'the wrapper frame\'s load: it loads once; a guest that navigates or reloads it ends the sandbox at the second', test: 'test/unit/broad-review.test.ts; test/e2e/lifecycle.spec.ts' },
    { realm: 'host', surface: 'message', modes: ['strict', 'worker', 'cooperative'], owner: 'host', handling: ['own'],
        bound: 'the element takes the guest frame\'s one announcement; anything else a cooperative guest posts to the host window is the host page\'s to read (a cooperative-mode limit: messages to the host window), and strict and worker mode run no guest code in a window', test: 'test/unit/broad-review.test.ts (CB1)' },
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
