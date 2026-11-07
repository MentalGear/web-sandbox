/**
 * Every request maker a guest of sealed mode can reach, as values (docs/research/24_sealed_mode, step 3): the one enumeration
 * test/e2e/sealed-no-network.spec.ts runs on every engine, each maker aimed at a listener that must see nothing. A maker is
 * code the worker runs, markup the worker renders into the view, a `set({ css })` value, or a rule of a registered
 * stylesheet, and it names what of the library's own lists it stands for (`covers`). test/unit/sealed-makers.test.ts ties the
 * enumeration to those lists: every name the request gate installs, every request maker kept off the worker's allowlist, every
 * row of COOKIE_CARRIERS, every [element, attribute] of the renderer that holds a URL, every `<link>` relation, and every kind
 * of URL a CSS reference makes in every place guest CSS reaches the view. A maker the library learns about without a maker
 * here fails that test, so none is missed silently.
 *
 * The enumeration is also every way a sealed worker could make the browser check the policy list it inherits from the host
 * page (S74, class A: INHERITED_CONTEXT.cspPolicyText, cspReporting; BD6:ISO-1, BD6:ISO-2): a check that refuses reports the
 * page's policy text to the guest and the action's URL or string to the page's report endpoint. Each worker maker is stopped
 * by the library before the platform checks anything: the request gate, the allowlist, the code-from-string refusal
 * (CODE_FROM_STRING_SINKS, with the compilers the worker does not have, ABSENT_COMPILERS), or the build, which refuses an
 * entry that calls `import()`. test/e2e/sealed-host-policy.spec.ts runs them on the realistic host, whose report endpoint
 * must receive nothing from the guest.
 *
 * Plain data and types: imported by a unit test as well as by the spec, so it imports nothing at run time.
 */
import type { CookieCarrierId } from '@src/lib/cookie-facts';
import type { ABSENT_COMPILERS, CodeFromStringSinkId } from '@src/lib/code-from-strings';

/** Where the guest makes the request. */
export type MakerRealm = 'worker' | 'view' | 'set-css' | 'stylesheet';

/** The places guest CSS reaches the view (css-references.ts reads each). */
export const CSS_PLACES = ['style-attribute', 'style-element', 'set-css', 'registered-stylesheet'] as const;
export type CssPlace = (typeof CSS_PLACES)[number];

/** The kind of load a CSS reference makes (CssReference['kind'], css-references.ts). */
export type CssKind = 'style' | 'font' | 'image';

/** What of the library's lists a maker stands for. */
export type MakerCovers =
    | { readonly gate: string } // a global the request gate installs (in-sandbox-script.ts, replaceGlobal)
    | { readonly global: string } // a worker global that makes a request, off the allowlist (STRICT_WORKER_GLOBALS)
    | { readonly navigator: string } // a navigator member that makes a request, off WORKER_NAVIGATOR_MEMBERS
    | { readonly reserved: 'sandboxFetch' } // the library's own maker (the fetch bridge's guest side)
    | { readonly carrier: CookieCarrierId } // a row of COOKIE_CARRIERS
    | { readonly attribute: readonly [element: string, attribute: string] } // a URL attribute the renderer governs (RENDER_URL_ATTRIBUTES, links)
    | { readonly linkRel: string } // a <link> relation (LINK_REL_KINDS, RENDER_RULES.linkRelations)
    | { readonly css: CssPlace; readonly kind: CssKind; readonly via: 'url' | 'image-set' | '@import' | '@font-face' }
    | { readonly sink: CodeFromStringSinkId } // a code-from-string sink the prelude refuses (CODE_FROM_STRING_SINKS)
    | { readonly compiler: keyof typeof ABSENT_COMPILERS }; // a compiler the worker does not have (ABSENT_COMPILERS)

/**
 * How sealed mode stops it and where that is reported:
 *   - `gate`: the request gate refuses it in the guest (the platform's failure) and reports a `connect-src` violation whose
 *     sourceFile is the gate's, with the URL;
 *   - `refused`: the library refuses it in the guest with its own code and sends nothing anywhere (`sandboxFetch()`:
 *     FETCH_NOT_ALLOWED, D4);
 *   - `absent`: the worker has no such global or member (the allowlist), so the attempt throws in the guest;
 *   - `dropped`: the renderer drops the URL before insertion and reports it as a violation of its kind's directive;
 *   - `removed`: the renderer keeps no such element or attribute, so nothing names the URL and nothing is reported: a
 *     navigation (a link's href becomes INERT_HREF, a form loses its action), a frame, a ping, and a `<link>` that names no
 *     file the view minted (removed whole, in strict mode too);
 *   - `warned`: the element drops the URL from a registered stylesheet when it builds, and warns once, naming the file;
 *   - `string`: the prelude's code-from-string refusal throws the library's EvalError in the guest before the platform sees the
 *     string, which would have made the request: nothing is checked, reported or sent;
 *   - `unbuildable`: the build refuses an entry that holds it (`import()` or a phase of it, entry-imports.ts), with the reason `entryImport`:
 *     no worker runs, so nothing is checked, reported or sent. The spec builds each one on its own.
 */
export type SealedOutcome = 'gate' | 'refused' | 'absent' | 'dropped' | 'removed' | 'warned' | 'string' | 'unbuildable';

/** The scheme of the listener a maker is aimed at. */
export type MakerScheme = 'https' | 'http' | 'wss';

export interface Maker {
    readonly id: string;
    readonly realm: MakerRealm;
    readonly covers: readonly MakerCovers[];
    readonly scheme: MakerScheme;
    /**
     * worker: an expression the worker evaluates to a string (awaited), given `U`, the maker's URL; view: markup holding `U`;
     * set-css: a `set({ css })` object literal holding `U`; stylesheet: rules holding `U`.
     */
    readonly code: string;
    readonly outcome: SealedOutcome;
    /** `dropped` and `gate`: the directive of its report. */
    readonly directive?: string;
    /** The scheme of the URL its report names, where it is not the scheme it was given (a WebSocket's https: URL is reported as wss:). */
    readonly reportedAs?: MakerScheme;
    /** worker: what the guest sees in sealed mode. */
    readonly sees?: string;
    /** view: the trusted click that would follow it (the element's id), after the render. */
    readonly click?: string;
    /**
     * The positive controls, measured: whether the request reaches the listener on every engine from strict mode with the
     * listener in every `origins` list (`strict`), and from a plain sandboxed frame of the host page that makes it as a
     * document does (`frame`); `note` says why not, where neither does (on an engine or on all).
     */
    readonly strict: boolean;
    readonly frame: boolean;
    readonly note?: string;
}

const attempt = (body: string) => `(async () => { try { ${body} } catch (e) { return e.name; } })()`;
const fetched = (call: string) => `${call}.then(() => 'sent', (e) => e.name)`;
const xhr = (sync: boolean) => sync
    ? attempt("const x = new XMLHttpRequest(); x.open('GET', U, false); x.send(); return 'sent ' + x.status;")
    : `new Promise((resolve) => { const x = new XMLHttpRequest(); x.onload = () => resolve('sent'); x.onerror = () => resolve('error ' + x.readyState + ' ' + x.status); x.open('GET', U); x.send(); })`;
const absent = (expression: string) => attempt(`${expression}; return 'made';`);
// The text of a dynamic import of U, spelt so that the entry itself holds no `import` followed by `(` (the build refuses
// that, entry-imports.ts): what a sink would compile and run, if it reached the platform.
const IMPORTS_U = "'imp' + 'ort(' + JSON.stringify(U) + ')'";
const compiled = (call: string) => attempt(`const S = ${IMPORTS_U}; ${call}; return 'ran';`);
const at = (top: number) => `position:absolute;left:0;top:${top}px;width:120px;height:20px;display:block;margin:0`;

/** The worker's makers: the platform's, the library's, and the ones the allowlist keeps out. */
const WORKER: Maker[] = [
    { id: 'fetch', realm: 'worker', covers: [{ gate: 'fetch' }], scheme: 'https', code: fetched('fetch(U)'), outcome: 'gate', directive: 'connect-src', sees: 'TypeError', strict: true, frame: true },
    { id: 'fetch-http', realm: 'worker', covers: [{ gate: 'fetch' }], scheme: 'http', code: fetched('fetch(U)'), outcome: 'gate', directive: 'connect-src', sees: 'TypeError', strict: true, frame: true },
    { id: 'fetch-request', realm: 'worker', covers: [{ gate: 'fetch' }], scheme: 'https', code: fetched("fetch(new Request(U, { method: 'POST', body: 'x' }))"), outcome: 'gate', directive: 'connect-src', sees: 'TypeError', strict: true, frame: true },
    { id: 'fetch-no-cors', realm: 'worker', covers: [{ gate: 'fetch' }], scheme: 'https', code: fetched("fetch(U, { mode: 'no-cors', credentials: 'include' })"), outcome: 'gate', directive: 'connect-src', sees: 'TypeError', strict: true, frame: true },
    { id: 'fetch-keepalive', realm: 'worker', covers: [{ gate: 'fetch' }], scheme: 'https', code: fetched("fetch(U, { keepalive: true, method: 'POST', body: 'x' })"), outcome: 'gate', directive: 'connect-src', sees: 'TypeError', strict: false, frame: true },
    { id: 'xhr', realm: 'worker', covers: [{ gate: 'XMLHttpRequest' }], scheme: 'https', code: xhr(false), outcome: 'gate', directive: 'connect-src', sees: 'error 4 0', strict: true, frame: true },
    { id: 'xhr-sync', realm: 'worker', covers: [{ gate: 'XMLHttpRequest' }], scheme: 'https', code: xhr(true), outcome: 'gate', directive: 'connect-src', sees: 'NetworkError', strict: true, frame: true },
    { id: 'websocket', realm: 'worker', covers: [{ gate: 'WebSocket' }, { carrier: 'websocket' }], scheme: 'wss', code: absent('new WebSocket(U)'), outcome: 'gate', directive: 'connect-src', sees: 'SecurityError', strict: false, frame: false, note: "not on every engine: Chromium's handshake from a sandboxed srcdoc frame did not reach the listener (measured; Firefox's and WebKit's did); the request gate's own spec has a socket's positive control" },
    { id: 'websocket-https', realm: 'worker', covers: [{ gate: 'WebSocket' }], scheme: 'https', code: absent('new WebSocket(U)'), outcome: 'gate', directive: 'connect-src', reportedAs: 'wss', sees: 'SecurityError', strict: false, frame: false, note: "not on every engine: Chromium's handshake from a sandboxed srcdoc frame did not reach the listener (measured; Firefox's and WebKit's did); the request gate's own spec has a socket's positive control" },
    { id: 'sandbox-fetch', realm: 'worker', covers: [{ reserved: 'sandboxFetch' }], scheme: 'https', code: 'sandboxFetch(U).then(() => \'sent\', (e) => e.code)', outcome: 'refused', sees: 'FETCH_NOT_ALLOWED', strict: false, frame: false, note: "the library's own maker: a document has none" },
    // import() is syntax: the build refuses the entry that holds one (each built on its own; sees: the build's reason)
    { id: 'import', realm: 'worker', covers: [], scheme: 'https', code: "import(U).then(() => 'sent', (e) => e.name)", outcome: 'unbuildable', sees: 'entryImport', strict: false, frame: true },
    { id: 'import-file', realm: 'worker', covers: [], scheme: 'https', code: "import('./main.js').then(() => 'sent', (e) => e.name)", outcome: 'unbuildable', sees: 'entryImport', strict: false, frame: false, note: "a registered file by a literal specifier: the view's script-src admits no module, so it loads nothing in strict mode either, and a document has no registered files" },
    { id: 'import-data', realm: 'worker', covers: [], scheme: 'https', code: "import('data:text/javascript,0').then(() => 'sent', (e) => e.name)", outcome: 'unbuildable', sees: 'entryImport', strict: false, frame: false, note: 'a data: URL names no server' },
    // the phases of an import (BD7:CHL-1): no engine of the suite runs them unflagged, and the build refuses them as import()
    { id: 'import-source', realm: 'worker', covers: [], scheme: 'https', code: "import.source(U).then(() => 'sent', (e) => e.name)", outcome: 'unbuildable', sees: 'entryImport', strict: false, frame: false, note: 'a phase of an import: a SyntaxError on every engine of the suite, which runs it only behind a flag' },
    { id: 'import-defer', realm: 'worker', covers: [], scheme: 'https', code: "import.defer(U).then(() => 'sent', (e) => e.name)", outcome: 'unbuildable', sees: 'entryImport', strict: false, frame: false, note: 'as import-source' },
    { id: 'import-scripts', realm: 'worker', covers: [{ global: 'importScripts' }, { compiler: 'importScripts' }], scheme: 'https', code: absent('importScripts(U)'), outcome: 'absent', sees: 'ReferenceError', strict: false, frame: false, note: 'a document has no importScripts()' },
    { id: 'worker', realm: 'worker', covers: [{ global: 'Worker' }, { carrier: 'frames' }, { compiler: 'Worker' }], scheme: 'https', code: absent('new Worker(U)'), outcome: 'absent', sees: 'ReferenceError', strict: false, frame: false, note: "a frame's Worker of another origin's URL is refused before any request" },
    { id: 'shared-worker', realm: 'worker', covers: [{ global: 'SharedWorker' }, { carrier: 'frames' }, { compiler: 'SharedWorker' }], scheme: 'https', code: absent('new SharedWorker(U)'), outcome: 'absent', sees: 'ReferenceError', strict: false, frame: false, note: "a frame's SharedWorker of another origin's URL is refused before any request" },
    { id: 'event-source', realm: 'worker', covers: [{ global: 'EventSource' }, { carrier: 'eventsource' }], scheme: 'https', code: absent('new EventSource(U, { withCredentials: true })'), outcome: 'absent', sees: 'ReferenceError', strict: false, frame: true },
    { id: 'send-beacon', realm: 'worker', covers: [{ navigator: 'sendBeacon' }, { carrier: 'beacon' }], scheme: 'https', code: absent("navigator.sendBeacon(U, 'x')"), outcome: 'absent', sees: 'TypeError', strict: false, frame: true },
    { id: 'web-transport', realm: 'worker', covers: [{ global: 'WebTransport' }], scheme: 'https', code: absent('new WebTransport(U)'), outcome: 'absent', sees: 'ReferenceError', strict: false, frame: false, note: 'WebTransport needs HTTP/3, which the listener does not speak' },
    { id: 'websocket-stream', realm: 'worker', covers: [{ global: 'WebSocketStream' }], scheme: 'wss', code: absent('new WebSocketStream(U)'), outcome: 'absent', sees: 'ReferenceError', strict: false, frame: false, note: 'no engine of the suite sends its handshake to the listener from a frame (measured)' },
    { id: 'font-face', realm: 'worker', covers: [{ global: 'FontFace' }], scheme: 'https', code: absent("new FontFace('f', 'url(' + U + ')').load()"), outcome: 'absent', sees: 'ReferenceError', strict: false, frame: true },
    { id: 'caches', realm: 'worker', covers: [{ global: 'caches' }], scheme: 'https', code: absent('caches.open(U)'), outcome: 'absent', sees: 'ReferenceError', strict: false, frame: false, note: 'Cache Storage makes no request' },
    // strings run as code: each compiles a dynamic import of U, if it reaches the platform (a document's run, where the
    // page admits them: `frame`; the sandbox's frame control runs with no 'unsafe-eval', so it makes none)
    { id: 'eval', realm: 'worker', covers: [{ sink: 'eval' }], scheme: 'https', code: compiled('eval(S)'), outcome: 'string', sees: 'EvalError', strict: false, frame: false, note: "a string run as code: the frame control's policy, like the sandbox's, admits no 'unsafe-eval'" },
    { id: 'eval-indirect', realm: 'worker', covers: [{ sink: 'eval' }], scheme: 'https', code: compiled('(0, eval)(S)'), outcome: 'string', sees: 'EvalError', strict: false, frame: false, note: "a string run as code: the frame control's policy, like the sandbox's, admits no 'unsafe-eval'" },
    { id: 'function', realm: 'worker', covers: [{ sink: 'Function' }], scheme: 'https', code: compiled('new Function(S)()'), outcome: 'string', sees: 'EvalError', strict: false, frame: false, note: "a string run as code: the frame control's policy, like the sandbox's, admits no 'unsafe-eval'" },
    { id: 'function-constructor', realm: 'worker', covers: [{ sink: 'Function.prototype.constructor' }], scheme: 'https', code: compiled('(() => {}).constructor(S)()'), outcome: 'string', sees: 'EvalError', strict: false, frame: false, note: "a string run as code: the frame control's policy, like the sandbox's, admits no 'unsafe-eval'" },
    { id: 'async-function-constructor', realm: 'worker', covers: [{ sink: 'AsyncFunction.prototype.constructor' }], scheme: 'https', code: compiled('(async () => {}).constructor(S)()'), outcome: 'string', sees: 'EvalError', strict: false, frame: false, note: "a string run as code: the frame control's policy, like the sandbox's, admits no 'unsafe-eval'" },
    { id: 'generator-function-constructor', realm: 'worker', covers: [{ sink: 'GeneratorFunction.prototype.constructor' }], scheme: 'https', code: compiled('(function* () {}).constructor(S)().next()'), outcome: 'string', sees: 'EvalError', strict: false, frame: false, note: "a string run as code: the frame control's policy, like the sandbox's, admits no 'unsafe-eval'" },
    { id: 'async-generator-function-constructor', realm: 'worker', covers: [{ sink: 'AsyncGeneratorFunction.prototype.constructor' }], scheme: 'https', code: compiled('(async function* () {}).constructor(S)().next()'), outcome: 'string', sees: 'EvalError', strict: false, frame: false, note: "a string run as code: the frame control's policy, like the sandbox's, admits no 'unsafe-eval'" },
    { id: 'set-timeout-string', realm: 'worker', covers: [{ sink: 'setTimeout' }], scheme: 'https', code: compiled('setTimeout(S)'), outcome: 'string', sees: 'EvalError', strict: false, frame: false, note: "a string run as code: the frame control's policy, like the sandbox's, admits no 'unsafe-eval'" },
    { id: 'set-interval-string', realm: 'worker', covers: [{ sink: 'setInterval' }], scheme: 'https', code: compiled('clearInterval(setInterval(S, 1000000))'), outcome: 'string', sees: 'EvalError', strict: false, frame: false, note: "a string run as code: the frame control's policy, like the sandbox's, admits no 'unsafe-eval'" },
    // the compilers the worker does not have
    { id: 'webassembly', realm: 'worker', covers: [{ compiler: 'WebAssembly' }], scheme: 'https', code: absent('WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))'), outcome: 'absent', sees: 'ReferenceError', strict: false, frame: false, note: 'compiles bytes, makes no request' },
    { id: 'shadow-realm', realm: 'worker', covers: [{ compiler: 'ShadowRealm' }], scheme: 'https', code: absent(`new ShadowRealm().evaluate(${IMPORTS_U})`), outcome: 'absent', sees: 'ReferenceError', strict: false, frame: false, note: 'no engine of the suite ships ShadowRealm' },
    { id: 'trusted-types', realm: 'worker', covers: [{ compiler: 'trustedTypes' }, { compiler: 'TrustedScript' }], scheme: 'https', code: absent("trustedTypes.createPolicy('p', { createScript: (s) => s })"), outcome: 'absent', sees: 'ReferenceError', strict: false, frame: false, note: 'makes a value a sink accepts, no request' },
];

/** The view's makers: every URL the renderer governs, and the ones it removes. */
const VIEW: Maker[] = [
    { id: 'img', realm: 'view', covers: [{ attribute: ['img', 'src'] }, { carrier: 'markup' }], scheme: 'https', code: '<img src="{U}" alt="">', outcome: 'dropped', directive: 'img-src', strict: true, frame: true },
    { id: 'img-http', realm: 'view', covers: [{ attribute: ['img', 'src'] }], scheme: 'http', code: '<img src="{U}" alt="">', outcome: 'dropped', directive: 'img-src', strict: true, frame: true },
    { id: 'img-srcset', realm: 'view', covers: [{ attribute: ['img', 'srcset'] }], scheme: 'https', code: '<img srcset="{U} 1x" alt="">', outcome: 'dropped', directive: 'img-src', strict: true, frame: true },
    { id: 'picture-source', realm: 'view', covers: [{ attribute: ['source', 'srcset'] }], scheme: 'https', code: '<picture><source srcset="{U}"><img alt=""></picture>', outcome: 'dropped', directive: 'img-src', strict: true, frame: true },
    { id: 'video', realm: 'view', covers: [{ attribute: ['video', 'src'] }], scheme: 'https', code: '<video src="{U}" preload="auto"></video>', outcome: 'dropped', directive: 'media-src', strict: true, frame: true },
    { id: 'poster', realm: 'view', covers: [{ attribute: ['video', 'poster'] }], scheme: 'https', code: '<video poster="{U}"></video>', outcome: 'dropped', directive: 'img-src', strict: false, frame: true },
    { id: 'audio', realm: 'view', covers: [{ attribute: ['audio', 'src'] }], scheme: 'https', code: '<audio src="{U}" preload="auto"></audio>', outcome: 'dropped', directive: 'media-src', strict: true, frame: true },
    { id: 'media-source', realm: 'view', covers: [{ attribute: ['source', 'src'] }], scheme: 'https', code: '<audio preload="auto"><source src="{U}" type="audio/wav"></audio>', outcome: 'dropped', directive: 'media-src', strict: false, frame: false, note: 'not on every engine: WebKit does not always request the <source> of an audio element before playback (observed both ways); Chromium and Firefox do, in strict mode and in a frame' },
    { id: 'track', realm: 'view', covers: [{ attribute: ['track', 'src'] }], scheme: 'https', code: '<video preload="auto"><track default kind="subtitles" src="{U}"></video>', outcome: 'dropped', directive: 'media-src', strict: false, frame: false, note: "not on every engine: a text track of a video with no source loads from strict mode's view on Chromium and Firefox, not on WebKit (measured), and from a plain frame on none" },
    { id: 'link-stylesheet', realm: 'view', covers: [{ attribute: ['link', 'href'] }, { linkRel: 'stylesheet' }], scheme: 'https', code: '<link rel="stylesheet" href="{U}">', outcome: 'removed', strict: false, frame: true },
    { id: 'link-icon', realm: 'view', covers: [{ linkRel: 'icon' }], scheme: 'https', code: '<link rel="icon" href="{U}">', outcome: 'removed', strict: false, frame: false, note: "an icon is the tab's: the browser loads none for a frame" },
    { id: 'link-preload', realm: 'view', covers: [{ linkRel: 'preload' }], scheme: 'https', code: '<link rel="preload" as="image" href="{U}">', outcome: 'removed', strict: false, frame: true },
    { id: 'link-modulepreload', realm: 'view', covers: [{ linkRel: 'modulepreload' }], scheme: 'https', code: '<link rel="modulepreload" href="{U}">', outcome: 'removed', strict: false, frame: true },
    { id: 'link-prefetch', realm: 'view', covers: [], scheme: 'https', code: '<link rel="prefetch" href="{U}"><link rel="preconnect" href="{U}"><link rel="dns-prefetch" href="{U}">', outcome: 'removed', strict: false, frame: false, note: 'not on every engine: Firefox and WebKit prefetch nothing for a sandboxed frame (measured; Chromium does)' },
    { id: 'a', realm: 'view', covers: [{ attribute: ['a', 'href'] }], scheme: 'https', code: `<a id="m-a" href="{U}" style="${at(0)}">a</a>`, outcome: 'removed', click: 'm-a', strict: false, frame: false, note: 'a navigation, followed by a click: the frame control makes no click (strict.spec.ts holds one: a link on the host page reaches a listener)' },
    { id: 'a-ping', realm: 'view', covers: [{ carrier: 'ping' }], scheme: 'https', code: `<a id="m-ping" href="#x" ping="{U}" style="${at(30)}">ping</a>`, outcome: 'removed', click: 'm-ping', strict: false, frame: false, note: 'a navigation, followed by a click: the frame control makes no click (strict.spec.ts holds one: a link on the host page reaches a listener)' },
    { id: 'area', realm: 'view', covers: [{ attribute: ['area', 'href'] }], scheme: 'https', code: '<map name="m"><area shape="rect" coords="0,0,9,9" href="{U}"></map>', outcome: 'removed', strict: false, frame: false, note: 'a navigation: nothing loads until it is followed' },
    { id: 'svg-a', realm: 'view', covers: [], scheme: 'https', code: '<svg width="9" height="9"><a href="{U}"><text y="9">s</text></a><a xlink:href="{U}"><text y="9">x</text></a><image href="{U}"/></svg>', outcome: 'removed', strict: false, frame: true },
    { id: 'mathml-href', realm: 'view', covers: [], scheme: 'https', code: '<math href="{U}"><mi>m</mi></math>', outcome: 'removed', strict: false, frame: false, note: 'a navigation: nothing loads until it is followed' },
    { id: 'form', realm: 'view', covers: [], scheme: 'https', code: `<form action="{U}" method="post"><button id="m-form" style="${at(60)}">submit</button></form>`, outcome: 'removed', click: 'm-form', strict: false, frame: false, note: 'a navigation, followed by a click: the frame control makes no click (strict.spec.ts holds one: a link on the host page reaches a listener)' },
    { id: 'formaction', realm: 'view', covers: [], scheme: 'https', code: `<form><button id="m-formaction" formaction="{U}" style="${at(90)}">submit</button></form>`, outcome: 'removed', click: 'm-formaction', strict: false, frame: false, note: 'a navigation, followed by a click: the frame control makes no click (strict.spec.ts holds one: a link on the host page reaches a listener)' },
    { id: 'frames', realm: 'view', covers: [{ carrier: 'frames' }], scheme: 'https', code: '<iframe src="{U}"></iframe><object data="{U}"></object><embed src="{U}"><frame src="{U}">', outcome: 'removed', strict: false, frame: true },
    { id: 'base-meta', realm: 'view', covers: [], scheme: 'https', code: '<base href="{U}"><meta http-equiv="refresh" content="0;url={U}">', outcome: 'removed', strict: false, frame: false, note: "its refresh would navigate the control's frame away from the other makers' loads" },
    // CSS in the guest's markup
    { id: 'style-attr-url', realm: 'view', covers: [{ css: 'style-attribute', kind: 'image', via: 'url' }], scheme: 'https', code: '<div style="width:5px;height:5px;background-image:url(\'{U}\')"></div>', outcome: 'dropped', directive: 'img-src', strict: false, frame: true },
    { id: 'style-attr-image-set', realm: 'view', covers: [{ css: 'style-attribute', kind: 'image', via: 'image-set' }], scheme: 'https', code: '<div style="width:5px;height:5px;background-image:image-set(\'{U}\' 1x)"></div>', outcome: 'dropped', directive: 'img-src', strict: false, frame: true },
    { id: 'style-url', realm: 'view', covers: [{ css: 'style-element', kind: 'image', via: 'url' }], scheme: 'https', code: '<style>.m-bg{width:5px;height:5px;background:url("{U}")}</style><div class="m-bg"></div>', outcome: 'dropped', directive: 'img-src', strict: false, frame: true },
    { id: 'style-image-set', realm: 'view', covers: [{ css: 'style-element', kind: 'image', via: 'image-set' }], scheme: 'https', code: '<style>.m-set{width:5px;height:5px;background-image:image-set("{U}" 1x)}</style><div class="m-set"></div>', outcome: 'dropped', directive: 'img-src', strict: false, frame: true },
    { id: 'style-import', realm: 'view', covers: [{ css: 'style-element', kind: 'style', via: '@import' }], scheme: 'https', code: '<style>@import url("{U}");</style>', outcome: 'dropped', directive: 'style-src', strict: false, frame: true },
    { id: 'style-font-face', realm: 'view', covers: [{ css: 'style-element', kind: 'font', via: '@font-face' }], scheme: 'https', code: '<style>@font-face{font-family:mf;src:url("{U}")} .m-font{font-family:mf}</style><p class="m-font">font</p>', outcome: 'dropped', directive: 'font-src', strict: false, frame: true },
];

/** `set({ css })` on an element the view holds (`m-set-target`): the two kinds of property that may name a URL (VIEW_STYLE_PROPERTIES). */
const SET_CSS: Maker[] = [
    { id: 'set-cursor', realm: 'set-css', covers: [{ css: 'set-css', kind: 'image', via: 'url' }], scheme: 'https', code: "{ cursor: 'url(\"' + U + '\"), auto' }", outcome: 'dropped', directive: 'img-src', strict: false, frame: true },
    { id: 'set-custom', realm: 'set-css', covers: [{ css: 'set-css', kind: 'image', via: 'image-set' }], scheme: 'https', code: "{ '--m-image': 'image-set(\"' + U + '\" 1x)' }", outcome: 'dropped', directive: 'img-src', strict: false, frame: true },
];

/** A registered stylesheet (`net.css`, linked from the view) that names the network (its @import first, where CSS reads one). */
const STYLESHEET: Maker[] = [
    { id: 'sheet-import', realm: 'stylesheet', covers: [{ css: 'registered-stylesheet', kind: 'style', via: '@import' }], scheme: 'https', code: '@import url("{U}");', outcome: 'warned', strict: false, frame: true },
    { id: 'sheet-url', realm: 'stylesheet', covers: [{ css: 'registered-stylesheet', kind: 'image', via: 'url' }], scheme: 'https', code: '.m-sheet-bg{width:5px;height:5px;background:url("{U}")}', outcome: 'warned', strict: false, frame: true },
    { id: 'sheet-image-set', realm: 'stylesheet', covers: [{ css: 'registered-stylesheet', kind: 'image', via: 'image-set' }], scheme: 'https', code: '.m-sheet-set{width:5px;height:5px;background-image:image-set("{U}" 1x)}', outcome: 'warned', strict: false, frame: true },
    { id: 'sheet-font-face', realm: 'stylesheet', covers: [{ css: 'registered-stylesheet', kind: 'font', via: '@font-face' }], scheme: 'https', code: '@font-face{font-family:ms;src:url("{U}")} .m-sheet-font{font-family:ms}', outcome: 'warned', strict: false, frame: true },
];

export const SEALED_MAKERS: readonly Maker[] = Object.freeze([...WORKER, ...VIEW, ...SET_CSS, ...STYLESHEET]);

/** The URL a maker is aimed at, on the listener of its scheme (`origins` maps a scheme to the listener's origin). */
export const makerUrl = (maker: Maker, origins: Readonly<Record<MakerScheme, string>>) => `${origins[maker.scheme]}/m/${maker.id}`;

/** A maker's code with its URL in place. */
export const makerCode = (maker: Maker, url: string) => maker.realm === 'worker' || maker.realm === 'set-css'
    ? `(() => { const U = ${JSON.stringify(url)}; return ${maker.code}; })()`
    : maker.code.replaceAll('{U}', url);

// ---- the guest's styles ------------------------------------------------------------------------------------------------

/**
 * Every way guest CSS that names no network reaches the view's document (S74, class A: INHERITED_CONTEXT.cspReporting;
 * BD6:ISO-2; docs/research/25_cssom_styles/README.md): a style attribute of an element of each namespace the renderer
 * gives one (RENDER_ATTRIBUTES), a `<style>` in each namespace the renderer keeps one in (RENDER_ELEMENTS), and every
 * operation that changes a style after a render: `text()` and a render into a `<style>`, a render that replaces one, a
 * render that removes one, and `set({ css })`. As a style attribute or a `<style>` element, each would be an inline style
 * that the host page's `style-src` checks, refuses and reports; the view applies each through the CSSOM.
 * test/e2e/sealed-host-policy.spec.ts renders them on the realistic host with a `style-src` of hashes only, `'report-sample'`
 * and a keyed report endpoint, on every engine: the endpoint receives nothing, no violation is raised, and each style
 * applies. test/unit/sealed-makers.test.ts ties the list to the renderer's.
 */
export type StyleWay = 'attribute' | 'element' | 'text' | 'render-into' | 'replace' | 'remove' | 'set-css';

export interface StyleMaker {
    readonly id: string;
    readonly way: StyleWay;
    /** The namespace of the element that carries the style (an attribute, a set) or holds it (a `<style>`). */
    readonly namespace: 'html' | 'svg' | 'mathml';
    /** The markup the guest renders into the body. */
    readonly markup: string;
    /** What the guest does once that is rendered: one sandboxView call. */
    readonly then?: string;
    /** The element whose computed style shows the maker applied: its `property` computes to `value`. */
    readonly check: { readonly id: string; readonly property: string; readonly value: string };
}

const APPLIED = 'rgb(1, 2, 3)';
const OVERRIDDEN = 'rgb(9, 9, 9)';
const UNSTYLED = 'rgb(0, 0, 0)';

export const STYLE_MAKERS: readonly StyleMaker[] = Object.freeze([
    { id: 'attribute', way: 'attribute', namespace: 'html', markup: `<p id="s-attribute" style="color: ${APPLIED}">a</p>`, check: { id: 's-attribute', property: 'color', value: APPLIED } },
    { id: 'attribute-svg', way: 'attribute', namespace: 'svg', markup: `<svg width="9" height="9"><rect id="s-attribute-svg" width="9" height="9" style="fill: ${APPLIED}"/></svg>`, check: { id: 's-attribute-svg', property: 'fill', value: APPLIED } },
    { id: 'attribute-mathml', way: 'attribute', namespace: 'mathml', markup: `<math><mi id="s-attribute-mathml" style="color: ${APPLIED}">m</mi></math>`, check: { id: 's-attribute-mathml', property: 'color', value: APPLIED } },
    { id: 'element', way: 'element', namespace: 'html', markup: `<style>#s-element { color: ${APPLIED} }</style><p id="s-element">e</p>`, check: { id: 's-element', property: 'color', value: APPLIED } },
    // the cascade among them: the later <style> wins, and one whose media does not match applies nothing
    { id: 'element-order', way: 'element', namespace: 'html', markup: `<style>#s-order { color: ${OVERRIDDEN} }</style><style>#s-order { color: ${APPLIED} }</style><style media="print">#s-order { color: ${OVERRIDDEN} }</style><p id="s-order">o</p>`, check: { id: 's-order', property: 'color', value: APPLIED } },
    { id: 'element-svg', way: 'element', namespace: 'svg', markup: `<svg width="9" height="9"><style>#s-element-svg { fill: ${APPLIED} }</style><rect id="s-element-svg" width="9" height="9"/></svg>`, check: { id: 's-element-svg', property: 'fill', value: APPLIED } },
    { id: 'text', way: 'text', namespace: 'html', markup: '<style id="s-text-sheet"></style><p id="s-text">t</p>', then: `sandboxView.text('s-text-sheet', '#s-text { color: ${APPLIED} }')`, check: { id: 's-text', property: 'color', value: APPLIED } },
    { id: 'render-into', way: 'render-into', namespace: 'svg', markup: `<svg width="9" height="9"><style id="s-into-sheet">#s-into { fill: ${OVERRIDDEN} }</style><rect id="s-into" width="9" height="9"/></svg>`, then: `sandboxView.render('#s-into { fill: ${APPLIED} }', 's-into-sheet')`, check: { id: 's-into', property: 'fill', value: APPLIED } },
    { id: 'replace', way: 'replace', namespace: 'html', markup: `<div id="s-replace-slot"><style>#s-replace { color: ${OVERRIDDEN} }</style></div><p id="s-replace">r</p>`, then: `sandboxView.render('<style>#s-replace { color: ${APPLIED} }</style>', 's-replace-slot')`, check: { id: 's-replace', property: 'color', value: APPLIED } },
    { id: 'remove', way: 'remove', namespace: 'html', markup: `<div id="s-remove-slot"><style>#s-remove { color: ${OVERRIDDEN} }</style></div><p id="s-remove">x</p>`, then: "sandboxView.render('', 's-remove-slot')", check: { id: 's-remove', property: 'color', value: UNSTYLED } },
    { id: 'set-css', way: 'set-css', namespace: 'html', markup: '<p id="s-set">s</p>', then: "sandboxView.set('s-set', { css: { opacity: '0.5' } })", check: { id: 's-set', property: 'opacity', value: '0.5' } },
]);
