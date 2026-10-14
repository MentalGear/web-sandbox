import type { CSPDirectives, SafeCapability, UnsafeCapability } from "./csp-directives";
import { SAFE_CAPABILITIES, UNSAFE_CAPABILITIES, UNSAFE_PERMISSIONS } from "./csp-directives";
import { generateCSP } from "./lib/csp/csp-generator";
import { dropSelfSources } from "./lib/csp/drop-self";
import { dropMetaIgnoredDirectives } from "./lib/csp/drop-meta-ignored";
import { dropEvalSources } from "./lib/csp/drop-eval";
import { dropDataWorkerSources } from "./lib/csp/drop-data-workers";
import { isKnownDirective, sanitizeDirectives } from "./lib/csp/policy-grammar";
import { addFileSources } from "./lib/csp/file-sources";
import { addEvalSource } from "./lib/csp/effective-directive";
import { FALLBACK_TYPE, fileError, FileStore, isJavaScriptType, type FileEntry, type FileInfo, type FileSnapshotEntry } from "./lib/files";
import { createGuestWrites, parseCommitArguments, WRITE_METHOD, type GuestWrite, type GuestWriteAnswer, type GuestWrites } from "./lib/guest-writes";
import { inSandboxFiles, inSandboxImportMap, inSandboxMarkup } from "./lib/in-sandbox-files";
import { inlineScriptsAllowed, kindMismatchMessage, rewriteGuestMarkup, type MarkupParts } from "./lib/markup-references";
import { mergeGuestImportMaps } from "./lib/import-map";
import { deepMerge } from "./lib/utils";
import { ANNOUNCEMENT_TYPE, inSandboxScript } from "./lib/in-sandbox-script";
import { createBroker, RESERVED_METHOD_PREFIX } from "./lib/rpc";
import { workerBootstrap } from "./lib/worker-bootstrap";
import { keepOnlyWorkerGlobals, WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS } from "./lib/worker-globals";
import { filterCapabilities } from "./lib/capabilities";
import { startWatchdog, watchdogBudget, type Watchdog } from "./lib/watchdog";
import { toViolationDetail, VIOLATION_EVENT_LIMIT } from "./lib/violation";
import { createLogLimiter, LOG_EVENTS_PER_SECOND, toLogDetail, type SandboxLogLevel } from "./lib/sandbox-log";
import { startAutoResize, type AutoResizer } from "./lib/auto-resize";
import { createFetchBridge, fetchRefusal, FETCH_METHOD, toFetchPolicy, type FetchBridge, type FetchBridgeConfig, type FetchPolicy, type FetchRecord } from "./lib/fetch-bridge";
import { buildGuestDocument, buildWrapperDocument, FRAME_REFERRER_POLICY, permissionAttributes, toInlineScriptLiteral } from "./lib/frame-documents";
import { assertEntryScoped, buildViewDocument, entryDoneName, inStrictWorker, isViewFileType, viewBootstrapHash, viewBootstrapText, VIEW_EVENT_TYPES, VIEW_MAX_DEPTH, VIEW_MAX_ELEMENTS, VIEW_RENDER_MAX_LENGTH, VIEW_TARGET_MAX_LENGTH } from "./lib/in-sandbox-view";
import { strictPassedThrough, strictPolicyOverrides, strictViewDirectives } from "./lib/csp/strict-policy";

/**
 * The element's configuration, passed to setConfig() as a Partial: every option left out takes its default
 * (DEFAULT_SANDBOX_CONFIG), not its previous value. Reference with defaults and modes: docs/API.md#configuration.
 */
export interface SandboxConfig {
    /**
     * The guest's Content Security Policy. Providing a key here will merge with/override the default for that
     * directive. `[]` means 'none'; 'self' and eval keywords are dropped with a warning (src/lib/csp/).
     */
    connectionsAllowed: CSPDirectives;
    /**
     * 'unsafe-eval', needed to use .execute method (run arbitrary code in the sandbox). For testing: enabling it
     * logs one warning per instance (backlog S4), since it lets guest code compile strings as code.
     * Only a literal `true` enables it. Default false.
     */
    scriptUnsafe?: boolean;
    /** Sandbox attributes that keep the guest inside the frame (SAFE_CAPABILITIES). Default []. */
    capabilities?: SafeCapability[];
    /**
     * Capabilities that reach outside the frame (popups, modals, downloads, presentation, fullscreen). Opt-in
     * only, logs a warning. Dropped in strict mode. Default [].
     */
    unsafeCapabilities?: UnsafeCapability[];
    /**
     * Initial HTML content: the guest document in iframe mode, the initial view in strict mode. Ignored in
     * worker mode. Empty (the default) means `<div id="root"></div>`. load() sets it too.
     */
    html?: string;
    /**
     * Execution mode, default 'iframe'. 'strict' (ADR-005): guest code runs only in a worker spawned by a view
     * document that runs no guest script; the worker draws into the view with sandboxView.render(). Any other
     * value starts no environment: the sandbox terminates until a config names a valid mode.
     */
    mode?: 'iframe' | 'worker' | 'strict';
    /**
     * Strict mode: the path of a registered JavaScript file the worker runs first, as a classic script.
     * Ignored (with a warning) in other modes.
     */
    entry?: string;
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
     * Content auto-sizing (iframe and strict mode, off by default): the element's height follows the guest's content
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
}

/**
 * Where the element is in its lifecycle (read it from `sandbox.state`):
 *   idle        constructed, or removed from the document: no frame
 *   loading     a frame was created and is waiting for its one load
 *   ready       the port was handed over and 'ready' dispatched
 *   terminated  torn down by terminate(), a budget (watchdog, workerExecutionTimeout), a frame-integrity check
 *               or a build that failed; stays so until reset(), load() or setConfig() builds a new environment
 * There is deliberately no 'running' state: nothing the guest reports could make it truthful (execute() reports
 * nothing back, and guest code as a whole never says it is running or that it stopped).
 */
export type SandboxState = 'idle' | 'loading' | 'ready' | 'terminated';

/** The execution modes. Anything else is refused: the sandbox does not start (review A4). */
const SANDBOX_MODES = ['iframe', 'worker', 'strict'] as const;
const isSandboxMode = (mode: unknown): mode is SandboxConfig['mode'] => (SANDBOX_MODES as readonly unknown[]).includes(mode);

const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
    // An empty array means 'none' for every directive (generateCSP, backlog S16), so the defaults list
    // only what they set: a fetch directive left out here falls back to default-src, which is 'none' by
    // default and is the embedder's own value once they set it. Listing connect-src, img-src … as []
    // would pin each to 'none' and silently cut it off from an embedder's default-src.
    connectionsAllowed: {
        "upgrade-insecure-requests": true,
        "default-src": ["'none'"],
        "script-src": ["'unsafe-inline'"], // never 'self': see src/lib/csp/drop-self.ts
        "base-uri": [], // no default-src fallback: 'none' (the guest also inherits an inert base, frame-documents.ts)
        "style-src": ["'unsafe-inline'"],
        "form-action": [], // no default-src fallback: 'none'
        "worker-src": ["blob:"] // never data: (drop-data-workers.ts, broad review PD1): the library's workers are blob:
    },
    scriptUnsafe: false,
    capabilities: [],
    unsafeCapabilities: [],
    html: '',
    mode: 'iframe',
    workerExecutionTimeout: 0,
    watchdogTimeout: 0,
    autoResize: false,
    guestWrites: false,
};

// Texts of the host's own refusals, for people reading them. Code branches on the error's `code`
// ('TERMINATED', set by the broker), never on these texts: a guest handler can throw the very same text,
// and that call rejects with code 'HANDLER_ERROR' instead.
const TERMINATED_CALL_MESSAGE = "[Sandbox] call() rejected: the sandbox was terminated. Call reset(), setConfig() or load() to start a new one.";
const RESET_CALL_MESSAGE = "[Sandbox] call() rejected: the sandbox was reset or terminated.";
const IDLE_CALL_MESSAGE = "[Sandbox] call() rejected: the sandbox is not in the document. Call it once the element is inserted.";

// What the bootstrap writes and registers for one build's guest markup (iframe mode).
interface GuestMarkupPlan {
    // the markup cut into parts for the bootstrap to write (markup-references.ts), or null to embed it as written
    parts: MarkupParts | null;
    // the one import map (module graph, PR3): every registered JavaScript file, plus the guest's own
    // inline maps merged (import-map.ts), or null when no JavaScript file is registered
    importMap: { paths: string[]; guest: string | null } | null;
}

const NO_MARKUP_PLAN: GuestMarkupPlan = { parts: null, importMap: null };

const DEFAULT_TERMINATE_REASON = 'terminated by the host';
const WATCHDOG_REASON = 'the guest stopped responding (watchdog)';
const ENTRY_FAILED_REASON = 'the guest entry failed to start';
const VIEW_LOST_REASON = 'the sandbox view stopped responding';
const EXECUTION_TIMEOUT_REASON = 'the executed code ran longer than workerExecutionTimeout';
const CONFIG_REFUSED_REASON = 'the configuration could not be used';
const BUILD_FAILED_REASON = 'the environment could not be built';
const SECOND_ANNOUNCEMENT_REASON = 'the guest frame announced itself again (it reloaded or rewrote its document)';
const LOAD_TIMEOUT_REASON = 'the sandbox did not finish loading';

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
const workerGlobalsStatement = (global: string) =>
    `(${keepOnlyWorkerGlobals.toString()})(${global}, ${toInlineScriptLiteral(WORKER_GLOBALS)}, ${toInlineScriptLiteral(WORKER_NAVIGATOR_MEMBERS)});`;

// A worker's uncaught error as a guest line, prefixed once: Chromium's ErrorEvent message already starts with
// "Uncaught", Firefox's and WebKit's do not.
const uncaughtLine = (message: string) => (message.startsWith('Uncaught ') ? message : `Uncaught ${message}`);

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
 * (watchdog.ts), so a host stall never counts. A frame that has not loaded by then (and, in iframe and worker mode,
 * announced its port) is terminated with 'the sandbox did not finish loading'. Measured: a guest that calls
 * document.open() and never closes the document held WebKit in `loading` indefinitely. The wrapper's load waits for
 * the guest document's own load, subresources included: a guest page that needs longer than this for its images
 * should load them after it loaded.
 */
export const LOAD_TIMEOUT_MS = VIEW_LIVENESS_TIMEOUT_MS;

// What the host posts to a strict view with its two ports (INIT_VIEW).
interface StrictInit {
    workerSource: string;
    viewFiles: FileSnapshotEntry[];
    html: string;
    autoResize: boolean;
}

/**
 * The `<web-sandbox>` element: one sandboxed environment for untrusted web content, rebuilt by setConfig(),
 * load() and reset(). Register it with defineWebSandbox(). Public surface: docs/API.md.
 */
export class WebSandbox extends HTMLElement {
    private _iframe: HTMLIFrameElement | null = null;
    private _frameLoaded = false;
    // The reversed handshake (broad review 2026-10-14, CB1): the port the guest frame announced, kept unstarted until
    // the build completes; whether this build's guest runs a bootstrap that announces one; and the listener on the
    // host's window, removed by _teardown. Iframe and worker mode only.
    private _announcedPort: MessagePort | null = null;
    private _expectAnnouncement = false;
    private _stopListening: (() => void) | null = null;
    private _loadDeadline: Watchdog | null = null; // LOAD_TIMEOUT_MS while loading (CB3)
    // A build termination being dispatched from initialize(), and the build inputs it was for (CB5): a 'terminated'
    // listener that builds again from the same inputs gets the same answer, so it is not dispatched again.
    private _buildTermination: { reason: string; inputs: number } | null = null;
    private _buildInputs = 0; // counts changes to what a build reads: setConfig(), load(), the files
    private _state: SandboxState = 'idle'; // changed only by _enterState()
    private _watchdog: Watchdog | null = null;
    private _resizer: AutoResizer | null = null; // this environment's auto-sizing (B6), or null when off
    private _autoHeight: string | null = null;   // the inline height auto-sizing last wrote on the element
    private _fetchPolicy: FetchPolicy | null = null; // the validated fetchBridge config, or null when off (B5)
    private _fetchBridge: FetchBridge | null = null; // this environment's bridge: its requests end with it
    private _warnedFetchBridge = new Set<string>();  // fetchBridge config warnings, once each per instance
    // The guest-write overlay (C5): created by each build when guestWrites is on, else null. It outlives its
    // environment's termination (closed, still listable and committable) and is discarded by the next build and on
    // removal (_discardGuestWrites).
    private _guestWrites: GuestWrites | null = null;
    private _violationCounts = new Map<string, number>(); // 'violation' events dispatched per source for the current environment (capped, violation.ts)
    private _logLimiter = createLogLimiter(); // guest 'sandbox-log' events per second for the current environment (sandbox-log.ts)
    private _warnedLogLimit = false;          // the log rate limit warned for the current environment
    // Counts environments: every teardown increments it. Read only by _notifyThenAct, the one path for a host
    // action that dispatches an event and then acts on the environment, so a listener that reset or terminated
    // the sandbox in between is never undone (review B5).
    private _generation = 0;
    private _config: SandboxConfig = structuredClone(DEFAULT_SANDBOX_CONFIG);
    // Why the last setConfig() argument could not be used, or null: while set, every build is refused with
    // this reason (initialize), as for an unknown mode.
    private _configRefusal: string | null = null;
    private _port: MessagePort | null = null;     // the guest's port: the iframe's bootstrap, or the worker (logic port)
    private _viewPort: MessagePort | null = null; // strict mode: the view's port (violations, resize, entry errors, liveness)
    private _viewWatchdog: Watchdog | null = null; // strict mode: the view liveness check (A5)
    private _strictInit: StrictInit | null = null; // strict mode: what the next frame load hands the view
    private _executionTimers = new Set<ReturnType<typeof setTimeout>>(); // workerExecutionTimeout deadlines of this environment
    // Liveness probes started at a deadline (F2): each PING number they sent (negative, so never the watchdog's)
    // → that probe's end. A PONG to any of a probe's pings passes it.
    private _executionProbes = new Map<number, () => void>();
    private _probePings = 0; // numbers the probes' pings: -1, -2, …
    private _queuedMessages: { code: string }[] = [];
    private _rpcQueue: unknown[] = []; // the host's own RPC requests waiting for a port (cloned at call time)
    private _warnedUnsafeCapabilities = new Set<string>();
    private _warnedScriptUnsafe = false; // the scriptUnsafe guard rail warns once per instance (S4)
    private _warnedSelfDirectives = new Set<string>(); // directives already warned about for 'self' (drop-self.ts)
    private _warnedMetaIgnored = new Set<string>(); // directives a <meta> policy discards, already warned about (drop-meta-ignored.ts)
    private _warnedFileDirectives = new Set<string>(); // directives already warned about for an explicit 'none' (file-sources.ts)
    private _warnedEvalDirectives = new Set<string>(); // directives already warned about for an eval keyword (drop-eval.ts)
    private _warnedDataWorkers = new Set<string>(); // directives already warned about for data: workers (drop-data-workers.ts)
    private _warnedPolicy = new Set<string>(); // names and sources the policy grammar dropped, once each (policy-grammar.ts)
    private _warnedVirtualFilesUrl = false;
    private _warnedBootstrapRefused = false; // the guest policy refuses the inline bootstrap (S13), once per instance
    private _warnedAutoResizeWorker = false; // autoResize asked for in worker mode, once per instance
    private _warnedGuestMarkup = new Set<string>(); // module-graph warnings about guest markup, once per text (_warnOnce)
    private _warnedStrict = new Set<string>(); // strict-mode config warnings, once each per instance
    private _warnedForeignDocument = false; // inserted into a document of another realm (CB7), once per instance

    // Files are part of the environment: they live on the element, survive reset(), load(), setConfig()
    // and terminate(), and every environment build takes a snapshot (createIframe). See src/lib/files.ts.
    private _files = new FileStore();

    // One broker lives on the element for its whole life, so host-exposed methods persist across
    // frame recreation (the guest's broker is per-frame and resets with each new frame). Its send only
    // ever carries the host's own requests: it queues them until a port exists, then setupChannel
    // flushes them. Answers to the guest never use it — they go back on the port the request arrived on.
    private _broker = createBroker((frame) => this._postRpc(frame));

    constructor() {
        super();
        this.attachShadow({ mode: "open" });
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
        this._terminate(typeof reason === 'string' ? reason : DEFAULT_TERMINATE_REASON);
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
     * Partial: anything left out keeps its default (see DEFAULT_SANDBOX_CONFIG), not its previous value: `html`
     * included. Values that cannot be used are dropped with a warning before anything is applied.
     */
    setConfig(config: Partial<SandboxConfig>) {
        // A config the element cannot use is a termination with a reason, never a throw that leaves the old
        // environment torn down and no new one built (follow-up audit 2026-10-14): initialize() refuses every
        // build while _configRefusal is set, as it does for an unknown mode (review A4), until a usable config
        // arrives. Nothing of a refused config is applied.
        this._buildInputs++;
        try {
            this._applyConfig(config);
            this._configRefusal = null;
        } catch (error) {
            this._configRefusal = `${CONFIG_REFUSED_REASON} (${errorName(error)})`;
        }
        this.initialize();
    }

    // Parses, sanitizes, checks and stores one setConfig() argument. Throws for a config that cannot be used; then
    // nothing is stored (the fields are assigned last, after every check and warning).
    private _applyConfig(config: Partial<SandboxConfig>) {
        // ---- Copy, then parse and sanitize

        // One structured clone of the whole argument before anything reads it: every check below, and every
        // later build, reads this copy, never the caller's objects. So an array the caller changes after
        // setConfig() never changes the policy a later reset() builds, and a getter or a Proxy cannot answer two
        // reads differently (review A6). What cannot be cloned (a Proxy, a function, a DOM node) throws here.
        const copy: unknown = structuredClone(config);
        if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw new TypeError('setConfig() takes an object');
        const input = copy as Partial<SandboxConfig>;

        // Filter out any forbidden capabilities that might have been passed
        const sanitizedConfig: Partial<SandboxConfig> = {
            ...input,
            capabilities: filterCapabilities(input.capabilities, SAFE_CAPABILITIES, 'capabilities'),
            unsafeCapabilities: filterCapabilities(input.unsafeCapabilities, UNSAFE_CAPABILITIES, 'unsafeCapabilities'),
        };
        // The entry is a registered path or nothing; it is looked up in each build's snapshot.
        if (Object.hasOwn(input, 'entry') && typeof input.entry !== 'string') delete sanitizedConfig.entry;
        // The fetch bridge config is validated into a policy here and kept out of the merged config: a
        // config without it turns the bridge off.
        const fetchPolicy = toFetchPolicy(input.fetchBridge, (message) => this._warnFetchBridge(message));
        delete sanitizedConfig.fetchBridge;
        this._dropVirtualFilesUrl(sanitizedConfig);

        const merged = deepMerge(DEFAULT_SANDBOX_CONFIG, sanitizedConfig);
        // Only a literal true enables eval or auto-sizing: both values are interpolated into the guest bootstrap.
        merged.scriptUnsafe = merged.scriptUnsafe === true;
        merged.autoResize = merged.autoResize === true;
        // Guest writes too: the build reads only this normalised copy.
        merged.guestWrites = merged.guestWrites === true;
        if (typeof merged.entry !== 'string') delete merged.entry;

        // The policy must be a directive object, whatever the mode: anything else could only fail a later step
        // (sanitizeDirectives in the strict warnings, or the build) after the config had been stored.
        const policy = merged.connectionsAllowed as unknown;
        if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new TypeError('connectionsAllowed must be an object of directives');

        // Every check and warning reads the candidate, and only a config that passed them all is stored, last
        // (focused review 2026-10-14, F6: the warnings ran after the assignment, so a config one of them refused,
        // connectionsAllowed: null in strict mode, was stored all the same).
        this._warnAboutUnknownMode(merged);
        this._warnAboutUnsafeCapabilities(merged);
        this._warnAboutScriptUnsafe(merged);
        this._warnAboutAutoResizeInWorker(merged);
        this._warnAboutStrictConfig(merged);
        this._config = merged;
        this._fetchPolicy = fetchPolicy;
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
    private _handleGuestWrite(writes: GuestWrites | null, request: unknown): Promise<GuestWriteAnswer> {
        if (!writes) return refuseGuestWrite();
        let answer: GuestWriteAnswer;
        try {
            answer = writes.handle(request);
        } catch (error) {
            return Promise.reject(error);
        }
        if (answer.change === 'none') return Promise.resolve(answer); // nothing recorded, nothing to announce
        return new Promise((resolve, reject) => {
            this._notifyThenAct(() => this._dispatchFilesWritten(answer.path), () => resolve(answer));
            reject(new Error('[Sandbox] the sandbox was reset or terminated while this write was announced.')); // no-op once resolved
        });
    }

    // One guest change the host recorded: dispatched on the element and bubbling, like the other events a guest
    // causes. At most GUEST_WRITES_PER_SECOND per environment (guest-writes.ts).
    private _dispatchFilesWritten(path: string) {
        this.dispatchEvent(new CustomEvent('fileswritten', { detail: Object.freeze({ paths: Object.freeze([path]) }), bubbles: true }));
    }

    // virtualFilesUrl configured the removed Service-Worker hub (ADR-004). Dropped from the config, with
    // one warning per instance, so an old config keeps working without it.
    private _dropVirtualFilesUrl(config: Partial<SandboxConfig>) {
        if (!Object.hasOwn(config, 'virtualFilesUrl')) return;
        delete (config as Record<string, unknown>).virtualFilesUrl;
        if (this._warnedVirtualFilesUrl) return;
        this._warnedVirtualFilesUrl = true;
        console.warn('[Sandbox] "virtualFilesUrl" is no longer supported and was ignored: register files with registerFiles() and read them in the guest through sandboxFiles (see docs/ADR-004).');
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

        if (this._port) {
            this._postExecute(this._port, code);
        } else {
            this._queuedMessages.push({ code });
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
        if (typeof name === 'string' && name.startsWith(RESERVED_METHOD_PREFIX)) {
            console.warn(`[Sandbox] expose(): names starting with "${RESERVED_METHOD_PREFIX}" are reserved for the library; "${name}" was not exposed.`);
            return;
        }
        this._broker.expose(name, fn);
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
        return this._queuedWhilePending(() => this._broker.call(method, ...args)) as Promise<T>;
    }

    /** Like call(), but with an explicit timeout in ms for this one call (0 disables the timeout). */
    callWithTimeout<T = unknown>(timeoutMs: number, method: string, ...args: unknown[]): Promise<T> {
        const refusal = this._noEnvironmentError();
        if (refusal) return Promise.reject(refusal);
        return this._queuedWhilePending(() => this._broker.callWithTimeout(timeoutMs, method, ...args)) as Promise<T>;
    }

    // The queue holds only calls still waiting for their answer (broad review 2026-10-14, CB3). A call made while
    // loading waits in _rpcQueue for the port; if it settles there first (TIMEOUT), its request leaves the queue with
    // it. Before, it stayed and was sent at the next flush: the method ran after its caller had been told the call
    // timed out, and a caller that retried ran it twice. The broker posts a call's one request synchronously from
    // call(), so the frame queued during `makeCall` is this call's.
    private _queuedWhilePending(makeCall: () => Promise<unknown>): Promise<unknown> {
        const queued = this._rpcQueue.length;
        const promise = makeCall();
        if (this._rpcQueue.length === queued) return promise; // sent at once, or refused before sending
        const frame = this._rpcQueue[this._rpcQueue.length - 1];
        const drop = () => {
            const index = this._rpcQueue.indexOf(frame);
            if (index >= 0) this._rpcQueue.splice(index, 1);
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

    // Sends one of the host's own RPC requests over the port, or queues it until setupChannel flushes (mirrors execute()).
    private _postRpc(frame: unknown) {
        if (this._port) {
            this._port.postMessage(frame);
            return;
        }
        this._rpcQueue.push(frame);
    }

    // A mode the element does not know is refused, never read as the default (review A4): strict mode is a
    // security opt-in, so a misspelt 'Strict' must not quietly give the weaker iframe mode. initialize() then
    // terminates every build with a reason until a config names a valid mode; this says why, once per value.
    private _warnAboutUnknownMode(config: SandboxConfig) {
        const mode = config.mode;
        if (isSandboxMode(mode)) return;
        const message = `[Sandbox] mode ${this._describeMode(mode)} is not one of ${SANDBOX_MODES.join(', ')}: the sandbox will not start until setConfig() names one of them.`;
        if (this._warnedStrict.has(message)) return;
        this._warnedStrict.add(message);
        console.warn(message);
    }

    private _describeMode(mode: unknown): string {
        return typeof mode === 'string' ? JSON.stringify(mode.slice(0, 32)) : `of type ${mode === null ? 'null' : typeof mode}`;
    }

    private _warnAboutUnsafeCapabilities(config: SandboxConfig) {
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
    private _warnAboutScriptUnsafe(config: SandboxConfig) {
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
    // tearing the frame down stops it. Iframe mode has no such budget: the guest document can share the host's
    // thread, so no timer could fire meanwhile.
    private _armExecutionBudget() {
        if (this._config.mode !== 'worker' && this._config.mode !== 'strict') return;
        const budget = watchdogBudget(this._config.workerExecutionTimeout); // a finite number > 0, else off
        if (budget === 0) return;
        const timer = setTimeout(() => {
            this._executionTimers.delete(timer);
            this._probeExecution();
        }, budget);
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
        this._notifyThenAct(() => this._dispatchHostLog('error', 'Execution Timeout'), () => this._terminate(EXECUTION_TIMEOUT_REASON));
    }

    /**
     * The one way the host dispatches an event and then acts on the environment (review B5). Dispatching runs
     * embedder listeners synchronously, and a listener may reset() or terminate() the sandbox; acting afterwards
     * on the environment that is gone would undo what the listener did (rebuild what it terminated, tear down
     * what it just built). So the action runs only if no teardown happened in between: every teardown counts up
     * _generation, and this is the only place that compares it. A path that dispatches and then acts goes through
     * here; none compares the count by hand (test/unit/channel-guarantees.test.ts enumerates them).
     */
    private _notifyThenAct(notify: () => void, act: () => void) {
        const generation = this._generation;
        notify();
        if (generation !== this._generation) return;
        act();
    }

    // The guest's port, announced by the guest frame itself (CB1), becomes this environment's port. Null when this
    // build's guest runs no bootstrap (no allow-scripts, or a policy that refuses it): there is nothing to talk to,
    // and calls wait in the queue until they time out.
    private setupChannel(port: MessagePort | null) {
        if (this._port) { this._port.close(); this._port = null; }
        if (!port) return;
        this._port = port;
        // One reply channel per port: answers go back where their request came from, and the broker counts the
        // calls it runs per channel (review B7), so the count belongs to this environment.
        const reply = (frame: unknown) => port.postMessage(frame);
        // Setting onmessage starts the port: frames the guest posted while the frame loaded are delivered now,
        // after 'ready', as they were when the host handed the port over at this point.
        port.onmessage = (e) => this._onGuestMessage(port, reply, e.data, null);
        this._flushQueues(port);
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
            const guestWindow = iframe.contentWindow?.frames[0];
            if (!guestWindow || event.source !== guestWindow) return;
            const data = event.data;
            if (!data || typeof data !== 'object' || data.type !== ANNOUNCEMENT_TYPE) return;
            event.stopImmediatePropagation(); // the port is the element's: no other listener on this window sees it
            if (accepted || !this._expectAnnouncement || !event.isTrusted || event.ports.length !== 1) {
                this._terminate(SECOND_ANNOUNCEMENT_REASON);
                return;
            }
            accepted = true;
            this._announcedPort = event.ports[0]!;
            this._finishBuild();
        };
        host.addEventListener('message', onMessage, true);
        this._stopListening = () => host.removeEventListener('message', onMessage, true);
    }

    // One frame from the guest's port: the iframe bootstrap's, or (worker and strict mode) the worker's.
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
        const reply = (frame: unknown) => port.postMessage(frame);
        port.onmessage = (e) => this._onGuestMessage(port, reply, e.data, 'logic');
        viewPort.onmessage = (e) => this._onViewMessage(viewPort, e.data);

        const init = this._strictInit;
        this._strictInit = null;
        target.postMessage({ type: 'INIT_VIEW', ...init }, '*', [logic.port2, view.port2]);
        this._flushQueues(port);
    }

    private _onViewMessage(viewPort: MessagePort, data: any) {
        if (!viewPort || viewPort !== this._viewPort) return; // only the current environment's view (review B4)
        if (data?.type === 'VIEW_PONG') {
            this._viewWatchdog?.handlePong(data.n);
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
            // review C1): a guest line like the worker's own 'Uncaught …' lines, rate-limited the same way
            const message = typeof data.message === 'string' ? data.message.slice(0, 2048) : '';
            this._dispatchGuestLog({ level: 'error', args: [uncaughtLine(message)] });
            return;
        }
        if (data?.type === 'GUEST_ERROR') {
            // The entry's own error text is the guest's (it wrote the code, or threw the value): a 'guest' line,
            // clamped and rate-limited like every guest line, never part of the host line or the reason (F3).
            const message = typeof data.message === 'string' ? data.message.slice(0, 2048) : '';
            this._notifyThenAct(() => {
                this._dispatchHostLog('error', `[Sandbox] ${ENTRY_FAILED_REASON}`);
                this._dispatchGuestLog({ level: 'error', args: [uncaughtLine(message)] });
            }, () => this._terminate(ENTRY_FAILED_REASON));
        }
    }

    // Flushes what was queued before the guest's port existed onto it.
    private _flushQueues(port: MessagePort) {
        // Flush any messages queued during initialization
        if (this._queuedMessages.length > 0) {
            const pending = this._queuedMessages;
            this._queuedMessages = [];
            for (const { code } of pending) this._postExecute(port, code); // checked by execute() when queued
        }

        // Flush the host's RPC requests queued before the port existed. After the execute() flush, so that
        // a call() and an expose-via-execute() both issued before ready keep their original wire order.
        this._flushRpcQueue(port);
    }

    // Posts the host's own RPC requests queued while there was no port — the queue never holds answers
    // (those go back on the port their request arrived on). Requests are cloned when the call is made
    // (see callWithTimeout in rpc.ts), so a post failure is not expected here; the per-frame catch is a
    // backstop so that one bad frame could never drop the frames behind it or — since _onFrameLoad
    // dispatches 'ready' only after setupChannel returns — stop 'ready' from firing.
    private _flushRpcQueue(port: MessagePort) {
        const frames = this._rpcQueue;
        this._rpcQueue = [];

        let skipped = 0;
        for (const frame of frames) {
            try {
                port.postMessage(frame);
            } catch {
                skipped++;
            }
        }
        if (skipped > 0) console.warn(`[Sandbox] skipped ${skipped} queued RPC frame(s) that could not be posted (not transferable).`);
    }

    // Log lines are dispatched on the element and bubble, so one event serves both kinds of listener:
    // one on the element hears only its own sandbox, and one on window (the playground, the e2e harness)
    // hears every sandbox and tells them apart by event.target. Not composed: the element sits in the
    // embedding page's DOM, and an event of ours has no business crossing a consumer's shadow boundary.
    // The name stays namespaced because it bubbles: a generic 'log' would collide with other code on window.
    // Every detail is normalised and labelled with where it came from (sandbox-log.ts, review B3), here, from the
    // raw line and its source: no caller can hand this a detail of its own making.
    private _dispatchLog(line: unknown, source: 'guest' | 'host') {
        this.dispatchEvent(new CustomEvent('sandbox-log', { detail: toLogDetail(line, source), bubbles: true }));
    }

    // A LOG frame from the guest's port: normalised, labelled 'guest', and at most LOG_EVENTS_PER_SECOND per
    // environment, so a guest cannot make the host run embedder listeners without bound (one warning).
    private _dispatchGuestLog(frame: unknown) {
        if (!this._logLimiter.admit()) {
            if (this._warnedLogLimit) return;
            this._warnedLogLimit = true;
            console.warn(`[Sandbox] the guest logged more than ${LOG_EVENTS_PER_SECOND} lines in one second; lines past that rate are not dispatched as 'sandbox-log' events.`);
            return;
        }
        this._dispatchLog(frame, 'guest');
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
    // (KNOWN_DIRECTIVES + 1) × VIOLATION_EVENT_LIMIT per environment. The logic port, and iframe and worker mode,
    // keep one count: guest code writes the directive name there, so per-name counts would be guest-chosen.
    private _dispatchViolation(frame: unknown, source: 'view' | 'logic' | null = null) {
        const detail = toViolationDetail(frame, source ?? undefined);
        if (!detail) return;
        const key = source === 'view' ? `view:${isKnownDirective(detail.directive) ? detail.directive : '*'}` : (source ?? '');
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

    // Auto-sizing applies to iframe and strict mode: a worker has no document to measure, a strict view does.
    private _autoResizeEnabled(): boolean {
        return this._config.autoResize === true && this._config.mode !== 'worker';
    }

    private _warnAboutAutoResizeInWorker(config: SandboxConfig) {
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
            this.style.height = value;
            this._autoHeight = value;
        });
    }

    // Gives the height back to the embedder's CSS when auto-sizing is off for the environment being built,
    // removing the inline height only if it is still the one auto-sizing wrote.
    private _releaseAutoHeight() {
        if (this._autoHeight === null) return;
        if (this.style.height === this._autoHeight) this.style.height = '';
        this._autoHeight = null;
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

    private _warnFetchBridge(message: string) {
        if (this._warnedFetchBridge.has(message)) return;
        this._warnedFetchBridge.add(message);
        console.warn(message);
    }

    // The one place `state` changes. The 'ready' and 'terminated' events are dispatched here, after the
    // state is set, so a listener always reads the state its event announces.
    private _enterState(next: SandboxState, reason?: string) {
        this._state = next;
        if (next === 'ready') this.dispatchEvent(new CustomEvent('ready'));
        if (next === 'terminated') this.dispatchEvent(new CustomEvent('terminated', { detail: { reason } }));
    }

    private _teardown() {
        this._generation++;
        this._guestWrites?.close(); // its writes stay listable and committable until the next build (initialize)
        this._logLimiter = createLogLimiter(); // the log rate limit is per environment
        this._warnedLogLimit = false;
        this._queuedMessages = []; // Clear queue for the old environment
        this._rpcQueue = [];       // same for the host's RPC requests queued for the old environment
        this._violationCounts.clear(); // the violation cap is per environment
        this._strictInit = null;
        // Reject any in-flight calls so their promises never hang once this environment goes away.
        // They reject with code TERMINATED, minted by the broker (see rpc.ts).
        this._broker.rejectAllPending(RESET_CALL_MESSAGE);
        if (this._stopListening) { this._stopListening(); this._stopListening = null; }
        if (this._loadDeadline) { this._loadDeadline.stop(); this._loadDeadline = null; }
        if (this._announcedPort) { this._announcedPort.close(); this._announcedPort = null; }
        if (this._iframe) { this._iframe.onload = null; this._iframe.remove(); this._iframe = null; }
        if (this._port) { this._port.close(); this._port = null; }
        if (this._viewPort) { this._viewPort.close(); this._viewPort = null; }
        for (const timer of this._executionTimers) clearTimeout(timer);
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
    // whoever called setConfig() or reset(): a configured string where a directive takes a list
    // ("img-src": "x; script-src *") made generateCSP throw there. Now a refusal known up front (a config that
    // could not be used, an unknown mode) and anything the build throws end the same way: state 'terminated',
    // one 'terminated' event with the reason, nothing half-built (_teardown).
    private initialize() {
        // A 'terminated' listener that builds again (reset(), load()) while the build termination it hears is still
        // being dispatched, from the same inputs, would get the same refusal or failure, and dispatch it again, and
        // recurse until the stack ran out (broad review 2026-10-14, CB5: about 590 dispatches, then a RangeError).
        // That nested build is the same answer: it changes nothing and dispatches nothing. The same answer is known
        // without building when the inputs did not change, or when the refusal they give is the one being dispatched
        // (load() of other markup under an unknown mode). A listener that changes what decides the answer
        // (setConfig() with a usable config, the files for a build that failed) builds normally.
        if (this._buildTermination !== null && (this._buildTermination.inputs === this._buildInputs || this._buildRefusal() === this._buildTermination.reason)) return;
        this._teardown();
        this._discardGuestWrites(); // every build starts without the last environment's uncommitted writes
        if (!this.isConnected) {
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
            this._terminateBuild(`${BUILD_FAILED_REASON} (${errorName(error)})`);
            return;
        }
        if (this._state === 'loading') this._startLoadDeadline();
    }

    // A termination of the build initialize() is making: dispatched once for these inputs (CB5).
    private _terminateBuild(reason: string) {
        const outer = this._buildTermination;
        this._buildTermination = { reason, inputs: this._buildInputs };
        try {
            this._terminate(reason);
        } finally {
            this._buildTermination = outer;
        }
    }

    // `loading` is bounded (CB3): a build that has not completed within LOAD_TIMEOUT_MS of host ticks ends with a
    // reason. A watchdog that nothing answers: it expires after the whole budget, never counting a host stall.
    private _startLoadDeadline() {
        this._loadDeadline = startWatchdog({
            timeoutMs: LOAD_TIMEOUT_MS,
            ping: () => {},
            onExpire: () => this._terminate(LOAD_TIMEOUT_REASON),
        });
    }

    // Why no environment may be built from the current config, or null. Fail closed on a config that could not be
    // used, and on a mode the element does not know (review A4): no environment at all, rather than one of a mode
    // the embedder did not ask for.
    private _buildRefusal(): string | null {
        if (this._configRefusal !== null) return this._configRefusal;
        if (!isSandboxMode(this._config.mode)) return `unknown mode ${this._describeMode(this._config.mode)}`;
        return null;
    }

    private _getSandboxCommsScript(mode: 'iframe' | 'worker', files: FileSnapshotEntry[], plan: GuestMarkupPlan = NO_MARKUP_PLAN) {
        // communication, logs and RPC bridge template that any content running in the sandbox uses.
        // createBroker is stringified in too, so the guest runs the identical dispatcher (see rpc.ts).
        // Opt-in features as one literal, only when one is on (a sandbox without them keeps its bootstrap text).
        const features: { autoResize?: true; fetchBridge?: { timeoutMs: number }; guestWrites?: true } = {};
        if (mode === 'iframe' && this._autoResizeEnabled()) features.autoResize = true;
        if (this._fetchPolicy) features.fetchBridge = { timeoutMs: this._fetchPolicy.timeoutMs };
        if (this._config.guestWrites === true) features.guestWrites = true;
        const featuresArgument = Object.keys(features).length > 0 ? `, ${toInlineScriptLiteral(features)}` : '';
        // Only literals are interpolated: `=== true` here as well, whatever setConfig() stored (review A6).
        const comms = `(${inSandboxScript.toString()})(${this._config.scriptUnsafe === true}, '${mode}', console, ${createBroker.toString()}${featuresArgument})`;
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
        const workerSource = `${workerGlobalsStatement('this')}${this._getSandboxCommsScript('worker', files)}`;
        return `(${workerBootstrap.toString()})(${toInlineScriptLiteral(workerSource)});`;
    }

    private _isPermission(capability: string): boolean {
        return (UNSAFE_PERMISSIONS as readonly string[]).includes(capability);
    }

    private _getSandboxFlags(): string {
        // Strict mode (ADR-005): the view needs scripts for its bootstrap and forms so that `submit` reaches it
        // (to be cancelled; research 15 P4), plus the safe capabilities configured. No unsafe capability.
        if (this._config.mode === 'strict') return [...new Set<string>(['allow-scripts', 'allow-forms', ...(this._config.capabilities || [])])].join(' ');
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

    private _getCSPDirectives(files: FileSnapshotEntry[]): CSPDirectives {
        // Clone the config directives to avoid mutating the original config
        // passing the refs of the original object. Directives a <meta> policy discards (frame-ancestors,
        // report-uri, report-to, sandbox) are dropped first, with a warning: the guest policy is always a
        // <meta> policy, so emitting them would only look like control (drop-meta-ignored.ts, S7).
        // Then the policy grammar (review A1): only known directive names, and only tokens that are one CSP
        // source expression, go on, so every later step sees the tokens the policy will hold and no value can
        // add a directive. generateCSP enforces the same grammar again on whatever reaches it. Then the eval
        // keywords, which only scriptUnsafe grants (review A5).
        const metaApplicable = dropMetaIgnoredDirectives(structuredClone(
            this._config.connectionsAllowed
        ), this._warnedMetaIgnored);
        const grammatical = sanitizeDirectives(metaApplicable, (message) => this._warnPolicy(message));
        // Then data: for worker loads, which WebKit runs outside the guest policy (drop-data-workers.ts, PD1).
        const cloned = dropDataWorkerSources(dropEvalSources(grammatical, this._config.scriptUnsafe === true, this._warnedEvalDirectives), this._warnedDataWorkers);

        cloned["upgrade-insecure-requests"] = true

        // blob: only for the file types in this build's snapshot, each in the directive that governs its kind of
        // load in this policy (file-sources.ts, effective-directive.ts). No files, no change. Before 'unsafe-eval'
        // and the 'self' drop, so S14 stays the last step.
        // Strict mode: only the directives the view will hold are asked which one governs a load
        // (strictPassedThrough), and never for scripts (its worker is classic and its view runs no guest script).
        const strict = this._config.mode === 'strict';
        const fileTypes = files.map(entry => entry[1]);
        if (strict) {
            // A type the view mints no URL for (isViewFileType, broad review ST1) is only fetched, by the worker.
            const viewTypes = fileTypes.map(type => (isViewFileType(type) ? type : FALLBACK_TYPE));
            const viewSources = addFileSources(strictPassedThrough(cloned), viewTypes, this._warnedFileDirectives, { exclude: ['script-src-elem'] });
            // the 'self' drop as everywhere, then the view policy, built last from an allowlist (strict-policy.ts):
            // the hash of the one bootstrap, and 'unsafe-eval' only with scriptUnsafe.
            return strictViewDirectives(dropSelfSources(viewSources, this._warnedSelfDirectives), viewBootstrapHash(), this._config.scriptUnsafe === true);
        }
        const directives = addFileSources(cloned, fileTypes, this._warnedFileDirectives);

        // String compilation is checked against script-src, then default-src (effective-directive.ts, 'eval'):
        // addEvalSource is the one writer of the keyword, and never puts it in default-src (focused review F5).
        const withEval = this._config.scriptUnsafe === true ? addEvalSource(directives) : directives;

        // The one place every guest policy is built (worker mode inherits this frame's policy), so the
        // guest never gets 'self', whatever the config says: its meaning for an opaque origin differs by
        // engine (drop-self.ts). Done last, so a directive emptied by the drop becomes 'none' only if
        // nothing else was added to it.
        return dropSelfSources(withEval, this._warnedSelfDirectives);
    }

    // What the bootstrap does with this build's guest markup (GuestMarkupPlan): references to registered
    // files cut into parts for it to write (markup-references.ts) and, with JavaScript files, the one
    // import map (module graph). Only when the bootstrap can run — scripts allowed by the sandbox flags
    // and inline scripts by the policy — since otherwise nothing would write the markup or register the
    // map; references then stay as written and fail closed, and so do relative imports between modules.
    private _getMarkupPlan(html: string, files: FileSnapshotEntry[], sandboxFlags: string, directives: CSPDirectives): GuestMarkupPlan {
        if (files.length === 0) return NO_MARKUP_PLAN;
        if (!sandboxFlags.split(' ').includes('allow-scripts')) return NO_MARKUP_PLAN;
        if (!inlineScriptsAllowed(directives)) return NO_MARKUP_PLAN;

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

    // The guarantees that live in the guest bootstrap — WebRTC removed from the guest realm (S13), violation
    // reports (S5), the bridge and sandboxFiles — hold only where it runs. It is an inline script, so a policy
    // that refuses inline scripts while the sandbox flags allow scripts lets guest scripts from allowlisted
    // origins run without it. Said once per instance, since only the embedder's config can cause it.
    private _warnIfBootstrapRefused(sandboxFlags: string, directives: CSPDirectives) {
        if (this._warnedBootstrapRefused) return;
        if (!sandboxFlags.split(' ').includes('allow-scripts') || inlineScriptsAllowed(directives)) return;
        this._warnedBootstrapRefused = true;
        console.warn("[Sandbox] the guest policy refuses inline scripts, so the sandbox bootstrap cannot run: guest scripts would run with no bridge, no sandboxFiles, no violation reports, and with WebRTC available. Keep 'unsafe-inline' in script-src (without nonces or hashes).");
    }

    // What the policy grammar dropped (policy-grammar.ts): the same config is built again on every reset(),
    // load() or setConfig(), so each message is said once per element.
    private _warnPolicy(message: string) {
        if (this._warnedPolicy.has(message)) return;
        this._warnedPolicy.add(message);
        console.warn(message);
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
        const directives = this._getCSPDirectives(files);
        this._warnIfBootstrapRefused(sandboxFlags, directives);

        // TODO: run through DOMPurify ?
        let guestDocument: string;
        if (isWorkerMode) {
            // worker mode is headless: no guest markup, so no markup references either
            guestDocument = buildGuestDocument({ csp: generateCSP(directives, (message) => this._warnPolicy(message)), bootstrapScript: this._getWorkerBootstrapScript(files), content: '' });
        } else {
            const html = this._config.html || '<div id="root"></div>';
            // A fresh slot nonce per build (inside rewriteGuestMarkup); null parts keep the markup verbatim.
            const plan = this._getMarkupPlan(html, files, sandboxFlags, directives);
            guestDocument = buildGuestDocument({
                csp: generateCSP(directives, (message) => this._warnPolicy(message)),
                bootstrapScript: this._getSandboxCommsScript('iframe', files, plan),
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
        this._iframe.onload = () => this._onFrameLoad();

        // srcdoc goes in before the frame is inserted: an iframe inserted without one first
        // loads about:blank, which would count as the frame's one load (see _onFrameLoad)
        this._iframe.srcdoc = buildWrapperDocument(guestDocument, sandboxFlags, permissions);
        // The guest announces its port from its first statement (CB1), so the listener is in place before the frame
        // exists. A bootstrap runs, and announces, exactly where the inline script can run (_getMarkupPlan's test).
        this._expectAnnouncement = sandboxFlags.split(' ').includes('allow-scripts') && inlineScriptsAllowed(directives);
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
            if (!file || !isJavaScriptType(file[1])) {
                this._terminate(`the guest entry "${entry.slice(0, 256)}" is not a registered JavaScript file`);
                return;
            }
            entrySource = new TextDecoder().decode(Uint8Array.from(atob(file[2]), c => c.charCodeAt(0)));
        }

        const sandboxFlags = this._getSandboxFlags();
        const directives = this._getCSPDirectives(files);
        this._strictInit = {
            workerSource: this._getStrictWorkerSource(files, entrySource),
            viewFiles: files.filter(candidate => isViewFileType(candidate[1])), // never a type that opens as a document (broad review ST1)
            html: this._config.html || '<div id="root"></div>',
            autoResize: this._autoResizeEnabled(),
        };
        const view = buildViewDocument(generateCSP(directives, (message) => this._warnPolicy(message)), viewBootstrapText());

        this._iframe = document.createElement("iframe");
        this._iframe.setAttribute("sandbox", sandboxFlags);
        this._iframe.setAttribute("referrerpolicy", FRAME_REFERRER_POLICY);
        this._iframe.style.cssText = "width:100%;height:100%;border:none";
        this._frameLoaded = false;
        this._iframe.onload = () => this._onFrameLoad();
        this._iframe.srcdoc = buildWrapperDocument(view, sandboxFlags, []);
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
        const features: { fetchBridge?: { timeoutMs: number }; externalPort: true; guestWrites?: true } = { externalPort: true };
        if (this._fetchPolicy) features.fetchBridge = { timeoutMs: this._fetchPolicy.timeoutMs };
        if (this._config.guestWrites === true) features.guestWrites = true;
        const marker = entryDoneName(); // drawn per build: an entry cannot declare a binding of its name (broad review ST4)
        const options = { scriptUnsafe: this._config.scriptUnsafe === true, maxRender: VIEW_RENDER_MAX_LENGTH, maxTarget: VIEW_TARGET_MAX_LENGTH, maxElements: VIEW_MAX_ELEMENTS, maxDepth: VIEW_MAX_DEPTH, entryDoneName: marker, eventTypes: VIEW_EVENT_TYPES };
        const prelude = '(function (g) {'
            + `(${assertEntryScoped.toString()})(g);`
            + workerGlobalsStatement('g')
            + `var comms = (${inSandboxScript.toString()})(${this._config.scriptUnsafe === true}, 'strict', console, ${createBroker.toString()}, ${toInlineScriptLiteral(features)});`
            + `(${inSandboxFiles.toString()})(${toInlineScriptLiteral(files)}${this._config.guestWrites === true ? ', comms.writeFiles' : ''});`
            + `(${inStrictWorker.toString()})(comms, ${toInlineScriptLiteral(options)});`
            + '})(this);';
        return `${prelude}\n(function () {\n${entrySource}\n}).call(this);\n${marker}();\n`;
    }

    // Strict-mode configuration the element will not honour, said once per instance each.
    private _warnAboutStrictConfig(config: SandboxConfig) {
        const warn = (message: string) => {
            if (this._warnedStrict.has(message)) return;
            this._warnedStrict.add(message);
            console.warn(message);
        };
        if (config.mode !== 'strict') {
            if (config.entry) warn('[Sandbox] "entry" is used only in strict mode and was ignored.');
            return;
        }
        const unsafe = config.unsafeCapabilities || [];
        if (unsafe.length > 0) warn(`[Sandbox] unsafeCapabilities are not available in strict mode and were dropped: ${unsafe.join(', ')}.`);
        // Compared in the grammar's tokens (policy-grammar.ts): a name the grammar drops is warned about there.
        for (const message of strictPolicyOverrides(sanitizeDirectives(config.connectionsAllowed), sanitizeDirectives(DEFAULT_SANDBOX_CONFIG.connectionsAllowed))) warn(message);
    }

    // The view liveness check (A5): the view answers VIEW_PING on its port; silence for the budget ends the sandbox.
    private _startViewWatchdog(viewPort: MessagePort) {
        this._viewWatchdog = startWatchdog({
            timeoutMs: VIEW_LIVENESS_TIMEOUT_MS,
            ping: (n) => viewPort.postMessage({ type: 'VIEW_PING', n }),
            onExpire: () => this._terminate(VIEW_LOST_REASON),
        });
    }

    // The second half of a build, run on the wrapper's one load: like createIframe(), anything it throws ends the
    // sandbox with a reason instead of leaving it 'loading' (initialize).
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
            this._terminate('the sandbox frame loaded a second time');
            return;
        }
        this._frameLoaded = true;

        const guestWindow = this._iframe?.contentWindow?.frames[0];
        if (!guestWindow) {
            this._terminate('the guest frame is missing');
            return;
        }

        if (this._config.mode === 'strict') {
            this._setupStrictChannels(guestWindow);
            this._enterReady();
            return;
        }
        this._finishBuild();
    }

    // Iframe and worker mode: the build completes once the wrapper has loaded and, where this build's guest runs a
    // bootstrap, the guest has announced its port (CB1), in whichever order the two arrive. Called by both; acts
    // once, when the second of them arrives. Anything it throws ends the sandbox, as in _onFrameLoad.
    private _finishBuild() {
        if (!this._frameLoaded || this._state !== 'loading') return;
        if (this._expectAnnouncement && !this._announcedPort) return;
        try {
            const port = this._announcedPort;
            this._announcedPort = null;
            this.setupChannel(port);
            this._enterReady();
        } catch (error) {
            this._terminate(`${BUILD_FAILED_REASON} (${errorName(error)})`);
        }
    }

    private _enterReady() {
        if (this._loadDeadline) { this._loadDeadline.stop(); this._loadDeadline = null; }
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

// An environment is built only in the document of the realm that defined the element. In another document (an
// iframe's, one made with document.implementation) the guest would announce itself to that document's window, which
// the element does not listen to (Chromium and WebKit built a bridge that never connected), and in Firefox the
// element has lost its methods. So it stays idle there, with one warning, until it is back in its own document.
function connected(element: WebSandbox) {
    if (element.ownerDocument !== document) {
        stop(element);
        const own = element as unknown as { _warnedForeignDocument: boolean };
        if (own._warnedForeignDocument) return;
        own._warnedForeignDocument = true;
        console.warn('[Sandbox] the element was inserted into a document of another window: it builds no environment there. Insert it into the document of the window that defined it.');
        return;
    }
    // Back in its own document after Firefox replaced its prototype: give it back, so its methods exist again.
    if (Object.getPrototypeOf(element) !== WebSandbox.prototype) {
        try {
            Object.setPrototypeOf(element, WebSandbox.prototype);
        } catch {
            return; // the engine refuses: the element stays idle (stop() ran when it left)
        }
    }
    Reflect.apply(LIFECYCLE.initialize, element, []);
}

function disconnected(element: WebSandbox) {
    stop(element);
}

function adopted(element: WebSandbox) {
    stop(element);
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
