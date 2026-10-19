import type { SafeCapability, UnsafeCapability } from "./csp-directives";
import { SAFE_CAPABILITIES, UNSAFE_CAPABILITIES, UNSAFE_PERMISSIONS } from "./csp-directives";
import { cooperativePolicy, fileKinds, strictViewPolicy } from "./lib/csp/csp-generator";
import { NO_ORIGINS, parseOrigins, shown, type OriginPolicy, type SandboxOrigins, type StrictSandboxOrigins } from "./lib/csp/origins";
import { FALLBACK_TYPE, fileError, FileStore, isJavaScriptType, type FileEntry, type FileInfo, type FileSnapshotEntry } from "./lib/files";
import { createGuestWrites, parseCommitArguments, WRITE_METHOD, type GuestWrite, type GuestWriteAnswer, type GuestWrites } from "./lib/guest-writes";
import { inSandboxFiles, inSandboxImportMap, inSandboxMarkup } from "./lib/in-sandbox-files";
import { kindMismatchMessage, rewriteGuestMarkup, type MarkupParts } from "./lib/markup-references";
import { scriptInMarkup } from "./lib/markup-scripts";
import { LOAD_KINDS } from "./lib/load-kinds";
import { mergeGuestImportMaps } from "./lib/import-map";
import { deepMerge } from "./lib/utils";
import { ANNOUNCEMENT_TYPE, inSandboxScript } from "./lib/in-sandbox-script";
import { createBroker, RESERVED_METHOD_PREFIX } from "./lib/rpc";
import { createSizeOf } from "./lib/structured-size";
import { workerBootstrap } from "./lib/worker-bootstrap";
import { keepOnlyWorkerGlobals, WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS } from "./lib/worker-globals";
import { filterCapabilities } from "./lib/capabilities";
import { startWatchdog, watchdogBudget, type Watchdog } from "./lib/watchdog";
import { setLongTimeout, type LongTimeout } from "./lib/long-timer";
import { createRateLimiter, type RateLimiter } from "./lib/rate-limit";
import { toViolationDetail, VIOLATION_DIRECTIVES, VIOLATION_EVENT_LIMIT, type SandboxViolation } from "./lib/violation";
import { createLogLimiter, LOG_EVENTS_PER_SECOND, LOG_MAX_BYTES, LOG_OWN_LINES, toLogDetail, type SandboxLog, type SandboxLogLevel } from "./lib/sandbox-log";
import { startAutoResize, type AutoResizer } from "./lib/auto-resize";
import { createFetchBridge, fetchRefusal, FETCH_METHOD, toFetchPolicy, type FetchBridge, type FetchBridgeConfig, type FetchPolicy, type FetchRecord } from "./lib/fetch-bridge";
import { buildGuestDocument, buildWrapperDocument, FRAME_REFERRER_POLICY, permissionAttributes, toInlineScriptLiteral, WRAPPER_STYLE } from "./lib/frame-documents";
import { scriptHashSource } from "./lib/csp/script-hash";
import { setWrapperSrcdoc, TRUSTED_TYPES_POLICY, TrustedTypesRefusal } from "./lib/trusted-types";
import { assertEntryScoped, buildViewDocument, entryDoneName, inStrictWorker, isViewFileType, VIEW_FILE_TYPES, viewBootstrapHash, viewBootstrapText, VIEW_EVENT_TYPES, VIEW_MAX_CHARACTERS, VIEW_MAX_DEPTH, VIEW_MAX_ELEMENTS, VIEW_MAX_URLS, VIEW_OPTIONS, VIEW_RENDER_MAX_LENGTH, VIEW_STILL_STYLE, VIEW_TARGET_MAX_LENGTH, VIEW_WRITE_TYPES } from "./lib/in-sandbox-view";

/**
 * The element's configuration, passed to setConfig(): every option left out takes its default
 * (DEFAULT_SANDBOX_CONFIG), not its previous value. Reference with defaults and modes: docs/API.md#configuration.
 *
 * A union keyed by `mode` (ADR-007), so what a mode cannot use does not type-check: strict mode's `origins` has no
 * `scripts`. A config from JSON is held to the same rules at run time (dropped with a warning). Strict mode is the
 * default, so a config that names no mode is a strict config; cooperative and worker mode are named.
 */
export type SandboxConfig = StrictSandboxConfig | CooperativeSandboxConfig | WorkerSandboxConfig;

/**
 * Strict mode (ADR-005), the default: guest code runs only in a worker spawned by a view document that runs no guest
 * script; the worker draws into the view with sandboxView.render(). `html` is the initial view, rendered without its
 * scripts and handlers.
 */
export interface StrictSandboxConfig extends SandboxConfigOptions {
    /** Execution mode: strict when left out. Any value that is not a mode starts no environment (review A4). */
    mode?: 'strict';
    /** As in the other modes, without `scripts`: the view runs only the library's bootstrap. */
    origins?: StrictSandboxOrigins;
    /** Not in strict mode (review round 1, R3-6): no capability reaches outside the view. Dropped at run time. */
    unsafeCapabilities?: never;
}

/**
 * Cooperative mode, for content that cooperates: guest code runs in the guest document, within a frozen list of
 * documented limits (README, "Cooperative-mode limits"); 'iframe' was renamed 'cooperative'.
 */
export interface CooperativeSandboxConfig extends SandboxConfigOptions {
    mode: 'cooperative';
    /** The exact origins the guest may load each kind from (src/lib/csp/origins.ts). Default: none. */
    origins?: SandboxOrigins;
    /** Strict mode only (review round 1, R3-6); ignored with a warning at run time. */
    entry?: never;
    /** Strict mode only: the guest document is the guest's own; ignored with a warning at run time. */
    allowAnimations?: never;
    /** Strict mode only; ignored with a warning at run time. */
    allowAutoplay?: never;
    /** Worker and strict mode only: the guest document may share the host's thread, so no timer could fire (R3-6). */
    workerExecutionTimeout?: never;
}

/** Worker mode: guest code runs in a worker inside the frame (frozen; to be folded into strict mode, S49). */
export interface WorkerSandboxConfig extends SandboxConfigOptions {
    mode: 'worker';
    /** The exact origins the guest may load each kind from (src/lib/csp/origins.ts). Default: none. */
    origins?: SandboxOrigins;
    /** Strict mode only (review round 1, R3-6); ignored with a warning at run time. */
    entry?: never;
    /** Strict mode only: a worker has no document; ignored with a warning at run time. */
    allowAnimations?: never;
    /** Strict mode only; ignored with a warning at run time. */
    allowAutoplay?: never;
    /** A worker has no document (R3-6): ignored. */
    html?: never;
    /** A worker has no document to measure (R3-6): no effect, with a warning at run time. */
    autoResize?: never;
}

/** The element's events and what each one carries (docs/API.md#events; review round 1, R4-12). */
export interface WebSandboxEventMap extends HTMLElementEventMap {
    ready: CustomEvent<null>;
    terminated: CustomEvent<{ reason: string }>;
    'sandbox-log': CustomEvent<SandboxLog>;
    violation: CustomEvent<SandboxViolation>;
    fetch: CustomEvent<FetchRecord>;
    fileschanged: CustomEvent<{ paths: string[] }>;
    fileswritten: CustomEvent<{ readonly paths: readonly string[] }>;
}

/** Typed listeners for the element's events (WebSandboxEventMap; R4-12): types only, merged into the class. */
export interface WebSandbox {
    addEventListener<K extends keyof WebSandboxEventMap>(type: K, listener: (this: WebSandbox, event: WebSandboxEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
    removeEventListener<K extends keyof WebSandboxEventMap>(type: K, listener: (this: WebSandbox, event: WebSandboxEventMap[K]) => unknown, options?: boolean | EventListenerOptions): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

declare global {
    interface HTMLElementTagNameMap {
        /** The element under its default tag name (defineWebSandbox()). */
        'web-sandbox': WebSandbox;
    }
}

/** The options every mode takes. */
export interface SandboxConfigOptions {
    /**
     * 'unsafe-eval', needed to use .execute method (run arbitrary code in the sandbox). For testing: enabling it
     * logs one warning per instance (backlog S4), since it lets guest code compile strings as code.
     * Only a literal `true` enables it. Default false.
     */
    scriptUnsafe?: boolean;
    /** Sandbox attributes that keep the guest inside the frame (SAFE_CAPABILITIES). Default []. */
    capabilities?: SafeCapability[];
    /**
     * Capabilities that reach outside the frame (popups, modals, downloads, forms, presentation, fullscreen). Opt-in
     * only, logs a warning. Dropped in strict mode. Default [].
     */
    unsafeCapabilities?: UnsafeCapability[];
    /**
     * Initial HTML content: the initial view in strict mode (its scripts and handlers do not run; one warning per
     * element says so), the guest document in cooperative mode. Ignored in worker mode. Empty (the default) means
     * `<div id="root"></div>`. load() sets it too.
     */
    html?: string;
    /**
     * Strict mode: the path of a registered JavaScript file the worker runs first, as a classic script.
     * Ignored (with a warning) in other modes.
     */
    entry?: string;
    /**
     * Strict mode: whether CSS animations and transitions run in the view. Default `true`. Left out (or `undefined`) or
     * `true` keeps them; any other value turns them off: `false`, and anything that is not a boolean, with one warning.
     * Ignored, with a warning, in the other modes.
     *
     * **Warning**: while `true` (the default), CSS animations and transitions in the view run on the host page's main
     * thread wherever the browser runs the view there: Firefox, Safari and every WebKit browser, Android (Android WebView
     * always), and Chromium without sandboxed-iframe isolation; desktop Chromium 127+ isolates the view in a process of
     * its own. A guest can then keep the host page busy (measured: 80–98% of its main thread) for as long as they run:
     * the view's time budget does not bound them. Set `false` to remove animations and transitions from the view
     * (elements show their end state), which restores the bound. With `false`, a host page whose `style-src` refuses
     * inline styles must allow the view's stylesheet by its hash (docs/API.md#host-page-policy).
     */
    allowAnimations?: boolean;
    /**
     * Strict mode: whether `<video autoplay>` and `<audio autoplay>` in the view start on their own. Default `false`: the
     * `autoplay` attribute is removed, and media plays only when the user starts it. Only a literal `true` keeps it: left
     * out (or `undefined`) or `false` removes it, and so does any other value, with one warning when it is not a boolean.
     * Ignored, with a warning, in the other modes.
     *
     * **Warning**: with `true`, autoplaying media decodes and paints on the host page's main thread wherever the view
     * runs there (see `allowAnimations`), for as long as it plays, and the view's time budget does not bound it
     * (measured: up to +6 points of the host page's main thread for 20 looping videos).
     */
    allowAutoplay?: boolean;
    /**
     * A budget in ms for each execute() (worker and strict mode); 0 (the default) is off. At the deadline the guest's
     * event loop must be free: the host pings it, and a guest that does not answer within
     * EXECUTION_TIMEOUT_GRACE_MS ends the sandbox ('Execution Timeout', then 'terminated'). See _armExecutionBudget.
     */
    workerExecutionTimeout?: number;
    /**
     * Liveness watchdog budget in ms (0 = off, the default): terminates a guest that stops answering for this long.
     * Off by default because legitimate synchronous work longer than the budget would be stopped too. See src/lib/watchdog.ts for what it can and cannot bound.
     */
    watchdogTimeout?: number;
    /**
     * Content auto-sizing (cooperative and strict mode, off by default): the element's height follows the guest's content
     * height, validated, clamped and rate-limited on the host (src/lib/auto-resize.ts). Only a literal true
     * enables it. No effect in worker mode, which has no document (one warning per instance).
     */
    autoResize?: boolean;
    /**
     * The host-mediated fetch bridge (off by default): the guest gets sandboxFetch(url, init), and the host makes
     * the request under a fixed discipline (exact-origin allowlist, no credentials, no redirects, capped body
     * and time) and reports each one as a 'fetch' event. The guest policy is unchanged. See src/lib/fetch-bridge.ts.
     */
    fetchBridge?: FetchBridgeConfig;
    /**
     * Guest writes (off by default): the guest's sandboxFiles.write() and remove() are recorded by the host in an
     * overlay of this environment, checked like registerFiles(), reported as 'fileswritten', listed by
     * listGuestWrites() and applied only by commitGuestWrites(). Only a literal true enables it. See
     * src/lib/guest-writes.ts.
     */
    guestWrites?: boolean;
    /**
     * The per-second budget of the calls the guest makes (every mode): `maxPerSecond` calls and `maxBytesPerSecond`
     * bytes of them in any one-second window, per environment. The guest's bridge refuses a call past it with BUSY,
     * and the element answers BUSY to one that arrives anyway. A field left out takes its default; one that is not a
     * finite number >= 1 takes its default with one warning. There is no "off".
     */
    callLimits?: CallLimits;
}

/** `callLimits` (docs/API.md#calllimits): the per-second budget of the calls the guest makes. */
export interface CallLimits {
    /** Calls per second. Default 1000. */
    maxPerSecond?: number;
    /** Bytes of calls per second, each call's whole message measured as RPC_MAX_BYTES is. Default 67108864 (64 MiB). */
    maxBytesPerSecond?: number;
}

/**
 * Where the element is in its lifecycle (read it from `sandbox.state`):
 *   idle        constructed, or removed from the document: no frame
 *   loading     a frame was created; waiting for the guest to check in (its bootstrap announces its port, S46; in
 *               worker mode once its worker runs; in strict mode the view's bootstrap checks in on its own port), or
 *               without a bootstrap (no allow-scripts), for the frame's one load
 *   ready       the guest's port is this environment's and 'ready' dispatched; in cooperative mode the guest document
 *               may still be loading (its calls and execute() wait in the guest until it is parsed)
 *   terminated  torn down by terminate(), a budget (watchdog, workerExecutionTimeout), a frame-integrity check
 *               or a build that failed; stays so until reset(), load() or setConfig() builds a new environment
 * There is deliberately no 'running' state: nothing the guest reports could make it truthful (execute() reports
 * nothing back, and guest code as a whole never says it is running or that it stopped).
 */
export type SandboxState = 'idle' | 'loading' | 'ready' | 'terminated';

/** The execution modes. Anything else is refused: the sandbox does not start (review A4). */
const SANDBOX_MODES = ['strict', 'cooperative', 'worker'] as const;
type SandboxMode = (typeof SANDBOX_MODES)[number];
const isSandboxMode = (mode: unknown): mode is SandboxMode => (SANDBOX_MODES as readonly unknown[]).includes(mode);

// Old names of modes: refused like any other value that is not a mode, never an alias (nothing is published, so no
// config needs one), and the refusal names the new one.
const RENAMED_MODES: Readonly<Record<string, SandboxMode>> = Object.freeze({ iframe: 'cooperative' });

// " ('iframe' was renamed 'cooperative')" for an old name, else ''.
function renamedModeNote(mode: unknown): string {
    if (typeof mode !== 'string' || !Object.hasOwn(RENAMED_MODES, mode)) return '';
    return ` ('${mode}' was renamed '${RENAMED_MODES[mode]}')`;
}

/**
 * The configuration as the element keeps it: the options merged over the defaults. `origins` is not kept here: it is
 * parsed into an OriginPolicy by setConfig() (_origins). `mode` can hold a value that is not a mode; every build
 * is refused then (_buildRefusal).
 */
type StoredConfig = SandboxConfigOptions & { mode?: SandboxMode };

const DEFAULT_SANDBOX_CONFIG: StoredConfig = {
    scriptUnsafe: false,
    capabilities: [],
    unsafeCapabilities: [],
    html: '',
    mode: 'strict',
    workerExecutionTimeout: 0,
    watchdogTimeout: 0,
    autoResize: false,
    guestWrites: false,
    allowAnimations: true,
    allowAutoplay: false,
};

// Texts of the host's own refusals, for people reading them. Code branches on the error's `code`
// ('TERMINATED', set by the broker), never on these texts: a guest handler can throw the very same text,
// and that call rejects with code 'HANDLER_ERROR' instead.
const TERMINATED_CALL_MESSAGE = "[Sandbox] call() rejected: the sandbox was terminated. Call reset(), setConfig() or load() to start a new one.";
const RESET_CALL_MESSAGE = "[Sandbox] call() rejected: the sandbox was reset or terminated.";
const IDLE_CALL_MESSAGE = "[Sandbox] call() rejected: the sandbox is not in the document. Call it once the element is inserted.";

// What the bootstrap writes and registers for one build's guest markup (cooperative mode).
interface GuestMarkupPlan {
    // the markup cut into parts for the bootstrap to write (markup-references.ts), or null to embed it as written
    parts: MarkupParts | null;
    // the one import map (module graph, PR3): every registered JavaScript file, plus the guest's own
    // inline maps merged (import-map.ts), or null when no JavaScript file is registered
    importMap: { paths: string[]; guest: string | null } | null;
}

const NO_MARKUP_PLAN: GuestMarkupPlan = { parts: null, importMap: null };

// The sandbox flags of strict mode's view, always: scripts for its bootstrap, and forms so that `submit` reaches it, to be
// forwarded to the worker's handlers and cancelled (research 15, P4: without allow-forms Chromium and Firefox dispatch no
// submit). allow-forms is an unsafe capability in cooperative and worker mode (review round 1, R2-2: a modifier-click
// submission opens a new tab past form-action in Chromium), not here: no guest script runs in the view to synthesize a
// click, the view cancels every submit, and its forms keep no action, formaction, method or target (ADR-005). So the
// owner's move of allow-forms leaves strict mode as it was.
const STRICT_VIEW_FLAGS = ['allow-scripts', 'allow-forms'] as const;
const STRICT_CAPABILITIES = [...SAFE_CAPABILITIES, ...STRICT_VIEW_FLAGS] as const;

// The per-second budget of the calls the guest makes, per environment (review round 3, M-2): calls, and bytes of their
// frames, in any one-second window. The defaults of `callLimits`; the configuration gives the budget in callBudgetOf(),
// the one place both ends take it from (the host's window, _admitGuestCall; the guest's broker, through the bootstrap's
// features).
// 1000 calls (review round 4, M-6, the owner's decision): the reviewers measured Firefox's host page 32–37% busy at 4900
// calls per second, with gaps of 1.8 s in bursts. At 1000, a strict guest calling paced at the budget and one sending
// a second's worth at once each second left Firefox's host page its idle ticks, longest gap 15–27 ms
// (test/e2e/review-round-4.spec.ts, "M-6").
const GUEST_CALLS_PER_SECOND = 1000;
const GUEST_CALL_BYTES_PER_SECOND = 67108864;

interface CallBudget {
    calls: number;
    bytes: number;
}

const DEFAULT_CALL_BUDGET: Readonly<CallBudget> = Object.freeze({ calls: GUEST_CALLS_PER_SECOND, bytes: GUEST_CALL_BYTES_PER_SECOND });

// The call budget `callLimits` asks for (from the copy setConfig() took). Each field is a finite number >= 1, else its
// default: left out, silently; anything else (Infinity, a number below 1, NaN, a string), with a warning. There is no
// "off": a budget that can be lifted is one a config typo lifts. Nor a budget that admits nothing (review round 4, C-6):
// below 1, every call was BUSY forever, without a word, since no call weighs less than 1. Never throws: a callLimits that
// is not an object is warned about and gives the defaults.
function callBudgetOf(callLimits: unknown, warn: (message: string) => void): Readonly<CallBudget> {
    if (callLimits === undefined) return DEFAULT_CALL_BUDGET;
    if (!callLimits || typeof callLimits !== 'object' || Array.isArray(callLimits)) {
        warn(`[Sandbox] callLimits must be an object; ${shown(callLimits)} was ignored: the defaults apply (${DEFAULT_CALL_BUDGET.calls} calls and ${DEFAULT_CALL_BUDGET.bytes} bytes per second).`);
        return DEFAULT_CALL_BUDGET;
    }
    const limits = callLimits as Record<string, unknown>;
    const field = (name: keyof CallLimits, fallback: number): number => {
        const value = limits[name];
        if (value === undefined) return fallback;
        if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return value;
        warn(`[Sandbox] callLimits.${name} must be a finite number >= 1; ${typeof value === 'number' ? String(value) : shown(value)} was ignored: the default ${fallback} applies.`);
        return fallback;
    };
    return Object.freeze({ calls: field('maxPerSecond', DEFAULT_CALL_BUDGET.calls), bytes: field('maxBytesPerSecond', DEFAULT_CALL_BUDGET.bytes) });
}

// Why a guest call past the budget is refused (BUSY): the same words in the guest's broker (in-sandbox-script.ts).
const callBudgetText = (budget: Readonly<CallBudget>) => `more than ${budget.calls} calls or ${budget.bytes} bytes of calls in one second`;

const STRICT_HTML_SCRIPT_WARNING = "[Sandbox] strict mode (the default) runs no script in `html`; name a registered file in `entry`, or choose `mode: 'cooperative'`.";

const DEFAULT_TERMINATE_REASON = 'terminated by the host';
const WATCHDOG_REASON = 'the guest stopped responding (watchdog)';
const ENTRY_FAILED_REASON = 'the guest entry failed to start';
const VIEW_LOST_REASON = 'the sandbox view stopped responding';
const EXECUTION_TIMEOUT_REASON = 'the executed code ran longer than workerExecutionTimeout';
const CONFIG_REFUSED_REASON = 'the configuration could not be used';
const BUILD_FAILED_REASON = 'the environment could not be built';
const SECOND_LOAD_REASON = 'the sandbox frame loaded a second time';
const SECOND_ANNOUNCEMENT_REASON = 'the guest frame announced itself again (it reloaded or rewrote its document)';
const LOAD_TIMEOUT_REASON = 'the sandbox did not finish loading';
// What the host page's own policy can refuse (review round 1, R3-1): the sandbox's frames are srcdoc documents, and a
// srcdoc document inherits the policies of the page that made it (CSP3: a copy of its policy list; Trusted Types;
// COEP). Each reason names the policy, so a misconfigured host page is told what to allow (docs/API.md#host-page-policy).
const STARTUP_BLOCKED_REASON = "the sandbox's startup script did not run: the host page's Content-Security-Policy must allow it (see docs/API.md#host-page-policy)";
const WORKER_REFUSED_REASON = "the sandbox's worker could not be loaded: the host page's policy refuses blob: workers (worker-src; WebKit also under Cross-Origin-Embedder-Policy; see docs/API.md#host-page-policy)";
const TRUSTED_TYPES_REASON = `the host page's Trusted Types policy does not allow the policy name '${TRUSTED_TYPES_POLICY}' (trusted-types; see docs/API.md#host-page-policy)`;
// What worker mode's frame may announce instead of a port (worker-bootstrap.ts), and the reason each ends the build with.
const WORKER_FRAME_REFUSALS: Readonly<Record<string, string>> = Object.freeze(Object.assign(Object.create(null), {
    'worker': WORKER_REFUSED_REASON,
    'trusted-types': TRUSTED_TYPES_REASON,
    'failed': `${BUILD_FAILED_REASON} (Error)`,
}));

// Plain data, compared as data (R3-7): the same primitives, arrays and plain objects, key by key. Anything else (a
// Date, a Map, a typed array) never compares equal, so a config holding one always rebuilds.
// Each pair of objects is compared once (review round 2, C-7): a config is a structured clone, which keeps shared
// references, and a recursive comparison walked a shared object once per path to it, exponential in the nesting (one
// object shared 24 levels deep blocked setConfig() for 2.4 s). A pair already compared, or being compared, adds nothing:
// were it different, the comparison already in progress or done answers so. At most SAME_DATA_MAX_PAIRS pairs are
// compared; past that, and past a depth of 64, the configs count as different, which only costs a rebuild.
const SAME_DATA_MAX_PAIRS = 10000;
function sameData(a: unknown, b: unknown): boolean {
    const compared = new Map<object, Set<object>>();
    const pending: [unknown, unknown, number][] = [[a, b, 0]];
    let pairs = 0;
    while (pending.length > 0) {
        const [x, y, depth] = pending.pop()!;
        if (Object.is(x, y)) continue;
        if (depth > 64 || !x || !y || typeof x !== 'object' || typeof y !== 'object') return false;
        const partners = compared.get(x) ?? new Set<object>();
        if (partners.has(y)) continue;
        if (++pairs > SAME_DATA_MAX_PAIRS) return false;
        partners.add(y);
        compared.set(x, partners);
        const arrays = Array.isArray(x);
        if (arrays !== Array.isArray(y)) return false;
        if (!arrays && (Object.getPrototypeOf(x) !== Object.prototype || Object.getPrototypeOf(y) !== Object.prototype)) return false;
        const keys = Object.keys(x);
        if (keys.length !== Object.keys(y).length) return false;
        for (const key of keys) {
            if (!Object.hasOwn(y, key)) return false;
            pending.push([(x as Record<string, unknown>)[key], (y as Record<string, unknown>)[key], depth + 1]);
        }
    }
    return true;
}

// The first statement after the globals allowlist in worker mode's worker unless scriptUnsafe (R2-5). Stringified.
function removeWebAssembly(g: { WebAssembly?: unknown }) {
    if (!('WebAssembly' in g)) return;
    delete g.WebAssembly;
    if ('WebAssembly' in g) throw new Error('[Sandbox] the worker could not remove WebAssembly');
}

// What a reason or a host line says about an error the element caught (focused review 2026-10-14, F3): a fixed
// text of the element's own plus the error's name, never its message. The message is whatever the thrower put
// there: Chromium's DataCloneError quotes the source of the function it could not clone, a throwing getter's
// error carries any text, a guest's error is the guest's text. A reason reaches 'terminated' listeners, the
// console warning and every log an embedder keeps, so it carries none of that. The name is checked too (a thrown
// object can name itself anything): a short identifier, else "Error"; a thrown primitive is named by its type.
// The one rule for every caught error: build failures, unusable configs, an entry that failed (whose text
// arrives as a 'guest' line instead, the guest's own words labelled as such).
function errorName(error: unknown): string {
    if (error === null) return 'null';
    if (typeof error !== 'object' && typeof error !== 'function') return typeof error;
    try {
        const name = (error as { name?: unknown }).name;
        if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name)) return name;
    } catch {
        // a name that throws: named below
    }
    return 'Error';
}

// The first statement of every guest worker's source, worker mode and strict mode (independent verification
// 2026-10-14, V1): the worker keeps only the allowlisted globals (worker-globals.ts) before any other script of the
// library or the guest runs there, so every request guest code can make goes through an API the policy governs on
// every engine. `global` is the expression for the global object in that source.
// The call is an expression whose value is the worker's postMessage, which it deleted (worker-globals.ts); strict mode
// runs it as a statement and keeps nothing of it.
const workerGlobalsCall = (global: string) =>
    `(${keepOnlyWorkerGlobals.toString()})(${global}, ${toInlineScriptLiteral(WORKER_GLOBALS)}, ${toInlineScriptLiteral(WORKER_NAVIGATOR_MEMBERS)})`;
const workerGlobalsStatement = (global: string) => `${workerGlobalsCall(global)};`;

// The guest frame's window: the wrapper's frames[0], or null. Read by length first: the wrapper is cross-origin to
// the host, and reading an index a cross-origin window does not have throws a SecurityError.
function guestWindowOf(iframe: HTMLIFrameElement | null): Window | null {
    const wrapper = iframe?.contentWindow;
    if (!wrapper || wrapper.length < 1) return null;
    return wrapper[0] ?? null;
}

// A worker's uncaught error as a guest line, prefixed once: Chromium's ErrorEvent message already starts with
// "Uncaught", Firefox's and WebKit's do not.
const uncaughtLine = (message: string) => (message.startsWith('Uncaught ') ? message : `Uncaught ${message}`);

// The guest line of an error text the strict view relays (GUEST_ERROR, GUEST_UNCAUGHT): composed, then cut once, to the
// length the view cuts the text to (review round 4, M-4: the text was cut and "Uncaught " added after, so the line
// reached 2056–2057 characters in Firefox and WebKit, whose messages carry no prefix of their own).
const viewErrorLine = (message: unknown) => uncaughtLine(typeof message === 'string' ? message : '').slice(0, VIEW_OPTIONS.guestText.maxLength);

// What the element says when the view dropped guest error texts past its window (review round 4, M-5).
const VIEW_TEXT_DROPPED_LINE = `[Sandbox] the guest raised more than ${VIEW_OPTIONS.guestText.perSecond} uncaught errors in one second that only the view could describe; errors past that are dropped in the view.`;

/**
 * workerExecutionTimeout's grace (focused review 2026-10-14, F2): at an execute()'s deadline the host pings the
 * guest, and a guest that has not answered within this long is terminated. Only a free event loop can answer, so
 * this is how long the loop may still be busy at the deadline; counted in ticks, so a host stall never counts.
 */
export const EXECUTION_TIMEOUT_GRACE_MS = 1000;

/**
 * Strict mode's view liveness check (A5): always on, independent of watchdogTimeout. The view runs no guest
 * script, so it answers within this budget unless it is gone (Chromium replaces a view whose navigation the
 * wrapper refuses with an error page, research 15 P4) or rendering guest markup keeps its thread busy for
 * that long. Host stalls are never counted (watchdog.ts).
 */
export const VIEW_LIVENESS_TIMEOUT_MS = 5000;

/**
 * How long a build may stay `loading` (broad review 2026-10-14, CB3): the liveness budget, counted in host ticks
 * (watchdog.ts), so a host stall never counts. It bounds the wait for the guest's check-in: the announcement its
 * bootstrap posts as its first statement (cooperative mode, S46), the frame's announcement once its worker runs (worker
 * mode), or the view's check-in on its own port (strict mode, R3-1); and, where no bootstrap runs (no allow-scripts),
 * the wait for the frame's one load. A build still `loading` then is terminated with 'the sandbox did not finish
 * loading', or with the reason that names the host page's policy when the frame loaded and its startup script never
 * checked in. Where a bootstrap checks in, the guest's own subresources and scripts
 * never count (the check-in comes before them): a guest page with slow images, or one that never finishes its
 * document, is `ready`. Without one, the frame's load waits for the guest's subresources, and they count.
 */
export const LOAD_TIMEOUT_MS = VIEW_LIVENESS_TIMEOUT_MS;

// What the host posts to a strict view with its two ports (INIT_VIEW).
interface StrictInit {
    workerSource: string;
    viewFiles: FileSnapshotEntry[];
    html: string;
    autoResize: boolean;
    allowAnimations: boolean;
    allowAutoplay: boolean;
    // The origins the view's policy admits for the loads its markup makes, by kind key (review round 4, M-2): the
    // renderer drops an http(s) URL outside them, so the browser never processes a refusal.
    origins: { images: readonly string[]; media: readonly string[] };
}

// The strict view's two switches and the value each takes when it is left out. A value that is a boolean is itself; one
// left out (or undefined) takes its default; anything else is false, the safe side of both (animations removed, no
// autoplay), with a warning.
const VIEW_SWITCHES = { allowAnimations: true, allowAutoplay: false } as const;
type ViewSwitch = keyof typeof VIEW_SWITCHES;
const VIEW_SWITCH_OFF: Readonly<Record<ViewSwitch, string>> = {
    allowAnimations: 'animations and transitions are removed from the view',
    allowAutoplay: 'media in the view does not autoplay',
};

/**
 * The `<web-sandbox>` element: one sandboxed environment for untrusted web content, rebuilt by setConfig(),
 * load() and reset(). Register it with defineWebSandbox(). Public surface: docs/API.md.
 */
// What the element extends: HTMLElement where there is a DOM. Importing the package must not need one (review round 2,
// C-8): an embedder reads viewScriptHash() in a build step, in Node or Bun, and the class declaration is the only thing
// evaluated at import that names a DOM interface. Without a DOM the class extends an empty one, which nothing constructs.
const ElementBase: typeof HTMLElement = typeof HTMLElement === 'function' ? HTMLElement : (class {} as unknown as typeof HTMLElement);

export class WebSandbox extends ElementBase {
    private _iframe: HTMLIFrameElement | null = null;
    private _frameLoaded = false;
    // The reversed handshake (broad review 2026-10-14, CB1): whether this build's guest runs a bootstrap that announces
    // its port; the guest frame's window whose announcement was accepted (S46: the wrapper's load must still hold it);
    // and the listener on the host's window, removed by _teardown. Cooperative and worker mode only.
    private _expectAnnouncement = false;
    private _guestWindow: Window | null = null;
    private _stopListening: (() => void) | null = null;
    private _loadDeadline: Watchdog | null = null; // LOAD_TIMEOUT_MS until the guest checks in, or a frame with no bootstrap loads (CB3, S46)
    // The reason of the 'terminated' being dispatched, while it is, or null (CB5; see _terminateBuild). Every 'terminated'
    // is dispatched through _dispatchTerminated, which sets it (review round 4, L-3).
    private _terminationDispatched: string | null = null;
    private _buildInputs = 0; // counts changes to what a build reads: setConfig(), load(), the files
    private _buildWithin: string | null = null; // the 'terminated' being dispatched when this build started (L-4)
    private _state: SandboxState = 'idle'; // changed only by _enterState()
    private _watchdog: Watchdog | null = null;
    private _resizer: AutoResizer | null = null; // this environment's auto-sizing (B6), or null when off
    private _autoHeight: string | null = null;   // the inline height auto-sizing last wrote on the element
    private _fetchPolicy: FetchPolicy | null = null; // the validated fetchBridge config, or null when off (B5)
    private _origins: OriginPolicy = NO_ORIGINS; // the parsed `origins` (ADR-007), what the guest policy admits
    private _warnedOrigins = new Set<string>();  // origins warnings (an entry dropped, connectionsAllowed), once each per instance
    private _fetchBridge: FetchBridge | null = null; // this environment's bridge: its requests end with it
    private _warnedFetchBridge = new Set<string>();  // fetchBridge config warnings, once each per instance
    private _warnedCallLimits = new Set<string>();   // callLimits config warnings, once each per instance
    // The guest-write overlay (C5): created by each build when guestWrites is on, else null. It outlives its
    // environment's termination (closed, still listable and committable) and is discarded by the next build and on
    // removal (_discardGuestWrites).
    private _guestWrites: GuestWrites | null = null;
    private _violationCounts = new Map<string, number>(); // 'violation' events dispatched per source for the current environment (capped, violation.ts)
    private _logLimiter = createLogLimiter(); // guest 'sandbox-log' events per second for the current environment (sandbox-log.ts)
    // The per-second budget of the guest's calls (M-2): what the config gives (callBudgetOf), and this environment's
    // windows, made again by every teardown.
    private _callBudget: Readonly<CallBudget> = DEFAULT_CALL_BUDGET;
    private _guestCalls: RateLimiter = createRateLimiter(DEFAULT_CALL_BUDGET.calls);
    private _guestCallBytes: RateLimiter = createRateLimiter(DEFAULT_CALL_BUDGET.bytes);
    private _warnedLogLimit = false;          // the log rate limit warned for the current environment
    private _ownLines = 0;                    // the guest relay's own lines dispatched for the current environment (LOG_OWN_LINES)
    private _warnedLogBytes = false;          // a guest line past LOG_MAX_BYTES warned for the current environment
    private _warnedViewTextDropped = false;   // the view's notice that it dropped guest error texts, for the current environment (M-5)
    // Counts environments: every teardown increments it. Read by _notifyThenAct, the one path for a host action that
    // dispatches an event and then acts on the environment, so a listener that reset or terminated the sandbox in between
    // is never undone (review B5); and by _postRpc, so a call is sent only to the environment it was made in (L-2).
    private _generation = 0;
    // The environment (its _generation) of the host call being made now, while the broker copies its arguments and
    // sends it (_issue), or null outside one.
    private _issuedIn: number | null = null;
    private _config: StoredConfig = structuredClone(DEFAULT_SANDBOX_CONFIG);
    // Why the last setConfig() argument could not be used, or null: while set, every build is refused with
    // this reason (initialize), as for an unknown mode.
    private _configRefusal: string | null = null;
    private _port: MessagePort | null = null;     // the guest's port: the guest document's bootstrap, or the worker (logic port)
    private _viewPort: MessagePort | null = null; // strict mode: the view's port (violations, resize, entry errors, liveness)
    private _viewWatchdog: Watchdog | null = null; // strict mode: the view liveness check (A5)
    // Strict mode (R4-4): guest writes posted to the view and not yet confirmed (VIEW_WRITTEN), by id; their guest is
    // answered on confirmation. Emptied by every teardown.
    private _viewWrites = new Map<number, { shown: () => void; lost: (error: Error) => void }>();
    private _viewWriteIds = 0;
    private _strictInit: StrictInit | null = null; // strict mode: what the next frame load hands the view
    private _executionTimers = new Set<LongTimeout>(); // workerExecutionTimeout deadlines of this environment
    // Liveness probes started at a deadline (F2): each PING number they sent (negative, so never the watchdog's)
    // → that probe's end. A PONG to any of a probe's pings passes it.
    private _executionProbes = new Map<number, () => void>();
    private _probePings = 0; // numbers the probes' pings: -1, -2, …
    // What waits for the port while loading, in the order it was issued (review round 2, L-3): execute() code and the
    // host's own RPC requests (cloned at call time). Two queues, flushed one after the other, sent a call made before an
    // execute() after it.
    private _queue: ({ code: string } | { frame: unknown })[] = [];
    private _warnedUnsafeCapabilities = new Set<string>();
    private _warnedScriptUnsafe = false; // the scriptUnsafe guard rail warns once per instance (S4)
    private _warnedVirtualFilesUrl = false;
    private _warnedAutoResizeWorker = false; // autoResize asked for in worker mode, once per instance
    private _warnedGuestMarkup = new Set<string>(); // module-graph warnings about guest markup, once per text (_warnOnce)
    private _warnedStrict = new Set<string>(); // strict-mode config warnings, once each per instance
    private _warnedForeignDocument = false; // inserted into a document of another realm (CB7), once per instance
    private _warnedWrapperStyle = false;    // the host page's style-src refused the wrapper's style (R3-1), once per instance
    private _lastConfig: { copy: unknown; inputs: number } | null = null; // the copy of the last usable setConfig() argument (R3-7)
    private _pendingTermination: object | null = null; // a build's 'terminated' waiting for its task (R3-2), cleared by every teardown
    private _heightBeforeAuto: string | null = null; // the embedder's inline height before auto-sizing first wrote one (R3-8)
    private _exposedNames = new Set<string>(); // what expose() published, for the no-allow-scripts warning (R3-4)

    // Files are part of the environment: they live on the element, survive reset(), load(), setConfig()
    // and terminate(), and every environment build takes a snapshot (createIframe). See src/lib/files.ts.
    private _files = new FileStore();

    // One broker lives on the element for its whole life, so host-exposed methods persist across
    // frame recreation (the guest's broker is per-frame and resets with each new frame). Its send only
    // ever carries the host's own requests: it queues them until a port exists, then setupChannel
    // flushes them. Answers to the guest never use it — they go back on the port the request arrived on.
    // Results go back with their snapshot's ArrayBuffers transferred (review round 2, C-3: rpc.ts, sendResult).
    // A guest's request past its environment's per-second budget is answered BUSY (M-2: _admitGuestCall).
    private _broker = createBroker((frame) => this._postRpc(frame), {
        sizeOf: createSizeOf(),
        transferResults: true,
        admitInbound: (bytes) => this._admitGuestCall(bytes),
    });

    constructor() {
        super();
        const root = this.attachShadow({ mode: "open" });
        // A block by default (review round 1, R4-12): a custom element is inline, and an inline element has no height to
        // fill. Through a constructed stylesheet, which no style-src governs (a <style> in the shadow root is subject to
        // the host page's policy); the embedder's own CSS for the element still wins over :host.
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(':host { display: block }');
            root.adoptedStyleSheets = [sheet];
        } catch {
            // an engine without constructed stylesheets: the embedder's CSS decides, as before
        }
        // The fetch bridge (B5) and guest writes (C5) are library methods under reserved names: expose() can never
        // replace them. Each build registers both again, bound to that build's bridge and overlay
        // (_startFetchBridge, _startGuestWrites); until the first build, none: every request is refused.
        this._exposeFetch(null);
        this._exposeGuestWrites(null);
    }

    /** Where the sandbox is in its lifecycle; see SandboxState. Agrees with 'ready' / 'terminated' when they fire. */
    get state(): SandboxState {
        return this._state;
    }

    // The lifecycle callbacks call module-level functions (connected, disconnected, adopted below), never a method
    // looked up on the element (broad review 2026-10-14, CB7): Firefox gives an element adopted into another
    // document that document's HTMLElement prototype, so `this.initialize` and `this._teardown` were gone there, the
    // callbacks threw, and the guest kept running with nothing left that could end it.
    connectedCallback() {
        connected(this);
    }

    // Removing the element ends its environment: a frame outside the document cannot be used, and keeping
    // its port, timers and watchdog alive would only let pending calls hang. Pending calls reject with
    // TERMINATED. This is not a termination — no 'terminated' event — and re-inserting the element builds
    // a fresh environment through connectedCallback (which also makes moving the element a clean re-init).
    disconnectedCallback() {
        disconnected(this);
    }

    // Moving the element into another document (adoptNode, or appending it to an iframe's document) ends its
    // environment like a removal; connectedCallback then refuses to build there (CB7).
    adoptedCallback() {
        adopted(this);
    }

    /**
     * Tears the sandbox down now and fires 'terminated' with `{ reason }`. Pending calls reject with
     * TERMINATED, later calls are refused at once, and `state` stays 'terminated' until reset(), load()
     * or setConfig(). Calling it again while terminated does nothing, so 'terminated' fires once per termination.
     */
    terminate(reason: string = DEFAULT_TERMINATE_REASON): void {
        // a reason that says nothing (not a string, empty, only white space) is the default one (review round 2, L-7)
        this._terminate(typeof reason === 'string' && reason.trim() !== '' ? reason : DEFAULT_TERMINATE_REASON);
    }

    /**
     * Recreates the environment now, from any state (terminated included): a fresh frame with a fresh
     * opaque origin and the current config. Guest-exposed methods are gone, host-exposed ones persist,
     * and pending calls reject with TERMINATED. Wait for 'ready' before relying on the new frame.
     */
    reset(): void {
        this.initialize();
    }

    /**
     * Replaces the configuration and rebuilds the environment now (when the element is in the document).
     * Anything left out keeps its default (see DEFAULT_SANDBOX_CONFIG), not its previous value: `html`
     * included. Values that cannot be used are dropped with a warning before anything is applied.
     */
    setConfig(config: SandboxConfig) {
        // A config the element cannot use is a termination with a reason, never a throw that leaves the old
        // environment torn down and no new one built (follow-up audit 2026-10-14): initialize() refuses every
        // build while _configRefusal is set, as it does for an unknown mode (review A4), until a usable config
        // arrives. Nothing of a refused config is applied.
        //
        // One structured clone of the whole argument before anything reads it: every check, and every later build,
        // reads this copy, never the caller's objects. So an array the caller changes after setConfig() never changes
        // the policy a later reset() builds, and a getter or a Proxy cannot answer two reads differently (review A6).
        // What cannot be cloned (a Proxy, a function, a DOM node) throws here, and refuses the config.
        let copy: unknown;
        let unusable: unknown = null;
        try {
            copy = structuredClone(config);
        } catch (error) {
            unusable = error;
        }
        // The configuration the environment was built from, again, while that environment stands (review round 1,
        // R3-7): nothing to change, so nothing is rebuilt (an embedder that applies its config on every edit, as the
        // playground does, keeps its guest). Anything a build reads changed since (load(), the files) builds as usual.
        if (unusable === null && this._isCurrentConfig(copy)) return;
        this._buildInputs++;
        try {
            if (unusable !== null) throw unusable;
            this._applyConfig(copy);
            this._configRefusal = null;
            this._lastConfig = { copy, inputs: this._buildInputs };
        } catch (error) {
            this._configRefusal = `${CONFIG_REFUSED_REASON} (${errorName(error)})`;
            this._lastConfig = null;
        }
        this.initialize();
    }

    // Whether `copy` is the configuration the standing environment was built from, with nothing else changed since.
    private _isCurrentConfig(copy: unknown): boolean {
        const last = this._lastConfig;
        if (!last || last.inputs !== this._buildInputs || this._configRefusal !== null) return false;
        if (this._state !== 'ready' && this._state !== 'loading') return false;
        return sameData(copy, last.copy);
    }

    // Parses, sanitizes, checks and stores one setConfig() argument, already copied (setConfig). Throws for a config
    // that cannot be used; then nothing is stored (the fields are assigned last, after every check and warning).
    private _applyConfig(copy: unknown) {
        // ---- Parse and sanitize the copy
        if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw new TypeError('setConfig() takes an object');
        const input = copy as SandboxConfig;

        // Filter out any forbidden capabilities that might have been passed. Strict mode's view always has its own
        // flags (STRICT_VIEW_FLAGS), so listing one of them there asks for nothing more and is not dropped.
        const strict = (input.mode ?? DEFAULT_SANDBOX_CONFIG.mode) === 'strict';
        const sanitizedConfig: Partial<StoredConfig> & { origins?: unknown } = {
            ...input,
            capabilities: filterCapabilities(input.capabilities, strict ? STRICT_CAPABILITIES : SAFE_CAPABILITIES, 'capabilities') as SafeCapability[] | undefined,
            unsafeCapabilities: filterCapabilities(input.unsafeCapabilities, UNSAFE_CAPABILITIES, 'unsafeCapabilities'),
        };
        // The entry is a registered path or nothing; it is looked up in each build's snapshot.
        if (Object.hasOwn(input, 'entry') && typeof input.entry !== 'string') delete sanitizedConfig.entry;
        // Markup is a string or nothing (R1-3): anything else is dropped with a warning, never refuses the config.
        if (Object.hasOwn(input, 'html') && typeof input.html !== 'string') {
            delete sanitizedConfig.html;
            this._warnOnce(`[Sandbox] "html" must be a string; ${shown(input.html)} was dropped.`);
        }
        // The fetch bridge config is validated into a policy here and kept out of the merged config: a
        // config without it turns the bridge off.
        const fetchPolicy = toFetchPolicy(input.fetchBridge, (message) => this._warnFetchBridge(message), globalThis.location?.origin ?? '');
        delete sanitizedConfig.fetchBridge;
        // `callLimits` too: parsed into the call budget both ends take (M-2), kept out of the merged config.
        const callBudget = callBudgetOf(input.callLimits, (message) => this._warnCallLimits(message));
        delete sanitizedConfig.callLimits;
        // `origins` is kept out of the merged config too: it is parsed below, for the mode the merged config has.
        delete sanitizedConfig.origins;
        this._dropRemovedOptions(sanitizedConfig);

        const merged = deepMerge(DEFAULT_SANDBOX_CONFIG, sanitizedConfig as Partial<StoredConfig>);
        // `origins` is parsed into the policy's origins here, once (origins.ts): an entry that is not an origin is
        // dropped with a warning; a value that cannot be read refuses the config. Parsed for the mode the build will
        // have, the default included, so strict mode drops `scripts` whether the config names it or not.
        const origins = parseOrigins(input.origins, merged.mode, (message) => this._warnOrigins(message));
        // Only a literal true enables eval or auto-sizing: both values are interpolated into the guest bootstrap.
        merged.scriptUnsafe = merged.scriptUnsafe === true;
        merged.autoResize = merged.autoResize === true;
        // Guest writes too: the build reads only this normalised copy.
        merged.guestWrites = merged.guestWrites === true;
        if (typeof merged.entry !== 'string') delete merged.entry;
        // The view's switches: always a boolean in the stored config (VIEW_SWITCHES).
        for (const name of Object.keys(VIEW_SWITCHES) as ViewSwitch[]) merged[name] = this._viewSwitch(input, name, merged.mode);

        // Every check and warning reads the candidate, and only a config that passed them all is stored, last
        // (focused review 2026-10-14, F6: the warnings ran after the assignment, so a config one of them refused
        // was stored all the same).
        this._warnAboutUnknownMode(merged);
        this._warnAboutUnsafeCapabilities(merged);
        this._warnAboutScriptUnsafe(merged);
        this._warnAboutAutoResizeInWorker(merged);
        this._warnAboutStrictConfig(merged, input);
        this._config = merged;
        this._fetchPolicy = fetchPolicy;
        this._origins = origins;
        this._callBudget = callBudget;
    }

    /**
     * Adds or replaces files in this element's store (a string is stored as UTF-8, a Uint8Array is
     * copied; `{ content, type }` overrides the type from the extension). The guest sees them from the
     * next environment build on — reset(), load() or setConfig() — never in the frame already running.
     * The whole batch is validated first: a refusal throws an Error with `code` INVALID_PATH,
     * INVALID_FILE or FILES_QUOTA_EXCEEDED and changes nothing. Fires 'fileschanged' with `{ paths }`
     * when something changed.
     */
    registerFiles(files: Record<string, FileEntry>): void {
        this._dispatchFilesChanged(this._files.register(files));
    }

    /**
     * Removes the given paths from the store, or every file when called without paths. Unregistered
     * paths are ignored; an invalid one throws INVALID_PATH and removes nothing. Like registerFiles(),
     * this takes effect at the next environment build.
     */
    unregisterFiles(paths?: string[]): void {
        this._dispatchFilesChanged(this._files.unregister(paths));
    }

    /** The registered files, sorted by path. */
    listFiles(): FileInfo[] {
        return this._files.list();
    }

    /**
     * The guest's pending writes and removals (guestWrites), sorted by path: `{ path, change: 'write', type, size,
     * content }` (content a copy of the bytes) or `{ path, change: 'remove' }`. Empty when writes are off. They belong
     * to the current environment, survive its termination, and are discarded by the next build and on removal.
     */
    listGuestWrites(): GuestWrite[] {
        return this._guestWrites?.list() ?? [];
    }

    /**
     * Applies the guest's pending changes at `paths` (required: an array of paths; a path with no pending change is
     * skipped) to the store, atomically, as registerFiles() and unregisterFiles() would, and fires 'fileschanged'.
     * A write whose type is not inert (anything but images, fonts, audio, video, text/plain, application/json and
     * text/css: JavaScript, HTML, SVG, XML, WebAssembly, unknown types) is refused with FILES_NOT_ALLOWED unless
     * `options.code === true`. Refusals throw INVALID_PATH, FILES_NOT_ALLOWED or FILES_QUOTA_EXCEEDED and change
     * nothing. Committed paths leave the pending list; the guest sees them from the next build on.
     */
    commitGuestWrites(paths: string[], options?: { code?: boolean }): void {
        const { paths: checked, code } = parseCommitArguments(paths, options);
        if (!this._guestWrites) return;
        this._dispatchFilesChanged(this._guestWrites.commit(checked, code));
    }

    // Synchronous, once per call that changed something.
    private _dispatchFilesChanged(paths: string[]) {
        if (paths.length === 0) return;
        this._buildInputs++;
        this.dispatchEvent(new CustomEvent('fileschanged', { detail: { paths } }));
    }

    // One overlay per environment (C5), made with the build like the fetch bridge, and the reserved method bound to
    // it. The method is registered again here, not once: the broker looks a method up when a request ARRIVES
    // (handleRequest, rpc.ts), and only the current port's frames arrive (_onGuestMessage, B4), so a request is
    // always handled by the overlay of the environment that sent it, even if it runs after a listener rebuilt the
    // sandbox. Never the next environment's.
    // `built` is the copy of the store this build delivers (createIframe): the overlay answers the guest from it, so
    // nothing registered after the build shows through a write's answer or its quota (broad review 2026-10-14, CB4).
    private _startGuestWrites(built: FileStore) {
        this._guestWrites = this._config.guestWrites === true ? createGuestWrites({ store: this._files, built }) : null;
        this._exposeGuestWrites(this._guestWrites);
    }

    private _exposeGuestWrites(writes: GuestWrites | null) {
        this._broker.exposeReserved(WRITE_METHOD, (request: unknown) => this._handleGuestWrite(writes, request));
    }

    // The next build, or the element's removal, ends what the last environment wrote and did not commit.
    // Only own fields and module functions: the lifecycle path runs it on an element whose prototype may be gone (CB7).
    private _discardGuestWrites() {
        this._guestWrites?.close();
        this._guestWrites = null;
        this._broker.exposeReserved(WRITE_METHOD, refuseGuestWrite);
    }

    // The reserved sandbox:write method. Every refusal is a FileError with a library code (guest-writes.ts); with
    // writes off, FILES_NOT_ALLOWED: the guarantee, whatever the guest's own sandboxFiles does first. A recorded
    // change is announced last, through _notifyThenAct (B5): 'fileswritten' runs embedder listeners, and the guest is
    // told its change stands only if no listener reset or terminated the sandbox meanwhile (then the overlay that
    // held it is gone or closed, and the answer could only reach a closed port anyway).
    // In strict mode the change goes to the view as well (R4-4), and the guest is answered once the view has it.
    private _handleGuestWrite(writes: GuestWrites | null, request: unknown): Promise<GuestWriteAnswer> {
        if (!writes) return refuseGuestWrite();
        // What the list holds at the path before (the request is the guest's structured-cloned data, read once): a change is
        // announced only when the list changed (review round 4, L-4), so 'fileswritten' never names what listGuestWrites()
        // does not show. A removal of a path the host unregistered after the build changes the guest's view only.
        const requested = request !== null && typeof request === 'object' ? (request as { path?: unknown }).path : undefined;
        const before = typeof requested === 'string' ? writes.change(requested) : undefined;
        let answer: GuestWriteAnswer;
        try {
            answer = writes.handle(request);
        } catch (error) {
            return Promise.reject(error);
        }
        if (answer.change === 'none' || writes.change(answer.path) === before) return Promise.resolve(answer); // nothing to announce
        // What the view is told, taken now: a 'fileswritten' listener may commit the change and empty its place.
        const shown = this._viewPort ? viewWriteOf(answer.path, writes.change(answer.path)) : null;
        return new Promise((resolve, reject) => {
            let acted = false;
            this._notifyThenAct([() => this._dispatchFilesWritten(answer.path)], () => {
                acted = true;
                this._showInView(shown, () => resolve(answer), reject);
            });
            if (!acted) reject(new Error('[Sandbox] the sandbox was reset or terminated while this write was announced.'));
        });
    }

    // Strict mode (R4-4): one recorded guest change to the view, which mints a URL for a raster image from these bytes
    // (VIEW_WRITE_TYPES, its own check) and answers VIEW_WRITTEN; `shown` runs then. The view is the only reader of the
    // bytes: a copy, transferred. Without a view (cooperative and worker mode) `shown` runs at once. A teardown before the
    // view answered ends the wait (_teardown): the change stays recorded, and the guest's port is closed anyway.
    private _showInView(change: ViewWrite | null, shown: () => void, lost: (error: Error) => void) {
        const port = this._viewPort;
        if (!change || !port) {
            shown();
            return;
        }
        const id = ++this._viewWriteIds;
        this._viewWrites.set(id, { shown, lost });
        port.postMessage({ type: 'VIEW_WRITE', id, ...change }, change.bytes ? [change.bytes.buffer] : []);
    }

    // One guest change the host recorded: dispatched on the element and bubbling, like the other events a guest
    // causes. At most GUEST_WRITES_PER_SECOND per environment (guest-writes.ts).
    private _dispatchFilesWritten(path: string) {
        this.dispatchEvent(new CustomEvent('fileswritten', { detail: Object.freeze({ paths: Object.freeze([path]) }), bubbles: true }));
    }

    // Options that were removed, dropped from the config with one warning per instance each, so an old config keeps
    // working without them. virtualFilesUrl configured the removed Service-Worker hub (ADR-004). connectionsAllowed
    // was the raw policy, replaced by `origins` (ADR-007): ignored, never adapted, so it fails closed (no origin).
    private _dropRemovedOptions(config: object) {
        if (Object.hasOwn(config, 'connectionsAllowed')) {
            delete (config as Record<string, unknown>).connectionsAllowed;
            this._warnOrigins('[Sandbox] connectionsAllowed was removed; use origins. It was ignored: the guest policy admits only the exact origins listed in `origins` (see docs/API.md#origins).');
        }
        if (!Object.hasOwn(config, 'virtualFilesUrl')) return;
        delete (config as Record<string, unknown>).virtualFilesUrl;
        if (this._warnedVirtualFilesUrl) return;
        this._warnedVirtualFilesUrl = true;
        console.warn('[Sandbox] "virtualFilesUrl" is no longer supported and was ignored: register files with registerFiles() and read them in the guest through sandboxFiles (see docs/ADR-004).');
    }

    // What setConfig() dropped from `origins` (origins.ts), and the connectionsAllowed removal: the same config is set
    // again and again (the playground applies it on every edit), so each message is said once per element.
    private _warnOrigins(message: string) {
        if (this._warnedOrigins.has(message)) return;
        this._warnedOrigins.add(message);
        console.warn(message);
    }

    /**
     * Sets `html` (the guest document, or the initial view in strict mode), keeps the rest of the configuration
     * and rebuilds the environment now. Worker mode ignores the markup but still rebuilds.
     */
    load(html: string) {
        this._buildInputs++;
        this._config.html = html;
        this.initialize();
    }

    /**
     * Runs `code` in the guest's global scope as a function body (the guest document, or the worker in worker
     * and strict mode), compiled with the Function the bootstrap captured. Returns nothing, and nothing is reported
     * back; workerExecutionTimeout checks the event loop at its deadline. Needs scriptUnsafe and a string; ignored with a warning otherwise, and
     * while there is no environment (idle or terminated), like call(), which rejects then. Queued while loading;
     * a synchronous throw becomes a 'sandbox-log' error.
     */
    execute(code: string) {
        if (typeof code !== 'string') {
            console.warn("[Sandbox] execute() ignored: code must be a string.");
            return;
        }
        if (!this._config.scriptUnsafe) {
            console.warn("[Sandbox] execute() blocked: scriptUnsafe is false. Enable it in config to run arbitrary code.");
            return;
        }
        // One rule for work handed to the guest (backlog B8): it belongs to an environment, and while idle or
        // terminated there is none. execute() warns and does nothing; call() rejects at once with TERMINATED.
        // (While idle, execute() used to queue code that the build on insertion then dropped silently.)
        if (this._state === 'terminated' || this._state === 'idle') {
            console.warn(`[Sandbox] execute() ignored: the sandbox ${this._state === 'idle' ? 'is not in the document' : 'was terminated'}. Call it once the element is in the document and not terminated (reset(), setConfig() or load() start a new environment).`);
            return;
        }

        // Before `ready` it waits, even with a port (strict mode has one from the wrapper's load): _enterReady posts it.
        if (this._port && this._state === 'ready') {
            this._postExecute(this._port, code);
        } else {
            this._queue.push({ code });
        }
    }

    // One EXECUTE frame, with its budget armed first.
    private _postExecute(port: MessagePort, code: string) {
        this._armExecutionBudget();
        port.postMessage({ type: 'EXECUTE', code });
    }

    /**
     * Publishes a host method the guest can invoke with `bridge.call(name, ...)`.
     * Methods live on the element, so they survive frame recreation (load()/setConfig()).
     * Exposing a name again replaces its handler; names starting with "sandbox:" are reserved (refused with a
     * warning). The arguments are the guest's data: validate them before use.
     */
    expose(name: string, fn: (...args: any[]) => unknown): void {
        // A name that is not a string, or a handler that is not a function, is a mistake to say at once (review round
        // 1, R3-9): it used to be ignored, and the guest's call failed with UNKNOWN_METHOD far from the cause.
        if (typeof name !== 'string') throw new TypeError('[Sandbox] expose(): the name must be a string');
        // the broker's longest method name (rpc.ts, review round 3, C-1): a longer one could never be called
        if (name.length > 256) throw new TypeError(`[Sandbox] expose(): the name "${name.slice(0, 64)}…" is longer than 256 characters`);
        if (typeof fn !== 'function') throw new TypeError(`[Sandbox] expose(): the handler for "${name.slice(0, 64)}" must be a function`);
        if (name.startsWith(RESERVED_METHOD_PREFIX)) {
            console.warn(`[Sandbox] expose(): names starting with "${RESERVED_METHOD_PREFIX}" are reserved for the library; "${name}" was not exposed.`);
            return;
        }
        this._broker.expose(name, fn);
        this._exposedNames.add(name);
    }

    /**
     * Invokes a guest-exposed method and resolves with its result. Every rejection is an Error with a
     * `code` (RpcErrorCode, see rpc.ts); UNKNOWN_METHOD, HANDLER_ERROR and RESULT_NOT_TRANSFERABLE
     * are reported by the guest, and their message is the guest's text.
     * Works WITHOUT scriptUnsafe: it calls a pre-registered function on the guest, it never evals.
     * Times out after 30 s (TIMEOUT). Queued while loading; rejects with TERMINATED when the environment goes away,
     * and at once while there is none (idle or terminated).
     */
    call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        const refusal = this._noEnvironmentError();
        if (refusal) return Promise.reject(refusal);
        return this._issue(() => this._broker.call(method, ...args)) as Promise<T>;
    }

    /** Like call(), but with an explicit timeout in ms for this one call (0 disables the timeout). */
    callWithTimeout<T = unknown>(timeoutMs: number, method: string, ...args: unknown[]): Promise<T> {
        const refusal = this._noEnvironmentError();
        if (refusal) return Promise.reject(refusal);
        return this._issue(() => this._broker.callWithTimeout(timeoutMs, method, ...args)) as Promise<T>;
    }

    // One host call, made in the current environment (review round 3, L-2). The broker copies the arguments with
    // structuredClone before it sends them, and a getter among them runs then: one that called terminate(), remove() or
    // reset() ended the environment before the frame was sent, and _postRpc queued it for an environment that no longer
    // existed (after terminate() or remove(): never sent, never settled), or sent it to the next one. So the call carries
    // the environment it was made in, nested calls included, and _postRpc sends a frame only there: any other is refused
    // TERMINATED, at once (RpcSend in rpc.ts). Every call settles, whatever runs while its arguments are copied.
    private _issue(makeCall: () => Promise<unknown>): Promise<unknown> {
        const outer = this._issuedIn;
        this._issuedIn = this._generation;
        try {
            return this._queuedWhilePending(makeCall);
        } finally {
            this._issuedIn = outer;
        }
    }

    // The queue holds only calls still waiting for their answer (broad review 2026-10-14, CB3). A call made while
    // loading waits in _queue for the port; if it settles there first (TIMEOUT), its request leaves the queue with
    // it. Before, it stayed and was sent at the next flush: the method ran after its caller had been told the call
    // timed out, and a caller that retried ran it twice. The broker posts a call's one request synchronously from
    // call(), so the frame queued during `makeCall` is this call's.
    private _queuedWhilePending(makeCall: () => Promise<unknown>): Promise<unknown> {
        const queue = this._queue;
        const queued = queue.length;
        const promise = makeCall();
        // sent at once, or refused before sending (a teardown meanwhile replaced the queue: L-2, _issue)
        if (this._queue !== queue || queue.length === queued) return promise;
        const entry = queue[queue.length - 1];
        const drop = () => {
            const index = this._queue.indexOf(entry!);
            if (index >= 0) this._queue.splice(index, 1);
        };
        promise.then(drop, drop);
        return promise;
    }

    // The same rule as execute() (backlog B8): while idle or terminated there is no environment to call, so a call
    // is refused at once with TERMINATED. (While idle, a call used to wait for the element's insertion, whose
    // build then rejected it with TERMINATED anyway.)
    private _noEnvironmentError(): Error | null {
        if (this._state === 'terminated') return this._broker.terminationError(TERMINATED_CALL_MESSAGE);
        if (this._state === 'idle') return this._broker.terminationError(IDLE_CALL_MESSAGE);
        return null;
    }

    // Sends one of the host's own RPC requests over the port once the build is ready, or queues it until _enterReady flushes
    // (mirrors execute(); review round 5, L-1: strict mode has its port from the wrapper's load, before `ready`).
    // Only for the environment the call was made in, while it stands (L-2, _issue): otherwise nothing is sent, and the
    // text returned refuses the call TERMINATED.
    private _postRpc(frame: unknown): string | undefined {
        if (this._issuedIn !== this._generation || this._state === 'idle' || this._state === 'terminated') return RESET_CALL_MESSAGE;
        if (this._port && this._state === 'ready') {
            this._port.postMessage(frame);
            return;
        }
        this._queue.push({ frame });
    }

    // A mode the element does not know is refused, never read as the default (review A4): strict mode is a
    // security opt-in, so a misspelt 'Strict' must not quietly give the weaker cooperative mode. initialize() then
    // terminates every build with a reason until a config names a valid mode; this says why, once per value.
    private _warnAboutUnknownMode(config: StoredConfig) {
        const mode = config.mode;
        if (isSandboxMode(mode)) return;
        const message = `[Sandbox] mode ${this._describeMode(mode)} is not one of ${SANDBOX_MODES.join(', ')}${renamedModeNote(mode)}: the sandbox will not start until setConfig() names one of them.`;
        if (this._warnedStrict.has(message)) return;
        this._warnedStrict.add(message);
        console.warn(message);
    }

    private _describeMode(mode: unknown): string {
        return typeof mode === 'string' ? JSON.stringify(mode.slice(0, 32)) : `of type ${mode === null ? 'null' : typeof mode}`;
    }

    private _warnAboutUnsafeCapabilities(config: StoredConfig) {
        if (config.mode === 'strict') return; // dropped there instead, with one warning (_warnAboutStrictConfig)
        for (const capability of config.unsafeCapabilities || []) {
            if (this._warnedUnsafeCapabilities.has(capability)) continue;
            this._warnedUnsafeCapabilities.add(capability);
            console.warn(`[Sandbox] unsafe capability "${capability}" is enabled: it lets guest content act outside the sandbox.`);
        }
    }

    // The guard rail for scriptUnsafe (backlog S4). It is on in most presets and every e2e spec, so it is the
    // path of least resistance for a copy-paste consumer; one warning per instance says what it costs
    // without repeating on every reset(), load() or setConfig().
    private _warnAboutScriptUnsafe(config: StoredConfig) {
        if (config.scriptUnsafe !== true || this._warnedScriptUnsafe) return;
        this._warnedScriptUnsafe = true;
        console.warn("[Sandbox] scriptUnsafe is enabled: the guest policy allows 'unsafe-eval', so guest code can run strings as code (eval, new Function) and execute() runs code in the guest. It exists for testing; leave it off for untrusted content.");
    }

    // workerExecutionTimeout (focused review 2026-10-14, F2; ADR-003 amendment): what it bounds is "the guest's
    // event loop is free at the deadline". Each execute() arms a deadline `budget` ms after the host posts the code
    // (the only moment the host can see). At the deadline the host pings the guest through the bootstrap's own PING
    // handler, which guest code cannot reach (review B2), and only a free event loop can run it: no answer within
    // EXECUTION_TIMEOUT_GRACE_MS means the loop is still busy, and that ends the sandbox the way the watchdog does
    // (ADR-003: a guest over a budget is terminated; reset() is the embedder's choice).
    //
    // Before, the guest reported EXECUTED once the code returned, and that report stopped the timer. Neither part
    // was a bound: code that returned at once but left a loop scheduled (setTimeout(() => { for (;;) {} })) stopped
    // its own timer and then looped (A1), and guest code that replaced globalThis.Function had the bootstrap's
    // `new Function(code)` return a function of its choosing, so EXECUTED was posted before the embedder's code had
    // run at all (A2). Now nothing the guest says ends a budget, only an answer from a free loop at the deadline,
    // and the bootstrap compiles with the Function it captured before guest code ran (in-sandbox-script.ts).
    //
    // Several execute() calls each have their own deadline, and each deadline checks the one event loop: a loop
    // started by any code ends the sandbox at the first deadline it blocks. Code that ran to its end and left the
    // loop free stays, whatever it scheduled for later; a loop that starts after the last deadline is the
    // watchdog's to bound (watchdogTimeout checks the loop continuously). The worker lives inside the frame, so
    // tearing the frame down stops it. Cooperative mode has no such budget: the guest document can share the host's
    // thread, so no timer could fire meanwhile.
    private _armExecutionBudget() {
        if (this._config.mode !== 'worker' && this._config.mode !== 'strict') return;
        const budget = watchdogBudget(this._config.workerExecutionTimeout); // a finite number > 0, else off
        if (budget === 0) return;
        const timer = setLongTimeout(() => {
            this._executionTimers.delete(timer);
            this._probeExecution();
        }, budget); // any budget, 2^31 ms and past (L-2: long-timer.ts)
        this._executionTimers.add(timer);
    }

    // The check at a deadline: a one-off watchdog over EXECUTION_TIMEOUT_GRACE_MS (watchdog.ts: pings each tick until
    // an answer, expires after a whole grace of silent ticks, so a host stall is never counted against the guest).
    // Its pings carry negative numbers of their own, so a PONG names the probe it answers and never the watchdog's.
    private _probeExecution() {
        const port = this._port;
        if (!port) return;
        const pings: number[] = [];
        let probe: Watchdog | null = null;
        const end = () => {
            probe?.stop();
            for (const n of pings) this._executionProbes.delete(n);
        };
        probe = startWatchdog({
            timeoutMs: EXECUTION_TIMEOUT_GRACE_MS,
            ping: () => {
                const n = -(++this._probePings);
                pings.push(n);
                this._executionProbes.set(n, end);
                port.postMessage({ type: 'PING', n });
            },
            onExpire: () => {
                end();
                this._onExecutionTimeout();
            },
        });
    }

    // A PONG to a probe's ping: the event loop was free, the probe passes. False when it answers no probe.
    private _passExecutionProbe(n: unknown): boolean {
        const end = typeof n === 'number' ? this._executionProbes.get(n) : undefined;
        if (!end) return false;
        end();
        return true;
    }

    private _onExecutionTimeout() {
        this._notifyThenAct([() => this._dispatchHostLog('error', 'Execution Timeout')], () => this._terminate(EXECUTION_TIMEOUT_REASON));
    }

    /**
     * The one way the host dispatches an event and then acts on the environment (review B5). Dispatching runs
     * embedder listeners synchronously, and a listener may reset() or terminate() the sandbox; acting afterwards
     * on the environment that is gone would undo what the listener did (rebuild what it terminated, tear down
     * what it just built). So the action runs only if no teardown happened in between: every teardown counts up
     * _generation, and this is the only place that compares it. A path that dispatches and then acts goes through
     * here; none compares the count by hand (test/unit/channel-guarantees.test.ts enumerates them).
     *
     * Each notice dispatches ONE event, and the next one is dispatched only if no teardown happened during the one before
     * (review round 4, L-2): an entry failure announces a host line and then the guest's own line, and the guest line,
     * dispatched from the same callback after a listener of the host line had reset or removed the element, reached the
     * next environment's listeners, or an idle element's. The same test checks that each notice dispatches one event.
     */
    private _notifyThenAct(notices: readonly (() => void)[], act: () => void) {
        const generation = this._generation;
        for (const notice of notices) {
            notice();
            if (generation !== this._generation) return;
        }
        act();
    }

    // A frame of ours that the host page's policy refused, as it reported (R3-1; review round 2, C-5 and C-6): one host
    // line, then the termination with the reason that names the policy (unless a listener of that line acted first).
    private _refusedByHostPage(reason: string) {
        this._notifyThenAct([() => this._dispatchHostLog('error', `[Sandbox] ${reason}`)], () => this._terminate(reason));
    }

    // The guest's port, announced by the guest frame itself (CB1), becomes this environment's port. Null when this
    // build's guest runs no bootstrap (no allow-scripts): there is nothing to talk to,
    // and calls wait in the queue until they time out.
    private setupChannel(port: MessagePort | null) {
        if (this._port) { this._port.close(); this._port = null; }
        if (!port) return;
        this._port = port;
        // One reply channel per port: answers go back where their request came from, and the broker counts the
        // calls it runs per channel (review B7), so the count belongs to this environment.
        const reply = (frame: unknown, transfer?: Transferable[]) => port.postMessage(frame, transfer ?? []);
        // Setting onmessage starts the port: frames the guest posted before its announcement was accepted are
        // delivered now, after 'ready'. What waits in the queue is posted by _enterReady, the one flush point.
        port.onmessage = (e) => this._onGuestMessage(port, reply, e.data, null);
    }

    /**
     * The reversed handshake (broad review 2026-10-14, CB1; ADR-002 amendment). The guest frame's bootstrap (iframe
     * mode) or the frame's worker bootstrap (worker mode) makes the channel itself and posts one end to this window
     * as its first statement; the other end never leaves the bootstrap's closure. This listener, installed before the
     * frame is inserted, accepts exactly one such announcement per environment: a trusted message from the guest
     * frame's own window (identity: the wrapper's frames[0]) carrying exactly one port. Every later announcement from
     * that window, or one this build does not expect, or a malformed one, ends the environment: a guest that reloads
     * itself (location.reload(), a <meta refresh> without a URL) or rewrites its document so a bootstrap runs again
     * announces again, and a guest that forges one can only end its own environment (PD8). Messages from any other
     * window, and the guest's other messages, are not this listener's (they reach the embedder's own listeners).
     */
    private _listenForAnnouncement(iframe: HTMLIFrameElement) {
        const host = window;
        let accepted = false;
        const onMessage = (event: MessageEvent) => {
            const guestWindow = guestWindowOf(iframe);
            if (!guestWindow || event.source !== guestWindow) return;
            const data = event.data;
            if (!data || typeof data !== 'object' || data.type !== ANNOUNCEMENT_TYPE) return;
            event.stopImmediatePropagation(); // the port is the element's: no other listener on this window sees it
            // Worker mode's frame announces a worker that could not start as its one announcement, with no port (review
            // round 2, C-5, worker-bootstrap.ts): the build ends with the reason strict mode gives for the same refusal,
            // and is never 'ready'. Only in worker mode, whose frame runs no guest code: elsewhere it is a forgery.
            const refusal = this._config.mode === 'worker' && event.ports.length === 0 ? WORKER_FRAME_REFUSALS[data.refused as string] : undefined;
            if (accepted || !this._expectAnnouncement || !event.isTrusted || (event.ports.length !== 1 && refusal === undefined)) {
                this._terminate(SECOND_ANNOUNCEMENT_REASON);
                return;
            }
            accepted = true;
            if (refusal !== undefined) {
                this._refusedByHostPage(refusal);
                return;
            }
            // The check-in (S46): the environment is ready now, whether or not the wrapper has loaded (its load waits
            // for the guest's subresources). The guest frame it came from is the one the wrapper's load must still hold.
            this._guestWindow = guestWindow;
            this._finishBuild(event.ports[0]!);
        };
        host.addEventListener('message', onMessage, true);
        this._stopListening = () => host.removeEventListener('message', onMessage, true);
    }

    // One frame from the guest's port: the guest document's bootstrap's, or (worker and strict mode) the worker's.
    // `source` labels its violation reports in strict mode ('logic'); null elsewhere.
    // Only the current environment's port is heard (review B4): teardown closes a port, and a closed port
    // delivers nothing more, but this does not rely on it — a frame from any other port changes nothing.
    private _onGuestMessage(port: MessagePort, reply: (frame: unknown) => void, data: any, source: 'logic' | null) {
        if (!port || port !== this._port) return;
        if (data?.type === 'PONG') {
            // an execution probe's (negative numbers), else the watchdog's: validated there; only this generation's are live
            if (!this._passExecutionProbe(data.n)) this._watchdog?.handlePong(data.n);
            return;
        }
        if (data?.type === 'LOG') {
            this._dispatchGuestLog(data);
            return;
        }
        if (data?.type === 'VIOLATION') {
            this._dispatchViolation(data, source);
            return;
        }
        if (data?.type === 'RESIZE') {
            // null unless this environment asked for auto-sizing: then a RESIZE frame (forged or not) does
            // nothing. In strict mode only the view port's reports count, never the worker's.
            if (source === null) this._resizer?.report(data);
            return;
        }
        // Everything else on this port is RPC (or not ours); the broker validates every frame.
        // Answers go back on THIS port — the one the request arrived on — never on whatever port is
        // current. Teardown closes it, and a message posted on a closed port is silently discarded
        // (HTML spec), so an answer that settles after a re-init goes nowhere: not into the next
        // frame's port, and not into its queue. That is what keeps frame generations isolated —
        // a response only ever reaches the generation that asked for it. (An answer that cannot be
        // cloned may still throw while being posted; sendResult turns that into an error frame,
        // which is discarded the same way.)
        this._broker.handleMessage(data, reply);
    }

    /**
     * Strict mode (ADR-005): two channels to the view, once per frame like setupChannel. The logic port goes
     * on to the worker, which the view spawns; the view port stays with the view, which runs no guest code,
     * so what arrives on it is the library's own: the view's violations, its height, an entry failure, and
     * its liveness answers. The render port between view and worker is the view's to create.
     */
    private _setupStrictChannels(target: Window) {
        if (this._port) { this._port.close(); this._port = null; }
        if (this._viewPort) { this._viewPort.close(); this._viewPort = null; }
        const logic = new MessageChannel();
        const view = new MessageChannel();
        const port = logic.port1;
        const viewPort = view.port1;
        this._port = port;
        this._viewPort = viewPort;
        const reply = (frame: unknown, transfer?: Transferable[]) => port.postMessage(frame, transfer ?? []);
        port.onmessage = (e) => this._onGuestMessage(port, reply, e.data, 'logic');
        viewPort.onmessage = (e) => this._onViewMessage(viewPort, e.data);

        // The ports go to the view now, at the wrapper's load; what waits in the queue does not (review round 5, L-1): it is
        // posted when the build becomes ready, at the view's check-in (_enterReady). Flushed here, a call made while loading
        // that timed out between the load and the check-in had already left, and ran in the guest after its caller had been
        // told TIMEOUT, though docs/API.md says it never runs.
        const init = this._strictInit;
        this._strictInit = null;
        target.postMessage({ type: 'INIT_VIEW', ...init }, '*', [logic.port2, view.port2]);
    }

    private _onViewMessage(viewPort: MessagePort, data: any) {
        if (!viewPort || viewPort !== this._viewPort) return; // only the current environment's view (review B4)
        if (data?.type === 'VIEW_READY') {
            // The view's check-in, the first frame on the port only its bootstrap holds (R3-1): the strict build is ready.
            if (this._state !== 'loading') return;
            this._checkViewSize(data.height);
            if (data.stillStyleRefused === true) this._warnStillStyleRefused();
            this._enterReady();
            return;
        }
        if (data?.type === 'TRUSTED_TYPES_REFUSED') {
            // The view could not create its Trusted Types policy (review round 2, C-6): the host page's trusted-types
            // directive does not name it, though the host page itself never needed it (its own default policy took the
            // element's strings). The view checked before its check-in, so the build was never ready.
            this._refusedByHostPage(TRUSTED_TYPES_REASON);
            return;
        }
        if (data?.type === 'WORKER_REFUSED') {
            // The view could not load the worker at all (no script of the guest's ran): the host page's policy (R3-1).
            this._refusedByHostPage(WORKER_REFUSED_REASON);
            return;
        }
        if (data?.type === 'VIEW_PONG') {
            this._viewWatchdog?.handlePong(data.n);
            return;
        }
        if (data?.type === 'VIEW_WRITTEN') {
            // the view holds a guest write (R4-4): the guest may now be told its write stands
            const pending = typeof data.id === 'number' ? this._viewWrites.get(data.id) : undefined;
            if (!pending) return;
            this._viewWrites.delete(data.id);
            pending.shown();
            return;
        }
        if (data?.type === 'VIOLATION') {
            this._dispatchViolation(data, 'view');
            return;
        }
        if (data?.type === 'RESIZE') {
            this._resizer?.report(data);
            return;
        }
        if (data?.type === 'GUEST_UNCAUGHT') {
            // a later uncaught error of the worker's that only the view could still describe (in-sandbox-view.ts,
            // review C1): a guest line like the worker's own 'Uncaught …' lines, rate-limited the same way. The view cut
            // it and rate-limited it before posting (review round 3, C-4); the line is cut again here (viewErrorLine).
            this._dispatchGuestLog({ level: 'error', args: [viewErrorLine(data.message)] });
            return;
        }
        if (data?.type === 'GUEST_TEXT_DROPPED') {
            // The view dropped a guest error text past its per-second window (review round 4, M-5): said once per
            // environment, as the console relay says its own drops, in a line of the relay's (not counted in the window).
            if (this._warnedViewTextDropped) return;
            this._warnedViewTextDropped = true;
            this._dispatchLog({ level: 'warn', args: [VIEW_TEXT_DROPPED_LINE] }, 'guest');
            return;
        }
        if (data?.type === 'GUEST_ERROR') {
            // The entry's own error text is the guest's (it wrote the code, or threw the value): a 'guest' line,
            // clamped and rate-limited like every guest line, never part of the host line or the reason (F3).
            const line = viewErrorLine(data.message);
            this._notifyThenAct([
                () => this._dispatchHostLog('error', `[Sandbox] ${ENTRY_FAILED_REASON}`),
                () => this._dispatchGuestLog({ level: 'error', args: [line] }),
            ], () => this._terminate(ENTRY_FAILED_REASON));
        }
    }

    // The view's height against the frame's (R3-1): a view 150 px high in a taller frame means the host page's style-src
    // refused the wrapper's style (frame-documents.ts, WRAPPER_STYLE), which nothing on this side can see. Once per element.
    private _checkViewSize(height: unknown) {
        const frame = this._iframe?.clientHeight ?? 0;
        if (this._warnedWrapperStyle || typeof height !== 'number' || height > 150 || frame <= height + 1) return;
        this._warnedWrapperStyle = true;
        console.warn(`[Sandbox] the sandbox's view is ${height} px high in a frame of ${frame} px: the host page's style-src refuses the wrapper's style. Allow 'unsafe-inline' or '${scriptHashSource(WRAPPER_STYLE)}' in style-src (see docs/API.md#host-page-policy).`);
    }

    // allowAnimations: false, and the host page's style-src refused the view's still stylesheet (in-sandbox-view.ts,
    // VIEW_STILL_STYLE), which a srcdoc document inherits: the view checked, and drops the guest's stylesheets instead, so
    // no guest animation runs either way. Said once per element, with the hash to allow.
    private _warnStillStyleRefused() {
        this._warnStrictOnce(`[Sandbox] allowAnimations is false, and the host page's style-src refuses the view's stylesheet that stops animations, so the view shows no guest stylesheet (<style>, <link rel="stylesheet">). Allow 'unsafe-inline' or '${scriptHashSource(VIEW_STILL_STYLE)}' in style-src (see docs/API.md#host-page-policy).`);
    }

    // Flushes what was queued before the build was ready onto its port, in the order it was issued (L-3): execute() code
    // (checked by execute() when queued) and the host's own RPC requests — the queue never holds answers (those go back
    // on the port their request arrived on). Called by _enterReady only (review round 5, L-1). Requests are cloned when
    // the call is made (see callWithTimeout in rpc.ts), so a post failure is not expected here; the per-frame catch is a
    // backstop so that one bad frame could never drop the frames behind it or stop 'ready' from firing.
    private _flushQueues(port: MessagePort) {
        const queued = this._queue;
        this._queue = [];
        let skipped = 0;
        for (const item of queued) {
            try {
                if ('code' in item) this._postExecute(port, item.code);
                else port.postMessage(item.frame);
            } catch {
                skipped++;
            }
        }
        if (skipped > 0) console.warn(`[Sandbox] skipped ${skipped} queued frame(s) that could not be posted (not transferable).`);
    }

    // Log lines are dispatched on the element and bubble, so one event serves both kinds of listener:
    // one on the element hears only its own sandbox, and one on window (the playground, the e2e harness)
    // hears every sandbox and tells them apart by event.target. Not composed: the element sits in the
    // embedding page's DOM, and an event of ours has no business crossing a consumer's shadow boundary.
    // The name stays namespaced because it bubbles: a generic 'log' would collide with other code on window.
    // Every detail is normalised and labelled with where it came from (sandbox-log.ts, review B3), here, from the
    // raw line and its source: no caller can hand this a detail of its own making.
    private _dispatchLog(line: unknown, source: 'guest' | 'host') {
        this.dispatchEvent(new CustomEvent('sandbox-log', { detail: toLogDetail(line, source, () => this._warnLogBytes()), bubbles: true }));
    }

    // A line past LOG_MAX_BYTES arrived (the guest's relay never sends one): its arguments past the budget were dropped.
    private _warnLogBytes() {
        if (this._warnedLogBytes) return;
        this._warnedLogBytes = true;
        console.warn(`[Sandbox] a guest log line was larger than ${LOG_MAX_BYTES} bytes; its arguments past that were dropped.`);
    }

    // A LOG frame from the guest's port: normalised, labelled 'guest', and at most LOG_EVENTS_PER_SECOND per
    // environment, so a guest cannot make the host run embedder listeners without bound (one warning).
    private _dispatchGuestLog(frame: unknown) {
        // the relay's own lines, up to LOG_OWN_LINES per environment, outside the guest's window (M-1, M-2)
        if ((frame as { own?: unknown } | null)?.own === true && this._ownLines < LOG_OWN_LINES) {
            this._ownLines++;
            this._dispatchLog(frame, 'guest');
            return;
        }
        if (!this._logLimiter.admit()) {
            if (this._warnedLogLimit) return;
            this._warnedLogLimit = true;
            // Said where the lines are read, once per environment (review round 3, L-4): the guest's relay keeps the same
            // window, but lines delivered late (the host was busy) arrive bunched, past this window though the relay sent
            // them within its own, and only a console warning said they were gone.
            const notice = `[Sandbox] the guest logged more than ${LOG_EVENTS_PER_SECOND} lines in one second; lines past that rate are not dispatched as 'sandbox-log' events.`;
            console.warn(notice);
            this._dispatchHostLog('warn', notice);
            return;
        }
        this._dispatchLog(frame, 'guest');
    }

    // One request from the guest against this environment's per-second budget (M-2), before its method is looked up (the
    // broker asks, rpc.ts): null when it fits, and is counted against both windows; else why it is refused BUSY, and
    // nothing is counted. The guest's broker refuses a call past the same budget before sending it, so this refuses only
    // what did not come through that check, or arrived bunched (delivered late while the host page was busy).
    private _admitGuestCall(bytes: number): string | null {
        const now = performance.now();
        if (!this._guestCalls.fits(now) || !this._guestCallBytes.fits(now, bytes)) return callBudgetText(this._callBudget);
        this._guestCalls.admit(now);
        this._guestCallBytes.admit(now, bytes);
        return null;
    }

    // A line the element writes itself: labelled 'host', never rate-limited.
    private _dispatchHostLog(level: SandboxLogLevel, text: string) {
        this._dispatchLog({ level, args: [text] }, 'host');
    }

    // A CSP violation reported by the guest (backlog S5): dispatched on the element and bubbling, like
    // sandbox-log. The detail is guest-supplied, so it is validated and clamped (violation.ts) and the
    // number of events per environment is capped: past VIOLATION_EVENT_LIMIT reports are dropped, with one
    // warning, so a guest cannot make the host run embedder listeners without bound.
    // In strict mode each port has its own count, labelled by where the report arrived (A6): the view's
    // reports are the library's own, so a worker flooding the logic port can never use up the view's.
    // The view port counts per directive (review C4, follow-up audit 2026-10-14): its reports include refusals of
    // the guest's own rendered markup, so with one count a guest that rendered 100 refused images used it up,
    // and a later refusal of another kind (a handler attribute: script-src-attr) went unreported. The directive
    // of a view report is the browser's own, so per-directive counts are sound there; the buckets are the known
    // directive names plus one for any other name, which bounds the view's events at
    // (VIOLATION_DIRECTIVES + 1) × VIOLATION_EVENT_LIMIT per environment. The logic port, and cooperative and worker mode,
    // keep one count: guest code writes the directive name there, so per-name counts would be guest-chosen.
    private _dispatchViolation(frame: unknown, source: 'view' | 'logic' | null = null) {
        const detail = toViolationDetail(frame, source ?? undefined);
        if (!detail) return;
        const key = source === 'view' ? `view:${VIOLATION_DIRECTIVES.includes(detail.directive) ? detail.directive : '*'}` : (source ?? '');
        const count = this._violationCounts.get(key) ?? 0;
        if (count > VIOLATION_EVENT_LIMIT) return;
        this._violationCounts.set(key, count + 1);
        if (count + 1 > VIOLATION_EVENT_LIMIT) {
            const where = source === 'view' ? ` for ${detail.directive} on its view port` : source ? ` on its ${source} port` : '';
            console.warn(`[Sandbox] the guest reported more than ${VIOLATION_EVENT_LIMIT} CSP violations${where}; further ones are not dispatched until the next reset(), load() or setConfig().`);
            return;
        }
        this.dispatchEvent(new CustomEvent('violation', { detail, bubbles: true }));
    }

    // Arms the liveness watchdog for the port just handed over, if the config asks for one (see
    // src/lib/watchdog.ts). Pings go on THIS port: teardown closes it and stops the watchdog together.
    private _startWatchdog(port: MessagePort) {
        const budget = watchdogBudget(this._config.watchdogTimeout);
        if (budget === 0) return;
        this._watchdog = startWatchdog({
            timeoutMs: budget,
            ping: (n) => port.postMessage({ type: 'PING', n }),
            onExpire: () => this._terminate(WATCHDOG_REASON),
        });
    }

    // Auto-sizing applies to cooperative and strict mode: a worker has no document to measure, a strict view does.
    private _autoResizeEnabled(): boolean {
        return this._config.autoResize === true && this._config.mode !== 'worker';
    }

    private _warnAboutAutoResizeInWorker(config: StoredConfig) {
        if (config.autoResize !== true || config.mode !== 'worker' || this._warnedAutoResizeWorker) return;
        this._warnedAutoResizeWorker = true;
        console.warn('[Sandbox] autoResize has no effect in worker mode: a worker has no document to measure.');
    }

    // One resizer per environment (backlog B6, src/lib/auto-resize.ts), started with the port it listens on
    // and stopped by _teardown. It is the only path from a RESIZE frame to the element's height.
    private _startAutoResize() {
        if (!this._autoResizeEnabled()) return;
        this._resizer = startAutoResize((height) => {
            const value = `${height}px`;
            // the embedder's own inline height, kept to give back (R3-8), unless it is one auto-sizing wrote
            if (this._autoHeight === null || this.style.height !== this._autoHeight) this._heightBeforeAuto = this.style.height;
            this.style.height = value;
            this._autoHeight = value;
        });
    }

    // Gives the height back to the embedder when auto-sizing is off for the environment being built: the inline height
    // it had before auto-sizing first wrote one (review round 1, R3-8: it used to be removed), and only if the inline
    // height is still the one auto-sizing wrote.
    private _releaseAutoHeight() {
        if (this._autoHeight === null) return;
        if (this.style.height === this._autoHeight) this.style.height = this._heightBeforeAuto ?? '';
        this._autoHeight = null;
        this._heightBeforeAuto = null;
    }

    // One fetch bridge per environment (B5), built with the environment and aborted by _teardown. The reserved
    // method is registered again with it, closed over THIS build's bridge (or null when off), as sandbox:write is
    // over its overlay: the broker looks a method up when a request arrives and runs it a microtask later, and a
    // request must be served by the bridge of the environment it arrived in. Before, the method read
    // this._fetchBridge when it ran, so a request that arrived just before a rebuild was served by the next
    // environment's bridge (focused review 2026-10-14, hardening). Now it reaches its own bridge, which teardown
    // closed, and is refused there.
    private _startFetchBridge() {
        this._fetchBridge = this._fetchPolicy ? createFetchBridge({
            policy: this._fetchPolicy,
            hostOrigin: globalThis.location?.origin ?? '',
            onRecord: (record) => this._dispatchFetch(record),
        }) : null;
        this._exposeFetch(this._fetchBridge);
    }

    private _exposeFetch(bridge: FetchBridge | null) {
        this._broker.exposeReserved(FETCH_METHOD, (request: unknown) => this._handleFetch(bridge, request));
    }

    // The reserved sandbox:fetch method of one environment. Every refusal is minted in fetch-bridge.ts with a library code.
    private _handleFetch(bridge: FetchBridge | null, request: unknown): Promise<unknown> {
        if (!bridge) return Promise.reject(fetchRefusal('FETCH_NOT_ALLOWED', 'the fetch bridge is off (fetchBridge is not configured)'));
        return bridge.handle(request);
    }

    // Every request through the bridge, once, when it settled: dispatched on the element and bubbling, like
    // 'violation'. The record is built by the host from validated fields (fetch-bridge.ts).
    private _dispatchFetch(record: FetchRecord) {
        this.dispatchEvent(new CustomEvent('fetch', { detail: record, bubbles: true }));
    }

    // What setConfig() did not take of `callLimits`: once per element and message, as the same config is set again and again.
    private _warnCallLimits(message: string) {
        if (this._warnedCallLimits.has(message)) return;
        this._warnedCallLimits.add(message);
        console.warn(message);
    }

    private _warnFetchBridge(message: string) {
        if (this._warnedFetchBridge.has(message)) return;
        this._warnedFetchBridge.add(message);
        console.warn(message);
    }

    // The one place `state` changes. The 'ready' and 'terminated' events are dispatched here, after the
    // state is set, so a listener always reads the state its event announces; a build's 'terminated' in a task of its
    // own (`dispatch: 'task'`, _terminateBuild).
    private _enterState(next: SandboxState, reason?: string, dispatch: 'now' | 'task' | 'none' = 'now') {
        this._state = next;
        if (next === 'ready') this.dispatchEvent(new CustomEvent('ready'));
        if (next !== 'terminated' || dispatch === 'none') return;
        if (dispatch === 'now') {
            this._dispatchTerminated(reason ?? '');
            return;
        }
        const token = {};
        this._pendingTermination = token;
        setTimeout(() => this._dispatchBuildTermination(reason ?? '', token), 0);
    }

    private _teardown() {
        this._generation++;
        this._pendingTermination = null; // a build's 'terminated' still to come is no longer the sandbox's state (R3-2)
        this._guestWrites?.close(); // its writes stay listable and committable until the next build (initialize)
        this._logLimiter = createLogLimiter(); // the log rate limit is per environment
        this._warnedLogLimit = false;
        this._guestCalls = createRateLimiter(this._callBudget.calls); // and so is the call budget (M-2)
        this._guestCallBytes = createRateLimiter(this._callBudget.bytes);
        this._ownLines = 0;
        this._warnedLogBytes = false;
        this._warnedViewTextDropped = false;
        this._queue = []; // what was queued for the old environment
        this._violationCounts.clear(); // the violation cap is per environment
        this._strictInit = null;
        // Reject any in-flight calls so their promises never hang once this environment goes away.
        // They reject with code TERMINATED, minted by the broker (see rpc.ts).
        this._broker.rejectAllPending(RESET_CALL_MESSAGE);
        if (this._stopListening) { this._stopListening(); this._stopListening = null; }
        if (this._loadDeadline) { this._loadDeadline.stop(); this._loadDeadline = null; }
        this._expectAnnouncement = false;
        this._guestWindow = null;
        if (this._iframe) { this._iframe.onload = null; this._iframe.remove(); this._iframe = null; }
        if (this._port) { this._port.close(); this._port = null; }
        if (this._viewPort) { this._viewPort.close(); this._viewPort = null; }
        const unshown = [...this._viewWrites.values()];
        this._viewWrites.clear(); // the guest writes the view never confirmed: their guest is gone with its port
        for (const { lost } of unshown) lost(new Error('[Sandbox] the sandbox was reset or terminated before the view showed this write.'));
        for (const timer of this._executionTimers) timer.cancel();
        this._executionTimers.clear();
        for (const end of new Set(this._executionProbes.values())) end(); // stops every probe; empties the map
        if (this._watchdog) { this._watchdog.stop(); this._watchdog = null; }
        if (this._viewWatchdog) { this._viewWatchdog.stop(); this._viewWatchdog = null; }
        if (this._resizer) { this._resizer.stop(); this._resizer = null; } // the height it wrote stays until the next report
        if (this._fetchBridge) { this._fetchBridge.abortAll(); this._fetchBridge = null; } // upstream requests end with the environment
    }

    // Every termination comes through here: terminate(), the frame-integrity checks in _onFrameLoad and
    // the watchdog. Already terminated means nothing to do, which is what makes 'terminated' fire once.
    private _terminate(reason: string) {
        if (this._state === 'terminated') return;
        console.warn(`[Sandbox] terminated: ${reason}`);
        this._teardown();
        this._enterState('terminated', reason);
    }

    // Builds a fresh environment from the current config: the one place a build starts (connectedCallback,
    // reset(), load(), setConfig()). Outside the document there is nothing to build into (a detached iframe
    // never loads), so the element stays idle and connectedCallback builds it.
    //
    // Every build failure is a termination (follow-up audit 2026-10-14). A build that threw used to leave the
    // old environment torn down, state 'loading', no frame and no 'terminated' event, and the throw escaped to
    // whoever called setConfig() or reset(): a configured string where a directive took a list
    // ("img-src": "x; script-src *") made the policy generator throw there. Now a refusal known up front (a config that
    // could not be used, an unknown mode) and anything the build throws end the same way: state 'terminated',
    // one 'terminated' event with the reason, nothing half-built (_teardown).
    private initialize() {
        // Every build runs, from a 'terminated' listener too: CB5's rule is in _terminateBuild (the answer it gives is
        // not dispatched again), never a build skipped here (review round 3, L-1).
        this._buildWithin = this._terminationDispatched;
        this._teardown();
        this._discardGuestWrites(); // every build starts without the last environment's uncommitted writes
        // Where the element may build is one rule (review round 2, L-1: buildsHere, below), asked by every build, however
        // it starts: in another window's document, reset(), load() and setConfig() built there before (the guest ran,
        // and announced itself to a window the element does not listen to); now they stop the environment, as
        // insertion there does, and the element stays idle.
        if (!buildsHere(this)) {
            this._enterState('idle');
            return;
        }
        // 'loading' first: every build attempt that fails is one termination with its own reason, also when the
        // sandbox was already terminated (reset() of a refused config says again why it cannot start).
        this._enterState('loading');
        const refusal = this._buildRefusal();
        if (refusal !== null) {
            this._terminateBuild(refusal);
            return;
        }
        try {
            this.createIframe();
        } catch (error) {
            this._terminateBuild(error instanceof TrustedTypesRefusal ? TRUSTED_TYPES_REASON : `${BUILD_FAILED_REASON} (${errorName(error)})`);
            return;
        }
        if (this._state === 'loading') this._startLoadDeadline();
    }

    // A termination of the build initialize() is making. The state is 'terminated' at once; the 'terminated' event comes
    // in a task of its own, like 'ready' (review round 1, R3-2): a listener added right after setConfig(), reset() or
    // load() hears it, where it used to be dispatched inside the call. Not at all if the environment changed meanwhile
    // (another build, the element's removal): that answer is no longer the sandbox's state. While it is dispatched, a
    // listener that builds again gets the same answer, which is not dispatched again (CB5), in one rule: a build started
    // while a build termination is dispatched, and refused or failed with that same reason, ends 'terminated' and
    // dispatches nothing. Without it a 'terminated' listener that built again (reset(), load()) from the same inputs got
    // the same refusal, dispatched it again, and recursed until the stack ran out (broad review 2026-10-14: about 590
    // dispatches, then a RangeError); with it, every such build ends at once, so no listener can loop.
    // The rule is on the answer, so it covers alike a refusal known before building (an unknown mode, an unregistered
    // entry), and a reason initialize() only learns by building (the host page's Trusted Types policy, a build that
    // threw: review round 2, L-4). It used to be a check that skipped the build when its inputs had not changed, which
    // also skipped the state the build stands for (review round 3, L-1): a listener that moved the element (appendChild
    // elsewhere: disconnected, so 'idle', then connected) left it connected and 'idle', with no frame. Now that build runs,
    // and ends 'terminated' with the reason being dispatched. A listener that changes what decides the answer (a usable
    // config, the files for a build that failed) builds normally.
    private _terminateBuild(reason: string) {
        if (this._state === 'terminated') return;
        const repeated = this._buildWithin === reason; // the answer being dispatched now: said once, already
        if (!repeated) console.warn(`[Sandbox] terminated: ${reason}`);
        this._teardown();
        this._enterState('terminated', reason, repeated ? 'none' : 'task');
    }

    // The deferred 'terminated' of a build (above), dispatched only if nothing tore the environment down since: every
    // teardown clears _pendingTermination, so a token that is no longer the pending one is a stale answer.
    private _dispatchBuildTermination(reason: string, token: object) {
        if (this._pendingTermination !== token || this._state !== 'terminated') return;
        this._pendingTermination = null;
        this._dispatchTerminated(reason);
    }

    // The one place 'terminated' is dispatched (review round 4, L-3): CB5's rule holds for every termination, not only a
    // build's. A listener that rebuilt after terminate(reason), and whose build was refused with that very reason, used to
    // get a second 'terminated' with it (and, with a listener that rebuilt again, one per task, without end): the marker was
    // set only around a build's deferred dispatch.
    private _dispatchTerminated(reason: string) {
        const outer = this._terminationDispatched;
        this._terminationDispatched = reason;
        try {
            this.dispatchEvent(new CustomEvent('terminated', { detail: { reason } }));
        } finally {
            this._terminationDispatched = outer;
        }
    }

    // `loading` is bounded (CB3): a build that has not completed within LOAD_TIMEOUT_MS of host ticks ends with a
    // reason. Completed means the guest checked in (S46; strict mode: the view's VIEW_READY), or, without a bootstrap,
    // the frame loaded.
    // A watchdog that nothing answers: it expires after the whole budget, never counting a host stall.
    private _startLoadDeadline() {
        this._loadDeadline = startWatchdog({
            timeoutMs: LOAD_TIMEOUT_MS,
            ping: () => {},
            onExpire: () => this._terminate(this._loadTimeoutReason()),
        });
    }

    // Why a build is still `loading` at its deadline. Once the wrapper has loaded, the frame that runs the library's
    // startup script (the strict view, or the guest's bootstrap) has loaded too, and that script runs before anything
    // else in it: had it run, it would have checked in long before. So it did not run, and what stops an inline script
    // of ours there is the host page's policy, which srcdoc documents inherit (R3-1). Before the wrapper's load, the
    // frame itself did not finish loading.
    private _loadTimeoutReason(): string {
        const scripted = this._config.mode === 'strict' || this._expectAnnouncement;
        return this._frameLoaded && scripted ? STARTUP_BLOCKED_REASON : LOAD_TIMEOUT_REASON;
    }

    // Why no environment may be built from the current config, or null. Fail closed on a config that could not be
    // used, and on a mode the element does not know (review A4): no environment at all, rather than one of a mode
    // the embedder did not ask for.
    // The strict entry that names no registered JavaScript file is one of them (review round 2, L-4): decided here, so
    // the re-entrancy rule of initialize() (CB5) knows it before building.
    private _buildRefusal(): string | null {
        if (this._configRefusal !== null) return this._configRefusal;
        if (!isSandboxMode(this._config.mode)) return `unknown mode ${this._describeMode(this._config.mode)}${renamedModeNote(this._config.mode)}`;
        const entry = this._config.entry;
        if (this._config.mode === 'strict' && typeof entry === 'string' && entry !== '') {
            const file = this._files.list().find(candidate => candidate.path === entry);
            if (!file || !isJavaScriptType(file.type)) return `the guest entry "${entry.slice(0, 256)}" is not a registered JavaScript file`;
        }
        return null;
    }

    // `postToFrame` (worker mode): the expression that names the worker's platform postMessage, which the globals
    // allowlist handed over (worker-globals.ts, review round 4, M-1); the bootstrap's one WORKER_STARTED uses it.
    private _getSandboxCommsScript(mode: 'cooperative' | 'worker', files: FileSnapshotEntry[], plan: GuestMarkupPlan = NO_MARKUP_PLAN, postToFrame = 'null') {
        // communication, logs and RPC bridge template that any content running in the sandbox uses.
        // createBroker is stringified in too, so the guest runs the identical dispatcher (see rpc.ts).
        // The features as one literal: the opt-in ones only when on, and the call budget always (M-2).
        const features: { autoResize?: true; fetchBridge?: { timeoutMs: number }; guestWrites?: true; callBudget: CallBudget } = { callBudget: { ...this._callBudget } };
        if (mode === 'cooperative' && this._autoResizeEnabled()) features.autoResize = true;
        if (this._fetchPolicy) features.fetchBridge = { timeoutMs: this._fetchPolicy.timeoutMs };
        if (this._config.guestWrites === true) features.guestWrites = true;
        const featuresArgument = `, ${toInlineScriptLiteral(features)}`;
        // Only literals are interpolated: `=== true` here as well, whatever setConfig() stored (review A6).
        const comms = `(${inSandboxScript.toString()})(${this._config.scriptUnsafe === true}, '${mode}', console, ${createBroker.toString()}${featuresArgument}, ${createSizeOf.toString()}, ${postToFrame})`;
        // Guest writes (C5): sandboxFiles gets the comms script's captured write call through `comms`, a constant
        // of a block the whole bootstrap then runs in: block-scoped, so never a global guest code could read.
        // Without them the bootstrap keeps its text: the comms statement, then sandboxFiles without a write call
        // (its write() and remove() refuse locally).
        const writes = this._config.guestWrites === true;
        // The snapshot is one inline literal, so the blobs exist before the parser reaches guest markup.
        // Installed even with no files (an empty literal): sandboxFiles always exists, and a lookup in
        // an empty store is NOT_FOUND like any other miss, never a ReferenceError.
        let filesCall = `(${inSandboxFiles.toString()})(${toInlineScriptLiteral(files)}${writes ? ', comms.writeFiles' : ''})`;
        // With JavaScript files: the one import map, registered with the URLs filesCall just created,
        // before any guest markup (module graph, PR3). It hands the files object on to the next step.
        if (plan.importMap) {
            filesCall = `(${inSandboxImportMap.toString()})(${filesCall}, ${toInlineScriptLiteral(plan.importMap.paths)}, ${toInlineScriptLiteral(plan.importMap.guest)})`;
        }
        // Guest markup that names files: written by the bootstrap's last statement, with the blob: URLs
        // filesCall just created (markup-references.ts). The parts are one more inline literal.
        const last = plan.parts ? `(${inSandboxMarkup.toString()})(${filesCall}, ${toInlineScriptLiteral(plan.parts)});` : `${filesCall};`;
        return writes ? `{const comms = ${comms};${last}}` : `${comms};${last}`;
    }

    private _getWorkerBootstrapScript(files: FileSnapshotEntry[]) {
        // the worker keeps only the allowlisted globals (worker-globals.ts), then runs the comms script and builds its
        // own blobs and sandboxFiles from the same literal; the frame only spawns it and forwards the port
        // No WebAssembly unless scriptUnsafe (review round 1, R2-5), as in strict mode: WebKit compiles it without
        // 'wasm-unsafe-eval', so the policy alone does not keep it out. Removed before the comms script, like the globals.
        // The allowlist runs first, as the argument of the function the rest runs in: it returns the worker's postMessage,
        // which it deleted (review round 4, M-1), and only the comms script is given it, for its one WORKER_STARTED.
        const noWasm = this._config.scriptUnsafe === true ? '' : `(${removeWebAssembly.toString()})(g);`;
        const workerSource = `(function (g, postToFrame) {${noWasm}${this._getSandboxCommsScript('worker', files, NO_MARKUP_PLAN, 'postToFrame')}})(this, ${workerGlobalsCall('this')});`;
        return `(${workerBootstrap.toString()})(${toInlineScriptLiteral(workerSource)}, ${toInlineScriptLiteral(TRUSTED_TYPES_POLICY)});`;
    }

    private _isPermission(capability: string): boolean {
        return (UNSAFE_PERMISSIONS as readonly string[]).includes(capability);
    }

    private _getSandboxFlags(): string {
        // Strict mode (ADR-005): STRICT_VIEW_FLAGS, plus the safe capabilities configured. No unsafe capability.
        if (this._config.mode === 'strict') return [...new Set<string>([...STRICT_VIEW_FLAGS, ...(this._config.capabilities || [])])].join(' ');
        const flags = new Set<string>(this._config.capabilities || []);
        for (const capability of this._config.unsafeCapabilities || []) {
            if (this._isPermission(capability)) continue; // goes into the allow attribute instead
            flags.add(capability);
        }

        // worker mode needs scripts in the frame to spawn the worker
        if (this._config.mode === 'worker') flags.add('allow-scripts');

        return [...flags].join(' ');
    }

    // Permissions Policy features for the iframe `allow` attribute (e.g. fullscreen)
    private _getPermissions(): string[] {
        const permissions: string[] = [];
        if (this._config.mode === 'strict') return permissions;
        for (const capability of this._config.unsafeCapabilities || []) {
            if (this._isPermission(capability)) permissions.push(capability);
        }
        return permissions;
    }

    // The guest policy of this build (csp-generator.ts, ADR-007): the mode's template, the parsed origins, and blob:
    // for the kinds of load this build's files need (the snapshot's types, through the one load-kind table). The one
    // place a guest policy is made; worker mode's worker and strict mode's worker inherit their frame's.
    private _guestPolicy(files: FileSnapshotEntry[]): string {
        const types = files.map(entry => entry[1]);
        const scriptUnsafe = this._config.scriptUnsafe === true;
        if (this._config.mode !== 'strict') return cooperativePolicy({ origins: this._origins, fileKinds: fileKinds(types), scriptUnsafe });
        // A type the view mints no URL for (isViewFileType, broad review ST1) is only fetched, by the worker.
        const viewTypes = types.map(type => (isViewFileType(type) ? type : FALLBACK_TYPE));
        const kinds = fileKinds(viewTypes);
        // With guest writes the view may mint URLs for raster images during the environment (R4-4): image loads only.
        if (this._config.guestWrites === true) kinds.add(LOAD_KINDS.image.key);
        return strictViewPolicy({ origins: this._origins, fileKinds: kinds, scriptUnsafe, bootstrapHash: viewBootstrapHash() });
    }

    // What the bootstrap does with this build's guest markup (GuestMarkupPlan): references to registered
    // files cut into parts for it to write (markup-references.ts) and, with JavaScript files, the one
    // import map (module graph). Only when the bootstrap can run — scripts allowed by the sandbox flags (the
    // policy always admits the inline bootstrap, csp-generator.ts) — since otherwise nothing would write the markup
    // or register the map; references then stay as written and fail closed, and so do relative imports between modules.
    private _getMarkupPlan(html: string, files: FileSnapshotEntry[], sandboxFlags: string): GuestMarkupPlan {
        if (files.length === 0) return NO_MARKUP_PLAN;
        if (!sandboxFlags.split(' ').includes('allow-scripts')) return NO_MARKUP_PLAN;

        // The module graph maps only files a script load admits (load-kinds.ts, through isJavaScriptType): an import
        // of any other file names nothing in the import map and fails closed, as a <script src> of one does (W1).
        const javascript = files.filter(entry => isJavaScriptType(entry[1])).map(entry => entry[0]);
        const markup = rewriteGuestMarkup(html, new Map(files.map(entry => [entry[0], entry[1]])), {
            modules: javascript.length > 0,
            onModuleFailure: (index) => this._warnOnce(`[Sandbox] inline module script #${index + 1} in the guest markup could not be lexed, so its relative imports were not rewritten and will fail.`),
            onKindMismatch: (mismatch) => this._warnOnce(kindMismatchMessage(mismatch)),
        });
        if (javascript.length === 0) return { parts: markup.parts, importMap: null };
        const guest = mergeGuestImportMaps(markup.importMaps, (message) => this._warnOnce(message));
        return { parts: markup.parts, importMap: { paths: javascript, guest } };
    }

    // Cooperative mode without allow-scripts runs no script, the library's bootstrap included (review round 1, R3-4): what
    // needs one does nothing there, silently, so it is said once per element and message.
    private _warnAboutNoScripts(html: string, sandboxFlags: string) {
        if (sandboxFlags.split(' ').includes('allow-scripts')) return;
        const unused: string[] = [];
        if (scriptInMarkup(html)) unused.push('the scripts and handlers in html');
        if (watchdogBudget(this._config.watchdogTimeout) > 0) unused.push('watchdogTimeout');
        if (this._config.autoResize === true) unused.push('autoResize');
        if (this._fetchPolicy) unused.push('fetchBridge');
        if (this._config.guestWrites === true) unused.push('guestWrites');
        if (this._config.scriptUnsafe === true) unused.push('execute()');
        if (this._exposedNames.size > 0) unused.push('the methods published with expose()');
        if (unused.length === 0) return;
        this._warnOnce(`[Sandbox] cooperative mode without "allow-scripts" runs no script, the library's own included: ${unused.join(', ')} ${unused.length === 1 ? 'has' : 'have'} no effect. Add "allow-scripts" to capabilities.`);
    }

    // Warnings about the guest's markup come back with every build of the same markup: one each per element.
    private _warnOnce(message: string) {
        if (this._warnedGuestMarkup.has(message)) return;
        this._warnedGuestMarkup.add(message);
        console.warn(message);
    }

    private createIframe() {
        const isWorkerMode = this._config.mode === 'worker';
        if (!this._autoResizeEnabled()) this._releaseAutoHeight();
        this._startFetchBridge();
        // One copy of the store per build, taken now: the guest's files and the policy come from its snapshot, and the
        // guest-write overlay answers from it (CB4). Later registerFiles() calls reach the guest only through the next build.
        const built = this._files.copy();
        this._startGuestWrites(built);

        const files = built.snapshot();
        if (this._config.mode === 'strict') {
            this._createStrictFrame(files);
            return;
        }

        const sandboxFlags = this._getSandboxFlags();
        const permissions = this._getPermissions();
        const policy = this._guestPolicy(files);

        // TODO: run through DOMPurify ?
        let guestDocument: string;
        if (isWorkerMode) {
            // worker mode is headless: no guest markup, so no markup references either
            guestDocument = buildGuestDocument({ csp: policy, bootstrapScript: this._getWorkerBootstrapScript(files), content: '' });
        } else {
            const html = this._config.html || '<div id="root"></div>';
            this._warnAboutNoScripts(html, sandboxFlags);
            // A fresh slot nonce per build (inside rewriteGuestMarkup); null parts keep the markup verbatim.
            const plan = this._getMarkupPlan(html, files, sandboxFlags);
            guestDocument = buildGuestDocument({
                csp: policy,
                bootstrapScript: this._getSandboxCommsScript('cooperative', files, plan),
                content: plan.parts ? '' : html,
                bootstrapWritesContent: plan.parts !== null,
            });
        }

        this._iframe = document.createElement("iframe");
        this._iframe.setAttribute("sandbox", sandboxFlags);
        // the wrapper's own document.referrer is never the host page (S15; the guest's is set in the wrapper)
        this._iframe.setAttribute("referrerpolicy", FRAME_REFERRER_POLICY);
        for (const [name, value] of Object.entries(permissionAttributes(permissions))) {
            this._iframe.setAttribute(name, value);
        }
        this._iframe.style.cssText = isWorkerMode ? "display:none" : "width:100%;height:100%;border:none";
        this._frameLoaded = false;
        this._iframe.onload = this._frameLoadHandler(this._iframe);

        // srcdoc goes in before the frame is inserted: an iframe inserted without one first
        // loads about:blank, which would count as the frame's one load (see _onFrameLoad)
        setWrapperSrcdoc(this._iframe, buildWrapperDocument(guestDocument, sandboxFlags, permissions));
        // The guest announces its port from its first statement (CB1), so the listener is in place before the frame
        // exists. A bootstrap runs, and announces, exactly where the inline script can run (_getMarkupPlan's test).
        this._expectAnnouncement = sandboxFlags.split(' ').includes('allow-scripts');
        this._listenForAnnouncement(this._iframe);
        this.shadowRoot!.appendChild(this._iframe);
    }

    /**
     * Strict mode (ADR-005). The view document is the policy and the hashed bootstrap, nothing of the guest's;
     * the worker's source (comms, files, the strict prelude, then the entry) and the initial markup travel in
     * INIT_VIEW once the wrapper has loaded. The view mints its own blob: URLs for the registered files it may
     * show, so no JavaScript file is ever given to it.
     */
    private _createStrictFrame(files: FileSnapshotEntry[]) {
        let entrySource = '';
        const entry = this._config.entry;
        if (typeof entry === 'string' && entry !== '') {
            const file = files.find(candidate => candidate[0] === entry);
            if (!file || !isJavaScriptType(file[1])) throw new Error('the entry was not refused before the build'); // _buildRefusal decides
            entrySource = new TextDecoder().decode(Uint8Array.from(atob(file[2]), c => c.charCodeAt(0)));
        }

        const html = this._config.html || '<div id="root"></div>';
        this._warnAboutStrictHtml(html);
        const sandboxFlags = this._getSandboxFlags();
        const policy = this._guestPolicy(files);
        this._strictInit = {
            workerSource: this._getStrictWorkerSource(files, entrySource),
            viewFiles: files.filter(candidate => isViewFileType(candidate[1])), // never a type that opens as a document (broad review ST1)
            html,
            autoResize: this._autoResizeEnabled(),
            allowAnimations: this._config.allowAnimations !== false,
            allowAutoplay: this._config.allowAutoplay === true,
            origins: { images: [...this._origins.images], media: [...this._origins.media] },
        };
        const view = buildViewDocument(policy, viewBootstrapText());

        this._iframe = document.createElement("iframe");
        this._iframe.setAttribute("sandbox", sandboxFlags);
        this._iframe.setAttribute("referrerpolicy", FRAME_REFERRER_POLICY);
        this._iframe.style.cssText = "width:100%;height:100%;border:none";
        this._frameLoaded = false;
        this._iframe.onload = this._frameLoadHandler(this._iframe);
        setWrapperSrcdoc(this._iframe, buildWrapperDocument(view, sandboxFlags, []));
        this.shadowRoot!.appendChild(this._iframe);
    }

    // The worker's source in strict mode: the scope check, the globals allowlist, the comms script (bridge, logs, violations, execute,
    // the fetch bridge), sandboxFiles with every registered file, the strict prelude (hardening, sandboxView, the
    // ports), then the guest's entry in a function scope of its own, then the line that marks the entry as having
    // run to its end. The entry's own scope (review C2): its top-level declarations are local to it, so none can
    // replace a global before the prelude has captured or deleted it; an entry that wants a global assigns it
    // (globalThis.x = …). `this` inside is the global object, as at a script's top level. The scope check
    // (assertEntryScoped) refuses to start a worker whose entry escaped that scope.
    private _getStrictWorkerSource(files: FileSnapshotEntry[], entrySource: string): string {
        const features: { fetchBridge?: { timeoutMs: number }; externalPort: true; guestWrites?: true; callBudget: CallBudget } = { externalPort: true, callBudget: { ...this._callBudget } };
        if (this._fetchPolicy) features.fetchBridge = { timeoutMs: this._fetchPolicy.timeoutMs };
        if (this._config.guestWrites === true) features.guestWrites = true;
        const marker = entryDoneName(); // drawn per build: an entry cannot declare a binding of its name (broad review ST4)
        const options = { scriptUnsafe: this._config.scriptUnsafe === true, maxRender: VIEW_RENDER_MAX_LENGTH, maxTarget: VIEW_TARGET_MAX_LENGTH, maxElements: VIEW_MAX_ELEMENTS, maxDepth: VIEW_MAX_DEPTH, maxCharacters: VIEW_MAX_CHARACTERS, maxUrls: VIEW_MAX_URLS, entryDoneName: marker, eventTypes: VIEW_EVENT_TYPES };
        const prelude = '(function (g) {'
            + `(${assertEntryScoped.toString()})(g);`
            + workerGlobalsStatement('g')
            + `var comms = (${inSandboxScript.toString()})(${this._config.scriptUnsafe === true}, 'strict', console, ${createBroker.toString()}, ${toInlineScriptLiteral(features)}, ${createSizeOf.toString()});`
            + `(${inSandboxFiles.toString()})(${toInlineScriptLiteral(files)}, ${this._config.guestWrites === true ? 'comms.writeFiles' : 'null'}, ${toInlineScriptLiteral(VIEW_FILE_TYPES)});`
            + `(${inStrictWorker.toString()})(comms, ${toInlineScriptLiteral(options)});`
            + '})(this);';
        return `${prelude}\n(function () {\n${entrySource}\n}).call(this);\n${marker}();\n`;
    }

    // One of the view's switches as the config gives it (VIEW_SWITCHES): its default when left out, the boolean it is,
    // else false, with a warning in strict mode (in the other modes it is ignored, which _warnAboutStrictConfig says).
    private _viewSwitch(input: object, name: ViewSwitch, mode: unknown): boolean {
        const value = (input as Record<string, unknown>)[name];
        if (value === undefined) return VIEW_SWITCHES[name];
        if (typeof value === 'boolean') return value;
        if (mode === 'strict') this._warnStrictOnce(`[Sandbox] ${name} must be a boolean; ${shown(value)} was taken as false: ${VIEW_SWITCH_OFF[name]}.`);
        return false;
    }

    private _warnStrictOnce(message: string) {
        if (this._warnedStrict.has(message)) return;
        this._warnedStrict.add(message);
        console.warn(message);
    }

    // Strict-mode configuration the element will not honour, said once per instance each.
    private _warnAboutStrictConfig(config: StoredConfig, input: object) {
        const warn = (message: string) => this._warnStrictOnce(message);
        if (config.mode !== 'strict') {
            if (config.entry) warn('[Sandbox] "entry" is used only in strict mode and was ignored.');
            for (const name of Object.keys(VIEW_SWITCHES) as ViewSwitch[]) {
                if ((input as Record<string, unknown>)[name] !== undefined) warn(`[Sandbox] "${name}" is used only in strict mode and was ignored.`);
            }
            return;
        }
        const unsafe = config.unsafeCapabilities || [];
        if (unsafe.length > 0) warn(`[Sandbox] unsafeCapabilities are not available in strict mode and were dropped: ${unsafe.join(', ')}.`);
    }

    // Strict mode is the default, so markup written for cooperative mode reaches it unchanged: its scripts and
    // handlers never run (the renderer drops them, and the view's policy admits only the bootstrap). Said once per
    // element, read with an inert parser (markup-scripts.ts); not again once said, so a big view is parsed only until then.
    private _warnAboutStrictHtml(html: string) {
        if (this._warnedStrict.has(STRICT_HTML_SCRIPT_WARNING) || !scriptInMarkup(html)) return;
        this._warnedStrict.add(STRICT_HTML_SCRIPT_WARNING);
        console.warn(STRICT_HTML_SCRIPT_WARNING);
    }

    // The view liveness check (A5): the view answers VIEW_PING on its port; silence for the budget ends the sandbox.
    private _startViewWatchdog(viewPort: MessagePort) {
        this._viewWatchdog = startWatchdog({
            timeoutMs: VIEW_LIVENESS_TIMEOUT_MS,
            ping: (n) => viewPort.postMessage({ type: 'VIEW_PING', n }),
            onExpire: () => this._terminate(VIEW_LOST_REASON),
        });
    }

    // The wrapper's one load: completes a build that waits for it (strict mode, or a guest that runs no bootstrap), and
    // checks the frame's integrity in every mode. Like createIframe(), anything it throws ends the sandbox with a reason
    // instead of leaving it 'loading' (initialize).
    // The wrapper's load handler for `iframe` (review round 2, L-6): a load counts only for the element's current frame
    // while both are in the document. Chromium and WebKit fire a frame's load when it is detached, from inside remove()
    // or appendChild() and before the element's disconnectedCallback: a cooperative build without a bootstrap became
    // 'ready' there, dispatched synchronously from the embedder's own remove().
    //
    // Never from inside the load event itself (review round 4, L-1): the check above held in a load that Chromium and
    // WebKit fire during the embedder's appendChild() of the element (a move), for the frame being moved, since the frame
    // and the element still read as connected there, and 'ready' was dispatched from inside the embedder's own call. The
    // build completes in a microtask instead, after the element's own lifecycle reactions (disconnectedCallback, then
    // connectedCallback), which run before appendChild() or remove() returns: a frame that the move tore down is no
    // longer the element's then, and its load completes nothing. The microtask asks again: the same frame, both still
    // connected, and the same environment.
    private _frameLoadHandler(iframe: HTMLIFrameElement) {
        return () => {
            const generation = this._generation;
            queueMicrotask(() => {
                if (iframe !== this._iframe || generation !== this._generation || !iframe.isConnected || !this.isConnected) return;
                this._onFrameLoad();
            });
        };
    }

    private _onFrameLoad() {
        try {
            this._completeBuild();
        } catch (error) {
            this._terminate(`${BUILD_FAILED_REASON} (${errorName(error)})`);
        }
    }

    private _completeBuild() {
        // The wrapper is written once and has no script, so it loads exactly once.
        // A second load means something navigated or reloaded it: never hand a port
        // (or queued code) to a document we did not write.
        if (this._frameLoaded) {
            this._terminate(SECOND_LOAD_REASON);
            return;
        }
        this._frameLoaded = true;

        const guestWindow = guestWindowOf(this._iframe);
        // The guest checked in already (S46), and the build completed then: the load must hold the frame that
        // announced. A wrapper navigated before its first load fires one load only, for a document we did not write.
        if (this._guestWindow) {
            if (guestWindow !== this._guestWindow) this._terminate(SECOND_LOAD_REASON);
            return;
        }
        if (!guestWindow) {
            this._terminate('the guest frame is missing');
            return;
        }
        // A bootstrap runs: its check-in completes the build, after this load.
        if (this._expectAnnouncement) return;

        // Strict mode: the view gets its ports now, and the build completes when the view checks in on its port
        // (VIEW_READY, _onViewMessage): never on this load alone, which also fires for a view whose bootstrap did not
        // run (refused by the host page's policy, R3-1: 'ready' came, and 5 s later "the sandbox view stopped
        // responding").
        if (this._config.mode === 'strict') {
            this._setupStrictChannels(guestWindow);
            return;
        }
        this._finishBuild(null);
    }

    // Cooperative and worker mode: the build completes when the guest checks in, its bootstrap's announcement accepted
    // (CB1, S46), with the port it announced; where this build's guest runs no bootstrap (no allow-scripts), on the
    // wrapper's one load, with no port. Anything it throws ends the sandbox, as in _onFrameLoad.
    private _finishBuild(port: MessagePort | null) {
        if (this._state !== 'loading') {
            port?.close();
            return;
        }
        try {
            this.setupChannel(port);
            this._enterReady();
        } catch (error) {
            this._terminate(`${BUILD_FAILED_REASON} (${errorName(error)})`);
        }
    }

    // The transition to `ready`, in every mode, and the one place what waited for it is released (review round 5, L-1; the
    // first slice of the lifecycle reducer, backlog S65): the queued calls and execute() code are posted here, in the
    // order they were made, and nowhere else. A call made while loading waits in the queue for this point; if it settles
    // first (its timeout), it leaves the queue and is never posted (_queuedWhilePending), so a call that timed out before
    // `ready` never runs. Before, strict mode flushed at the wrapper's load (_setupStrictChannels), the other modes in
    // setupChannel, two flush points for one rule, and strict mode's was not this one.
    private _enterReady() {
        if (this._loadDeadline) { this._loadDeadline.stop(); this._loadDeadline = null; }
        if (this._port) this._flushQueues(this._port);
        // Armed before 'ready' is dispatched: a 'ready' listener that resets or terminates the sandbox then
        // stops this watchdog with the rest, instead of leaving one running for a port that is gone.
        if (this._port) this._startWatchdog(this._port);
        if (this._viewPort) this._startViewWatchdog(this._viewPort);
        // Reports buffered before the port existed arrive after this, so the resizer is in place for them.
        this._startAutoResize();
        this._enterState('ready');
    }
}

// The lifecycle (CB7). Each function reaches the element's own fields and the class's methods through
// WebSandbox.prototype, never through the element's prototype chain: in Firefox an element adopted into another
// document has that document's HTMLElement prototype. The methods applied here (_teardown, _discardGuestWrites,
// _enterState, and initialize only in the defining document) use the element's own fields.
const LIFECYCLE = WebSandbox.prototype as unknown as {
    initialize(): void;
    _teardown(): void;
    _discardGuestWrites(): void;
    _enterState(state: SandboxState): void;
};

// One guest change as the strict view is told it (R4-4): the path, its store type (null after a removal) and, only for a
// type the view mints a URL for (VIEW_WRITE_TYPES), a copy of the bytes. Any other change still names the path, so the
// view stops resolving whatever it named before.
interface ViewWrite {
    path: string;
    mime: string | null;
    bytes: Uint8Array | null;
}

function viewWriteOf(path: string, change: { type: string; bytes: Uint8Array } | null | undefined): ViewWrite {
    if (!change) return { path, mime: null, bytes: null };
    return { path, mime: change.type, bytes: VIEW_WRITE_TYPES.includes(change.type) ? change.bytes.slice() : null };
}

// A guest write while writes are off, or after the overlay was discarded: the one refusal.
function refuseGuestWrite(): Promise<never> {
    return Promise.reject(fileError('FILES_NOT_ALLOWED', 'guest writes are off (guestWrites is not set).'));
}

// The environment ends; no 'terminated' event: the element left (or never reached) a document it can build in.
function stop(element: WebSandbox) {
    Reflect.apply(LIFECYCLE._teardown, element, []);
    Reflect.apply(LIFECYCLE._discardGuestWrites, element, []);
    Reflect.apply(LIFECYCLE._enterState, element, ['idle']);
}

// An environment is built only in the document of the realm that defined the element, while the element is in it. In
// another document (an iframe's, one made with document.implementation) the guest would announce itself to that
// document's window, which the element does not listen to (Chromium and WebKit built a bridge that never connected),
// and in Firefox the element has lost its methods. So it stays idle there, with one warning, until it is back in its
// own document. The one predicate both connected() and initialize() ask (review round 2, L-1).
function buildsHere(element: WebSandbox): boolean {
    return element.isConnected && element.ownerDocument === document;
}

function connected(element: WebSandbox) {
    if (!buildsHere(element)) {
        stop(element);
        const own = element as unknown as { _warnedForeignDocument: boolean };
        if (own._warnedForeignDocument) return;
        own._warnedForeignDocument = true;
        console.warn('[Sandbox] the element was inserted into a document of another window: it builds no environment there. Insert it into the document of the window that defined it.');
        return;
    }
    if (!restorePrototype(element)) return; // the engine refuses: the element stays idle (stop() ran when it left)
    Reflect.apply(LIFECYCLE.initialize, element, []);
}

// Firefox gives an element adopted into another document that document's HTMLElement prototype (CB7): its methods were
// gone there, so a call threw a TypeError, and registerFiles() changed the store and then threw before its
// 'fileschanged' (review round 2, L-5). The element gets its own prototype back on adoption, and again on its return
// (connected), so its methods behave the same in every document: there, as the element is idle, a call is refused with
// TERMINATED and a build does nothing (buildsHere). False if the engine refuses.
function restorePrototype(element: WebSandbox): boolean {
    if (Object.getPrototypeOf(element) === WebSandbox.prototype) return true;
    try {
        Object.setPrototypeOf(element, WebSandbox.prototype);
        return true;
    } catch {
        return false;
    }
}

function disconnected(element: WebSandbox) {
    stop(element);
}

function adopted(element: WebSandbox) {
    stop(element);
    restorePrototype(element);
}

/**
 * Registers the element under `tagName` (default `<web-sandbox>`). Safe to call more than once.
 * Importing the library does not register anything, so you can pick your own tag name.
 * Throws if `tagName` is taken by another element; the class can be registered under one name only (the
 * browser throws NotSupportedError for a second, different name).
 */
export function defineWebSandbox(tagName = 'web-sandbox'): typeof WebSandbox {
    const existing = customElements.get(tagName);
    if (existing && existing !== WebSandbox) throw new Error(`<${tagName}> is already defined by another element`);
    if (!existing) customElements.define(tagName, WebSandbox);
    return WebSandbox;
}
