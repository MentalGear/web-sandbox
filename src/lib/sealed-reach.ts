/**
 * Everything a sealed guest can reach, classified against every row of INHERITED_CONTEXT (S74, class A). In sealed mode
 * guest code reaches the browser through two allowlists only: the worker's globals (worker-globals.ts, with the library's
 * own names and the syntax the language gives) and what the view's renderer admits (its elements, attributes and load
 * kinds, in-sandbox-view.ts; the view runs no guest script). Each name of those lists is classified here against each row:
 *  - `none`: the name cannot make the browser consult the row's inherited state, nor read it, and the cell says why;
 *  - `neutralised`: it could, and a chokepoint of the library stands in front of it (CHOKEPOINTS, each a declaration or a
 *    statement of the code, which the structural test finds);
 *  - `remains`: it does, and what follows is one of the row's documented residuals (INHERITED_CONTEXT, `residuals`), each
 *    with the test that pins it.
 *
 * So class A is closed by enumeration, as the other closed classes were (docs/research/18_finding_classes): a channel of
 * the host page's context that a sealed guest could reach is a cell of this table, not a finding waiting for a review.
 * test/unit/sealed-reach.test.ts fails when a name of either allowlist has no surface, when a row has no column, when a
 * cell names a chokepoint the code does not have, and when a `remains` cell names no residual of its row; so a new
 * allowlisted name, element, attribute or load kind cannot ship unclassified, nor a new row without its column.
 *
 * The table is written by surface: every name has exactly one (what it can do), and each row's column says what each
 * surface is to that row, or, where a single name differs from its surface, what that name is. A cell is looked up by
 * name, then by surface, then by side (`worker` or `view`), and a surface the column does not name is `none` for the
 * column's `rest` reason. A prototype member is classified with its global (the members that differ are listed in
 * REACH_MEMBERS); test/e2e/sealed-reach.spec.ts calls every member of every global the sealed worker keeps, on every
 * engine, on a host page whose policy has a nonce, `'report-sample'` and a keyed report endpoint, and holds that none
 * makes a request, raises a violation or sends a report.
 *
 * Values first: the names come from the lists the code keeps (WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS,
 * CODE_FROM_STRING_SINKS, RENDER_ELEMENTS, RENDER_ATTRIBUTES, VIEW_LOAD_KINDS) and the library's own names below.
 * Internal: not exported from the package.
 */
import { CODE_FROM_STRING_SINKS } from './code-from-strings';
import { sealedHostPasses } from './host-passes';
import { RENDER_ATTRIBUTES, RENDER_ELEMENTS, VIEW_LOAD_KINDS } from './in-sandbox-view';
import type { InheritedContextId } from './inherited-context';
import { SECURE_CONTEXT_ONLY, WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS } from './worker-globals';

/** The relations of a name to a row. */
export const REACH_RELATIONS = ['none', 'neutralised', 'remains'] as const;
export type ReachRelation = (typeof REACH_RELATIONS)[number];

/** A chokepoint of the library: what it does, and the declaration or statement in `file` that is it (`token`, verbatim). */
export interface Chokepoint {
    readonly what: string;
    readonly file: string;
    readonly token: string;
}

/** The library's chokepoints a `neutralised` cell may name. */
export const CHOKEPOINTS = {
    requestGate: {
        what: "the request gate: the guest's `fetch`, `XMLHttpRequest` and `WebSocket` admit only the guest policy's `connect-src` sources, which sealed mode has none of, and refuse before the platform",
        file: 'src/lib/in-sandbox-script.ts',
        token: 'const replaceGlobal = (name: string, original: unknown, value: unknown, enumerable: boolean) =>',
    },
    sealedFetchRefusal: {
        what: '`sandboxFetch()` refuses in the guest with `FETCH_NOT_ALLOWED` and sends nothing to the host',
        file: 'src/lib/in-sandbox-script.ts',
        token: "'[sandboxFetch] FETCH_NOT_ALLOWED: sealed mode has no network'",
    },
    codeFromStringRefusal: {
        what: "the prelude puts the library's `EvalError` in place of every code-from-string sink (CODE_FROM_STRING_SINKS), which never calls the platform",
        file: 'src/lib/code-from-strings.ts',
        token: 'export function refuseCodeFromStrings(',
    },
    entryImportRefusal: {
        what: 'the build refuses an entry that holds an import expression (`import()`, or a phase of one: `import.source()`, `import.defer()`), with the reason `entryImport`, so no worker runs it',
        file: 'src/lib/entry-imports.ts',
        token: 'export function dynamicImportAt(',
    },
    strictWorkerAllowlist: {
        what: "strict and sealed mode's worker globals have no `importScripts`",
        file: 'src/lib/worker-globals.ts',
        token: 'export const STRICT_WORKER_GLOBALS',
    },
    webAssemblyRemoval: {
        what: "the worker's allowlist has no `WebAssembly` unless `scriptUnsafe`, which sealed mode refuses",
        file: 'src/lib/worker-globals.ts',
        token: 'export const workerGlobalsFor',
    },
    createObjectUrlRemoval: {
        what: 'the strict prelude deletes `URL.createObjectURL`: the guest mints no URL the view could load',
        file: 'src/lib/in-sandbox-view.ts',
        token: "remove(urlStatics, 'createObjectURL');",
    },
    violationStop: {
        what: "the bootstrap's first capture listener relays a trusted violation and stops it, so no listener of the guest's hears one",
        file: 'src/lib/in-sandbox-script.ts',
        token: 'const stopViolation = (event: Event) =>',
    },
    violationFieldBlanking: {
        what: 'every field of `SecurityPolicyViolationEvent.prototype` reads blank to guest code (VIOLATION_EVENT_FIELDS)',
        file: 'src/lib/in-sandbox-script.ts',
        token: 'const blankViolationFields = () =>',
    },
    originCheck: {
        what: "every frame is sandboxed without `allow-same-origin`, and every bootstrap stays inert unless its origin reads `'null'` (the environment check's `origin` row): the view and its worker have an opaque origin of their own",
        file: 'src/lib/environment-check.ts',
        token: "reason: 'environmentOrigin'",
    },
    baseCheck: {
        what: "every bootstrap stays inert unless its document's base URL is `about:blank` (the environment check's `base` row): a relative URL resolves to nothing",
        file: 'src/lib/environment-check.ts',
        token: "reason: 'environmentBase'",
    },
    isolationRefusal: {
        what: 'the element refuses to build on a host page that is cross-origin isolated, before any frame exists',
        file: 'src/host.ts',
        token: 'private _buildRefusal(): string | null {',
    },
    viewPolicy: {
        what: "sealed mode's view policy: `script-src` is the bootstrap's hash alone and no source is a network one, so no guest script runs in the view",
        file: 'src/lib/csp/csp-generator.ts',
        token: 'export function sealedViewPolicy(',
    },
    viewViolationRelay: {
        what: "the view relays a violation's directive, blocked URL and place to the element, never its policy text, and never to the worker",
        file: 'src/lib/in-sandbox-view.ts',
        token: "toHost({ type: 'VIOLATION', directive: name,",
    },
    urlKeepRule: {
        what: "the one rule for a URL in the view (keepsUrl, BD7:ISO-1): a URL attribute, a CSS reference or a registered stylesheet's reference is kept only when it is a URL the view minted, the empty URL, a fragment of the view's document in an SVG reference property, or text that names no URL; everything else goes, whatever its scheme or spelling",
        file: 'src/lib/css-references.ts',
        token: 'export function keepsUrl(',
    },
    rendererUrlDrop: {
        what: 'the renderer keeps a URL attribute only as the URL rule allows (a `blob:` URL the view minted; sealed mode lists no origin), before insertion',
        file: 'src/lib/in-sandbox-view.ts',
        token: 'export function sanitizeRender(',
    },
    cssUrlDrop: {
        what: "every reference of guest CSS the URL rule does not keep (`url()`, `image-set()`, `@import`, `@font-face`, a string) becomes `\"\"` before the view applies it, and every one of a registered stylesheet before the view gets it",
        file: 'src/lib/css-references.ts',
        token: 'export function withKeptReferences(',
    },
    styleEncoding: {
        what: "the view's parser is given the guest's markup with no `style` attribute and no `<style>` element in it, in any context (styleMarkup renames them first): Chromium checks a style attribute as it parses it",
        file: 'src/lib/style-markup.ts',
        token: 'export function styleMarkup(nonce: string): StyleMarkup {',
    },
    cssomDeclaration: {
        what: "a guest style attribute's text becomes the element's CSSOM declaration (the `cssText` setter), which no `style-src` checks, on any engine; no attribute named style is written from guest text",
        file: 'src/lib/in-sandbox-view.ts',
        token: 'call(setCssText, style, [css]);',
    },
    adoptedSheets: {
        what: "a guest `<style>` is an inert `noframes` holding its text, which the view applies as a constructed stylesheet it adopts, in tree order; no `style-src` checks one, on any engine, and no `<style>` element of the guest's is ever in the view",
        file: 'src/lib/in-sandbox-view.ts',
        token: 'const syncSheets = (target: Element, added: readonly Element[]) => {',
    },
    linkRelations: {
        what: 'a kept `<link>` has only the `stylesheet` and `icon` relations: no preload, prefetch or preconnect',
        file: 'src/lib/in-sandbox-view.ts',
        token: "const LINK_RELATIONS = ['stylesheet', 'icon'] as const;",
    },
    svgLocalReferences: {
        what: "SVG paint, clip and mask references name only a fragment of the view's own document",
        file: 'src/lib/in-sandbox-view.ts',
        token: "svgLocalReferences: ['fill', 'stroke', 'clip-path', 'mask'],",
    },
    inertHref: {
        what: "every hyperlink's href becomes `about:blank#` before insertion: no URL of the guest's to navigate to, copy or open",
        file: 'src/lib/in-sandbox-view.ts',
        token: "export const INERT_HREF = 'about:blank#';",
    },
    navigationCancel: {
        what: 'the view cancels every click and auxclick on a link and every submit: no navigation from rendered markup',
        file: 'src/lib/in-sandbox-view.ts',
        token: "addEventListener('click', cancelLink, true);",
    },
    forcedNoReferrer: {
        what: 'the renderer gives every `a`, `area`, `img` and `link` `referrerpolicy="no-referrer"`, whatever the guest wrote',
        file: 'src/lib/in-sandbox-view.ts',
        token: "referrerElements: ['a', 'area', 'img', 'link'],",
    },
    forcedCrossorigin: {
        what: 'the renderer gives every `img`, `video`, `audio` and `link` `crossorigin="anonymous"` before it is connected: no load carries credentials',
        file: 'src/lib/in-sandbox-view.ts',
        token: "['img', 'crossorigin', 'anonymous'],",
    },
    forcedMediaControls: {
        what: 'the renderer gives every `video` `disablepictureinpicture` and every `video` and `audio` `disableremoteplayback`, whatever the guest wrote, before it is connected: the user agent offers no picture-in-picture and no remote playback for the guest\'s media (BD7:ISO-3)',
        file: 'src/lib/in-sandbox-view.ts',
        token: "['video', 'disablepictureinpicture', ''],",
    },
    autoplaySwitch: {
        what: 'the `autoplay` attribute goes unless `allowAutoplay`',
        file: 'src/lib/in-sandbox-view.ts',
        token: "&& !(attribute === 'autoplay' && !switches.autoplay);",
    },
    noDelegation: {
        what: "strict and sealed mode's frames carry no `allow` attribute: no feature is delegated, so a host Permissions-Policy only narrows what no frame has",
        file: 'src/host.ts',
        token: 'if (hasStrictView(this._config.mode)) return permissions;',
    },
    viewEventList: {
        what: 'the view forwards only the event types of VIEW_EVENT_TYPES, none of them a media event',
        file: 'src/lib/in-sandbox-view.ts',
        token: 'export const VIEW_EVENT_TYPES',
    },
    viewFocusRule: {
        what: "`set({ focus })` moves focus only while the view's document has the user's focus: it never takes focus from the host page",
        file: 'src/lib/in-sandbox-view.ts',
        token: "if (!call(hasFocus, document, [])) throw new RangeError('VIEW_FOCUS');",
    },
    trustedTypesPolicy: {
        what: "the view parses the guest's markup through the library's own Trusted Types policy, never a string to a sink",
        file: 'src/lib/trusted-types.ts',
        token: "export const TRUSTED_TYPES_POLICY = 'web-sandbox';",
    },
    brokerCapture: {
        what: "host code reads what the guest sends (calls, writes, view frames, errors) through intrinsics captured before any guest data arrives, and measures it as a snapshot",
        file: 'src/lib/rpc.ts',
        token: 'export function createBroker(',
    },
    logRelay: {
        what: "a guest's log line reaches the host page as a normalised `sandbox-log` detail, never through the host page's `console`",
        file: 'src/lib/sandbox-log.ts',
        token: 'export function toLogDetail(',
    },
    teardownDetach: {
        what: 'the teardown detaches the old environment before it releases anything, so a listener the removal runs re-enters a consistent element',
        file: 'src/lib/environment.ts',
        token: 'export function detachEnvironment(',
    },
    hostPassRule: {
        what: "every pass of the host realm over guest content a sealed build runs is library code over strings and bytes: it hands nothing of the guest's to a platform parser, loader or policy-checked API, and its cost is linear in what it takes (HOST_PASSES; test/unit/host-passes.test.ts scans every pass and the view's frame builders)",
        file: 'src/lib/host-passes.ts',
        token: 'export const HOST_PASSES = {',
    },
    secureContextRemoval: {
        what: "strict and sealed mode's worker has nothing only a secure context has, and reads `isSecureContext` as false, on every engine and page (SECURE_CONTEXT_ONLY): its globals and navigator members are off the strict allowlists, and the prelude deletes its members and pins `isSecureContext`; the surface Chromium's worker has on every page",
        file: 'src/lib/worker-globals.ts',
        token: 'export function removeSecureContextOnly(',
    },
} as const satisfies Record<string, Chokepoint>;
export type ChokepointId = keyof typeof CHOKEPOINTS;

/**
 * The library's own names on the sealed worker's global object (its guest API): the bridge (`bridge`, in-sandbox-script.ts),
 * the files (`sandboxFiles`, in-sandbox-files.ts), the view (`sandboxView`, in-sandbox-view.ts) and the fetch bridge's guest
 * side (`sandboxFetch`, in-sandbox-script.ts). test/e2e/sealed-reach.spec.ts holds that the worker's global object has
 * exactly these besides STRICT_WORKER_GLOBALS (and the entry's marker, ENTRY_DONE_PREFIX).
 */
export const LIBRARY_GUEST_GLOBALS = ['bridge', 'sandboxFiles', 'sandboxView', 'sandboxFetch'] as const;

/** A member of an interface's prototype, as the table names it. */
const prototypeMember = ([owner, member]: readonly [string, string]) => `${owner}.prototype.${member}`;

/**
 * The members of a kept global that are classified on their own, because they differ from their global's surface: the
 * static the prelude removes, and the secure-context-only members (SECURE_CONTEXT_ONLY). Every other member is its
 * global's.
 */
export const REACH_MEMBERS: readonly string[] = ['URL.createObjectURL', ...SECURE_CONTEXT_ONLY.members.map(prototypeMember)];

/** Every name of the table that only a secure context has: its globals, navigator members and members (SECURE_CONTEXT_ONLY). */
export const secureContextOnlyNames = (): string[] => [
    ...SECURE_CONTEXT_ONLY.globals,
    ...SECURE_CONTEXT_ONLY.navigator.map(member => `navigator.${member}`),
    ...SECURE_CONTEXT_ONLY.members.map(prototypeMember),
];

/** `import()`: syntax, which nothing at run time can take from the language. */
export const DYNAMIC_IMPORT = 'import()';

/**
 * The phases of an import (TC39 proposals an engine may run behind a flag): syntax too, which the build refuses with
 * `import()` (entry-imports.ts; BD7:CHL-1).
 */
export const IMPORT_PHASES = ['import.source()', 'import.defer()'] as const;

/** Every import expression: `import()` and its phases. */
export const IMPORT_EXPRESSIONS: readonly string[] = [DYNAMIC_IMPORT, ...IMPORT_PHASES];

/** Where a name is found. */
export const REACH_DOMAINS = ['global', 'navigator', 'library', 'member', 'syntax', 'element', 'attribute', 'loadKind', 'hostPass'] as const;
export type ReachDomain = (typeof REACH_DOMAINS)[number];

/**
 * The realm a domain belongs to: the guest's worker, the view, or the host page's own, where the element runs the passes
 * over guest content a sealed build makes (HOST_PASSES, host-passes.ts; BD7:LIM-1): the third realm that handles guest
 * content, where the browser consults the host page's policy for what the host realm parses or loads.
 */
export const REACH_SIDES = ['worker', 'view', 'host'] as const;
export type ReachSide = (typeof REACH_SIDES)[number];
const SIDE_OF: Readonly<Record<ReachDomain, ReachSide>> = {
    global: 'worker', navigator: 'worker', library: 'worker', member: 'worker', syntax: 'worker',
    element: 'view', attribute: 'view', loadKind: 'view', hostPass: 'host',
};
export const sideOf = (domain: ReachDomain): ReachSide => SIDE_OF[domain];

export interface ReachName {
    readonly name: string;
    readonly domain: ReachDomain;
}

const namespaces = ['html', 'svg', 'mathml'] as const;

/** The view's attribute names: `ns:*@name` for one on every element of a namespace, `ns:element@name` for one element's. */
function attributeNames(): string[] {
    const names: string[] = [];
    for (const ns of namespaces) for (const pattern of ['data-*', 'aria-*']) names.push(`${ns}:*@${pattern}`);
    for (const name of RENDER_ATTRIBUTES.html) names.push(`html:*@${name}`);
    for (const [element, attributes] of Object.entries(RENDER_ATTRIBUTES.htmlElements)) {
        for (const name of attributes) names.push(`html:${element}@${name}`);
    }
    for (const name of RENDER_ATTRIBUTES.svg) names.push(`svg:*@${name}`);
    for (const name of RENDER_ATTRIBUTES.svgLink) names.push(`svg:a@${name}`);
    for (const name of RENDER_ATTRIBUTES.mathml) names.push(`mathml:*@${name}`);
    return names;
}

/** The syntax that reaches a compiler: the import expressions, and each function kind's constructor (CODE_FROM_STRING_SINKS). */
function syntaxNames(): string[] {
    const names: string[] = [...IMPORT_EXPRESSIONS];
    for (const [id, sink] of Object.entries(CODE_FROM_STRING_SINKS)) {
        if (sink.kind === 'function-kind') names.push(id);
    }
    return names;
}

/** Every name a sealed guest can reach, from the lists the code keeps. */
export function sealedReachNames(): ReachName[] {
    const names: ReachName[] = [];
    const add = (domain: ReachDomain, list: Iterable<string>) => {
        for (const name of list) names.push({ name, domain });
    };
    add('global', WORKER_GLOBALS);
    add('navigator', WORKER_NAVIGATOR_MEMBERS.map(member => `navigator.${member}`));
    add('library', LIBRARY_GUEST_GLOBALS);
    add('member', REACH_MEMBERS);
    add('syntax', syntaxNames());
    for (const ns of namespaces) add('element', RENDER_ELEMENTS[ns].map(element => `${ns}:${element}`));
    add('attribute', attributeNames());
    add('loadKind', Object.keys(VIEW_LOAD_KINDS).map(kind => `load:${kind}`));
    add('hostPass', hostPassNames());
    return names;
}

/** The passes of the host realm over guest content a sealed build runs, as the table names them: `host:<row of HOST_PASSES>`. */
const hostPassNames = (): string[] => sealedHostPasses().map(id => `host:${id}`);

/** A string of names separated by white space, as a list. */
const words = (text: string): readonly string[] => text.trim().split(/\s+/);

export interface Surface {
    readonly side: ReachSide;
    /** What the names of this surface can do. */
    readonly what: string;
    readonly names: readonly string[];
}

/** What each name can do: every name of sealedReachNames() is in exactly one surface. */
export const SURFACES = {
    // ---- the worker
    language: {
        side: 'worker',
        what: "the language's values and functions, and the platform's that compute on their arguments alone",
        names: words(`
            globalThis Infinity NaN undefined isFinite isNaN parseFloat parseInt decodeURI decodeURIComponent encodeURI
            encodeURIComponent escape unescape Object Array Number Boolean String Symbol BigInt RegExp Promise Proxy Reflect JSON
            Math Iterator Error AggregateError EvalError RangeError ReferenceError SyntaxError TypeError URIError SuppressedError
            InternalError ArrayBuffer DataView Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array
            Uint32Array Float16Array Float32Array Float64Array BigInt64Array BigUint64Array Map Set WeakMap WeakSet WeakRef
            FinalizationRegistry DisposableStack AsyncDisposableStack structuredClone atob btoa DOMException QuotaExceededError
            DOMStringList`),
    },
    clock: { side: 'worker', what: "dates, times and locales: the profile's time zone and locale", names: words('Date Intl Temporal') },
    isolation: {
        side: 'worker',
        what: 'what cross-origin isolation decides: shared memory, and whether the realm reads as isolated',
        names: words('SharedArrayBuffer Atomics crossOriginIsolated'),
    },
    code: {
        side: 'worker',
        what: 'compile a string as code: `eval`, `Function` and the constructor of every function kind',
        names: words(`eval Function ${syntaxNames().filter(name => !IMPORT_EXPRESSIONS.includes(name)).join(' ')}`),
    },
    timers: { side: 'worker', what: 'schedule a handler, and compile it when it is a string', names: words('setTimeout setInterval') },
    dynamicImport: { side: 'worker', what: 'load and run a module by URL, in any phase', names: IMPORT_EXPRESSIONS },
    scheduling: {
        side: 'worker',
        what: 'schedule work the guest gives as a function',
        names: words('clearTimeout clearInterval queueMicrotask requestAnimationFrame cancelAnimationFrame scheduler Scheduler TaskController TaskSignal TaskPriorityChangeEvent'),
    },
    webAssembly: { side: 'worker', what: 'compile bytes as code', names: ['WebAssembly'] },
    scope: {
        side: 'worker',
        what: "the worker's own scope: its global object, origin, URL, name, navigator and end",
        names: words('self location origin name close isSecureContext DedicatedWorkerGlobalScope WorkerGlobalScope WorkerLocation navigator WorkerNavigator'),
    },
    events: {
        side: 'worker',
        what: "events and the worker's error handlers: values the guest makes or the platform dispatches in its realm",
        names: words('onerror onrejectionhandled onunhandledrejection onlanguagechange onoffline ononline reportError Event CustomEvent ErrorEvent MessageEvent ProgressEvent PromiseRejectionEvent CloseEvent'),
    },
    listeners: { side: 'worker', what: 'listen for an event the platform dispatches, `securitypolicyviolation` included', names: ['EventTarget'] },
    violationEvent: { side: 'worker', what: "a CSP violation's fields, the refusing policy's text among them", names: ['SecurityPolicyViolationEvent'] },
    console: { side: 'worker', what: "log lines, which the library relays to the element", names: ['console'] },
    requests: {
        side: 'worker',
        what: 'make a request',
        names: words('fetch XMLHttpRequest XMLHttpRequestEventTarget XMLHttpRequestUpload WebSocket'),
    },
    importScripts: { side: 'worker', what: 'load and run a classic script by URL', names: ['importScripts'] },
    fetchValues: { side: 'worker', what: 'values of a request and its response, which make no request', names: words('Request Response Headers FormData AbortController AbortSignal') },
    messaging: { side: 'worker', what: "message channels the guest makes inside its realm", names: words('MessageChannel MessagePort') },
    originStorage: {
        side: 'worker',
        what: "storage and coordination keyed to the realm's origin: databases, locks, broadcast channels",
        names: words(`indexedDB IDBCursor IDBCursorWithValue IDBDatabase IDBFactory IDBIndex IDBKeyRange IDBObjectStore IDBOpenDBRequest
            IDBRecord IDBRequest IDBTransaction IDBVersionChangeEvent Lock LockManager BroadcastChannel navigator.locks`),
    },
    bytes: {
        side: 'worker',
        what: 'bytes, text, streams and URLs as values',
        names: words(`Blob File FileList FileReader FileReaderSync URL URLSearchParams URLPattern TextDecoder TextEncoder
            TextDecoderStream TextEncoderStream CompressionStream DecompressionStream ReadableStream ReadableStreamDefaultReader
            ReadableStreamBYOBReader ReadableStreamBYOBRequest ReadableStreamDefaultController ReadableByteStreamController
            WritableStream WritableStreamDefaultWriter WritableStreamDefaultController TransformStream
            TransformStreamDefaultController ByteLengthQueuingStrategy CountQueuingStrategy`),
    },
    crypto: { side: 'worker', what: 'random values, hashes, keys and ciphers', names: words('Crypto CryptoKey SubtleCrypto crypto Crypto.prototype.subtle Crypto.prototype.randomUUID') },
    performance: {
        side: 'worker',
        what: "the worker's own timeline and clock",
        names: words(`performance Performance PerformanceEntry PerformanceMark PerformanceMeasure PerformanceObserver
            PerformanceObserverEntryList PerformanceResourceTiming PerformanceServerTiming
            PerformanceResourceTiming.prototype.serverTiming`),
    },
    graphics: {
        side: 'worker',
        what: 'geometry, images and drawing on an OffscreenCanvas, from values the guest holds (no URL)',
        names: words(`DOMMatrix DOMMatrixReadOnly DOMPoint DOMPointReadOnly DOMQuad DOMRect DOMRectReadOnly ImageData ImageBitmap
            ImageBitmapRenderingContext OffscreenCanvas OffscreenCanvasRenderingContext2D CanvasGradient CanvasPattern Path2D
            TextMetrics WebGLRenderingContext WebGL2RenderingContext WebGLActiveInfo WebGLBuffer WebGLContextEvent
            WebGLFramebuffer WebGLObject WebGLProgram WebGLQuery WebGLRenderbuffer WebGLSampler WebGLShader
            WebGLShaderPrecisionFormat WebGLSync WebGLTexture WebGLTransformFeedback WebGLUniformLocation
            WebGLVertexArrayObject createImageBitmap`),
    },
    codecs: {
        side: 'worker',
        what: 'encode and decode media the guest holds as bytes, and ask what the device decodes',
        names: words(`AudioData AudioDecoder AudioEncoder EncodedAudioChunk EncodedVideoChunk VideoColorSpace VideoDecoder VideoEncoder
            VideoFrame ImageDecoder ImageTrack ImageTrackList MediaCapabilities navigator.mediaCapabilities`),
    },
    device: {
        side: 'worker',
        what: 'what the navigator says of the browser, the device and the profile',
        names: words(`navigator.appCodeName navigator.appName navigator.appVersion navigator.platform navigator.product
            navigator.userAgent navigator.language navigator.languages navigator.onLine navigator.hardwareConcurrency
            navigator.deviceMemory navigator.globalPrivacyControl navigator.gpu`),
    },
    bridge: { side: 'worker', what: "call the embedder's exposed methods and expose the guest's", names: ['bridge'] },
    files: { side: 'worker', what: "read the registered files, and write the guest's own", names: ['sandboxFiles'] },
    viewApi: { side: 'worker', what: 'render markup into the view, set what `set()` admits, and hear the events the view forwards', names: ['sandboxView'] },
    fetchBridge: { side: 'worker', what: "the fetch bridge's guest side", names: ['sandboxFetch'] },
    preludeRemoved: { side: 'worker', what: 'mint a `blob:` URL of bytes the guest holds', names: ['URL.createObjectURL'] },

    // ---- the view: elements
    markup: {
        side: 'view',
        what: 'text, structure, tables, lists, form widgets that only show a value, and SVG and MathML that draw: no load, URL or style of their own',
        names: words(`
            html:address html:article html:aside html:footer html:header html:h1 html:h2 html:h3 html:h4 html:h5 html:h6 html:hgroup
            html:main html:nav html:section html:search html:blockquote html:dd html:div html:dl html:dt html:figcaption html:figure
            html:hr html:li html:menu html:ol html:p html:pre html:ul html:abbr html:b html:bdi html:bdo html:br html:cite html:code
            html:data html:dfn html:em html:i html:kbd html:mark html:q html:s html:samp html:small html:span html:strong html:sub
            html:sup html:time html:u html:var html:del html:ins html:map html:table html:caption html:colgroup html:col html:tbody
            html:thead html:tfoot html:tr html:td html:th html:label html:datalist html:optgroup html:option html:output
            html:progress html:meter html:fieldset html:legend
            svg:svg svg:g svg:defs svg:symbol svg:title svg:desc svg:rect svg:circle svg:ellipse svg:line svg:polyline svg:polygon
            svg:path svg:text svg:tspan svg:linearGradient svg:radialGradient svg:stop svg:clipPath svg:mask svg:pattern
            mathml:math mathml:semantics mathml:annotation mathml:merror mathml:mfrac mathml:mi mathml:mmultiscripts mathml:mn
            mathml:mo mathml:mover mathml:mpadded mathml:mphantom mathml:mprescripts mathml:mroot mathml:mrow mathml:ms
            mathml:mspace mathml:msqrt mathml:mstyle mathml:msub mathml:msubsup mathml:msup mathml:mtable mathml:mtd mathml:mtext
            mathml:mtr mathml:munder mathml:munderover mathml:none`),
    },
    loader: {
        side: 'view',
        what: 'an element that loads what its URL attribute names (each classified with that attribute and its load kind)',
        names: words('html:img html:picture html:source html:video html:audio html:track html:link'),
    },
    hyperlink: { side: 'view', what: 'a link the user can follow', names: words('html:a html:area svg:a') },
    form: { side: 'view', what: 'a form and the controls the user types into or presses', names: words('html:form html:input html:button html:select html:textarea') },
    disclosure: { side: 'view', what: 'a widget the user opens and closes', names: words('html:details html:summary html:dialog') },
    styleElement: { side: 'view', what: "a stylesheet of the guest's, as an element", names: words('html:style svg:style') },

    // ---- the view: attributes
    styleAttribute: { side: 'view', what: "an inline style of the guest's", names: words('html:*@style svg:*@style mathml:*@style') },
    urlAttribute: {
        side: 'view',
        what: 'a URL the view loads: a registered file (a `blob:` URL the view minted) or a network URL',
        names: words('html:img@src html:img@srcset html:source@src html:source@srcset html:video@src html:video@poster html:audio@src html:track@src html:link@href'),
    },
    linkHref: { side: 'view', what: "a hyperlink's destination", names: words('html:a@href html:area@href svg:a@href svg:a@xlink:href mathml:*@href') },
    referrerPolicyAttribute: {
        side: 'view',
        what: "an element's referrer policy",
        names: words('html:a@referrerpolicy html:area@referrerpolicy html:img@referrerpolicy html:link@referrerpolicy svg:a@referrerpolicy'),
    },
    linkRelation: { side: 'view', what: "a `<link>`'s relation, which decides what it loads", names: ['html:link@rel'] },
    autoplay: { side: 'view', what: 'start media without the user', names: words('html:video@autoplay html:audio@autoplay') },
    mediaControls: {
        side: 'view',
        what: "the browser's own media controls (fullscreen, picture-in-picture, remote playback), which the user drives",
        names: words('html:video@controls html:audio@controls html:video@controlslist html:audio@controlslist'),
    },
    svgReference: { side: 'view', what: 'a reference from an SVG shape to a paint server, clip path or mask', names: words('svg:*@fill svg:*@stroke svg:*@clip-path svg:*@mask') },
    focusAttribute: { side: 'view', what: 'make an element focusable', names: words('html:*@tabindex svg:*@tabindex mathml:*@tabindex') },
    presentation: {
        side: 'view',
        what: 'how an element renders, what it means, how a control behaves or how a load its URL attribute names is made: no URL, load or style of its own',
        names: words(`
            html:*@data-* html:*@aria-* svg:*@data-* svg:*@aria-* mathml:*@data-* mathml:*@aria-*
            html:*@id html:*@class html:*@title html:*@lang html:*@dir html:*@hidden html:*@role html:*@translate html:*@inert
            html:*@spellcheck html:*@inputmode html:*@enterkeyhint html:*@autocapitalize
            html:a@rel html:a@hreflang html:a@type html:area@rel html:area@alt html:area@shape html:area@coords
            html:img@sizes html:img@alt html:img@width html:img@height html:img@loading html:img@decoding html:img@fetchpriority
            html:img@usemap html:img@ismap html:source@sizes html:source@media html:source@type html:source@width
            html:source@height html:video@loop html:video@muted html:video@playsinline html:video@preload html:video@width
            html:video@height html:audio@loop html:audio@muted html:audio@preload html:track@kind html:track@srclang
            html:track@label html:track@default html:map@name html:link@type html:link@media html:link@sizes html:style@media
            html:ol@reversed html:ol@start html:ol@type html:li@value html:td@colspan html:td@rowspan html:td@headers
            html:th@colspan html:th@rowspan html:th@headers html:th@scope html:th@abbr html:col@span html:colgroup@span
            html:time@datetime html:data@value html:del@datetime html:ins@datetime html:form@name html:form@autocomplete
            html:form@novalidate html:label@for html:input@type html:input@name html:input@value html:input@checked
            html:input@disabled html:input@readonly html:input@required html:input@placeholder html:input@min html:input@max
            html:input@step html:input@minlength html:input@maxlength html:input@pattern html:input@size html:input@multiple
            html:input@accept html:input@autocomplete html:input@list html:input@form html:input@dirname html:input@alt
            html:button@type html:button@name html:button@value html:button@disabled html:button@form html:select@name
            html:select@multiple html:select@size html:select@disabled html:select@required html:select@form
            html:select@autocomplete html:option@value html:option@selected html:option@disabled html:option@label
            html:optgroup@label html:optgroup@disabled html:textarea@name html:textarea@rows html:textarea@cols
            html:textarea@placeholder html:textarea@disabled html:textarea@readonly html:textarea@required html:textarea@maxlength
            html:textarea@minlength html:textarea@wrap html:textarea@form html:textarea@autocomplete html:textarea@dirname
            html:fieldset@name html:fieldset@disabled html:fieldset@form html:output@for html:output@name html:output@form
            html:progress@value html:progress@max html:meter@value html:meter@min html:meter@max html:meter@low html:meter@high
            html:meter@optimum html:details@open html:details@name html:dialog@open
            svg:*@id svg:*@class svg:*@lang svg:*@role svg:*@xml:lang svg:*@xml:space svg:*@xmlns svg:*@xmlns:xlink
            svg:*@transform svg:*@transform-origin svg:*@x svg:*@y svg:*@width svg:*@height svg:*@cx svg:*@cy svg:*@r svg:*@rx
            svg:*@ry svg:*@x1 svg:*@y1 svg:*@x2 svg:*@y2 svg:*@d svg:*@points svg:*@pathLength svg:*@viewBox
            svg:*@preserveAspectRatio svg:*@dx svg:*@dy svg:*@rotate svg:*@textLength svg:*@lengthAdjust svg:*@fill-opacity
            svg:*@fill-rule svg:*@stroke-width svg:*@stroke-opacity svg:*@stroke-linecap svg:*@stroke-linejoin
            svg:*@stroke-miterlimit svg:*@stroke-dasharray svg:*@stroke-dashoffset svg:*@opacity svg:*@color svg:*@display
            svg:*@visibility svg:*@overflow svg:*@font-family svg:*@font-size svg:*@font-size-adjust svg:*@font-weight
            svg:*@font-style svg:*@font-variant svg:*@font-stretch svg:*@text-anchor svg:*@dominant-baseline
            svg:*@alignment-baseline svg:*@baseline-shift svg:*@letter-spacing svg:*@word-spacing svg:*@text-decoration
            svg:*@writing-mode svg:*@direction svg:*@unicode-bidi svg:*@clip-rule svg:*@stop-color svg:*@stop-opacity
            svg:*@color-interpolation svg:*@shape-rendering svg:*@text-rendering svg:*@vector-effect svg:*@paint-order
            svg:*@pointer-events svg:*@mix-blend-mode svg:*@isolation svg:*@gradientUnits svg:*@gradientTransform
            svg:*@spreadMethod svg:*@fx svg:*@fy svg:*@fr svg:*@offset svg:*@clipPathUnits svg:*@maskUnits
            svg:*@maskContentUnits svg:*@patternUnits svg:*@patternContentUnits svg:*@patternTransform svg:*@media svg:*@type
            svg:a@rel
            mathml:*@id mathml:*@class mathml:*@dir mathml:*@xmlns mathml:*@displaystyle mathml:*@mathbackground
            mathml:*@mathcolor mathml:*@mathsize mathml:*@mathvariant mathml:*@scriptlevel mathml:*@display mathml:*@alttext
            mathml:*@fence mathml:*@form mathml:*@largeop mathml:*@lspace mathml:*@maxsize mathml:*@minsize
            mathml:*@movablelimits mathml:*@rspace mathml:*@separator mathml:*@stretchy mathml:*@symmetric mathml:*@accent
            mathml:*@accentunder mathml:*@linethickness mathml:*@depth mathml:*@height mathml:*@width mathml:*@voffset
            mathml:*@columnspan mathml:*@rowspan mathml:*@encoding`),
    },

    // ---- the view: load kinds
    loadKind: { side: 'view', what: "a load of a registered file the view makes (a `blob:` URL it minted), checked against its kind's directive", names: Object.keys(VIEW_LOAD_KINDS).map(kind => `load:${kind}`) },

    // ---- the host realm: the passes over guest content a sealed build runs
    hostPass: { side: 'host', what: "a pass of the element's host code over guest content (`html`, the entry, the files, the guest's frames), in the host page's realm and on its thread", names: hostPassNames() },
} as const satisfies Record<string, Surface>;
export type SurfaceId = keyof typeof SURFACES;

/** A cell: what a name, a surface or a side is to one row. */
export type Cell =
    | { readonly relation: 'none'; readonly why: string }
    | { readonly relation: 'neutralised'; readonly by: readonly ChokepointId[]; readonly why: string }
    | { readonly relation: 'remains'; readonly residuals: readonly string[]; readonly why: string };

const none = (why: string): Cell => ({ relation: 'none', why });
const neutralised = (by: readonly ChokepointId[], why: string): Cell => ({ relation: 'neutralised', by, why });
const remains = (residuals: readonly string[], why: string): Cell => ({ relation: 'remains', residuals, why });

/** A row's column: the cells of the surfaces (or single names, or a side) that relate to it; every other is `none`, for `rest`. */
export interface Column {
    readonly rest: string;
    readonly cells: Readonly<Record<string, Cell>>;
    /** `permissionsPolicy` only: every feature the view's document allows, and what it is to a sealed guest (VIEW_FEATURES). */
    readonly features?: Readonly<Record<string, Cell>>;
}

// Cells several columns share.
const STRINGS_REFUSED = neutralised(['codeFromStringRefusal'], "a string never reaches the platform's compiler, so no policy of the inherited list is asked");
const IMPORT_REFUSED = neutralised(['entryImportRefusal'], 'no worker runs an entry that calls it, so no policy is asked');
const NO_IMPORT_SCRIPTS = neutralised(['strictWorkerAllowlist'], 'the sealed worker does not have it');
const NO_WEBASSEMBLY = neutralised(['webAssemblyRemoval'], "the sealed worker does not have it, so no `'wasm-unsafe-eval'` check is made");
const REQUESTS_GATED = neutralised(['requestGate'], 'every request is refused before the platform: none is made');
const NO_FETCH_BRIDGE = neutralised(['sealedFetchRefusal'], 'refused in the guest; nothing reaches the host');
const NO_GUEST_URL = neutralised(['createObjectUrlRemoval'], 'the sealed worker does not have it');
const SECURE_CONTEXT_REMOVED = neutralised(['secureContextRemoval'], 'only a secure context has it: the sealed worker does not, on any engine and whatever the host page');
const VIEW_RUNS_NO_GUEST_CODE = neutralised(['viewPolicy', 'viewViolationRelay'], "the view's checks of the host page's policy raise violations in the view, which runs no guest code and relays no policy text");
const NO_NETWORK_RENDERED = neutralised(['urlKeepRule', 'rendererUrlDrop', 'cssUrlDrop', 'inertHref'], 'what it renders keeps no URL but a registered file\'s, in markup or CSS, and no link navigates');
const VIEW_FOCUS_ON_TEARDOWN = neutralised(['teardownDetach'], 'a focused element of the view makes the browser dispatch focus and blur into the host page when the frame goes');
// The guest's styles, applied through the CSSOM: no check of the host page's `style-src`, so no refusal, violation or report.
const STYLE_ATTRIBUTE_CSSOM = neutralised(['styleEncoding', 'cssomDeclaration'], "the view applies its text as the element's declaration: no inline style, so no check of the host page's `style-src`");
const STYLE_ELEMENT_CSSOM = neutralised(['styleEncoding', 'adoptedSheets'], 'the view applies its text as an adopted constructed stylesheet: no inline style, so no check of the host page\'s `style-src`');
const STYLES_CSSOM = neutralised(['styleEncoding', 'cssomDeclaration', 'adoptedSheets'], 'what it renders: its style attributes and `<style>`s, each applied through the CSSOM');
// What the guest's styles load: only the URLs the one rule keeps (BD7:ISO-1), so only a registered file's `blob:` URL.
const STYLE_LOADS = remains(['blobLoads'], "every reference the URL rule does not keep becomes `\"\"` before the view applies the style (urlKeepRule, cssUrlDrop: whatever its scheme, so no report names one); a registered file it names loads as a `blob:` URL, under the page's directive of its kind");
const STYLE_VIOLATIONS = neutralised(['styleEncoding', 'cssomDeclaration', 'adoptedSheets', 'urlKeepRule', 'cssUrlDrop', 'viewViolationRelay'], "applied through the CSSOM, so no `style-src` check; every URL but a registered file's is dropped first, and a registered file's load the page refuses raises its violation in the view, which runs no guest code and relays no policy text");
const NO_NETWORK_IN_CSS = neutralised(['urlKeepRule', 'cssUrlDrop'], "CSS keeps no URL but a registered file's `blob:` URL: no network URL");
// The host realm's passes (HOST_PASSES): none of them parses, loads or writes a sink the browser would check against the host
// page's policy; and none of them starts, loads or reads anything the other rows govern.
const HOST_PURE = neutralised(['hostPassRule'], "it hands nothing of the guest's to a parser, a loader or a sink of the host realm, so the browser checks none of it against the host page's policy (BD7:LIM-1)");
const HOST_NOTHING = none("it reads and builds strings and bytes in the host page's realm, and starts, loads and reads nothing this row governs");
// Every name that would make a request or load by URL, if the library let it: the rows a request reaches share these.
const REQUEST_MAKERS = { requests: REQUESTS_GATED, fetchBridge: NO_FETCH_BRIDGE, importScripts: NO_IMPORT_SCRIPTS, dynamicImport: IMPORT_REFUSED } as const;

// A feature the view allows that only script of the view's document reaches (an API of `document`, `navigator` or `window`,
// a fetch() option): the view runs no guest code, and the worker's allowlist has none of it.
const SCRIPT_ONLY = (what: string) => none(`${what}: only script of the view's document reaches it, and the view runs no guest code (the worker has no such name)`);
const NO_REQUEST = (what: string) => neutralised(['urlKeepRule', 'requestGate'], `${what}: rides on a network request, which the view never makes (it loads only the \`blob:\` URLs it minted) and the worker's request gate refuses`);

/**
 * Every feature the view's document allows (Chromium's `document.featurePolicy.allowedFeatures()`: the features whose
 * default allowlist is `*`, since the frames delegate none; Firefox and WebKit expose no such list), and what each is to a
 * sealed guest (BD7:ISO-3). test/e2e/view-permissions.spec.ts fails on a feature the engine allows that this does not name,
 * so a feature an engine adds is classified before it ships. Only picture-in-picture is reachable from markup, by the user
 * through a video's controls; the renderer turns it off on every video.
 */
export const VIEW_FEATURES: Readonly<Record<string, Cell>> = {
    'picture-in-picture': neutralised(['forcedMediaControls'], "every `<video>` the renderer keeps has `disablepictureinpicture`: its controls and context menu offer no picture-in-picture, and `requestPictureInPicture()` refuses; the host page's own policy decides nothing for it"),
    'attribution-reporting': SCRIPT_ONLY("the Attribution Reporting API (and the `attributionsrc` attribute, which no allowlist of the renderer has)"),
    'browsing-topics': SCRIPT_ONLY('the Topics API (`document.browsingTopics()`, and a fetch option)'),
    'interest-cohort': SCRIPT_ONLY('FLoC (`document.interestCohort()`)'),
    'join-ad-interest-group': SCRIPT_ONLY('`navigator.joinAdInterestGroup()`'),
    'run-ad-auction': SCRIPT_ONLY('`navigator.runAdAuction()`'),
    'private-aggregation': SCRIPT_ONLY('the Private Aggregation API, from shared-storage and auction worklets'),
    'shared-storage': SCRIPT_ONLY('`window.sharedStorage` and its worklets'),
    'shared-storage-select-url': SCRIPT_ONLY('`sharedStorage.selectURL()`'),
    'private-state-token-issuance': SCRIPT_ONLY('a fetch() option of the Private State Token API'),
    'private-state-token-redemption': SCRIPT_ONLY('a fetch() option of the Private State Token API'),
    'storage-access': SCRIPT_ONLY('`document.requestStorageAccess()`'),
    'deferred-fetch-minimal': SCRIPT_ONLY('`fetchLater()`'),
    'sync-xhr': SCRIPT_ONLY("a document's synchronous `XMLHttpRequest`"),
    'gamepad': SCRIPT_ONLY('`navigator.getGamepads()` and the gamepad events'),
    'aria-notify': SCRIPT_ONLY('`ariaNotify()`'),
    'unload': none("an `unload` handler: the renderer keeps no event handler attribute, and the view runs no guest code"),
    'ch-ua': NO_REQUEST('a client hint'),
    'ch-ua-mobile': NO_REQUEST('a client hint'),
    'ch-ua-platform': NO_REQUEST('a client hint'),
    'ch-ua-high-entropy-values': NO_REQUEST('a client hint, which also reaches script through `navigator.userAgentData`, which the view runs none of'),
    'ch-save-data': NO_REQUEST('a client hint'),
};

/** Every row of INHERITED_CONTEXT, and what each surface of the sealed guest is to it. */
export const SEALED_REACH = {
    cspScript: {
        rest: "compiles and loads no script: the host page's `script-src` is asked only for the library's bootstrap",
        cells: { host: HOST_PURE, code: STRINGS_REFUSED, timers: STRINGS_REFUSED, dynamicImport: IMPORT_REFUSED, importScripts: NO_IMPORT_SCRIPTS, webAssembly: NO_WEBASSEMBLY },
    },
    cspWorker: {
        rest: "starts no worker: the host page's `worker-src` is asked once, for the library's own `blob:` worker (no `Worker` or `SharedWorker` is on the allowlist)",
        cells: { host: HOST_NOTHING },
    },
    cspStyle: {
        rest: "applies no style the host page's `style-src` checks",
        cells: { host: HOST_PURE, styleElement: STYLE_ELEMENT_CSSOM, styleAttribute: STYLE_ATTRIBUTE_CSSOM, viewApi: STYLES_CSSOM },
    },
    cspBaseUri: {
        rest: "resolves no URL against the document's base",
        cells: {
            host: HOST_PURE,
            urlAttribute: neutralised(['baseCheck', 'urlKeepRule', 'rendererUrlDrop'], 'a registered path is resolved by the library, and every other URL is dropped: none is left to resolve against the base'),
            linkHref: neutralised(['inertHref'], 'the href is replaced before insertion'),
            ...REQUEST_MAKERS,
            viewApi: neutralised(['baseCheck', 'urlKeepRule', 'rendererUrlDrop', 'inertHref'], 'what it renders: its URL attributes and links'),
            scope: none("the worker's base is its own `blob:` URL, against which no relative URL resolves, never the document's (probe: test/e2e/sealed-reach.spec.ts)"),
        },
    },
    cspFetch: {
        rest: 'makes no request and no load',
        cells: {
            host: HOST_PURE,
            ...REQUEST_MAKERS,
            preludeRemoved: NO_GUEST_URL,
            urlAttribute: remains(['blobLoads'], "every URL but one the view minted is dropped before insertion, whatever its scheme (urlKeepRule, rendererUrlDrop); a registered file's `blob:` URL loads under the host page's directive of its kind"),
            loadKind: remains(['blobLoads'], "the load of a registered file is checked against the host page's directive of its kind"),
            styleElement: STYLE_LOADS,
            styleAttribute: STYLE_LOADS,
            linkRelation: neutralised(['linkRelations'], 'no relation that preloads, prefetches or preconnects is kept'),
            linkHref: neutralised(['inertHref', 'navigationCancel'], 'nothing is loaded by a link'),
            svgReference: neutralised(['urlKeepRule', 'svgLocalReferences'], 'a reference keeps only a fragment of the view, which loads nothing'),
            viewApi: remains(['blobLoads'], 'what it renders and sets: the registered files its markup and its styles name, every other URL dropped (urlKeepRule)'),
        },
    },
    cspPolicyText: {
        rest: "raises no violation of the host page's policy, and reads none",
        cells: {
            host: HOST_PURE,
            code: STRINGS_REFUSED,
            timers: STRINGS_REFUSED,
            webAssembly: NO_WEBASSEMBLY,
            ...REQUEST_MAKERS,
            preludeRemoved: NO_GUEST_URL,
            listeners: neutralised(['violationStop'], 'a listener of the guest never hears a trusted violation'),
            violationEvent: neutralised(['violationFieldBlanking'], 'every field reads blank, on an event of the platform or of the guest'),
            styleElement: STYLE_VIOLATIONS,
            styleAttribute: STYLE_VIOLATIONS,
            urlAttribute: VIEW_RUNS_NO_GUEST_CODE,
            loadKind: VIEW_RUNS_NO_GUEST_CODE,
            viewApi: VIEW_RUNS_NO_GUEST_CODE,
        },
    },
    cspReporting: {
        rest: 'raises no violation, so the browser sends no report',
        cells: {
            host: HOST_PURE,
            code: STRINGS_REFUSED,
            timers: STRINGS_REFUSED,
            webAssembly: NO_WEBASSEMBLY,
            ...REQUEST_MAKERS,
            preludeRemoved: NO_GUEST_URL,
            styleElement: remains(['blobLoads'], "applied through the CSSOM, so no `style-src` check (styleEncoding, adoptedSheets); every reference the URL rule does not keep becomes `\"\"` first, whatever its scheme (urlKeepRule, cssUrlDrop), so no report names one; a directive that refuses `blob:` reports a registered file's load, naming `blob`"),
            styleAttribute: remains(['blobLoads'], "applied through the CSSOM, so no `style-src` check (styleEncoding, cssomDeclaration); every reference the URL rule does not keep becomes `\"\"` first, whatever its scheme (urlKeepRule, cssUrlDrop), so no report names one; a directive that refuses `blob:` reports a registered file's load, naming `blob`"),
            urlAttribute: remains(['blobLoads'], "every URL but one the view minted is dropped before insertion, whatever its scheme (urlKeepRule), so no report names one; a directive that refuses `blob:` reports the registered file's load, naming `blob`"),
            svgReference: neutralised(['urlKeepRule', 'svgLocalReferences'], 'a reference keeps only a fragment of the view, which loads nothing'),
            loadKind: remains(['blobLoads'], "a directive that refuses `blob:` reports the load, naming `blob`"),
            viewApi: remains(['blobLoads'], 'what it renders and sets: the registered files its markup and its styles name, every other URL dropped (urlKeepRule; its styles are applied through the CSSOM: styleEncoding, cssomDeclaration, adoptedSheets)'),
        },
    },
    trustedTypesRequirement: {
        rest: 'hands no string to a Trusted Types sink: no element or attribute the renderer keeps is one (no script, handler, frame or srcdoc)',
        cells: {
            host: HOST_PURE,
            code: STRINGS_REFUSED,
            timers: STRINGS_REFUSED,
            importScripts: NO_IMPORT_SCRIPTS,
            viewApi: neutralised(['trustedTypesPolicy'], "its markup is parsed through the library's policy"),
        },
    },
    trustedTypesDefault: {
        rest: "runs in the guest's realm or the view, where the host page's default policy does not exist; the library's host code writes no string to a sink",
        cells: { host: HOST_PURE },
    },
    coep: {
        rest: 'reads nothing cross-origin isolation changes, and loads nothing an embedder policy checks (a `blob:` load is not cross-origin)',
        cells: {
            host: HOST_NOTHING,
            isolation: neutralised(['isolationRefusal'], 'no sandbox runs on an isolated host page: shared memory is absent and `crossOriginIsolated` reads false on every engine (probe: test/e2e/sealed-reach.spec.ts)'),
            performance: neutralised(['isolationRefusal'], "no sandbox runs on an isolated host page, so the clock keeps the coarse resolution of a page that is not"),
        },
    },
    referrer: {
        rest: 'makes no request, so sends no referrer',
        cells: {
            host: HOST_PURE,
            ...REQUEST_MAKERS,
            viewApi: NO_NETWORK_RENDERED,
            urlAttribute: neutralised(['urlKeepRule', 'rendererUrlDrop', 'forcedNoReferrer'], 'no network URL is kept; a `blob:` load sends no referrer'),
            referrerPolicyAttribute: neutralised(['forcedNoReferrer'], "the guest's value is replaced"),
            linkHref: neutralised(['inertHref', 'navigationCancel'], 'a link navigates nowhere'),
            styleElement: NO_NETWORK_IN_CSS,
            styleAttribute: NO_NETWORK_IN_CSS,
        },
    },
    ancestorOrigins: {
        rest: "the row is a document's `location.ancestorOrigins`: the view runs no guest code, and the worker's `WorkerLocation` has no such member",
        cells: { host: HOST_NOTHING, scope: none("`WorkerLocation` has no `ancestorOrigins` on any engine (probe: test/e2e/sealed-reach.spec.ts)") },
    },
    documentOrigin: {
        rest: 'reads no origin, URL or storage',
        cells: {
            host: HOST_NOTHING,
            scope: neutralised(['originCheck'], "it reads the worker's own origin, `'null'`, and its own URL, `blob:null/<uuid>` (probe: test/e2e/sealed-reach.spec.ts)"),
            originStorage: neutralised(['originCheck'], "the opaque origin's own: a database or a lock is refused with a SecurityError, and a channel reaches only the guest's own realms (measured, BD5:ISO-1)"),
        },
    },
    cookies: {
        rest: 'makes no request, so carries no cookie',
        cells: {
            host: HOST_PURE,
            ...REQUEST_MAKERS,
            viewApi: NO_NETWORK_RENDERED,
            urlAttribute: neutralised(['urlKeepRule', 'rendererUrlDrop', 'forcedCrossorigin'], 'no network URL is kept, and no element load carries credentials; a `blob:` load carries no cookie'),
            linkHref: neutralised(['inertHref', 'navigationCancel'], 'a link navigates nowhere'),
            styleElement: NO_NETWORK_IN_CSS,
            styleAttribute: NO_NETWORK_IN_CSS,
            loadKind: none('a `blob:` load is no network request and carries no cookie'),
        },
    },
    serviceWorker: {
        rest: 'makes no request a Service Worker could answer',
        cells: {
            host: HOST_PURE,
            ...REQUEST_MAKERS,
            viewApi: NO_NETWORK_RENDERED,
            urlAttribute: neutralised(['urlKeepRule', 'rendererUrlDrop', 'originCheck'], 'no network URL is kept, and the view is an opaque origin no Service Worker controls'),
            loadKind: none("a `blob:` URL is answered from the URL store, and the view's opaque origin has no Service Worker"),
        },
    },
    hostRealmGlobals: {
        rest: "runs no code of the library's in the host page's realm",
        cells: {
            host: none("it runs in the host page's realm with that realm's built-ins, which the guest can neither reach nor replace; what the host page itself replaces there is the embedder's own code"),
            bridge: neutralised(['brokerCapture'], "a call runs the embedder's method; the broker reads it through captured intrinsics"),
            files: neutralised(['brokerCapture'], 'a write reaches the host as a call of the broker'),
            viewApi: neutralised(['brokerCapture'], "what the view sends the host is read the same way"),
            console: neutralised(['logRelay'], 'a line becomes a `sandbox-log` event, never a call of the host page\'s `console`'),
            events: neutralised(['brokerCapture'], 'an uncaught error is relayed as a frame the host reads through captured intrinsics'),
        },
    },
    permissionsPolicy: {
        rest: 'uses no feature a permissions policy gates',
        cells: {
            host: HOST_NOTHING,
            autoplay: neutralised(['autoplaySwitch', 'noDelegation', 'viewEventList'], 'dropped by default; with `allowAutoplay` the frame has no `autoplay` delegated, and the guest hears no media event'),
            mediaControls: neutralised(['forcedMediaControls', 'noDelegation'], "picture-in-picture and remote playback are off on every video and audio the renderer keeps, whatever the host page's policy (picture-in-picture is allowed in every frame by default, so delegating nothing does not turn it off); fullscreen is delegated to no frame"),
            isolation: neutralised(['isolationRefusal'], "`cross-origin-isolated` is the feature behind `crossOriginIsolated`, which no sandbox runs with"),
            viewApi: neutralised(['autoplaySwitch', 'forcedMediaControls', 'noDelegation', 'viewEventList'], 'what it renders: its media elements and their controls'),
        },
        features: VIEW_FEATURES,
    },
    permissionState: {
        rest: "reads no browser state keyed to an origin or to the user's profile",
        cells: {
            // Every name of the allowlists that reads browser state keyed to an origin or to the user's profile, with what it
            // reads and why the guest learns nothing of the host page from it. The worker is a `blob:` worker of an opaque
            // origin, but an engine may still answer it from the host page's own record: WebKit answered
            // `navigator.permissions.query()` there with the host origin's grants (BD5:ISO-1), and Firefox's
            // `navigator.storage.estimate()` ended the caller's task without settling (BD5:ISO-2). So `navigator.permissions`,
            // `Permissions`, `PermissionStatus`, `navigator.storage` and `StorageManager` are not listed: no API a permission
            // gates exists in the worker, and the storage manager stores nothing in an opaque origin.
            // Measured in the sealed guest's worker on Chromium, Firefox and WebKit, with the host origin holding permission
            // grants, an IndexedDB database, a held Web Lock, `localStorage` and a `BroadcastChannel` listener, and without
            // them: each answer below was the same both ways (BD5:ISO-1). Every navigator member has its own cell here.
            'indexedDB': neutralised(['originCheck'], "the origin's databases: `open()`, `databases()` and `deleteDatabase()` give a SecurityError in the opaque origin on every engine; the host page's database is not visible"),
            'IDBFactory': neutralised(['originCheck'], "indexedDB's interface: as indexedDB"),
            'navigator.locks': neutralised(['secureContextRemoval', 'originCheck'], "the origin's Web Locks: secure-context only, so not in the sealed worker on any engine; in worker mode's, `query()` and `request()` give a SecurityError (Firefox, WebKit), and a lock the host page holds is not visible"),
            'Lock': neutralised(['secureContextRemoval', 'originCheck'], "navigator.locks's interface: as navigator.locks"),
            'LockManager': neutralised(['secureContextRemoval', 'originCheck'], "navigator.locks's interface: as navigator.locks"),
            'BroadcastChannel': neutralised(['originCheck'], "the origin's channels: the guest's opaque origin is its own, and a channel of the host page's (or of a plain sandboxed frame's) of the same name never receives or delivers its messages"),
            'navigator.mediaCapabilities': none('what the engine and the device decode: the same answer for any page'),
            'MediaCapabilities': none("navigator.mediaCapabilities's interface: as navigator.mediaCapabilities"),
            'navigator.gpu': none('the device: absent from the worker on every engine of the suite'),
            'navigator.deviceMemory': none('the device: absent from the worker on every engine of the suite'),
            'navigator.hardwareConcurrency': none('the device: the same for any page'),
            'navigator.language': none("the profile's language: the same for any page"),
            'navigator.languages': none("the profile's languages: the same for any page"),
            'Intl': none("the profile's locale and time zone: the same for any page"),
            'Date': none("the profile's time zone: the same for any page"),
            'Temporal': none("the profile's time zone: the same for any page"),
            'navigator.globalPrivacyControl': none("the profile's privacy setting (Firefox): the same for any page"),
            'navigator.onLine': none('the device: the same for any page'),
            'navigator.userAgent': none('the browser: the same for any page'),
            'navigator.appVersion': none('the browser: the same for any page'),
            'navigator.platform': none('the browser: the same for any page'),
            'navigator.appCodeName': none('a constant of the platform'),
            'navigator.appName': none('a constant of the platform'),
            'navigator.product': none('a constant of the platform'),
            'origin': none("the worker's own origin: `'null'`"),
            'location': none("the worker's own URL: `blob:null/<uuid>`"),
            'isSecureContext': none("the worker's own context: false on every engine and page (the `secureContext` row)"),
            'crossOriginIsolated': none("the worker's own context: false (the element refuses an isolated host page)"),
            'performance': none("the worker's own timeline: its own entries only"),
        },
    },
    secureContext: {
        rest: 'reads nothing that depends on whether the document is a secure context',
        // Every name whose presence or answer the secure context decides on an engine of the suite (SECURE_CONTEXT_ONLY): the
        // sealed worker has none of them and reads `isSecureContext` as false, so a host page on a URL that is not
        // potentially trustworthy and one on a loopback host give it the same names on every engine
        // (test/e2e/sealed-reach.spec.ts, which fails on any name that differs).
        cells: {
            host: HOST_NOTHING,
            ...Object.fromEntries(secureContextOnlyNames().map(name => [name, SECURE_CONTEXT_REMOVED])),
            'isSecureContext': neutralised(['secureContextRemoval'], 'reads false on every engine and page: the answer Chromium gives on every page'),
        },
    },
    uiSurfaces: {
        rest: 'reaches no shared surface of the browser: focus, the clipboard, history, top-level navigation, the host window',
        cells: {
            host: HOST_NOTHING,
            hyperlink: neutralised(['inertHref', 'navigationCancel'], 'a link navigates nowhere, and its href names nothing of the guest\'s'),
            linkHref: neutralised(['inertHref', 'navigationCancel'], 'a link navigates nowhere, and its href names nothing of the guest\'s'),
            form: neutralised(['navigationCancel'], 'a submission is cancelled, and no form target is kept (no `action`, `formaction` or `target`)'),
            viewApi: neutralised(['viewFocusRule', 'inertHref', 'navigationCancel'], "`set({ focus })` moves focus inside the view only while the view has the user's focus, and no link it renders navigates"),
        },
    },
    eventDispatch: {
        rest: "the row's events are the host page's own, dispatched when the element removes its frames, whatever the guest holds",
        cells: {
            host: HOST_NOTHING,
            hyperlink: VIEW_FOCUS_ON_TEARDOWN,
            form: VIEW_FOCUS_ON_TEARDOWN,
            disclosure: VIEW_FOCUS_ON_TEARDOWN,
            focusAttribute: VIEW_FOCUS_ON_TEARDOWN,
            viewApi: VIEW_FOCUS_ON_TEARDOWN,
        },
    },
    thread: {
        rest: 'runs on the worker\'s own thread; what it sends the view is charged to the view\'s budgets',
        cells: {
            host: remains(['hostPasses'], "it runs on the host page's thread, linear in what it takes, which a cap of the library's bounds (HOST_PASSES `cost`)"),
            view: remains(['viewRendering'], "rendered in the view, on the host page's thread where the engine shares it"),
            viewApi: remains(['viewRendering'], "what it renders, and every `set()`, is applied in the view, on the host page's thread where the engine shares it"),
        },
    },
} as const satisfies { readonly [Row in InheritedContextId]: Column };

// Each name's surface, and each surface's side.
const SURFACE_OF: ReadonlyMap<string, SurfaceId> = (() => {
    const map = new Map<string, SurfaceId>();
    for (const id of Object.keys(SURFACES) as SurfaceId[]) {
        for (const name of SURFACES[id].names) map.set(name, id);
    }
    return map;
})();

/** The surface of `name`, or undefined when no surface lists it. */
export const surfaceOf = (name: string): SurfaceId | undefined => SURFACE_OF.get(name);

/**
 * What `name` is to `row`: the column's cell for the name, else for its surface, else for its side, else `none` for the
 * column's `rest`. Undefined when the name has no surface.
 */
export function reachCell(name: string, row: InheritedContextId): Cell | undefined {
    const surface = surfaceOf(name);
    if (!surface) return undefined;
    const column: Column = SEALED_REACH[row];
    const side = SURFACES[surface].side;
    return column.cells[name] ?? column.cells[surface] ?? column.cells[side] ?? none(column.rest);
}
