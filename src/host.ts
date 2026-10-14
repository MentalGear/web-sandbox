import type { CSPDirectives, SafeCapability, UnsafeCapability } from "./csp-directives";
import { SAFE_CAPABILITIES, UNSAFE_CAPABILITIES, UNSAFE_PERMISSIONS } from "./csp-directives";
import { generateCSP } from "./lib/csp/csp-generator";
import { dropSelfSources } from "./lib/csp/drop-self";
import { dropMetaIgnoredDirectives } from "./lib/csp/drop-meta-ignored";
import { addFileSources } from "./lib/csp/file-sources";
import { FileStore, isJavaScriptType, type FileEntry, type FileInfo, type FileSnapshotEntry } from "./lib/files";
import { inSandboxFiles, inSandboxImportMap, inSandboxMarkup } from "./lib/in-sandbox-files";
import { inlineScriptsAllowed, rewriteGuestMarkup, type MarkupParts } from "./lib/markup-references";
import { mergeGuestImportMaps } from "./lib/import-map";
import { deepMerge } from "./lib/utils";
import { inSandboxScript } from "./lib/in-sandbox-script";
import { createBroker, RESERVED_METHOD_PREFIX } from "./lib/rpc";
import { workerBootstrap } from "./lib/worker-bootstrap";
import { filterCapabilities } from "./lib/capabilities";
import { startWatchdog, watchdogBudget, type Watchdog } from "./lib/watchdog";
import { toViolationDetail, VIOLATION_EVENT_LIMIT } from "./lib/violation";
import { startAutoResize, type AutoResizer } from "./lib/auto-resize";
import { createFetchBridge, fetchRefusal, FETCH_METHOD, toFetchPolicy, type FetchBridge, type FetchBridgeConfig, type FetchPolicy, type FetchRecord } from "./lib/fetch-bridge";
import { buildGuestDocument, buildWrapperDocument, FRAME_REFERRER_POLICY, permissionAttributes, toInlineScriptLiteral } from "./lib/frame-documents";
import { buildViewDocument, ENTRY_DONE_NAME, inStrictWorker, viewBootstrapHash, viewBootstrapText, VIEW_EVENT_TYPES, VIEW_RENDER_MAX_LENGTH, VIEW_TARGET_MAX_LENGTH } from "./lib/in-sandbox-view";
import { strictPolicyOverrides, strictViewDirectives } from "./lib/csp/strict-policy";

export interface SandboxConfig {
    connectionsAllowed: CSPDirectives; // Providing a key here will merge with/override the default for that directive.
    // 'unsafe-eval', needed to use .execute method (run arbitrary code in the sandbox). For testing: enabling it
    // logs one warning per instance (backlog S4), since it lets guest code compile strings as code.
    scriptUnsafe?: boolean;
    capabilities?: SafeCapability[]; // Sandbox attributes that keep the guest inside the frame
    unsafeCapabilities?: UnsafeCapability[]; // Capabilities that reach outside the frame (popups, modals, downloads, presentation, fullscreen). Opt-in only, logs a warning.
    html?: string; // Initial HTML content: the guest document in iframe mode, the initial view in strict mode
    // Execution mode. 'strict' (ADR-005): guest code runs only in a worker spawned by a view document that runs
    // no guest script; the worker draws into the view with sandboxView.render().
    mode?: 'iframe' | 'worker' | 'strict';
    // Strict mode: the path of a registered JavaScript file the worker runs first, as a classic script.
    entry?: string;
    workerExecutionTimeout?: number; // Max execution time in ms (worker and strict mode)
    // Liveness watchdog budget in ms (0 = off, the default): terminates a guest that stops answering for this long.
    // Off by default because legitimate synchronous work longer than the budget would be stopped too. See src/lib/watchdog.ts for what it can and cannot bound.
    watchdogTimeout?: number;
    // Content auto-sizing (iframe mode, off by default): the element's height follows the guest's content
    // height, validated, clamped and rate-limited on the host (src/lib/auto-resize.ts). Only a literal true
    // enables it. No effect in worker mode, which has no document (one warning per instance).
    autoResize?: boolean;
    // The host-mediated fetch bridge (off by default): the guest gets sandboxFetch(url, init), and the host makes
    // the request under a fixed discipline (exact-origin allowlist, no credentials, no redirects, capped body
    // and time) and reports each one as a 'fetch' event. The guest policy is unchanged. See src/lib/fetch-bridge.ts.
    fetchBridge?: FetchBridgeConfig;
}

/**
 * Where the element is in its lifecycle (read it from `sandbox.state`):
 *   idle        constructed, or removed from the document: no frame
 *   loading     a frame was created and is waiting for its one load
 *   ready       the port was handed over and 'ready' dispatched
 *   terminated  torn down by terminate(), a frame-integrity check or the watchdog; stays so until
 *               reset(), load() or setConfig() builds a new environment
 * There is deliberately no 'running' state: execute() is fire-and-forget and nothing reports when guest
 * code finishes, so the element could never say truthfully that code is running (or that it stopped).
 */
export type SandboxState = 'idle' | 'loading' | 'ready' | 'terminated';

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
        "worker-src": ["blob:", "data:"]
    },
    scriptUnsafe: false,
    capabilities: [],
    unsafeCapabilities: [],
    html: '',
    mode: 'iframe',
    workerExecutionTimeout: 0,
    watchdogTimeout: 0,
    autoResize: false,
};

// Texts of the host's own refusals, for people reading them. Code branches on the error's `code`
// ('TERMINATED', set by the broker), never on these texts: a guest handler can throw the very same text,
// and that call rejects with code 'HANDLER_ERROR' instead.
const TERMINATED_CALL_MESSAGE = "[Sandbox] call() rejected: the sandbox was terminated. Call reset(), setConfig() or load() to start a new one.";
const RESET_CALL_MESSAGE = "[Sandbox] call() rejected: the sandbox was reset or terminated.";

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

/**
 * Strict mode's view liveness check (A5): always on, independent of watchdogTimeout. The view runs no guest
 * script, so it answers within this budget unless it is gone (Chromium replaces a view whose navigation the
 * wrapper refuses with an error page, research 15 P4) or rendering guest markup keeps its thread busy for
 * that long. Host stalls are never counted (watchdog.ts).
 */
export const VIEW_LIVENESS_TIMEOUT_MS = 5000;

// What the host posts to a strict view with its two ports (INIT_VIEW).
interface StrictInit {
    workerSource: string;
    viewFiles: FileSnapshotEntry[];
    html: string;
    autoResize: boolean;
}

export class WebSandbox extends HTMLElement {
    private _iframe: HTMLIFrameElement | null = null;
    private _frameLoaded = false;
    private _state: SandboxState = 'idle'; // changed only by _enterState()
    private _watchdog: Watchdog | null = null;
    private _resizer: AutoResizer | null = null; // this environment's auto-sizing (B6), or null when off
    private _autoHeight: string | null = null;   // the inline height auto-sizing last wrote on the element
    private _fetchPolicy: FetchPolicy | null = null; // the validated fetchBridge config, or null when off (B5)
    private _fetchBridge: FetchBridge | null = null; // this environment's bridge: its requests end with it
    private _warnedFetchBridge = new Set<string>();  // fetchBridge config warnings, once each per instance
    private _violationCounts = new Map<string, number>(); // 'violation' events dispatched per source for the current environment (capped, violation.ts)
    private _config: SandboxConfig = structuredClone(DEFAULT_SANDBOX_CONFIG);
    private _port: MessagePort | null = null;     // the guest's port: the iframe's bootstrap, or the worker (logic port)
    private _viewPort: MessagePort | null = null; // strict mode: the view's port (violations, resize, entry errors, liveness)
    private _viewWatchdog: Watchdog | null = null; // strict mode: the view liveness check (A5)
    private _strictInit: StrictInit | null = null; // strict mode: what the next frame load hands the view
    private _timeoutId: ReturnType<typeof setTimeout> | null = null;
    private _queuedMessages: { code: string }[] = [];
    private _rpcQueue: unknown[] = []; // the host's own RPC requests waiting for a port (cloned at call time)
    private _warnedUnsafeCapabilities = new Set<string>();
    private _warnedScriptUnsafe = false; // the scriptUnsafe guard rail warns once per instance (S4)
    private _warnedSelfDirectives = new Set<string>(); // directives already warned about for 'self' (drop-self.ts)
    private _warnedMetaIgnored = new Set<string>(); // directives a <meta> policy discards, already warned about (drop-meta-ignored.ts)
    private _warnedFileDirectives = new Set<string>(); // directives already warned about for an explicit 'none' (file-sources.ts)
    private _warnedVirtualFilesUrl = false;
    private _warnedBootstrapRefused = false; // the guest policy refuses the inline bootstrap (S13), once per instance
    private _warnedAutoResizeWorker = false; // autoResize asked for in worker mode, once per instance
    private _warnedGuestMarkup = new Set<string>(); // module-graph warnings about guest markup, once per text (_warnOnce)
    private _warnedStrict = new Set<string>(); // strict-mode config warnings, once each per instance

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
        // The fetch bridge is a library method under a reserved name (B5): expose() can never replace it.
        // Registered once; it refuses while the current environment has no bridge.
        this._broker.exposeReserved(FETCH_METHOD, (request: unknown) => this._handleFetch(request));
    }

    /** Where the sandbox is in its lifecycle; see SandboxState. Agrees with 'ready' / 'terminated' when they fire. */
    get state(): SandboxState {
        return this._state;
    }

    connectedCallback() {
        this.initialize();
    }

    // Removing the element ends its environment: a frame outside the document cannot be used, and keeping
    // its port, timers and watchdog alive would only let pending calls hang. Pending calls reject with
    // TERMINATED. This is not a termination — no 'terminated' event — and re-inserting the element builds
    // a fresh environment through connectedCallback (which also makes moving the element a clean re-init).
    disconnectedCallback() {
        this._teardown();
        this._enterState('idle');
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

    // Partial: anything left out keeps its default (see DEFAULT_SANDBOX_CONFIG)
    setConfig(config: Partial<SandboxConfig>) {

        // ---- Parse and Sanitize Input

        // Filter out any forbidden capabilities that might have been passed
        const sanitizedConfig: Partial<SandboxConfig> = {
            ...config,
            capabilities: filterCapabilities(config.capabilities, SAFE_CAPABILITIES, 'capabilities'),
            unsafeCapabilities: filterCapabilities(config.unsafeCapabilities, UNSAFE_CAPABILITIES, 'unsafeCapabilities'),
        };
        // Only a literal true enables eval: the value is also interpolated into the guest bootstrap.
        if (Object.hasOwn(config, 'scriptUnsafe')) sanitizedConfig.scriptUnsafe = config.scriptUnsafe === true;
        // Likewise for autoResize, which is interpolated into the bootstrap too.
        if (Object.hasOwn(config, 'autoResize')) sanitizedConfig.autoResize = config.autoResize === true;
        // The entry is a registered path or nothing; it is looked up in each build's snapshot.
        if (Object.hasOwn(config, 'entry') && typeof config.entry !== 'string') delete sanitizedConfig.entry;
        // The fetch bridge config is validated into a policy here and kept out of the merged config: a
        // config without it turns the bridge off.
        this._fetchPolicy = toFetchPolicy(config.fetchBridge, (message) => this._warnFetchBridge(message));
        delete sanitizedConfig.fetchBridge;
        this._dropVirtualFilesUrl(sanitizedConfig);

        // apply new config
        this._config = deepMerge(DEFAULT_SANDBOX_CONFIG, sanitizedConfig);
        this._warnAboutUnsafeCapabilities();
        this._warnAboutScriptUnsafe();
        this._warnAboutAutoResizeInWorker();
        this._warnAboutStrictConfig();

        this.initialize();
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

    // Synchronous, once per call that changed something.
    private _dispatchFilesChanged(paths: string[]) {
        if (paths.length === 0) return;
        this.dispatchEvent(new CustomEvent('fileschanged', { detail: { paths } }));
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

    load(html: string) {
        this._config.html = html;
        this.initialize();
    }

    execute(code: string) {
        if (!this._config.scriptUnsafe) {
            console.warn("[Sandbox] execute() blocked: scriptUnsafe is false. Enable it in config to run arbitrary code.");
            return;
        }

        if (this._state === 'terminated') {
            console.warn("[Sandbox] execute() ignored: the sandbox was terminated. Call reset(), setConfig() or load() to start a new one.");
            return;
        }

        if (this._port) {
            this._startTimeout();
            this._port.postMessage({ type: 'EXECUTE', code });
        } else {
            this._queuedMessages.push({ code });
        }
    }

    /**
     * Publishes a host method the guest can invoke with `bridge.call(name, ...)`.
     * Methods live on the element, so they survive frame recreation (load()/setConfig()).
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
     */
    call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        if (this._state === 'terminated') return Promise.reject(this._broker.terminationError(TERMINATED_CALL_MESSAGE));
        return this._broker.call(method, ...args) as Promise<T>;
    }

    /** Like call(), but with an explicit timeout in ms for this one call (0 disables the timeout). */
    callWithTimeout<T = unknown>(timeoutMs: number, method: string, ...args: unknown[]): Promise<T> {
        if (this._state === 'terminated') return Promise.reject(this._broker.terminationError(TERMINATED_CALL_MESSAGE));
        return this._broker.callWithTimeout(timeoutMs, method, ...args) as Promise<T>;
    }

    // Sends one of the host's own RPC requests over the port, or queues it until setupChannel flushes (mirrors execute()).
    private _postRpc(frame: unknown) {
        if (this._port) {
            this._port.postMessage(frame);
            return;
        }
        this._rpcQueue.push(frame);
    }

    private _warnAboutUnsafeCapabilities() {
        if (this._config.mode === 'strict') return; // dropped there instead, with one warning (_warnAboutStrictConfig)
        for (const capability of this._config.unsafeCapabilities || []) {
            if (this._warnedUnsafeCapabilities.has(capability)) continue;
            this._warnedUnsafeCapabilities.add(capability);
            console.warn(`[Sandbox] unsafe capability "${capability}" is enabled: it lets guest content act outside the sandbox.`);
        }
    }

    // The guard rail for scriptUnsafe (backlog S4). It is on in most presets and every e2e spec, so it is the
    // path of least resistance for a copy-paste consumer; one warning per instance says what it costs
    // without repeating on every reset(), load() or setConfig().
    private _warnAboutScriptUnsafe() {
        if (this._config.scriptUnsafe !== true || this._warnedScriptUnsafe) return;
        this._warnedScriptUnsafe = true;
        console.warn("[Sandbox] scriptUnsafe is enabled: the guest policy allows 'unsafe-eval', so guest code can run strings as code (eval, new Function) and execute() runs code in the guest. It exists for testing; leave it off for untrusted content.");
    }

    private _startTimeout() {
        if (this._timeoutId) clearTimeout(this._timeoutId);

        if ((this._config.mode === 'worker' || this._config.mode === 'strict') && this._config.workerExecutionTimeout && this._config.workerExecutionTimeout > 0) {
            this._timeoutId = setTimeout(() => {
                console.warn("[Sandbox] Execution Timeout - Terminating Worker");
                this._dispatchLog({ type: 'LOG', level: 'error', args: ['Execution Timeout'] });

                // the worker lives inside the frame: recreating the frame terminates it
                this.initialize();
            }, this._config.workerExecutionTimeout);
        }
    }

    private setupChannel(target: Window) {
        if (this._port) { this._port.close(); this._port = null; }
        const channel = new MessageChannel();
        const port = channel.port1;
        this._port = port;
        port.onmessage = (e) => this._onGuestMessage(port, e.data, null);

        // An opaque origin cannot be named as targetOrigin, hence '*'.
        // What keeps the port from reaching a foreign document is that this runs exactly once per frame (see _onFrameLoad).
        target.postMessage({ type: 'INIT_PORT' }, '*', [channel.port2]);
        this._flushQueues(port);
    }

    // One frame from the guest's port: the iframe bootstrap's, or (worker and strict mode) the worker's.
    // `source` labels its violation reports in strict mode ('logic'); null elsewhere.
    private _onGuestMessage(port: MessagePort, data: any, source: 'logic' | null) {
        if (data?.type === 'PONG') {
            this._watchdog?.handlePong(data.n); // validated there; only this generation's watchdog is live
            return;
        }
        if (data?.type === 'LOG') {
            this._dispatchLog(data);
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
        this._broker.handleMessage(data, (frame) => port.postMessage(frame));
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
        port.onmessage = (e) => this._onGuestMessage(port, e.data, 'logic');
        viewPort.onmessage = (e) => this._onViewMessage(e.data);

        const init = this._strictInit;
        this._strictInit = null;
        target.postMessage({ type: 'INIT_VIEW', ...init }, '*', [logic.port2, view.port2]);
        this._flushQueues(port);
    }

    private _onViewMessage(data: any) {
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
        if (data?.type === 'GUEST_ERROR') {
            // the worker's own error text (guest-influenced): logged, clamped, never the reason
            const message = typeof data.message === 'string' ? data.message.slice(0, 2048) : '';
            this._dispatchLog({ type: 'LOG', level: 'error', args: [`[Sandbox] ${ENTRY_FAILED_REASON}: ${message}`] });
            this._terminate(ENTRY_FAILED_REASON);
        }
    }

    // Flushes what was queued before the guest's port existed onto it.
    private _flushQueues(port: MessagePort) {
        // Flush any messages queued during initialization
        if (this._queuedMessages.length > 0) {
            const pending = [...this._queuedMessages];
            this._queuedMessages = [];
            pending.forEach(msg => this.execute(msg.code));
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
    private _dispatchLog(detail: unknown) {
        this.dispatchEvent(new CustomEvent('sandbox-log', { detail, bubbles: true }));
    }

    // A CSP violation reported by the guest (backlog S5): dispatched on the element and bubbling, like
    // sandbox-log. The detail is guest-supplied, so it is validated and clamped (violation.ts) and the
    // number of events per environment is capped: past VIOLATION_EVENT_LIMIT reports are dropped, with one
    // warning, so a guest cannot make the host run embedder listeners without bound.
    // In strict mode each port has its own count, labelled by where the report arrived (A6): the view's
    // reports are the library's own, so a worker flooding the logic port can never use up the view's.
    private _dispatchViolation(frame: unknown, source: 'view' | 'logic' | null = null) {
        const key = source ?? '';
        const count = this._violationCounts.get(key) ?? 0;
        if (count > VIOLATION_EVENT_LIMIT) return;
        const detail = toViolationDetail(frame, source ?? undefined);
        if (!detail) return;
        this._violationCounts.set(key, count + 1);
        if (count + 1 > VIOLATION_EVENT_LIMIT) {
            console.warn(`[Sandbox] the guest reported more than ${VIOLATION_EVENT_LIMIT} CSP violations${source ? ` on its ${source} port` : ''}; further ones are not dispatched until the next reset(), load() or setConfig().`);
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

    private _warnAboutAutoResizeInWorker() {
        if (this._config.autoResize !== true || this._config.mode !== 'worker' || this._warnedAutoResizeWorker) return;
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

    // One fetch bridge per environment (B5), built with the environment and aborted by _teardown.
    private _startFetchBridge() {
        if (!this._fetchPolicy) return;
        this._fetchBridge = createFetchBridge({
            policy: this._fetchPolicy,
            hostOrigin: globalThis.location?.origin ?? '',
            onRecord: (record) => this._dispatchFetch(record),
        });
    }

    // The reserved sandbox:fetch method. Every refusal is minted in fetch-bridge.ts with a library code.
    private _handleFetch(request: unknown): Promise<unknown> {
        if (!this._fetchBridge) return Promise.reject(fetchRefusal('FETCH_NOT_ALLOWED', 'the fetch bridge is off (fetchBridge is not configured)'));
        return this._fetchBridge.handle(request);
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
        this._queuedMessages = []; // Clear queue for the old environment
        this._rpcQueue = [];       // same for the host's RPC requests queued for the old environment
        this._violationCounts.clear(); // the violation cap is per environment
        this._strictInit = null;
        // Reject any in-flight calls so their promises never hang once this environment goes away.
        // They reject with code TERMINATED, minted by the broker (see rpc.ts).
        this._broker.rejectAllPending(RESET_CALL_MESSAGE);
        if (this._iframe) { this._iframe.onload = null; this._iframe.remove(); this._iframe = null; }
        if (this._port) { this._port.close(); this._port = null; }
        if (this._viewPort) { this._viewPort.close(); this._viewPort = null; }
        if (this._timeoutId) { clearTimeout(this._timeoutId); this._timeoutId = null; }
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

    // Builds a fresh environment from the current config. Outside the document there is nothing to build
    // into (a detached iframe never loads), so the element stays idle and connectedCallback builds it.
    private initialize() {
        this._teardown();
        if (!this.isConnected) {
            this._enterState('idle');
            return;
        }
        this._enterState('loading');
        this.createIframe();
    }

    private _getSandboxCommsScript(mode: 'iframe' | 'worker', files: FileSnapshotEntry[], plan: GuestMarkupPlan = NO_MARKUP_PLAN) {
        // communication, logs and RPC bridge template that any content running in the sandbox uses.
        // createBroker is stringified in too, so the guest runs the identical dispatcher (see rpc.ts).
        // Opt-in features as one literal, only when one is on (a sandbox without them keeps its bootstrap text).
        const features: { autoResize?: true; fetchBridge?: { timeoutMs: number } } = {};
        if (mode === 'iframe' && this._autoResizeEnabled()) features.autoResize = true;
        if (this._fetchPolicy) features.fetchBridge = { timeoutMs: this._fetchPolicy.timeoutMs };
        const featuresArgument = Object.keys(features).length > 0 ? `, ${toInlineScriptLiteral(features)}` : '';
        const comms = `(${inSandboxScript.toString()})(${this._config.scriptUnsafe}, '${mode}', console, ${createBroker.toString()}${featuresArgument});`;
        // The snapshot is one inline literal, so the blobs exist before the parser reaches guest markup.
        // Installed even with no files (an empty literal): sandboxFiles always exists, and a lookup in
        // an empty store is NOT_FOUND like any other miss, never a ReferenceError.
        let filesCall = `(${inSandboxFiles.toString()})(${toInlineScriptLiteral(files)})`;
        // With JavaScript files: the one import map, registered with the URLs filesCall just created,
        // before any guest markup (module graph, PR3). It hands the files object on to the next step.
        if (plan.importMap) {
            filesCall = `(${inSandboxImportMap.toString()})(${filesCall}, ${toInlineScriptLiteral(plan.importMap.paths)}, ${toInlineScriptLiteral(plan.importMap.guest)})`;
        }
        if (!plan.parts) return `${comms}${filesCall};`;
        // Guest markup that names files: written by the bootstrap's last statement, with the blob: URLs
        // filesCall just created (markup-references.ts). The parts are one more inline literal.
        return `${comms}(${inSandboxMarkup.toString()})(${filesCall}, ${toInlineScriptLiteral(plan.parts)});`;
    }

    private _getWorkerBootstrapScript(files: FileSnapshotEntry[]) {
        // the worker runs the comms script and builds its own blobs and sandboxFiles from the same
        // literal; the frame only spawns it and forwards the port
        const workerSource = this._getSandboxCommsScript('worker', files);
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
        const cloned = dropMetaIgnoredDirectives(structuredClone(
            this._config.connectionsAllowed
        ), this._warnedMetaIgnored);

        cloned["upgrade-insecure-requests"] = true

        // blob: only for the file types in this build's snapshot, each in its own directive (file-sources.ts).
        // No files, no change. Before 'unsafe-eval' and the 'self' drop, so S14 stays the last step.
        // Strict mode: never in script-src (its worker is classic and its view runs no guest script).
        const strict = this._config.mode === 'strict';
        const fileTypes = files.map(entry => entry[1]);
        const directives = addFileSources(cloned, fileTypes, this._warnedFileDirectives, strict ? { exclude: ['script-src'] } : {});

        // Strict mode: the 'self' drop as everywhere, then the view policy, built last from an allowlist
        // (strict-policy.ts): the hash of the one bootstrap, and 'unsafe-eval' only with scriptUnsafe.
        if (strict) return strictViewDirectives(dropSelfSources(directives, this._warnedSelfDirectives), viewBootstrapHash(), this._config.scriptUnsafe === true);

        if (this._config.scriptUnsafe) {
            directives["script-src"]?.push("'unsafe-eval'");
        }

        // The one place every guest policy is built (worker mode inherits this frame's policy), so the
        // guest never gets 'self', whatever the config says: its meaning for an opaque origin differs by
        // engine (drop-self.ts). Done last, so a directive emptied by the drop becomes 'none' only if
        // nothing else was added to it.
        return dropSelfSources(directives, this._warnedSelfDirectives);
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

        const javascript = files.filter(entry => isJavaScriptType(entry[1])).map(entry => entry[0]);
        const markup = rewriteGuestMarkup(html, new Set(files.map(entry => entry[0])), {
            modules: javascript.length > 0,
            onModuleFailure: (index) => this._warnOnce(`[Sandbox] inline module script #${index + 1} in the guest markup could not be lexed, so its relative imports were not rewritten and will fail.`),
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

        // One snapshot per environment build: the policy and the guest's files come from the same one,
        // and later registerFiles() calls reach the guest only through the next build.
        const files = this._files.snapshot();
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
            guestDocument = buildGuestDocument({ csp: generateCSP(directives), bootstrapScript: this._getWorkerBootstrapScript(files), content: '' });
        } else {
            const html = this._config.html || '<div id="root"></div>';
            // A fresh slot nonce per build (inside rewriteGuestMarkup); null parts keep the markup verbatim.
            const plan = this._getMarkupPlan(html, files, sandboxFlags, directives);
            guestDocument = buildGuestDocument({
                csp: generateCSP(directives),
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
            viewFiles: files.filter(candidate => !isJavaScriptType(candidate[1])),
            html: this._config.html || '<div id="root"></div>',
            autoResize: this._autoResizeEnabled(),
        };
        const view = buildViewDocument(generateCSP(directives), viewBootstrapText());

        this._iframe = document.createElement("iframe");
        this._iframe.setAttribute("sandbox", sandboxFlags);
        this._iframe.setAttribute("referrerpolicy", FRAME_REFERRER_POLICY);
        this._iframe.style.cssText = "width:100%;height:100%;border:none";
        this._frameLoaded = false;
        this._iframe.onload = () => this._onFrameLoad();
        this._iframe.srcdoc = buildWrapperDocument(view, sandboxFlags, []);
        this.shadowRoot!.appendChild(this._iframe);
    }

    // The worker's source in strict mode: the comms script (bridge, logs, violations, execute, the fetch
    // bridge), sandboxFiles with every registered file, the strict prelude (hardening, sandboxView, the
    // ports), then the guest's entry as written, then the line that marks the entry as having run to its end.
    private _getStrictWorkerSource(files: FileSnapshotEntry[], entrySource: string): string {
        const features: { fetchBridge?: { timeoutMs: number }; externalPort: true } = { externalPort: true };
        if (this._fetchPolicy) features.fetchBridge = { timeoutMs: this._fetchPolicy.timeoutMs };
        const options = { scriptUnsafe: this._config.scriptUnsafe === true, maxRender: VIEW_RENDER_MAX_LENGTH, maxTarget: VIEW_TARGET_MAX_LENGTH, entryDoneName: ENTRY_DONE_NAME, eventTypes: VIEW_EVENT_TYPES };
        const prelude = '(function () {'
            + `var comms = (${inSandboxScript.toString()})(${this._config.scriptUnsafe === true}, 'strict', console, ${createBroker.toString()}, ${toInlineScriptLiteral(features)});`
            + `(${inSandboxFiles.toString()})(${toInlineScriptLiteral(files)});`
            + `(${inStrictWorker.toString()})(comms, ${toInlineScriptLiteral(options)});`
            + '})();';
        return `${prelude}\n${entrySource}\n;${ENTRY_DONE_NAME}();\n`;
    }

    // Strict-mode configuration the element will not honour, said once per instance each.
    private _warnAboutStrictConfig() {
        const warn = (message: string) => {
            if (this._warnedStrict.has(message)) return;
            this._warnedStrict.add(message);
            console.warn(message);
        };
        if (this._config.mode !== 'strict') {
            if (this._config.entry) warn('[Sandbox] "entry" is used only in strict mode and was ignored.');
            return;
        }
        const unsafe = this._config.unsafeCapabilities || [];
        if (unsafe.length > 0) warn(`[Sandbox] unsafeCapabilities are not available in strict mode and were dropped: ${unsafe.join(', ')}.`);
        for (const message of strictPolicyOverrides(this._config.connectionsAllowed, DEFAULT_SANDBOX_CONFIG.connectionsAllowed)) warn(message);
    }

    // The view liveness check (A5): the view answers VIEW_PING on its port; silence for the budget ends the sandbox.
    private _startViewWatchdog(viewPort: MessagePort) {
        this._viewWatchdog = startWatchdog({
            timeoutMs: VIEW_LIVENESS_TIMEOUT_MS,
            ping: (n) => viewPort.postMessage({ type: 'VIEW_PING', n }),
            onExpire: () => this._terminate(VIEW_LOST_REASON),
        });
    }

    private _onFrameLoad() {
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

        if (this._config.mode === 'strict') this._setupStrictChannels(guestWindow);
        else this.setupChannel(guestWindow);
        // Armed before 'ready' is dispatched: a 'ready' listener that resets or terminates the sandbox then
        // stops this watchdog with the rest, instead of leaving one running for a port that is gone.
        if (this._port) this._startWatchdog(this._port);
        if (this._viewPort) this._startViewWatchdog(this._viewPort);
        // Reports buffered before the port existed arrive after this, so the resizer is in place for them.
        this._startAutoResize();
        this._enterState('ready');
    }
}

/**
 * Registers the element under `tagName` (default `<web-sandbox>`). Safe to call more than once.
 * Importing the library does not register anything, so you can pick your own tag name.
 */
export function defineWebSandbox(tagName = 'web-sandbox'): typeof WebSandbox {
    const existing = customElements.get(tagName);
    if (existing && existing !== WebSandbox) throw new Error(`<${tagName}> is already defined by another element`);
    if (!existing) customElements.define(tagName, WebSandbox);
    return WebSandbox;
}
