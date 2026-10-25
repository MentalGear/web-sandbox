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
 * Plain data and types: imported by a unit test as well as by the spec, so it imports nothing at run time.
 */
import type { CookieCarrierId } from '@src/lib/cookie-facts';

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
    | { readonly css: CssPlace; readonly kind: CssKind; readonly via: 'url' | 'image-set' | '@import' | '@font-face' };

/**
 * How sealed mode stops it and where that is reported:
 *   - `gate`: the request gate refuses it in the guest (the platform's failure) and reports a `connect-src` violation whose
 *     sourceFile is the gate's, with the URL;
 *   - `refused`: the library refuses it in the guest with its own code and sends nothing anywhere (`sandboxFetch()`:
 *     FETCH_NOT_ALLOWED, D4);
 *   - `absent`: the worker has no such global or member (the allowlist), so the attempt throws in the guest;
 *   - `policy`: the browser's policy refuses it (a module script outside `script-src`); the guest's promise rejects, and the
 *     engine's own report reaches the element where the engine raises one in a worker (Chromium, Firefox; not WebKit);
 *   - `dropped`: the renderer drops the URL before insertion and reports it as a violation of its kind's directive;
 *   - `removed`: the renderer keeps no such element or attribute, so nothing names the URL and nothing is reported: a
 *     navigation (a link's href becomes INERT_HREF, a form loses its action), a frame, a ping, and a `<link>` that names no
 *     file the view minted (removed whole, in strict mode too);
 *   - `warned`: the element drops the URL from a registered stylesheet when it builds, and warns once, naming the file.
 */
export type SealedOutcome = 'gate' | 'refused' | 'absent' | 'policy' | 'dropped' | 'removed' | 'warned';

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
    { id: 'import', realm: 'worker', covers: [], scheme: 'https', code: "import(U).then(() => 'sent', (e) => e.name)", outcome: 'policy', sees: 'TypeError', strict: false, frame: true },
    { id: 'import-scripts', realm: 'worker', covers: [{ global: 'importScripts' }], scheme: 'https', code: absent('importScripts(U)'), outcome: 'absent', sees: 'ReferenceError', strict: false, frame: false, note: 'a document has no importScripts()' },
    { id: 'worker', realm: 'worker', covers: [{ global: 'Worker' }, { carrier: 'frames' }], scheme: 'https', code: absent('new Worker(U)'), outcome: 'absent', sees: 'ReferenceError', strict: false, frame: false, note: "a frame's Worker of another origin's URL is refused before any request" },
    { id: 'shared-worker', realm: 'worker', covers: [{ global: 'SharedWorker' }, { carrier: 'frames' }], scheme: 'https', code: absent('new SharedWorker(U)'), outcome: 'absent', sees: 'ReferenceError', strict: false, frame: false, note: "a frame's SharedWorker of another origin's URL is refused before any request" },
    { id: 'event-source', realm: 'worker', covers: [{ global: 'EventSource' }, { carrier: 'eventsource' }], scheme: 'https', code: absent('new EventSource(U, { withCredentials: true })'), outcome: 'absent', sees: 'ReferenceError', strict: false, frame: true },
    { id: 'send-beacon', realm: 'worker', covers: [{ navigator: 'sendBeacon' }, { carrier: 'beacon' }], scheme: 'https', code: absent("navigator.sendBeacon(U, 'x')"), outcome: 'absent', sees: 'TypeError', strict: false, frame: true },
    { id: 'web-transport', realm: 'worker', covers: [{ global: 'WebTransport' }], scheme: 'https', code: absent('new WebTransport(U)'), outcome: 'absent', sees: 'ReferenceError', strict: false, frame: false, note: 'WebTransport needs HTTP/3, which the listener does not speak' },
    { id: 'websocket-stream', realm: 'worker', covers: [{ global: 'WebSocketStream' }], scheme: 'wss', code: absent('new WebSocketStream(U)'), outcome: 'absent', sees: 'ReferenceError', strict: false, frame: false, note: 'no engine of the suite sends its handshake to the listener from a frame (measured)' },
    { id: 'font-face', realm: 'worker', covers: [{ global: 'FontFace' }], scheme: 'https', code: absent("new FontFace('f', 'url(' + U + ')').load()"), outcome: 'absent', sees: 'ReferenceError', strict: false, frame: true },
    { id: 'caches', realm: 'worker', covers: [{ global: 'caches' }], scheme: 'https', code: absent('caches.open(U)'), outcome: 'absent', sees: 'ReferenceError', strict: false, frame: false, note: 'Cache Storage makes no request' },
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
