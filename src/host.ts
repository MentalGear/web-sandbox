/**
 * The `<web-sandbox>` custom element: it builds each mode's frames, holds the host end of every port, and applies the
 * lifecycle reducer's effects (lifecycle.ts) to the DOM.
 */
import type { SafeCapability, UnsafeCapability } from "./csp-directives";
import { UNSAFE_PERMISSIONS } from "./csp-directives";
import { connectSources, cooperativePolicy, fileKinds, strictViewPolicy, type PolicyInput } from "./lib/csp/csp-generator";
import { narrowToHostPolicy, parseHostPolicies, type NarrowedReach } from "./lib/csp/host-connect";
import { buildRefused, executeRefused, trustedTypesStance, type TrustedTypesMode, type TrustedTypesStance } from "./lib/csp/host-trusted-types";
import { hostPolicyReadFailed, knownHostPolicies, whenHostPoliciesKnown } from "./lib/host-csp";
import { NO_ORIGINS, ORIGINS_REFUSAL_TEXT, OriginsTypeError, type OriginPolicy, type SandboxOrigins, type StrictSandboxOrigins } from "./lib/csp/origins";
import { FALLBACK_TYPE, fileError, FileStore, isJavaScriptType, type FileEntry, type FileInfo, type FileSnapshotEntry } from "./lib/files";
import { createGuestWrites, parseCommitArguments, WRITE_METHOD, type GuestWrite, type GuestWriteAnswer, type GuestWrites } from "./lib/guest-writes";
import { inSandboxFiles, inSandboxImportMap, inSandboxMarkup } from "./lib/in-sandbox-files";
import { kindMismatchMessage, rewriteGuestMarkup, type MarkupParts } from "./lib/markup-references";
import { scriptInMarkup } from "./lib/markup-scripts";
import { LOAD_KINDS } from "./lib/load-kinds";
import { mergeGuestImportMaps } from "./lib/import-map";
import { ANNOUNCEMENT_TYPE, inSandboxScript } from "./lib/in-sandbox-script";
import { createBroker, RESERVED_METHOD_PREFIX, type BudgetRefusal } from "./lib/rpc";
import { createSizeOf } from "./lib/structured-size";
import { workerBootstrap } from "./lib/worker-bootstrap";
import { keepOnlyWorkerGlobals, STRICT_WORKER_GLOBALS, WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS } from "./lib/worker-globals";
import { startWatchdog, watchdogBudget, type Watchdog } from "./lib/watchdog";
import { setLongTimeout, type LongTimeout } from "./lib/long-timer";
import { createRateLimiter, type RateLimiter } from "./lib/rate-limit";
import { toViolationDetail, VIOLATION_DIRECTIVES, VIOLATION_EVENT_LIMIT, type SandboxViolation } from "./lib/violation";
import { createLogLimiter, LOG_MAX_BYTES, LOG_OWN_LINES, toLogDetail, type SandboxLog, type SandboxLogLevel } from "./lib/sandbox-log";
import { startAutoResize, type AutoResizer } from "./lib/auto-resize";
import { createFetchBridge, fetchRefusal, FETCH_METHOD, type FetchBridge, type FetchBridgeConfig, type FetchPolicy, type FetchRecord } from "./lib/fetch-bridge";
import { BRIDGE_FRAME_REFUSED, createBridgeFrame, prepareBridgeFrame, type BridgeFrame } from "./lib/bridge-frame";
import { buildGuestDocument, buildWrapperDocument, permissionAttributes, setWrapperFrameIsolation, toInlineScriptLiteral, WRAPPER_STYLE } from "./lib/frame-documents";
import { scriptHashSource } from "./lib/csp/script-hash";
import { browserHasTrustedTypes, setLibrarySrcdoc, TRUSTED_TYPES_POLICY, TrustedTypesRefusal } from "./lib/trusted-types";
import { hostRegistrableDomain } from "./lib/host-site";
import { admitGuestCall, DEFAULT_CALL_BUDGET, defaultConfig, normaliseConfig, STRICT_VIEW_FLAGS, unknownModeReason, type CallBudget, type StoredConfig } from "./lib/config-schema";
import { bootstrapListeners, UNCAUGHT_BUDGET, type BootstrapListener } from "./lib/egress";
import { elementEvent } from "./lib/element-events";
import { detachEnvironment, releaseEnvironment, type EnvironmentFields } from "./lib/environment";
import { hostLine, reasonText } from "./lib/reasons";
import { ENVIRONMENT_CHECKS, ENVIRONMENT_EXPECTED, ENVIRONMENT_REFUSED_TYPE } from "./lib/environment-check";
import { INITIAL_LIFECYCLE, runNotices, step as runStep, type BuildContext, type Generation, type LcInput, type LcState, type LifecycleHost, type Notice } from "./lib/lifecycle";
import { assertEntryScoped, buildViewDocument, entryDoneName, environmentGate, inStrictWorker, isViewFileType, VIEW_FILE_TYPES, viewBootstrapHash, viewBootstrapText, VIEW_EVENT_TYPES, VIEW_MAX_CHARACTERS, VIEW_MAX_DEPTH, VIEW_MAX_DISTINCT_URLS, VIEW_MAX_ELEMENTS, VIEW_MAX_URLS, VIEW_OPTIONS, VIEW_RENDER_MAX_LENGTH, VIEW_STILL_STYLE, VIEW_TARGET_MAX_LENGTH, VIEW_WRITE_TYPES } from "./lib/in-sandbox-view";

/**
 * The configuration `setConfig()` takes: a union keyed by `mode`.
 *
 * @remarks
 * Every option left out takes its default, not its previous value. The union narrows each mode, so an option a mode
 * cannot use does not type-check (strict mode's `origins` has no `scripts`; ADR-007). A config from JSON is held to the
 * same rules at run time: an option outside its modes is ignored and holds its default, mostly with one warning. A
 * config that names no `mode` is a strict config. Defaults, bounds and modes of every option: docs/API.md#configuration.
 */
export type SandboxConfig = StrictSandboxConfig | CooperativeSandboxConfig | WorkerSandboxConfig;

/**
 * The configuration of strict mode (ADR-005), the default: guest code runs only in a worker that a view document
 * spawns, and the worker draws into the view with `sandboxView.render()`. `html` is the initial view, rendered without
 * its scripts and event-handler attributes.
 */
export interface StrictSandboxConfig extends SandboxConfigOptions {
    /**
     * Names the mode; strict when left out. A value that is not a mode starts no environment: the sandbox terminates
     * with a reason that names it (AR:A4).
     */
    mode?: 'strict';
    /** The origins the view's policy admits: as in the other modes, but without `scripts`, since the view runs only the library's bootstrap. */
    origins?: StrictSandboxOrigins;
    /** Not in strict mode (R1:R3-6): no capability reaches outside the view. Dropped at run time. */
    unsafeCapabilities?: never;
}

/**
 * The configuration of cooperative mode, for content that cooperates: guest code runs in the guest document, within the
 * documented limits of the mode (README, "Cooperative-mode limits"). `'iframe'` is not a mode: it is refused like any other unknown value.
 */
export interface CooperativeSandboxConfig extends SandboxConfigOptions {
    /** Names the mode. */
    mode: 'cooperative';
    /**
     * The exact origins the guest may load each kind from (ADR-007).
     * @defaultValue none
     */
    origins?: SandboxOrigins;
    /** Strict mode only (R1:R3-6): ignored with a warning at run time. */
    entry?: never;
    /** Strict mode only (the guest document is the guest's own): ignored with a warning at run time. */
    allowAnimations?: never;
    /** Strict mode only: ignored with a warning at run time. */
    allowAutoplay?: never;
    /** Worker and strict mode only (the guest document may share the host's thread, so no timer could fire; R1:R3-6): ignored. */
    workerExecutionTimeout?: never;
}

/**
 * The configuration of worker mode: guest code runs in a worker inside the frame. The mode is frozen and is to be folded
 * into strict mode (S49).
 */
export interface WorkerSandboxConfig extends SandboxConfigOptions {
    /** Names the mode. */
    mode: 'worker';
    /**
     * The exact origins the guest may load each kind from (ADR-007).
     * @defaultValue none
     */
    origins?: SandboxOrigins;
    /** Strict mode only (R1:R3-6): ignored with a warning at run time. */
    entry?: never;
    /** Strict mode only (a worker has no document): ignored with a warning at run time. */
    allowAnimations?: never;
    /** Strict mode only: ignored with a warning at run time. */
    allowAutoplay?: never;
    /** A worker has no document (R1:R3-6): ignored. */
    html?: never;
    /** A worker has no document to measure (R1:R3-6): no effect, with a warning at run time. */
    autoResize?: never;
}

/**
 * The events the element dispatches, and the `detail` of each: the type map of `addEventListener()`.
 *
 * @remarks
 * Every event is a `CustomEvent` dispatched on the element and none is `composed`. The bubbling ones reach a listener on
 * `window` for every sandbox on the page; `event.target` says which. The `detail` is frozen, deeply: every object and
 * array in it, a guest's log arguments included. What cannot be frozen stays as it is: the bytes of a typed array or an
 * `ArrayBuffer`, the entries of a `Map` or a `Set`, a `Date`'s time. Fields that come from the guest are validated and
 * clamped, but remain the guest's data: read them, do not merge them into your objects. Guest-controlled text (a log
 * line's arguments, a violation's `blockedURI` and `sourceFile`, a fetch record's `url`): show it with `textContent`,
 * never in an HTML, URL (such as a link `href`), `eval` or template sink. `terminated.reason` is the library's text.
 */
export interface WebSandboxEventMap extends HTMLElementEventMap {
    /**
     * The guest checked in and `state` is now `'ready'`.
     *
     * @remarks
     * Once per environment. In cooperative mode the guest document may still be loading (see
     * docs/API.md#ready-and-the-startup-gate). Without `allow-scripts` no guest script runs: `ready` comes with the
     * frame's load, and calls time out. Does not bubble.
     */
    ready: CustomEvent<null>;
    /**
     * The sandbox was terminated: `state` is `'terminated'` and `detail.reason` says why.
     *
     * @remarks
     * Once per termination, for a call to `terminate()`, a budget or liveness check that ended the guest, a failed frame
     * check, or a configuration or build that was refused (that one in a task of its own, and not at all if another build
     * started meanwhile). Removing the element ends its environment without this event. Branch on `state` and the event,
     * not on the reason's text. Does not bubble.
     */
    terminated: CustomEvent<{ readonly reason: string }>;
    /**
     * A log line from the guest's console or written by the element; see {@link SandboxLog}.
     *
     * @remarks
     * Guest lines are limited to {@link LOG_EVENTS_PER_SECOND} per environment per second. Bubbles.
     */
    'sandbox-log': CustomEvent<SandboxLog>;
    /**
     * The guest's policy refused a load; see {@link SandboxViolation}.
     *
     * @remarks
     * At most {@link VIOLATION_EVENT_LIMIT} per environment. A report is a claim by the guest, not a host fact. Bubbles.
     */
    violation: CustomEvent<SandboxViolation>;
    /**
     * A `sandboxFetch()` request settled, refusals included; see {@link FetchRecord}.
     *
     * @remarks
     * Dispatched only with `fetchBridge` configured. Without it `sandboxFetch()` rejects with `FETCH_NOT_ALLOWED` and no
     * event is dispatched. Bubbles.
     */
    fetch: CustomEvent<FetchRecord>;
    /**
     * `registerFiles()`, `unregisterFiles()` or `commitGuestWrites()` changed the files; `detail.paths` lists the paths
     * that changed.
     *
     * @remarks
     * Dispatched synchronously, once per call that changed something. Does not bubble.
     */
    fileschanged: CustomEvent<{ readonly paths: readonly string[] }>;
    /**
     * The guest's write or removal changed what `listGuestWrites()` shows at a path (with `guestWrites`); `detail.paths`
     * holds that one path.
     *
     * @remarks
     * At most {@link GUEST_WRITES_PER_SECOND} per environment per second. Bubbles.
     */
    fileswritten: CustomEvent<{ readonly paths: readonly string[] }>;
}

/**
 * Typed event listeners for `WebSandbox`: each event's `detail` is typed by {@link WebSandboxEventMap}. This
 * declaration is types only, merged into the class.
 */
export interface WebSandbox {
    /**
     * Listens for an event of the element; the listener's `event.detail` has the type {@link WebSandboxEventMap} gives
     * the event's name.
     *
     * @typeParam K - The event name.
     * @param type - The event name, one of {@link WebSandboxEventMap}'s.
     * @param listener - Called with the event, `this` being the element.
     * @param options - As for `EventTarget.addEventListener`.
     */
    addEventListener<K extends keyof WebSandboxEventMap>(type: K, listener: (this: WebSandbox, event: WebSandboxEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
    /**
     * Listens for any event by name, untyped: the platform's own signature.
     *
     * @param type - The event name.
     * @param listener - A function or an object with `handleEvent`.
     * @param options - As for `EventTarget.addEventListener`.
     */
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
    /**
     * Removes a listener added with the typed overload of `addEventListener()`.
     *
     * @typeParam K - The event name.
     * @param type - The event name, one of {@link WebSandboxEventMap}'s.
     * @param listener - The function that was added.
     * @param options - As for `EventTarget.removeEventListener`.
     */
    removeEventListener<K extends keyof WebSandboxEventMap>(type: K, listener: (this: WebSandbox, event: WebSandboxEventMap[K]) => unknown, options?: boolean | EventListenerOptions): void;
    /**
     * Removes a listener by event name, untyped: the platform's own signature.
     *
     * @param type - The event name.
     * @param listener - The function or object that was added.
     * @param options - As for `EventTarget.removeEventListener`.
     */
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

declare global {
    interface HTMLElementTagNameMap {
        /** The element under its default tag name (defineWebSandbox()). */
        'web-sandbox': WebSandbox;
    }
}

/**
 * The options every mode takes, and the ones a mode's config narrows ({@link StrictSandboxConfig},
 * {@link CooperativeSandboxConfig}, {@link WorkerSandboxConfig}).
 *
 * @remarks
 * An option left out takes its default, whatever `setConfig()` was given before. An option a mode does not
 * read holds its default in that mode. Each option's accepted values, bounds, warnings and modes are declared once, in
 * the config schema (`CONFIG_SCHEMA`, src/lib/config-schema.ts), and docs/API.md#configuration renders them.
 */
export interface SandboxConfigOptions {
    /**
     * Whether the guest policy allows `'unsafe-eval'` (strings run as code, WebAssembly too) and
     * `execute()` runs code. For testing: each element that enables it warns once. Only a literal `true`
     * enables it.
     *
     * @defaultValue `false`
     */
    scriptUnsafe?: boolean;
    /**
     * Sandbox flags that keep the guest inside the frame, from {@link SAFE_CAPABILITIES}. An entry that is not one is
     * dropped with a warning. Worker mode always adds `allow-scripts`; strict mode's view always has `allow-scripts` and
     * `allow-forms`, so listing either there changes nothing.
     *
     * @defaultValue `[]`
     */
    capabilities?: SafeCapability[];
    /**
     * Capabilities that act outside the frame, from {@link UNSAFE_CAPABILITIES} (popups, modals, downloads, forms,
     * presentation, pointer lock, fullscreen): an explicit opt-in, and each one enabled warns once. Cooperative and worker mode only;
     * dropped with a warning in strict mode.
     *
     * @remarks
     * On Chromium the sandbox's frame is credentialless, so a popup that `allow-popups` lets the guest open has no
     * opener: the guest's `window.open()` returns `null`, though the page opens.
     *
     * @defaultValue `[]`
     */
    unsafeCapabilities?: UnsafeCapability[];
    /**
     * The initial HTML: the initial view in strict mode (its `<script>` elements and event-handler attributes never
     * run, and markup that holds any warns once per element), the guest document in cooperative mode. Ignored in worker
     * mode. `load()` sets it too. Empty means `<div id="root"></div>`. A value that is not a string is
     * dropped with a warning.
     *
     * @defaultValue `''`
     */
    html?: string;
    /**
     * Strict mode only: the path of a registered JavaScript file (see `registerFiles()`) that the worker
     * runs first, as a classic script. Ignored with a warning in other modes. If it is not a registered JavaScript file
     * the sandbox terminates.
     *
     * @defaultValue none
     */
    entry?: string;
    /**
     * Strict mode only: whether CSS animations and transitions run in the view. Only a literal `true` keeps them; left
     * out, `false` or any other value (with one warning when it is not a boolean) removes them. Ignored with a warning
     * in other modes.
     *
     * @remarks
     * While `true`, animations run on the host page's main thread wherever the browser runs the view there, and the
     * view's time budget does not bound them: a guest can keep the page busy for as long as they run. `false` removes
     * them (elements show their end state), which keeps the default configuration inside the documented bound on every
     * engine. While `false`, a host page whose `style-src` refuses inline styles must allow the view's stylesheet by
     * its hash (docs/API.md#host-page-policy).
     *
     * @defaultValue `false`
     */
    allowAnimations?: boolean;
    /**
     * Strict mode only: whether `<video autoplay>` and `<audio autoplay>` in the view start on their own. Only a literal
     * `true` keeps `autoplay`; left out, `false` or any other value (with one warning when it is not a boolean) removes
     * it, and media then plays only when the user starts it. Ignored with a warning in other modes.
     *
     * @remarks
     * With `true`, playing media costs the host page's main thread where the view shares it, outside the view's time
     * budget.
     *
     * @defaultValue `false`
     */
    allowAutoplay?: boolean;
    /**
     * A deadline in ms for each `execute()`, in worker and strict mode. At the deadline the guest's event
     * loop must be free: the element pings the guest, and if no answer arrives within
     * {@link EXECUTION_TIMEOUT_GRACE_MS} the sandbox ends (a `sandbox-log` line `Execution Timeout`, then `terminated`).
     * Anything but a finite number above 0 is off. Not read in cooperative mode.
     *
     * @defaultValue `0` (off)
     */
    workerExecutionTimeout?: number;
    /**
     * Terminates a guest that stops answering for this long, in ms; anything but a finite number above 0 is off. It
     * starts at `ready`. Off by default because legitimate synchronous work longer than the budget is stopped too.
     * In cooperative mode it bounds a looping guest only where the browser runs the frame in its own process.
     *
     * @defaultValue `0` (off)
     */
    watchdogTimeout?: number;
    /**
     * Whether the element's height follows the guest's content height, from `ready` on; the height is validated,
     * clamped to {@link AUTO_RESIZE_MAX_HEIGHT} and changes at most {@link AUTO_RESIZE_MAX_UPDATES_PER_SECOND} times a
     * second. Only a literal `true` enables it. Strict and cooperative mode; in worker mode it does nothing, with one
     * warning.
     *
     * @defaultValue `false`
     */
    autoResize?: boolean;
    /**
     * Opens `sandboxFetch()` in the guest: the host decides each request under a fixed discipline (exact-origin
     * allowlist, no credentials, no redirects, capped body and time), a hidden frame of the library's with an opaque
     * origin makes it (the target sees `Origin: null`), and the host reports it as a `fetch` event. The guest's
     * policy is unchanged. Without it, `sandboxFetch()` rejects with `FETCH_NOT_ALLOWED`. See ADR-006.
     *
     * @defaultValue off
     */
    fetchBridge?: FetchBridgeConfig;
    /**
     * The host page's Content-Security-Policy as text, so that the library drops the origins it refuses from
     * `origins.connect` and `fetchBridge.allow`: a string (one or more policies, as a header or a `<meta>` carries them),
     * or `false` to skip. Left out, the library reads the page's policy once per page load.
     *
     * @remarks
     * A sandbox's frames inherit the host page's policy, which can only narrow theirs, but engines differ on what some of
     * its sources admit in such a frame. So the library applies the page's `connect-src` (else
     * `default-src`) itself, in every engine: each origin in `origins.connect` and `fetchBridge.allow` that a policy
     * refuses is dropped with a warning, before the guest's and the bridge's policies are written. Only `connect-src` is
     * read, and an origin is kept only where every engine admits it: `'self'`, a host written without a scheme, a path
     * and anything the parser does not understand admit nothing (docs/API.md#your-connect-src has the grammar).
     *
     * - A string is the enforced policy, exactly as served; several policies are separated by commas, as in a header. A
     *   Report-Only policy is not passed. The page is then not asked. It is also what a browser without Trusted Types
     *   (Firefox, at the version measured) reads the page's `require-trusted-types-for` and `trusted-types` from: with it,
     *   such a browser ends the build and refuses `execute()` as the others do, and without it nothing is applied there
     *   (docs/API.md#trusted-types-without-the-browser).
     * - `false` skips the narrowing and the read. The browser's own inheritance still narrows where the engine applies it.
     * - Left out, a build that lists a connect origin reads the policy before it starts, once per page load (cached):
     *   the element calls `fetch()` once from a hidden, empty frame to a decoy host that cannot exist, on a port every
     *   engine refuses; the request never leaves the browser and costs no DNS lookup, and the policy that refuses it
     *   reports its own text. Its cost is a console error (two in an engine that logs the refused port, whatever the
     *   policy) and, when a policy refuses the decoy, a CSP report to that policy's `report-uri`. The first such build waits
     *   for it, a few tens of milliseconds. A build with no connect origin never reads.
     *
     * @defaultValue read from the page
     */
    hostContentSecurityPolicy?: string | false;
    /**
     * Whether the guest's `sandboxFiles.write()` and `remove()` are recorded as pending changes of the environment,
     * announced as `fileswritten`, listed by `listGuestWrites()` and applied only by
     * `commitGuestWrites()`. Only a literal `true` enables it.
     *
     * @defaultValue `false`
     */
    guestWrites?: boolean;
    /**
     * The per-second budget of the calls the guest makes, per environment and in every mode. A call past it is refused
     * with `BUSY` by the guest's `bridge` before sending, and by the element if it arrives anyway. A field left out takes
     * its default; one that is not a finite number of at least 1 takes it with one warning. There is no way to turn
     * the budget off.
     *
     * @defaultValue `{ maxPerSecond: 1000, maxBytesPerSecond: 67108864 }`
     */
    callLimits?: CallLimits;
}

/** The per-second budget of the calls the guest makes ({@link SandboxConfigOptions.callLimits}). */
export interface CallLimits {
    /**
     * Most calls in any one-second window (a sliding window).
     *
     * @defaultValue `1000`
     */
    maxPerSecond?: number;
    /**
     * Most bytes of calls in any one-second window, each call's whole message measured as `call()`
     * measures it. A value below `RPC_MAX_BYTES` (33 MiB) also caps one call: a heavier call is refused with
     * `ARGS_NOT_TRANSFERABLE`, with one warning at `setConfig()`.
     *
     * @defaultValue `67108864` (64 MiB)
     */
    maxBytesPerSecond?: number;
}

/**
 * Where the element is in its lifecycle; read it from `state`.
 *
 * - `'idle'`: constructed, or removed from the document. There is no frame.
 * - `'loading'`: a frame was built and the guest has not checked in (without a bootstrap, the frame has not loaded).
 * - `'ready'`: the guest checked in and `ready` was dispatched. In cooperative mode the guest document may still be
 *   loading; its calls and `execute()` wait until it is parsed.
 * - `'terminated'`: torn down by `terminate()`, a budget (`watchdogTimeout`, `workerExecutionTimeout`),
 *   a frame check, or a build that failed. It stays so until `reset()`, `load()` or
 *   `setConfig()` builds a new environment.
 *
 * @remarks
 * There is deliberately no `'running'` state: nothing the guest reports could make it truthful. Lifecycle
 * reference: docs/API.md#lifecycle and ADR-003.
 */
export type SandboxState = 'idle' | 'loading' | 'ready' | 'terminated';

// The configuration as the element keeps it, its modes and their refusal: src/lib/config-schema.ts (the config schema,
// backlog S67), which declares every option once. Every option left out takes its default there, not its previous value.

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
    // the one import map (module graph): every registered JavaScript file, plus the guest's own
    // inline maps merged (import-map.ts), or null when no JavaScript file is registered
    importMap: { paths: string[]; guest: string | null } | null;
}

const NO_MARKUP_PLAN: GuestMarkupPlan = { parts: null, importMap: null };

// The sandbox flags of strict mode's view, always: scripts for its bootstrap, and forms so that `submit` reaches it, to be
// forwarded to the worker's handlers and cancelled (research 15, P4: without allow-forms Chromium and Firefox dispatch no
// submit). allow-forms is an unsafe capability in cooperative and worker mode (R1:R2-2: a modifier-click
// submission opens a new tab past form-action in Chromium), not here: no guest script runs in the view to synthesize a
// click, the view cancels every submit, and its forms keep no action, formaction, method or target (ADR-005). So the
// owner's move of allow-forms leaves strict mode as it was.
// (STRICT_VIEW_FLAGS, declared with the config schema, which keeps them in `capabilities` there.)

const STRICT_HTML_SCRIPT_WARNING = "[Sandbox] strict mode (the default) runs no script in `html`; name a registered file in `entry`, or choose `mode: 'cooperative'`.";

// Every reason the element gives, and every line it dispatches itself, is the texts registry's (src/lib/reasons.ts).
// What worker mode's frame may announce instead of a port (worker-bootstrap.ts), and the reason each ends the build with.
const WORKER_FRAME_REFUSALS: Readonly<Record<string, string>> = Object.freeze(Object.assign(Object.create(null), {
    'worker': reasonText('workerRefused'),
    'trusted-types': reasonText('trustedTypes'),
    'failed': reasonText('buildFailed', 'Error'),
}));

// The reason each environment check ends the build with (environment-check.ts, S74): the element's own table, by the
// check's id; what a bootstrap posts names a row, never a text.
const ENVIRONMENT_REFUSALS: Readonly<Record<string, string>> = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(
    Object.entries(ENVIRONMENT_CHECKS).map(([id, row]) => [id, reasonText(row.reason)]),
)));

// Plain data, compared as data (R1:R3-7): the same primitives, arrays and plain objects, key by key. Anything else (a
// Date, a Map, a typed array) never compares equal, so a config holding one always rebuilds.
// Each pair of objects is compared once (R2:C-7): a config is a structured clone, which keeps shared references, and
// walking a shared object once per path to it would be exponential in the nesting. A pair already compared, or being compared, adds nothing:
// were it different, the comparison already in progress or done answers so. At most SAME_DATA_MAX_PAIRS pairs are
// compared; past that, and past a depth of 64, the configs count as different, which only costs a rebuild.
export const SAME_DATA_MAX_PAIRS = 10000;
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

// The first statement after the globals allowlist in worker mode's worker unless scriptUnsafe (R1:R2-5). Stringified.
function removeWebAssembly(g: { WebAssembly?: unknown }) {
    if (!('WebAssembly' in g)) return;
    delete g.WebAssembly;
    if ('WebAssembly' in g) throw new Error('[Sandbox] the worker could not remove WebAssembly');
}

// What a reason or a host line says about an error the element caught (FR:F3): a fixed
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

// The first statement of every guest worker's source, worker mode and strict mode (VR:V1): the worker keeps only the allowlisted globals (worker-globals.ts) before any other script of the
// library or the guest runs there, so every request guest code can make goes through an API the policy governs on
// every engine. `global` is the expression for the global object in that source.
// The call is an expression whose value is the worker's postMessage, which it deleted (worker-globals.ts); strict mode
// runs it as a statement and keeps nothing of it.
// Strict mode's worker keeps STRICT_WORKER_GLOBALS: no importScripts, which its policy never lets load anything (S74).
const workerGlobalsCall = (global: string, globals: readonly string[] = WORKER_GLOBALS) =>
    `(${keepOnlyWorkerGlobals.toString()})(${global}, ${toInlineScriptLiteral(globals)}, ${toInlineScriptLiteral(WORKER_NAVIGATOR_MEMBERS)})`;
const workerGlobalsStatement = (global: string) => `${workerGlobalsCall(global, STRICT_WORKER_GLOBALS)};`;

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
// length the view cuts the text to (R4:M-4): cutting first and prefixing "Uncaught " after would overrun that length
// in Firefox and WebKit, whose messages carry no prefix of their own.
const viewErrorLine = (message: unknown) => uncaughtLine(typeof message === 'string' ? message : '').slice(0, VIEW_OPTIONS.guestText.maxLength);


/**
 * How long, in ms, the guest's event loop may still be busy at an `execute()` deadline (`workerExecutionTimeout`): the
 * element pings the guest there, and a guest that has not answered within this time ends the sandbox. Only a free event
 * loop can answer. Counted in host ticks, so a stall of the host page never counts (FR:F2).
 */
export const EXECUTION_TIMEOUT_GRACE_MS = 1000;

/**
 * How long, in ms, strict mode's view may go without answering before the sandbox terminates (ADR-005). Always on,
 * independent of `watchdogTimeout`. Counted in host ticks, so a stall of the host page never counts (watchdog.ts).
 */
export const VIEW_LIVENESS_TIMEOUT_MS = 5000;

/**
 * How long, in ms, a build may stay `loading` before the sandbox terminates; the reason names the host page's policy
 * when the frame loaded and its startup script never checked in (BR:CB3). Counted in host ticks, so a stall of the host
 * page never counts.
 *
 * @remarks
 * It bounds the wait for the guest's check-in, which comes before the guest's own subresources and scripts: a guest
 * page with slow images, or one that never finishes its document, is `ready`. Where no bootstrap runs (no
 * `allow-scripts`) it bounds the wait for the frame's one load, and the guest's subresources count. The value is
 * {@link VIEW_LIVENESS_TIMEOUT_MS}.
 */
export const LOAD_TIMEOUT_MS = VIEW_LIVENESS_TIMEOUT_MS;

// The features literal a bootstrap is given (in-sandbox-script.ts): the opt-in ones only when on, the call budget
// always, the listeners of its rows in the egress table (egress.ts), and in worker and strict mode the budget of uncaught
// errors and rejections.
interface BootstrapFeatures {
    autoResize?: true;
    fetchBridge?: { timeoutMs: number };
    externalPort?: true;
    guestWrites?: true;
    callBudget: CallBudget;
    listeners: BootstrapListener[];
    uncaught?: { count: number; characters: number };
    connect: string[];
}

// What the host posts to a strict view with its two ports (INIT_VIEW).
interface StrictInit {
    workerSource: string;
    // The build's marker (entryDoneName): the worker's source ends the entry with its error, which tells the view the
    // entry ran to its end, in the order of the Worker object's errors (backlog S75; in-sandbox-view.ts).
    entryDone: string;
    viewFiles: FileSnapshotEntry[];
    html: string;
    autoResize: boolean;
    allowAnimations: boolean;
    allowAutoplay: boolean;
    // The origins the view's policy admits for the loads its markup makes, by kind key (R4:M-2): the
    // renderer drops an http(s) URL outside them, so the browser never processes a refusal.
    origins: { images: readonly string[]; media: readonly string[] };
}

// What the element extends: HTMLElement where there is a DOM. Importing the package must not need one (R2:C-8):
// an embedder reads viewScriptHash() in a build step, in Node or Bun, and the class declaration is the only thing
// evaluated at import that names a DOM interface. Without a DOM the class extends an empty one, which nothing constructs.
// It is private to this module and typed `typeof HTMLElement`, so the declarations name HTMLElement instead
// (scripts/declaration-base.ts rewrites dist/host.d.ts): the public type is the same, and no stand-in is a public name.
const ElementBase: typeof HTMLElement = typeof HTMLElement === 'function' ? HTMLElement : (class {} as unknown as typeof HTMLElement);

/**
 * The `<web-sandbox>` custom element: one sandboxed environment for untrusted web content, rebuilt by
 * `setConfig()`, `load()` and `reset()`. Register it with
 * {@link defineWebSandbox}.
 *
 * @remarks
 * The element has no observed attributes and one property, `state`; everything else is set through its
 * methods. It builds an environment only while it is in the document of the window that defined it: moved into another
 * document it tears its environment down and stays `'idle'` there, with one warning. Its events are listed in
 * {@link WebSandboxEventMap}. Reference: docs/API.md.
 */
export class WebSandbox extends ElementBase {
    // The per-environment resources (this and the fields below named in EnvironmentFields) are declared in
    // src/lib/environment.ts, which releases them: _teardown detaches them all before it releases any (LM-2; S74).
    private _iframe: EnvironmentFields['_iframe'] = null;
    // The reversed handshake (BR:CB1): the listener on the host's window, removed by _teardown
    // (cooperative and worker mode). Whether this build's guest announces, whether the wrapper loaded and the window
    // whose announcement was accepted are the build's progress in the reducer (`_lc.build`; S65).
    private _stopListening: EnvironmentFields['_stopListening'] = null;
    private _loadDeadline: EnvironmentFields['_loadDeadline'] = null; // LOAD_TIMEOUT_MS until the guest checks in, or a frame with no bootstrap loads (BR:CB3, S46)
    // The lifecycle's state (src/lib/lifecycle.ts, LcState; backlog S65): `state`, the environment count (`gen`: every
    // teardown increments it), a build's 'terminated' waiting for its task (`pending`, R1:R3-2), the 'terminated' reasons
    // being dispatched (`dispatching`, R4:L-3), the one being dispatched when the last build started (`within`,
    // R2:L-4: BR:CB5's no-repeat rule), the standing build's progress, how often what a build reads changed (setConfig(),
    // load(), the files: `inputs`, R1:R3-7) and the refusal of the last setConfig() argument (`refused`). One value. The
    // executor's `step` (module level, below) writes it, and nothing else does.
    private _lc: LcState = INITIAL_LIFECYCLE;
    private _watchdog: EnvironmentFields['_watchdog'] = null;
    private _resizer: EnvironmentFields['_resizer'] = null; // this environment's auto-sizing (BL:B6), or null when off
    private _autoHeight: string | null = null;   // the inline height auto-sizing last wrote on the element
    private _fetchPolicy: FetchPolicy | null = null; // the validated fetchBridge config, or null when off (BL:B5)
    private _origins: OriginPolicy = NO_ORIGINS; // the parsed `origins` (ADR-007), what the guest policy admits
    private _warnedConfig = new Set<string>();   // the config schema's warnings (normaliseConfig), once each per instance
    private _fetchBridge: EnvironmentFields['_fetchBridge'] = null; // this environment's bridge: its requests end with it
    private _bridgeFrame: EnvironmentFields['_bridgeFrame'] = null; // the frame that makes this environment's bridge requests (BD1:ISO-1)
    private _warnedBridgeFrame = false;      // the bridge's frame did not start, said once per instance
    // The guest-write overlay (BL:C5): created by each build when guestWrites is on, else null. It outlives its
    // environment's termination (closed, still listable and committable) and is discarded by the next build and on
    // removal (_discardGuestWrites).
    private _guestWrites: GuestWrites | null = null;
    private _violationCounts = new Map<string, number>(); // 'violation' events dispatched per source for the current environment (capped, violation.ts)
    private _logLimiter = createLogLimiter(); // guest 'sandbox-log' events per second for the current environment (sandbox-log.ts)
    // The per-second budget of the guest's calls (R3:M-2): what the config gives (the config schema, callBudgetOf), and this
    // environment's windows, made again by every teardown.
    private _callBudget: Readonly<CallBudget> = DEFAULT_CALL_BUDGET;
    private _guestCalls: RateLimiter = createRateLimiter(DEFAULT_CALL_BUDGET.calls);
    private _guestCallBytes: RateLimiter = createRateLimiter(DEFAULT_CALL_BUDGET.bytes);
    private _warnedLogLimit = false;          // the log rate limit warned for the current environment
    private _ownLines = 0;                    // the guest relay's own lines dispatched for the current environment (LOG_OWN_LINES)
    private _warnedLogBytes = false;          // a guest line past LOG_MAX_BYTES warned for the current environment
    private _warnedViewTextDropped = false;   // the view's notice that it dropped guest error texts, for the current environment (R4:M-5)
    private _warnedViewOverrun = false;       // the view's first overrun of the current environment was said (S72)
    // The environment (its `_lc.gen`) of the host call being made now, while the broker copies its arguments and sends it
    // (_issue), or null outside one: _postRpc sends a call's frame only to the environment it was made in (R3:L-2).
    private _issuedIn: number | null = null;
    private _config: StoredConfig = defaultConfig();
    // The setConfig() argument being applied, as its structured clone or what refused cloning it: setConfig() holds it
    // for the executor's `applyConfig` effect (_configure), within its own call. Why the last argument could not be used
    // is the reducer's (`_lc.refused`): while set, every build is refused with it, as for an unknown mode.
    private _configuring: { copy: unknown; unusable: unknown } | null = null;
    private _port: EnvironmentFields['_port'] = null;     // the guest's port: the guest document's bootstrap, or the worker (logic port)
    private _viewPort: EnvironmentFields['_viewPort'] = null; // strict mode: the view's port (violations, resize, entry errors, liveness)
    private _viewWatchdog: EnvironmentFields['_viewWatchdog'] = null; // strict mode: the view liveness check (ADR-005)
    // Strict mode (R1:R4-4): guest writes posted to the view and not yet confirmed (VIEW_WRITTEN), by id; their guest is
    // answered on confirmation. Emptied by every teardown.
    private _viewWrites: EnvironmentFields['_viewWrites'] = new Map();
    private _viewWriteIds = 0;
    private _strictInit: StrictInit | null = null; // strict mode: what the next frame load hands the view
    private _executionTimers: EnvironmentFields['_executionTimers'] = new Set(); // workerExecutionTimeout deadlines of this environment
    // Liveness probes started at a deadline (FR:F2): each PING number they sent (negative, so never the watchdog's)
    // → that probe's end. A PONG to any of a probe's pings passes it.
    private _executionProbes: EnvironmentFields['_executionProbes'] = new Map();
    private _probePings = 0; // numbers the probes' pings: -1, -2, …
    // What waits for the port while loading, in the order it was issued (R2:L-3): execute() code and the host's own RPC
    // requests (cloned at call time), in one queue, so a call made before an execute() is sent before it.
    private _queue: ({ code: string } | { frame: unknown })[] = [];
    private _warnedGuestMarkup = new Set<string>(); // module-graph warnings about guest markup, once per text (_warnOnce)
    private _warnedStrict = new Set<string>(); // strict-mode warnings of a build (the view's stylesheet, html's scripts), once each per instance
    private _warnedForeignDocument = false; // inserted into a document of another realm (BR:CB7), once per instance
    private _warnedWrapperStyle = false;    // the host page's style-src refused the wrapper's style (R1:R3-1), once per instance
    // The copy of the last usable setConfig() argument (R1:R3-7), compared as data with the next one; whether nothing else a
    // build reads changed since is the reducer's (`_lc.lastInputs`, `_lc.inputs`).
    private _lastConfig: { copy: unknown } | null = null;
    private _heightBeforeAuto: string | null = null; // the embedder's inline height before auto-sizing first wrote one (R1:R3-8)
    private _exposedNames = new Set<string>(); // what expose() published, for the no-allow-scripts warning (R1:R3-4)

    // Files are part of the environment: they live on the element, survive reset(), load(), setConfig()
    // and terminate(), and every environment build takes a snapshot (_prepareBuild). See src/lib/files.ts.
    private _files = new FileStore();

    // One broker lives on the element for its whole life, so host-exposed methods persist across
    // frame recreation (the guest's broker is per-frame and resets with each new frame). Its send only
    // ever carries the host's own requests: it queues them until a port exists, then setupChannel
    // flushes them. Answers to the guest never use it — they go back on the port the request arrived on.
    // Results go back with their snapshot's ArrayBuffers transferred (R2:C-3: rpc.ts, sendResult).
    // A guest's request past its environment's per-second budget is answered BUSY (R3:M-2: _admitGuestCall).
    private _broker = createBroker((frame) => this._postRpc(frame), {
        sizeOf: createSizeOf(),
        transferResults: true,
        admitInbound: (bytes) => this._admitGuestCall(bytes),
    });

    constructor() {
        super();
        const root = this.attachShadow({ mode: "open" });
        // A block by default (R1:R4-12): a custom element is inline, and an inline element has no height to
        // fill. Through a constructed stylesheet, which no style-src governs (a <style> in the shadow root is subject to
        // the host page's policy); the embedder's own CSS for the element still wins over :host.
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(':host { display: block }');
            root.adoptedStyleSheets = [sheet];
        } catch {
            // an engine without constructed stylesheets: the embedder's CSS decides
        }
        // The fetch bridge (BL:B5) and guest writes (BL:C5) are library methods under reserved names: expose() can never
        // replace them. Each build registers both again, bound to that build's bridge and overlay
        // (_startFetchBridge, _startGuestWrites); until the first build, none: every request is refused.
        this._exposeFetch(null);
        this._exposeGuestWrites(null);
    }

    /**
     * Where the element is in its lifecycle ({@link SandboxState}). It already has the new value when `ready` or
     * `terminated` is dispatched.
     */
    get state(): SandboxState {
        return this._lc.state;
    }

    // The lifecycle callbacks call module-level functions (connected, disconnected, adopted below), never a method
    // looked up on the element (BR:CB7): Firefox gives an element adopted into another document that document's
    // HTMLElement prototype, so `this.initialize` and `this._teardown` are gone there; a method call would throw, and the
    // guest would keep running with nothing left that could end it.
    /**
     * Custom element reaction: the browser calls it when the element is inserted into a document. It builds an
     * environment from the current configuration (see `state`) where the element may build one;
     * nothing is dispatched synchronously.
     */
    connectedCallback() {
        connected(this);
    }

    // A frame outside the document cannot be used, and keeping its port, timers and watchdog alive would only let
    // pending calls hang. This is not a termination — no 'terminated' event — and re-inserting the element builds
    // a fresh environment through connectedCallback (which also makes moving the element a clean re-init).
    /**
     * Custom element reaction: the browser calls it when the element is removed from a document. The environment ends
     * and pending calls reject with `TERMINATED`. This is not a termination: no `terminated` event is dispatched, and
     * inserting the element again builds a fresh environment.
     */
    disconnectedCallback() {
        disconnected(this);
    }

    // connectedCallback then refuses to build in the other document (BR:CB7).
    /**
     * Custom element reaction: the browser calls it when the element is moved into another document
     * (`adoptNode()`, or appending it to an iframe's document). Its environment ends as for a removal and it stays
     * `'idle'` there, with one warning; moved back, it builds again.
     */
    adoptedCallback() {
        adopted(this);
    }

    /**
     * Removes the frame now, sets `state` to `'terminated'` and dispatches `terminated` with `{ reason }`. Pending calls
     * reject with `TERMINATED` and later calls are refused at once. The sandbox stays terminated until
     * `reset()`, `load()` or `setConfig()` builds a new environment.
     *
     * @remarks
     * Calling it while terminated does nothing, so `terminated` fires once per termination. The reason is also written to
     * the console as a warning.
     *
     * @param reason - Why, as the `terminated` event reports it; `'terminated by the host'` when left out. A value that
     * is not a string, or is empty or only white space, is replaced by that default.
     */
    terminate(reason: string = reasonText('host')): void {
        // a reason that says nothing (not a string, empty, only white space) is the default one (R2:L-7)
        // No generation: the embedder's own call ends whatever environment stands (src/lib/lifecycle.ts, `terminate`).
        step(this, { t: 'terminate', reason: typeof reason === 'string' && reason.trim() !== '' ? reason : reasonText('host') });
    }

    /**
     * Rebuilds the environment now, from any state (terminated included): a fresh frame with a fresh opaque origin, the
     * current configuration and a new snapshot of the files. Methods the guest exposed are gone, methods exposed with
     * `expose()` stay, and pending calls reject with `TERMINATED`. Wait for `ready` before relying on the
     * new environment. Outside the document it builds nothing until the element is inserted.
     */
    reset(): void {
        step(this, { t: 'build', why: 'reset', ctx: this._buildContext() });
    }

    /**
     * Replaces the configuration and rebuilds the environment now (while the element is in the document).
     *
     * @remarks
     * - The configuration is applied over the defaults, not over the previous one: an option left out returns to its
     *   default, `html` included, so a `setConfig()` after `load()` starts with an empty document unless
     *   it passes `html` again.
     * - The argument is copied (structured clone) before anything reads it; changing your objects afterwards changes
     *   nothing, not even at the next `reset()`.
     * - Values that cannot be used (an entry that is not allowed, a list option that is not a list, an `html` that is not
     *   a string) are dropped with one `console.warn` per element and message, and never applied half-way.
     * - The configuration the environment already stands on, set again, changes nothing: no rebuild and no event, so read
     *   `state` rather than wait for `ready`. Anything a build reads that changed since (`load()`, the files) rebuilds as
     *   usual.
     * - A config that cannot be used at all (not an object, not cloneable such as a `Proxy` or a function value, an
     *   `origins` that is not an object or has a kind that is not a list) applies nothing and the previous config stays: the
     *   sandbox terminates, and stays terminated until a usable config is set. A build that fails terminates it too.
     * - It never throws. `state` is `'terminated'` when it returns after a refusal; the `terminated` event of a refused
     *   build comes in a task of its own, like `ready`, and not at all if another build started meanwhile.
     *
     * @param config - The new configuration; see {@link SandboxConfig}.
     */
    setConfig(config: SandboxConfig) {
        // A config the element cannot use is a termination with a reason, never a throw that leaves the old
        // environment torn down and no new one built (S26): the reducer refuses every build
        // while its refusal stands (`_lc.refused`), as it does for an unknown mode (AR:A4), until a usable config
        // arrives. Nothing of a refused config is applied.
        //
        // One structured clone of the whole argument before anything reads it: every check, and every later build,
        // reads this copy, never the caller's objects. So an array the caller changes after setConfig() never changes
        // the policy a later reset() builds, and a getter or a Proxy cannot answer two reads differently (AR:A6).
        // What cannot be cloned (a Proxy, a function, a DOM node) throws here, and refuses the config.
        let copy: unknown;
        let unusable: unknown = null;
        try {
            copy = structuredClone(config);
        } catch (error) {
            unusable = error;
        }
        // The configuration the environment was built from, again, while that environment stands (R1:R3-7):
        // nothing to change, so nothing is rebuilt (an embedder that applies its config on every edit, as the
        // playground does, keeps its guest). Anything a build reads changed since (load(), the files) builds as usual.
        // The comparison of the data is the host's (`same`); the rest of the no-op rule is the reducer's (`setConfig`),
        // and decides it before anything of the argument is applied. Otherwise the executor applies the copy
        // (`applyConfig`: _configure), then builds from it.
        const same = unusable === null && this._lastConfig !== null && sameData(copy, this._lastConfig.copy);
        this._configuring = { copy, unusable };
        try {
            step(this, { t: 'setConfig', same });
        } finally {
            this._configuring = null;
        }
    }

    // The executor's `applyConfig` effect: the argument setConfig() holds, applied (_applyConfig), and its refusal, or null.
    // The reducer stores the refusal and starts the build from it (`configured`).
    private _configure(): string | null {
        const { copy, unusable } = this._configuring!;
        try {
            if (unusable !== null) throw unusable;
            this._applyConfig(copy);
            this._lastConfig = { copy };
            return null;
        } catch (error) {
            this._lastConfig = null;
            // an `origins` of the wrong type names the option, in a fixed text of the library's (BD3:NEW-3)
            return reasonText('configRefused', error instanceof OriginsTypeError ? `${errorName(error)}: ${ORIGINS_REFUSAL_TEXT[error.option]}` : errorName(error));
        }
    }

    // Stores one setConfig() argument, already copied (setConfig), as the config schema normalised it
    // (src/lib/config-schema.ts, normaliseConfig: every option's rule and the cross-field ones, decided there once).
    // Throws what refused a config that cannot be used; then nothing is stored. Its warnings are said first, once per
    // element and message (the same config is set again and again: the playground applies it on every edit), those of
    // a refused config too, up to what refused it; only a config that passed every check is stored, last (FR:F6).
    private _applyConfig(copy: unknown) {
        const { value, warnings, refusal } = normaliseConfig(copy, { hostOrigin: globalThis.location?.origin ?? "", hostSite: () => hostRegistrableDomain() });
        for (const message of warnings) this._warnConfig(message);
        if (value === null) throw refusal;
        this._config = value.config;
        this._fetchPolicy = value.fetchPolicy;
        this._origins = value.origins;
        this._callBudget = value.callBudget;
    }

    // A warning of the config schema: once per element and message.
    private _warnConfig(message: string) {
        if (this._warnedConfig.has(message)) return;
        this._warnedConfig.add(message);
        console.warn(message);
    }

    /**
     * Adds or replaces files in the element's store. The guest sees them from the next environment build on
     * (`reset()`, `load()` or `setConfig()`), never in a guest already
     * running. Files survive every rebuild and `terminate()`.
     *
     * @remarks
     * - The whole batch is validated first. It fires `fileschanged` when something changed; registering identical content
     *   again changes nothing.
     * - A path is relative (`src/main.js`): segments of letters, digits and the characters of `._~!$&'()*+,;=@-`,
     *   separated by single slashes, at most 256 characters, no `.` or `..` segment. Paths are checked, never normalised.
     * - A file's type comes from its extension (`.js` and `.mjs` `text/javascript`, `.css` `text/css`, `.json`
     *   `application/json`, `.svg` `image/svg+xml`, `.png`, `.woff2`, `.mp4` and the like); an unknown extension is
     *   `application/octet-stream`.
     * - A reference names a file only for the kind of load its type is for: `<script src>`, `modulepreload`,
     *   `preload as=script` and module imports only JavaScript types; a stylesheet `<link>`, `preload as=style` and
     *   `@import` only `text/css`; `img`, `srcset`, `poster`, icon links and CSS `url()` only `image/*`; `url()` in
     *   `@font-face` and `preload as=font` only `font/*`; `audio`, `video` and `source` only `audio/*` and `video/*`;
     *   `track` only `text/vtt`. A reference to a file of another type stays as written and fails closed, with one
     *   warning. This holds for registered files as for committed ones: `x.js` registered as `text/plain` is never a
     *   script. Code that passes `sandboxFiles.url()` to a script element or `importScripts()` itself decides what it
     *   loads (Chromium runs such a file whatever its type; Firefox and WebKit refuse it in `importScripts()`).
     * - How the guest names files (markup, module imports, stylesheets) is described in the README's Files section; why:
     *   ADR-004.
     *
     * @param files - The files by path. An entry is a `string` (stored as UTF-8), a `Uint8Array` (copied), or
     * `{ content, type }` to set the MIME type instead of deriving it from the extension.
     * @throws A {@link FileError} with `code` `INVALID_PATH`, `INVALID_FILE` or `FILES_QUOTA_EXCEEDED`. The whole batch is
     * validated first, so a refusal changes nothing.
     */
    registerFiles(files: Record<string, FileEntry>): void {
        this._dispatchFilesChanged(this._files.register(files));
    }

    /**
     * Removes files from the store. Like `registerFiles()`, it takes effect at the next environment
     * build. Fires `fileschanged` when something was removed.
     *
     * @param paths - The paths to remove; every file when left out. A path that is not registered is ignored.
     * @throws A {@link FileError} with `code` `INVALID_PATH` for an invalid path (or `paths` that is not an array); nothing
     * is removed then.
     */
    unregisterFiles(paths?: string[]): void {
        this._dispatchFilesChanged(this._files.unregister(paths));
    }

    /**
     * The registered files, sorted by path.
     *
     * @returns One {@link FileInfo} per file: its path, its MIME type and its size in bytes as registered.
     */
    listFiles(): FileInfo[] {
        return this._files.list();
    }

    /**
     * The guest's pending writes and removals (see `guestWrites` and docs/API.md#guest-writes), sorted by path. They belong
     * to the current environment and survive its termination; the next build and the element's removal discard them.
     *
     * @returns One {@link GuestWrite} per path with a pending change, each a fresh object: `{ path, change: 'write', type, size, content }`
     * (`type` as the files would give it, `content` a copy of the bytes) or `{ path, change: 'remove' }`. Empty while
     * `guestWrites` is off.
     */
    listGuestWrites(): GuestWrite[] {
        return this._guestWrites?.list() ?? [];
    }

    /**
     * Applies the guest's pending changes at `paths` to the files, atomically, as one `registerFiles()` or
     * `unregisterFiles()` would, and removes them from the pending list. The guest sees committed files
     * from the next build on. Fires `fileschanged` when the files changed.
     *
     * @remarks
     * - A write whose type is not inert is refused with `FILES_NOT_ALLOWED` unless `options.code` is `true`. Inert types
     *   are the images, fonts, audio and video a browser only decodes, plain text, JSON and CSS (the exact list is in
     *   `INERT_TYPES`, src/lib/guest-writes.ts). JavaScript, HTML, SVG, XML, WebAssembly, unknown types and any other type
     *   the guest set can run or be parsed as code. The type checked is the one the file will be loaded as, never just its
     *   name.
     * - All checks come first, the quota included (with what module and stylesheet rewrites add, against the files as they
     *   are now), so a refusal changes neither the files nor the pending list.
     * - A committed file loads only as what its type is for (see `registerFiles()`): an inert file never runs as a script.
     *   Committed `text/css` is inert but still CSS: markup of the next build that links it is styled by it.
     *
     * @param paths - The paths to commit; required, since there is no "commit everything". A path with no pending change
     * is skipped.
     * @param options - `code: true` allows the writes whose type is not inert.
     * @throws A {@link FileError} with `code` `INVALID_PATH`, `FILES_NOT_ALLOWED` or `FILES_QUOTA_EXCEEDED`.
     */
    commitGuestWrites(paths: string[], options?: { code?: boolean }): void {
        const { paths: checked, code } = parseCommitArguments(paths, options);
        if (!this._guestWrites) return;
        this._dispatchFilesChanged(this._guestWrites.commit(checked, code));
    }

    // Synchronous, once per call that changed something.
    private _dispatchFilesChanged(paths: string[]) {
        if (paths.length === 0) return;
        step(this, { t: 'filesChanged' }); // what a build reads changed (R1:R3-7: the same config again rebuilds now)
        this.dispatchEvent(elementEvent('fileschanged', { paths }));
    }

    // One overlay per environment (BL:C5), made with the build like the fetch bridge, and the reserved method bound to
    // it. The method is registered again here, not once: the broker looks a method up when a request ARRIVES
    // (handleRequest, rpc.ts), and only the current port's frames arrive (_onGuestMessage, AR:B4), so a request is
    // always handled by the overlay of the environment that sent it, even if it runs after a listener rebuilt the
    // sandbox. Never the next environment's.
    // `built` is the copy of the store this build delivers (_prepareBuild): the overlay answers the guest from it, so
    // nothing registered after the build shows through a write's answer or its quota (BR:CB4).
    private _startGuestWrites(built: FileStore) {
        this._guestWrites = this._config.guestWrites === true ? createGuestWrites({ store: this._files, built }) : null;
        this._exposeGuestWrites(this._guestWrites);
    }

    private _exposeGuestWrites(writes: GuestWrites | null) {
        this._broker.exposeReserved(WRITE_METHOD, (request: unknown) => this._handleGuestWrite(writes, request));
    }

    // The next build, or the element's removal, ends what the last environment wrote and did not commit.
    // Only own fields and module functions: the lifecycle path runs it on an element whose prototype may be gone (BR:CB7).
    private _discardGuestWrites() {
        this._guestWrites?.close();
        this._guestWrites = null;
        this._broker.exposeReserved(WRITE_METHOD, refuseGuestWrite);
    }

    // The reserved sandbox:write method. Every refusal is a FileError with a library code (guest-writes.ts); with
    // writes off, FILES_NOT_ALLOWED: the guarantee, whatever the guest's own sandboxFiles does first. A recorded
    // change is announced last, through the lifecycle executor's runNotices (AR:B5): 'fileswritten' runs embedder listeners,
    // and the guest is told its change stands only if no listener reset or terminated the sandbox meanwhile (then the
    // overlay that held it is gone or closed, and the answer could only reach a closed port anyway).
    // In strict mode the change goes to the view as well (R1:R4-4), and the guest is answered once the view has it.
    // What is announced and what the view is told are both projections of the one diff the overlay reports for the
    // request (guest-writes.ts, record; R5:N-4, R5:L-4): 'fileswritten' exactly when the entry
    // listGuestWrites() shows at the path changed, and the view exactly when what the guest sees there changed. A removal
    // of a file the host unregistered after the build changes nothing listed and is announced nowhere, but the guest does
    // not see the file, so the view must not show it either (R5:N-4: the old blob: URL would stay).
    private _handleGuestWrite(writes: GuestWrites | null, request: unknown): Promise<GuestWriteAnswer> {
        if (!writes) return refuseGuestWrite();
        let recorded: ReturnType<GuestWrites['record']>;
        try {
            recorded = writes.record(request);
        } catch (error) {
            return Promise.reject(error);
        }
        const { answer, diff } = recorded;
        // What the view is told, taken now: a 'fileswritten' listener may commit the change and empty its place.
        const shown = diff.view && this._viewPort ? viewWriteOf(answer.path, diff.shown) : null;
        if (!diff.listed) return new Promise((resolve, reject) => this._showInView(shown, () => resolve(answer), reject));
        return new Promise((resolve, reject) => {
            const acted = runNotices(lifecycleHost(this), [() => this._dispatchFilesWritten(answer.path)], () => this._showInView(shown, () => resolve(answer), reject));
            if (!acted) reject(new Error('[Sandbox] the sandbox was reset or terminated while this write was announced.'));
        });
    }

    // Strict mode (R1:R4-4): one recorded guest change to the view, which mints a URL for a raster image from these bytes
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
        this.dispatchEvent(elementEvent('fileswritten', { paths: [path] }));
    }

    /**
     * Sets `html` (the guest document, or the initial view in strict mode), keeps the rest of the configuration and
     * rebuilds the environment now (while the element is in the document). Worker mode ignores the markup but still
     * rebuilds.
     *
     * @param html - The markup, as for the `html` option of {@link SandboxConfigOptions}.
     */
    load(html: string) {
        this._config.html = html;
        step(this, { t: 'build', why: 'load', ctx: this._buildContext() }); // the reducer counts the change of `html`
    }

    /**
     * Runs `code` in the guest's global scope as the body of a function: in the guest document in cooperative mode, in
     * the worker in worker and strict mode. It is compiled with the `Function` the bootstrap captured before any guest
     * code ran. Nothing reaches the host: no return value and no report that it returned.
     *
     * @remarks
     * - Needs `scriptUnsafe: true` and a string; otherwise it warns and does nothing.
     * - While the element is `'idle'` (not in the document) or `'terminated'` there is no environment: it warns and does
     *   nothing, where `call()` rejects.
     * - While `'loading'` the code is queued and sent when the build becomes `ready`. In cooperative mode it runs once the
     *   guest document is parsed (see docs/API.md#ready-and-the-startup-gate), in order with calls.
     * - A synchronous throw becomes a `sandbox-log` line (`level: 'error'`, `source: 'guest'`).
     * - In worker and strict mode each call has its own `workerExecutionTimeout` deadline. What it bounds is precise:
     *   the guest's event loop is free at the deadline. The element pings the guest there; the bootstrap answers from a
     *   handler guest code cannot reach, and only a free event loop can run it. No answer within
     *   {@link EXECUTION_TIMEOUT_GRACE_MS} terminates the sandbox.
     * - Code that is still running at the deadline, or that returned but left work running then (a loop in a
     *   `setTimeout`), is terminated. Code that ran to its end and left the loop free stays ready, whatever it scheduled
     *   for later.
     * - Several calls each have their own deadline, and every deadline checks the one event loop: a loop started by any
     *   code ends the sandbox at the first deadline it blocks.
     * - A loop that starts after the last deadline is not bounded by it: `watchdogTimeout` checks the event loop
     *   continuously and covers that case.
     *
     * @param code - The function body to run.
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
        // One rule for work handed to the guest (BL:B8): it belongs to an environment, and while idle or
        // terminated there is none. execute() warns and does nothing; call() rejects at once with TERMINATED.
        // (Code queued while idle would be dropped silently by the build on insertion.)
        if (this._lc.state === 'terminated' || this._lc.state === 'idle') {
            console.warn(`[Sandbox] execute() ignored: the sandbox ${this._lc.state === 'idle' ? 'is not in the document' : 'was terminated'}. Call it once the element is in the document and not terminated (reset(), setConfig() or load() start a new environment).`);
            return;
        }

        // Before `ready` it waits, even with a port (strict mode has one from the wrapper's load): the `flush` effect posts it.
        if (this._port && this._lc.state === 'ready') {
            this._postExecute(this._port, code);
        } else {
            this._queue.push({ code });
        }
    }

    // One EXECUTE frame, with its budget armed first.
    private _postExecute(port: MessagePort, code: string) {
        // where the browser has no Trusted Types: the page requires them for scripts, so a string is not evaluated (as the guest's own sink refuses it where it has them)
        const trustedTypes = this._trustedTypes();
        if (trustedTypes && executeRefused(trustedTypes)) {
            console.warn("[Sandbox] execute() refused: the host page requires Trusted Types for scripts (require-trusted-types-for 'script'), so a string is not evaluated (docs/API.md#host-page-policy).");
            return;
        }
        this._armExecutionBudget();
        port.postMessage({ type: 'EXECUTE', code });
    }

    /**
     * Publishes a host method the guest calls with `bridge.call(name, ...args)`. The guest receives the handler's return
     * value (awaited if it is a promise). A throw or rejection reaches the guest as `HANDLER_ERROR` with the error's
     * message, verbatim up to 65536 characters (a longer one is cut, and ends `[… cut at 65536 characters]`): throw errors
     * whose message you would show the guest, or wrap the handler.
     *
     * @remarks
     * Methods belong to the element: they survive `reset()`, `load()`,
     * `setConfig()` and `terminate()`. Exposing a name again replaces its handler. Names that
     * start with `sandbox:` are reserved for the library and refused with a warning. The arguments are the guest's data:
     * validate them, and copy objects with spread rather than `Object.assign` or a `for...in` loop (an own `__proto__` key
     * survives the copy). Guest-controlled text: show it with `textContent`, never in an HTML, URL (such as a link `href`),
     * `eval` or template sink.
     *
     * @param name - The method name, a string of at most 256 characters.
     * @param fn - The handler; its arguments come from the guest by structured clone.
     * @throws A `TypeError` if `name` is not a string or is longer than 256 characters, or `fn` is not a function.
     */
    expose(name: string, fn: (...args: any[]) => unknown): void {
        // A name that is not a string, or a handler that is not a function, is a mistake to say at once (R1:R3-9): ignored,
        // it would fail the guest's call with UNKNOWN_METHOD far from the cause.
        if (typeof name !== 'string') throw new TypeError('[Sandbox] expose(): the name must be a string');
        // the broker's longest method name (rpc.ts, R3:C-1): a longer one could never be called
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
     * Calls a method the guest exposed with `bridge.expose()` and resolves with its result. It works without
     * `scriptUnsafe`: it never evaluates code.
     *
     * @remarks
     * - Arguments and results are copied by structured clone, at most `RPC_MAX_BYTES` (33 MiB) per message, counted on
     *   both sides on the copy that is sent: past it a call is refused before anything is sent (`ARGS_NOT_TRANSFERABLE`)
     *   and a result is answered `RESULT_NOT_TRANSFERABLE`. The measure knows primitives, plain objects and arrays, `Map`,
     *   `Set`, `Date`, `RegExp`, `ArrayBuffer`, typed arrays and `DataView`, `Blob` and `File`, and `String`, `Number`,
     *   `Boolean` and `BigInt` objects. Any other value (an `Error`, an `ImageData` or another platform object, a
     *   `SharedArrayBuffer`) is refused the same way, with a message that names the value rather than the budget; send what
     *   you need of it instead: an error's `{ name, message, stack }`, an image's `data`, `width` and `height`. The whole
     *   message is counted, the method name included, and a name is at most 256 characters (`INVALID_CALL`).
     * - The default timeout is 30 s (`TIMEOUT`). The element's timers and its copy of the arguments use the `setTimeout` and
     *   `structuredClone` it took when it was constructed: fake timers installed after that (a test's) do not control a
     *   call's timeout.
     * - Calls made while `'loading'` are queued and sent when the build becomes `ready`, in every mode (strict mode
     *   included, whose view has its ports before it checks in); one that settles while queued (its timeout) leaves the queue
     *   and never runs. In cooperative mode a call reaches the guest's method once the guest document is parsed (see
     *   docs/API.md#ready-and-the-startup-gate).
     * - Calls made while `'idle'` (not in the document) or `'terminated'` reject at once with `TERMINATED`, as
     *   `execute()` does nothing then; so do pending ones when the environment goes away.
     *
     * @typeParam T - The type of the result, which the caller asserts: the guest's value is not checked against it.
     * @param method - The name the guest exposed.
     * @param args - The arguments, copied by structured clone.
     * @returns The guest method's return value (awaited if it is a promise).
     * @throws Never synchronously: the promise rejects with an {@link RpcError}, an `Error` whose `code` is an
     * {@link RpcErrorCode}. `UNKNOWN_METHOD`, `HANDLER_ERROR` and `RESULT_NOT_TRANSFERABLE` are reported by the guest and
     * their message is the guest's text.
     */
    call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        const refusal = this._noEnvironmentError();
        if (refusal) return Promise.reject(refusal);
        return this._issue(() => this._broker.call(method, ...args)) as Promise<T>;
    }

    /**
     * Like `call()`, with a timeout of your own for this one call. Every other timeout is waited out in
     * full, however long: `watchdogTimeout` and `workerExecutionTimeout` do not shorten it.
     *
     * @typeParam T - The type of the result, which the caller asserts.
     * @param timeoutMs - The timeout in ms. `0`, any value that is not above 0, and `Infinity` disable it.
     * @param method - The name the guest exposed.
     * @param args - The arguments, copied by structured clone.
     * @returns The guest method's return value (awaited if it is a promise).
     * @throws Never synchronously: the promise rejects as `call()`'s does.
     */
    callWithTimeout<T = unknown>(timeoutMs: number, method: string, ...args: unknown[]): Promise<T> {
        const refusal = this._noEnvironmentError();
        if (refusal) return Promise.reject(refusal);
        return this._issue(() => this._broker.callWithTimeout(timeoutMs, method, ...args)) as Promise<T>;
    }

    // One host call, made in the current environment (R3:L-2). The broker copies the arguments with
    // structuredClone before it sends them, and a getter among them runs then: one that calls terminate(), remove() or
    // reset() ends the environment before the frame is sent, and _postRpc would queue it for an environment that is gone
    // (after terminate() or remove(): never sent, never settled), or send it to the next one. So the call carries
    // the environment it was made in, nested calls included, and _postRpc sends a frame only there: any other is refused
    // TERMINATED, at once (RpcSend in rpc.ts). Every call settles, whatever runs while its arguments are copied.
    private _issue(makeCall: () => Promise<unknown>): Promise<unknown> {
        const outer = this._issuedIn;
        this._issuedIn = this._lc.gen;
        try {
            return this._queuedWhilePending(makeCall);
        } finally {
            this._issuedIn = outer;
        }
    }

    // The queue holds only calls still waiting for their answer (BR:CB3). A call made while
    // loading waits in _queue for the port; if it settles there first (TIMEOUT), its request leaves the queue with
    // it. Left there, it would be sent at the next flush: the method would run after its caller had been told the call
    // timed out, and a caller that retried would run it twice. The broker posts a call's one request synchronously from
    // call(), so the frame queued during `makeCall` is this call's.
    private _queuedWhilePending(makeCall: () => Promise<unknown>): Promise<unknown> {
        const queue = this._queue;
        const queued = queue.length;
        const promise = makeCall();
        // sent at once, or refused before sending (a teardown meanwhile replaced the queue: R3:L-2, _issue)
        if (this._queue !== queue || queue.length === queued) return promise;
        const entry = queue[queue.length - 1];
        const drop = () => {
            const index = this._queue.indexOf(entry!);
            if (index >= 0) this._queue.splice(index, 1);
        };
        promise.then(drop, drop);
        return promise;
    }

    // The same rule as execute() (BL:B8): while idle or terminated there is no environment to call, so a call
    // is refused at once with TERMINATED. (Waiting for the element's insertion would end in the same TERMINATED, from
    // the build.)
    private _noEnvironmentError(): Error | null {
        if (this._lc.state === 'terminated') return this._broker.terminationError(TERMINATED_CALL_MESSAGE);
        if (this._lc.state === 'idle') return this._broker.terminationError(IDLE_CALL_MESSAGE);
        return null;
    }

    // Sends one of the host's own RPC requests over the port once the build is ready, or queues it until `ready` flushes
    // (mirrors execute(); R5:L-1: strict mode has its port from the wrapper's load, before `ready`).
    // Only for the environment the call was made in, while it stands (R3:L-2, _issue): otherwise nothing is sent, and the
    // text returned refuses the call TERMINATED.
    private _postRpc(frame: unknown): string | undefined {
        if (this._issuedIn !== this._lc.gen || this._lc.state === 'idle' || this._lc.state === 'terminated') return RESET_CALL_MESSAGE;
        if (this._port && this._lc.state === 'ready') {
            this._port.postMessage(frame);
            return;
        }
        this._queue.push({ frame });
    }

    // workerExecutionTimeout (FR:F2, ADR-003): what it bounds is "the guest's
    // event loop is free at the deadline". Each execute() arms a deadline `budget` ms after the host posts the code
    // (the only moment the host can see). At the deadline the host pings the guest through the bootstrap's own PING
    // handler, which guest code cannot reach (AR:B2), and only a free event loop can run it: no answer within
    // EXECUTION_TIMEOUT_GRACE_MS means the loop is still busy, and that ends the sandbox the way the watchdog does
    // (ADR-003: a guest over a budget is terminated; reset() is the embedder's choice).
    //
    // The guest reports nothing when the code returns, because no report of the guest's can be a bound: code that
    // returns at once but leaves a loop scheduled (setTimeout(() => { for (;;) {} })) would stop its own timer and then
    // loop, and guest code that replaced globalThis.Function would have the bootstrap's `new Function(code)` return a
    // function of its choosing, so a "done" report would come before the embedder's code had run at all (FR:F2). So
    // nothing the guest says ends a budget, only an answer from a free loop at the deadline, and the bootstrap compiles
    // with the Function it captured before guest code ran (in-sandbox-script.ts).
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
        const gen = this._lc.gen; // the environment the code was posted to: its timeout ends that one only
        const timer = setLongTimeout(() => {
            this._executionTimers.delete(timer);
            this._probeExecution(gen);
        }, budget); // any budget, 2^31 ms and past (R2:L-2: long-timer.ts)
        this._executionTimers.add(timer);
    }

    // The check at a deadline: a one-off watchdog over EXECUTION_TIMEOUT_GRACE_MS (watchdog.ts: pings each tick until
    // an answer, expires after a whole grace of silent ticks, so a host stall is never counted against the guest).
    // Its pings carry negative numbers of their own, so a PONG names the probe it answers and never the watchdog's.
    private _probeExecution(gen: Generation) {
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
                this._onExecutionTimeout(gen);
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

    // The deadline's probe went unanswered: one host line, then the termination, of the environment the code ran in.
    //
    // A termination the element starts that says something first carries its lines as `notices` (src/lib/lifecycle.ts,
    // Notice), and the executor dispatches them, one event each, then the termination as a nested step. A listener of a
    // line may reset() or terminate() the sandbox, and acting afterwards on the environment that is gone would undo what
    // the listener did (AR:B5); a second line of one callback, dispatched after a listener of the first had reset or
    // removed the element, would reach the next environment's listeners, or an idle element's (R4:L-2). So the
    // executor stops before the next line and before the step once the generation moved (lifecycle.ts, `runEffects`),
    // and the step itself carries `gen`, which `reduce` drops once it is stale. host.ts keeps no comparison of its own
    // for this (test/unit/lifecycle-reducer.test.ts scans for one), and a notice is data, so it dispatches exactly one
    // event by construction (the executor's `notice`, host.ts's `lifecycleHost`).
    private _onExecutionTimeout(gen: Generation) {
        step(this, { t: 'terminate', reason: reasonText('executionTimeout'), gen, notices: [hostNotice(hostLine('executionTimeout'))] });
    }

    // A frame of ours that the host page's policy refused, as it reported (R1:R3-1, R2:C-5, R2:C-6): one host
    // line, then the termination with the reason that names the policy (unless a listener of that line acted first), of
    // the environment `gen` whose frame said so.
    private _refusedByHostPage(reason: string, gen: Generation) {
        step(this, { t: 'terminate', reason, gen, notices: [hostNotice(hostLine('refusedByHostPage', reason))] });
    }

    // The guest's port, announced by the guest frame itself (BR:CB1), becomes this environment's port. Null when this
    // build's guest runs no bootstrap (no allow-scripts): there is nothing to talk to,
    // and calls wait in the queue until they time out.
    private setupChannel(port: MessagePort | null) {
        if (this._port) { this._port.close(); this._port = null; }
        if (!port) return;
        this._port = port;
        // One reply channel per port: answers go back where their request came from, and the broker counts the
        // calls it runs per channel (AR:B7), so the count belongs to this environment.
        const reply = (frame: unknown, transfer?: Transferable[]) => port.postMessage(frame, transfer ?? []);
        // Setting onmessage starts the port: frames the guest posted before its announcement was accepted are
        // delivered now, after 'ready'. What waits in the queue is posted by the `flush` effect, the one flush point.
        port.onmessage = (e) => this._onGuestMessage(port, reply, e.data, null);
    }

    /**
     * The reversed handshake (BR:CB1, ADR-002). The guest frame's bootstrap (iframe
     * mode) or the frame's worker bootstrap (worker mode) makes the channel itself and posts one end to this window
     * as its first statement; the other end never leaves the bootstrap's closure. This listener, installed before the
     * frame is inserted, accepts exactly one such announcement per environment: a trusted message from the guest
     * frame's own window (identity: the wrapper's frames[0]) carrying exactly one port. Every later announcement from
     * that window, or one this build does not expect, or a malformed one, ends the environment: a guest that reloads
     * itself (location.reload(), a `<meta refresh>` without a URL) or rewrites its document so a bootstrap runs again
     * announces again, and a guest that forges one can only end its own environment (BR:PD8). Messages from any other
     * window, and the guest's other messages, are not this listener's (they reach the embedder's own listeners).
     *
     * What the announcement is (from the guest frame's window, trusted, with exactly one port or worker mode's refusal)
     * is read here; what it does is the reducer's (`announced`): which one is accepted, and whether the build expects one,
     * are the build's progress there, and so is the window it came from, which the wrapper's load must still hold.
     *
     * The same listener hears the other portless message of the library's frames: a bootstrap's refusal of a document
     * that is not the one the library built (ENVIRONMENT_REFUSED, environment-check.ts; S74), in every mode and from the
     * fetch bridge's frame too. It ends the environment with the reason of the check that failed (`bridge` is the bridge
     * frame, or null; `announces` is false in strict mode, whose view takes no announcement).
     */
    private _listenForAnnouncement(iframe: HTMLIFrameElement, bridge: HTMLIFrameElement | null, announces: boolean) {
        const host = window;
        // The environment this listener belongs to: installed by its build, removed by its teardown (_stopListening).
        // Its input carries it, so one that a teardown made stale is dropped (S65).
        const gen = this._lc.gen;
        const onMessage = (event: MessageEvent) => {
            const data = event.data;
            if (!data || typeof data !== 'object') return;
            const guestWindow = guestWindowOf(iframe);
            // A bootstrap that found its document other than the one the library built (environment-check.ts, S74) stayed
            // inert and says so, with no port: from the guest frame's window (the view, the cooperative guest, worker mode's
            // frame) or the fetch bridge's frame, in every mode. The reason is the element's own, by the check's id; a guest
            // that forges the message can only end its own environment.
            if (data.type === ENVIRONMENT_REFUSED_TYPE) {
                const source = event.source;
                const reason = ENVIRONMENT_REFUSALS[data.refused as string];
                if (!event.isTrusted || !source || reason === undefined || (source !== guestWindow && source !== bridge?.contentWindow)) return;
                event.stopImmediatePropagation();
                this._refusedByHostPage(reason, gen);
                return;
            }
            // Strict mode's view checks in on its own port instead (R1:R3-1): there is no announcement to take.
            if (!announces || !guestWindow || event.source !== guestWindow) return;
            if (data.type !== ANNOUNCEMENT_TYPE) return;
            event.stopImmediatePropagation(); // the port is the element's: no other listener on this window sees it
            // Worker mode's frame announces a worker that could not start as its one announcement, with no port (R2:C-5,
            // worker-bootstrap.ts): the build ends with the reason strict mode gives for the same refusal,
            // and is never 'ready'. Only in worker mode, whose frame runs no guest code: elsewhere it is a forgery.
            const refusal = this._config.mode === 'worker' && event.ports.length === 0 ? WORKER_FRAME_REFUSALS[data.refused as string] ?? null : null;
            const valid = event.isTrusted && (event.ports.length === 1 || refusal !== null);
            // The check-in (S46): the environment is ready then, whether or not the wrapper has loaded (its load waits for
            // the guest's subresources).
            step(this, { t: 'announced', gen, valid, refusal, port: valid && refusal === null ? event.ports[0]! : null, source: guestWindow });
        };
        host.addEventListener('message', onMessage, true);
        this._stopListening = () => host.removeEventListener('message', onMessage, true);
    }

    // One frame from the guest's port: the guest document's bootstrap's, or (worker and strict mode) the worker's.
    // `source` labels its violation reports in strict mode ('logic'); null elsewhere.
    // Only the current environment's port is heard (AR:B4): teardown closes a port, and a closed port
    // delivers nothing more, but this does not rely on it — a frame from any other port changes nothing.
    // So past that check the port is the standing environment's, and the generation read then is the one the port was
    // opened in: the termination a frame starts carries it (S65), as _onViewMessage's do.
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
        if (data?.type === 'UNCAUGHT_PAST_BUDGET') {
            // The guest raised more uncaught errors and rejections in one second than their budget (egress.ts; R5:N-1),
            // counted by its bootstrap, which alone posts on this port. Firefox reports each to the host
            // page's thread, cancelled or not, so the guest that causes them is stopped.
            step(this, { t: 'terminate', reason: reasonText('uncaughtBudget'), gen: this._lc.gen });
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

        // The ports go to the view now, at the wrapper's load; what waits in the queue does not (R5:L-1): it is
        // posted when the build becomes ready, at the view's check-in (the `flush` effect). Flushed here, a call made while loading
        // that timed out between the load and the check-in would already have left, and run in the guest after its caller had been
        // told TIMEOUT, though docs/API.md says it never runs.
        const init = this._strictInit;
        this._strictInit = null;
        target.postMessage({ type: 'INIT_VIEW', ...init }, '*', [logic.port2, view.port2]);
    }

    private _onViewMessage(viewPort: MessagePort, data: any) {
        if (!viewPort || viewPort !== this._viewPort) return; // only the current environment's view (AR:B4)
        const gen = this._lc.gen; // so the environment the view port was opened in (see _onGuestMessage)
        if (data?.type === 'VIEW_READY') {
            // The view's check-in, the first frame on the port only its bootstrap holds (R1:R3-1): the strict build is ready,
            // if it is still loading (the reducer's `viewReady`), and what the view measured is checked then (`checkView`).
            step(this, { t: 'viewReady', gen, height: data.height, stillStyleRefused: data.stillStyleRefused === true });
            return;
        }
        if (data?.type === 'TRUSTED_TYPES_REFUSED') {
            // The view could not create its Trusted Types policy (R2:C-6): the host page's trusted-types
            // directive does not name it, though the host page itself never needed it (its own default policy took the
            // element's strings). The view checked before its check-in, so the build was never ready.
            this._refusedByHostPage(reasonText('trustedTypes'), gen);
            return;
        }
        if (data?.type === 'WORKER_REFUSED') {
            // The view could not load the worker at all (no script of the guest's ran): the host page's policy (R1:R3-1).
            this._refusedByHostPage(reasonText('workerRefused'), gen);
            return;
        }
        if (data?.type === 'VIEW_PONG') {
            this._viewWatchdog?.handlePong(data.n);
            return;
        }
        if (data?.type === 'VIEW_FIRST_OVERRUN') {
            // One operation of the view, a flush and the rendering that showed it, took longer than VIEW_MAX_OPERATION_MS,
            // and no other overrun came within VIEW_OVERRUN_WINDOW_MS before it (backlog S72, class P; in-sandbox-view.ts,
            // viewBudget): the view goes on. Said to the embedder, once per environment, as a host line on sandbox-log.
            // Why say it at all: the next overrun within the window ends the sandbox, and the embedder whose sandbox then
            // ends should be able to see that the first one came, and when (a load spike on its machine reads differently
            // from a guest whose every operation is slow). Why this channel: it exists, with a closed list of host lines
            // (docs/API.md, sandbox-log; the lifecycle model's whitelist), so no new event, field or name is public; and
            // once per environment: a warning is news only the first time, and a sandbox that had one overrun per window
            // for hours would otherwise log one line per window (the view posts one notice per first overrun, at most one
            // per 9 s of debt; past the first, they are dropped here).
            if (this._warnedViewOverrun) return;
            this._warnedViewOverrun = true;
            this._dispatchHostLog('warn', hostLine('viewFirstOverrun'));
            return;
        }
        if (data?.type === 'VIEW_OVERRUN') {
            // The second overrun of the view within VIEW_OVERRUN_WINDOW_MS (S72, class P; R5:M-2;
            // in-sandbox-view.ts, viewBudget): the view has stopped applying operations.
            step(this, { t: 'terminate', reason: reasonText('viewOverrun'), gen });
            return;
        }
        if (data?.type === 'VIEW_WRITTEN') {
            // the view holds a guest write (R1:R4-4): the guest may now be told its write stands
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
            // AR:C1): a guest line like the worker's own 'Uncaught …' lines, rate-limited the same way. The view cuts
            // it and rate-limits it before posting (R3:C-4); the line is cut again here (viewErrorLine).
            this._dispatchGuestLog({ level: 'error', args: [viewErrorLine(data.message)] });
            return;
        }
        if (data?.type === 'UNCAUGHT_PAST_BUDGET') {
            // The uncaught errors that only the view could see (WebKit mutes them in the worker: in-sandbox-view.ts,
            // countUncaught) passed UNCAUGHT_CHARACTERS_PER_SECOND in a second, counted by the view as the worker counts the rest.
            step(this, { t: 'terminate', reason: reasonText('uncaughtBudget'), gen });
            return;
        }
        if (data?.type === 'GUEST_TEXT_DROPPED') {
            // The view dropped a guest error text past its per-second window (R4:M-5): said once per
            // environment, as the console relay says its own drops, in a line of the relay's (not counted in the window).
            if (this._warnedViewTextDropped) return;
            this._warnedViewTextDropped = true;
            this._dispatchLog({ level: 'warn', args: [hostLine('viewTextDropped')] }, 'guest');
            return;
        }
        if (data?.type === 'GUEST_ERROR') {
            // The entry's own error text is the guest's (it wrote the code, or threw the value): a 'guest' line,
            // clamped and rate-limited like every guest line, never part of the host line or the reason (FR:F3).
            // The guest line goes through the guest relay's rate limit (the executor's notice, `source: 'guest'`).
            const line = viewErrorLine(data.message);
            step(this, { t: 'terminate', reason: reasonText('entryFailed'), gen, notices: [hostNotice(hostLine('entryFailed')), { level: 'error', text: line, source: 'guest' }] });
        }
    }

    // The view's height against the frame's (R1:R3-1): a view 150 px high in a taller frame means the host page's style-src
    // refused the wrapper's style (frame-documents.ts, WRAPPER_STYLE), which nothing on this side can see. Once per element.
    private _checkViewSize(height: unknown) {
        const frame = this._iframe?.clientHeight ?? 0;
        if (this._warnedWrapperStyle || typeof height !== 'number' || height > 150 || frame <= height + 1) return;
        this._warnedWrapperStyle = true;
        console.warn(`[Sandbox] the sandbox's view is ${height} px high in a frame of ${frame} px: the host page's style-src refuses the wrapper's style. Allow 'unsafe-inline' or ${scriptHashSource(WRAPPER_STYLE)} in style-src (see docs/API.md#host-page-policy).`);
    }

    // allowAnimations: false, and the host page's style-src refused the view's still stylesheet (in-sandbox-view.ts,
    // VIEW_STILL_STYLE), which a srcdoc document inherits: the view checked, and drops the guest's stylesheets instead, so
    // no guest animation runs either way. Said once per element, with the hash to allow.
    private _warnStillStyleRefused() {
        this._warnStrictOnce(`[Sandbox] allowAnimations is false, and the host page's style-src refuses the view's stylesheet that stops animations, so the view shows no guest stylesheet (<style>, <link rel="stylesheet">). Allow 'unsafe-inline' or ${scriptHashSource(VIEW_STILL_STYLE)} in style-src (see docs/API.md#host-page-policy).`);
    }

    // Flushes what was queued before the build was ready onto its port, in the order it was issued (R2:L-3): execute() code
    // (checked by execute() when queued) and the host's own RPC requests — the queue never holds answers (those go back
    // on the port their request arrived on). Reached by the `flush` effect only (R5:L-1). Requests are cloned when
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
    // Every detail is normalised and labelled with where it came from (sandbox-log.ts, AR:B3), here, from the
    // raw line and its source: no caller can hand this a detail of its own making.
    private _dispatchLog(line: unknown, source: 'guest' | 'host') {
        this.dispatchEvent(elementEvent('sandbox-log', toLogDetail(line, source, () => this._warnLogBytes())));
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
        // the relay's own lines, up to LOG_OWN_LINES per environment, outside the guest's window (R2:M-1, R2:M-2)
        if ((frame as { own?: unknown } | null)?.own === true && this._ownLines < LOG_OWN_LINES) {
            this._ownLines++;
            this._dispatchLog(frame, 'guest');
            return;
        }
        if (!this._logLimiter.admit()) {
            if (this._warnedLogLimit) return;
            this._warnedLogLimit = true;
            // Said where the lines are read, once per environment (R3:L-4): the guest's relay keeps the same
            // window, but lines delivered late (the host was busy) arrive bunched, past this window though the relay sent
            // them within its own, and a console warning alone would not tell a reader of sandbox-log that they are gone.
            const notice = hostLine('logLimit');
            console.warn(notice);
            this._dispatchHostLog('warn', notice);
            return;
        }
        this._dispatchLog(frame, 'guest');
    }

    // One request from the guest against this environment's per-second budget (R3:M-2), before its method is looked up (the
    // broker asks, rpc.ts), by the config schema's one rule (admitGuestCall, config-schema.ts): null when it fits, and is
    // counted against both windows; else the refusal, BUSY, or ARGS_NOT_TRANSFERABLE for a call heavier than the whole byte
    // budget (R5:L-2), and nothing is counted. The guest's broker refuses a call by the same rule before
    // sending it, so this refuses only what did not come through that check, or arrived bunched (delivered late while the
    // host page was busy).
    private _admitGuestCall(bytes: number): BudgetRefusal | null {
        return admitGuestCall(this._callBudget, this._guestCalls, this._guestCallBytes, bytes, performance.now());
    }

    // A line the element writes itself: labelled 'host', never rate-limited.
    private _dispatchHostLog(level: SandboxLogLevel, text: string) {
        this._dispatchLog({ level, args: [text] }, 'host');
    }

    // A CSP violation reported by the guest (S5): dispatched on the element and bubbling, like
    // sandbox-log. The detail is guest-supplied, so it is validated and clamped (violation.ts) and the
    // number of events per environment is capped: past VIOLATION_EVENT_LIMIT reports are dropped, with one
    // warning, so a guest cannot make the host run embedder listeners without bound.
    // In strict mode each port has its own count, labelled by where the report arrived (ADR-005): the view's
    // reports are the library's own, so a worker flooding the logic port can never use up the view's.
    // The view port counts per directive (AR:C4): its reports include refusals of
    // the guest's own rendered markup, so with one count a guest that rendered 100 refused images would use it up,
    // and a later refusal of another kind (a handler attribute: script-src-attr) would go unreported. The directive
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
        this.dispatchEvent(elementEvent('violation', detail));
    }

    // Arms the liveness watchdog for the port just handed over, if the config asks for one (see
    // src/lib/watchdog.ts). Pings go on THIS port: teardown closes it and stops the watchdog together.
    private _startWatchdog(port: MessagePort) {
        const budget = watchdogBudget(this._config.watchdogTimeout);
        if (budget === 0) return;
        const gen = this._lc.gen; // armed for this environment's port (`startWatchdogs`): its expiry ends that one only
        this._watchdog = startWatchdog({
            timeoutMs: budget,
            ping: (n) => port.postMessage({ type: 'PING', n }),
            onExpire: () => step(this, { t: 'terminate', reason: reasonText('watchdog'), gen }),
        });
    }

    // Auto-sizing applies to cooperative and strict mode: a worker has no document to measure, a strict view does.
    private _autoResizeEnabled(): boolean {
        return this._config.autoResize === true && this._config.mode !== 'worker';
    }

    // One resizer per environment (BL:B6, src/lib/auto-resize.ts), started with the port it listens on
    // and stopped by _teardown. It is the only path from a RESIZE frame to the element's height.
    private _startAutoResize() {
        if (!this._autoResizeEnabled()) return;
        this._resizer = startAutoResize((height) => {
            const value = `${height}px`;
            // the embedder's own inline height, kept to give back (R1:R3-8), unless it is one auto-sizing wrote
            if (this._autoHeight === null || this.style.height !== this._autoHeight) this._heightBeforeAuto = this.style.height;
            this.style.height = value;
            this._autoHeight = value;
        });
    }

    // Gives the height back to the embedder when auto-sizing is off for the environment being built: the inline height
    // it had before auto-sizing first wrote one (R1:R3-8: given back, not just removed), and only if the inline
    // height is still the one auto-sizing wrote.
    private _releaseAutoHeight() {
        if (this._autoHeight === null) return;
        if (this.style.height === this._autoHeight) this.style.height = this._heightBeforeAuto ?? '';
        this._autoHeight = null;
        this._heightBeforeAuto = null;
    }

    // One fetch bridge per environment (BL:B5), built with the environment and aborted by _teardown. The reserved
    // method is registered again with it, closed over THIS build's bridge (or null when off), as sandbox:write is
    // over its overlay: the broker looks a method up when a request arrives and runs it a microtask later, and a
    // request must be served by the bridge of the environment it arrived in. Reading this._fetchBridge when the method
    // runs would let a request that arrived just before a rebuild be served by the next environment's bridge (FR:H).
    // Closed over its own bridge, it reaches the one teardown closed, and is refused there.
    // Its requests are made by its own frame (bridge-frame.ts; BD1:ISO-1, class E-net), prepared by the build and put in
    // the shadow root after the wrapper: the bridge's only transport. The host page's fetch makes none of them.
    private _startFetchBridge(prepared: HTMLIFrameElement | null, policy: FetchPolicy | null) {
        if (!policy || !prepared) {
            this._fetchBridge = null;
            this._exposeFetch(null);
            return;
        }
        const frame = createBridgeFrame({
            iframe: prepared,
            parent: this.shadowRoot!,
            maxBytes: policy.maxBytes,
            startupTimeoutMs: LOAD_TIMEOUT_MS,
            onRefused: () => this._warnBridgeFrameRefused(),
        });
        this._bridgeFrame = frame;
        this._fetchBridge = createFetchBridge({
            policy,
            hostOrigin: globalThis.location?.origin ?? '',
            onRecord: (record) => this._dispatchFetch(record),
            transport: frame.transport,
        });
        this._exposeFetch(this._fetchBridge);
    }

    // The bridge fails closed when its frame never started (every request refused, with the reason in its record);
    // the embedder is told once, on the console.
    private _warnBridgeFrameRefused() {
        if (this._warnedBridgeFrame) return;
        this._warnedBridgeFrame = true;
        console.warn(`[Sandbox] ${BRIDGE_FRAME_REFUSED}: every sandboxFetch() request is refused.`);
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
        this.dispatchEvent(elementEvent('fetch', record));
    }

    // The resources of the environment (the executor's `teardown` effect): its generation is the reducer's. Everything a
    // build makes is made in _attachBuild or later, and released here (LM-2).
    // Detach, then release (class L; S74): first every per-environment field is written, the declared resources taken
    // into a record and their fields cleared, and only then is anything released, from the record. A release can run
    // embedder code synchronously (a frame's removal fires the host window's `focus` on Firefox, and a focused guest's
    // `pagehide` calls `parent.parent.focus()` on every engine), and a listener's reset(), load() or setConfig() builds
    // a new environment from inside it: it finds the element holding no environment, and its fields are not written
    // again by this teardown. test/unit/teardown-reentry.test.ts re-enters at every release; it also scans this body
    // for a write after the first release.
    private _teardown() {
        this._logLimiter = createLogLimiter(); // the log rate limit is per environment
        this._warnedLogLimit = false;
        this._guestCalls = createRateLimiter(this._callBudget.calls); // and so is the call budget (R3:M-2)
        this._guestCallBytes = createRateLimiter(this._callBudget.bytes);
        this._ownLines = 0;
        this._warnedLogBytes = false;
        this._warnedViewTextDropped = false;
        this._warnedViewOverrun = false;
        this._queue = []; // what was queued for the old environment
        this._violationCounts.clear(); // the violation cap is per environment
        this._strictInit = null;
        const guestWrites = this._guestWrites;
        const detached = detachEnvironment(this);
        guestWrites?.close(); // its writes stay listable and committable until the next build
        // Reject any in-flight calls so their promises never hang once this environment goes away.
        // They reject with code TERMINATED, minted by the broker (see rpc.ts).
        this._broker.rejectAllPending(RESET_CALL_MESSAGE);
        releaseEnvironment(detached);
    }

    // What a build reads besides the reducer's state, asked as it starts (src/lib/lifecycle.ts, BuildContext). Every build
    // starts in the reducer (`connect`, `build`, `configured`: its `initialize`), the one place a build starts, and every
    // build failure is a termination there (S26, AR:A4). A build that throws must not leave the old environment torn
    // down with state 'loading', no frame and no 'terminated' event, the throw escaping to whoever called setConfig() or
    // reset() (a configured string where a directive takes a list ("img-src": "x; script-src *") makes the policy
    // generator throw). A refusal known up front (a config that could not be used, an unknown mode, an entry that is
    // not registered) and anything the build throws end the same way: state 'terminated', one 'terminated' event with
    // the reason, nothing half-built (the `teardown` effect).
    // Where the element may build is one rule (R2:L-1: buildsHere, below), asked by every build, however it starts: in
    // another window's document, reset(), load() and setConfig() would build (the guest would run, and announce itself
    // to a window the element does not listen to), so they stop the environment instead, as insertion there does, and
    // the element stays idle. Asked first: in another document the element may have lost its prototype (BR:CB7), and
    // nothing else here is asked there.
    private _buildContext(): BuildContext {
        if (!buildsHere(this)) return NOT_HERE;
        const strict = this._config.mode === 'strict';
        // a bootstrap runs, and announces its port, exactly where the inline script can run (_getMarkupPlan's test, BR:CB1)
        return { buildsHere: true, blocked: this._buildRefusal(), strict, announces: !strict && this._getSandboxFlags().split(' ').includes('allow-scripts') };
    }

    // `loading` is bounded (BR:CB3): a build that has not completed within LOAD_TIMEOUT_MS of host ticks ends with a
    // reason. Completed means the guest checked in (S46; strict mode: the view's VIEW_READY), or, without a bootstrap,
    // the frame loaded.
    // A watchdog that nothing answers: it expires after the whole budget, never counting a host stall.
    // One per build (LM-2): the executor's `startLoadDeadline` effect, which the reducer gives once per build, when the
    // build is attached (`built`). It carries its build's generation, and the reducer lets it act only while that build is
    // `loading` (`loadDeadline`), which also decides the reason: once the wrapper has loaded, the frame that runs the
    // library's startup script (the strict view, or the guest's bootstrap) has loaded too, and that script runs before
    // anything else in it, so had it run it would have checked in; what stops an inline script of ours there is the host
    // page's policy, which srcdoc documents inherit (R1:R3-1).
    private _startLoadDeadline() {
        const gen = this._lc.gen;
        this._loadDeadline = startWatchdog({
            timeoutMs: LOAD_TIMEOUT_MS,
            ping: () => {},
            onExpire: () => step(this, { t: 'loadDeadline', gen }),
        });
    }

    // Why no environment may be built from the current config and files, or null (BuildContext.blocked). Fail closed on a
    // mode the element does not know (AR:A4): no environment at all, rather than one of a mode the embedder did not
    // ask for. A config that could not be used is the reducer's own refusal (`_lc.refused`).
    // The strict entry that names no registered JavaScript file is one of them (R2:L-4): decided here, so
    // the no-repeat rule (BR:CB5) knows it before building.
    private _buildRefusal(): string | null {
        const unknownMode = unknownModeReason(this._config.mode);
        if (unknownMode !== null) return unknownMode;
        // A host page that is cross-origin isolated is not one a sandbox runs in, on any engine (environment-check.ts, the
        // `isolated` row): refused here, in the host's realm, before any frame exists. The frames' bootstraps read the same row,
        // as defence in depth: an engine's opaque-origin frames need not read an isolated page's isolation.
        if (String(window.crossOriginIsolated === true) !== ENVIRONMENT_EXPECTED.isolated) return reasonText(ENVIRONMENT_CHECKS.isolated.reason);
        const entry = this._config.entry;
        if (this._config.mode === 'strict' && typeof entry === 'string' && entry !== '') {
            const file = this._files.list().find(candidate => candidate.path === entry);
            if (!file || !isJavaScriptType(file.type)) return reasonText('entryNotRegistered', entry.slice(0, 256));
        }
        return null;
    }

    // `postToFrame` (worker mode): the expression that names the worker's platform postMessage, which the globals
    // allowlist handed over (worker-globals.ts, R4:M-1); the bootstrap's one WORKER_STARTED uses it.
    // `connect`: the sources of the guest policy's connect-src (_gateConnect), which the bootstrap's request gate admits.
    private _getSandboxCommsScript(mode: 'cooperative' | 'worker', files: FileSnapshotEntry[], plan: GuestMarkupPlan = NO_MARKUP_PLAN, postToFrame = 'null', connect: readonly string[] = []) {
        // communication, logs and RPC bridge template that any content running in the sandbox uses.
        // createBroker is stringified in too, so the guest runs the identical dispatcher (see rpc.ts).
        // The features as one literal: the opt-in ones only when on, and the call budget always (R3:M-2).
        // The listeners the bootstrap installs are the egress table's rows for this mode (egress.ts), and worker mode's guest also
        // counts its uncaught errors and rejections against their budget (R5:N-1).
        const features: BootstrapFeatures = { callBudget: { ...this._callBudget }, listeners: bootstrapListeners(mode), connect: [...connect] };
        if (mode === 'worker') features.uncaught = { ...UNCAUGHT_BUDGET };
        if (mode === 'cooperative' && this._autoResizeEnabled()) features.autoResize = true;
        if (this._fetchPolicy) features.fetchBridge = { timeoutMs: this._fetchPolicy.timeoutMs };
        if (this._config.guestWrites === true) features.guestWrites = true;
        const featuresArgument = `, ${toInlineScriptLiteral(features)}`;
        // Only literals are interpolated: `=== true` here as well, whatever setConfig() stored (AR:A6).
        const comms = `(${inSandboxScript.toString()})(${this._config.scriptUnsafe === true}, '${mode}', console, ${createBroker.toString()}${featuresArgument}, ${createSizeOf.toString()}, ${postToFrame})`;
        // Guest writes (BL:C5): sandboxFiles gets the comms script's captured write call through `comms`, a constant
        // of a block the whole bootstrap then runs in: block-scoped, so never a global guest code could read.
        // Without them the bootstrap keeps its text: the comms statement, then sandboxFiles without a write call
        // (its write() and remove() refuse locally).
        const writes = this._config.guestWrites === true;
        // The snapshot is one inline literal, so the blobs exist before the parser reaches guest markup.
        // Installed even with no files (an empty literal): sandboxFiles always exists, and a lookup in
        // an empty store is NOT_FOUND like any other miss, never a ReferenceError.
        let filesCall = `(${inSandboxFiles.toString()})(${toInlineScriptLiteral(files)}${writes ? ', comms.writeFiles' : ''})`;
        // With JavaScript files: the one import map, registered with the URLs filesCall just created,
        // before any guest markup (module graph). It hands the files object on to the next step.
        if (plan.importMap) {
            filesCall = `(${inSandboxImportMap.toString()})(${filesCall}, ${toInlineScriptLiteral(plan.importMap.paths)}, ${toInlineScriptLiteral(plan.importMap.guest)})`;
        }
        // Guest markup that names files: written by the bootstrap's last statement, with the blob: URLs
        // filesCall just created (markup-references.ts). The parts are one more inline literal.
        const last = plan.parts ? `(${inSandboxMarkup.toString()})(${filesCall}, ${toInlineScriptLiteral(plan.parts)});` : `${filesCall};`;
        return writes ? `{const comms = ${comms};${last}}` : `${comms};${last}`;
    }

    // The cooperative guest's bootstrap, behind the environment gate (environment-check.ts, S74): the check is its first
    // statement, and on a refusal the document's parser stops, so the guest markup that follows never runs.
    private _getCooperativeBootstrapScript(files: FileSnapshotEntry[], plan: GuestMarkupPlan, connect: readonly string[]) {
        return environmentGate('parent.parent', true, this._getSandboxCommsScript('cooperative', files, plan, 'null', connect));
    }

    private _getWorkerBootstrapScript(files: FileSnapshotEntry[], connect: readonly string[]) {
        // the worker keeps only the allowlisted globals (worker-globals.ts), then runs the comms script and builds its
        // own blobs and sandboxFiles from the same literal; the frame only spawns it and forwards the port
        // No WebAssembly unless scriptUnsafe (R1:R2-5), as in strict mode: WebKit compiles it without
        // 'wasm-unsafe-eval', so the policy alone does not keep it out. Removed before the comms script, like the globals.
        // The allowlist runs first, as the argument of the function the rest runs in: it returns the worker's postMessage,
        // which it deleted (R4:M-1), and only the comms script is given it, for its one WORKER_STARTED.
        const noWasm = this._config.scriptUnsafe === true ? '' : `(${removeWebAssembly.toString()})(g);`;
        const workerSource = `(function (g, postToFrame) {${noWasm}${this._getSandboxCommsScript('worker', files, NO_MARKUP_PLAN, 'postToFrame', connect)}})(this, ${workerGlobalsCall('this')});`;
        return environmentGate('parent.parent', false, `(${workerBootstrap.toString()})(${toInlineScriptLiteral(workerSource)}, ${toInlineScriptLiteral(TRUSTED_TYPES_POLICY)});`);
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
    private _guestPolicy(files: FileSnapshotEntry[], origins: OriginPolicy): string {
        const input = this._policyInput(files, origins);
        if (this._config.mode !== 'strict') return cooperativePolicy(input);
        return strictViewPolicy({ ...input, bootstrapHash: viewBootstrapHash() });
    }

    // The sources of that policy's connect-src, from the same input: what the bootstrap's request gate admits (S74), so
    // the gate and the browser read one list.
    private _gateConnect(files: FileSnapshotEntry[], origins: OriginPolicy): string[] {
        return connectSources(this._policyInput(files, origins));
    }

    private _policyInput(files: FileSnapshotEntry[], origins: OriginPolicy): PolicyInput {
        const types = files.map(entry => entry[1]);
        const scriptUnsafe = this._config.scriptUnsafe === true;
        if (this._config.mode !== 'strict') return { origins, fileKinds: fileKinds(types), scriptUnsafe };
        // A type the view mints no URL for (isViewFileType, BR:ST1) is only fetched, by the worker.
        const viewTypes = types.map(type => (isViewFileType(type) ? type : FALLBACK_TYPE));
        const kinds = fileKinds(viewTypes);
        // With guest writes the view may mint URLs for raster images during the environment (R1:R4-4): image loads only.
        if (this._config.guestWrites === true) kinds.add(LOAD_KINDS.image.key);
        return { origins, fileKinds: kinds, scriptUnsafe };
    }

    // The host page's policy applied to the connect origins of this build (host-connect.ts): `origins` and the bridge's
    // allowlist as configured, less what a policy of the page refuses. The policy is the embedder's
    // (`hostContentSecurityPolicy`), or the page's as the first such build read it (host-csp.ts, which `_buildGate` waited
    // for); `false`, a policy that could not be read, and a build with nothing to narrow leave the configured lists.
    // Pure of the element's fields: a nested or stale build narrows its own (LM-2).
    private _reach(): NarrowedReach {
        const configured = { origins: this._origins, fetchPolicy: this._fetchPolicy };
        const option = this._config.hostContentSecurityPolicy;
        if (option === false) return configured;
        let texts: string | readonly string[];
        if (typeof option === 'string') {
            texts = option;
        } else {
            const read = knownHostPolicies();
            if (!read) {
                if (read === null && hostPolicyReadFailed()) this._warnConfig("[Sandbox] the host page's Content-Security-Policy could not be read, so its connect-src is not applied to origins.connect and fetchBridge.allow by the library (the browser still applies it where its engine does). Pass hostContentSecurityPolicy to give it (docs/API.md#host-page-policy).");
                return configured;
            }
            texts = read;
        }
        return narrowToHostPolicy(configured.origins, configured.fetchPolicy, parseHostPolicies(texts), message => this._warnConfig(message));
    }

    // What the build waits for (the executor's gate, lifecycle.ts): the host page's policy, when the embedder gave none and
    // the build lists a connect origin or a bridge origin it could refuse. Null when nothing is to be waited for.
    private _buildGate(): Promise<void> | null {
        if (this._config.hostContentSecurityPolicy !== undefined || !this.shadowRoot) return null;
        if (this._origins.connect.length === 0 && (this._fetchPolicy?.allow.length ?? 0) === 0) return null;
        return whenHostPoliciesKnown(this.shadowRoot);
    }

    // The host page's Trusted Types directives, where the browser has no Trusted Types to apply them (a browser that has them
    // decides, in the sinks and in the guest: null), and only from the embedder's `hostContentSecurityPolicy`: the read of the
    // page's policy (host-csp.ts) cannot supply them, because a browser without Trusted Types leaves the directives it does not
    // implement out of the policy text it reports (measured), so nothing is read, and nothing is applied, without the option
    // (host-trusted-types.ts).
    private _trustedTypes(): TrustedTypesStance | null {
        if (browserHasTrustedTypes()) return null;
        const option = this._config.hostContentSecurityPolicy;
        return typeof option === 'string' ? trustedTypesStance(option, TRUSTED_TYPES_POLICY) : null;
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
        // of any other file names nothing in the import map and fails closed, as a <script src> of one does (FR:W1).
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

    // Cooperative mode without allow-scripts runs no script, the library's bootstrap included (R1:R3-4): what
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

    // The build effect (src/lib/lifecycle.ts, `build`): everything of a build that can run embedder code, into values the
    // element does not hold yet. LM-2: a host page's Trusted Types default policy runs at each HTML sink written here (the
    // wrapper's srcdoc, the inert parse of the markup in the warnings and the markup plan), and a patched console.warn at
    // each warning; one that calls reset() builds again from inside this one. So the frame is made and written detached
    // (setting the element's fields as the build went would let the outer build go on over the nested one's), nothing is
    // the element's until `attach`, and the reducer attaches only the build that is still the element's (`built{gen}`):
    // an outer build that a nested one replaced is dropped whole.
    private _prepareBuild(): PreparedBuild {
        const isWorkerMode = this._config.mode === 'worker';
        // The embedder's own inline height, back as soon as a build without auto-sizing starts (R1:R3-8), whether or not it
        // then completes: the element's, not a resource of the build, and written without embedder code.
        if (!this._autoResizeEnabled()) this._releaseAutoHeight();
        // One copy of the store per build, taken now: the guest's files and the policy come from its snapshot, and the
        // guest-write overlay answers from it (BR:CB4). Later registerFiles() calls reach the guest only through the next build.
        const built = this._files.copy();
        const files = built.snapshot();
        const reach = this._reach();
        // where the browser has no Trusted Types: the page's list that does not name the library's policy ends the build, as it does where it has them
        const trustedTypes = this._trustedTypes();
        if (trustedTypes && buildRefused(trustedTypes, this._config.mode as TrustedTypesMode)) throw new TrustedTypesRefusal("the host page's trusted-types directive does not name the policy");
        if (this._config.mode === 'strict') return this._prepareStrictFrame(built, files, reach);

        const sandboxFlags = this._getSandboxFlags();
        const permissions = this._getPermissions();
        const policy = this._guestPolicy(files, reach.origins);
        const connect = this._gateConnect(files, reach.origins);

        // Guest markup is the guest's own: cooperative mode runs it as it is (that is the mode), and strict mode's view cleans
        // it with its allowlist renderer (sanitizeRender), not here.
        let guestDocument: string;
        if (isWorkerMode) {
            // worker mode is headless: no guest markup, so no markup references either
            guestDocument = buildGuestDocument({ csp: policy, bootstrapScript: this._getWorkerBootstrapScript(files, connect), content: '' });
        } else {
            const html = this._config.html || '<div id="root"></div>';
            this._warnAboutNoScripts(html, sandboxFlags);
            // A fresh slot nonce per build (inside rewriteGuestMarkup); null parts keep the markup verbatim.
            const plan = this._getMarkupPlan(html, files, sandboxFlags);
            guestDocument = buildGuestDocument({
                csp: policy,
                bootstrapScript: this._getCooperativeBootstrapScript(files, plan, connect),
                content: plan.parts ? '' : html,
                bootstrapWritesContent: plan.parts !== null,
            });
        }

        const iframe = document.createElement("iframe");
        iframe.setAttribute("sandbox", sandboxFlags);
        // the wrapper's own document.referrer is never the host page (S15; the guest's is set in the wrapper), and on Chromium
        // none of its requests carries a cookie (S74)
        setWrapperFrameIsolation(iframe);
        for (const [name, value] of Object.entries(permissionAttributes(permissions))) {
            iframe.setAttribute(name, value);
        }
        iframe.style.cssText = isWorkerMode ? "display:none" : "width:100%;height:100%;border:none";
        // srcdoc goes in before the frame is inserted: an iframe inserted without one first
        // loads about:blank, which would count as the frame's one load (see _frameLoadHandler)
        setLibrarySrcdoc(iframe, buildWrapperDocument(guestDocument, sandboxFlags, permissions));
        return { iframe, built, strictInit: null, bridgeFrame: this._prepareBridgeFrame(reach.fetchPolicy), fetchPolicy: reach.fetchPolicy };
    }

    /**
     * Strict mode (ADR-005). The view document is the policy and the hashed bootstrap, nothing of the guest's;
     * the worker's source (comms, files, the strict prelude, then the entry) and the initial markup travel in
     * INIT_VIEW once the wrapper has loaded. The view mints its own blob: URLs for the registered files it may
     * show, so no JavaScript file is ever given to it.
     */
    private _prepareStrictFrame(built: FileStore, files: FileSnapshotEntry[], reach: NarrowedReach): PreparedBuild {
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
        const policy = this._guestPolicy(files, reach.origins);
        const marker = entryDoneName(); // drawn per build: an entry cannot declare a binding of its name (BR:ST4)
        const strictInit: StrictInit = {
            workerSource: this._getStrictWorkerSource(files, entrySource, marker, this._gateConnect(files, reach.origins)),
            entryDone: marker,
            viewFiles: files.filter(candidate => isViewFileType(candidate[1])), // never a type that opens as a document (BR:ST1)
            html,
            autoResize: this._autoResizeEnabled(),
            allowAnimations: this._config.allowAnimations === true,
            allowAutoplay: this._config.allowAutoplay === true,
            origins: { images: [...this._origins.images], media: [...this._origins.media] },
        };
        const view = buildViewDocument(policy, viewBootstrapText());

        const iframe = document.createElement("iframe");
        iframe.setAttribute("sandbox", sandboxFlags);
        setWrapperFrameIsolation(iframe);
        iframe.style.cssText = "width:100%;height:100%;border:none";
        setLibrarySrcdoc(iframe, buildWrapperDocument(view, sandboxFlags, []));
        return { iframe, built, strictInit, bridgeFrame: this._prepareBridgeFrame(reach.fetchPolicy), fetchPolicy: reach.fetchPolicy };
    }

    // The fetch bridge's frame of this build, written detached like the wrapper, or null with the bridge off.
    private _prepareBridgeFrame(policy: FetchPolicy | null): HTMLIFrameElement | null {
        return policy ? prepareBridgeFrame(policy.allow) : null;
    }

    // The executor's `attach` effect: the prepared build becomes the element's, every per-build resource made here (the
    // frame and its load handler, the strict view's init, the announcement listener, the fetch bridge, the guest-write
    // overlay) and released by the teardown (LM-2). Nothing here runs embedder code: inserting a frame whose srcdoc is set
    // fires no load synchronously (a load the engine fires inside a DOM operation is handled in a microtask anyway,
    // _frameLoadHandler), and no HTML sink is written. So no other build can start in between, and this build's
    // resources are one set.
    private _attachBuild(prepared: PreparedBuild) {
        this._startGuestWrites(prepared.built);
        const iframe = prepared.iframe;
        this._iframe = iframe;
        this._strictInit = prepared.strictInit;
        iframe.onload = this._frameLoadHandler(iframe);
        // The guest announces its port from its first statement (BR:CB1), so the listener is in place before the frame is
        // inserted. Strict mode's view checks in on its own port instead (R1:R3-1); every mode's bootstraps may refuse an
        // environment other than the one built (environment-check.ts), the fetch bridge's frame included.
        this._listenForAnnouncement(iframe, prepared.bridgeFrame, prepared.strictInit === null);
        this.shadowRoot!.appendChild(iframe);
        this._startFetchBridge(prepared.bridgeFrame, prepared.fetchPolicy); // its frame after the wrapper, which stays the shadow root's first
    }

    // The worker's source in strict mode: the scope check, the globals allowlist, the comms script (bridge, logs, violations, execute,
    // the fetch bridge), sandboxFiles with every registered file, the strict prelude (hardening, sandboxView, the
    // ports), then the guest's entry in a function scope of its own, then the line that marks the entry as having
    // run to its end (it raises the marker error that tells the view so: in-sandbox-view.ts). The entry's own scope
    // (AR:C2): its top-level declarations are local to it, so none can
    // replace a global before the prelude has captured or deleted it; an entry that wants a global assigns it
    // (globalThis.x = …). `this` inside is the global object, as at a script's top level. The scope check
    // (assertEntryScoped) refuses to start a worker whose entry escaped that scope.
    private _getStrictWorkerSource(files: FileSnapshotEntry[], entrySource: string, marker = entryDoneName(), connect: readonly string[] = []): string {
        const features: BootstrapFeatures = { externalPort: true, callBudget: { ...this._callBudget }, listeners: bootstrapListeners('strict'), uncaught: { ...UNCAUGHT_BUDGET }, connect: [...connect] };
        if (this._fetchPolicy) features.fetchBridge = { timeoutMs: this._fetchPolicy.timeoutMs };
        if (this._config.guestWrites === true) features.guestWrites = true;
        const options = { scriptUnsafe: this._config.scriptUnsafe === true, maxRender: VIEW_RENDER_MAX_LENGTH, maxTarget: VIEW_TARGET_MAX_LENGTH, maxElements: VIEW_MAX_ELEMENTS, maxDepth: VIEW_MAX_DEPTH, maxCharacters: VIEW_MAX_CHARACTERS, maxUrls: VIEW_MAX_URLS, maxDistinctUrls: VIEW_MAX_DISTINCT_URLS, entryDoneName: marker, eventTypes: VIEW_EVENT_TYPES };
        const prelude = '(function (g) {'
            + `(${assertEntryScoped.toString()})(g);`
            + workerGlobalsStatement('g')
            + `var comms = (${inSandboxScript.toString()})(${this._config.scriptUnsafe === true}, 'strict', console, ${createBroker.toString()}, ${toInlineScriptLiteral(features)}, ${createSizeOf.toString()});`
            + `(${inSandboxFiles.toString()})(${toInlineScriptLiteral(files)}, ${this._config.guestWrites === true ? 'comms.writeFiles' : 'null'}, ${toInlineScriptLiteral(VIEW_FILE_TYPES)});`
            + `(${inStrictWorker.toString()})(comms, ${toInlineScriptLiteral(options)});`
            + '})(this);';
        return `${prelude}\n(function () {\n${entrySource}\n}).call(this);\n${marker}();\n`;
    }

    private _warnStrictOnce(message: string) {
        if (this._warnedStrict.has(message)) return;
        this._warnedStrict.add(message);
        console.warn(message);
    }

    // Strict mode is the default, so markup written for cooperative mode reaches it unchanged: its scripts and
    // handlers never run (the renderer drops them, and the view's policy admits only the bootstrap). Said once per
    // element, read with an inert parser (markup-scripts.ts); not again once said, so a big view is parsed only until then.
    private _warnAboutStrictHtml(html: string) {
        if (this._warnedStrict.has(STRICT_HTML_SCRIPT_WARNING) || !scriptInMarkup(html)) return;
        this._warnedStrict.add(STRICT_HTML_SCRIPT_WARNING);
        console.warn(STRICT_HTML_SCRIPT_WARNING);
    }

    // The view liveness check (ADR-005): the view answers VIEW_PING on its port; silence for the budget ends the sandbox.
    private _startViewWatchdog(viewPort: MessagePort) {
        const gen = this._lc.gen; // armed for this environment's view (`startWatchdogs`): its expiry ends that one only
        this._viewWatchdog = startWatchdog({
            timeoutMs: VIEW_LIVENESS_TIMEOUT_MS,
            ping: (n) => viewPort.postMessage({ type: 'VIEW_PING', n }),
            onExpire: () => step(this, { t: 'terminate', reason: reasonText('viewLost'), gen }),
        });
    }

    // The wrapper's load handler for `iframe` (R2:L-6): a load counts only for the element's current frame
    // while both are in the document. Chromium and WebKit fire a frame's load when it is detached, from inside remove()
    // or appendChild() and before the element's disconnectedCallback: a cooperative build without a bootstrap would
    // become 'ready' there, dispatched synchronously from the embedder's own remove().
    //
    // Never from inside the load event itself (R4:L-1): the check above holds in a load that Chromium and
    // WebKit fire during the embedder's appendChild() of the element (a move), for the frame being moved, since the frame
    // and the element still read as connected there; 'ready' would be dispatched from inside the embedder's own call. The
    // build completes in a microtask instead, after the element's own lifecycle reactions (disconnectedCallback, then
    // connectedCallback), which run before appendChild() or remove() returns: a frame that the move tore down is no
    // longer the element's then, and its load completes nothing. The microtask asks again: the same frame, and both still
    // connected (`stillOurs`).
    //
    // What the load is, is read here: whether it is still ours, and the guest frame's window it holds. What it does is the
    // reducer's (`frameLoad`, S65): a second load, a guest frame other than the one that checked in, or none, end the
    // environment; strict mode hands the view its ports (`sendInitView`); a guest with no bootstrap completes the build.
    // It carries the generation the load event found, so the load of an environment torn down since is dropped. Anything
    // reading the frame throws ends the build it completes, as the completion's own effects do (they are guarded).
    private _frameLoadHandler(iframe: HTMLIFrameElement) {
        return () => {
            const gen = this._lc.gen;
            queueMicrotask(() => {
                const stillOurs = iframe === this._iframe && iframe.isConnected && this.isConnected;
                let guest: Window | null;
                try {
                    guest = stillOurs ? guestWindowOf(iframe) : null;
                } catch (error) {
                    step(this, { t: 'terminate', reason: buildFailureReason(error, 'complete'), gen });
                    return;
                }
                step(this, { t: 'frameLoad', gen, stillOurs, guest });
            });
        };
    }

    // The executor's completion effects (src/lib/lifecycle.ts: `enterReady`, `finishBuild`, `frameLoad`), each one thing
    // done to this environment's resources; the reducer decides when, and in which order.

    // `stopLoadDeadline`: the build is ready, its bound is met.
    private _stopLoadDeadline() {
        if (this._loadDeadline) { this._loadDeadline.stop(); this._loadDeadline = null; }
    }

    // `flush`: the one place what waited for `ready` is released (R5:L-1; S65). The reducer emits it in one output only,
    // the transition to `ready`, in every mode, and test/unit/lifecycle-reducer.test.ts checks that nothing else reaches
    // _flushQueues. The queued calls and execute() code are posted in the order they were made, and nowhere else. A call
    // made while loading waits in the queue for this point; if it settles first (its timeout), it leaves the queue and is
    // never posted (_queuedWhilePending), so a call that timed out before `ready` never runs. Neither the wrapper's load
    // (_setupStrictChannels) nor setupChannel flushes: two flush points for one rule would let strict mode's release a
    // call before `ready`.
    private _flush() {
        if (this._port) this._flushQueues(this._port);
    }

    // `startWatchdogs`: armed before 'ready' is dispatched, so a 'ready' listener that resets or terminates the sandbox
    // stops them with the rest, instead of leaving one running for a port that is gone.
    private _startWatchdogs() {
        if (this._port) this._startWatchdog(this._port);
        if (this._viewPort) this._startViewWatchdog(this._viewPort);
    }

    // `checkView`: what the strict view reports at its check-in (R1:R3-1).
    private _checkView(height: unknown, stillStyleRefused: boolean) {
        this._checkViewSize(height);
        if (stillStyleRefused) this._warnStillStyleRefused();
    }

    // For tests: the platform's lifecycle inputs, delivered by hand where jsdom cannot deliver them (a guest frame's
    // announcement, the view's check-in, the wrapper's load; test/unit/check-in.ts). The element itself never calls it.
    private _step(input: LcInput) {
        step(this, input);
    }
}

// The lifecycle (BR:CB7). Each function reaches the element's own fields and the class's methods through
// WebSandbox.prototype, never through the element's prototype chain: in Firefox an element adopted into another
// document has that document's HTMLElement prototype. The methods applied here use the element's own fields, and those
// that build (_buildContext past its first line, _configure, _prepareBuild, _attachBuild, _startLoadDeadline) run only
// in the defining document, where the element has its own prototype (connected restores it first).
const LIFECYCLE = WebSandbox.prototype as unknown as {
    _buildContext(): BuildContext;
    _configure(): string | null;
    _prepareBuild(): PreparedBuild;
    _buildGate(): Promise<void> | null;
    _attachBuild(prepared: PreparedBuild): void;
    _startLoadDeadline(): void;
    _teardown(): void;
    _discardGuestWrites(): void;
    _dispatchHostLog(level: SandboxLogLevel, text: string): void;
    _dispatchGuestLog(frame: unknown): void;
    _stopLoadDeadline(): void;
    _setupStrictChannels(target: Window): void;
    setupChannel(port: MessagePort | null): void;
    _checkView(height: unknown, stillStyleRefused: boolean): void;
    _flush(): void;
    _startWatchdogs(): void;
    _startAutoResize(): void;
};

// What the executor reaches on the element: its own fields, whatever its prototype (BR:CB7).
interface LifecycleFields {
    _lc: LcState;
    _warnedForeignDocument: boolean;
}

// What a build prepared (_prepareBuild), until the reducer attaches it (`built`, then `attach`) or drops it (LM-2).
interface PreparedBuild {
    iframe: HTMLIFrameElement; // the wrapper, its srcdoc written, not in the document
    built: FileStore; // the copy of the store this build delivers (BR:CB4)
    strictInit: StrictInit | null; // strict mode: what the wrapper's load hands the view
    bridgeFrame: HTMLIFrameElement | null; // the fetch bridge's frame, its srcdoc written, not in the document (BD1:ISO-1)
    fetchPolicy: FetchPolicy | null; // the bridge's policy with the host page's policy applied (_reach): what its requests are checked against
}

// The context of a build where the element may not build (buildsHere): it stops instead, and asks nothing else.
const NOT_HERE: BuildContext = Object.freeze({ buildsHere: false, blocked: null, strict: false, announces: false });

/**
 * The lifecycle executor's one entry (S65; src/lib/lifecycle.ts, `step`): reduce `input` against the element's
 * `_lc`, store the next state, then run the effects on the element. Every transition comes through here: every build
 * (the DOM callbacks, reset(), load(), setConfig()) and its completion (the wrapper's load, the guest's announcement,
 * the view's check-in), and every termination: terminate(), a build's failure and its deferred 'terminated', and every
 * one the element starts itself. What a platform callback or a timer delivers is stamped with the generation it was
 * armed in, which `reduce` drops once a teardown made it stale (research 18, class L: "an actor of an old environment
 * cannot act"). The executor is the only writer of `_lc` and makes the lifecycle's two events. Module level, and
 * every effect is applied through LIFECYCLE (BR:CB7): in Firefox an element adopted into another document has lost its
 * prototype, and a step must still end its environment there.
 * Steps nest synchronously (a listener's terminate() dispatches inside that listener, as docs/API.md says).
 */
function step(element: WebSandbox, input: LcInput): void {
    runStep(lifecycleHost(element), input);
}

// One adapter per element, made on its first step.
const LIFECYCLE_HOSTS = new WeakMap<WebSandbox, LifecycleHost>();

function lifecycleHost(element: WebSandbox): LifecycleHost {
    let host = LIFECYCLE_HOSTS.get(element);
    if (!host) {
        host = lifecycleHostOf(element);
        LIFECYCLE_HOSTS.set(element, host);
    }
    return host;
}

function lifecycleHostOf(element: WebSandbox): LifecycleHost {
    const own = element as unknown as LifecycleFields;
    return {
        get lc() {
            return own._lc;
        },
        set lc(next: LcState) {
            own._lc = next;
        },
        step: (input) => step(element, input),
        task: (input) => {
            setTimeout(() => step(element, input), 0);
        },
        teardown: () => Reflect.apply(LIFECYCLE._teardown, element, []),
        discardWrites: () => Reflect.apply(LIFECYCLE._discardGuestWrites, element, []),
        applyConfig: () => Reflect.apply(LIFECYCLE._configure, element, []),
        buildContext: () => Reflect.apply(LIFECYCLE._buildContext, element, []),
        buildGate: () => Reflect.apply(LIFECYCLE._buildGate, element, []),
        build: () => Reflect.apply(LIFECYCLE._prepareBuild, element, []),
        attach: (prepared) => Reflect.apply(LIFECYCLE._attachBuild, element, [prepared as PreparedBuild]),
        startLoadDeadline: () => Reflect.apply(LIFECYCLE._startLoadDeadline, element, []),
        failureReason: buildFailureReason,
        warn: (text) => console.warn(text),
        // Once per element (BR:CB7): inserted into a document of another window, where it builds nothing.
        warnForeignDocument: () => {
            if (own._warnedForeignDocument) return;
            own._warnedForeignDocument = true;
            console.warn('[Sandbox] the element was inserted into a document of another window: it builds no environment there. Insert it into the document of the window that defined it.');
        },
        // The one dispatch of 'terminated' (R4:L-3): the executor runs it between its `dispatchStarted` and
        // `dispatchEnded` steps, so the no-repeat rule (BR:CB5) knows the reason while the listeners run.
        // test/unit/lifecycle-reducer.test.ts checks that host.ts makes this event nowhere else.
        dispatchTerminated: (reason) => {
            element.dispatchEvent(elementEvent('terminated', { reason }));
        },
        // One notice, one event: a host line, or the guest's own words through the guest relay's rate limit (FR:F3).
        notice: (notice: Notice) => {
            if (notice.source === 'host') Reflect.apply(LIFECYCLE._dispatchHostLog, element, [notice.level, notice.text]);
            else Reflect.apply(LIFECYCLE._dispatchGuestLog, element, [{ level: notice.level, args: [notice.text] }]);
        },
        // The completion of a build (S65), in the order `enterReady` gives them.
        stopLoadDeadline: () => Reflect.apply(LIFECYCLE._stopLoadDeadline, element, []),
        sendInitView: (target) => Reflect.apply(LIFECYCLE._setupStrictChannels, element, [target as Window]),
        openChannel: (port) => Reflect.apply(LIFECYCLE.setupChannel, element, [port as MessagePort | null]),
        closePort: (port) => (port as MessagePort | null)?.close(),
        checkView: (height, stillStyleRefused) => Reflect.apply(LIFECYCLE._checkView, element, [height, stillStyleRefused]),
        flush: () => Reflect.apply(LIFECYCLE._flush, element, []),
        startWatchdogs: () => Reflect.apply(LIFECYCLE._startWatchdogs, element, []),
        startAutoResize: () => Reflect.apply(LIFECYCLE._startAutoResize, element, []),
        // The one dispatch of 'ready', after the state settled and the watchdogs and the resizer are in place.
        dispatchReady: () => {
            element.dispatchEvent(elementEvent('ready'));
        },
    };
}

// A line of the element's own, said before the termination it announces (the executor dispatches it: `notices`).
function hostNotice(text: string): Notice {
    return { level: 'error', text, source: 'host' };
}

// The reason of a build that threw (S26, FR:F3: the error's name, never its message): while it was
// built (_prepareBuild), the host page's Trusted Types policy is named; while it completed (the wrapper's load, the
// guest's check-in), any throw is a build failure.
function buildFailureReason(error: unknown, phase: 'build' | 'complete'): string {
    if (phase === 'build' && error instanceof TrustedTypesRefusal) return reasonText('trustedTypes');
    return reasonText('buildFailed', errorName(error));
}

// One guest change as the strict view is told it (R1:R4-4): the path, its store type (null after a removal) and, only for a
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

// An environment is built only in the document of the realm that defined the element, while the element is in it. In
// another document (an iframe's, one made with document.implementation) the guest would announce itself to that
// document's window, which the element does not listen to (Chromium and WebKit would build a bridge that never
// connects), and in Firefox the element has lost its methods. So it stays idle there, with one warning, until it is back
// in its own document. The one predicate every build asks (R2:L-1: _buildContext).
function buildsHere(element: WebSandbox): boolean {
    return element.isConnected && element.ownerDocument === document;
}

// Insertion: the reducer's `connect` builds, or, where the element may not build, stops and warns once (`initialize`,
// `warnForeignDocument`). Neither dispatches anything synchronously: a build's failure comes in a task (R1:R3-2).
function connected(element: WebSandbox) {
    // The engine refuses to give a Firefox-adopted element its prototype back: it stays idle (it stopped when it left).
    if (buildsHere(element) && !restorePrototype(element)) return;
    step(element, { t: 'connect', ctx: Reflect.apply(LIFECYCLE._buildContext, element, []) });
}

// Firefox gives an element adopted into another document that document's HTMLElement prototype (BR:CB7): its methods are
// gone there, so a call would throw a TypeError, and registerFiles() would change the store and then throw before its
// 'fileschanged' (R2:L-5). The element gets its own prototype back on adoption, and again on its return
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

// Removal, and adoption into another document: the environment ends, with no 'terminated' event (the reducer's `stop`).
function disconnected(element: WebSandbox) {
    step(element, { t: 'disconnect' });
}

function adopted(element: WebSandbox) {
    step(element, { t: 'disconnect' });
    restorePrototype(element);
}

/**
 * Registers `WebSandbox` as a custom element under `tagName` and returns the class. Importing the package
 * registers nothing, so you pick the name. Calling it again with the same name does nothing.
 *
 * @param tagName - The tag name; `'web-sandbox'` when left out. The class can be registered under one name only.
 * @returns The `WebSandbox` class.
 * @throws An `Error` if the name is already defined by another element; the browser's `NotSupportedError` for a second,
 * different name of this class, and its `SyntaxError` for a name that is not a valid custom element name.
 */
export function defineWebSandbox(tagName = 'web-sandbox'): typeof WebSandbox {
    const existing = customElements.get(tagName);
    if (existing && existing !== WebSandbox) throw new Error(`<${tagName}> is already defined by another element`);
    if (!existing) customElements.define(tagName, WebSandbox);
    return WebSandbox;
}
