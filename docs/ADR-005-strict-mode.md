# ADR-005: Strict mode — guest logic in a worker, a view that runs no guest script

**Status**: Accepted · **Date**: 2026-10-13

## Context

Three guarantees could not be made to hold where guest script runs in a DOM document (cooperative mode), each for the
same structural reason:

| Item | Cooperative-mode limit |
| :--- | :--- |
| S6 · execution budget | where the browser runs the sandboxed frame on the host page's thread (WebKit always, Chromium in some environments), a guest loop blocks the host's timers too, so no watchdog can stop it |
| S13 · WebRTC | the bootstrap removes `RTCPeerConnection` from the guest's realm, but a frame the guest creates is a realm of its own, runs its own script under the inherited `'unsafe-inline'`, and its ICE traffic leaves in Chromium and WebKit |
| S17 · host URL in WebKit | a frame the guest creates reads the host page URL (path and query) as `document.referrer` in WebKit |

A fourth: in WebKit a guest that asks for `unsafe-url` sends the host page's full URL as `Referer` to any allowed origin
that is same-site with the host page (S18).

None of these has a single chokepoint in cooperative mode: frames can be created through `innerHTML`, `document.write`,
`setHTMLUnsafe`, the parser, closed declarative shadow roots and `javascript:` URLs, and a same-thread loop is a platform
limit. The structural answer is to take guest script out of every document. It is also why strict mode is the default:
every review found its new issues in the mode where guest script runs in a document, and each was the same class — a
realm the library does not reach, or a platform behaviour no policy governs — so each fix was a guest-realm patch and the
next finding was another. Strict mode closes that class by construction.

## Decision

**`mode: 'strict'` is the default.** Guest code runs only in a dedicated classic worker. The DOM frame — the *view* —
runs exactly one script, the library's bootstrap, admitted by its SHA-256 hash, and shows what the worker renders.

```
host page
└─ wrapper   frame-src 'none', base about:blank, no-referrer (frame-documents.ts); runs no script
   └─ view   srcdoc = CSP <meta> + referrer <meta> + ONE <script> (the bootstrap); no guest bytes
      └─ worker  new Worker(blob:) spawned by the view: comms, sandboxFiles, the strict prelude, the entry
```

Three ports per environment, all `MessageChannel`s. Each frame type is declared once, with its route, its fields and
what bounds each, in `src/lib/frames.ts` (`FRAMES`); [ARCHITECTURE.md](../ARCHITECTURE.md#channels-and-frames) lists them
all, with the realms named as there (`strict-worker` is the guest's worker). `VIOLATION` is labelled by the port it arrives
on, and the render port is the view's and the worker's alone
([ADR-002](ADR-002-host-guest-broker.md#strict-mode-renders-bypass-the-host)).

<!-- describes: adr005:ports sig:3633 -->
<!-- generated:begin adr005-ports -->
| Port | Ends | Carries |
| :--- | :--- | :--- |
| logic | host ↔ strict-worker | `EXECUTE`, `PING`, `PONG`, `RPC_REQ`, `RPC_RES`, `LOG`, `VIOLATION`, `UNCAUGHT_PAST_BUDGET` |
| view | host ↔ view | `VIOLATION`, `RESIZE`, `VIEW_READY`, `VIEW_PING`, `VIEW_PONG`, `VIEW_WRITE`, `VIEW_WRITTEN`, `VIEW_FIRST_OVERRUN`, `VIEW_OVERRUN`, `GUEST_ERROR`, `GUEST_UNCAUGHT`, `GUEST_TEXT_DROPPED`, `TRUSTED_TYPES_REFUSED`, `WORKER_REFUSED` |
| render | view ↔ strict-worker (the host is not on this path) | `VIEW_STARTED`, `VIEW_RENDER`, `VIEW_TEXT`, `VIEW_SET`, `VIEW_LISTEN`, `VIEW_ACK`, `VIEW_EVENT` |
<!-- generated:end -->

<!-- generated:begin adr005-init-view -->
On the wrapper's one `load`, the host posts `INIT_VIEW { workerSource, entryDone, viewFiles, html, autoResize, allowAnimations, allowAutoplay, origins }` to the view with the logic and view ports.
<!-- generated:end -->

The bootstrap accepts exactly one `INIT_VIEW`, from `parent.parent`, in a capture listener that stops it there; it
creates the render port, spawns the worker from a `blob:` URL (`worker-src blob:`; worker scripts are checked against
`worker-src`, not the script hashes, so the hashed text stays constant) and hands the worker the logic and render ports.

### The modes

- **The modes are `'strict' | 'cooperative' | 'worker'`**, in the config schema (`CONFIG_SCHEMA`, `mode`; the default is
  strict). A config without `mode` is a strict config, in the types too (`StrictSandboxConfig.mode` is optional;
  `CooperativeSandboxConfig.mode` is required), and `origins` is parsed for the mode the build will have, so a config that
  names no mode drops `scripts`. A default element with only `html` renders the cleaned html in the view and runs no guest
  script: without an `entry` the worker runs only the prelude. The mode that runs guest script in a document is
  `'cooperative'`: it is for cooperative content. `'iframe'` was renamed and is not aliased: it fails closed like any
  unknown mode, and the reason and the one warning say `('iframe' was renamed 'cooperative')`.
- **Markup written for cooperative mode is said to run nothing.** When a strict build's `html` holds a script element or an
  `on…` handler attribute, the element warns once: ``strict mode (the default) runs no script in `html`; name a registered
  file in `entry`, or choose `mode: 'cooperative'`.`` It reads the markup with the host's `DOMParser`, which runs and loads
  nothing (`src/lib/markup-scripts.ts`), and never changes what is rendered: the renderer drops both.
- **Cooperative mode's limits are a frozen list.** No new guest-realm patch is made in cooperative mode; a new finding there
  is documented as a limit (README "Cooperative-mode limits", the same in API.md and backlog S44). The list: the
  same-thread execution budget (S6); the pre-policy window over guest markup (S8); frames the guest creates (S13: WebRTC;
  S35: Firefox keepalive, history traversal, naming) and workers it creates (Firefox `EventSource`, `FontFace`); the host
  URL in WebKit's created frames (S17) and to same-site origins (S18), with S15's platform limits; WebKit's preconnect;
  focus, clipboard, messages to the host window, modifier-click tabs and session history (S36, V3, H1); forgeable
  violation reports; guest-only stalls (a document that never finishes, Firefox's silent `<meta refresh>`). The hardening
  already in the guest realm (S35) stays.
- **Worker mode is frozen as it is.** It duplicates strict mode without a view; folding it into strict mode with `entry` is
  backlog S49.

### The guarantees, on Chromium, Firefox and WebKit

- **G1 — no guest script runs in any document.** The view's policy is `script-src 'sha256-<bootstrap>'` with
  `script-src-attr 'none'`: no inline script, handler or `javascript:` URL can run there. Rendered markup is parsed into an
  inert `<template>`, cleaned by the renderer, then **moved** into the document — never cloned or imported (A2: a cloned SVG
  `<script>` is fresh and runs, P6). The renderer is an allowlist (below), so every nested browsing context and
  document-level control (`iframe`, `frame`, `frameset`, `object`, `embed`, `portal`, `fencedframe`, `script` in HTML and
  SVG, `meta`, `base`, `noscript`, nested `template`) is gone before insertion, and `link` survives only as a stylesheet or
  icon naming a file the view minted (A1). So no frame exists below the view at all, and a copy of the bootstrap can never
  run (a copy that ran a second time in the view would also return at once).
- **G2 — guest logic is confined to one worker.** Before any guest code the worker keeps only the globals of an allowlist
  (below), so it has no `Worker` or `SharedWorker` (a nested blob worker would be admitted by `worker-src blob:`, P3), no
  `postMessage`, `onmessage` or `onmessageerror` of its own (what it posted reached the view's `Worker` object, on the host
  page's thread wherever the view shares it, outside every budget; the library's ports are its only way out), and never
  `RTCPeerConnection` or a document; the prelude deletes `WebAssembly` unless `scriptUnsafe` (WebKit compiles it without
  `'unsafe-eval'`, P3) and `URL.createObjectURL` (A8). Its location is its own `blob:null/…` URL.
- **G3 — the host can always stop the guest.** The watchdog (`watchdogTimeout`) and `workerExecutionTimeout` watch the
  worker, which never shares the host's thread: the S6 bound holds on every engine
  ([ADR-003](ADR-003-lifecycle-and-liveness.md#strict-mode-bounds-execution-on-every-engine)).
- **G4 — egress is the policy, and nothing navigates.** The worker inherits the view policy exactly (`connect-src` governs
  it), and requests only through the four globals of its allowlist that the policy governs on every engine; the view's
  loads are governed by `img-src`, `style-src`, `font-src`, `media-src`, and a URL in rendered markup is kept only where
  every engine's policy check admits it (its exact origin is listed, or it is an image's `http:` URL whose `https:` upgrade
  is, off a loopback host), else dropped by the renderer before the browser sees it and, an `http(s)` one, reported as a
  violation. The ones it keeps are bounded in number (`VIEW_MAX_URLS`), and every load is charged before the browser can
  start it (a kept URL attribute when it is rendered, what applied CSS can load, counted from its text, when it is applied;
  S73) and otherwise as the browser reports it (resource timing, CSS-borne loads included, and violations), per second
  (`VIEW_URLS_PER_SECOND`) and in distinct URLs over the view's life (`VIEW_MAX_DISTINCT_URLS`). The renderer's prediction
  may only err toward refusing, and no bound depends on it. No WebRTC is reachable. The view cancels the default of every
  click on or inside a link (HTML and SVG `a`, `area`, anything with an `href`, including fragment links, which resolve
  against the inherited `about:blank` base and so are navigations) and of every submit; `form-action 'none'` and the
  wrapper's `frame-src 'none'` stand behind that, and `<meta http-equiv=refresh>` cannot exist (A1). Rendered links are
  inert (below).
- **G5 — nothing guest code can read reveals the host URL.** Guest code runs only in the worker. Every request the worker or
  rendered markup makes carries no `Referer`: the renderer forces `referrerpolicy="no-referrer"` and removes
  `<meta name=referrer>`, which closes S17 and S18 here.
- **G6 — the view's violation reports are complete and unforgeable** (A6, rescoped). No guest code runs in the view, and the
  host labels reports by the port they arrive on, so `source: 'view'` reports are the library's own, complete up to
  `VIOLATION_EVENT_LIMIT` **per directive** (the view and the host count each directive the browser names apart, so the
  guest's refused loads of one kind cannot hide a report of another; the buckets are the known directive names plus one,
  which bounds the view's events). The view's reports include refusals of the guest's own rendered markup, so a guest that
  renders 100 refused loads uses up the cap for that directive in the environment. Worker reports (`source: 'logic'`) are
  forgeable like any cooperative-mode report and per engine.
- **The view renders no `blob:` content but registered files and raster-image guest writes, decoded only** (A8). The worker
  cannot mint URLs (its prelude removes `URL.createObjectURL`), the worker's own source URL is revoked once its script ran
  (below), and the renderer removes every attribute that names a `blob:` URL the view did not mint
  ([ADR-004](ADR-004-files-as-blob-urls.md#strict-mode)).

### API

```js
sandbox.registerFiles({ 'main.js': `sandboxView.render('<button id="go">Go</button>');
    sandboxView.on('click', 'go', (e) => sandboxView.render('<p>clicked ' + e.target.id + '</p>'));` });
sandbox.setConfig({ mode: 'strict', entry: 'main.js' });
```

- `mode: 'strict'`, `entry` (a registered JavaScript path; the worker runs it first, as a classic script); `html` / `load()`
  is the initial view; `execute()` runs in the worker (needs `scriptUnsafe`); `call()` and `expose()` talk to the worker's
  `bridge`; `watchdogTimeout` and `workerExecutionTimeout` watch the worker.
- In the worker, `sandboxView.render(html, into?)` replaces the view's body, or the children of the element whose id is
  `into`; at most `VIEW_RENDER_MAX_LENGTH` (256 Ki) characters; latest wins per target. `sandboxView.text(id, text)` makes a
  string an element's only content, assigned and never parsed, so a guest escapes nothing; `sandboxView.set(id, { value?,
  checked?, focus? })` sets an `input`'s, `textarea`'s, `select`'s or `output`'s value (not a file input's) or an `input`'s
  checked state, or focuses the element. `sandboxView.on(type, id | null, handler)` returns `off`: `click`, `input`,
  `change`, `submit`, `keydown`, trusted only, with a detail of `{ type, ids, target: { tag, id, name, value, checked },
  key?, form? }` — never a URL. [API.md](API.md#sandboxview-strict-mode) lists the signatures, the renderer's lists and the
  budgets.
- An entry that fails to start (a syntax error, or a throw at its top level) ends the sandbox with `the guest entry failed
  to start`; a later uncaught error is logged and does not. An entry that is not a registered JavaScript file ends the build
  with a reason.
- `violation` events carry `source: 'view' | 'logic'` in strict mode.
- `viewScriptHash()` is exported: the bootstrap's hash source, the very value `viewBootstrapHash()` puts in the view's
  `script-src`, for an embedder's own policy. The wrapper style's hash is a constant documented in API.md; it gets no name.
- `allow-forms` is an unsafe capability in cooperative and worker mode (`UNSAFE_SANDBOX_FLAGS`). Strict mode's view always
  has `allow-scripts allow-forms` (`STRICT_VIEW_FLAGS`, `src/lib/config-schema.ts`), since `submit` must reach the bootstrap
  to be forwarded and cancelled (P4), no guest script runs in the view, and its forms keep no `action`, `formaction`,
  `method` or `target`. A strict config that lists `allow-forms` in `capabilities` warns nothing.

### The view policy

The generator's strict template (`strictViewPolicy`, `src/lib/csp/csp-generator.ts`; [ADR-007](ADR-007-typed-origins.md)),
every directive explicit:

```
default-src 'none'; script-src 'sha256-<B>' ['unsafe-eval']; script-src-attr 'none'; style-src 'unsafe-inline' …;
img-src …; font-src …; media-src …; connect-src …; worker-src blob:; frame-src 'none'; object-src 'none';
base-uri 'none'; form-action 'none'; manifest-src 'none'; upgrade-insecure-requests
```

The embedder's `origins` fill `style-src`, `img-src`, `font-src`, `media-src` and `connect-src` only, and `blob:` is added per
kind for the files the view or the worker may load, never to `script-src`. `'unsafe-eval'` comes only with `scriptUnsafe`.
`origins.scripts` does not type-check in strict mode (`StrictSandboxConfig`) and is dropped with one warning at run time.
`data:` is not an origin, so it reaches no image (ST1: a `data:` SVG opened in a new tab is a document that runs its
script) and no font or media either. The sandbox flags are `allow-scripts allow-forms` plus the configured safe
capabilities; `unsafeCapabilities` are dropped with one warning.

**The hash** is computed synchronously on the host (`src/lib/csp/script-hash.ts`) over the UTF-8 of the bootstrap text, once
per page. The text is the stringified library functions, so it differs between the dev server, the bundle and a consumer's
build; hashing at run time always matches what the page serves. The parser changes CR, CR LF and NUL (P2), so the text is
refused if it contains any, or anything that would end or re-enter the script element (A3).

### The renderer

- **An allowlist.** `RENDER_ELEMENTS` and `RENDER_ATTRIBUTES` (`src/lib/in-sandbox-view.ts`; the lists and what guests lose
  are in [API.md](API.md#sandboxview-strict-mode)). A renderer that lists what to remove leaves open every mechanism the
  list does not name (SMIL animation and SVG `<use>` both came from there); one that lists what is kept does not. Per
  namespace: HTML flow, phrasing, sectioning, lists, tables, forms and their controls, details, dialog, media, `style` and
  the minted `link`; SVG shapes, text, structure, gradients, clip paths, masks, patterns; MathML Core presentation elements.
  Attributes: the global ones, `data-*`, `aria-*`, and per element what it needs; never a handler, a form target, an
  invoker, or a URL attribute other than `src`, `srcset`, `poster` and the minted `link` `href`, which keep only `https:`,
  `http:`, a URL the view minted or a relative one (no `data:`, no `javascript:`).
- **Unknown HTML elements are unwrapped**: their children take their place and are checked in turn, so obsolete or unknown
  wrappers (`center`, `font`, `marquee`) keep their text; nothing is serialised or reparsed, so unwrapping cannot change what
  a child is. The elements that hold raw text, a template or a browsing context (`script`, `noscript`, `template`,
  `iframe`, …) and **every SVG or MathML element outside the list are removed with their content** (an unknown SVG element
  renders nothing anyway; `annotation-xml` can hold HTML). A hyphenated custom element name is kept: no script can define it
  in the view, so it is an inert element. Move-not-clone (A2) and the captured primitives hold: the walk reads and changes
  nodes only through prototype getters and methods captured when it starts.
- **Left out by measurement**, beyond what a review listed: `marker` is out like `use` (markers instance their content per
  vertex and nest), SVG filter primitives are out (their cost is what their parameters say, not what the markup weighs), and
  SVG `image` is out (the HTML `img` covers it, under the same rules). Masks, clip paths and patterns nested the same way
  measured flat, and stay, without `href` templates. SVG animation elements (`animate`, `set`, `animateMotion`,
  `animateTransform`, `animateColor`, `discard`, `animation`) are not on the list: a `<set>` inside a rendered link could
  animate its `href` back to the guest's URL after the renderer made it inert, and one inside an `<image>` could load a URL
  the renderer never saw, so the renderer checks attributes once, before insertion, and nothing may change them afterwards.
- **Linear, and no element whose layout is super-linear.** The walk takes each parent's children from the front and appends
  the kept ones back (removing middle children one by one is quadratic). Runs of text are joined into one node, and comments
  are dropped. `wbr`, `ruby`, `rt` and `rp` are unwrapped for what their layout costs; a scan of the other listed elements
  found them linear.
- **Links are inert.** The renderer replaces the value of every href that makes a hyperlink (HTML `a` and `area`, SVG `a` with
  `href` and `xlink:href`, any MathML element) with one constant, `INERT_HREF = 'about:blank#'`, before insertion; no option
  turns it off. The browser's own actions on a link — "copy link address", "open in new tab", dragging — need no page event,
  so the view cannot cancel them, and they would carry the guest's URL; with the constant they carry none. The worker never had the URL
  (event details carry ids), so routing is unchanged, and an embedder who wants links that leave the sandbox exposes a host
  method (`openExternal(url)`) that the worker calls on click. `about:blank#` is absolute, so it means the same in any
  document; every engine reports it unchanged as the link's URL and its drag data; and opening it loads the empty
  `about:blank`, no request. `#` resolves to the same only through the view's inherited `about:blank` base; `""` differs per
  engine; `about:invalid` and `javascript:` differ per engine; `data:,` opens a document. Removing `href` or rewriting to a
  `span` would drop the element from the tab order, the role `link` and `:link`/`:any-link`; with the constant all three
  hold, and clicks and Enter are still cancelled and delivered by id.
- **Nothing the view shows opens as a document.** A user can open a shown image or video in a new tab, a navigation the
  view cannot cancel; a registered SVG opened that way ran its script top-level, outside the policy. The view mints URLs
  only for `VIEW_FILE_TYPES`, types that are never a document, through its own load-kind table derived from the cooperative
  one ([ADR-004](ADR-004-files-as-blob-urls.md#strict-mode)). An image from an origin the embedder allowed opens as that
  origin's document: a residual.
- **Forcing off animations and autoplay, as switches.** See below.

### Flow control, files, clobbering, liveness

- **Flow control (A4).** `sandboxView.render()` keeps the latest html per target and posts one render at a time; the view
  applies at most one flush per animation frame (a 100 ms timer stands in where frames are throttled) and acknowledges it,
  which releases the next. `render` and `text` share one slot per target, and a `set` merges only into a `set` of the same
  id queued right before it, so no operation passes another. The render port is taken from the one trusted `INIT_WORKER`
  message by a capture listener registered before guest code, which stops every trusted message on the worker's global;
  every operation on it uses primitives captured then, called through a captured `Reflect.apply`. So guest code cannot post
  on it — patching `MessagePort`, `MessageEvent`, `EventTarget` or `Function` prototypes yields only the logic port, as in
  worker mode. A render the renderer refuses is dropped but still acknowledged, so it can neither be half-inserted nor jam
  the flow control; the view finds an operation's element as a render's target, drops an id that names nothing and
  acknowledges.
- **Files (A8, [ADR-004](ADR-004-files-as-blob-urls.md#strict-mode)).** The view mints its own `blob:` URLs for the registered
  files that are never a document; the renderer resolves the cooperative mode's reference attributes (minus `<script src>`)
  against `https://vfs.invalid/index.html`, and removes every attribute that holds a `blob:` URL the view did not mint. The
  worker gets every file through `sandboxFiles`. No `blob:` in `script-src`, ever; strict mode is classic only. The view
  shows raster-image guest writes, decoded only, from URLs it mints from the bytes the host holds.
- **DOM clobbering.** `Document` and `HTMLFormElement` let named elements override built-ins (`<img name="body">` is
  `document.body`; in `<form><input name="hasAttribute">` the form's `hasAttribute` is the input). The bootstrap and the
  renderer therefore read and change the DOM only through prototype methods and getters captured before any markup exists;
  the link check cancels if anything unexpected throws.
- **Liveness (A5).** The host pings the view on the view port, always (5 s budget, host stalls not counted). A view that stops
  answering — Chromium replaces a view whose navigation the wrapper refuses with an error page, which ends the worker with it
  (P4) — ends the sandbox with `the sandbox view stopped responding`.
- **`ready` is the view's check-in.** The view's bootstrap posts `VIEW_READY` as the first frame on the view port, which only
  it holds; the host enters `ready` on it, never on the wrapper's load alone ([ADR-003](ADR-003-lifecycle-and-liveness.md)).
  A build whose frame loaded but whose bootstrap never checked in ends with a reason that names the host page's policy (a
  `srcdoc` document inherits the host page's `script-src`); a worker the host page's policy refuses ends with its own reason
  (a probe worker tells it from Firefox's message-less syntax error). The view's two HTML and script sinks go through one
  Trusted Types policy (`web-sandbox`) where the host page requires them (API.md, "Host page policy").
- **Focus never leaves the host page for the sandbox on the guest's say.** A sandboxed frame's `focus()` without user
  activation takes focus from the host page's focused element in Chromium and Firefox (Chromium also its keystrokes);
  WebKit keeps it. So `set({ focus: true })` focuses only while the view's `document.hasFocus()`: the user last clicked or
  tabbed into the sandbox and the window is focused. Otherwise the view refuses it (`VIEW_FOCUS` in the ack, a line in the
  guest's log) and applies the rest of the call.

### The worker's globals are an allowlist

The worker keeps only the globals of `WORKER_GLOBALS` and the navigator members of `WORKER_NAVIGATOR_MEMBERS`
(`src/lib/worker-globals.ts`). Its first statement, in strict mode and in worker mode (`keepOnlyWorkerGlobals`), deletes
every other name from the global object and from its scope prototypes (where the engines keep `fetch`, `fonts`, `caches`,
`importScripts`, …), before the library's scripts and any guest code. Four listed globals can make a request — `fetch`,
`XMLHttpRequest`, `WebSocket` (`connect-src`) and `importScripts` (`script-src`) — each measured as governed on all three
engines; the rest of the list makes none (the language, timers, events, encoding, streams, crypto, blobs and URLs,
IndexedDB, OffscreenCanvas, WebCodecs). A denylist would have to know every engine's gaps and every future API: in Firefox,
`new EventSource(url)` from a worker reached an origin `connect-src` blocks, and `new FontFace(name, 'url(…)')` one
`font-src` blocks, with no violation, while `fetch` and the rest were refused. So G4 reads: **the worker requests only
through APIs the policy governs on every engine, and any other platform API, present or future, is absent.** A listed name
added later must be measured the same way first. A name off the list that cannot be deleted stops the worker before the
channel exists (fails closed); WebIDL constants, primitives, are left. Worker mode thereby loses nested workers too.
Residual: in cooperative mode the guest can still create a worker of its own, and in Firefox its EventSource and FontFace
pass (the S13 class: a realm of its own).

The entry's console lines are not lost: the comms script installs its console relay while the bootstrap runs and buffers up
to 1000 lines (in order with bridge frames) until the logic port exists.

### The entry and the worker's prelude

- **The entry runs in its own scope.** The worker's source is one classic script, and a script's declarations are
  instantiated before any of it runs, so a top-level `function Reflect() {}` in the entry would replace a global before the
  prelude captured it, and a declared `Worker` would make the prelude's deletion fail silently. The host evaluates the entry
  inside `(function () { … }).call(this)`: **its top-level declarations are local** (an entry that wants a global assigns it,
  `globalThis.x = …`; `this` is still the global object). An entry that closes that function early to declare at the
  script's top level is refused before the prelude runs: a top-level function declaration is the only thing that leaves a
  non-configurable function on the global object (all three engines), and the first step of the prelude checks for one
  (`assertEntryScoped`). A name the prelude cannot delete is an error, not a silent pass.
- **The prelude's lists have no prototype.** Its render queue, handlers and subscribed types are null-prototype lists, so
  guest code with a setter (or a Proxy) in `Array.prototype`'s chain sees none of them; flow control holds with such a trap
  installed.
- **The worker's source URL is revoked once its script ran.** The view revokes it on the first message the worker sends on
  the render port (`VIEW_STARTED`, which the prelude posts when it takes `INIT_WORKER`, so only after the whole worker script
  ran; guest code cannot post on that port). From then on the URL resolves nowhere, so the only `blob:` URLs rendered CSS
  could name are the worker's copies of registered files: the view-renders-no-`blob:`-but-registered-files guarantee holds by
  construction instead of by the source's type and prefix. Revoking when the Worker object exists, before WebKit has read the
  script, breaks `sandboxFiles` there. Inside the worker, WebKit mutes the text of an uncaught error thrown by code from the
  revoked script (it reads `Script error.`, no error object) while the Worker object in the view still gets its text; so the
  prelude logs the later errors it can describe and leaves a muted one to the view, which logs it as the same `Uncaught …`
  guest line (`GUEST_UNCAUGHT` on the view port).
- **The end of the entry is read from the order of one channel.** The view must tell the entry's own errors (which end the
  sandbox) from later ones. The line after the entry raises the build's marker error (its message is the per-build marker name,
  `entryDoneName`, 128 random bits, which the view gets in `INIT_VIEW`), through `reportError` so that it is raised before any
  microtask the entry queued (Firefox and WebKit report an error thrown at the end of a script only after them). The prelude
  stops it, so no listener of the guest's sees it, and leaves it uncancelled; the view cancels it and posts nothing, and looks
  for it only until it came, in the first characters of the text. Every error on the Worker object before it is the entry's;
  every error after it is later, because errors on one Worker object arrive in the order they were raised. An entry that threw
  never reaches the marker, so its errors all end the sandbox. A guest that reads the marker's name and raises its text itself
  can only spare its own failing entry the end it would have had; it cannot make a later error end the sandbox. Telling the
  two by `VIEW_STARTED` on the render port instead is wrong: WebKit mutes the errors of code compiled from a string
  (`Function`, `eval`, so every `execute()`) from the start, before any revocation, and its render-port messages can arrive
  after a later error on the Worker object.

### The view's budgets

The view's cost to the thread it runs on is one statement, in
[API.md, "The view's cost to the host page"](API.md#the-views-cost-to-the-host-page), per engine and process placement; the
limits are in [Limits](API.md#limits). What the decision rests on:

- **The document is bounded and the DOM an apply builds is linear in its markup.** The view's body holds at most
  `VIEW_MAX_ELEMENTS` elements nested at most `VIEW_MAX_DEPTH` deep and `VIEW_MAX_CHARACTERS` (4 × `VIEW_RENDER_MAX_LENGTH`)
  characters of serialization, counted over the document a render would leave (renders accumulate across targets, so a
  per-render bound alone would not bound the document): past any, the render is refused before insertion, still
  acknowledged, and the worker logs why. The view parses at most `VIEW_RENDER_CHARACTERS_PER_SECOND` characters per second,
  refused renders included: a render past it waits, and flow control holds the worker meanwhile. One event detail carries at
  most `VIEW_EVENT_LIMITS.maxTotal` characters in all, with `truncated: true` when anything was cut.
- **Running counts.** The view keeps its body's serialized length and element count as running counts, updated from what each
  operation changes (the target's old and new content, a value attribute), not by serializing the whole body per operation. A
  `MutationObserver` on the body reports any change no operation made (the user opening a `<details>`, find-in-page, an
  extension); the counts are then dropped and the next operation counts the whole body again. What an operation serializes is
  charged to the per-second character budget on top of its own text.
- **A time budget.** The view spends at most `VIEW_APPLY_MS_PER_SECOND` (200 ms) of its own time per second applying
  operations: each flush is timed with its forced layout (by hit testing, `elementFromPoint`, which WebKit cannot answer
  without laying out a textarea's text, unlike `offsetHeight`), and the rendering update that follows it is charged as
  measured (the time from the end of a frame callback to the first task after it: the frame the flush ran in, or the next
  frame for a flush the timer ran). An operation past the budget waits; nothing is dropped. At most one measurement is
  outstanding, nothing is requested without a flush, and no wall time is charged in which no frame ran (a measure across
  which the document's visibility changed is dropped), so a hidden or off-screen view neither stalls nor is charged for
  rendering nothing. Every operation is charged all it took, so the budget is a long-run average, not a bound on each
  second.
- **One operation, and the repeated-overrun rule.** One operation, a flush and the rendering measured after it, is bounded by
  `VIEW_MAX_OPERATION_MS` (2 s) and the repeated-overrun rule (the owner's decision, S72, class P): past it the operation is
  an overrun, charged in full, and the view goes on; the second overrun within `VIEW_OVERRUN_WINDOW_MS` (5 minutes) stops the
  view and ends the sandbox (`the view spent more than 2000 ms on one operation twice within 5 minutes`). The meter measures
  wall time, so under machine load a single overrun ends nothing: a large initial view on a loaded CI runner, and WebKit's
  first `set()` of a 250 000-character textarea, are overruns without a fault of the guest. A debt cap of one second would
  charge an operation of 7.5 s only 1.2 s, and it would run again every 12.5 s (53% busy).
- **URLs have budgets of their own**, because what the browser does with a URL after the render (fetching, decoding, laying
  the image out, a refused one's violation processing) runs on the host page's thread and outside the time budget:
  `VIEW_MAX_URLS`, `VIEW_URLS_PER_SECOND` and `VIEW_MAX_DISTINCT_URLS` (the last bounds a cumulative cost, which a rate
  cannot).
- **Stated once.** The long-run bound, the single-operation bound, the rates and caps that bound what the meter cannot see,
  and the closed list of what is outside it are one statement in API.md. A cost of the view outside both the bound and its
  list is a finding. README's limits link it instead of restating it.
- **The guest's error texts.** The view cuts each `GUEST_ERROR` and `GUEST_UNCAUGHT` text to 2048 characters and sends at most
  `LOG_EVENTS_PER_SECOND` of them per second before posting; the host cuts them again.

**Rejected: a meter and an actuator** (measure the host's load, pause what animates). Pausing animations one by one
(`getAnimations().forEach(a => a.pause())`) made it worse (Chromium reached 100% with a 9.7 s frame). A freeze stylesheet
switched on by the meter held Chromium and Firefox only while the view was visible, held WebKit well above its target, and
was blind to off-screen views in Firefox and to hidden or off-screen views in WebKit. A switch the embedder sets, in force
from the first render, has neither problem.

### The switches: `allowAnimations` and `allowAutoplay`

What runs without the view doing anything is outside the time budget: CSS animations and transitions, scroll-driven
animations, a pointer moving over `:hover ~` rules, animated images, indeterminate `<progress>`, autoplaying media.

- **`allowAnimations`** (strict mode, default `true`; a literal `false` turns it off, any other non-boolean is `false` with
  one warning; ignored with a warning in the other modes; part of the equal-config comparison). **While `true`, CSS
  animations and transitions in the view run on the host page's thread wherever the browser runs the view there, and the
  time budget does not bound them: a guest can keep the host page busy for as long as they run.** `false` removes them, and
  the bound holds again:
  - a stylesheet of the library's (`VIEW_STILL_STYLE`) becomes the view head's first element at `INIT_VIEW`, before anything
    is rendered: one anonymous `@layer` with `animation:none!important;transition:none!important` on `*`. Its text is constant
    (so is its hash); the view appends to the layer, through the CSSOM, a rule of its own for each pseudo-element of
    `VIEW_STILL_PSEUDO_ELEMENTS` this engine supports, once guest CSS it is about to apply names it (an escape or an `@import`
    names them all). Every rule costs style work for every element, and only a guest stylesheet can give a pseudo-element an
    animation, so a guest pays for the pseudo-elements it names, in its own time budget. Pseudo-elements on which no animation
    ran or only typographic properties apply (`::first-letter`, `::first-line`, the highlight pseudo-elements, `::column`,
    the scrollbar parts) are not listed. A layered `!important` beats every later layer's and every unlayered one; the layer is
    first because renders reach only the body; it is anonymous so no guest rule can join it;
  - the renderer takes every `animation*` and `transition*` declaration, prefixed ones included, out of every kept `style`
    attribute, read through the element's own CSSOM declaration and written back as its serialization: an inline `!important`
    beats any layer. Which attributes are read is decided by their text alone: one without `animation`, `transition` or a
    backslash stays as written, and one with a backslash or a declaration of `all` goes whole;
  - the view checks that the sheet is in force (a probe element's inline transition and animation must compute to none). A
    host page whose `style-src` refuses it (neither `'unsafe-inline'` nor its constant hash, API.md "Host page policy") gets a
    view that drops the guest's `<style>` and stylesheet `<link>` elements instead, and one warning with the hash.
  Asserted on all three engines against unlayered `!important`, the guest's own anonymous and named layers, pseudo-elements
  (form-control parts included), `@starting-style`, hover transitions, scroll-driven animations, `@property`, registered
  stylesheets and their `@import`s, SVG `<style>` and `style`.
- **`allowAutoplay`** (strict mode, default `false`; a literal `true` enables it, any other non-boolean is `false` with one
  warning; ignored with a warning in the other modes; part of the equal-config comparison). While `false` the renderer removes
  `autoplay` from every element (only `<video>` and `<audio>` keep it at all).
- **Not removed by the switch** (residuals, README "What strict mode does not cover"): `:hover` restyles over many elements
  while the user's pointer moves (one operation's cost, driven by the user), animated images, indeterminate `<progress>`, and
  autoplaying media with `allowAutoplay: true`.

### Where the view runs

The view (a sandboxed `srcdoc` frame in a sandboxed wrapper) runs on the host page's thread in Firefox (Fission isolates only
cross-site frames; an opaque-origin sandboxed frame is placed with the site that created it), in WebKit and Safari (no site
isolation), on Android (Chromium isolates partially; Android WebView has no out-of-process frames) and in the Chromium
headless shell. Desktop Chromium 127+ runs it in a process of its own (`IsolateSandboxedIframes`; turning the feature off
brings it back). The table is in [API.md](API.md#the-views-cost-to-the-host-page) ([research 16](research/16_view_isolation/README.md)).
So the host-thread residual below is the rule outside desktop Chromium, not an engine detail.

## Probe findings that shaped it

[Research 15](research/15_strict_mode/README.md) measured the design before it was built (P1–P8); each finding set a rule,
labelled A1–A9 where the code and its tests cite them:

| Finding | Rule |
| :--- | :--- |
| P1: the hash-only policy reaches every frame guest markup creates, but their refusals never reach the view; P4: a `<meta http-equiv=refresh>` from a template navigates, and in Chromium a refused view navigation commits an error page that ends the worker; P8: a nested srcdoc's own `<meta name=referrer>` works | **A1**: no nested frames, no `meta`, `base`, `noscript`, `template`, and only minted stylesheet/icon links; `referrerpolicy="no-referrer"` forced |
| P6: `importNode` of template content makes SVG `<script>` fresh: the hashed copy runs | **A2**: move, never clone; a unit test pins it |
| P2: the browser hashes the parsed text (CR → LF, NUL → U+FFFD) | **A3**: refuse CR and NUL; hash the UTF-8; unit test against `crypto.subtle` over the parsed text |
| P7: one 1 MiB apply blocks WebKit's host thread for 1.2–1.6 s; an unacknowledged burst holds Firefox's worker round trip near 1 s | **A4**: one render in flight with acks, a cap on one render, render port closed over |
| P4: Chromium's error page ends view and worker silently | **A5**: link/submit cancellation for every link form, plus a host-side view liveness check |
| P1, P3: created frames report nothing to the view; worker reports go to the worker (Chromium), partly to the view (Firefox, `importScripts`), nowhere (WebKit) | **A6**: G6 scoped to the view; `source: 'logic'` best effort |
| P3: nested blob workers are admitted; WebKit compiles WebAssembly without `'unsafe-eval'` | **A7**: delete `Worker`, `SharedWorker`, `WebAssembly` before guest code (the worker's allowlist omits the first two) |
| P5: a worker-minted `blob:` URL loads in the view; CSP cannot tell whose it is | **A8**: keep only view-minted `blob:` URLs |
| P8: WebKit sends the full host URL to same-site targets when asked | **A9**: S18 filed for cooperative mode; closed here by A1 |

## Alternatives considered

- **The bootstrap in the wrapper, with the view `sandbox=""`.** The view could then run nothing at all, but every render
  would reload a document (no incremental update), events could not be delivered, and the wrapper — which has no script, the
  basis of S10/S11 — would gain one.
- **A nonce instead of a hash.** A nonce in the `<meta>` content is readable through CSS attribute selectors by anything that
  can style the document; the hash is not a secret.
- **`crypto.subtle.digest`.** Asynchronous: building an environment is synchronous end to end, and the lifecycle invariants
  ([ADR-003](ADR-003-lifecycle-and-liveness.md)) rely on it.
- **A build-time constant hash.** The bootstrap is the text of library functions as this page serves them: dev server,
  bundle and a consumer's bundler each produce different text.
- **Rendered frames with a forced `sandbox=""`.** It stops the hashed copy from running (P1), but leaves frames whose
  refusals are silent, nested `<meta>` referrer choices (P8) and meta refresh in nested documents. Removing them all (A1) is
  simpler and closes every one of those.
- **No flow control, a 1 MiB cap and per-frame coalescing in the view.** P7: every queued message is still deserialised on the
  view's thread, the host's in Firefox and WebKit.
- **Detecting a lost view by `frames[0]` identity.** A `WindowProxy` belongs to the browsing context and survives navigation,
  so it does not change when the view is replaced; the liveness ping does detect it.
- **Module workers, `importScripts`.** Either needs a script source beyond the hash; the entry is appended to the worker's
  source on the host instead. Loading the entry as a second script with `importScripts(blob:)` is checked against
  `script-src-elem`, and admitting `blob:` there would admit `<script src=blob:>` in the view.
- **A `data:` URL for the worker.** WebKit then cannot read the worker's own `blob:` URLs (`NotReadableError`), and Chromium
  mutes the errors of a large `data:` worker.
- **Revoking the worker's source URL when the Worker object exists.** WebKit has not read the script yet; it makes every
  `blob:` URL the worker minted unreadable and mutes its error messages. The revocation waits for `VIEW_STARTED`.
- **Default mode's own markup parser for rendering (`DOMParser` on the host).** It would put the host on the render path; the
  view has the document and an inert template parser of its own.
- **Removing `href` from rendered links, or rewriting the element.** See "Links are inert".

## Consequences

Each guarantee is asserted on all three engines: `test/e2e/strict.spec.ts` (the G1 corpus — script, handlers, SVG script,
`javascript:` link, frames at any depth and namespace, the hashed copy, meta refresh, base, links, noscript, templates —
asserted absent; G4 navigation; G2 worker; the entry; A5; files and A8; configuration, fetch bridge, auto-sizing),
`strict-render-flood.spec.ts` (A4), `webrtc.spec.ts`, `watchdog.spec.ts`, `host-url.spec.ts`, `violations.spec.ts`
(section 5), `strict-events.spec.ts`, `broad-strict.spec.ts` (the allowlist corpus and its positive control, the opened URLs,
the fan-out with host lag and the budgets), `verification.spec.ts` (every worker global on the list, every network API of
every engine aimed at a blocked listener), `view-switches.spec.ts` (every vector, the host's ticks with 5 000 animated
elements, the host page's `style-src`, autoplay), `view-budget.spec.ts`, `view-bound.spec.ts`, `owner-decisions.spec.ts`,
`strict-default.spec.ts`, `host-policy.spec.ts`, and the strict cases of `broker`, `lifecycle` and `events.spec.ts`; unit
tests in `src/lib/in-sandbox-view.test.ts`, `src/lib/worker-globals.test.ts`, `src/lib/csp/script-hash.test.ts`,
`src/lib/csp/csp-generator.test.ts`, `test/unit/strict.test.ts`, `test/unit/strict-default.test.ts`,
`test/unit/view-switches.test.ts`, `test/unit/view-api.test.ts`, `test/unit/entry-end-marker.test.ts` and
`test/unit/view-bound.test.ts`.

**What it does not guarantee (residuals):**

- **Rendering cost on the host's thread** wherever the view shares it (Firefox, WebKit, Android, Chromium without
  sandboxed-iframe isolation): each apply is host-thread work there, and so is every CSS animation it leaves running
  (`allowAnimations`). Flow control bounds it to one apply at a time, the budgets bound the common cases, but what laying out
  and painting it costs is not bounded: CSS is not read by the renderer, and a filter list on many elements costs their
  product (S42, accepted). Strict mode protects confidentiality and egress; the host page's availability is not protected
  wherever the view shares the host's thread, and cooperative mode is no better there. The bound and the list of what is
  outside it are in [API.md, "The view's cost to the host page"](API.md#the-views-cost-to-the-host-page). The watchdog does
  not count host stalls against the guest; the bound on termination is the budget plus one apply.
- **CSS exfiltration** within the policy (style-based probing of the view's own content, requests to allowed origins); the
  policy governs it.
- **Worker reports** are per engine: WebKit raises no violations in workers, Firefox raises the worker's `importScripts`
  refusals in the view (they arrive as `source: 'view'`).
- **A worker that ends itself** (`close()`) or crashes is detected only by the opt-in watchdog.
- **Memory, timing side channels, UI spoofing** inside the element's box, and same-site cookies on requests to allowed origins
  (every mode).
- **Programming model.** No inline guest `<script>`, no nested frames, no `srcset`/`style` file references, no module graph;
  UI updates are whole-subtree renders and coarse events.

### Revisit if

- a platform primitive makes created frames governable from their parent (then nested frames could return);
- `ShadowRealm` or a reliable out-of-process view lands in Firefox and WebKit (the host-thread residual, S42);
- a logic tier such as a QuickJS worker is adopted ([ADR-001](ADR-001-continue-or-adopt.md)): the view and render protocol
  stay.

History: [the amendments to this decision](archive/adr/ADR-005-history.md).
