/**
 * The `<web-sandbox>` custom element: it builds sealed mode's frames, holds the host end of every port, and applies the
 * lifecycle reducer's effects (lifecycle.ts) to the DOM. What strict, cooperative and worker mode add to it are methods
 * the network build installs on its prototype (lib/network-host.ts; ADR-009), which it calls through the seam
 * (lib/network-modes.ts): a build without them has none.
 */
import type { SafeCapability } from "./csp-directives";
import { fileKinds, SEALED_FILE_KINDS, sealedViewPolicy } from "./lib/csp/csp-generator";
import { buildRefused, trustedTypesStance, type TrustedTypesMode, type TrustedTypesStance } from "./lib/csp/host-trusted-types";
import { NO_ORIGINS, type OriginKind, type OriginPolicy } from "./lib/csp/origin-kinds";
import { FALLBACK_TYPE, fileError, FileStore, isJavaScriptType, viewStylesheets, type FileEntry, type FileInfo, type FileSnapshotEntry } from "./lib/files";
import { createGuestWrites, parseCommitArguments, WRITE_METHOD, type GuestWrite, type GuestWriteAnswer, type GuestWrites, type MintedWrites } from "./lib/guest-writes";
import { inSandboxFiles } from "./lib/in-sandbox-files";
import { LOAD_KINDS } from "./lib/load-kinds";
import { ANNOUNCEMENT_TYPE, inSandboxScript } from "./lib/in-sandbox-script";
import { crossingText, mintError, mintUncodedError } from "./lib/minted-errors";
import { createBroker, type BudgetRefusal } from "./lib/rpc";
import { LINK_WINDOW_FEATURES, listedLink } from "./lib/links";
import { createSizeOf } from "./lib/structured-size";
import { keepOnlyWorkerGlobals, removeSecureContextOnly, SEALED_WORKER_GLOBALS, SECURE_CONTEXT_ONLY, STRICT_WORKER_GLOBALS, STRICT_WORKER_NAVIGATOR_MEMBERS, WORKER_NAVIGATOR_MEMBERS, workerGlobalsFor } from "./lib/worker-globals";
import { dynamicImportAt } from "./lib/entry-imports";
import { CODE_FROM_STRING_REFUSAL, FUNCTION_KINDS_SOURCE, REFUSED_GLOBALS, REFUSED_TIMERS, refuseCodeFromStrings } from "./lib/code-from-strings";
import { startWatchdog, watchdogBudget } from "./lib/watchdog";
import { createRateLimiter, type RateLimiter } from "./lib/rate-limit";
import { toViolationDetail, VIOLATION_EVENT_FIELDS, VIOLATION_EVENT_LIMIT, violationBucket, type SandboxViolation } from "./lib/violation";
import { createLogLimiter, LOG_MAX_BYTES, LOG_OWN_LINES, toLogDetail, type SandboxLog, type SandboxLogLevel } from "./lib/sandbox-log";
import { startAutoResize } from "./lib/auto-resize";
import { fetchRefusal, FETCH_METHOD } from "./lib/fetch-method";
import { networkModes, type FetchHandler, type NetworkElement, type PreparedBuild, type StrictInit, type ViewNetwork } from "./lib/network-modes";
import { buildWrapperDocument, setWrapperFrameIsolation, toInlineScriptLiteral, WRAPPER_STYLE } from "./lib/frame-documents";
import { scriptHashSource } from "./lib/csp/script-hash";
import { browserHasTrustedTypes, setLibrarySrcdoc, TRUSTED_TYPES_POLICY, TrustedTypesRefusal } from "./lib/trusted-types";
import { admitGuestCall, DEFAULT_CALL_BUDGET, defaultConfig, hasStrictView, NO_HOST_PAGE, STRICT_VIEW_FLAGS, unknownModeReason, type AppOptionName, type CallBudget, type EmbedderOptionName, type StoredConfig } from "./lib/config-schema";
import { readStart, type StartValues } from "./lib/app-start";
import type { Holds } from "./lib/utils";
import { bootstrapListeners, UNCAUGHT_BUDGET, type BootstrapListener } from "./lib/egress";
import { elementEvent } from "./lib/element-events";
import { detachEnvironment, releaseEnvironment, type EnvironmentFields } from "./lib/environment";
import { errorName, hostLine, reasonText } from "./lib/reasons";
import { ENVIRONMENT_CHECKS, ENVIRONMENT_EXPECTED, ENVIRONMENT_REFUSED_TYPE } from "./lib/environment-check";
import { INITIAL_LIFECYCLE, runNotices, step as runStep, type BuildContext, type Generation, type LcInput, type LcState, type LifecycleHost, type Notice } from "./lib/lifecycle";
import { assertEntryScoped, buildViewDocument, entryDoneName, inStrictWorker, STRICT_DIRECTIVE, isStyleProperty, isViewFileType, VIEW_FILE_TYPES, viewBootstrapHash, viewBootstrapText, VIEW_EVENT_LIMITS, VIEW_EVENT_TYPES, VIEW_MAX_CHARACTERS, VIEW_SET_STYLE_LIMITS, VIEW_STYLE_PROPERTIES, VIEW_MAX_DEPTH, VIEW_MAX_DISTINCT_URLS, VIEW_MAX_ELEMENTS, VIEW_MAX_URLS, VIEW_OPTIONS, VIEW_RENDER_MAX_LENGTH, VIEW_STILL_STYLE, VIEW_TARGET_MAX_LENGTH, VIEW_WRITE_TYPES } from "./lib/in-sandbox-view";

/**
 * The options of one of the modes the build has ({@link SandboxConfigByMode}), the app's and the embedder's together: a
 * union keyed by `mode`. `start()` takes them as two arguments, {@link SandboxApp} and {@link SandboxGrants}.
 *
 * @remarks
 * Every option left out takes its default. The union narrows each mode, so an option a mode cannot use does not
 * type-check (a sealed config takes no `origins` and no `fetchBridge`). Options from JSON are held to the same rules at
 * run time: an option outside its modes is ignored and holds its default, mostly with one warning, and a mode or an
 * option the build does not have makes `start()` throw, with a message that names the fix. Options that name no `mode`
 * are sealed mode's (sealed is the default; ADR-008). Defaults, bounds and modes of every option:
 * docs/API.md#configuration.
 */
export type SandboxConfig = SandboxConfigByMode[keyof SandboxConfigByMode];

/**
 * The configuration of each mode this build of the package has, by the mode's name.
 *
 * @remarks
 * The package as published has sealed mode alone. A build with the network modes (ADR-009; docs/API.md#builds) adds
 * strict, cooperative and worker mode here, with their configurations, so that {@link SandboxConfig} is what the build
 * takes and nothing else type-checks.
 */
export interface SandboxConfigByMode {
    /** Sealed mode, the default: no network ({@link SealedSandboxConfig}). */
    sealed: SealedSandboxConfig;
}

/**
 * The configuration of sealed mode, the default (ADR-008): strict mode with no network. Guest code runs only in a worker
 * that a view document spawns, as in strict mode, and the view's policy admits no network source: every fetch directive
 * is `'none'` or `blob:` for registered files, and `connect-src` is `'none'`.
 *
 * @remarks
 * A config that names no `mode` is a sealed config. A sealed config that names `origins` or `fetchBridge`, with the mode
 * written or left out, does not type-check, and from JSON `start()` throws, with a message that names the fix,
 * `mode: 'strict'`. `sandboxFetch()` rejects with `FETCH_NOT_ALLOWED`.
 */
export interface SealedSandboxConfig extends SandboxConfigOptions {
    /**
     * Names the mode; sealed when left out. A value that is not a mode starts no environment: the sandbox terminates
     * with a reason that names it (AR:A4).
     */
    mode?: 'sealed';
    /** Not in sealed mode, which has no network: `start()` throws for grants that name it. */
    origins?: never;
    /** Not in sealed mode, which has no network: `start()` throws for grants that name it. */
    fetchBridge?: never;
    /**
     * Not in sealed mode, which runs no string as code: `true` makes `start()` throw.
     *
     * @remarks
     * A string run as code is checked against the host page's policy, which the guest's worker inherits; a policy that
     * refuses it reports the refusal with the page's policy text, and to the page's report endpoint with a sample of the
     * string. So in sealed mode `eval`, `Function`, the other function constructors and a timer given a string throw
     * the library's `EvalError` before the browser sees the string. Strict mode keeps the option, for testing.
     *
     * @defaultValue `false`
     */
    scriptUnsafe?: false;
    /** Not in sealed mode: no capability reaches outside the view. Dropped at run time. */
    unsafeCapabilities?: never;
}

/**
 * A host method the guest calls with `bridge.call(name, ...args)`, given to `start()` in {@link SandboxGrants}. Its
 * arguments are the guest's data, so they are `unknown`: check each one's type and size before you use it. They never
 * hold a `Blob` or a `File`: a call that holds one, at any depth, is refused `ARGS_NOT_TRANSFERABLE` before the method
 * runs (I7).
 *
 * @remarks
 * It runs with your page's rights. The guest receives its return value (awaited if it is a promise), copied: a typed
 * array or `DataView` that covers part of its buffer arrives with a buffer that holds exactly its bytes.
 *
 * What a failure tells the guest: a throw or rejection reaches it as `HANDLER_ERROR`, and its text is your own words
 * only. The guest receives the message of a plain `Error` your code made (`throw new Error(text)`, whose prototype is
 * this window's `Error.prototype`) or a thrown string, verbatim up to 65536 characters (a longer one is cut, and ends
 * `[… cut at 65536 characters]`): put nothing in it you would not show the guest. An error of the library's that the
 * method lets through (a refusal of `commitGuestWrites()`, of its own `call()` to this guest or another element's, a
 * `TypeError` of `start()`) arrives as its code and the library's fixed text for that code (`INVALID_PATH: …`;
 * `the method failed (TypeError)` for one without a code), never its message, which quotes what you gave the library
 * or what another app answered. Any other throw (an engine's `TypeError` or `SyntaxError` from `JSON.parse`, a
 * `DOMException`, a subclass of `Error`, an error from another window, an object) arrives as
 * `the method failed (<name>)` with its name only, because an engine's message quotes the data it was handling. A
 * result that cannot be copied is refused `RESULT_NOT_TRANSFERABLE` with the library's own text. Each text the guest does not receive is
 * written to this page's console with `console.warn`, once per call.
 *
 * The methods belong to the app: they stay through `reset()`, `terminate()` and the element's removal, for the
 * element's whole life. A method that started keeps running after `terminate()`, `reset()` or the element's removal:
 * only its answer is dropped. One that writes should check a flag you set when you stop the app, right before the
 * write. The arguments are the guest's data: validate them, and copy objects with spread rather than `Object.assign` or
 * a `for...in` loop (an own `__proto__` key survives the copy). Guest-controlled text: show it with `textContent`,
 * never in an HTML, URL (such as a link `href`), `eval`, template or `console` format-string sink.
 */
export type HostMethod = (...args: unknown[]) => unknown;

/**
 * The app `start()` runs: its own content, what its author wrote. It may come from data, such as a bundle you stored:
 * a grant in it is refused, so it carries none by accident. Every option the embedder decides is in
 * {@link SandboxGrants}, the second argument.
 *
 * @remarks
 * `html` and `entry` are the options of the same names ({@link SandboxConfigOptions}). In strict and sealed mode an
 * `entry` must name a JavaScript file of `files`; any other key, the grants' own included, is refused.
 */
export interface SandboxApp extends Readonly<Pick<SandboxConfigOptions, 'html' | 'entry'>> {
    /**
     * The app's files by path, validated as one batch and copied into the element's store. The guest reads them through
     * `sandboxFiles`, and its markup names them by path. An entry is a `string` (stored as UTF-8), a `Uint8Array`
     * (copied), or `{ content, type }` to set the MIME type instead of deriving it from the extension.
     *
     * @remarks
     * - A path is relative (`src/main.js`): segments of letters, digits and the characters of `._~!$&'()*+,;=@-`,
     *   separated by single slashes, at most 256 characters, no `.` or `..` segment. Paths are checked, never normalised;
     *   a refusal's message names the rule the path breaks. A refusal is a {@link FileError} with `code`
     *   `INVALID_PATH`, `INVALID_FILE` or `FILES_QUOTA_EXCEEDED`, and nothing is stored.
     * - A file's type comes from its extension (`.js` and `.mjs` `text/javascript`, `.css` `text/css`, `.json`
     *   `application/json`, `.svg` `image/svg+xml`, `.png`, `.woff2`, `.mp4` and the like); an unknown extension is
     *   `application/octet-stream`.
     * - A reference names a file only for the kind of load its type is for: `<script src>`, `modulepreload`,
     *   `preload as=script` and module imports only JavaScript types; a stylesheet `<link>`, `preload as=style` and
     *   `@import` only `text/css`; `img`, `srcset`, `poster`, icon links and CSS `url()` only `image/*`; `url()` in
     *   `@font-face` and `preload as=font` only `font/*`; `audio`, `video` and `source` only `audio/*` and `video/*`;
     *   `track` only `text/vtt`. A reference to a file of another type stays as written and fails closed, with one
     *   warning (strict and sealed mode's view drops it: docs/API.md#the-url-rule). This holds for the app's files as
     *   for committed ones: `x.js` given as `text/plain` is never a script. Code that passes `sandboxFiles.url()` to a
     *   script element or `importScripts()` itself decides what it loads (Chromium runs such a file whatever its type;
     *   Firefox and WebKit refuse it in `importScripts()`).
     * - The files change only through the app's own committed writes (`commitGuestWrites()`), and every build delivers
     *   them as they are then. How the guest names files (markup, module imports, stylesheets) is described in the
     *   README's Files section; why: ADR-004.
     *
     * @defaultValue none
     */
    readonly files?: Readonly<Record<string, FileEntry>>;
}

/**
 * What the embedder allows the app `start()` runs: the host methods, and every option that is not the app's own
 * ({@link SandboxApp}), for the modes this build has, keyed by `mode` as {@link SandboxConfig} is.
 *
 * @remarks
 * A grant is whatever you pass as this argument. The two arguments keep an app read from data from carrying a grant by
 * accident; nothing stops you from passing a stored manifest here, and then its author chooses the grants. Write them
 * in your own code. A key of the app's, or one that is no option, is refused.
 */
export type SandboxGrants = {
    [Mode in keyof SandboxConfigByMode]: Readonly<Omit<SandboxConfigByMode[Mode], keyof SandboxApp>> & {
        /**
         * The host methods the guest may call, by name: own enumerable keys, each a name of at most 256 characters that
         * does not start with `sandbox:`, each value a function. Copied when `start()` is called: a name not listed
         * here is `UNKNOWN_METHOD` to the guest.
         */
        readonly methods?: Readonly<Record<string, HostMethod>>;
    };
}[keyof SandboxConfigByMode];

// The two types against the schema's classification (CONFIG_SCHEMA's `owner`; I17): written out for the API report, and
// held to the value here, so that neither can drift from it.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : { differ: [A, B] }) : { differ: [A, B] };
type AppOptionsAreTheSchemas = Holds<Same<Exclude<keyof SandboxApp, 'files'>, AppOptionName>>;
type GrantsAreTheSchemas = Holds<Same<Exclude<keyof SealedSandboxConfig, keyof SandboxApp>, EmbedderOptionName>>;

/**
 * The events the element dispatches, and the `detail` of each: the type map of `addEventListener()`.
 *
 * @remarks
 * Every event is a `CustomEvent` dispatched on the element and none is `composed`. Listen on the element itself: the
 * events whose detail carries the guest's data (`sandbox-log`, `violation`, `fileswritten`, `fileschanged`) do not
 * bubble, nor does the network build's `fetch`, so a bubbling listener on a shared ancestor or on `window` hears no
 * app's data. A listener added for the capture phase on an ancestor still receives each of them: the
 * capture phase runs down the whole path whatever `bubbles` says. The `detail` is frozen, deeply: every object and
 * array in it, a guest's log arguments included. What cannot be frozen stays as it is: the bytes of a typed array or an
 * `ArrayBuffer`, the entries of a `Map` or a `Set`, a `Date`'s time. Fields that come from the guest are validated and
 * clamped, but remain the guest's data: read them, do not merge them into your objects. Guest-controlled text (every
 * value of docs/API.md#guest-chosen-text, the list the registry of guest values gives: a log line's `args`, a violation's
 * `blockedURI` and `sourceFile`, a fetch record's `url`, the path of a guest's write in `fileswritten` and
 * `listGuestWrites()`, which also chose its type, and the others listed there): show it with `textContent`, never in an HTML,
 * URL (such as a link `href`), `eval`, template or `console` format-string sink, and do not forward it to a network sink,
 * an error reporter or analytics (`fetch`, `navigator.sendBeacon`) as if it were your page's own event: whoever wrote
 * the app reads that sink. A valid path can hold `'`, `(`, `)`, `;`, `=`, `&`, `!`, `$`, `*`,
 * `+`, `,` and `@`, so one written into a single-quoted attribute can end it and add one. `terminated.reason` is the
 * library's text, which never quotes a value of your configuration, or the text you passed to `terminate()`.
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
     * check, or a build that failed (that one in a task of its own, and not at all if another build started
     * meanwhile). Removing the element ends its environment without this event. Branch on `state` and the event,
     * not on the reason's text. Does not bubble.
     */
    terminated: CustomEvent<{ readonly reason: string }>;
    /**
     * A log line from the guest's console or written by the element; see {@link SandboxLog}.
     *
     * @remarks
     * Guest lines are limited to {@link LOG_EVENTS_PER_SECOND} per environment per second. Does not bubble. Listen on
     * the element (a capture listener on an ancestor still receives it).
     */
    'sandbox-log': CustomEvent<SandboxLog>;
    /**
     * The guest's policy refused a load; see {@link SandboxViolation}.
     *
     * @remarks
     * At most {@link VIOLATION_EVENT_LIMIT} per environment. A report is a claim by the guest, not a host fact.
     * Does not bubble. Listen on the element (a capture listener on an ancestor still receives it).
     */
    violation: CustomEvent<SandboxViolation>;
    /**
     * `commitGuestWrites()` changed the files; `detail.paths` lists the paths that changed.
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
     * At most {@link GUEST_WRITES_PER_SECOND} per environment per second. Does not bubble. Listen on the element (a
     * capture listener on an ancestor still receives it). The path is guest-controlled text: show
     * it with `textContent` (a valid path can end a single-quoted attribute).
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
 * The options every mode takes, and the ones a mode's config narrows ({@link SealedSandboxConfig}, and in a build with
 * the network modes the configurations of strict, cooperative and worker mode).
 *
 * @remarks
 * An option left out takes its default. An option a mode does not read holds its default in that mode. Each option's accepted values, bounds, warnings and modes are declared once, in
 * the config schema (`CONFIG_SCHEMA`, src/lib/config-schema.ts), and docs/API.md#configuration renders them.
 */
export interface SandboxConfigOptions {
    /**
     * Whether the guest policy allows `'unsafe-eval'` (strings run as code, WebAssembly too), and in a build with the
     * network modes whether `execute()` runs code. For testing: each element that enables it warns once. A value that
     * is not a boolean makes `start()` throw. Sealed mode refuses `true` ({@link SealedSandboxConfig}).
     *
     * @remarks
     * The host page's policy still applies: the guest's realm inherits it, so a string it refuses fails, and the page's
     * policy reports the refusal to the guest's realm (its text) and to the page's report endpoint (a sample of the
     * string). Without it, strict mode's worker refuses every string itself, before the browser sees it.
     *
     * @defaultValue `false`
     */
    scriptUnsafe?: boolean;
    /**
     * Sandbox flags that keep the guest inside the frame, from {@link SAFE_CAPABILITIES}. An entry that is not one, or a
     * value that is not a list, makes `start()` throw. Worker mode always adds `allow-scripts`; the view of strict and sealed mode always has
     * `allow-scripts` and `allow-forms`, so listing either there changes nothing.
     *
     * @defaultValue `[]`
     */
    capabilities?: SafeCapability[];
    /**
     * The initial HTML: the initial view in strict and sealed mode (its `<script>` elements and event-handler attributes never
     * run, and markup that holds any warns once per element), the guest document in cooperative mode. Ignored in worker
     * mode. Empty means `<div id="root"></div>`. A value that is not a string makes `start()` throw.
     *
     * @defaultValue `''`
     */
    html?: string;
    /**
     * Strict and sealed mode only: the path of a JavaScript file of the app's ({@link SandboxApp}) that the worker runs
     * first, as a classic script. Ignored with a warning in other modes. In strict and sealed mode `start()` throws when
     * it names no JavaScript file of the app's.
     *
     * @defaultValue none
     */
    entry?: string;
    /**
     * Strict and sealed mode only: whether CSS animations and transitions run in the view. Left out or `false` removes
     * them; there, a value that is not a boolean makes `start()` throw. Ignored with a warning in other modes.
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
     * Strict and sealed mode only: whether `<video autoplay>` and `<audio autoplay>` in the view start on their own. Left
     * out or `false` removes `autoplay`, and media then plays only when the user starts it; there, a value that is not a
     * boolean makes `start()` throw. Ignored with a warning in other modes.
     *
     * @remarks
     * With `true`, playing media costs the host page's main thread where the view shares it, outside the view's time
     * budget.
     *
     * @defaultValue `false`
     */
    allowAutoplay?: boolean;
    /**
     * A deadline in ms for each `execute()`, in worker and strict mode (a build with the network modes). At the
     * deadline the guest's event loop must be free: the element pings the guest, and if no answer arrives within
     * {@link EXECUTION_TIMEOUT_GRACE_MS} the sandbox ends (a `sandbox-log` line `Execution Timeout`, then `terminated`).
     * `0` is off; anything but `0` or a finite number above 0 makes `start()` throw. Not read in cooperative mode, nor
     * in sealed mode, which runs no `execute()` (ignored silently; `watchdogTimeout` bounds a sealed app that loops).
     *
     * @defaultValue `0` (off)
     */
    workerExecutionTimeout?: number;
    /**
     * Terminates a guest that stops answering for this long, in ms; `0` is off, and anything but `0` or a finite number
     * above 0 makes `start()` throw. It starts at `ready`. Off by default because legitimate synchronous work longer than the budget is stopped too.
     * In cooperative mode it bounds a looping guest only where the browser runs the frame in its own process.
     *
     * @defaultValue `0` (off)
     */
    watchdogTimeout?: number;
    /**
     * Whether the element's height follows the guest's content height, from `ready` on; the height is validated,
     * clamped to {@link AUTO_RESIZE_MAX_HEIGHT} and changes at most {@link AUTO_RESIZE_MAX_UPDATES_PER_SECOND} times a
     * second. A value that is not a boolean makes `start()` throw, except in worker mode, where it does nothing (`true`
     * with one warning). Strict, sealed and cooperative mode.
     *
     * @defaultValue `false`
     */
    autoResize?: boolean;
    /**
     * The host page's Content-Security-Policy as text, so that the library drops the origins it refuses from
     * `origins.connect` and `fetchBridge.allow`: a string (one or more policies, as a header or a `<meta>` carries them),
     * or `false` when the page sends none. Left out, both lists are dropped, with a warning.
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
     *   Report-Only policy is not passed. It is also what a browser without Trusted Types reads the page's
     *   `require-trusted-types-for` and `trusted-types` from: with it, such a browser ends the build and refuses `execute()`
     *   as the others do, and without it nothing is applied there
     *   (docs/API.md#trusted-types-without-the-browser).
     * - `false` says the page sends no Content-Security-Policy: the lists are kept as configured. A policy the page does
     *   send is then applied by the browser alone, and engines differ on what some of its sources admit.
     * - Left out, a build that lists an `origins.connect` or `fetchBridge.allow` entry drops all of them, with one
     *   warning that says what to pass: the guest's requests are refused by the request gate and its `sandboxFetch()`
     *   with `FETCH_NOT_ALLOWED`. The library never asks the page for its policy. A build with no such entry needs nothing.
     *
     * @defaultValue none: `origins.connect` and `fetchBridge.allow` are dropped
     */
    hostContentSecurityPolicy?: string | false;
    /**
     * Whether the guest's `sandboxFiles.write()` and `remove()` are recorded as pending changes of the environment,
     * announced as `fileswritten`, listed by `listGuestWrites()` and applied only by
     * `commitGuestWrites()`. A value that is not a boolean makes `start()` throw.
     *
     * @defaultValue `false`
     */
    guestWrites?: boolean;
    /**
     * Strict and sealed mode only: the URLs the user's click on a link of the app's opens, each in a new tab with no
     * opener and no referrer. The app writes an ordinary `<a href="…">` whose `href` is one of them, character for
     * character; the element opens your own copy of the URL, so nothing of the guest's is part of what it opens.
     * Ignored with a warning in other modes.
     *
     * @remarks
     * Each entry is a string of at most 2048 characters that parses as a URL, has the scheme `https:`, has no user name
     * or password, and is equal to its own serialisation (`new URL(entry).href === entry`), so that a URL has one
     * spelling; at most {@link MAX_LINKS} entries, no two equal. A list that breaks a rule makes `start()` throw a
     * `TypeError` whose message names the rule (the reason `linksRefused`), in every mode, and nothing of it is kept.
     *
     * The view marks an HTML `a` whose `href` is a listed URL, compared as strings with no parsing or normalising; an
     * `area`, an SVG `a` and a MathML element are never marked, and every other `href` stays inert. A marked link's
     * `href` in the view is the inert one too, so the status bar and "copy link address" do not show the URL (a listed
     * URL as the `href` would reach its site on a press, before any click: docs/research/33_link_href). The request is
     * the user's trusted `click` on a marked link or inside one, not on a form control inside it (Enter on a focused link
     * is such a click; a middle click is not): the view sends the link's index in the list, and the element calls
     * `window.open(url, '_blank', 'noopener,noreferrer')` in the task of that message, where the browser's popup blocker
     * allows it for the click. The guest's worker has nothing to call. The app chooses which listed URL each link carries
     * and how it looks, so each click carries a choice among the listed URLs to their sites, and its time
     * (docs/API.md#budgets). The element cannot see a tab the browser blocked: with `noopener`, `window.open` returns
     * `null` either way.
     *
     * @defaultValue none: no link opens
     */
    links?: readonly string[];
    /**
     * The per-second budget of the calls the guest makes, per environment and in every mode. A call past it is refused
     * with `BUSY` by the guest's `bridge` before sending, and by the element if it arrives anyway. A field left out takes
     * its default; one that is not a finite number of at least 1, or a `callLimits` that is not an object, makes
     * `start()` throw. There is no way to turn the budget off.
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
     * `ARGS_NOT_TRANSFERABLE`, with one warning at `start()`.
     *
     * @defaultValue `67108864` (64 MiB)
     */
    maxBytesPerSecond?: number;
}

/**
 * Where the element is in its lifecycle; read it from `state`.
 *
 * - `'idle'`: no app yet (`start()` was not called), or not in the document (constructed, removed). There is no frame:
 *   an element with no app builds nothing, wherever it is, and is never `'terminated'`.
 * - `'loading'`: a frame was built and the guest has not checked in (without a bootstrap, the frame has not loaded).
 * - `'ready'`: the guest checked in and `ready` was dispatched. In cooperative mode the guest document may still be
 *   loading; its calls wait until it is parsed.
 * - `'terminated'`: torn down by `terminate()`, a budget (`watchdogTimeout`, `workerExecutionTimeout`),
 *   a frame check, or a build that failed. It stays so until `reset()` builds a new environment.
 *
 * @remarks
 * There is deliberately no `'running'` state: nothing the guest reports could make it truthful. Lifecycle
 * reference: docs/API.md#lifecycle and ADR-003.
 */
export type SandboxState = 'idle' | 'loading' | 'ready' | 'terminated';

// The configuration as the element keeps it, its modes and their refusal: src/lib/config-schema.ts (the config schema,
// backlog S67), which declares every option once. Every option left out takes its default there.

// Texts of the host's own refusals, for people reading them. Code branches on the error's `code`
// ('TERMINATED', set by the broker), never on these texts: a guest handler can throw the very same text,
// and that call rejects with code 'HANDLER_ERROR' instead.
const TERMINATED_CALL_MESSAGE = "[Sandbox] call() rejected: the sandbox was terminated. Call reset() to start it again.";
const RESET_CALL_MESSAGE = "[Sandbox] call() rejected: the sandbox was reset or terminated.";
const IDLE_CALL_MESSAGE = "[Sandbox] call() rejected: the sandbox is not in the document. Call it once the element is inserted.";
const NO_APP_CALL_MESSAGE = "[Sandbox] call() rejected: the element has no app. Call start() first.";

// The sandbox flags of strict mode's view, always: scripts for its bootstrap, and forms so that `submit` reaches it, to be
// forwarded to the worker's handlers and cancelled (research 15, P4: without allow-forms Chromium and Firefox dispatch no
// submit). allow-forms is an unsafe capability in cooperative and worker mode (R1:R2-2: a modifier-click
// submission opens a new tab past form-action in Chromium), not here: no guest script runs in the view to synthesize a
// click, the view cancels every submit, and its forms keep no action, formaction, method or target (ADR-005). So the
// owner's move of allow-forms leaves strict mode as it was.
// (STRICT_VIEW_FLAGS, declared with the config schema, which keeps them in `capabilities` there.)

const STRICT_HTML_SCRIPT_WARNING = "[Sandbox] strict mode runs no script in `html`; name a registered file in `entry`, or choose `mode: 'cooperative'`.";
const SEALED_HTML_SCRIPT_WARNING = "[Sandbox] sealed mode (the default) runs no script in `html`; name a registered file in `entry`, or choose `mode: 'cooperative'`.";

// Every reason the element gives, and every line it dispatches itself, is the texts registry's (src/lib/reasons.ts).
// The reason each environment check ends the build with (environment-check.ts, S74): the element's own table, by the
// check's id; what a bootstrap posts names a row, never a text.
const ENVIRONMENT_REFUSALS: Readonly<Record<string, string>> = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(
    Object.entries(ENVIRONMENT_CHECKS).map(([id, row]) => [id, reasonText(row.reason)]),
)));

// The first statement of every guest worker's source, worker mode and strict mode (VR:V1): the worker keeps only the allowlisted globals (worker-globals.ts) before any other script of the
// library or the guest runs there, so every request guest code can make goes through an API the policy governs on
// every engine. `global` is the expression for the global object in that source.
// The call is an expression whose value is the worker's postMessage, which it deleted (worker-globals.ts); strict mode
// runs it as a statement and keeps nothing of it.
// Strict mode's worker keeps STRICT_WORKER_GLOBALS (sealed mode's, SEALED_WORKER_GLOBALS) and STRICT_WORKER_NAVIGATOR_MEMBERS: no importScripts, which its policy
// never lets load anything (S74), and none of the names only a secure context has, whose members removeSecureContextOnly
// deletes next and whose isSecureContext it pins to false, so its surface is the same whatever the host page's URL and the
// engine (class A: INHERITED_CONTEXT.secureContext; SECURE_CONTEXT_ONLY).
export const workerGlobalsCall = (global: string, globals: readonly string[], navigatorMembers: readonly string[] = WORKER_NAVIGATOR_MEMBERS) =>
    `(${keepOnlyWorkerGlobals.toString()})(${global}, ${toInlineScriptLiteral(globals)}, ${toInlineScriptLiteral(navigatorMembers)})`;
// Sealed mode's worker keeps SEALED_WORKER_GLOBALS, which has none of the request makers (fetch, XMLHttpRequest, WebSocket):
// the names are gone before the bootstrap runs, which then has nothing to gate.
const workerGlobalsStatement = (global: string, scriptUnsafe: boolean, sealed: boolean) => `${workerGlobalsCall(global, workerGlobalsFor(sealed ? SEALED_WORKER_GLOBALS : STRICT_WORKER_GLOBALS, scriptUnsafe), STRICT_WORKER_NAVIGATOR_MEMBERS)};`
    + `(${removeSecureContextOnly.toString()})(${global}, ${toInlineScriptLiteral(SECURE_CONTEXT_ONLY.members)});`;

// The strict prelude's last statement, before the guest's entry, unless scriptUnsafe (code-from-strings.ts; BD6:ISO-1,
// class A): every code-from-string sink of the worker becomes the library's refusal, so no guest string reaches a check of
// the policy list the worker inherited from the host page. One function of each kind is written as text here, where no
// bundler rewrites it.
const refuseCodeFromStringsStatement = (global: string) =>
    `(${refuseCodeFromStrings.toString()})(${global}, ${FUNCTION_KINDS_SOURCE}, ${toInlineScriptLiteral(REFUSED_GLOBALS)}, ${toInlineScriptLiteral(REFUSED_TIMERS)}, ${toInlineScriptLiteral(CODE_FROM_STRING_REFUSAL)});`;

// The text of a strict or sealed entry as the worker runs it, from its registered bytes (base64): what the build scans
// (dynamicImportAt) is what the worker's source holds.
const entryText = (base64: string) => new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));

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
export interface BootstrapFeatures {
    autoResize?: true;
    fetchBridge?: { timeoutMs: number };
    externalPort?: true;
    guestWrites?: true;
    callBudget: CallBudget;
    listeners: BootstrapListener[];
    uncaught?: { count: number; characters: number };
    connect?: string[];
    sealed?: true;
    violationFields?: Readonly<Record<string, string | number>>;
}

// The warning for a registered stylesheet the view of strict or sealed mode gets without the URLs it may not keep, or not
// at all (files.ts, viewStylesheets; keepsUrl): once per element and text, as the build's other warnings about the files
// (_warnOnce). Sealed mode has no origin to show such a file from, so it names none.
function viewStylesheetWarning(mode: 'strict' | 'sealed', path: string, urls: readonly string[], unreadable: string | null): string {
    const file = `[Sandbox] ${mode} mode: the registered stylesheet ${JSON.stringify(path.slice(0, 256))}`;
    if (unreadable !== null) return `${file} gets no URL in the view: ${unreadable}, so the view could not read the URLs it names.`;
    const first = JSON.stringify(urls[0]!.slice(0, 256));
    const names = `${file} names ${urls.length === 1 ? 'a URL that is' : `${urls.length} URLs that are`} no registered file (${first}${urls.length > 1 ? ', …' : ''}); the view drops ${urls.length === 1 ? 'it' : 'them'}`;
    if (mode === 'sealed') return `${names}: sealed mode has no network. Register the file instead.`;
    return `${names}: CSS in the view loads registered files only (a load that CSS makes cannot be sent without cookies). Register the file instead, or show it with an element (<img>, <video>) from an origin listed in origins.`;
}

// What the element extends: HTMLElement where there is a DOM. Importing the package must not need one (R2:C-8):
// an embedder reads viewScriptHash() in a build step, in Node or Bun, and the class declaration is the only thing
// evaluated at import that names a DOM interface. Without a DOM the class extends an empty one, which nothing constructs.
// It is private to this module and typed `typeof HTMLElement`, so the declarations name HTMLElement instead
// (scripts/declaration-base.ts rewrites dist/host.d.ts): the public type is the same, and no stand-in is a public name.
const ElementBase: typeof HTMLElement = typeof HTMLElement === 'function' ? HTMLElement : (class {} as unknown as typeof HTMLElement);

/**
 * The `<web-sandbox>` custom element: one app, given once with `start()`, run in a sandboxed environment that
 * `reset()` rebuilds. Register it with {@link defineWebSandbox}.
 *
 * @remarks
 * The element has no observed attributes and two properties, `state` and `started`; everything else is done through
 * its methods. An element with no app builds nothing and stays `'idle'`, wherever it is and whatever is called on it;
 * another app is another element. It builds an environment only while it is in the document of the window that defined it: moved into another
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
    // R2:L-4: BR:CB5's no-repeat rule) and the standing build's progress. One value. The executor's `step` (module level,
    // below) writes it, and nothing else does.
    private _lc: LcState = INITIAL_LIFECYCLE;
    private _watchdog: EnvironmentFields['_watchdog'] = null;
    private _resizer: EnvironmentFields['_resizer'] = null; // this environment's auto-sizing (BL:B6), or null when off
    private _autoHeight: string | null = null;   // the inline height auto-sizing last wrote on the element
    private _fetchPolicy: object | null = null; // the validated fetchBridge config, the network modes' to read, or null when off (BL:B5)
    private _origins: OriginPolicy = NO_ORIGINS; // the parsed `origins` (ADR-007), what the guest policy admits
    private _fetchBridge: EnvironmentFields['_fetchBridge'] = null; // this environment's bridge: its requests end with it
    private _bridgeFrame: EnvironmentFields['_bridgeFrame'] = null; // the frame that makes this environment's bridge requests (BD1:ISO-1)
    private _warnedBridgeFrame = false;      // the bridge's frame did not start, said once per instance
    // The guest-write overlay (BL:C5): created by each build when guestWrites is on, else null. It outlives its
    // environment's termination (closed, still listable and committable) and is discarded by the next build and on
    // removal (_discardGuestWrites).
    private _guestWrites: GuestWrites | null = null;
    // Every GuestWrite this element's listGuestWrites() returned, to its entry: what commitGuestWrites() takes (I4).
    // One map for the element's life, so a value of an earlier environment is this element's and stale, not foreign.
    private readonly _mintedWrites: MintedWrites = new WeakMap();
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
    // What waits for the port while loading, in the order it was issued (R2:L-3): the host's own RPC requests (cloned at
    // call time) and, in a build with the network modes, execute() code, in one queue, so a call made before an execute()
    // is sent before it.
    private _queue: ({ code: string } | { frame: unknown })[] = [];
    private _warned = new Set<string>(); // the warnings said, each once per element and text (_warnOnce)
    private _warnedForeignDocument = false; // inserted into a document of another realm (BR:CB7), once per instance
    private _warnedWrapperStyle = false;    // the host page's style-src refused the wrapper's style (R1:R3-1), once per instance
    private _heightBeforeAuto: string | null = null; // the embedder's inline height before auto-sizing first wrote one (R1:R3-8)
    private _hasMethods = false; // the app's grants hold host methods, for the no-allow-scripts warning (R1:R3-4)

    // The app's files (start()): they live on the element, survive reset(), terminate() and removal, change only by a
    // commit of guest writes, and every environment build takes a snapshot (_prepareBuild). See src/lib/files.ts.
    private _files = new FileStore();

    // One broker lives on the element for its whole life, so the app's host methods persist across
    // frame recreation (the guest's broker is per-frame and resets with each new frame). Its send only
    // ever carries the host's own requests: it queues them until a port exists, then _setupChannel
    // flushes them. Answers to the guest never use it — they go back on the port the request arrived on.
    // Results go back with their snapshot's ArrayBuffers transferred (R2:C-3: rpc.ts, sendResult).
    // A guest's request past its environment's per-second budget is answered BUSY (R3:M-2: _admitGuestCall).
    // A handler's error text reaches the guest only by the broker's rule: the embedder's own words, or for an error the
    // library made the fixed text its factory chose (BD7:CHL-2: minted-errors.ts); what it withholds is written to the
    // console here, once per call (BD5:LIM-2, BD5:DOC-1: rpc.ts, reportWithheld).
    private _broker = createBroker((frame) => this._postRpc(frame), {
        sizeOf: createSizeOf(),
        transferResults: true,
        admitInbound: (bytes) => this._admitGuestCall(bytes),
        host: {
            mint: mintError,
            crossingText,
            reportWithheld: (method, refusal, text) => {
                console.warn(`[Sandbox] "${method.slice(0, 64)}" failed, and the other side received "${refusal}" in place of its error, which was:`, text);
            },
        },
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
        // The fetch bridge (BL:B5) and guest writes (BL:C5) are library methods under reserved names: no host method of
        // the grants can replace them (start() refuses the prefix). Each build registers both again, bound to that build's bridge and overlay
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

    /**
     * Whether `start()` has given this element its app: `true` from its first success on, for the rest of the element's
     * life. `state` cannot say it, since a new element and one with its app outside the document both read `'idle'`.
     *
     * @remarks
     * A framework set-up does not branch on it to restart an element: an element that has an app may hold another app
     * than the one you mean. Let the set-up own its element: create it, `start()` it and append it, and remove it in the
     * clean-up, with the app and the grants as the set-up's dependencies.
     */
    get started(): boolean {
        return this._lc.started;
    }

    /**
     * Gives the element its app, once: the app's own content and what you allow it, validated whole before anything is
     * stored. It builds at once while the element is in the document, otherwise when it is inserted.
     *
     * @remarks
     * - **Two arguments.** `app` is what the app's author wrote (`html`, `entry`, `files`) and may come from data;
     *   `grants` is yours (the host methods, `guestWrites`, `capabilities` and every other option). Each refuses a key of
     *   the other and any key it does not know, so an app read from data carries no grant by accident. A grant is
     *   whatever you pass as the second argument: nothing stops you from passing a stored manifest there, which hands its
     *   author the grants.
     * - **All or nothing.** Every option is checked for its shape and type, the files as one batch (see
     *   {@link SandboxApp}), an `entry` against the files given (in strict and sealed mode it must name a JavaScript file
     *   of them), and each method. A refusal throws and leaves the element as it was: without an app, so a corrected one
     *   can be started on it. What needs a parse of the guest's code (an `import()` in the entry) still ends the build,
     *   with its reason.
     * - **Copied.** The options are copied (structured clone), the files into the element's own store, the methods into
     *   a frozen record: changing your objects afterwards changes nothing.
     * - **Once.** A second call throws, whatever the element's state, and changes nothing; `started` is `true` from the
     *   first success on. Reading the arguments may run your code (a getter, a `Proxy`): of two calls that overlap this
     *   way, the one that finishes validating first binds and the other throws.
     * - **Its lifecycle.** `reset()` rebuilds the same app, with its files as they are now, committed writes included;
     *   `terminate()` ends it, and a later `reset()` starts it again; removing the element ends its environment and
     *   inserting it again builds the same app. Until `start()` is called the element builds nothing: inserted, reset
     *   or terminated, it stays `'idle'`.
     *
     * @param app - The app: its markup, its entry and its files; see {@link SandboxApp}.
     * @param grants - What the embedder allows it: its host methods and options; see {@link SandboxGrants}. None when
     * left out.
     * @throws A `TypeError` for a second call, an argument that is not an object, a key of the other argument or one
     * neither takes, an option of the wrong shape or type, a mode or an option this build does not have (in the default
     * build an option of the network modes, with the reason of the `networkModesOff` termination), an `entry` that names
     * no JavaScript file of `files`, or a method that is not a function or whose name is longer than 256 characters
     * or starts with `sandbox:`; a
     * {@link FileError} with `code` `INVALID_PATH`, `INVALID_FILE` or `FILES_QUOTA_EXCEEDED` for the files. Nothing is
     * stored then.
     */
    start(app: SandboxApp, grants?: SandboxGrants): void {
        if (this._lc.started) throw alreadyStarted();
        const values = readStart(app, grants, networkModes()?.readHostPage ?? NO_HOST_PAGE);
        this._bind(values);
        for (const message of values.warnings) this._warnOnce(message);
        // the build of the app just bound, as reset() starts one
        step(this, { t: 'build', ctx: this._buildContext() });
    }

    // The binding (I1): the check that the element has no app and the store of what start() validated, one step with no
    // code of the embedder's in it (no getter, no listener, no console), so that a start() the reading of the arguments
    // ran finds the element bound, or is the one that bound it. The reducer holds the binding (`_lc.started`): its `start`
    // input is stepped here, after the stores, and runs no effect. The configuration, the files and the host methods are
    // the app's from here on, for the element's whole life.
    private _bind({ normalised, files, methods }: StartValues) {
        if (this._lc.started) throw alreadyStarted();
        this._config = normalised.config;
        this._fetchPolicy = normalised.fetchPolicy;
        this._origins = normalised.origins;
        this._callBudget = normalised.callBudget;
        this._files = files;
        for (const [name, method] of Object.entries(methods)) {
            this._broker.expose(name, method);
            this._hasMethods = true;
        }
        step(this, { t: 'start' });
    }

    // The lifecycle callbacks call module-level functions (connected, disconnected, adopted below), never a method
    // looked up on the element (BR:CB7): Firefox gives an element adopted into another document that document's
    // HTMLElement prototype, so `this.initialize` and `this._teardown` are gone there; a method call would throw, and the
    // guest would keep running with nothing left that could end it.
    /**
     * Custom element reaction: the browser calls it when the element is inserted into a document. It builds an
     * environment of the element's app (see `state`) where the element may build one, and nothing for an element with
     * no app; nothing is dispatched synchronously.
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
     * reject with `TERMINATED` and later calls are refused at once. The sandbox stays terminated until `reset()`
     * builds a new environment of the same app.
     *
     * @remarks
     * Calling it while terminated does nothing, so `terminated` fires once per termination; so does calling it on an
     * element with no app, which stays `'idle'`. The reason is also written to the console as a warning.
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
     * Rebuilds the environment of the same app now, from any state (terminated included): a fresh frame with a fresh
     * opaque origin and a new snapshot of the app's files, committed writes included. Methods the guest exposed are
     * gone, the host methods of the grants stay, and pending calls reject with `TERMINATED`. Wait for `ready` before
     * relying on the new environment. Outside the document it builds nothing until the element is inserted, and on an
     * element with no app it does nothing.
     */
    reset(): void {
        step(this, { t: 'build', ctx: this._buildContext() });
    }

    /**
     * The app's files, committed writes included, sorted by path.
     *
     * @returns One {@link FileInfo} per file: its path, its MIME type and its size in bytes as stored.
     */
    listFiles(): FileInfo[] {
        return this._files.list();
    }

    /**
     * The guest's pending writes and removals (see `guestWrites` and docs/API.md#guest-writes), sorted by path. They belong
     * to the current environment; how long they live is stated once, at docs/API.md#guest-writes-lifetime.
     *
     * @returns One {@link GuestWrite} per path with a pending change, each a fresh frozen object: `{ path, change: 'write', type, size, content }`
     * (`type` the library's for the path's extension, `content` the bytes as a {@link GuestBytes}: `bytes()` a copy, `image()`
     * and `save()` the safe ways to show and to download them) or `{ path, change: 'remove' }`. Empty while
     * `guestWrites` is off. Each value is what `commitGuestWrites()` takes: the element knows the values it returned,
     * by identity.
     */
    listGuestWrites(): GuestWrite[] {
        return this._guestWrites?.list() ?? [];
    }

    /**
     * Applies the given values of `listGuestWrites()` to the app's files, all or none, if each is still what is pending at
     * its path, and removes them from the pending list. The guest sees committed files from the next build on. Fires
     * `fileschanged` when the files changed.
     *
     * @remarks
     * - It commits exactly what you were handed: each value commits the change it was listed from, never what the
     *   guest wrote at its path since, and the bytes stored are the ones listed (changing a value's `content` changes
     *   nothing). The element knows the values it returned by identity, so a copy of one is not one, and a value of
     *   another element is not either.
     * - A value is stale when its change is not its path's pending change now: the guest wrote or removed at the path again, the
     *   change was committed, or a build (`reset()`, the element's re-insertion) discarded the pending writes. If any value
     *   is stale, nothing is committed and it returns `false`: list again, check again, and commit the new values. Files you
     *   checked as a set are never committed in part.
     * - A write whose type is not inert is refused with `FILES_NOT_ALLOWED` unless `options.code` is `true`. Inert types
     *   are the images, fonts, audio and video a browser only decodes, plain text, JSON and CSS (the inert rows of the one
     *   type table, `FILE_TYPES`, src/lib/files.ts). JavaScript, HTML, SVG, XML, WebAssembly and any extension the table
     *   does not have can run or be parsed as code.
     * - All checks come first, the quota included (with what module and stylesheet rewrites add, against the files as they
     *   are now), so a refusal changes neither the files nor the pending list.
     * - A write's type is a function of its path (I8): the guest gives a path and bytes, never a type, so the type and the
     *   name agree. A write to `evil.html` is an HTML file and needs `code` to commit. The name is still the guest's: if you
     *   store or serve the bytes elsewhere, choose the name yourself.
     * - A committed file loads only as what its type is for (see {@link SandboxApp}): an inert file never runs as a script.
     *   Committed `text/css` is inert but still CSS: markup of the next build that links it is styled by it.
     *
     * @param writes - The values to commit, each one this element's `listGuestWrites()` returned; required, since there is
     * no "commit everything". An empty list commits nothing and returns `true`.
     * @param options - `code: true` allows the writes whose type is not inert.
     * @returns `true` when every value was current and all were committed; `false` when one was stale, and nothing was
     * committed.
     * @throws A `TypeError` when `writes` is not an array or holds a value this element did not return (a copy included),
     * before anything is committed. A {@link FileError} with `code` `FILES_NOT_ALLOWED` or `FILES_QUOTA_EXCEEDED`; then
     * nothing is committed.
     */
    commitGuestWrites(writes: readonly GuestWrite[], options?: { code?: boolean }): boolean {
        const { entries, code } = parseCommitArguments(writes, options, this._mintedWrites);
        if (!this._guestWrites) return entries.length === 0; // no overlay: none of this element's values is current
        const changed = this._guestWrites.commit(entries, code);
        if (changed === null) return false;
        this._dispatchFilesChanged(changed);
        return true;
    }

    // Synchronous, once per call that changed something.
    private _dispatchFilesChanged(paths: string[]) {
        if (paths.length === 0) return;
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
        this._guestWrites = this._config.guestWrites === true ? createGuestWrites({ store: this._files, built, minted: this._mintedWrites }) : null;
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
            if (!acted) reject(mintError('TERMINATED', '[Sandbox] the sandbox was reset or terminated while this write was announced.'));
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

    // One guest change the host recorded: dispatched on the element, not bubbling, like the other events that carry guest
    // data (ELEMENT_EVENTS; I5). At most GUEST_WRITES_PER_SECOND per environment (guest-writes.ts).
    private _dispatchFilesWritten(path: string) {
        this.dispatchEvent(elementEvent('fileswritten', { paths: [path] }));
    }

    /**
     * Calls a method the guest exposed with `bridge.expose()` and resolves with its result. It works without
     * `scriptUnsafe`: it never evaluates code.
     *
     * @remarks
     * - Arguments and results are copied by structured clone, at most `RPC_MAX_BYTES` (33 MiB) per message, counted on
     *   both sides on the copy that is sent: past it a call is refused before anything is sent (`ARGS_NOT_TRANSFERABLE`)
     *   and a result is answered `RESULT_NOT_TRANSFERABLE`. The measure knows primitives, plain objects and arrays, `Map`,
     *   `Set`, `Date`, `RegExp`, `ArrayBuffer`, typed arrays and `DataView`, and `String`, `Number`, `Boolean` and `BigInt`
     *   objects. Any other value (a `Blob` or a `File`, an `Error`, an `ImageData` or another platform object, a
     *   `SharedArrayBuffer`) is refused the same way, at any depth, with a message that names the value rather than the
     *   budget; send what you need of it instead: an image's `data`, `width` and `height`, a file's bytes, an error's
     *   `{ name, message, stack }`. The whole message is counted, the method name included, and a name is at most 256
     *   characters (`INVALID_CALL`).
     * - A `Blob` or a `File` crosses in neither direction (I7): a `blob:` URL made of one in your page is a document of your
     *   origin, so no value of the guest's carries one to your code. The guest sends bytes, and you decide what they are.
     * - A typed array or `DataView` crosses as what it shows, at any depth and in both directions: one that covers part
     *   of its buffer (`byteOffset` not 0, or `byteLength` less than its buffer's) arrives as the same kind of view over a
     *   new buffer that holds exactly its bytes, and one that covers its whole buffer crosses with that buffer. So
     *   `heap.subarray(ptr, ptr + n)` sends `n` bytes, never the rest of `heap`. Two views of one buffer arrive with a
     *   buffer each; one view passed twice arrives as one view.
     * - What comes back is the guest's data. Never make an object URL of its bytes with a type the guest chose (or none) and
     *   open it, since an SVG or HTML file is then a document of your origin; see docs/API.md#guest-writes.
     * - The default timeout is 30 s (`TIMEOUT`). The element's timers and its copy of the arguments use the `setTimeout` and
     *   `structuredClone` it took when it was constructed: fake timers installed after that (a test's) do not control a
     *   call's timeout.
     * - Calls made while `'loading'` are queued and sent when the build becomes `ready`, in every mode (strict and
     *   sealed mode included, whose view has its ports before it checks in); one that settles while queued (its timeout) leaves the queue
     *   and never runs. In cooperative mode a call reaches the guest's method once the guest document is parsed (see
     *   docs/API.md#ready-and-the-startup-gate).
     * - Calls made while `'idle'` (not in the document, or no app) or `'terminated'` reject at once with `TERMINATED`;
     *   so do pending ones when the environment goes away.
     *
     * @param method - The name the guest exposed.
     * @param args - The arguments, copied by structured clone.
     * @returns The guest method's return value (awaited if it is a promise): the guest's data, typed `unknown`, so your
     * code checks its type and shape before it uses it. No type argument asserts it.
     * @throws Never synchronously: the promise rejects with an {@link RpcError}, an `Error` whose `code` is an
     * {@link RpcErrorCode}. `UNKNOWN_METHOD`, `HANDLER_ERROR` and `RESULT_NOT_TRANSFERABLE` are reported by the guest and
     * their message is the guest's text. A host method that lets the rejection propagate hands its own caller the code
     * and the library's fixed text for it, never this message (see {@link HostMethod}).
     */
    call(method: string, ...args: unknown[]): Promise<unknown> {
        const refusal = this._noEnvironmentError();
        if (refusal) return Promise.reject(refusal);
        return this._issue(() => this._broker.call(method, ...args));
    }

    /**
     * Like `call()`, with a timeout of your own for this one call. Every other timeout is waited out in
     * full, however long: `watchdogTimeout` and `workerExecutionTimeout` do not shorten it.
     *
     * @param timeoutMs - The timeout in ms. `0`, any value that is not above 0, and `Infinity` disable it.
     * @param method - The name the guest exposed.
     * @param args - The arguments, copied by structured clone.
     * @returns The guest method's return value (awaited if it is a promise): the guest's data, typed `unknown`, as `call()`'s.
     * @throws Never synchronously: the promise rejects as `call()`'s does.
     */
    callWithTimeout(timeoutMs: number, method: string, ...args: unknown[]): Promise<unknown> {
        const refusal = this._noEnvironmentError();
        if (refusal) return Promise.reject(refusal);
        return this._issue(() => this._broker.callWithTimeout(timeoutMs, method, ...args));
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

    // One rule for work handed to the guest (BL:B8): while idle or terminated there is no environment to call, so a call
    // is refused at once with TERMINATED. (Waiting for the element's insertion would end in the same TERMINATED, from
    // the build.)
    private _noEnvironmentError(): Error | null {
        if (this._lc.state === 'terminated') return this._broker.terminationError(TERMINATED_CALL_MESSAGE);
        if (this._lc.state === 'idle') return this._broker.terminationError(this._lc.started ? IDLE_CALL_MESSAGE : NO_APP_CALL_MESSAGE);
        return null;
    }

    // Sends one of the host's own RPC requests over the port once the build is ready, or queues it until `ready` flushes
    // (R5:L-1: strict mode has its port from the wrapper's load, before `ready`).
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

    // A frame of ours that the host page's policy refused, as it reported (R1:R3-1, R2:C-5, R2:C-6): one host
    // line, then the termination with the reason that names the policy (unless a listener of that line acted first), of
    // the environment `gen` whose frame said so.
    private _refusedByHostPage(reason: string, gen: Generation) {
        step(this, { t: 'terminate', reason, gen, notices: [hostNotice(hostLine('refusedByHostPage', reason))] });
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
            // What it is (one port, or worker mode's refusal) and what it does are the network modes' (network-host.ts,
            // _onAnnouncement): only their builds announce.
            networkElement(this)?._onAnnouncement({ data, ports: event.ports, trusted: event.isTrusted, source: guestWindow, gen });
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
            if (networkElement(this)?._passExecutionProbe(data.n) !== true) this._watchdog?.handlePong(data.n);
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
     * Strict mode (ADR-005): two channels to the view, once per frame like _setupChannel. The logic port goes
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
        if (data?.type === 'VIEW_LINK') {
            this._openListedLink(data.index);
            return;
        }
        if (data?.type === 'VIEW_INITIAL') {
            this._warnAboutStrictHtml(data.dropped); // what the initial view dropped: its scripts and handlers, once per element
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

    /**
     * The view's request for a listed link (VIEW_LINK; design 02, I6): the user's trusted click on a link the view marked.
     * Only the view posts on its port, and only the current environment's port reaches here (_onViewMessage). The index
     * is checked against this element's own list (listedLink: an integer within it, else nothing opens), and the URL
     * opened is that list's string, in the task of this message, so the browser's popup blocker still sees the click: no
     * text of the guest's is part of it. `noopener` and `noreferrer` give the tab no handle on this page and no referrer;
     * `window.open` then answers null whether or not the browser opened the tab.
     */
    private _openListedLink(index: unknown) {
        const url = listedLink(this._config.links, index);
        if (url === null) return;
        window.open(url, '_blank', LINK_WINDOW_FEATURES);
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
        this._warnOnce(`[Sandbox] allowAnimations is false, and the host page's style-src refuses the view's stylesheet that stops animations, so the view shows no guest stylesheet (<style>, <link rel="stylesheet">). Allow 'unsafe-inline' or ${scriptHashSource(VIEW_STILL_STYLE)} in style-src (see docs/API.md#host-page-policy).`);
    }

    // Flushes what was queued before the build was ready onto its port, in the order it was issued (R2:L-3): the host's own
    // RPC requests and, in a build with the network modes, execute() code (checked by execute() when queued) — the queue never holds answers (those go back
    // on the port their request arrived on). Reached by the `flush` effect only (R5:L-1). Requests are cloned when
    // the call is made (see callWithTimeout in rpc.ts), so a post failure is not expected here; the per-frame catch is a
    // backstop so that one bad frame could never drop the frames behind it or stop 'ready' from firing.
    private _flushQueues(port: MessagePort) {
        const queued = this._queue;
        this._queue = [];
        let skipped = 0;
        for (const item of queued) {
            try {
                if ('code' in item) networkElement(this)?._postExecute(port, item.code);
                else port.postMessage(item.frame);
            } catch {
                skipped++;
            }
        }
        if (skipped > 0) console.warn(`[Sandbox] skipped ${skipped} queued frame(s) that could not be posted (not transferable).`);
    }

    // Log lines are dispatched on the element and do not bubble (ELEMENT_EVENTS; I5): they carry the guest's data, so a
    // listener on the element hears only its own sandbox, and a bubbling one on a shared ancestor hears no app's lines.
    // Not composed: the element sits in the embedding page's DOM, and an event of ours has no business crossing a
    // consumer's shadow boundary. The name is namespaced: a capture listener on window still receives it, beside other
    // code's events there.
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

    // A CSP violation reported by the guest (S5): dispatched on the element, not bubbling, like sandbox-log
    // (ELEMENT_EVENTS; I5). The detail is guest-supplied, so it is validated and clamped (violation.ts) and the
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
        const key = source === 'view' ? `view:${violationBucket(detail.directive)}` : (source ?? '');
        const count = this._violationCounts.get(key) ?? 0;
        if (count > VIOLATION_EVENT_LIMIT) return;
        this._violationCounts.set(key, count + 1);
        if (count + 1 > VIOLATION_EVENT_LIMIT) {
            const where = source === 'view' ? ` for ${detail.directive} on its view port` : source ? ` on its ${source} port` : '';
            console.warn(`[Sandbox] the guest reported more than ${VIOLATION_EVENT_LIMIT} CSP violations${where}; further ones are not dispatched until the next reset().`);
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

    // The reserved method is registered again by every build (_attachBuild), closed over THAT build's bridge, or null when
    // the build has none (a sealed build, or the bridge off): the broker looks a method up when a request arrives and runs it
    // a microtask later, and a request must be served by the bridge of the environment it arrived in (FR:H; network-host.ts,
    // _startFetchBridge).
    private _exposeFetch(bridge: FetchHandler | null) {
        this._broker.exposeReserved(FETCH_METHOD, (request: unknown) => this._handleFetch(bridge, request));
    }

    // The reserved sandbox:fetch method of one environment. Every refusal is minted with a library code (fetch-method.ts).
    private _handleFetch(bridge: FetchHandler | null, request: unknown): Promise<unknown> {
        if (!bridge) return Promise.reject(fetchRefusal('FETCH_NOT_ALLOWED', 'the fetch bridge is off (fetchBridge is not configured)'));
        return bridge.handle(request);
    }

    // The resources of the environment (the executor's `teardown` effect): its generation is the reducer's. Everything a
    // build makes is made in _attachBuild or later, and released here (LM-2).
    // Detach, then release (class L; S74): first every per-environment field is written, the declared resources taken
    // into a record and their fields cleared, and only then is anything released, from the record. A release can run
    // embedder code synchronously (a frame's removal fires the host window's `focus` on Firefox, and a focused guest's
    // `pagehide` calls `parent.parent.focus()` on every engine), and a listener's reset() builds
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
    // starts in the reducer (`connect`, `build`: its `initialize`), the one place a build starts, and every
    // build failure is a termination there (S26, AR:A4). A build that throws must not leave the old environment torn
    // down with state 'loading', no frame and no 'terminated' event, the throw escaping to whoever called start() or
    // reset(). A refusal known up front (a host page that is cross-origin isolated, an entry that calls import()) and
    // anything the build throws end the same way: state 'terminated', one 'terminated' event with the reason, nothing
    // half-built (the `teardown` effect).
    // Where the element may build is one rule (R2:L-1: buildsHere, below), asked by every build, however it starts: in
    // another window's document, reset() and start() would build (the guest would run, and announce itself
    // to a window the element does not listen to), so they stop the environment instead, as insertion there does, and
    // the element stays idle. Asked first: in another document the element may have lost its prototype (BR:CB7), and
    // nothing else here is asked there.
    private _buildContext(): BuildContext {
        if (!buildsHere(this)) return NOT_HERE;
        const strict = hasStrictView(this._config.mode);
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
        if (hasStrictView(this._config.mode) && typeof entry === 'string' && entry !== '') {
            const file = this._files.list().find(candidate => candidate.path === entry);
            if (!file || !isJavaScriptType(file.type)) return reasonText('entryNotRegistered'); // names the problem, not the entry (BD5:DOC-2)
            // An import() would be checked against the host page's policy list, which the worker inherits, and reported to
            // its endpoint with the URL the guest chose; the view's script-src admits nothing it could load (entry-imports.ts;
            // BD6:ISO-2, class A).
            if (dynamicImportAt(entryText(this._files.base64(entry) ?? '')) >= 0) return reasonText('entryImport');
        }
        return null;
    }

    private _getSandboxFlags(): string {
        // Strict and sealed mode (ADR-005): STRICT_VIEW_FLAGS, plus the safe capabilities configured. No unsafe capability.
        if (hasStrictView(this._config.mode)) return [...new Set<string>([...STRICT_VIEW_FLAGS, ...(this._config.capabilities || [])])].join(' ');
        // Cooperative and worker mode's are the network modes' (network-host.ts, _documentSandboxFlags); a mode that is no mode has none.
        return networkElement(this)?._documentSandboxFlags() ?? '';
    }

    // Sealed mode's view policy (sealedViewPolicy, docs/research/24_sealed_mode): the strict view's template with no
    // origins input, so no network source; blob: only for the kinds of load the view's files need, as in strict mode.
    private _sealedPolicy(files: FileSnapshotEntry[]): string {
        const kinds = this._viewFileKinds(files);
        return sealedViewPolicy({ fileKinds: new Set(SEALED_FILE_KINDS.filter(kind => kinds.has(kind))), bootstrapHash: viewBootstrapHash() });
    }

    // The kinds of load the files of a view of strict or sealed mode need blob: for (the one load-kind table).
    private _viewFileKinds(files: FileSnapshotEntry[]): Set<OriginKind> {
        // A type the view mints no URL for (isViewFileType, BR:ST1) is only fetched, by the worker.
        const kinds = fileKinds(files.map(entry => (isViewFileType(entry[1]) ? entry[1] : FALLBACK_TYPE)));
        // With guest writes the view may mint URLs for raster images during the environment (R1:R4-4): image loads only.
        if (this._config.guestWrites === true) kinds.add(LOAD_KINDS.image.key);
        return kinds;
    }

    // The host page's Trusted Types directives, where the browser has no Trusted Types to apply them (a browser that has them
    // decides, in the sinks and in the guest: null), and only from the embedder's `hostContentSecurityPolicy`: nothing is
    // applied without the option (host-trusted-types.ts).
    private _trustedTypes(): TrustedTypesStance | null {
        if (browserHasTrustedTypes()) return null;
        const option = this._config.hostContentSecurityPolicy;
        return typeof option === 'string' ? trustedTypesStance(option, TRUSTED_TYPES_POLICY) : null;
    }

    // Every warning a config or a build brings back (the config schema's, the build's about the guest's markup and files,
    // the view's notes) is said here, each text once per element.
    private _warnOnce(message: string) {
        if (this._warned.has(message)) return;
        this._warned.add(message);
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
        // The embedder's own inline height, back as soon as a build without auto-sizing starts (R1:R3-8), whether or not it
        // then completes: the element's, not a resource of the build, and written without embedder code.
        if (!this._autoResizeEnabled()) this._releaseAutoHeight();
        // One copy of the store per build, taken now: the guest's files and the policy come from its snapshot, and the
        // guest-write overlay answers from it (BR:CB4). A later commit reaches the guest only through the next build.
        const built = this._files.copy();
        const files = built.snapshot();
        // Sealed mode has no network (docs/research/24_sealed_mode): a path of its own from here, which takes nothing of
        // `origins` or `fetchBridge` and makes no bridge (_prepareSealedFrame), so the host page's policy is applied to
        // nothing and only its Trusted Types list is read.
        if (this._config.mode === 'sealed') {
            this._refuseByTrustedTypes();
            return this._prepareSealedFrame(built, files);
        }
        // Strict, cooperative and worker mode are the network modes' (network-host.ts, _prepareNetworkBuild). The config
        // schema refuses their configs where the build has none (networkModesOffRefusal), so no other mode reaches a build.
        const network = networkElement(this);
        if (!network) throw mintUncodedError(Error, 'the mode was not refused before the build');
        return network._prepareNetworkBuild(built, files);
    }

    // Where the browser has no Trusted Types: the page's list that does not name the library's policy ends the build, as
    // it does where it has them.
    private _refuseByTrustedTypes() {
        const trustedTypes = this._trustedTypes();
        if (trustedTypes && buildRefused(trustedTypes, this._config.mode as TrustedTypesMode)) throw mintUncodedError(TrustedTypesRefusal, "the host page's trusted-types directive does not name the policy");
    }

    /**
     * Sealed mode (docs/research/24_sealed_mode): the strict view with no network, by construction. The view's policy is
     * sealedViewPolicy (no origins input: every fetch directive 'none' or blob:, connect-src 'none'); the request gate
     * gets no list, so it admits nothing; INIT_VIEW carries no origins; the worker's sandboxFetch() refuses in the guest
     * and sends nothing; and the build has no network to start (no bridge frame). Nothing here reads `origins`,
     * `fetchBridge` or the host page.
     */
    private _prepareSealedFrame(built: FileStore, files: FileSnapshotEntry[]): PreparedBuild {
        return this._prepareViewFrame(built, files, this._sealedPolicy(files), null);
    }

    /**
     * The view of strict and sealed mode (ADR-005). The view document is the policy and the hashed bootstrap, nothing of
     * the guest's; the worker's source (comms, files, the strict prelude, then the entry) and the initial markup travel in
     * INIT_VIEW once the wrapper has loaded. The view mints its own blob: URLs for the registered files it may
     * show, so no JavaScript file is ever given to it. `network` is what strict mode takes of the network options, and
     * null in sealed mode; the build it returns has no network of its own (the caller adds strict mode's).
     */
    private _prepareViewFrame(built: FileStore, files: FileSnapshotEntry[], policy: string, network: ViewNetwork | null): PreparedBuild {
        const mode = network ? 'strict' : 'sealed';
        let entrySource = '';
        const entry = this._config.entry;
        if (typeof entry === 'string' && entry !== '') {
            const file = files.find(candidate => candidate[0] === entry);
            if (!file || !isJavaScriptType(file[1])) throw mintUncodedError(Error, 'the entry was not refused before the build'); // _buildRefusal decides
            entrySource = entryText(file[2]);
        }

        const html = this._config.html || '<div id="root"></div>';
        const sandboxFlags = this._getSandboxFlags();
        const marker = entryDoneName(); // drawn per build: an entry cannot declare a binding of its name (BR:ST4)
        // never a type that opens as a document (BR:ST1); stylesheets with only the URLs the view keeps (files.ts viewStylesheets)
        const viewFiles = viewStylesheets(files.filter(candidate => isViewFileType(candidate[1])));
        for (const drop of viewFiles.dropped) this._warnOnce(viewStylesheetWarning(mode, drop.path, drop.urls, drop.unreadable));
        const strictInit: StrictInit = {
            workerSource: this._getStrictWorkerSource(files, entrySource, marker, network),
            entryDone: marker,
            viewFiles: viewFiles.entries,
            html,
            autoResize: this._autoResizeEnabled(),
            allowAnimations: this._config.allowAnimations === true,
            allowAutoplay: this._config.allowAutoplay === true,
            links: [...this._config.links],
        };
        if (network) strictInit.origins = { images: [...network.origins.images], media: [...network.origins.media] };
        const view = buildViewDocument(policy, viewBootstrapText());

        const iframe = document.createElement("iframe");
        iframe.setAttribute("sandbox", sandboxFlags);
        setWrapperFrameIsolation(iframe);
        iframe.style.cssText = "width:100%;height:100%;border:none";
        setLibrarySrcdoc(iframe, buildWrapperDocument(view, sandboxFlags, []));
        return { iframe, built, strictInit, network: null };
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
        this._listenForAnnouncement(iframe, prepared.network ? prepared.network.bridgeFrame : null, prepared.strictInit === null);
        this.shadowRoot!.appendChild(iframe);
        // The bridge's frame after the wrapper, which stays the shadow root's first. A sealed build has no network: no
        // bridge, and the reserved method refuses, as before the first build (its guest's sandboxFetch() never calls it; a guest's
        // own bridge.call('sandbox:fetch') does, and is refused here, test/e2e/sealed.spec.ts). The method is registered here
        // for every build, with this build's bridge or none: no branch leaves the previous build's handler in place (BD6:TST-1).
        const bridge = prepared.network ? networkElement(this)?._startFetchBridge(prepared.network) ?? null : null;
        this._exposeFetch(bridge);
    }

    // The worker's source in strict mode: the scope check, the globals allowlist, the comms script (bridge, logs, violations, execute,
    // the fetch bridge), sandboxFiles with every registered file, the strict prelude (hardening, sandboxView, the
    // ports), the code-from-string refusal unless scriptUnsafe (code-from-strings.ts), then the guest's entry in a
    // function scope of its own, then the line that marks the entry as having
    // run to its end (it raises the marker error that tells the view so: in-sandbox-view.ts). The entry's own scope
    // (AR:C2): its top-level declarations are local to it, so none can
    // replace a global before the prelude has captured or deleted it; an entry that wants a global assigns it
    // (globalThis.x = …). `this` inside is the global object, as at a script's top level. The scope check
    // (assertEntryScoped) refuses to start a worker whose entry escaped that scope. The prelude's function is strict-mode
    // code (STRICT_DIRECTIVE, BD5:CHL-3) and the entry's is not: it keeps the semantics of the script it was written as.
    // `network`: what strict mode takes of the network options (the request gate's list, the bridge's timeout); null, the
    // default, in sealed mode, whose bootstrap gets `sealed` and no request gate (the worker has no fetch, XMLHttpRequest or WebSocket), so its sandboxFetch() refuses in the guest.
    private _getStrictWorkerSource(files: FileSnapshotEntry[], entrySource: string, marker = entryDoneName(), network: ViewNetwork | null = null): string {
        const features: BootstrapFeatures = network
            ? { externalPort: true, callBudget: { ...this._callBudget }, listeners: bootstrapListeners('strict'), uncaught: { ...UNCAUGHT_BUDGET }, connect: [...network.connect], violationFields: { ...VIOLATION_EVENT_FIELDS } }
            : { externalPort: true, callBudget: { ...this._callBudget }, listeners: bootstrapListeners('sealed'), uncaught: { ...UNCAUGHT_BUDGET }, sealed: true, violationFields: { ...VIOLATION_EVENT_FIELDS } };
        if (network?.fetchBridge) features.fetchBridge = { ...network.fetchBridge };
        if (this._config.guestWrites === true) features.guestWrites = true;
        const scriptUnsafe = this._config.scriptUnsafe === true;
        const sealed = network === null; // no network of the build's own: sealed mode, whose worker has no request maker
        const options = { maxRender: VIEW_RENDER_MAX_LENGTH, maxTarget: VIEW_TARGET_MAX_LENGTH, maxElements: VIEW_MAX_ELEMENTS, maxDepth: VIEW_MAX_DEPTH, maxCharacters: VIEW_MAX_CHARACTERS, maxUrls: VIEW_MAX_URLS, maxDistinctUrls: VIEW_MAX_DISTINCT_URLS, entryDoneName: marker, eventTypes: VIEW_EVENT_TYPES, maxMarks: VIEW_EVENT_LIMITS.maxIds, style: { properties: VIEW_STYLE_PROPERTIES, ...VIEW_SET_STYLE_LIMITS } };
        const prelude = `(function (g) {${STRICT_DIRECTIVE}`
            + `(${assertEntryScoped.toString()})(g);`
            + workerGlobalsStatement('g', scriptUnsafe, sealed)
            + `var comms = (${inSandboxScript.toString()})(${scriptUnsafe}, 'strict', console, ${createBroker.toString()}, ${toInlineScriptLiteral(features)}, ${createSizeOf.toString()}${network ? `, undefined, ${network.requestGateSource}` : ''});`
            + `(${inSandboxFiles.toString()})(${toInlineScriptLiteral(files)}, ${this._config.guestWrites === true ? 'comms.writeFiles' : 'null'}, ${toInlineScriptLiteral(VIEW_FILE_TYPES)});`
            + `(${inStrictWorker.toString()})(comms, ${toInlineScriptLiteral(options)}, ${isStyleProperty.toString()});`
            + (scriptUnsafe ? '' : refuseCodeFromStringsStatement('g'))
            + '})(this);';
        return `${prelude}\n(function () {\n${entrySource}\n}).call(this);\n${marker}();\n`;
    }

    // Sealed mode is the default and its view is strict mode's, so markup written for cooperative mode reaches that view
    // unchanged: its scripts and handlers never run (the renderer drops them, and the view's policy admits only the
    // bootstrap). Said once per element and mode, in the mode's words, from what the view's renderer noted it dropped of
    // the initial view (VIEW_INITIAL). The element reads no markup of a strict or sealed build itself: a parser of the host
    // page's realm would check the guest's markup against the host page's policy, and report it (BD7:LIM-1; HOST_PASSES,
    // host-passes.ts).
    private _warnAboutStrictHtml(dropped: unknown) {
        if (!hasStrictView(this._config.mode) || !dropsScript(dropped)) return;
        this._warnOnce(this._config.mode === 'sealed' ? SEALED_HTML_SCRIPT_WARNING : STRICT_HTML_SCRIPT_WARNING);
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
    // (_setupStrictChannels) nor _setupChannel flushes: two flush points for one rule would let strict mode's release a
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

    // The executor's entry as a method, for what is not in this module: the network modes' methods, which hand the reducer
    // their inputs (network-host.ts: the announcement, the execution timeout), and the tests, which deliver the platform's
    // lifecycle inputs by hand where jsdom cannot (the view's check-in, the wrapper's load; test/unit/check-in.ts). The
    // class itself never calls it.
    private _step(input: LcInput) {
        step(this, input);
    }
}

// The lifecycle (BR:CB7). Each function reaches the element's own fields and the class's methods through
// WebSandbox.prototype, never through the element's prototype chain: in Firefox an element adopted into another
// document has that document's HTMLElement prototype. The methods applied here use the element's own fields, and those
// that build (_buildContext past its first line, _prepareBuild, _attachBuild, _startLoadDeadline) run only
// in the defining document, where the element has its own prototype (connected restores it first).
const LIFECYCLE = WebSandbox.prototype as unknown as {
    _buildContext(): BuildContext;
    _prepareBuild(): PreparedBuild;
    _attachBuild(prepared: PreparedBuild): void;
    _startLoadDeadline(): void;
    _teardown(): void;
    _discardGuestWrites(): void;
    _dispatchHostLog(level: SandboxLogLevel, text: string): void;
    _dispatchGuestLog(frame: unknown): void;
    _stopLoadDeadline(): void;
    _setupStrictChannels(target: Window): void;
    _checkView(height: unknown, stillStyleRefused: boolean): void;
    _flush(): void;
    _startWatchdogs(): void;
    _startAutoResize(): void;
};

// The element as the holder of the network modes' methods (network-modes.ts, NetworkElement), which the network build
// installs on its prototype; null in a build without them, where the element has none.
const networkElement = (element: WebSandbox): NetworkElement | null => (networkModes() === null ? null : element as unknown as NetworkElement);

// What the executor reaches on the element: its own fields, whatever its prototype (BR:CB7).
interface LifecycleFields {
    _lc: LcState;
    _warnedForeignDocument: boolean;
}

// The context of a build where the element may not build (buildsHere): it stops instead, and asks nothing else.
const NOT_HERE: BuildContext = Object.freeze({ buildsHere: false, blocked: null, strict: false, announces: false });

/**
 * The lifecycle executor's one entry (S65; src/lib/lifecycle.ts, `step`): reduce `input` against the element's
 * `_lc`, store the next state, then run the effects on the element. Every transition comes through here: every build
 * (the DOM callbacks, start(), reset()) and its completion (the wrapper's load, the guest's announcement,
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
        // Only a build of the network modes announces a port, and has the method (network-host.ts, _setupChannel): reached
        // through the class's prototype, where that build installed it, as every effect is (BR:CB7).
        openChannel: (port) => {
            const setupChannel = (LIFECYCLE as unknown as Partial<NetworkElement>)._setupChannel;
            if (setupChannel) Reflect.apply(setupChannel, element, [port as MessagePort | null]);
        },
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

// start() on an element that has its app (I1): another app is another element.
function alreadyStarted(): TypeError {
    return mintUncodedError(TypeError, '[Sandbox] start(): this element already runs its app; another app is another element.');
}

// A line of the element's own, said before the termination it announces (the executor dispatches it: `notices`).
export function hostNotice(text: string): Notice {
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

// Whether the view's notes of what it dropped (VIEW_INITIAL: at most three constants) name a script or a handler.
function dropsScript(dropped: unknown): boolean {
    if (!Array.isArray(dropped)) return false;
    for (let i = 0; i < dropped.length && i < 3; i++) {
        if (dropped[i] === 'script' || dropped[i] === 'handler') return true;
    }
    return false;
}

// Insertion: the reducer's `connect` builds, or, where the element may not build, stops and warns once (`initialize`,
// `warnForeignDocument`). Neither dispatches anything synchronously: a build's failure comes in a task (R1:R3-2).
function connected(element: WebSandbox) {
    // The engine refuses to give a Firefox-adopted element its prototype back: it stays idle (it stopped when it left).
    if (buildsHere(element) && !restorePrototype(element)) return;
    step(element, { t: 'connect', ctx: Reflect.apply(LIFECYCLE._buildContext, element, []) });
}

// Firefox gives an element adopted into another document that document's HTMLElement prototype (BR:CB7): its methods are
// gone there, so a call would throw a TypeError, and a commit would change the store and then throw before its
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
    if (existing && existing !== WebSandbox) throw mintUncodedError(Error, `<${tagName}> is already defined by another element`);
    if (!existing) customElements.define(tagName, WebSandbox);
    return WebSandbox;
}
