# API reference

The complete public surface of `web-sandbox`: the element, its configuration, methods and events, and the
globals the guest gets in each mode. For an overview start with the [README](../README.md); for why each part
is built the way it is, follow the links to the decision records (ADRs); for what the sandbox defends and what it
leaves to you, read the [threat model](THREAT-MODEL.md).

- [Registering the element](#registering-the-element)
- [The element](#the-element)
- [Configuration](#configuration)
- [Methods](#methods)
- [Events](#events)
- [Lifecycle](#lifecycle)
- [Refusal codes](#refusal-codes)
- [Guest globals](#guest-globals)
- [Modes](#modes)
- [Building an app in sealed mode](#building-an-app-in-sealed-mode)
- [Limits](#limits)
- [The view's cost to the host page](#the-views-cost-to-the-host-page)
- [Host page policy](#host-page-policy)
- [Exports](#exports)
- [Examples](#examples)

---

## Registering the element

<!-- describes: api:defineWebSandbox sig:8e1b -->
```ts
import { defineWebSandbox } from 'web-sandbox';

defineWebSandbox();                  // <web-sandbox>
defineWebSandbox('my-sandbox');      // or a tag name of your own (instead, not as well)
```

<!-- generated:begin api-define -->
```ts
function defineWebSandbox(tagName?: string): typeof WebSandbox
```

Registers `WebSandbox` as a custom element under `tagName` and returns the class. Importing the package
registers nothing, so you pick the name. Calling it again with the same name does nothing.

**Parameters**

- `tagName`: The tag name; `'web-sandbox'` when left out. The class can be registered under one name only.

**Returns:** The `WebSandbox` class.

**Throws:** An `Error` if the name is already defined by another element; the browser's `NotSupportedError` for a second,
different name of this class, and its `SyntaxError` for a name that is not a valid custom element name.
<!-- generated:end -->

---

## The element

<!-- describes: api:WebSandbox sig:bfdf -->
The element has no observed attributes; everything is set through [`setConfig()`](#setconfigconfig) and the
other methods. It has one property:

<!-- generated:begin api-element -->
| Property | Type | Description |
| :--- | :--- | :--- |
| `state` | `'idle' \| 'loading' \| 'ready' \| 'terminated'` (read-only) | Where the element is in its lifecycle (`SandboxState`). It already has the new value when `ready` or `terminated` is dispatched. |
<!-- generated:end -->

The frame lives in an open shadow root and fills the element (`width: 100%; height: 100%`). The element is a block
(`:host { display: block }`, a constructed stylesheet your page's `style-src` does not govern; your own CSS for the
element wins); give it a height:

```css
web-sandbox { height: 320px; }
```

With [`autoResize`](#configuration) the element sets its own `style.height`, and gives your inline height back when a
later build turns auto-sizing off. In worker mode the frame is hidden (`display: none`).

TypeScript: `document.createElement('web-sandbox')` is a `WebSandbox`, and `addEventListener` types each event's
`detail` (`WebSandboxEventMap`).

The element builds an environment only in the document of the window that defined it. Moved into another document
(`adoptNode()`, an iframe's document), it tears its environment down and stays `idle` there, with one warning; moved
back, it builds again. Its methods work there as anywhere (in every engine): `reset()`, `load()` and `setConfig()` keep
what they are given for its return and build nothing, calls reject at once with `TERMINATED`.

The guest can post messages to the host page's window (any frame can; it reaches your own `message` listeners).
Act on a message only from a sender you know, by `event.source`, never by the message's shape. Do not give host
windows or frames names that host links, forms or `window.open()` target: a frame the guest creates can take such a
name (the guest's own frame cannot; its `window.name` is inert).

---

## Configuration

<!-- describes: options, capabilities, api:SandboxConfig, api:SandboxConfigOptions, api:StrictSandboxConfig, api:CooperativeSandboxConfig, api:WorkerSandboxConfig, api:SealedSandboxConfig, api:NetworkSandboxOptions sig:2daf5a254f4fbd6cdaecf42e3088af61cb46 -->
[`setConfig(config)`](#setconfigconfig) takes a `SandboxConfig`, a union keyed by `mode` (`StrictSandboxConfig`,
`SealedSandboxConfig`, `CooperativeSandboxConfig`, `WorkerSandboxConfig`, each extending `SandboxConfigOptions`, the
options every mode takes; all but `SealedSandboxConfig` also extend `NetworkSandboxOptions`, the options that open the
network: `origins` and `fetchBridge`): strict mode's `origins` has no `scripts`, a sealed config has no `origins` and no
`fetchBridge`, and a config without `mode` is a sealed config (sealed mode is the default; strict mode is named with
`mode: 'strict'`, so `{ origins }` without it does not type-check). How a call is applied (over the defaults, copied,
validated, and what a config that cannot be used does) is under [`setConfig()`](#setconfigconfig) below.

- `SandboxConfig` narrows each mode: `entry`, `allowAnimations` and `allowAutoplay` only in strict and sealed mode, `workerExecutionTimeout` not in cooperative mode,
  `html` and `autoResize` not in worker mode, `unsafeCapabilities` not in strict or sealed mode, `origins` and
  `fetchBridge` not in sealed mode. A config from JSON is held to the same rules at run time: an option outside its
  modes (the Modes column) is ignored and takes its default, with one warning for `entry`, `allowAnimations`,
  `allowAutoplay`, `unsafeCapabilities` and `autoResize`, silently for `html` and `workerExecutionTimeout`.
- A sealed config that names `origins` or `fetchBridge` (with any value but `undefined`), with `mode: 'sealed'` written
  or with no `mode`, is not ignored but refused, since either would open the network the mode does not have: nothing of
  it is applied, and the sandbox terminates with the reason
  `` origins and fetchBridge open the network, which sealed mode (the default) does not have: set `mode: 'strict'` ``
  ([`terminated` reasons](#terminated-reasons)), as it does for a `mode` that is not one. It is never read as strict mode
  and never stripped: one key would otherwise change the mode, or lose the network an app relies on, silently.
- Each option's default, accepted values, bounds, warnings and modes are declared once (`src/lib/config-schema.ts`), and
  so are the checks across options, which hold for every config: every call that `callLimits` can carry fits an empty
  window ([below](#calllimits)); a `fetchBridge` response of `maxBytes` fits one call result; a `fetchBridge` request
  body of `maxBytes` bytes (a string body is measured at two bytes a character, so a string above about 16.5 MiB is refused
  by the guest's broker: [S70](BACKLOG.md#s70)), and a guest write of the whole file quota, fit one call, unless a `maxBytesPerSecond` below
  `RPC_MAX_BYTES` caps calls, which it says once. `watchdogTimeout` and `workerExecutionTimeout` are independent: either
  may be the shorter.

<!-- generated:begin configuration -->
| Option | Type | Default | Modes | What it does |
| :--- | :--- | :--- | :--- | :--- |
| `mode` | `'strict' \| 'sealed' \| 'cooperative' \| 'worker'` | `'sealed'` | — | Where guest code runs; see [Modes](#modes). `'sealed'`, the default, is strict mode with no network: a sealed config that names `origins` or `fetchBridge`, with the mode written or left out, is refused, and the sandbox terminates with the reason `` origins and fetchBridge open the network, which sealed mode (the default) does not have: set `mode: 'strict'` ``. To open the network, name `mode: 'strict'`. Any other value starts no environment: the sandbox terminates with the reason `unknown mode …` until a valid mode is configured. `'iframe'` was renamed `'cooperative'`: refused the same way, and the reason says so. |
| `html` | `string` | `''` | strict, sealed, cooperative | The initial view (strict and sealed mode) or the guest document (cooperative mode). In strict and sealed mode its `<script>` elements and `on…` handler attributes never run, and markup that holds any warns once per element: ``sealed mode (the default) runs no script in `html`; …`` (in strict mode ``strict mode runs no script in `html`; …``). Empty means `<div id="root"></div>`. Ignored in worker mode. Also set by [`load()`](#loadhtml). |
| `capabilities` | `SafeCapability[]` | `[]` | all | Sandbox flags that keep the guest inside the frame: `allow-orientation-lock`, `allow-scripts`. Anything else is dropped with a warning. Worker mode always adds `allow-scripts`; strict and sealed mode always have `allow-scripts allow-forms` (listing either there changes nothing). |
| `unsafeCapabilities` | `UnsafeCapability[]` | `[]` | cooperative, worker | Capabilities that act outside the frame: `allow-downloads`, `allow-forms`, `allow-modals`, `allow-pointer-lock`, `allow-popups`, `allow-presentation`, `fullscreen`. Each one enabled warns once. `allow-forms` lets guest forms submit: `form-action 'none'` refuses the submission inside the frame, but one opened in a new tab by a modifier click (the user's, or one the guest's script synthesizes) is not checked against it in Chromium. `allow-pointer-lock` and `fullscreen` let a guest hide the cursor, capture relative input or draw over the whole screen, so each can imitate host or browser UI. `fullscreen` is granted as `allow="fullscreen *"` (a Permissions Policy feature), the rest as sandbox flags. Dropped with a warning in strict and sealed mode. Without `allow-popups` guest code opens no window, but in cooperative mode the user's own Ctrl-, Shift- or middle-click, or Ctrl/Shift+Enter, on a guest link opens it in a new tab in Chromium and Firefox (platform behaviour of any sandboxed frame; see [Modes](#modes)). On Chromium the sandbox's frame is credentialless, so a popup that `allow-popups` lets the guest open has no opener: the guest's `window.open()` returns `null`, though the page opens. |
| `scriptUnsafe` | `boolean` | `false` | all | Only a literal `true` enables it. Adds `'unsafe-eval'` to the guest policy (strings run as code; WebAssembly too) and enables [`execute()`](#executecode). For testing; warns once per element. |
| `origins` | `SandboxOrigins` | none | strict, cooperative, worker (strict: no `scripts`) | The exact origins the guest may load each kind from: connections, images, styles, fonts, media, scripts. Not in sealed mode: a sealed config that names it is refused. See [below](#origins). |
| `hostContentSecurityPolicy` | `string \| false` | none: `origins.connect` and `fetchBridge.allow` are dropped | all | Your page's Content-Security-Policy as text (one or more policies, as a header or `<meta>` carries them), so that the library drops the `origins.connect` and `fetchBridge.allow` entries it refuses, on every engine; `false` when your page sends none. Left out, every `origins.connect` and `fetchBridge.allow` entry is dropped, with one warning: the library never asks the page for its policy. A browser without Trusted Types (Firefox) applies your page's `require-trusted-types-for` and `trusted-types` only from the text you pass ([Trusted Types without the browser](#trusted-types-without-the-browser)). See [Host page policy](#host-page-policy). |
| `entry` | `string` | none | strict, sealed | The path of a registered JavaScript file the worker runs first. Ignored with a warning in other modes. If it is not a registered JavaScript file the sandbox terminates (`the guest entry "…" is not a registered JavaScript file`). |
| `watchdogTimeout` | `number` (ms) | `0` (off) | all | Terminates a guest that stops answering for this long (`the guest stopped responding (watchdog)`). Anything but a finite number `> 0` is off, with a warning unless it is `0`. Bounds a looping guest in strict, sealed and worker mode on every browser, and in cooperative mode only where the browser runs the frame in its own process. Starts at `ready`, so it covers the guest's startup scripts too. Needs the guest bootstrap to run. [ADR-003](ADR-003-lifecycle-and-liveness.md) |
| `workerExecutionTimeout` | `number` (ms) | `0` (off) | strict, sealed, worker | A deadline for each `execute()`, this long after the element posts the code, at which the guest's event loop must be free: the element pings the guest, and if no answer arrives within `EXECUTION_TIMEOUT_GRACE_MS` the sandbox ends: a `sandbox-log` line `Execution Timeout` (`source: 'host'`), then `terminated` with `the executed code ran longer than workerExecutionTimeout`. See [`execute()`](#executecode). Anything but a finite number `> 0` is off, with a warning unless it is `0`. |
| `autoResize` | `boolean` | `false` | strict, sealed, cooperative | Only a literal `true` enables it. The element's height follows the guest's content height, from `ready` on (the guest document may still be loading then); see [Limits](#limits) for the bounds. In worker mode it does nothing, with one warning. Without it, the height is left to your CSS. |
| `fetchBridge` | `FetchBridgeConfig` | off | strict, cooperative, worker | Opens [`sandboxFetch()`](#sandboxfetch); the host decides each request, and a hidden frame with an opaque origin makes it (the target sees `Origin: null`). A config without it turns the bridge off (`sandboxFetch()` rejects with `FETCH_NOT_ALLOWED`). Not in sealed mode: a sealed config that names it is refused. [ADR-006](ADR-006-fetch-bridge.md) |
| `callLimits` | `CallLimits` | 1000 calls and 64 MiB per second | all | The per-second budget of the calls the guest makes, per environment; see [below](#calllimits). |
| `allowAnimations` | `boolean` | `false` | strict, sealed | Whether CSS animations and transitions run in the view. **While `true`, they run on your page's main thread wherever the browser runs the view there (Firefox, Safari and WebKit, Android, Chromium without sandboxed-iframe isolation), and the view's time budget does not bound them: a guest can keep your page 80–98% busy.** `false` removes them (elements show their end state). Only a literal `true` keeps them: left out or `false` removes them, and so does any other value, with one warning when it is not a boolean. Ignored with a warning in other modes. See [below](#allowanimations-and-allowautoplay). |
| `allowAutoplay` | `boolean` | `false` | strict, sealed | Whether `<video autoplay>` and `<audio autoplay>` in the view start on their own; while `false` the `autoplay` attribute is removed and media plays only when the user starts it. With `true`, playing media costs your page's main thread where the view shares it (measured up to +6 points for 20 looping videos), outside the time budget. Only a literal `true` enables it: left out or `false` keeps it off, and so does any other value, with one warning when it is not a boolean. Ignored with a warning in other modes. See [below](#allowanimations-and-allowautoplay). |
| `guestWrites` | `boolean` | `false` | all | Only a literal `true` enables it. The guest's [`sandboxFiles.write()` and `remove()`](#sandboxfiles) are recorded by the element as pending changes of this environment; they reach the files only through [`commitGuestWrites()`](#commitguestwritespaths-options). See [Guest writes](#guest-writes). |
<!-- generated:end -->

### `origins`

<!-- describes: origins, cookie-facts, csp:cooperative, csp:strict, api:SandboxOrigins, api:StrictSandboxOrigins sig:d26274f1099fbb86493659f5 -->
The guest's policy is one fixed template per mode. `origins` adds exact origins to six of its directives, one list per
kind of load, and can change nothing else. Sealed mode, the default, takes none: name the mode that does.

```js
sandbox.setConfig({ mode: 'strict', origins: { connect: ['https://api.example.com'], images: ['https://cdn.example.com'] } });
```

| Kind | Directive | What loads from it |
| :--- | :--- | :--- |
| `connect` | `connect-src` | `fetch()`, `XMLHttpRequest` and, in cooperative and worker mode, `WebSocket` (it needs its own `wss://` entry), each through the library's [request gate](#the-request-gate). Strict mode opens [no `WebSocket`](#strict-no-websocket). In cooperative mode also `EventSource` and `sendBeacon()`, which the browser's policy alone governs; the worker of strict and worker mode has neither. |
| `images` | `img-src` | Images, CSS backgrounds, icons. In strict mode `<img>`, `srcset` and `<picture>` only, which the origin must answer with CORS ([below](#the-views-loads)). |
| `styles` | `style-src` | Stylesheets: `<link rel=stylesheet>`, `@import`. Inline styles are always allowed. In strict mode nothing loads from it ([below](#the-views-loads)). |
| `fonts` | `font-src` | `@font-face` fonts. In strict mode nothing loads from it ([below](#the-views-loads)). |
| `media` | `media-src` | Audio, video, text tracks. In strict mode the origin must answer with CORS ([below](#the-views-loads)). |
| `scripts` | `script-src` | `<script src>`, modules, `importScripts()`. Not in strict mode. |

- **An entry is one exact origin**, `https://host[:port]`; in `connect`, in cooperative and worker mode, also
  `wss://host[:port]`; plain `http://` only for `localhost` and `127.0.0.1` (local development). A request to the `http:` or `ws:` form of a listed `https:` or `wss:`
  origin is refused by every engine: no policy of the library carries `upgrade-insecure-requests`, so nothing is upgraded
  and nothing is sent in cleartext. Case is folded and a default port dropped. The host must be written as it is meant: no IPv6 literal (a
  policy cannot name one), IPv4 shorthand, percent-encoding, non-ASCII name (write its `xn--` form) or trailing dot.
  An `xn--` label is checked by the browser's own URL parser, and engines differ on invalid Punycode: one that an engine
  refuses is dropped there, so write the form your registrar gives.
- **A scheme is matched as written, and a `wss://` entry needs its `https://` twin** (cooperative and worker mode).
  `https://api.example.com` alone admits `fetch()` and `XMLHttpRequest` to the host and no `WebSocket`. A
  `wss://api.example.com` entry is dropped with a warning unless `https://api.example.com` (the same host and port) is
  listed too; with both, `fetch()` and `WebSocket` reach the host. It is the same on every engine: they disagree on a
  `wss://` source alone (see [the engines](#connect-src-by-engine)), so the library lists only the pairs they agree on.
- <a id="strict-no-websocket"></a>**Strict mode opens no `WebSocket`, on any engine.** A handshake carries the cookies
  the browser attaches by site, which nothing can strip, so in strict mode a `wss://` entry of `connect` is dropped with
  one warning per entry, and the request gate refuses every `new WebSocket()`, a listed origin's too, with a
  `SecurityError` (`refused by the sandbox: strict mode opens no WebSocket`) and its own
  [`violation`](#violation--sandboxviolation) report, as below. What takes its place:
  - **A streamed `fetch()` response.** The worker reads `response.body` as it arrives (`getReader()`), chunk by chunk, on
    every engine (`test/e2e/request-gate.spec.ts`), so a server that pushes events over one long response (server-sent
    events' format, or lines of JSON) reaches the guest through `fetch()`, without credentials. Send to the server with
    further `fetch()` requests.
  - **A socket your page opens.** Open the `WebSocket` in the host page, with the credentials it needs there, and relay
    what the guest may see with [`expose()`](#exposename-fn) and [`call()`](#callmethod-args): your page decides what
    crosses, and the guest never holds the socket.
- <a id="the-request-gate"></a>**The request gate: `fetch()`, `XMLHttpRequest` and `WebSocket` behave and report the same on
  every engine.** In every mode the guest's three request makers are the library's, put in its realm before any guest
  code runs. Each request's URL is resolved as the browser resolves it and admitted only when its scheme, host and port
  are exactly those of a `connect-src` source of the guest policy (the `connect` origins as kept, and `blob:` when files
  are registered), which is the list the policy is written from; in strict mode a `WebSocket` is never admitted. A
  refused request never reaches the browser: `fetch()`
  rejects with a `TypeError`, an `XMLHttpRequest` fails as a network error does (`loadstart`, then `readystatechange`,
  `error` and `loadend` with `readyState` 4 and `status` 0; a synchronous `send()` throws a `NetworkError`), and
  `new WebSocket()` throws a `SecurityError`, each with the library's own message. The library reports each one itself, as
  a [`violation`](#violation--sandboxviolation): `directive` `'connect-src'`, `blockedURI` the URL without credentials
  or fragment, `sourceFile` `'web-sandbox:request-gate'`, no line or column, and in strict mode `source` `'logic'`. So a
  refusal is reported on WebKit too, which raises no report in a worker. The browser's policy stays in force underneath:
  a redirect to an origin it refuses is refused and reported by the browser, per engine. The guest cannot reach the
  browser's own `fetch`, `XMLHttpRequest` or `WebSocket` (not through a prototype, a `constructor`, `Function` or a frame
  it creates); a frame or a worker it creates is a realm of its own, with the browser's request makers under the same
  policy, and reports nothing here.
- **`fetch()` and `XMLHttpRequest` send no credentials, on any engine.** Every `fetch()` is made with
  `credentials: 'omit'`, whatever the guest asks for, and `withCredentials` stays `false`. In cooperative and worker
  mode a `WebSocket` handshake cannot be stripped: it carries the cookies the engine attaches
  ([table below](#cookies-by-engine)), and so does, in cooperative mode, a load of the guest's markup or CSS. A server
  behind a listed `wss://` origin must check the `Origin` header (a sandbox sends `null`), as any WebSocket server must.
  **No request of strict mode carries a cookie, on any engine**: its worker's `fetch()` and `XMLHttpRequest` send none,
  it opens no `WebSocket`, and its view loads without credentials (below).
- <a id="the-views-loads"></a>**Strict mode's view loads without credentials, on every engine, so a listed `images` or
  `media` origin must answer with CORS.** The renderer gives every `<img>`, `<video>`, `<audio>` and `<link>` it keeps
  `crossorigin="anonymous"` before the element enters the document (the guest's own value, `use-credentials` included,
  is replaced), so each of their loads (`src`, `srcset`, a `<picture>`'s `<source>`, a media element's `<source>` and
  `<track>`) is a CORS request with no cookie of any kind, no HTTP authentication and `Origin: null`. The origin must
  answer `Access-Control-Allow-Origin: *` (or `null`); for media WebKit also needs `206` answers to `Range` requests,
  which a seek uses. A load that fails (no `Access-Control-Allow-Origin`, or a missing or undecodable file: the page
  cannot tell which) is reported as a [`violation`](#violation--sandboxviolation) with the directive of its kind
  (`img-src`, `media-src`) and its URL, within the view's cap. The loads no attribute reaches are dropped before
  insertion: a `poster` with an `https:` or `http:` URL (one engine fetches a poster without CORS, whatever the video says;
  a registered file stays), and every `https:` or `http:` URL in CSS (`url()`, `@import`, `image-set()`, `@font-face`
  `src`, any string that holds one), in a `style` attribute, a `<style>` or text set into one, each reported as a
  `violation` of its directive (`img-src`, `style-src`, `font-src`). A registered stylesheet reaches the view without its
  network URLs as well, with one warning per file (its references to registered files stay; one that is not UTF-8, or
  whose `@charset` names another encoding, gets no URL in the view). So nothing loads from `styles` or `fonts` in strict
  mode: register the stylesheets and fonts the guest needs. The rule has no exception, per origin or otherwise: an
  asset whose server does not answer with CORS is either made to answer it (`Access-Control-Allow-Origin: *`), or
  fetched by your page and [registered as a file](#registerfilesfiles), which the view shows from a `blob:` URL.
  Cooperative mode is unchanged: the guest's document makes its own loads, with the cookies the engine attaches.
- **The host page's `connect-src` narrows `connect` and the bridge's `allow` on every engine.** The library applies your
  page's policy to the two lists itself, before it writes the guest's and the bridge's policies: an origin your
  `connect-src` (or `default-src`) does not admit is dropped with a warning. It takes your policy from
  `hostContentSecurityPolicy` alone, and without that option drops both lists: see [Your `connect-src`](#your-connect-src).
- **Anything else is dropped** with one warning per entry: `https:` and other schemes, `*` and `*.example.com`,
  `'self'` and every other keyword, `data:`, `blob:`, paths, queries, credentials, whitespace, `;`. Dropping only
  narrows: a kind left with no origin admits none (`'none'`). A key that is not a kind is dropped with a warning.
- **An origin on the host page's site is dropped in every mode**, with one warning per kind that names the kind and each
  such origin. A WebSocket handshake in cooperative or worker mode, or in cooperative mode a load of the guest's markup
  or CSS, to it can carry the host site's cookies, as the [table below](#cookies-by-engine) says, so use
  [`fetchBridge`](#fetchbridge) for an API that knows the user: it sends no credentials in any engine.
- **The host page's site is the site of every origin a browser may decide a request's site from**: the page's own
  origin (`self.origin` of the realm the element runs in, so an element in a same-origin `srcdoc` or `about:blank` frame
  has its page's origin, as its cookies do), the origin of its top-level URL when the page is the top-level document, and
  the origin of every page that frames it (`location.ancestorOrigins`, or each ancestor's `origin` read up `parent`).
  An entry on the site of any of them is dropped. So a page framed by another site's page cannot list that site, and a
  page served with `Content-Security-Policy: sandbox` cannot list its URL's site. Each engine's part is in the
  [table below](#host-site-by-engine).
- **The site of an origin is decided by one rule, with no probe and no public-suffix list.** For a host name of two
  labels or more, an entry is on the site when its host is that host or shares its last two labels: for a page on
  `app.example.com`, the page's own origin on any scheme or port, `api.example.com`, `deep.api.example.com` and
  `example.com`. A registrable domain always has at least two labels, so the rule never misses an origin the browser
  counts as on the site; under a public suffix of several labels it also refuses other sites (`bob.github.io` from a
  page on `alice.github.io`, `other.co.uk` from `www.example.co.uk`), and the warning says so. Reach such an origin with
  [`fetchBridge`](#fetchbridge), which sends no credentials. For an IP address, `localhost` or any other single-label
  host, only that host is on the site.
- **Where the host page's site cannot be decided, every entry a cookie-carrying request can reach is dropped as well**,
  with one warning per kind that names each entry (`the host page's site is undecided`), says why, and names the
  requests. The site is undecided when one of the origins above is opaque (a page served with
  `Content-Security-Policy: sandbox`, one inside `<iframe sandbox>`, or a page under such a page) or cannot be read (a
  page of another origin above the host page, on an engine without `location.ancestorOrigins`). The entries are those
  the [requests below the table](#cookie-carriers) can reach in the mode, as the [table below](#host-site-by-engine)
  lists them by mode; strict mode, whose requests carry no cookie, has none. Entries on the site of an origin that can
  be read are dropped as on the site, in every mode.
- **A loopback, private or link-local host is kept only when the host page is itself on one**: `localhost`, `127.0.0.1`,
  `10.x`, `192.168.x`, `169.254.x`, or a name that is private by convention (a single label such as `intranet`, and
  `*.local`, `*.internal` such as `host.docker.internal`, `*.lan`, `*.home.arpa`, `*.localdomain`, `*.corp`, `*.home`,
  `*.intranet`). It is the user's own machine or network, which the guest then reaches, and the engines differ on whether
  a page of the public web may do that, so on any other page such an entry (in `origins` and in `fetchBridge.allow`) is
  dropped with one warning per kind. On a page that is on one it is kept, with that warning, in every mode. A name that
  only resolves to a private address, and is not private by convention, is not recognised.

<a id="cookies-by-engine"></a>
The cookies the browser would send with a request of the sandbox that the library cannot strip, by engine, for the
requests [listed below the table](#cookie-carriers) (`fetch()`, `XMLHttpRequest` and every request of strict mode carry
none, on any engine; this is why an origin on the host page's site is dropped; the warning is written from the same
table; every wrapper frame is `credentialless`, which only some engines honour). The host page's site is that of its
origin, of its top-level URL and of every page that frames it ([below](#host-site-by-engine)):

<!-- generated:begin cookie-facts -->
| Engine | To an origin on the host page's site | To an origin on another site | Narrower with | Found by |
| :--- | :--- | :--- | :--- | :--- |
| Chromium (the sandbox's frame is credentialless) | none | none | — | test/e2e/cookies.spec.ts: a listener of the same site and one of another, fetch with credentials, a no-cors POST and an image, in every mode; the same requests from a frame without the attribute carry the cookie |
| Firefox | `SameSite=None` | `SameSite=None` | Total Cookie Protection, Firefox's default: none to the host page's site, none to another | S74 board, 2026-10-21, Playwright's Firefox (cookieBehavior 4): a SameSite=None cookie in every mode, Lax and Strict none; with cookieBehavior 5 none. The WebSocket handshake to another site: test/e2e/request-gate.spec.ts, 2026-10-23 |
| WebKit | `SameSite=None, Lax and Strict` | `SameSite=None` | Safari, which blocks third-party cookies (not measured): `SameSite=None, Lax and Strict` to the host page's site, none to another | S74 board, 2026-10-21, Playwright's WebKit: None, Lax and Strict to a same-site origin and None to another site, in every mode. The WebSocket handshake to another site: test/e2e/request-gate.spec.ts, 2026-10-23 |
<!-- generated:end -->

<a id="host-site-by-engine"></a>
**The host page's site, by engine**, and what is dropped where it cannot be decided:

<!-- generated:begin host-site-facts -->
The host page's site is the site of its own origin, of its top-level URL and of every page that frames it: an engine may decide a request's site from any of them (Chromium: not measured: it sends no cookie with a request of the sandbox; Firefox: not measured: in every layout it sends `SameSite=None` only, as to any third party; WebKit: the top-level document's URL, whatever the host page's own origin). An `origins` entry on it is dropped in every mode. Where one of those origins is opaque (a sandboxed document) or cannot be read (a page of another origin above the host page, on an engine without `location.ancestorOrigins`: Firefox), the site is undecided, and every entry that such a request can reach in the mode is dropped as well, with a warning that says why: the `wss://` entries of `connect` in worker mode, every entry in cooperative mode, none in strict mode.

| Engine | A request's site is decided from | A host page framed by another origin | Found by |
| :--- | :--- | :--- | :--- |
| Chromium | not measured: it sends no cookie with a request of the sandbox | decided: its ancestors' origins come from `location.ancestorOrigins` (an opaque one leaves it undecided) | test/e2e/host-site-layouts.spec.ts: no cookie on a request of the guest in any layout |
| Firefox | not measured: in every layout it sends `SameSite=None` only, as to any third party | undecided (no `location.ancestorOrigins`): dropped as well, the `wss://` entries of `connect` in worker mode, every entry in cooperative mode | S74 board, BD4:ISO-1 and BD4:ISO-3, 2026-10-24, Playwright's Firefox: a host page whose origin is opaque, one in a sandboxed frame and one framed by another site send what a third-party page sends; test/e2e/host-site-layouts.spec.ts: no Lax or Strict cookie in any layout |
| WebKit | the top-level document's URL, whatever the host page's own origin | decided: its ancestors' origins come from `location.ancestorOrigins` (an opaque one leaves it undecided) | S74 board, BD4:ISO-1 and BD4:ISO-3, 2026-10-24, Playwright's WebKit: a request to the top-level URL's site carries its `SameSite=None, Lax and Strict` cookies from a host page whose origin is opaque and from one framed by that site; test/e2e/host-site-layouts.spec.ts: a plain sandboxed frame's handshake carries them, the guest's none |
<!-- generated:end -->

<a id="cookie-carriers"></a>
The requests that carry them (`COOKIE_CARRIERS`), and the modes in which the guest can make each: none in strict mode.
The library's [request gate](#the-request-gate) covers the guest's `fetch()`, `XMLHttpRequest` and `WebSocket`; every
other maker of a request is the browser's, and in cooperative mode the guest has all of them. Each row is made on
every engine by `test/e2e/cookies.spec.ts` or `test/e2e/request-gate.spec.ts`:

<!-- generated:begin cookie-carriers -->
| Request | Where | Why the library cannot strip it |
| :--- | :--- | :--- |
| A WebSocket handshake | cooperative and worker mode | The browser makes the handshake and attaches the cookies by site; the gate can refuse it, not strip it, so a server behind a listed `wss://` origin must check `Origin`. Strict mode opens none: its gate refuses every `WebSocket`, and its `origins.connect` keeps no `wss://` entry |
| A load of the guest's markup or CSS (an image, a stylesheet, a font, media) | cooperative mode only | The engine makes the load for the document that holds it. Strict mode's view makes each of its loads without credentials (`crossorigin="anonymous"`; no network URL in CSS or a poster) |
| A `navigator.sendBeacon(url, data)` call | cooperative mode only | A credentialed POST. The gate covers `fetch()`, `XMLHttpRequest` and `WebSocket`; this maker is not among them, and the strict and worker-mode worker has none |
| An `EventSource` made with `{ withCredentials: true }` | cooperative mode only | The guest chooses `withCredentials`; the gate does not cover `EventSource`, and the strict and worker-mode worker has none |
| An `<a ping>` click | cooperative mode only | A POST made by the browser when the link is followed; Firefox sends no ping by default (Firefox sends none) |
| A request of a frame or worker the guest creates (its own `fetch()` with `credentials: 'include'`) | cooperative mode only | A realm of its own with the platform's `fetch`: a limit of cooperative mode (S44) |
<!-- generated:end -->

The browser may attach credentials that are not cookies to these requests when it holds them for the origin: cached HTTP
authentication (Basic, Digest, integrated Windows or Kerberos) and a TLS client certificate. The tables do not state what
each engine sends (not measured), so do not list an origin for a guest that it recognises the user by. The guest's
`fetch()` and `XMLHttpRequest` through the gate, and the [fetch bridge](#fetchbridge), send none of these
(`credentials: 'omit'`).

- **Refused**: an `origins` that is not an object, or a kind that is not a list: the configuration could not be used, and
  the reason names the option (`(TypeError: origins.connect is not a list)`).
- **Strict mode has no `scripts`**: a type error in TypeScript (`SandboxConfig` is a union keyed by `mode`), and dropped
  with one warning at run time, for a config from JSON. With a mode chosen at run time, type `origins` as
  `StrictSandboxOrigins`.
- **Registered files** add `blob:` to the directive of each kind of load their types are for (JavaScript: `scripts`;
  `text/css`: `styles`; `image/*`: `images`; `font/*`: `fonts`; `audio/*`, `video/*`, `text/vtt`: `media`; every
  file: `connect`), whatever `origins` lists. Strict mode never adds it to `script-src`, and with `guestWrites` adds it
  to `img-src` (the view shows the raster images the guest writes).
- **`'unsafe-eval'`** is added to `script-src` by `scriptUnsafe` only.
- A `connectionsAllowed` key is ignored, with one warning: the policy is built from `origins` alone.

Every directive is always emitted (`'none'` when it admits nothing), so no browser falls back to `default-src`. With no
origins and no files, cooperative and worker mode get:

<!-- generated:begin csp-cooperative -->
```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none';
media-src 'none'; connect-src 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none';
form-action 'none'; manifest-src 'none'
```
<!-- generated:end -->

`'unsafe-inline'` in `script-src` admits inline scripts: the library's bootstrap is one, and it always runs. Strict
mode's view (its worker inherits it), where `<bootstrap>` is the hash of the library's one view script:

<!-- generated:begin csp-strict -->
```
default-src 'none'; script-src 'sha256-<bootstrap>'; script-src-attr 'none'; style-src 'unsafe-inline';
img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; worker-src blob:; frame-src 'none';
object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'
```
<!-- generated:end -->

[ADR-007](ADR-007-typed-origins.md)

### `fetchBridge`

<!-- generated:begin api-fetch-bridge -->
The `fetchBridge` option: what `sandboxFetch()` in the guest may reach. Only `allow` is required.

The host decides every request, and a hidden frame of the library's with an opaque origin makes it, never the host
page: the host page's Service Worker and any wrapper of its `fetch` never see it. So the target sees `Origin: null`,
and its CORS must allow that: `Access-Control-Allow-Origin: *` or `null`, for public data only. Every sandboxed frame
on the web, an attacker's too, has the origin `null`: a target must never pair it with
`Access-Control-Allow-Credentials: true` or treat `null` as trusted. The bridge itself sends no credentials (no cookies,
no HTTP authentication), so it gets what any anonymous page gets. Every request is pinned to no credentials, no
`Referer`, no redirects (refused with `FETCH_REDIRECT`) and `cache: 'no-store'`. The frame runs the same hashed
bootstrap as the strict view, under the same hash, so a host page policy that admits the sandbox admits it, and one
that refuses the view refuses it too (strict mode then ends with the startup reason). A frame that fails to start
alone fails the bridge closed and leaves the sandbox running ([Host page policy](#host-page-policy)). The host page's own origin and loopback, private and link-local hosts are refused
unless listed. A listed public name that resolves to a private address cannot be detected
from a page. A number that is not finite or is below 1 takes its default, and one above its bound takes the bound.
See [ADR-006](ADR-006-fetch-bridge.md).

| Field | Type | Default | What it does |
| :--- | :--- | :--- | :--- |
| `allow` | `string[]` | (required) | The exact origins the guest may reach: scheme, host and optional port, like `https://api.example` or `http://localhost:8080`. An entry with a path, query, fragment, credentials or `*` is dropped with a warning, and so is a value that is not a list. An empty list refuses everything. Listing the host page's own origin or a loopback, private or link-local host works, with one warning each. The host page's `connect-src`, as `hostContentSecurityPolicy` gives it, narrows the list on every engine: an origin it does not admit by its scheme and host (`'self'` admits nothing) is dropped with a warning; without that option the whole list is dropped ([Your connect src](#your-connect-src)). |
| `maxBytes` | `number` | `1048576` (1 MiB) | Most bytes of one response body, and of one request body. At most `33554432` (32 MiB). |
| `timeoutMs` | `number` | `10000` | Most ms for one request, response body included. At most `120000`. |
| `methods` | `string[]` | `['GET', 'HEAD', 'POST']` | The methods the guest may use, from `GET`, `HEAD`, `POST`, `PUT`, `PATCH` and `DELETE`. Replaces the default list. |
| `headers` | `string[]` | none | Header names the guest may set beyond `accept`, `accept-language`, `content-language` and `content-type`. `Authorization` only this way; `Cookie`, `Host`, `Origin`, `Referer`, `Sec-*`, `Proxy-*` and other forbidden names never. |
| `maxConcurrent` | `number` | `4` | Most requests in flight at once; a request past it is refused with `FETCH_BUSY`. At most `16`. The host's memory for the bridge is bounded by about 3 times `maxConcurrent` times `maxBytes`: a response is held as the chunks read and as the joined body, and the result is cloned for the guest (a bound, not a measurement). |
<!-- generated:end -->

### `callLimits`

<!-- describes: api:CallLimits sig:2e9a -->
The per-second budget of the calls the guest makes (`bridge.call()`, and `sandboxFetch()` and guest writes, which are
calls too), per environment, in every mode: in any one-second window (a sliding window), at most `maxPerSecond` calls
and `maxBytesPerSecond` bytes of them, each call's whole message measured as [`call()`](#callmethod-args) measures it.
The guest's `bridge` refuses a call past it with `BUSY` before sending it, and the element answers `BUSY` to one that
arrives anyway (a guest's calls delivered late, while your page was busy, can arrive closer together than it sent
them). Your own calls to the guest are not counted.

<!-- generated:begin api-call-limits -->
| Field | Type | Default | What it does |
| :--- | :--- | :--- | :--- |
| `maxPerSecond` | `number` | `1000` | Most calls in any one-second window (a sliding window). |
| `maxBytesPerSecond` | `number` | `67108864` (64 MiB) | Most bytes of calls in any one-second window, each call's whole message measured as `call()` measures it. A value below `RPC_MAX_BYTES` (33 MiB) also caps one call: a heavier call is refused with `ARGS_NOT_TRANSFERABLE`, with one warning at `setConfig()`. |
<!-- generated:end -->

A field left out, or `callLimits` left out, takes the default. A value that is not a finite number `>= 1` (`Infinity`,
`0`, `0.5`, a negative number, `NaN`, a string, `null`) takes the default with one warning, and a `callLimits` that is not
an object takes both defaults with one warning; there is no way to turn the budget off, nor to set one that admits no
call.

The two fields are checked together: every call that can be carried fits an empty window. A call weighs its whole
message, so a `maxBytesPerSecond` below `RPC_MAX_BYTES` (33 MiB) also caps one call: a call heavier than it can never fit,
and is refused with `ARGS_NOT_TRANSFERABLE`, which is not worth retrying, by the guest's `bridge` before sending it and
by the element if it arrives anyway; such a value gives one warning at `setConfig()`. The smallest call measures about
136 bytes, so a budget below that refuses every guest call, `sandboxFetch()` and guest writes included, with
`ARGS_NOT_TRANSFERABLE`.

### `allowAnimations` and `allowAutoplay`

Strict mode's view runs on your page's main thread wherever the browser places it there, and then everything it
renders is work on that thread:

| Browser | Where the view runs |
| :--- | :--- |
| Firefox | Your page's thread. Fission isolates only cross-site frames, and the view (an opaque-origin sandboxed frame) is placed with the site that created it. |
| Safari, every WebKit browser | Your page's thread: WebKit has no site isolation. |
| Android | Chromium isolates partially; Android WebView has no out-of-process frames at all. |
| Chromium on the desktop | A process apart from your page's, from Chromium 127 (sandboxed frames are isolated). All the sandboxed frames of your page can share that one process, so one sandbox's work can stall another's view ([S79](BACKLOG.md#s79)). Your page's thread where that isolation is off, as in the headless shell. |

Rendering follows script: wherever the view's script runs on your page's thread, so does its rendering.

**`allowAnimations: true`, an opt-in: CSS animations and transitions in the view run on your page's main thread
wherever the browser runs the view there, and the view's time budget does not bound them.** A guest can keep your page
busy for as long as they run (measured with 5 000 animated elements: 80–98% of its main thread; scroll-driven
animations and transitions too). The budget bounds what the view does when the guest renders; an animation, once
rendered, runs without the view doing anything. Left out, or `false`, the default, removes animations and transitions
from the view: every element shows its end state, and the bound holds on every engine. With `false` the view puts a stylesheet of its own before
anything the guest renders, one anonymous cascade layer that sets `animation` and `transition` to `none !important` on
every element and, once the guest's CSS names it (or uses an escape or `@import`), on each pseudo-element the browser
supports that an animation applies to (not `::first-letter`, `::first-line`, the highlight pseudo-elements or scrollbar
parts, on which no animation runs), and the renderer removes every animation and transition declaration that holds
anything but a CSS-wide keyword from `style` attributes (an inline `!important` would beat any layer). A `style`
attribute whose text contains neither `animation` nor `transition` (in any case) nor a backslash is left exactly as
written. One that does, and also has a backslash or declares `all` (outside comments and strings), is removed whole;
any other loses only its animation and transition declarations. Nothing the guest declares overrides it: its own
`!important`, its own layers, `@starting-style`, `@property`, scroll-driven animations, registered stylesheets and
their `@import`s. Your page's `style-src` must allow that stylesheet (`'unsafe-inline'`, or its hash: see
[Host page policy](#host-page-policy)); where it does not, the view removes the guest's stylesheets instead
(`<style>`, `<link rel="stylesheet">`), so no guest animation runs either way, and the element warns once with the
hash to allow.

**`allowAutoplay: false`, the default**: the renderer removes `autoplay` from `<video>` and `<audio>`, so media plays
only when the user starts it with its controls. With `true`, autoplaying media decodes and paints on your page's main
thread where the view shares it, for as long as it plays, outside the time budget (measured: up to +6 points of your
page's main thread for 20 looping videos).

What neither switch removes: a pointer moving over many elements with `:hover` rules restyles them on every move
(80–100% of the thread while the pointer moves; one operation's cost, driven by the user); animated images (GIF,
APNG, WebP: WebKit +22 points for 2 000); indeterminate `<progress>` (up to +4 points for 5 000). See
[Modes](#modes).

---

## Methods

Every method can be called in any state. Methods that build an environment do so only while the element is in
the document; otherwise they take effect when it is inserted.

<!-- generated:begin api-methods -->
### `setConfig(config)`

```ts
setConfig(config: SandboxConfig): void
```

Replaces the configuration and rebuilds the environment now (while the element is in the document).

- The configuration is applied over the defaults, not over the previous one: an option left out returns to its
 default, `html` included, so a `setConfig()` after `load()` starts with an empty document unless
 it passes `html` again.
- The argument is copied (structured clone) before anything reads it; changing your objects afterwards changes
 nothing, not even at the next `reset()`.
- Values that cannot be used (an entry that is not allowed, a list option that is not a list, an `html` that is not
 a string) are dropped with one `console.warn` per element and message, and never applied half-way.
- The configuration the environment already stands on, set again, changes nothing: no rebuild and no event, so read
 `state` rather than wait for `ready`. Anything a build reads that changed since (`load()`, the files) rebuilds as
 usual.
- A config that cannot be used at all (not an object, not cloneable such as a `Proxy` or a function value, an
 `origins` that is not an object or has a kind that is not a list) applies nothing and the previous config stays: the
 sandbox terminates, and stays terminated until a usable config is set. A build that fails terminates it too.
- It never throws. `state` is `'terminated'` when it returns after a refusal; the `terminated` event of a refused
 build comes in a task of its own, like `ready`, and not at all if another build started meanwhile.

**Parameters**

- `config`: The new configuration; see `SandboxConfig`.

### `load(html)`

```ts
load(html: string): void
```

Sets `html` (the guest document, or the initial view in sealed and strict mode), keeps the rest of the configuration and
rebuilds the environment now (while the element is in the document). Worker mode ignores the markup but still
rebuilds.

**Parameters**

- `html`: The markup, as for the `html` option of `SandboxConfigOptions`.

### `reset()`

```ts
reset(): void
```

Rebuilds the environment now, from any state (terminated included): a fresh frame with a fresh opaque origin, the
current configuration and a new snapshot of the files. Methods the guest exposed are gone, methods exposed with
`expose()` stay, and pending calls reject with `TERMINATED`. Wait for `ready` before relying on the
new environment. Outside the document it builds nothing until the element is inserted.

### `terminate(reason?)`

```ts
terminate(reason?: string): void
```

Removes the frame now, sets `state` to `'terminated'` and dispatches `terminated` with `{ reason }`. Pending calls
reject with `TERMINATED` and later calls are refused at once. The sandbox stays terminated until
`reset()`, `load()` or `setConfig()` builds a new environment.

Calling it while terminated does nothing, so `terminated` fires once per termination. The reason is also written to
the console as a warning.

**Parameters**

- `reason`: Why, as the `terminated` event reports it; `'terminated by the host'` when left out. A value that
is not a string, or is empty or only white space, is replaced by that default.

### `execute(code)`

```ts
execute(code: string): void
```

Runs `code` in the guest's global scope as the body of a function: in the guest document in cooperative mode, in
the worker in worker, strict and sealed mode. It is compiled with the `Function` the bootstrap captured before any guest
code ran. Nothing reaches the host: no return value and no report that it returned.

- Needs `scriptUnsafe: true` and a string; otherwise it warns and does nothing.
- While the element is `'idle'` (not in the document) or `'terminated'` there is no environment: it warns and does
 nothing, where `call()` rejects.
- While `'loading'` the code is queued and sent when the build becomes `ready`. In cooperative mode it runs once the
 guest document is parsed (see [Ready and the startup gate](#ready-and-the-startup-gate)), in order with calls.
- A synchronous throw becomes a `sandbox-log` line (`level: 'error'`, `source: 'guest'`).
- In worker, strict and sealed mode each call has its own `workerExecutionTimeout` deadline. What it bounds is precise:
 the guest's event loop is free at the deadline. The element pings the guest there; the bootstrap answers from a
 handler guest code cannot reach, and only a free event loop can run it. No answer within
 `EXECUTION_TIMEOUT_GRACE_MS` terminates the sandbox.
- Code that is still running at the deadline, or that returned but left work running then (a loop in a
 `setTimeout`), is terminated. Code that ran to its end and left the loop free stays ready, whatever it scheduled
 for later.
- Several calls each have their own deadline, and every deadline checks the one event loop: a loop started by any
 code ends the sandbox at the first deadline it blocks.
- A loop that starts after the last deadline is not bounded by it: `watchdogTimeout` checks the event loop
 continuously and covers that case.

**Parameters**

- `code`: The function body to run.

### `expose(name, fn)`

```ts
expose(name: string, fn: (...args: any[]) => unknown): void
```

Publishes a host method the guest calls with `bridge.call(name, ...args)`. The guest receives the handler's return
value (awaited if it is a promise). A throw or rejection reaches the guest as `HANDLER_ERROR` with the error's
message, verbatim up to 65536 characters (a longer one is cut, and ends `[… cut at 65536 characters]`): throw errors
whose message you would show the guest, or wrap the handler.

Methods belong to the element: they survive `reset()`, `load()`,
`setConfig()` and `terminate()`. Exposing a name again replaces its handler. Names that
start with `sandbox:` are reserved for the library and refused with a warning. The arguments are the guest's data:
validate them, and copy objects with spread rather than `Object.assign` or a `for...in` loop (an own `__proto__` key
survives the copy). Guest-controlled text: show it with `textContent`, never in an HTML, URL (such as a link `href`),
`eval`, template or `console` format-string sink.

**Parameters**

- `name`: The method name, a string of at most 256 characters.
- `fn`: The handler; its arguments come from the guest by structured clone.

**Throws:** A `TypeError` if `name` is not a string or is longer than 256 characters, or `fn` is not a function.

### `call(method, ...args)`

```ts
call<T = unknown>(method: string, ...args: unknown[]): Promise<T>
```

Calls a method the guest exposed with `bridge.expose()` and resolves with its result. It works without
`scriptUnsafe`: it never evaluates code.

- Arguments and results are copied by structured clone, at most `RPC_MAX_BYTES` (33 MiB) per message, counted on
 both sides on the copy that is sent: past it a call is refused before anything is sent (`ARGS_NOT_TRANSFERABLE`)
 and a result is answered `RESULT_NOT_TRANSFERABLE`. The measure knows primitives, plain objects and arrays, `Map`,
 `Set`, `Date`, `RegExp`, `ArrayBuffer`, typed arrays and `DataView`, `Blob` and `File`, and `String`, `Number`,
 `Boolean` and `BigInt` objects. Any other value (an `Error`, an `ImageData` or another platform object, a
 `SharedArrayBuffer`) is refused the same way, with a message that names the value rather than the budget; send what
 you need of it instead: an error's `{ name, message, stack }`, an image's `data`, `width` and `height`. The whole
 message is counted, the method name included, and a name is at most 256 characters (`INVALID_CALL`).
- The default timeout is 30 s (`TIMEOUT`). The element's timers and its copy of the arguments use the `setTimeout` and
 `structuredClone` it took when it was constructed: fake timers installed after that (a test's) do not control a
 call's timeout.
- Calls made while `'loading'` are queued and sent when the build becomes `ready`, in every mode (strict and
 sealed mode included, whose view has its ports before it checks in); one that settles while queued (its timeout) leaves the queue
 and never runs. In cooperative mode a call reaches the guest's method once the guest document is parsed (see
 [Ready and the startup gate](#ready-and-the-startup-gate)).
- Calls made while `'idle'` (not in the document) or `'terminated'` reject at once with `TERMINATED`, as
 `execute()` does nothing then; so do pending ones when the environment goes away.

**Type parameters**

- `T`: The type of the result, which the caller asserts: the guest's value is not checked against it.

**Parameters**

- `method`: The name the guest exposed.
- `...args`: The arguments, copied by structured clone.

**Returns:** The guest method's return value (awaited if it is a promise).

**Throws:** Never synchronously: the promise rejects with an `RpcError`, an `Error` whose `code` is an
`RpcErrorCode`. `UNKNOWN_METHOD`, `HANDLER_ERROR` and `RESULT_NOT_TRANSFERABLE` are reported by the guest and
their message is the guest's text.

### `callWithTimeout(timeoutMs, method, ...args)`

```ts
callWithTimeout<T = unknown>(timeoutMs: number, method: string, ...args: unknown[]): Promise<T>
```

Like `call()`, with a timeout of your own for this one call. Every other timeout is waited out in
full, however long: `watchdogTimeout` and `workerExecutionTimeout` do not shorten it.

**Type parameters**

- `T`: The type of the result, which the caller asserts.

**Parameters**

- `timeoutMs`: The timeout in ms. `0`, any value that is not above 0, and `Infinity` disable it.
- `method`: The name the guest exposed.
- `...args`: The arguments, copied by structured clone.

**Returns:** The guest method's return value (awaited if it is a promise).

**Throws:** Never synchronously: the promise rejects as `call()`'s does.

### `registerFiles(files)`

```ts
registerFiles(files: Record<string, FileEntry>): void
```

Adds or replaces files in the element's store. The guest sees them from the next environment build on
(`reset()`, `load()` or `setConfig()`), never in a guest already
running. Files survive every rebuild and `terminate()`.

- The whole batch is validated first. It fires `fileschanged` when something changed; registering identical content
 again changes nothing.
- A path is relative (`src/main.js`): segments of letters, digits and the characters of `._~!$&'()*+,;=@-`,
 separated by single slashes, at most 256 characters, no `.` or `..` segment. Paths are checked, never normalised.
- A file's type comes from its extension (`.js` and `.mjs` `text/javascript`, `.css` `text/css`, `.json`
 `application/json`, `.svg` `image/svg+xml`, `.png`, `.woff2`, `.mp4` and the like); an unknown extension is
 `application/octet-stream`.
- A reference names a file only for the kind of load its type is for: `<script src>`, `modulepreload`,
 `preload as=script` and module imports only JavaScript types; a stylesheet `<link>`, `preload as=style` and
 `@import` only `text/css`; `img`, `srcset`, `poster`, icon links and CSS `url()` only `image/*`; `url()` in
 `@font-face` and `preload as=font` only `font/*`; `audio`, `video` and `source` only `audio/*` and `video/*`;
 `track` only `text/vtt`. A reference to a file of another type stays as written and fails closed, with one
 warning. This holds for registered files as for committed ones: `x.js` registered as `text/plain` is never a
 script. Code that passes `sandboxFiles.url()` to a script element or `importScripts()` itself decides what it
 loads (Chromium runs such a file whatever its type; Firefox and WebKit refuse it in `importScripts()`).
- How the guest names files (markup, module imports, stylesheets) is described in the README's Files section; why:
 [ADR-004](ADR-004-files-as-blob-urls.md).

**Parameters**

- `files`: The files by path. An entry is a `string` (stored as UTF-8), a `Uint8Array` (copied), or
`{ content, type }` to set the MIME type instead of deriving it from the extension.

**Throws:** A `FileError` with `code` `INVALID_PATH`, `INVALID_FILE` or `FILES_QUOTA_EXCEEDED`. The whole batch is
validated first, so a refusal changes nothing.

### `unregisterFiles(paths?)`

```ts
unregisterFiles(paths?: string[]): void
```

Removes files from the store. Like `registerFiles()`, it takes effect at the next environment
build. Fires `fileschanged` when something was removed.

**Parameters**

- `paths`: The paths to remove; every file when left out. A path that is not registered is ignored.

**Throws:** A `FileError` with `code` `INVALID_PATH` for an invalid path (or `paths` that is not an array); nothing
is removed then.

### `listFiles()`

```ts
listFiles(): FileInfo[]
```

The registered files, sorted by path.

**Returns:** One `FileInfo` per file: its path, its MIME type and its size in bytes as registered.

### `listGuestWrites()`

```ts
listGuestWrites(): GuestWrite[]
```

The guest's pending writes and removals (see `guestWrites` and [Guest writes](#guest-writes)), sorted by path. They belong
to the current environment and survive its termination; the next build and the element's removal discard them.

**Returns:** One `GuestWrite` per path with a pending change, each a fresh object: `{ path, change: 'write', type, size, content }`
(`type` as the files would give it, `content` a copy of the bytes) or `{ path, change: 'remove' }`. Empty while
`guestWrites` is off.

### `commitGuestWrites(paths, options?)`

```ts
commitGuestWrites(paths: string[], options?: { code?: boolean; }): void
```

Applies the guest's pending changes at `paths` to the files, atomically, as one `registerFiles()` or
`unregisterFiles()` would, and removes them from the pending list. The guest sees committed files
from the next build on. Fires `fileschanged` when the files changed.

- A write whose type is not inert is refused with `FILES_NOT_ALLOWED` unless `options.code` is `true`. Inert types
 are the images, fonts, audio and video a browser only decodes, plain text, JSON and CSS (the exact list is in
 `INERT_TYPES`, src/lib/guest-writes.ts). JavaScript, HTML, SVG, XML, WebAssembly, unknown types and any other type
 the guest set can run or be parsed as code. The type checked is the one the file will be loaded as, never just its
 name.
- All checks come first, the quota included (with what module and stylesheet rewrites add, against the files as they
 are now), so a refusal changes neither the files nor the pending list.
- A committed file loads only as what its type is for (see `registerFiles()`): an inert file never runs as a script.
 Committed `text/css` is inert but still CSS: markup of the next build that links it is styled by it.

**Parameters**

- `paths`: The paths to commit; required, since there is no "commit everything". A path with no pending change
is skipped.
- `options`: `code: true` allows the writes whose type is not inert.

**Throws:** A `FileError` with `code` `INVALID_PATH`, `FILES_NOT_ALLOWED` or `FILES_QUOTA_EXCEEDED`.

The inert types, exactly: `application/json`, `audio/flac`, `audio/mp4`, `audio/mpeg`, `audio/ogg`, `audio/wav`, `font/otf`, `font/ttf`, `font/woff`, `font/woff2`, `image/avif`, `image/bmp`, `image/gif`, `image/jpeg`, `image/png`, `image/webp`, `image/x-icon`, `text/css`, `text/plain`, `video/mp4`, `video/ogg`, `video/webm`.
<!-- generated:end -->

### Custom element reactions

The browser calls these when the element is inserted, removed or moved; you do not.

<!-- generated:begin api-reactions -->
- `connectedCallback()`: Custom element reaction: the browser calls it when the element is inserted into a document. It builds an environment from the current configuration (see `state`) where the element may build one; nothing is dispatched synchronously.
- `disconnectedCallback()`: Custom element reaction: the browser calls it when the element is removed from a document. The environment ends and pending calls reject with `TERMINATED`. This is not a termination: no `terminated` event is dispatched, and inserting the element again builds a fresh environment.
- `adoptedCallback()`: Custom element reaction: the browser calls it when the element is moved into another document (`adoptNode()`, or appending it to an iframe's document). Its environment ends as for a removal and it stays `'idle'` there, with one warning; moved back, it builds again.
<!-- generated:end -->

---

## Events

<!-- describes: events, api:WebSandboxEventMap sig:b3e559d4 -->
<!-- generated:begin api-events -->
The events the element dispatches, and the `detail` of each: the type map of `addEventListener()`.

Every event is a `CustomEvent` dispatched on the element and none is `composed`. The bubbling ones reach a listener on
`window` for every sandbox on the page; `event.target` says which. The `detail` is frozen, deeply: every object and
array in it, a guest's log arguments included. What cannot be frozen stays as it is: the bytes of a typed array or an
`ArrayBuffer`, the entries of a `Map` or a `Set`, a `Date`'s time. Fields that come from the guest are validated and
clamped, but remain the guest's data: read them, do not merge them into your objects. Guest-controlled text (a log
line's arguments, a violation's `blockedURI` and `sourceFile`, a fetch record's `url`, and the path and type of a
guest's write: `fileswritten`'s `detail.paths`, `listGuestWrites()`): show it with `textContent`, never in an HTML,
URL (such as a link `href`), `eval`, template or `console` format-string sink. A valid path can hold `'`, `(`, `)`, `;`, `=`, `&`, `!`, `$`, `*`,
`+`, `,` and `@`, so one written into a single-quoted attribute can end it and add one. `terminated.reason` is the
library's text.

| Event | `detail` | Bubbles | When |
| :--- | :--- | :--- | :--- |
| `ready` | none | no | The guest checked in and `state` is now `'ready'`. Once per environment. In cooperative mode the guest document may still be loading (see [Ready and the startup gate](#ready-and-the-startup-gate)). Without `allow-scripts` no guest script runs: `ready` comes with the frame's load, and calls time out. |
| `terminated` | `{ reason: string }` | no | The sandbox was terminated: `state` is `'terminated'` and `detail.reason` says why. Once per termination, for a call to `terminate()`, a budget or liveness check that ended the guest, a failed frame check, or a configuration or build that was refused (that one in a task of its own, and not at all if another build started meanwhile). Removing the element ends its environment without this event. Branch on `state` and the event, not on the reason's text. |
| `sandbox-log` | `SandboxLog` | yes | A log line from the guest's console or written by the element; see `SandboxLog`. Guest lines are limited to `LOG_EVENTS_PER_SECOND` per environment per second. |
| `violation` | `SandboxViolation` | yes | The guest's policy refused a load; see `SandboxViolation`. At most `VIOLATION_EVENT_LIMIT` per environment. A report is a claim by the guest, not a host fact. |
| `fetch` | `FetchRecord` | yes | A `sandboxFetch()` request settled, refusals included; see `FetchRecord`. Dispatched only with `fetchBridge` configured. Without it `sandboxFetch()` rejects with `FETCH_NOT_ALLOWED` and no event is dispatched. |
| `fileschanged` | `{ paths: string[] }` | no | `registerFiles()`, `unregisterFiles()` or `commitGuestWrites()` changed the files; `detail.paths` lists the paths that changed. Dispatched synchronously, once per call that changed something. |
| `fileswritten` | `{ paths: string[] }` | yes | The guest's write or removal changed what `listGuestWrites()` shows at a path (with `guestWrites`); `detail.paths` holds that one path. At most `GUEST_WRITES_PER_SECOND` per environment per second. The path is guest-controlled text: show it with `textContent` (a valid path can end a single-quoted attribute). |
<!-- generated:end -->

The element's own startup message, the guest frame's port announcement (`{ type: 'SANDBOX_PORT' }` from the guest
frame's window), is taken by a capture listener the element adds to your window at each build; a `message` listener of
yours added before it, in the capture phase, sees it first. Act on a message only by `event.source` (above), never by
its shape.

### `sandbox-log` — `SandboxLog`

<!-- describes: limit:LOG_EVENTS_PER_SECOND, limit:LOG_MAX_ARGS, limit:LOG_MAX_STRING, limit:LOG_MAX_BYTES, limit:LOG_BYTES_PER_SECOND, limit:UNCAUGHT_PER_SECOND, limit:UNCAUGHT_CHARACTERS_PER_SECOND, limit:VIEW_OPTIONS.guestText.maxLength, host-lines, api:SandboxLog, api:SandboxLogLevel sig:c106f537ef2bcb8905a960883dc76370543a7ff2bb70 -->
<!-- generated:begin api-sandbox-log -->
| Field | Type | Meaning |
| :--- | :--- | :--- |
| `type` | `'LOG'` | Always `'LOG'`. |
| `level` | `'log' \| 'info' \| 'warn' \| 'error'` | How serious the line is. A level the guest sends that is not one of `SandboxLogLevel` reads as `'log'`. |
| `args` | `readonly unknown[]` | What was logged, structured-cloned: at most `LOG_MAX_ARGS` values, strings cut at `LOG_MAX_STRING` characters, all of them together at most `LOG_MAX_BYTES` (1 MiB). An argument past what is left of that is replaced by a string that says so. Guest-controlled text when `source` is `'guest'`: show it with `textContent`, never in an HTML, URL (such as a link `href`), `eval`, template or `console` format-string sink. |
| `source` | `'guest' \| 'host'` | `'host'` for a line the element wrote itself, `'guest'` for a line that came from the guest's port, whatever it claims. Set by the element, never read from the line. |
<!-- generated:end -->

Lines with `source: 'guest'`, from one relay in every mode: the guest's `console` (`log`, `info`, `warn`, `error`;
`debug`, `dir`, `dirxml`, `table`, `group` and `groupCollapsed` as `log`; `trace` as `log` after `console.trace()`; a
failed `assert` as `error` after `Assertion failed:`); `Uncaught …` for an uncaught error (strict mode: after the entry
ran) and `Uncaught (in promise) …` for an unhandled rejection; a throw from `execute()`; one `info` line
`<mode> Ready` per environment. Guest code can post anything here. The guest's console never throws: a value
structured clone refuses (a function, a Symbol, a DOM node, an `Event`, a `Response`, a `Proxy`, a `WeakMap`, a
`Promise`) arrives as a string naming its kind (`[function]`, `[object HTMLDivElement]`), and an `Error` or
`DOMException` as `{ name, message, stack }`. `count`, `countReset`, `time`, `timeLog`, `timeEnd`, `timeStamp`,
`profile` and `profileEnd` relay nothing, and reach the browser's own console bounded like a line. WebKit mutes the errors of a cooperative guest's inline scripts and
handlers and of worker mode's worker: they arrive as `Uncaught Script error.`, all the browser gives.

The bounds: `LOG_MAX_ARGS` and `LOG_MAX_STRING` bound the strings; `LOG_MAX_BYTES` bounds all arguments of a line
together (a typed array, an object of 100 000 keys), measured as [`call()`](#callmethod-args)
measures a message, counting every field a clone delivers ([what the byte measure counts](#limits): a `File`'s `name`, a
`Blob`'s `type`, a sparse array's `length`): an argument past what is left of it is a string saying so (`[Uint8Array: past the log line's byte
budget (1048576)]`), and one holding a value the measure does not know (an `ImageData`) a string naming it
(`[unsupported value: ImageData]`); when even that string would not fit, the line ends with one string saying how many
arguments it dropped (`[Sandbox] 3 more argument(s) past the log line's byte budget (1048576)`), so a line never
measures past `LOG_MAX_BYTES` where it arrives. An `Error` anywhere in an argument (in an object, an array, a `Map`, a `Set`,
`Promise.allSettled`'s results; within 64 levels and 10 000 objects) is sent as `{ name, message, stack }` first.
The guest applies them before a line is posted, and sends at most `LOG_EVENTS_PER_SECOND` lines and 4 MiB in any one-second window (one `warn` line when it
starts dropping), so a flood of values does not reach the host page's thread, a long `File` name or a sparse array of a large `length` included
(both cross as the placeholder). In cooperative mode the browser's own console gets a
dropped line not at all and a cut line cut; in worker and strict mode it gets none (the worker's console is not a sink:
`sandbox-log` is). The element measures every line again on receipt, and dispatches at most `LOG_EVENTS_PER_SECOND`
guest lines in any one-second window per environment (one warning); the relay's own lines (`<mode> Ready` and its
`warn` lines) are not counted there, so they always arrive. Lines logged before the guest is connected (a strict
entry's top level runs before the worker has its port) are kept, at most 1000 and 4 MiB (one window's worth), and
arrive in order once it is, counted in that second's window; past either cap, one `warn` line says how many were
dropped and for which cap. In strict mode the view relays the later uncaught errors that only it can describe (WebKit
raises them there) within the same `LOG_EVENTS_PER_SECOND` window; the first one it drops sends one `warn` line, also
not counted (the last line of the table below).

In worker and strict mode an uncaught error or an unhandled rejection is cancelled once it is relayed, so the browser
does not report it as well. Firefox reports a worker's unhandled rejections to your page's thread all the same, so in
those modes they have a budget per environment: past 1000 uncaught errors and rejections (rejections handled later
included), or 1048576 characters of their names and messages (of a rejected string, its length), in any one-second
window, the sandbox ends: `the guest raised more uncaught errors or unhandled rejections in one second than their
budget allows`. One error or rejection is not bounded by it: the browser reports it before the sandbox can end, so one
with a message of hundreds of millions of characters costs your page's thread that one report.

The element's own lines are never rate-limited. The table gives each one with its level and when it is dispatched;
`…` stands for text that varies. A line with `source: 'guest'` is written in the relay's name and counted as the relay's
own, so it always arrives. The entry's error text that follows an entry failure is a guest line, `Uncaught …`, at most
2048 characters. A `[Sandbox] …` line carries, in place of `…`, the reason the sandbox then ends with (see
[`terminated` reasons](#terminated-reasons)). Lines delivered late, while your page was busy, can arrive closer
together than the guest sent them.

<!-- generated:begin host-lines -->
| Line | Level | Source | When |
| :--- | :--- | :--- | :--- |
| `Execution Timeout` | error | host | workerExecutionTimeout: the event loop was still busy past an execute()'s deadline; the termination follows |
| `[Sandbox] the guest entry failed to start` | error | host | strict mode: the entry failed to start; the entry's own error text follows as a guest line, then the termination |
| `[Sandbox] …` | error | host | the host page's policy refused a frame of the library's, or a bootstrap of the library found its document not the one the library built: … is the termination's reason, which follows |
| `[Sandbox] the guest logged more than 1000 lines in one second; lines past that rate are not dispatched as 'sandbox-log' events.` | warn | host | once per environment, when the element first drops guest lines past LOG_EVENTS_PER_SECOND |
| `[Sandbox] the view spent more than 2000 ms on one operation; a second such operation within 5 minutes ends the sandbox.` | warn | host | strict mode, once per environment: the view's first overrun (VIEW_FIRST_OVERRUN) |
| `[Sandbox] the guest raised more than 1000 uncaught errors in one second that only the view could describe; errors past that are dropped in the view.` | warn | guest | strict mode, once per environment: the view dropped a guest error text past its window (GUEST_TEXT_DROPPED) |
<!-- generated:end -->

### `violation` — `SandboxViolation`

<!-- generated:begin api-violation -->
The `detail` of a `violation` event: the guest's policy refused a load. Guest-supplied: validated and clamped, but not
trusted.

A report is evidence that the guest attempted something the policy refused, never a host fact: guest code can suppress
its own reports, and a frame the guest creates reports to itself. A `fetch()`, `XMLHttpRequest` or `WebSocket` request
of the guest's realm to an origin `origins.connect` does not list (in strict mode, any `WebSocket`) is refused by the
library's request gate before the browser sees it, and reported by the gate in every mode and on every engine, with
the same fields: `directive`
`'connect-src'`, `blockedURI` the URL without credentials or fragment, `sourceFile` `'web-sandbox:request-gate'`, no
line or column (in strict mode `source` `'logic'`). Reports the browser raises itself depend on the engine in workers
(WebKit raises none there), so what remains of them there, such as a redirect the browser refuses, is per engine. At
most `VIOLATION_EVENT_LIMIT` events per environment; in strict mode per `source`, and for the view per directive,
so refused loads of one kind never hide a report of another. See [ADR-005](ADR-005-strict-mode.md).

| Field | Type | Meaning |
| :--- | :--- | :--- |
| `directive` | `string` | The effective directive that refused the load, e.g. `'connect-src'` or `'img-src'`. |
| `blockedURI` | `string` | What was refused: a URL (possibly reduced to its origin by the browser; a `data:` or `blob:` URL is reported by its scheme alone), or `'inline'`, `'eval'` and the like. At most 2048 characters. Guest-controlled text: show it with `textContent`, never in an HTML, URL (such as a link `href`), `eval`, template or `console` format-string sink. |
| `sourceFile` | `string?` | Where the refused code ran, when the browser says (a `blob:` URL, `about:srcdoc` and the like), or `'web-sandbox:request-gate'` for a request the library's request gate refused. At most 2048 characters. Guest-controlled text: show it with `textContent`, never in an HTML, URL (such as a link `href`), `eval`, template or `console` format-string sink. |
| `lineNumber` | `number?` | The line of the refused code, a positive integer, when the browser gives one. |
| `columnNumber` | `number?` | The column of the refused code, a positive integer, when the browser gives one. |
| `source` | `'view' \| 'logic'?` | Strict mode only ([ADR-005](ADR-005-strict-mode.md)): which document's report this is, set by the element from the port it arrived on, never read from the report. `'view'` is the view document, which runs no guest code, so its reports are the library's own and complete up to the cap. `'logic'` is the worker: the request gate's reports, the same on every engine, and the browser's own worker reports, which guest code can forge or suppress like any cooperative-mode report and which depend on the engine (WebKit raises none in workers). |
<!-- generated:end -->

### `fetch` — `FetchRecord`

<!-- generated:begin api-fetch-record -->
The `detail` of a `fetch` event: one request through the bridge, reported once when it settled. A union keyed by
`outcome`; each member has exactly the fields its outcome has, and the fields it lacks are typed `never`, so reading
one is allowed and gives `undefined`.

- `'ok'`: a response was handed to the guest, whatever its HTTP status. Has `status`; has no `code`.
- `'refused'`: no request was made; the bridge's rules, or the browser's `Request`, refused it, or the bridge's frame
 could not start. `code` says why (`FETCH_NOT_ALLOWED`, `FETCH_BUSY`, `FETCH_TOO_LARGE` for a request body, or
 `FETCH_FAILED` when the frame could not start). `bytes` is `0`. `reason` is present for a refusal of an origin that
 is not listed (the host page's own origin, or a loopback, private or link-local host) and for a frame that could
 not start: what the host knows beyond the text the guest gets.
- `'failed'`: the request was handed to the bridge's frame and no whole response was handed over; `code` says why (`FETCH_REDIRECT`,
 `FETCH_TOO_LARGE` for a response body, `FETCH_TIMEOUT` or `FETCH_FAILED`). `status` is present once a response's
 status was read (not for a redirect, which is refused first). It is not proof that a request left the page: the browser's `fetch` also rejects some requests before
 sending them (the host page's own `connect-src`, mixed content, local-network blocking).
- `'aborted'`: the environment was torn down (by `reset()`, `load()`, `setConfig()`, `terminate()` or removal) before
 the record was made, whatever the request had settled on. `code` is `FETCH_FAILED`; `status` and `bytes` are as
 measured.

A record belongs to the environment that made the request and is dispatched when the request settles, so an `'aborted'`
record of a torn-down environment can arrive after the call that tore it down, while the next build is loading; after
a teardown an environment's records are all `'aborted'`. Fields that come from the guest are validated or clamped
first. `method` is upper case (`''` when the guest sent no valid one). `url` is the whole URL without its fragment, at
most 8192 characters (a longer one is refused and reported cut), or the guest's string cut to that when it is not a
URL. `bytes` counts the response body bytes read. `durationMs` runs from the request to its settlement. `url` is
guest-controlled text (it can be `javascript:`): show it with `textContent`, never in an HTML, URL (such as a link
`href`), `eval`, template or `console` format-string sink.

```ts
type FetchRecord = {
    method: string;
    url: string;
    durationMs: number;
} & ({
    outcome: 'ok';
    status: number;
    bytes: number;
    code?: never;
    reason?: never;
} | {
    outcome: 'refused';
    code: FetchErrorCode;
    reason?: string;
    bytes: 0;
    status?: never;
} | {
    outcome: 'failed';
    code: FetchErrorCode;
    status?: number;
    bytes: number;
    reason?: never;
} | {
    outcome: 'aborted';
    code: 'FETCH_FAILED';
    status?: number;
    bytes: number;
    reason?: never;
})
```
<!-- generated:end -->

### `terminated` reasons

<!-- generated:begin termination-reasons -->
| Reason | Cause |
| :--- | :--- |
| `terminated by the host` | `terminate()` without a reason, or with an empty one (or with your own text instead). |
| `the guest stopped responding (watchdog)` | `watchdogTimeout` expired. |
| `the guest entry failed to start` | Strict and sealed mode: the entry threw or did not parse. |
| `the sandbox's startup script did not run: the host page's Content-Security-Policy must allow it (see docs/API.md#host-page-policy)` | The frame loaded but the library's startup script (strict mode's view bootstrap, cooperative and worker mode's bootstrap) never checked in: the host page's policy refused it. See [Host page policy](#host-page-policy). |
| `the sandbox's worker could not be loaded: the host page's policy refuses blob: workers (worker-src; WebKit also under Cross-Origin-Embedder-Policy; see docs/API.md#host-page-policy)` | Strict, sealed and worker mode: the worker's script could not be loaded at all; nothing of the guest's ran. Worker mode is never `ready` then. |
| `the host page's Trusted Types policy does not allow the policy name 'web-sandbox' (trusted-types; see docs/API.md#host-page-policy)` | The host page enforces Trusted Types and its `trusted-types` directive does not name `web-sandbox`, also when the host page's own default policy takes the element's strings (the view and worker mode's frame need the policy themselves). |
| `the sandbox document's origin is not opaque: it is not running in the frame the library built` | A bootstrap of the library's (strict mode's view, the cooperative guest's document, worker mode's frame, the fetch bridge's frame) read an origin other than `'null'`: its document is not in a frame the library sandboxed as built. It stayed inert, so nothing of the guest's ran. |
| `the sandbox document is not an about:srcdoc document: it is not the document the library built` | A bootstrap of the library's read a document URL other than `about:srcdoc`: its document is not the srcdoc the library wrote. It stayed inert, so nothing of the guest's ran. |
| `the sandbox document's base URL is not about:blank: the host page's Content-Security-Policy must allow the library's <base> (base-uri must include about: or be omitted; see docs/API.md#host-page-policy)` | A bootstrap of the library's read a base URL other than `about:blank`: the host page's `base-uri` refused the `<base>` the library's wrapper sets, so the sandbox would have seen the host page's URL. It stayed inert, so nothing of the guest's ran. Allow `about:` in `base-uri`, or omit the directive (see [Host page policy](#host-page-policy)). |
| `the host page is cross-origin isolated (COOP and COEP); a sandbox does not run there (see docs/API.md#host-page-policy)` | The host page reads `crossOriginIsolated === true` (it sends both `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`), and a guest never runs cross-origin isolated, on any engine. The element builds no frame (a bootstrap of the library's that reads it in its own document stays inert too), so nothing of the guest's ran. Serve the page that embeds a sandbox without COOP and COEP (see [Host page policy](#host-page-policy)). |
| `the guest entry "…" is not a registered JavaScript file` | Strict and sealed mode: `entry` names no registered JavaScript file. |
| `the sandbox view stopped responding` | Strict and sealed mode: the view did not answer for `VIEW_LIVENESS_TIMEOUT_MS` (always on). |
| `the view spent more than 2000 ms on one operation twice within 5 minutes` | Strict and sealed mode: an operation of the view (a render, `text()` or `set()` applied, with its layout and the rendering update that showed it) took longer than 2000 ms, measured as the view's time budget measures it, and another one had, at most 5 minutes before it. The first such operation only logs a `warn` line (see [`sandbox-log`](#sandbox-log--sandboxlog)); see [`sandboxView`](#sandboxview-strict-mode). |
| `unknown mode …` | `mode` is not `strict`, `sealed`, `cooperative` or `worker`. For `'iframe'` the reason ends `('iframe' was renamed 'cooperative')`. |
| `` origins and fetchBridge open the network, which sealed mode (the default) does not have: set `mode: 'strict'` `` | `mode` is `'sealed'` or left out (sealed mode is the default), and the config names `origins` or `fetchBridge` (with any value but `undefined`). Nothing of the config is applied, as for one that could not be used; the sandbox stays terminated until a usable config is set. |
| `the configuration could not be used (…)` | `setConfig()` got something that is not an object or cannot be cloned (the error's name follows, as in `(DataCloneError)`), an `origins` that is not an object (`(TypeError: origins is not an object)`), or a kind of it that is not a list (`(TypeError: origins.connect is not a list)`, naming the kind). |
| `the environment could not be built (…)` | Building the frame failed. |
| `the executed code ran longer than workerExecutionTimeout` | The guest's event loop was still busy `EXECUTION_TIMEOUT_GRACE_MS` after an `execute()` deadline. |
| `the sandbox frame loaded a second time` | Something navigated or reloaded the library's frame (also before its first load, once the guest had checked in). |
| `the guest frame announced itself again (it reloaded or rewrote its document)` | Cooperative and worker mode: the guest frame announced a second port (it reloaded itself, rewrote its document so the bootstrap ran again, or posted a forged announcement), or announced one where no bootstrap runs. |
| `the sandbox did not finish loading` | The build was still `loading` after `LOAD_TIMEOUT_MS` of host time and its frame had not loaded (without `allow-scripts`: subresources included). |
| `the guest frame is missing` | The library's frame has no guest frame. |
| `the guest raised more uncaught errors or unhandled rejections in one second than their budget allows` | Worker, strict and sealed mode: past the budget of uncaught errors and rejections (see [`sandbox-log`](#sandbox-log--sandboxlog) and [Limits](#limits)). |
<!-- generated:end -->

Branch on `state` and the event, not on these texts. A reason never carries the text of an error the element
caught (that can quote your config, or be the guest's words): only a fixed text and, in parentheses, the error's
name.

---

## Lifecycle

<!-- describes: lifecycle:states, lifecycle:transitions, api:SandboxState sig:204e4b6ea4b8 -->
| State | Meaning |
| :--- | :--- |
| `idle` | Not in the document (constructed, or removed): no frame. |
| `loading` | A frame was built; waiting for the guest to check in (without `allow-scripts`, and in strict mode, for the frame to load); at most `LOAD_TIMEOUT_MS` (host time), then `terminated`. |
| `ready` | The guest can be reached; `ready` was dispatched. In cooperative mode the guest document may still be loading. |
| `terminated` | Torn down by `terminate()`, a budget (watchdog, `workerExecutionTimeout`, the view's longest operation), an integrity check or a failed build; `terminated` was dispatched. |

There is no `running` state: nothing reports that guest code is running or that it stopped.

| From | Action | To |
| :--- | :--- | :--- |
| any | inserted into the document; `setConfig()`, `load()` or `reset()` while in it | `loading`, then `ready`, or `terminated` if the build is refused or fails: one `terminated` per attempt, except for an attempt made from a `terminated` listener that ends with the very reason being dispatched (the same refusal again), which ends `terminated` without another event |
| any | removed from the document | `idle`, no event |
| any but `terminated` | `terminate()`, watchdog, `workerExecutionTimeout`, the view's longest operation, integrity check | `terminated` |

Every rebuild and teardown rejects pending calls with `TERMINATED`, aborts in-flight `sandboxFetch()` requests,
and resets the per-environment caps (log rate, violations). Listeners run synchronously; a listener that calls
`reset()` or `terminate()` is never undone by what the element was doing.

### `ready` and the startup gate

`ready` means the guest's startup script checked in: the bootstrap, the first script of the guest document (cooperative
mode), announced its port; in worker mode the worker's frame announced it once its worker runs; in strict mode the
view's bootstrap posted its check-in on the port only it holds. It does not wait for the guest's images or its own scripts, so `LOAD_TIMEOUT_MS`
bounds only that check-in; a page with slow images, or one that never finishes its document, is `ready`. A frame
that loaded but whose startup script never checked in was refused by the host page's policy, and the reason says so.
The exception is a cooperative frame without `allow-scripts`: no script runs in it, so `ready` comes with the frame's load,
and no guest script has run.

A plugin or guest whose own initialisation outlives `ready` (an `async` setup, a module that awaits) should say when it
is done: expose a method once it is (`bridge.expose('ready', () => true)` in the guest) and have the host retry
`callWithTimeout()` on `UNKNOWN_METHOD`, or call a host method the host exposed for that purpose
(`bridge.call('pluginReady')`).

In cooperative mode the guest document can still be loading at `ready`. Calls and `execute()` code that arrive while it is
being parsed wait in the guest, in one queue in the order they were sent, until it is parsed: `DOMContentLoaded` has
fired (classic, deferred and module scripts have run) or it has loaded. So a method a guest script exposes is there
when a call reaches it. Not covered: methods exposed from `async` scripts, after an `await`, or in a `load` handler
(a call that arrives first is `UNKNOWN_METHOD`). At most `MAX_INBOUND_IN_FLIGHT` calls and executions wait: past
that a call rejects with `BUSY` and an `execute()` is dropped with an error line. A guest that never finishes parsing
(`document.open()` without `close()`) stays `ready` and alive; the calls it is sent time out (`TIMEOUT`). Guest code
cannot open the gate early.

| Kept across a rebuild | Not kept |
| :--- | :--- |
| Host-exposed methods, registered files, the configuration, the `autoResize` height (until the new guest reports) | The guest's realm and exposed methods, pending calls, queued `execute()` code, in-flight requests, uncommitted guest writes |

A termination keeps the guest's pending writes (listable and committable) until the next build; removing the
element discards them.

[ADR-003](ADR-003-lifecycle-and-liveness.md)

---

## Refusal codes

Every refusal is a plain `Error` with an own string `code`. Branch on the code, never on the message.

### Calls: `RpcErrorCode`

<!-- describes: codes:rpc, api:RpcErrorCode, api:RpcError sig:7d56768c657b -->
From `call()`, `callWithTimeout()` and, in the guest, `bridge.call()` / `bridge.callWithTimeout()`.

| Code | Set by | Meaning | Retry? |
| :--- | :--- | :--- | :--- |
| `TIMEOUT` | local | No answer within the call's timeout. | yes |
| `TERMINATED` | local | The environment was reset, terminated or removed. | after the next `ready` |
| `ARGS_NOT_TRANSFERABLE` | local, reported | The arguments cannot be structured-cloned, measure more than `RPC_MAX_BYTES`, or hold a value the measure does not know (the message names it; see [`call()`](#callmethod-args)); nothing was sent. Reported by the other side for a call that arrived so: the method did not run. Guest calls only: the call is heavier than [`callLimits`](#calllimits)`.maxBytesPerSecond`, so no window could ever carry it. | no |
| `SEND_FAILED` | local | The transport threw while sending. | no |
| `INVALID_CALL` | local | The method name is not a string, or is longer than 256 characters. | no |
| `UNKNOWN_METHOD` | reported | No method of that name is exposed on the other side. | no |
| `HANDLER_ERROR` | reported | The handler threw or rejected; the message is its text, at most 65536 characters. | depends on the handler |
| `RESULT_NOT_TRANSFERABLE` | reported | The handler's result cannot be structured-cloned, measures more than `RPC_MAX_BYTES`, or holds a value the measure does not know (as above). | no |
| `BUSY` | reported | The other side already runs `MAX_INBOUND_IN_FLIGHT` of your calls, or 64 MiB of their arguments; the method did not run. Guest calls only: the guest made more calls in the last second than [`callLimits`](#calllimits) allows (by default 1000 calls, or 64 MiB of calls); the guest's `bridge` refuses such a call before sending it, and the element answers one that arrives anyway. | yes |

**Local** codes are set by the side that made the call, from its own state; the other side can never produce
`TIMEOUT`, `TERMINATED`, `SEND_FAILED` or `INVALID_CALL`. **Reported** codes come from the other side, and their
message is its text (at most 65536 characters); any other code the other side claims reads as `HANDLER_ERROR`.
`ARGS_NOT_TRANSFERABLE` is both: the side that made the call refuses such arguments before sending them, and the other
side answers it for arguments that arrive anyway. The guest's `bridge` also refuses with `BUSY` itself, for the
element's per-second budget, so that a call past it never crosses. `state === 'terminated'`
confirms `TERMINATED` from the element's own state. [ADR-002](ADR-002-host-guest-broker.md)

### `sandboxFetch()`: `FetchErrorCode`

<!-- describes: codes:fetch, api:FetchErrorCode sig:7e100e79 -->
Set only by the host (`FETCH_ERROR_CODES`):

| Code | Meaning | Retry? |
| :--- | :--- | :--- |
| `FETCH_NOT_ALLOWED` | Refused before any request: URL, origin, method, a header or the body (also: the bridge is off). | no |
| `FETCH_BUSY` | Refused before any request: `maxConcurrent` requests are in flight. | yes |
| `FETCH_REDIRECT` | The response was a redirect, which is never followed. | no |
| `FETCH_TOO_LARGE` | The request or response body exceeds `maxBytes`. | no |
| `FETCH_TIMEOUT` | No whole response within `timeoutMs`. | yes |
| `FETCH_FAILED` | Network error, CORS (the target sees `Origin: null`), the bridge's frame could not start, or the environment was torn down. | yes |

HTTP error statuses resolve, as with `fetch`. `sandboxFetch()` can also reject with a call code (for example
`TIMEOUT`, as a backstop 5 s after `timeoutMs`), and with a `TypeError` for a body it cannot send.

### Files: `FileErrorCode` and `NOT_FOUND`

<!-- describes: codes:files, api:FileErrorCode, api:FileError sig:43e68c1b813b -->
| Code | Where | Meaning |
| :--- | :--- | :--- |
| `INVALID_PATH` | `registerFiles()`, `unregisterFiles()`, `commitGuestWrites()`, guest `write()` / `remove()` | A path is not valid, or a list of paths is not an array. |
| `INVALID_FILE` | `registerFiles()`, guest `write()` | The batch is not an object, or an entry is not a string, a `Uint8Array` or `{ content, type }` with a valid MIME type (in the guest: a string, `Blob`, `ArrayBuffer` or typed array). |
| `FILES_QUOTA_EXCEEDED` | `registerFiles()`, `commitGuestWrites()`, guest `write()` | The files would exceed `MAX_FILES` files or `MAX_TOTAL_BYTES` (a rewritten JavaScript or CSS file counts what its rewrite adds; a guest write counts the files with every pending change applied). |
| `FILES_NOT_ALLOWED` | `commitGuestWrites()`, guest `write()` / `remove()` | An opt-in is missing: `guestWrites` is off, or a non-inert file is committed without `{ code: true }`. |
| `FILES_BUSY` | guest `write()` / `remove()` | Past `GUEST_WRITES_PER_SECOND` requests or `GUEST_WRITE_BYTES_PER_SECOND` bytes in any one-second window; nothing was recorded. Retryable. |
| `NOT_FOUND` | guest `sandboxFiles` | Any lookup of a path that is not there, exactly as written (message `no such file`); a `remove()` of a path that is in neither the files nor the guest's writes. Also `url()` of a file that is there and has no URL, with a message of its own (`this file has no URL (read() and text() work)`): a path the guest wrote, and in strict mode's worker a type the view does not show. |

In the guest, the codes other than `NOT_FOUND` come from the element through the broker, so `write()` and
`remove()` can also reject with a [call code](#calls-rpcerrorcode) such as `BUSY` or `TERMINATED`.

---

## Guest globals

<!-- describes: worker-globals sig:bb00 -->
What guest code can use, by mode. Everything here is installed by the library's bootstrap before any guest code
runs; in cooperative mode that needs `allow-scripts` (the policy always admits it).

| Global | strict (worker) | cooperative | worker |
| :--- | :--- | :--- | :--- |
| `bridge` | ✓ | ✓ | ✓ |
| `sandboxFiles` | ✓ | ✓ | ✓ |
| `sandboxFetch` | ✓ (refused without `fetchBridge`) | ✓ (refused without `fetchBridge`) | ✓ (refused without `fetchBridge`) |
| `sandboxView` | ✓ | — | — |
| `console` relayed | every method ([`sandbox-log`](#sandbox-log--sandboxlog)) | every method | every method |

Removed before guest code runs: `RTCPeerConnection` (and prefixed variants) in every mode. In strict and worker mode
also `WebAssembly` unless `scriptUnsafe` (WebKit compiles it without `'wasm-unsafe-eval'` but refuses to instantiate it, so
nothing runs there either; deleting it keeps WebKit's compiler away from guest bytes, [research 24](research/24_sealed_mode/README.md);
cooperative mode keeps it, a frozen limit), and in strict mode `URL.createObjectURL`. In strict mode the view document
runs no guest code at all, and acts only on trusted events: a synthetic event is never forwarded to `sandboxView.on`.

**The worker's globals are an allowlist** (worker and strict mode): before anything else runs in it, the worker keeps
only the names listed in `src/lib/worker-globals.ts` (`WORKER_GLOBALS`, and `WORKER_NAVIGATOR_MEMBERS` for
`navigator`) and deletes every other one, so a platform API that is not listed is absent. The listed globals that can
make a request are `fetch`, `XMLHttpRequest` and `WebSocket` (`connect-src`), which are the library's
[request gate](#the-request-gate) in every mode (in strict mode `WebSocket` is kept as a name but refuses every
socket: [no `WebSocket`](#strict-no-websocket)), and in worker mode `importScripts` (`script-src`). Strict mode's worker
has no `importScripts`: its policy's `script-src` is the view's hash, so it could never load anything. Kept: the language's built-ins, timers, events, `MessageChannel` within the worker,
encoding, streams, `crypto`, `Blob`, `File`, `URL`, `OffscreenCanvas` with 2D and WebGL, WebCodecs,
`performance`, `scheduler`, `BroadcastChannel`, and `indexedDB`, which is present but stores nothing: in the sandbox's opaque
origin `indexedDB.open()` rejects with a `SecurityError` on all three engines (measured on Chromium 145, Firefox 146 and
WebKit 26). Absent: `EventSource`, `WebTransport`, `WebSocketStream`, `FontFace`
and `fonts`, `caches`, `Notification`, `Worker` and `SharedWorker` (no nested workers), the Service Worker, Push, RTC,
MediaSource and Reporting interfaces, `navigator.serviceWorker` and `navigator.connection`; and the worker's own
`postMessage`, `onmessage` and `onmessageerror`: the library's port, with its budgets, is the only way from the worker
to its parent (worker mode's frame, strict mode's view). Its uncaught errors and unhandled rejections leave it the same
way, as [`sandbox-log`](#sandbox-log--sandboxlog) lines, within their budget. Every surface of the worker and its parent
document by which guest activity can make work on your page's thread is listed, with its bound, in
`src/lib/egress.ts`.

### `bridge`

| Member | Signature | Description |
| :--- | :--- | :--- |
| `expose` | `(name: string, fn: (...args) => unknown) => void` | Publishes a guest method the host calls with `sandbox.call(name, ...)`. Last registration wins; `sandbox:` names, and names longer than 256 characters, are ignored. |
| `call` | `(method: string, ...args) => Promise<unknown>` | Calls a host method exposed with `sandbox.expose()`. 30 s timeout. At most [`callLimits`](#calllimits) calls in any one second (by default 1000 calls and 64 MiB), per environment: past that a call is refused with `BUSY` and not sent. |
| `callWithTimeout` | `(timeoutMs: number, method: string, ...args) => Promise<unknown>` | With a timeout for this call; `0` disables it. |

Usable at once: calls and exposes made before the channel is connected are buffered. Rejections carry the
[`RpcErrorCode`](#calls-rpcerrorcode)s. Guest methods belong to one environment and are gone after a rebuild.

### `sandboxFiles`

<!-- describes: api:SandboxFiles sig:30aa -->
| Member | Signature | Description |
| :--- | :--- | :--- |
| `list` | `() => string[]` | The registered paths, sorted. |
| `url` | `(path: string) => string` | The file's `blob:` URL, minted in the guest's own realm. Throws `NOT_FOUND`: `no such file` for a path that is not there, and `this file has no URL` for a file that is there and has none. In strict mode's worker, only for the types the view shows (below); any other file is `read()` and `text()` only. |
| `read` | `(path: string) => Promise<Uint8Array>` | The bytes as registered, a fresh copy per call. Rejects `NOT_FOUND`. |
| `text` | `(path: string) => Promise<string>` | The content decoded as UTF-8. Rejects `NOT_FOUND`. |
| `write` | `(path: string, entry) => Promise<void>` | Asks the element to record a write ([`guestWrites`](#configuration)). `entry`: a string, `Blob`, `ArrayBuffer` or typed array, or `{ content, type }`; copied when called. Rejects with a [files code](#files-fileerrorcode-and-not_found). |
| `remove` | `(path: string) => Promise<void>` | Asks the element to record a removal. Rejects `NOT_FOUND` for a path in neither the files nor the guest's writes. |

Always present: with no files, `list()` is empty and every lookup fails. Lookups are exact (`../x`, `/x` and
`%2e%2e/x` are not found). `url()` serves the rewritten form of a module or stylesheet; `read()` and `text()`
return what you registered. [ADR-004](ADR-004-files-as-blob-urls.md)

### Guest writes

<!-- describes: api:GuestWrite sig:cce0 -->
With `guestWrites: true`, `sandboxFiles.write()` and `remove()` change the guest's own view once the element
has accepted them: `list()`, `read()` and `text()` show them, `url()` of a written path is `NOT_FOUND` with the message
`this file has no URL` (the guest gets no URL for anything it wrote). The element checks each request as `registerFiles()` would (path, entry, type, the
quota with every pending change applied) and at most `GUEST_WRITES_PER_SECOND` requests and
`GUEST_WRITE_BYTES_PER_SECOND` bytes in any one-second window; a refused request changes nothing on either side. Nothing the
guest writes reaches the files, a policy or another environment until the host calls
[`commitGuestWrites()`](#commitguestwritespaths-options); it is listed by
[`listGuestWrites()`](#listguestwrites) and announced by `fileswritten`. Without `guestWrites`, both methods
reject with `FILES_NOT_ALLOWED`, and so does the element for any request that reaches it. Treat written
content as the guest's data, and so its path and type: show them with `textContent`, never in an HTML, URL, template or `console`
format-string sink (a valid path can hold `'`, `(`, `)`, `;`, `=`, `&`, `!`, `$`, `*`, `+`, `,` and `@`, so one written into a
single-quoted attribute can end it and add one). [ADR-004](ADR-004-files-as-blob-urls.md)

In strict mode the view shows the raster images the guest writes: a write whose type is `image/png`, `image/jpeg`,
`image/gif`, `image/webp` or `image/avif` (as the files would give it, never SVG) can be named by path in `img`,
`poster` or an icon link of the next render, with no rebuild. The element sends the view the bytes it recorded, the
view makes its own URL from them, and the image is only decoded; `write()` resolves once the view has it. A later
write to the path replaces the image; a removal, or a write of any other type, leaves the path naming nothing in the
view (a registered file the guest replaced or removed included, also one you unregistered after the build). The view
shows what the guest's own `sandboxFiles` holds, whatever the pending list says. A rebuild starts from the registered
files again.

`fileswritten` names a path exactly when a request changed what `listGuestWrites()` shows there. A removal of a path
the guest wrote and the files do not hold withdraws the write: the path leaves the list, and `fileswritten` names it
with nothing listed there. A removal of a file you unregistered after the build lists nothing (there is nothing left to
remove) and is announced nowhere; the file is gone from the guest's files and from the view. Writing the same bytes and type again
changes nothing listed and is not announced.

The element records a change before it announces it, and `listGuestWrites()` is the truth; the guest's view
changes only when the element's answer arrives. They disagree by design in two cases: a `fileswritten` listener
that calls `terminate()` (the change stays listed and committable, and the environment that asked is gone before
any answer), and a listener that blocks longer than the guest's call timeout, 30 s (the guest's `write()` rejects
with `TIMEOUT`, and the change is listed all the same). A listener's `reset()` discards the change with the rest.

### `sandboxFetch`

`sandboxFetch(url: string, init?: { method?, headers?, body? }): Promise<Response>` — asks the host for the request,
which it decides under the [`fetchBridge`](#fetchbridge) rules and the bridge's frame makes; without `fetchBridge` every request rejects with
`FETCH_NOT_ALLOWED`. Only `method`, `headers` and `body` are read from `init`, each once;
the body is a string, an `ArrayBuffer` or a typed array. Resolves with a whole `Response` (no streaming, no
`AbortSignal`); rejects with a [`FetchErrorCode`](#sandboxfetch-fetcherrorcode). `fetch` itself is untouched;
assign `globalThis.fetch = sandboxFetch` to route through the bridge. [ADR-006](ADR-006-fetch-bridge.md)

### `sandboxView` (strict mode)

<!-- describes: limit:VIEW_MAX_ELEMENTS, limit:VIEW_MAX_DEPTH, limit:VIEW_MAX_CHARACTERS, limit:VIEW_RENDER_CHARACTERS_PER_SECOND, limit:VIEW_EVENT_LIMITS.maxString, limit:VIEW_EVENT_LIMITS.maxIds, limit:VIEW_EVENT_LIMITS.maxFields, limit:VIEW_EVENT_LIMITS.maxTotal, limit:VIEW_INPUT_IN_FLIGHT, limit:VIEW_SET_STYLE_LIMITS.maxProperties, limit:VIEW_SET_STYLE_LIMITS.maxValue sig:7329ee0cf6ced5b39f62b689f003b322330931f95934 -->
| Member | Signature | Description |
| :--- | :--- | :--- |
| `render` | `(html: string, into?: string \| null) => void` | Replaces the view's body, or the children of the element with id `into`. At most `VIEW_RENDER_MAX_LENGTH` characters (else `RangeError`). The latest render per target wins; one operation is in flight at a time. |
| `text` | `(id: string, text: string) => void` | Makes `text` the only content of the element with that id, as text: the view assigns it and parses nothing, so nothing needs escaping. At most `VIEW_RENDER_MAX_LENGTH` characters (else `RangeError`). Shares its slot with `render`: the latest of the two per target wins. |
| `set` | `(id: string, fields: { value?: string, checked?: boolean, focus?: boolean, scroll?: { top?: number, left?: number }, css?: Record<string, string \| null> }) => void` | Sets the value of an `input`, `textarea`, `select` or `output` (not a file input), the checked state of an `input`, focuses the element, sets its own scroll position (CSS px; never an ancestor's, never the host page's), or sets inline style properties of it (`css`; `null` removes one): only those of `VIEW_STYLE_PROPERTIES`, at most `VIEW_SET_STYLE_LIMITS.maxProperties` a call, each value at most `VIEW_SET_STYLE_LIMITS.maxValue` characters. Any other key, property or a field of another type is a `TypeError`; a value past `VIEW_RENDER_MAX_LENGTH` characters, or past the `css` limits, a `RangeError`. |
| `on` | `(type, id: string \| null, handler: (detail) => void, options?: { pointerCapture?: boolean, rect?: boolean, preventDefault?: boolean }) => () => void` | Subscribes to `click`, `input`, `change`, `submit`, `keydown`, `pointerdown`, `pointermove`, `pointerup`, `pointercancel`, `wheel`, `scroll`, `focusin` or `focusout` on the element with that id (or inside it), or anywhere with `null`. Returns `off`. The options, each `true` or left out: `pointerCapture` (a `pointerdown` handler with an id), `rect` (a handler with an id; its element's rectangle arrives as the detail's `rect`) and `preventDefault` (a `wheel` handler); anything else is a `TypeError`, and more than `VIEW_EVENT_LIMITS.maxIds` elements of one type with options a `RangeError`. |

The renderer is an allowlist: what it does not list is gone before insertion.

**HTML**: `address`, `article`,
`aside`, `footer`, `header`, `h1`, `h2`, `h3`, `h4`, `h5`, `h6`, `hgroup`, `main`, `nav`, `section`, `search`,
`blockquote`, `dd`, `div`, `dl`, `dt`, `figcaption`, `figure`, `hr`, `li`, `menu`, `ol`, `p`, `pre`, `ul`, `a`,
`abbr`, `b`, `bdi`, `bdo`, `br`, `cite`, `code`, `data`, `dfn`, `em`, `i`, `kbd`, `mark`, `q`,
`s`, `samp`, `small`, `span`, `strong`, `sub`, `sup`, `time`, `u`, `var`, `del`, `ins`, `img`, `picture`,
`source`, `video`, `audio`, `track`, `map`, `area`, `table`, `caption`, `colgroup`, `col`, `tbody`, `thead`,
`tfoot`, `tr`, `td`, `th`, `form`, `label`, `input`, `button`, `select`, `datalist`, `optgroup`, `option`,
`textarea`, `output`, `progress`, `meter`, `fieldset`, `legend`, `details`, `summary`, `dialog`, `style`, `link`.
Any other HTML element is unwrapped (its content takes its place and is checked in turn: `wbr`, `ruby`, `rt` and `rp`
are, for what their layout costs); a custom element name with a hyphen (`my-card`) is kept as an inert element; `iframe`, `frame`, `frameset`, `object`, `embed`, `applet`,
`portal`, `fencedframe`, `script`, `noscript`, `noembed`, `noframes`, `template`, `meta`, `base` and `title` go with
their content.

**SVG**: `svg`, `g`, `defs`, `symbol`, `title`, `desc`, `style`, `a`, `rect`, `circle`, `ellipse`, `line`,
`polyline`, `polygon`, `path`, `text`, `tspan`, `linearGradient`, `radialGradient`, `stop`, `clipPath`, `mask`,
`pattern`. **MathML**: `math`, `semantics`, `annotation`, `merror`, `mfrac`, `mi`, `mmultiscripts`, `mn`, `mo`,
`mover`, `mpadded`, `mphantom`, `mprescripts`, `mroot`, `mrow`, `ms`, `mspace`, `msqrt`, `mstyle`, `msub`,
`msubsup`, `msup`, `mtable`, `mtd`, `mtext`, `mtr`, `munder`, `munderover`, `none`. Any other SVG or MathML element
goes with its content.

**Attributes**: `id`, `class`, `style`, `title`, `lang`, `dir`, `hidden`, `tabindex`, `role`, `translate`, `inert`,
`spellcheck`, `inputmode`, `enterkeyhint`, `autocapitalize`, `data-*` and `aria-*` everywhere, and per element the
ones it needs (form controls, tables, lists, media, links; SVG geometry and presentation; MathML presentation).
Never an event handler. `src` and `srcset` keep a registered file's path, a relative URL (which loads nothing), or an
`https:` or `http:` URL of an origin [`origins`](#origins) lists for that load (`images` for `img` and `srcset`, `media`
for `audio`, `video`, their `source` and `track`), never `data:` or `javascript:`; `poster` keeps a registered file's
path or a relative URL only. A URL the view's policy might refuse is dropped before insertion, so the browser never
loads or refuses it: an `https:` or `http:` URL is kept only when its scheme, host and port are exactly those of a listed
origin (an `http:` URL of a listed `https:` origin is refused by every engine, so it is dropped). So write URLs in the
form you list them. Every `img`, `video`, `audio` and `link` gets `crossorigin="anonymous"`, the guest's own value
replaced, so its loads carry no credentials ([The view's loads](#the-views-loads)). A dropped `https:` or `http:` URL is
reported as a `violation` with the directive and the URL (without credentials or fragment), within the same cap; a URL
of any other scheme is dropped without a report (no engine would request it). CSS keeps no `https:` or `http:` URL: each
one a `style` attribute or a `<style>` names (`url()`, `@import`, `image-set()`, `@font-face`, a string) becomes `""`,
reported the same way, and a `<style>` keeps its text only. SVG `fill`, `stroke`, `clip-path` and `mask`
reference only `url(#id)`. Link clicks and form submissions navigate nowhere.

Not available in strict mode: `use`, markers, SVG filters, SVG `image`, `foreignObject` and animation; `canvas`,
`slot`, `selectedcontent` (customizable `select`); popovers (`popover`, `popovertarget`) and invoker commands
(`commandfor`, `command`); `autofocus`, `contenteditable`; form `action`, `formaction`, `method` and `target`;
`target` and `download` on links; SVG gradient and pattern templates (`href`). CSS filters, HTML images and inline
SVG cover most of it.

Text is kept, each run of adjacent text joined into one node; comments are dropped. The view holds
at most 50000 elements, nested at most 256 deep below its body, and at most 1048576 characters (its body's
serialization: text, attributes and markup alike), and at most 1000 URL-bearing attributes (`src`, `srcset`, `poster`,
and `<link>`'s `href`, whatever they name), counted over the document a render would leave (what is outside the target
stays): a render past any of them is dropped as a whole, the next one still applies, and the guest's log says
`[Sandbox] sandboxView.render: the view refused a render: …`. The view parses at most 1048576 characters of markup
per second, renders it refused included. It makes at most 200 loads per second, each charged before the browser can
start it: every URL-bearing attribute a render keeps, when it is rendered, and what the CSS an operation applies can
load, when it is applied, counted from the text of its style attributes and `<style>` elements (each `url(`,
`image-set(`, `image(`, `cross-fade(` and `src(`, in any case or escape, comments and strings included, and 200 for
each `@import` and stylesheet `<link>`). A load its document's resource timing reports (a CSS background, a font, a
stylesheet, whatever named it), or one its policy refused, that no URL attribute charged takes from what the CSS
prepaid, of which at most a second's worth is kept, and is charged once that is spent. What the browser does with a URL once it is rendered, loading
and decoding it, is no work of the view's, so its time budget cannot see it. Over its whole life one view loads at most
10000 distinct URLs (each stays in the engine's caches while the view lives; WebKit's host page stalled 1.2 s near
8 000 and 8.8 s near 43 000): a render whose URL attributes would take it past that is refused (`[Sandbox]
sandboxView.render: the view refused a render: the view would load more than 10000
distinct URLs in this environment; nothing of it was applied.`), and so is, once it is reached, a render carrying CSS
that can name a URL (a `<style>`, a stylesheet `<link>`, a `style` attribute with `url(`, `image-set(`, `@import` or a
backslash); a stylesheet already in the view still loads what it names. `reset()` starts a new view. The view spends on
average at most 200 ms of its own time per second on operations, measured (their layout and the rendering update that
shows them included; never time in which the view, hidden or off-screen, rendered nothing). An operation past any of
these waits, and so does the worker's next one (one in flight), so a flood of renders is slowed, not dropped. Each
operation is charged all it took, so the budget bounds the view's long-run share of the thread: an operation of 1.5 s
holds the next back for about 6.5 s. It does not bound each second: the budget holds one second's worth, so a single
second can hold more (simulated: up to 553 ms with operations of at most 200 ms;
[research 17](research/17_formal_methods/README.md)). One operation's own cost is bounded by time alone: one that takes
longer than 2000 ms is an overrun, charged in full like any other (it holds the next operation back at least 9 s), and
the view goes on, with one `warn` line per environment on `sandbox-log`; the second overrun within 5 minutes of the
one before it ends the sandbox (`the view spent more than 2000 ms on one operation twice within 5 minutes`). The time
is wall time, so a loaded machine reaches 2000 ms sooner: one overrun alone does not end the sandbox for that reason.
In WebKit the first `set()` of a 250 000-character textarea value (its value and first paint) is an overrun. Where the view shares your
page's thread, a task of your page's that runs while the view measures its rendering update is counted in it. CSS
animations and transitions, once rendered, are outside this budget: see
[`allowAnimations`](#allowanimations-and-allowautoplay).

Registered files are named by path in `src`, `href` and `poster`. The view shows only files that never open as a
document: CSS, PNG, JPEG, GIF, WebP, AVIF, APNG, BMP and ICO images, WOFF, WOFF2, TTF and OTF fonts, MP3, WAV, Ogg,
MP4, FLAC, WebM and AAC audio, MP4, WebM and Ogg video, and WebVTT; and the raster images the guest wrote (see
[Guest writes](#guest-writes)). Any other file (SVG, HTML, XML, JSON …) is the worker's through `sandboxFiles` only; a
reference to it stays as written and loads nothing. Show vector graphics as inline `<svg>`.

Links are inert: every link's `href` (HTML `a` and `area`, SVG `a` with `href` or `xlink:href`, MathML) becomes
`about:blank#` before insertion, so a rendered link stays a focusable link with the role `link`, its clicks and
Enter still reach `sandboxView.on`, and the browser's own actions on it (copy link address, open in a new tab,
drag) carry no URL of the guest's. To open external URLs, expose a host method and call it from a click handler. The
address is the guest's text, so parse it, allow only `https:` and the exact origins you list, and open the parsed `href`,
never the text (a `javascript:` or `data:` URL given to `window.open` runs in or takes over your page, and
`https://example.com@evil.example` is another host):

```js
const OPENABLE = new Set(['https://example.com']); // the origins you mean to open, exactly
function openable(text) {
    if (typeof text !== 'string' || text.length > 2048) return null;
    let url;
    try { url = new URL(text); } catch { return null; }
    return url.protocol === 'https:' && OPENABLE.has(url.origin) ? url.href : null;
}
sandbox.expose('openExternal', (text) => {
    const href = openable(text);
    if (href === null) throw new Error('openExternal: address not allowed');
    window.open(href, '_blank', 'noopener');
});
// in the worker: sandboxView.on('click', 'docs', () => bridge.call('openExternal', 'https://example.com/docs'));
```

`test/unit/attacker-text-docs.test.ts` runs this snippet as written against hostile addresses.

An event handler receives:

```ts
{
    type: 'click' | 'input' | 'change' | 'submit' | 'keydown' | 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel'
        | 'wheel' | 'scroll' | 'focusin' | 'focusout',
    ids: string[],                       // ids of the target and its ancestors, nearest first
    target: { tag: string, id: string, name: string, value: string, checked: boolean },
    key?: string,                        // keydown
    form?: [name: string, value: string][], // submit
    pointer?: {                          // pointer*, wheel (x and y only): view CSS px, clamped to the view's box, rounded to 0.1
        x: number, y: number, id: number, kind: 'mouse' | 'pen' | 'touch',
        primary: boolean, button: number, buttons: number, pressure: number,
    },
    wheel?: { dx: number, dy: number, dz: number, unit: 'pixel' | 'line' | 'page' }, // the deltas it stands for, summed
    scroll?: { top: number, left: number, width: number, height: number, clientWidth: number, clientHeight: number },
                                         // scroll: the scrolled element's position and extent (the document's: its root)
    rect?: { x: number, y: number, width: number, height: number }, // with the `rect` option: the handler's element, view CSS px
    modifiers?: { alt: boolean, ctrl: boolean, meta: boolean, shift: boolean }, // pointer*, wheel
    time?: number,                       // pointer*, wheel, scroll: the event's timeStamp, whole ms
    coalesced?: number,                  // pointermove, wheel, scroll: how many raw events this one stands for
    truncated?: true,                    // something in this detail was cut
}
```

Never a URL. Strings are cut at 65536 characters, `ids` at 32 entries, `form` at 1000 fields, and all strings of
one detail together at 262144 characters (of one frame of events, when the view sends several at once); a detail that
was cut has `truncated: true`. A handler that throws is logged and does not stop the others. [ADR-005](ADR-005-strict-mode.md)

**Pointer, wheel, scroll and focus input** ([research 23](research/23_view_input/README.md)), for drag-and-drop within
the view, gestures, custom sliders and virtual lists, all of it guest code in the worker:

- **Only the view's own, trusted events**, as numbers and constants besides the target's strings. Pointer coordinates
  are in the view's CSS px, rounded to 0.1 and clamped to its box: a press that begins in the view goes on delivering
  moves over your page until it is released, in every browser, so a move outside the view is forwarded only while such a
  press is held, at the view's edge, with the modifier keys held, as any iframe's document receives them. Nothing else of
  your page's own input reaches the guest: no keystroke, no coordinate past the edge, no element of yours. `focusin` and
  `focusout` say which of the view's elements gained or lost focus, never where it went (no `relatedTarget`), so a
  `focusout` with no `focusin` after it tells the guest that focus left the view, as the `blur` of a window tells an
  iframe. The guest can raise them itself: `set(id, { focus: true })` moves focus while the view has it, one `set` a
  flush, charged to the view's time budget.
- **Continuous events are coalesced**: `pointermove` per pointer, `wheel` per element and unit (its deltas summed),
  `scroll` per scrolled element (its position and extent read when it is sent), the latest winning, `coalesced` counting
  the raw events. The view sends what it holds at most once per animation frame, and only once the worker has
  acknowledged the last frame of events it sent (`VIEW_INPUT_IN_FLIGHT`, 1; the worker acknowledges a frame once its
  handlers have returned). A handler that blocks gets, when it returns, one frame with the latest state. The discrete
  events (`pointerdown`, `pointerup`, `pointercancel`, `focusin`, `focusout` and the five others) go at once, after
  whatever the view held, so a `pointerup` never overtakes the last move. The view's time spent on its events is charged
  to its time budget, with its operations ([The view's cost](#a-the-long-run-bound)).
- **`pointerCapture`**: on a trusted `pointerdown` in the element, the view captures the pointer to it, in the event, so
  the moves and the release keep naming the element in `ids` after the pointer leaves it (a slider's thumb, a drag), and
  cancels a native drag or a text selection inside it until the release.
- **`rect`**: the worker cannot read layout, so the view gives a handler that asks its element's rectangle,
  `rect: { x, y, width, height }` in view CSS px, read once per frame of events. Layout also tells the guest the view's
  rendering environment: a `@media` rule in its CSS changes an element's size, and `rect` or `set({ scroll })` reads it,
  so the guest can learn the colour scheme, reduced motion, contrast, forced colours, pointer, hover and resolution media
  features of the view's document, as an opaque iframe does with `matchMedia`. A worker has no `matchMedia`, `screen` or
  `devicePixelRatio` of its own.
- **`preventDefault`**: the view cancels the wheel's default (scrolling) inside the element, or anywhere with `null`.
  While such a subscription exists, scrolling over the sandbox waits for the view's thread, as over any frame with a
  wheel listener that is not passive.
- **The answer**: `set(id, { css })` sets inline style properties of one element (HTML, SVG or MathML) from
  `VIEW_STYLE_PROPERTIES`: `transform`, `translate`, `rotate`, `scale`, `transform-origin`, `opacity`, `visibility`,
  `left`, `top`, `right`, `bottom`, `width`, `height`, `z-index`, `cursor` and custom properties (`--name`, letters,
  digits, `-` and `_`); `null` removes one. At most 16 properties a call (`VIEW_SET_STYLE_LIMITS.maxProperties`), each
  value at most 1024 characters (`VIEW_SET_STYLE_LIMITS.maxValue`). No animation or transition property, so
  `allowAnimations: false` holds; a value that names a URL (`cursor`, a custom property) is treated like a `style`
  attribute's: an `https:` or `http:` URL is replaced with `""` and reported as a `violation`, what remains is charged to
  the view's loads, and the view's policy applies to it; what the `style` attribute grows by counts against the
  view's characters, and a set past them is refused whole. `set(id, { scroll: { top, left } })` sets that element's own
  scroll position, never an ancestor's or your page's; the `scroll` event it raises is trusted and coalesced like the
  user's, so a guest that answers its own scroll events does so at most once a frame.
- **Touch**: pinch and rotation come from two pointer ids. Give the element `touch-action: none` (or `pan-y`) in the
  guest's CSS, or the browser takes the gesture for panning and sends `pointercancel`.
- **Not available**: native drag-and-drop with data from outside the view (files, a selection of your page's), no drag
  event is subscribable; `pointerrawupdate`, coalesced and predicted point lists, tilt, twist and contact size; `touch*`
  and `gesture*` events; `keyup`.

Measured (2026-10-24, headless, a shared 4-core VM; [research 23](research/23_view_input/README.md#23-latency)): a
60 Hz drag answered with `set({ css })` is rendered a median 28 ms (Chromium), 25 ms (Firefox) and 50 ms (WebKit) after
the move, one frame of it the worker's round trip, at 0–3% of your page's thread.

`render`, `text` and `set` go to the view in order, one at a time: an id that names no element in the view's body is
dropped, and the next one applies. What `text` and `set` leave in the view counts against its characters and the
characters it handles per second, as a render does (an input's value as its `value` attribute, a textarea's and an
output's as their text); past the budget the operation is dropped and the guest's log says
`[Sandbox] sandboxView.text: the view refused it: …`. `set({ focus: true })` moves focus within the sandbox only while
the user's focus is in it (the view's `document.hasFocus()`: the user last clicked or tabbed into the sandbox, and the
window is focused). Otherwise it is refused, the host page keeps its focused element and its keystrokes, and the log
says `[Sandbox] sandboxView.set: the view refused focus: …`; a `value` or `checked` in the same call still applies. A
non-focusable element is left as it is. Without this rule a sandboxed frame's `focus()` takes focus from the host
page in Chromium and Firefox, with no user activation (measured; cooperative mode's limit).

---

## Modes

| | `sealed` (default) | `strict` | `cooperative` | `worker` |
| :--- | :--- | :--- | :--- | :--- |
| For | content you do not trust | content you do not trust that needs the network | cooperative content | headless code (frozen) |
| Guest code runs in | a worker; the view runs only the library's hash-admitted script | as sealed | the guest document | a worker spawned inside the frame |
| Guest markup | `html` is the initial view, rendered without scripts or handlers; then `sandboxView.render()` | as sealed | `html` / `load()` | none |
| How code starts | `entry`, `execute()` | `entry`, `execute()` | markup scripts, `execute()` | `execute()` |
| Network | none: the view's fetch directives are `'none'` or `blob:` for registered files, `connect-src 'none'`; a config that names `origins` or `fetchBridge` is refused | `origins`, `fetchBridge` | `origins`, `fetchBridge` | `origins`, `fetchBridge` |
| `autoResize` | ✓ | ✓ | ✓ | — |
| `workerExecutionTimeout` | ✓ | ✓ | — | ✓ |
| Watchdog bounds a loop | ✓ | ✓ | where the frame runs in its own process | ✓ |
| `unsafeCapabilities` | — | — | ✓ | ✓ |
| Files named from markup | `src`, `href`, `poster` in rendered markup | as sealed | ✓ | — |
| Worker globals | allowlist | allowlist | — | allowlist |

A config without `mode` is sealed; strict mode is named with `mode: 'strict'`. Sealed mode is strict mode with no
network: the same view, worker, renderer and bootstrap, with a view policy (its worker inherits it) that admits no
network source, and `sandboxFetch()` rejects with `FETCH_NOT_ALLOWED`. A config with no `mode` that names `origins` or
`fetchBridge` is refused with the reason
`` origins and fetchBridge open the network, which sealed mode (the default) does not have: set `mode: 'strict'` ``.
`'iframe'` is not a mode; it starts nothing, like any value that is not a mode. [ADR-005](ADR-005-strict-mode.md),
[ADR-008](ADR-008-sealed-mode.md)

### Migrating to sealed as the default

What changes for an embed written when strict mode was the default:

| You have | Now | What to do |
| :--- | :--- | :--- |
| no `mode`, and no `origins` or `fetchBridge` | sealed mode: the same view, worker and API, nothing visible changes. A `<script>` or `on…` handler in `html` behaves as in strict mode: it never runs, and the one warning says `sealed mode (the default) runs no script in html; …`. `connect-src` has no `blob:`, so a guest `fetch()` of its own file's URL is refused: read the file with `sandboxFiles.read()` or `text()` | nothing |
| no `mode`, with `origins` or `fetchBridge` | refused: nothing is built, and the sandbox terminates with the reason `` origins and fetchBridge open the network, which sealed mode (the default) does not have: set `mode: 'strict'` ``; in TypeScript, a type error | add `mode: 'strict'` |
| `mode: 'strict'`, `'cooperative'` or `'worker'` | unchanged | nothing |
| TypeScript that types a config with no mode as `StrictSandboxConfig` | `mode` is required there | add `mode: 'strict'`, or type it `SealedSandboxConfig` |
| a host page policy that lists origins for the sandbox in `img-src`, `connect-src` and so on | sealed mode needs none of them | keep `blob:`; drop the origins if nothing else of the page needs them |

**What strict mode does not cover**: the host page's availability wherever the view shares the host page's thread
(Firefox, Safari and WebKit, Android, Chromium without sandboxed-iframe isolation; desktop Chromium 127+ runs it in a
process apart from the page's, which the page's other sandboxes can share): there the view's cost is the bound stated in [The view's cost to the host page](#the-views-cost-to-the-host-page),
and what it lists as outside it. Cooperative mode is no better there. Also
CSS probing the view's own content (CSS loads nothing from the network there), the worker's own `violation` reports beyond the [request gate's](#the-request-gate) (per engine, guest-influenced), a worker that closes itself (only the watchdog notices) and memory. No request of strict mode carries a cookie: its worker opens [no `WebSocket`](#strict-no-websocket), and its view's loads carry none ([The view's loads](#the-views-loads)).

**Cooperative-mode limits**, a frozen list (cooperative content only: the library adds no guest-realm patches for
new findings there, it lists them): same-thread execution; frames and workers the guest creates; WebKit's preconnect;
requests the gate does not cover (`sendBeacon()`, `EventSource`, `<a ping>`: [their cookies](#cookie-carriers)); focus and the clipboard; messages to the host window; the user's link actions and modifier clicks the guest's script
synthesizes (a new top-level tab without `allow-popups`; with `allow-forms`, Chromium submits a form that way past
`form-action`); session history; guest-only stalls; forgeable reports; the host page's URL and origin; the host page's
Trusted Types requirement. Each is described in the
[README](../README.md#cooperative-mode-limits). Worker mode shares only the reports: the worker's are per engine, as
in strict mode.

---

## Building an app in sealed mode

An app is a bundle the user saved, plain HTML and CSS plus its JavaScript logic, and your page drives it from outside: the
host is the app's only input and output, and sealed mode (the default) is what the app runs in. The code below is
[`examples/sealed-app/`](../examples/sealed-app), a todo list; `test/e2e/sealed-app.spec.ts` runs it on all three
engines, and each block here is generated from its file (`bun run docs:gen`), so the page cannot drift from the code.

### The bundle

- **`html`** is the app's initial view: markup the renderer cleans before it shows it. A `<script>` or an `on…` handler
  in it never runs; the code goes in `entry`.
- **`entry`** is the app's JavaScript, a registered file that runs in the worker with `bridge`, `sandboxFiles` and
  [`sandboxView`](#sandboxview-strict-mode).
- **CSS, images, fonts and media** are registered files, named by path in the markup (`href`, `src`, `poster`). The view
  shows the types listed under `sandboxView` (raster images, fonts, audio, video, CSS, WebVTT); an SVG, HTML or JSON file
  is the worker's, read with `sandboxFiles`, and a vector graphic is an inline `<svg>`.
- Register the files before `setConfig()`: they reach the app at the next build. At most 1000 files and 8 MiB in all
  ([Limits](#limits)).

<!-- generated:begin example:sealed-app-html -->
```html
<link rel="stylesheet" href="app.css">
<h1><img src="logo.png" alt="" width="24" height="24"> Todo</h1>
<form id="add"><input id="new" name="text"> <button>Add</button></form>
<ul id="list"></ul>
<p><span id="count"></span> <span id="badge"></span></p>
```
<!-- generated:end -->

<!-- generated:begin example:sealed-app-css -->
```css
h1 { font: 600 18px sans-serif; color: rgb(34, 170, 119); }
li { list-style: none; font: 14px sans-serif; }
```
<!-- generated:end -->

### The host

<!-- generated:begin example:sealed-app-host -->
```js
// The embedder's side: register the bundle, answer the app's calls, feed it data.
export async function mountTodoApp(sandbox, { bundle, store }) {
    const get = (name) => fetch(`${bundle}/${name}`);
    sandbox.registerFiles({
        'app.js': await (await get('app.js')).text(),
        'app.css': await (await get('app.css')).text(),
        'logo.png': new Uint8Array(await (await get('logo.png')).arrayBuffer()),
    });

    // The app's call runs here with your page's rights, and its argument is the app's data: check its type and size,
    // and keep a copy of what you expect, not the object itself.
    sandbox.expose('save', (todos) => {
        if (!Array.isArray(todos) || todos.length > 1000) throw new Error('save: expected at most 1000 todos');
        const clean = todos.map((todo) => {
            if (typeof todo?.text !== 'string' || todo.text.length > 200 || typeof todo.done !== 'boolean') throw new Error('save: bad todo');
            return { text: todo.text, done: todo.done };
        });
        store.setItem('todos', JSON.stringify(clean));
    });

    sandbox.setConfig({ entry: 'app.js', html: await (await get('app.html')).text(), guestWrites: true });
    await sandbox.call('load', JSON.parse(store.getItem('todos') ?? '[]')); // queued until the app is ready
}

// A stream: the host sends a batch when it has one, and the next only after the app took the last.
export async function pushAll(sandbox, todos, batchSize = 50) {
    for (let at = 0; at < todos.length; at += batchSize) await sandbox.call('push', todos.slice(at, at + batchSize));
}
```
<!-- generated:end -->

### The app

<!-- generated:begin example:sealed-app-guest -->
```js
let todos = [];

async function show() {
    const open = todos.filter((todo) => !todo.done).length;
    sandboxView.render(todos.map((todo, i) =>
        `<li id="todo-${i}"><input type="checkbox" id="done-${i}"${todo.done ? ' checked' : ''}> <span id="text-${i}"></span></li>`).join(''), 'list');
    todos.forEach((todo, i) => sandboxView.text(`text-${i}`, todo.text)); // text, never markup: nothing to escape
    sandboxView.text('count', `${open} open`);

    // an image the app makes: drawn in the worker, written as a file, shown by its path
    const canvas = new OffscreenCanvas(60, 8);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ddd';
    context.fillRect(0, 0, 60, 8);
    context.fillStyle = '#2a7';
    context.fillRect(0, 0, 60 * (todos.length - open) / Math.max(1, todos.length), 8);
    await sandboxFiles.write('progress.png', await canvas.convertToBlob({ type: 'image/png' }));
    sandboxView.render('<img src="progress.png" alt="progress" width="60" height="8">', 'badge');
}

// host -> app
bridge.expose('load', (saved) => { todos = saved; return show(); });
bridge.expose('push', (batch) => { todos.push(...batch); return show(); });

// user -> app -> host
sandboxView.on('submit', 'add', (event) => {
    const text = event.form.find(([name]) => name === 'text')[1].trim().slice(0, 200);
    if (text === '') return;
    todos.push({ text, done: false });
    sandboxView.set('new', { value: '' });
    show().then(() => bridge.call('save', todos));
});
sandboxView.on('change', 'list', (event) => {
    todos[Number(event.ids[0].slice('done-'.length))].done = event.target.checked;
    show().then(() => bridge.call('save', todos));
});
```
<!-- generated:end -->

### Host to app: data, commands and a stream

The app publishes methods with `bridge.expose()` and the host calls them with `sandbox.call(name, ...args)`: `load` hands
it the saved state, `push` a batch of todos. A call made while the sandbox is loading is queued and sent when it is ready,
which is why `mountTodoApp` can call `load` right after `setConfig()`.

- **A stream is `push(batch)` called at the host's own pace.** Await each call (`pushAll`): it resolves when the app's
  method returns, so return the app's work (`return show()`) and the next batch goes out only after the app took the
  last. A handler that renders a lot is slowed by [the view's budgets](#a-the-long-run-bound), and awaiting is what keeps
  the host from queuing faster than the app can show.
- **Arguments and results are copied** (structured clone, not transferred): at most `RPC_MAX_BYTES` (33 MiB) a message, 256
  calls in flight per side, 30 s to answer unless `callWithTimeout()` says otherwise. Your calls to the app are not counted
  by [`callLimits`](#calllimits); the app's calls to you are (1000 a second and 64 MiB by default, its guest writes
  included). The refusals are the [`RpcErrorCode`s](#calls-rpcerrorcode) of [`call()`](#callmethod-args).

### App to host

The host publishes methods with `sandbox.expose()` and the app calls them with `bridge.call(name, ...args)` (`save` above).

**Security note for embedders: an exposed method runs with your page's full rights, and its arguments are the app's data.**

- **Validate every argument**: its type, its length and the shape of what it holds, as `save` does, and keep a copy of what
  you expect (spread or a new object), not the object you were given.
- **Never pass the app's text to a sink that reads it as code or as an address**: not `innerHTML`, `eval`, `new Function`,
  `window.open`, `location` or a link `href`. Show it with `textContent`. When the app has to open a URL, expose
  one method with the guard of the [`openExternal` example](#sandboxview-strict-mode) (parse it with `new URL()`, admit
  `https:` and an exact list of origins, open the parsed `href`).
- **Never expose a generic proxy**: no `fetch(url)`, no `get(key)`/`set(key, value)` over `localStorage` or IndexedDB, no
  `run(name, ...args)` dispatcher. Each method does one thing the app needs, to a destination you fixed (this app's own
  storage key, a listed endpoint), at a size you capped. Sealed mode has no network, so what you expose is the app's only
  way out: a proxy hands it your page's network, cookies and storage.
- A throw reaches the app as `HANDLER_ERROR` with the message you threw: put nothing in it you would not tell the app.

### Saving the app's state

Two routes, and the host decides what is kept in both:

- **An exposed `save` method** (the example): the app sends its state as plain data and the host validates and stores it
  wherever it keeps apps (`localStorage` here), and hands it back with the next `load`. The rule above applies.
- **Guest writes**: with `guestWrites: true` the app writes files with `sandboxFiles.write()`, the host sees them in
  `listGuestWrites()` (and `fileswritten`), and `commitGuestWrites(paths)` makes the ones it accepts registered files for the
  next build, where the app reads them with `sandboxFiles.text()`. Treat what the app wrote as the app's data, its
  path and type as well as its bytes: check the size, parse it in a `try`, check its shape, show it with `textContent`.
  Only inert types commit without `{ code: true }`; leave code out for an app's data
  ([Guest writes](#guest-writes)).

### Images the app makes

The view shows the **raster images the app wrote** (PNG, JPEG, GIF, WebP or AVIF, never SVG), by path, with no rebuild:
`progress.png` above is drawn on an `OffscreenCanvas` in the worker, written with `sandboxFiles.write()` (it needs
`guestWrites: true`) and named in the next `render()`. A later write to the path replaces the image. The view has no
`<canvas>`, so the pixels are made in the worker, or the host sends bytes with `call()` and the app writes them. Registered
images are fixed at the build; see [Guest writes](#guest-writes) for what the view shows.

The app cannot `fetch()` its own files either: sealed mode's `connect-src` is `'none'`, so `fetch(sandboxFiles.url(path))` is
refused. Read them with `sandboxFiles.read()` or `text()`, which make no request.

### Input

`sandboxView.on(type, id, handler)` delivers the user's input to the app: the example reads a `submit` (the form's fields
arrive in `event.form`) and a `change` (the checkbox), and clears the field with `sandboxView.set('new', { value: '' })`.
For drag and drop, sliders, gestures and virtual lists use the pointer, wheel and scroll events with the `pointerCapture`,
`rect` and `preventDefault` options, and answer with `set(id, { css, scroll })`: [Pointer, wheel, scroll and focus
input](#sandboxview-strict-mode) describes them, and [research 23](research/23_view_input/README.md) measures them.

### What a sealed app cannot do

| It cannot | The way out |
| :--- | :--- |
| Reach the network: `fetch`, `XMLHttpRequest`, `WebSocket`, an `<img>` or a font from a URL | `mode: 'strict'` with [`origins`](#origins) or [`fetchBridge`](#fetchbridge), or have the host fetch and pass the data with `call()`, or register it as a file |
| Run a `<script>` or a handler in `html` | put the code in `entry` |
| Use a `<canvas>`, SVG animation, SVG filters, `contenteditable`, popovers | draw with `OffscreenCanvas` and write a raster image; inline `<svg>` for static vector graphics; `<textarea>` or `<input>` for editing; CSS animations with [`allowAnimations`](#allowanimations-and-allowautoplay) |
| Use WebAssembly (`WebAssembly` is removed from the worker, [research 24](research/24_sealed_mode/README.md)) | write the code in JavaScript, or run the module in your page and pass the results with `call()` |
| Open a link or a window | an exposed method with the `openExternal` guard |

---

## Limits

<!-- generated:begin limits -->
| Limit | Value | Exported constant |
| :--- | :--- | :--- |
| Inbound calls running at once, per side and environment | 256 | `MAX_INBOUND_IN_FLIGHT` |
| Guest calls per second, per environment (any one-second window; default of `callLimits.maxPerSecond`) | 1000 | — |
| Bytes of guest calls per second, per environment (any one-second window; default of `callLimits.maxBytesPerSecond`) | 67108864 (64 MiB) | — |
| Default call timeout (ms) | 30000 | — |
| Characters of a `Blob`'s or `File`'s `type` (longer is over every byte budget on every engine that keeps the type; Chromium empties one of 65 536 characters or more) | 4096 | — |
| Characters of the kind a message names when it refuses a value it does not know (a guest chooses the tag; the name is cut) | 64 | — |
| Objects a log line is walked through to turn its errors into plain records (an error past it stays, and the measure names it as unsupported) | 10000 | — |
| Levels of that walk | 64 | — |
| Characters of a method name | 256 | — |
| Characters of an error message a call carries | 65536 | — |
| Guest log lines per second, per environment | 1000 | `LOG_EVENTS_PER_SECOND` |
| Guest log lines kept until the guest is connected | 1000 (and 4 MiB) | — |
| Library lines (`own`: its Ready line and the relay's warnings) the host dispatches outside the guest's log window, per environment; past it a marked line counts as the guest's | 4 | — |
| Arguments kept per log line | 64 | `LOG_MAX_ARGS` |
| Characters kept per string log argument | 65536 | `LOG_MAX_STRING` |
| Bytes per log line, all arguments together | 1048576 (1 MiB) | — |
| Bytes of guest log lines sent per second | 4194304 (4 MiB) | — |
| Uncaught errors and unhandled rejections per second, per environment (worker and strict mode; rejections handled later included); past it the sandbox ends | 1000 | — |
| Characters of uncaught errors and unhandled rejections per second, per environment (worker and strict mode; their names and messages); past it the sandbox ends | 1048576 | — |
| Bytes per RPC message (arguments, or a result) | 34603008 (33 MiB) | — |
| Bytes of arguments in inbound calls running at once, per side and environment | 67108864 (64 MiB) | — |
| `violation` events per environment (strict mode: per source, and per directive for the view) | 100 | `VIOLATION_EVENT_LIMIT` |
| Auto-size: tallest height (px) | 100000 | `AUTO_RESIZE_MAX_HEIGHT` |
| Auto-size: height changes per second (and at most one per frame) | 30 | `AUTO_RESIZE_MAX_UPDATES_PER_SECOND` |
| Strict: characters per `sandboxView.render()`, `text()` or `set()` value | 262144 | `VIEW_RENDER_MAX_LENGTH` |
| Strict: characters of a render or event target id | 1024 | — |
| Strict: elements in the view | 50000 | — |
| Strict: characters in the view (its body's serialization) | 1048576 | — |
| Strict: characters of markup the view parses per second | 1048576 | — |
| Strict: time the view spends applying operations per second, their layout and rendering included (ms) | 200 | — |
| Strict: longest operation of the view, its layout and rendering included (ms; a longer one is an overrun, and the second within the next row's window ends the sandbox) | 2000 | — |
| Strict: window of the view's repeated-overrun rule (ms, from the first of two overruns) | 300000 | — |
| Strict: URL-bearing attributes in the view (`src`, `srcset`, `poster`, `<link>`'s `href`) | 1000 | — |
| Strict: loads of the view per second (URL-bearing attributes rendered, and every other load or refused load the browser reports) | 200 | — |
| Strict: distinct URLs one view loads, over its life | 10000 | — |
| Strict: nesting depth below the view's body | 256 | — |
| Strict: characters of one event detail, all strings together | 262144 | — |
| Strict: frames of the view's events the worker has not acknowledged, past which the view holds pointer moves, wheel and scroll events back, coalesced (at most one per pointer or element, sent at most once per animation frame) | 1 | `VIEW_INPUT_IN_FLIGHT` |
| Strict: style properties one `sandboxView.set(id, { css })` names | 16 | — |
| Strict: characters of one style value (or custom property name) of `set({ css })` | 1024 | — |
| Strict: view liveness budget (ms) | 5000 | `VIEW_LIVENESS_TIMEOUT_MS` |
| Longest `loading`, until the guest checks in (ms of host time) | 5000 | `LOAD_TIMEOUT_MS` |
| `workerExecutionTimeout`: how long the event loop may stay busy past a deadline (ms) | 1000 | `EXECUTION_TIMEOUT_GRACE_MS` |
| Files: total bytes | 8388608 (8 MiB) | — |
| Files: count | 1000 | — |
| Files: path length | 256 | — |
| Fetch: default `maxBytes` | 1048576 (1 MiB) | — |
| Fetch: largest `maxBytes` | 33554432 (32 MiB) | — |
| Fetch: default `timeoutMs` | 10000 | — |
| Fetch: largest `timeoutMs` | 120000 | — |
| Fetch: default `maxConcurrent` | 4 | — |
| Fetch: largest `maxConcurrent` | 16 | — |
| Fetch: headers of one `sandboxFetch()` request | 64 | — |
| Fetch: characters of a request header value | 8192 | — |
| Fetch: characters of a URL, as written and as parsed | 8192 | — |
| Fetch: characters of a response's status text and headers, together | 262144 | — |
| Pairs of objects `setConfig()` compares with the configuration the environment was built from (and 64 levels deep); past it the configurations count as different, which only costs a rebuild | 10000 | — |
| Guest writes: requests per second, per environment | 100 | `GUEST_WRITES_PER_SECOND` |
| Guest writes: bytes per second, per environment | 8388608 (8 MiB) | `GUEST_WRITE_BYTES_PER_SECOND` |
<!-- generated:end -->

The same limits by channel of guest activity, each with the test that checks it: [Budgets](#budgets).

**What the byte measure counts.** The byte limits above (a log line, an RPC message, the arguments of calls running at
once) are measured with the one measure of `call()`, on the snapshot a sender posts, which is the only form of a value that
leaves a sandbox. It is a closed set of kinds, and counts every field the receiver is handed. Every object, of any kind, costs 16, and an
object met again 8. A string costs two bytes a code unit plus 8; a `BigInt` its two's-complement bytes plus 8 (found by its
hexadecimal digits); any other primitive 8. A plain object adds its keys, each like a string, and their values; a `Map`
16 an entry and its key and value; a `Set` 8 an entry and its value; a `Date` nothing more; a `RegExp` two bytes a character
of its source plus 24; an array the more of its `length` times 8 and its keys, so a sparse array of 2**32 - 1 slots is past
every limit; an `ArrayBuffer` its byte length; a typed array or a `DataView` its whole buffer, once; a `Blob` 64 plus its
`type` like a string; a `File` that plus its `name` like a string and 8 for `lastModified`. Any other kind (an `Error`, an `ImageData`, a `SharedArrayBuffer`) is refused as
unsupported. The library's own walks of a delivered value follow its own keys, never an array's `length`. A `Blob` or
`File` whose `type` is longer than `BLOB_TYPE_MAX_LENGTH` (4096) characters is over every byte budget and is refused as
one past the budget, on every engine that keeps the type: Chromium empties a type of 65 536 characters or more when the
object is made, so there the guest holds a `Blob` of no type, which is sent as it is (Firefox and WebKit keep it whole and
refuse it; the [engine ledger](THREAT-MODEL.md#engine-blob-type-emptied)). The limit is the library's, not the engine's, for
a type of 4097 to 65 535 characters. A type of up to 4096 characters crosses on every engine.

---

## Budgets

Every channel through which guest activity makes the host page, the view or the network do work, with its bounds in
count, bytes and time, the constant behind each, the bound on what it costs the host page, what it reaches of the network
in sealed mode (nothing), and the test that checks it.
A channel with no bound in one of the three says why in that cell. The table is `CHANNEL_BUDGETS` of
`src/lib/egress.ts` rendered with the code's values (`test/unit/budgets.test.ts` keeps the rest equal), next to the egress
table of every surface those channels cross: a surface that relays, budgets or caps and is no channel's fails that test.

It is also where a documented cost to the host page lives: a finding whose only effect is that the guest slows the host
page, within a stated bound the embedder can end, is fixed by that bound in the cost column (for the strict view, by
[The view's cost to the host page](#the-views-cost-to-the-host-page)). The cost column states bounds only: a share, a cap
or a constant. Measured figures stand in the note under the table, with their date and engines.

<!-- generated:begin budgets -->
| Channel | Count | Bytes | Time | Bound on the cost to the host page | Network in sealed mode | Test |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Guest log lines, to `sandbox-log`: the console relay, and the uncaught errors and rejections it relays | `LOG_EVENTS_PER_SECOND` (1000) lines in any second, counted by the guest and again by the host; `LOG_MAX_ARGS` (64) arguments a line | `LOG_MAX_BYTES` (1048576) a line, measured by both ends, placeholders included; `LOG_BYTES_PER_SECOND` (4194304) a second, by the guest; a string argument cut at `LOG_MAX_STRING` (65536) characters | none of its own: one event a line | none beyond the count and the bytes | none: the lines reach the host page only | test/unit/relay-and-rpc-budgets.test.ts (R3-3); test/unit/structural.test.ts |
| Uncaught errors and unhandled rejections of the guest's worker, which the browser reports (worker and strict mode) | `UNCAUGHT_PER_SECOND` (1000) in any second, rejections handled later included; past it the sandbox ends | `UNCAUGHT_CHARACTERS_PER_SECOND` (1048576) characters of their names and messages in any second; past it the sandbox ends | none of its own: the count and the characters | Firefox reports each on the host page's thread, cancelled or not: bounded by the count and the characters, and past them the sandbox ends; one report is not bounded, since the browser makes it before the sandbox can end | none | test/e2e/error-cost-and-queued-calls.spec.ts (N-1); test/unit/egress.test.ts |
| Calls the guest makes (`bridge.call`), to the embedder's methods | `callLimits.maxPerSecond` in any second, by default `GUEST_CALLS_PER_SECOND` (1000), counted by the guest and again by the host; `MAX_INBOUND_IN_FLIGHT` (256) running at once | `RPC_MAX_BYTES` (34603008) a call, its whole frame measured by both ends; `callLimits.maxBytesPerSecond` a second, by default `GUEST_CALL_BYTES_PER_SECOND` (67108864); `RPC_MAX_INBOUND_BYTES` (67108864) of arguments running at once; a method name of at most `MAX_NAME_LENGTH` (256) characters | none of its own: the embedder's methods run as long as they take | none beyond the count and the bytes | none of the library's: the embedder's methods are the guest's only way out, so they are all it can reach | test/unit/rpc-bounds-and-call-limits.test.ts (M-2, C-1); test/unit/config-schema.test.ts; test/unit/rate-limit.prop.test.ts |
| Answers to the host's calls (`bridge.expose`) | one a call the host made: the host's pending calls | `RPC_MAX_BYTES` (34603008) an answer, measured by both ends; an error text cut at `MAX_TEXT_LENGTH` (65536) characters by both ends | the host's call timeout (`callWithTimeout`; by default `DEFAULT_TIMEOUT_MS` (30000) ms) | none beyond the host's pending calls and the bytes | none | test/unit/rpc-bounds-and-call-limits.test.ts (C-1); test/unit/structural.test.ts |
| Guest writes (`sandboxFiles.write`, `remove`) | `GUEST_WRITES_PER_SECOND` (100) requests in any second, and each as a call; what is kept, at most `MAX_FILES` (1000) files with the registered ones | `GUEST_WRITE_BYTES_PER_SECOND` (8388608) in any second; what is kept, at most `MAX_TOTAL_BYTES` (8388608) with the registered files | none of its own: the count and the bytes | none beyond the count and the bytes | none: the host keeps them | test/unit/guest-writes.test.ts; test/e2e/guest-writes.spec.ts |
| `sandboxFetch()`: a request the host decides and the bridge's frame makes, on the guest's behalf | `fetchBridge.maxConcurrent` at once, at most `MAX_MAX_CONCURRENT` (16); and each as a call | `fetchBridge.maxBytes` a response, at most `MAX_MAX_BYTES` (33554432); its status text and headers at most `MAX_RESPONSE_HEAD` (262144) characters together | `fetchBridge.timeoutMs` a request, at most `MAX_TIMEOUT_MS` (120000) ms | none beyond the count, the bytes and the time: each request is one fetch of the bridge's frame (an opaque origin: no Service Worker, no wrapper of the host page's), its body crossing to the host page one chunk at a time, as the host reads it | none: `sandboxFetch()` rejects in the guest with `FETCH_NOT_ALLOWED` and sends nothing; no bridge frame is built | src/lib/fetch-bridge.test.ts; test/e2e/fetch-bridge.spec.ts; test/e2e/fetch-bridge-isolation.spec.ts; test/unit/sealed-build.test.ts; test/e2e/sealed-no-network.spec.ts |
| CSP violation reports, to `violation` | `VIOLATION_EVENT_LIMIT` (100) events an environment (strict mode: per source, and per directive for the view) | each string cut at `VIOLATION_MAX_STRING` (2048) characters before it is posted, by the bootstrap and by the view, and again by the host on receipt | none of its own: the count | none beyond the count | none: every request the guest tries is refused and reported here, the request gate's refusals included | src/lib/in-sandbox-script.test.ts (violation reports); test/e2e/violations.spec.ts; test/unit/structural.test.ts; test/e2e/sealed-no-network.spec.ts |
| Content heights (`autoResize`), to the frame's height | `AUTO_RESIZE_MAX_UPDATES_PER_SECOND` (30) a second, and one a frame | a number, at most `AUTO_RESIZE_MAX_HEIGHT` (100000) px | none of its own: one relayout of the host page's frame a change | a cap: `AUTO_RESIZE_MAX_UPDATES_PER_SECOND` (30) relayouts of the host page's frame a second | none | src/lib/auto-resize.test.ts; test/e2e/auto-resize.spec.ts |
| Liveness answers (PONG, VIEW_PONG), to the host's probes | one a probe of the host's | a number | `VIEW_LIVENESS_TIMEOUT_MS` (5000) ms for the view to answer; `EXECUTION_TIMEOUT_GRACE_MS` (1000) ms past a deadline for the worker (`workerExecutionTimeout`) | none: the library's own | none | src/lib/watchdog.test.ts; test/e2e/watchdog.spec.ts |
| Strict: the guest's error texts the view relays (GUEST_ERROR, GUEST_UNCAUGHT), to `sandbox-log` | `LOG_EVENTS_PER_SECOND` (1000) a second, counted in the view | each cut at `VIEW_OPTIONS.guestText.maxLength` (2048) characters in the view, before it is posted; each uncaught one counted whole against `UNCAUGHT_CHARACTERS_PER_SECOND` (1048576) characters in any second, as the worker counts the ones it sees (WebKit mutes those of a revoked script there); past it the sandbox ends | none of its own: one line each | none beyond the count and the bytes | none | test/unit/rpc-bounds-and-call-limits.test.ts (C-4); test/e2e/worker-port-and-view-cost.spec.ts (M-5) |
| Strict: the view's operations (`sandboxView.render`, `text`, `set`) | one at a time; the body holds at most `VIEW_MAX_ELEMENTS` (50000) elements, `VIEW_MAX_DEPTH` (256) deep; a set names at most `VIEW_SET_STYLE_LIMITS.maxProperties` (16) style properties | `VIEW_RENDER_MAX_LENGTH` (262144) characters an operation, a style value `VIEW_SET_STYLE_LIMITS.maxValue` (1024); `VIEW_RENDER_CHARACTERS_PER_SECOND` (1048576) a second; `VIEW_MAX_CHARACTERS` (1048576) in the body | `VIEW_APPLY_MS_PER_SECOND` (200) ms a second on average, each operation charged in full; the second operation past `VIEW_MAX_OPERATION_MS` (2000) ms within `VIEW_OVERRUN_WINDOW_MS` (300000) ms ends the sandbox | a share: at most `VIEW_APPLY_MS_PER_SECOND` (200) ms of each second, averaged; see [The view's cost to the host page](#the-views-cost-to-the-host-page) | none | test/e2e/view-bound.spec.ts; test/e2e/view-budget.spec.ts; test/unit/view-budget.prop.test.ts; test/unit/view-input.test.ts (set({ css })) |
| Strict: the view's loads (URL attributes, CSS, and what the browser reports) | `VIEW_URLS_PER_SECOND` (200) a second, each charged before it can start; `VIEW_MAX_URLS` (1000) URL attributes in the body; `VIEW_MAX_DISTINCT_URLS` (10000) distinct URLs over the view's life | what the policy's origins serve: no budget of the library's | none of its own: the rate | a rate: at most `VIEW_URLS_PER_SECOND` (200) loads a second; see [The view's cost to the host page](#the-views-cost-to-the-host-page) | none: `blob:` loads of registered files and guest writes only; the view's policy has no network source, and the renderer drops every network URL before the browser sees it | test/e2e/worker-port-and-view-cost.spec.ts (M-2); test/e2e/strict-view-budget.spec.ts; test/unit/view-css-loads.test.ts; test/unit/view-budget.prop.test.ts; test/unit/sealed-build.test.ts; test/e2e/sealed-no-network.spec.ts |
| Strict: the view's events, to the guest's `sandboxView.on` handlers | of the types a handler listens to: the discrete ones as they are raised (by the user; `focusin` and `focusout` also by the guest's `set({ focus })`, one `set` a flush); pointer moves, wheel and scroll events coalesced to one per pointer or element, sent at most once per animation frame while fewer than `VIEW_INPUT_IN_FLIGHT` (1) frames are unacknowledged; `VIEW_EVENT_LIMITS.maxIds` (32) ids and `VIEW_EVENT_LIMITS.maxFields` (1000) form fields a detail | each string cut at `VIEW_EVENT_LIMITS.maxString` (65536) characters, all of one frame at `VIEW_EVENT_LIMITS.maxTotal` (262144); the rest numbers and constants | the event path charged to the view's `VIEW_APPLY_MS_PER_SECOND` (200) ms a second; continuous events wait while that budget is in debt | within the view's share: at most `VIEW_APPLY_MS_PER_SECOND` (200) ms of each second, averaged, with its operations; see [The view's cost to the host page](#the-views-cost-to-the-host-page) | none | test/e2e/strict-events.spec.ts; test/e2e/strict-pointer-events.spec.ts; test/e2e/strict-scroll-and-wheel.spec.ts; test/e2e/strict-focus-events.spec.ts; test/unit/view-input.test.ts |
| Strict: the view's overrun notices (VIEW_FIRST_OVERRUN, VIEW_OVERRUN), to `sandbox-log` and `terminated` | a first overrun's at most once per 9 s of its debt, and one host line an environment; the second ends the sandbox | none: no field | none of its own: the count | a stall past `VIEW_MAX_OPERATION_MS` (2000) ms at most once per `VIEW_OVERRUN_WINDOW_MS` (300000) ms beyond the first; see [The view's cost to the host page](#the-views-cost-to-the-host-page) | none | test/unit/strict-view-budget.test.ts (the repeated-overrun rule); test/e2e/view-bound.spec.ts |
| Cooperative: the guest's own document | none: the guest runs on the host page's thread wherever the engine puts its frame there | none | none: one loop can freeze the host page ([Modes](#modes)) | unbounded: a cooperative-mode limit | not a channel of sealed mode | README (cooperative-mode limits) |
<!-- generated:end -->

**What `terminate()` waits for.** It ends any flood, but only after the reports already queued are processed (a queue the
counts and bytes above bound); and where the view shares the host page's thread it cannot run during a stall of the view
([(b)](#b-the-single-operation-bound)).

<!-- describes: budgets sig:012c -->
**Measured figures** (examples within the bounds above, not part of them): on Firefox (Playwright 1.58.1's build), on a
shared 4-core VM, 2026-10-19 ([R5:N-1](archive/reviews/REVIEW-ROUND-5-2026-10-19.md#r5-n-1)), the uncaught errors and rejections
of the second row cost the host page's thread: 1000 cancelled a second, idle; 1000 handled a tick later, 4–7% busy;
1 Mi characters a second, 6% busy. One rejection of 16 Mi characters took about 0.5 s, after which the sandbox ended. The
strict view's figures are in [its own section](#the-views-cost-to-the-host-page).

---

## The view's cost to the host page

Strict mode's one statement of what the view can cost the thread it runs on. Every other place that speaks
of the view's cost (the [README's limits](../README.md#what-strict-mode-does-not-cover), [ADR-005](ADR-005-strict-mode.md),
the comments of `src/lib/in-sandbox-view.ts`) links here. `test/e2e/view-bound.spec.ts` measures (a) and (b) on every
engine CI runs, and `test/unit/view-bound.test.ts` keeps the constants named below equal to the code's. The view's
channels, with the other channels of guest activity, are in [Budgets](#budgets).

Measured on headless Playwright 1.58.1 (Chromium's headless shell, Firefox, WebKit) on a shared 4-core VM, 2026-10-19,
unless a row names another source. The shapes are what the statement rests on; the absolute numbers are that machine's.
Busy share is `1 − ticks / idle ticks` of a 10 ms interval on the host page, the idle baseline the best of 3 windows on
the same page right before, the loaded figure the best of 2 windows once the flood is under way (the table below). The
suite asserts with each loaded window between two such baselines, taken with the flood paused, against their mean, so
that the machine's other load is the same in the baseline as in the window.

**Where it applies.** The bound is on the thread the view runs on ([research 16](research/16_view_isolation/README.md)):

| Engine and build | The view runs on | So the bound is on |
| :--- | :--- | :--- |
| Desktop Chromium 127+ (`IsolateSandboxedIframes`) | a process apart from the host page's, shared with the page's other sandboxed frames | that process (so another sandbox's work can stall this view, [S79](BACKLOG.md#s79)); the host page's thread gets only the view's bounded notices (VIOLATION, GUEST_ERROR, RESIZE) |
| Chromium's headless shell, Chromium with that isolation off | the host page's thread | the host page's thread |
| Firefox (Fission isolates only cross-site frames; the view is placed with the site that made it) | the host page's thread | the host page's thread |
| WebKit and Safari (no site isolation) | the host page's thread | the host page's thread |
| Android WebView (no out-of-process frames); Chromium on Android isolates partially | the host page's thread | the host page's thread |

### (a) The long-run bound

For operations (a `render()`, `text()` or `set()` applied), whatever each costs (an overrun of (b) is charged in full
like any other), the view's share of the thread, averaged over runs long against a second, is at most

- **20%**: `VIEW_APPLY_MS_PER_SECOND` (200) ms per second of the view's own time: each operation's flush, the layout it
  forces and the rendering update after it, measured and charged in full, however long;
- **plus the browser's work on the view's loads**, which the meter cannot see (fetching, decoding and laying out an
  image, a CSS background or a font; processing a refusal): at most `VIEW_URLS_PER_SECOND` (200) loads a second, each
  measured at about 1 ms of the host page's thread or less (one render of 4 000 new admitted images: Chromium 52%,
  Firefox 46% busy over the 8 s after it; [research 16](research/16_view_isolation/README.md#what-the-browser-does-with-a-renders-urls)),
  so at most **20 points** more for a guest that loads, and none for one that does not.

That is 20% for a view that loads nothing and 40% for one that loads at the rate, on every engine where the view shares
the thread. It is an average, not a cap on each second: an operation is charged after it ran, so a single second can
hold more (398–553 ms of operations of at most 200 ms, simulated: [research 17](research/17_formal_methods/README.md)).

Every load is charged before the browser can start it: a render's URL attributes when it is rendered, and what the CSS
an operation applies can load when the operation is applied, counted from that CSS's text (each `url(`, `image-set(`,
`image(`, `cross-fade(` and `src(`, and a second's worth for each `@import` and stylesheet `<link>`); a load the
platform reports later takes from that prepayment, kept up to a second's worth, and is charged only past it. An
operation is applied only while the load budget is not in debt. So, with R the rate (`VIEW_URLS_PER_SECOND`, 200), the
loads the view's document starts over any t seconds number at most

- R·t + R: the rate, and the second's worth the budget holds;
- plus one operation's own charge, which may take the budget into debt: at most `VIEW_MAX_URLS` attributes and its
  CSS's count;
- plus R: the prepayment carried into the interval, which loads reported in it take before they are charged;
- plus what CSS already in the view loads past what was prepaid for it (a rule that matches only later: elements a
  later render inserts, a media query, a state such as `:hover`; an `image-set()` that picks another image when the
  resolution changes; a linked or imported sheet past its second's worth), charged once the platform reports it, and
  bounded only by that CSS's text.

The server's latency is in none of the first three: nothing an operation can load waits for its response to be charged,
so a slow server cannot let renders through meanwhile ([R5:M-3](archive/reviews/REVIEW-ROUND-5-2026-10-19.md#r5-m-3)). A load the browser itself defers (an image with `loading="lazy"` until it is
scrolled to, media until it plays) is charged when it is rendered and starts later: at most what the body holds of
them, `VIEW_MAX_URLS`.

Measured, the canonical floods (busy share). The suite asserts each against the bound plus 10 points, the measure's own
error: a 10 ms interval loses a tick for every slot a task straddles, so a stream of short tasks reads up to one tick
per task more than the time they took; the time budget alone measured 15–23% under a flood against its 20% (research
16); and the machine is shared, so a window can lose ticks to another process.

| Flood, operations as fast as the view takes them | Bound | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- | :--- |
| Renders: 261 000 characters of text, replacing one of three targets | 20% | 15% (17%) | 7% (9%) | 11% (14%) |
| Element flood: 37 449 empty elements re-rendered | 20% | 15% (43%: one window held a 1.6 s gap; over 4 windows of 10 s, 16% (19%)) | 11% (12%); over 4 windows of 10 s, 20% (23%) | 15% (17%) |
| `set()` loop: a 65 536-character textarea value | 20% | 0% (4%) | 4% (7%) | 14% (16%) |
| Class toggles: `text()` of one rule into a `<style>` over 5 000 elements | 20% | 8% (9%) | 8% (12%) | 16% (16%) |
| `<img>` from a refused source, 6 500 per render (the renderer drops them) | 40% | 1% (8%) | 1% (1%) | 2% (2%) |
| `<img>` from an admitted origin, 1 000 per render, the same URLs | 40% | 14% (17%) | 1% (16%) | 2% (8%) |
| CSS backgrounds from an admitted origin, 500 new per render | 40% | 26% (32%); over 4 windows of 10 s, 9% (15%) | 12% (27%); over 4 windows of 10 s, 3% (13%) | 0% (4%) |
| CSS backgrounds from a refused source, 500 new per render | 40% | 0% (2%) | 9% (9%) | 2% (5%) |
| 1 000 new images per render, every 5.2 s, up to `VIEW_MAX_DISTINCT_URLS` (then refused) | 40% | 18–32% per 10 s window | 10–21% | 17–27% |

The first figure is the best of the windows, the one in parentheses their mean. The machine ran other test suites at the
same time (load average 5–11 on 4 cores), which is why the suite asserts the best window.

**The view's events** (pointer, wheel, scroll and focus input, [`sandboxView`](#sandboxview-strict-mode)) are inside
this bound: the time the view spends on them (reading them, building their details, reading the rectangles and scroll
extents they carry) is measured and charged to the same `VIEW_APPLY_MS_PER_SECOND` as the operations, and the
continuous ones wait while that budget is in debt. Their count is bounded by the frame rate: at most one frame of them
per animation frame, and none while `VIEW_INPUT_IN_FLIGHT` (1) frame is unacknowledged. Measured (2026-10-24,
`docs/research/23_view_input/measure.spec.ts`): a 60 Hz drag answered every frame, 0% (Chromium), 1% (Firefox) and 3%
(WebKit) busy; a burst of moves as fast as the driver sends them, 1 386 a second reaching WebKit's view, of which the
guest received 27 to 62 a second, 0–8%.

### (b) The single-operation bound

An operation that took longer than `VIEW_MAX_OPERATION_MS` (2000) ms as the meter measures it (its flush, forced layout
and rendering update) is an **overrun**. The view charges it in full, like any other, so the next operation waits until
the debt is repaid (at least 9 s, five times its cost less the 200 ms the budget held), and goes on; the first overrun of
an environment is said in one `warn` line on `sandbox-log`. The **second overrun within `VIEW_OVERRUN_WINDOW_MS`
(300000 ms, 5 minutes)** of the one before it ends the sandbox (`the view spent more than 2000 ms on one operation
twice within 5 minutes`), and no operation runs after it; an overrun later than that is a first overrun again, and the
window runs from it. Why not the first: the meter measures wall time on a thread the view shares with your page and the
machine, so under load it passes 2000 ms for operations that are healthy ([ADR-005](ADR-005-strict-mode.md)).

**Exception: desktop Chromium** ([S79](BACKLOG.md#s79), open). There the view runs in a process apart from the host page's,
so the host page's ticks keep counting while the view is busy, and the view's liveness ping (5000 ms)
ends the sandbox (`the sandbox view stopped responding`) at the **first** operation that keeps the view silent for longer
than that, as a 240 000-character bidirectional paragraph does (5.7 s measured, Chromium 145). An overrun of 2 to about 5
s is survived there as described; a longer one is not. This fails closed, and the host page is not stalled.
The process is shared by all the sandboxed frames of the page, so the same happens across sandboxes: a loop in another
sandbox's cooperative guest, or one documented stall in another strict view, keeps this view silent and its liveness ping
ends it too (measured on Chromium 145 with two sandboxes at the default configuration; a cooperative sandbox in that
position is frozen for as long as the other's loop runs).

So the bound is: **at most one stall past 2000 ms per 5 minutes beyond the first**, and **each stall is what that one
operation costs before the view can observe it**: an operation is not interruptible, so the view learns its cost only
when it has ended, and the host page stalls for all of it. That cost is bounded only by the caps of (c) on what the
document holds. The long-run share of (a) holds all the same, since every overrun is charged in full. Measured
(`test/e2e/view-bound.spec.ts`, (b)): a render of elements under a rule whose `:has()` looks at all their later
siblings (30 000 in Chromium, 24 000 in Firefox and WebKit), an operation of 3.9 s (Chromium), 9.0 s (Firefox) and
6.5 s (WebKit) on a page of its own, stalled the host page for 3.9 s, 8.9 s and 7.2 s; the sandbox stood. The next such
render, made at once, ran 18.3 s, 43.5 s and 34.7 s later (the debt: five times the first's cost, less the 200 ms the
budget held) and stalled the host page for 4.0 s, 9.3 s and 6.5 s; the sandbox ended, and a third render queued behind
it never ran. What one operation within the caps can cost is listed in (d), the documented single-operation stalls.

One render's loads add to it, after the operation: up to `VIEW_MAX_URLS` (1000) URL attributes, about a second of the
host page's thread at most, and what its CSS can load, which its count bounds ((a)); all of them are charged when the
operation is applied, and the next operation waits until the load budget has repaid them. Measured at
`VIEW_MAX_DISTINCT_URLS`, the host page's longest stall: Chromium 297 ms, Firefox 654 ms, WebKit 809 ms ([R5:M-4](archive/reviews/REVIEW-ROUND-5-2026-10-19.md#r5-m-4)).

### (c) The rates and caps that bound what the meter does not see

The first three rows are (a)'s and (b)'s; the rest bound what the view's meter cannot see.

| Constant | Value | Bounds |
| :--- | :--- | :--- |
| `VIEW_APPLY_MS_PER_SECOND` | 200 | (a): milliseconds of the view's own time per second, on average; an operation past it waits. |
| `VIEW_MAX_OPERATION_MS` | 2000 | (b): milliseconds of one operation, as the meter measures it; past it the operation is an overrun, charged in full. |
| `VIEW_OVERRUN_WINDOW_MS` | 300000 | (b): the second overrun within this many milliseconds of the one before it ends the sandbox. |
| `VIEW_URLS_PER_SECOND` | 200 | Loads per second, each charged before it can start: every URL-bearing attribute a render keeps, and what the CSS an operation applies can load (its `url(`, `image-set(`, `image(`, `cross-fade(` and `src(` tokens, and a second's worth per `@import` and stylesheet `<link>`), when the operation is applied. A load the document's resource timing reports, or a violation the view observes, that no URL attribute charged takes from that prepayment (at most a second's worth is kept), and is charged once it is spent. An operation past it applies; the next one waits. The bound over any interval: (a). |
| `VIEW_MAX_URLS` | 1000 | URL-bearing attributes the view's body holds: what one render can make the browser load. |
| `VIEW_MAX_DISTINCT_URLS` | 10000 | Distinct URLs one view loads over its life: what stays in the engine's caches (WebKit's stalls grew with it: 1.2 s near 8 000, 8.8 s near 43 000). |
| `VIEW_MAX_ELEMENTS` | 50000 | Elements the body holds: what any restyle, relayout or repaint, seen or not, covers. |
| `VIEW_MAX_DEPTH` | 256 | Nesting below the body. |
| `VIEW_MAX_CHARACTERS` | 1048576 | Characters the body holds (its serialization: text, attributes and markup). |
| `VIEW_RENDER_CHARACTERS_PER_SECOND` | 1048576 | Characters of markup the view parses per second, refused renders included. |
| `VIEW_RENDER_MAX_LENGTH` | 262144 | Characters of one operation. |
| `VIEW_INPUT_IN_FLIGHT` | 1 | Frames of the view's events the worker has not acknowledged, past which the continuous ones wait, coalesced: what the guest's events cost the worker's queue and the view, whatever the engine delivers. |
| `LOG_EVENTS_PER_SECOND` | 1000 | The guest's error texts the view posts to the host page per second (GUEST_ERROR and GUEST_UNCAUGHT frames, each cut to 2048 characters before posting). |
| `VIOLATION_EVENT_LIMIT` | 100 | `violation` events the host page dispatches from the view, per directive; every refusal is charged to `VIEW_URLS_PER_SECOND` all the same. |
| `UNCAUGHT_PER_SECOND` | 1000 | Uncaught errors and unhandled rejections of the guest's worker per second, which Firefox reports on the view's thread; past it the sandbox ends. |
| `UNCAUGHT_CHARACTERS_PER_SECOND` | 1048576 | Their characters per second; past it the sandbox ends (the `name` and `message` of any object are counted, whatever it says it is). |

The call budgets (`callLimits`) and the worker's log budget do not touch the view: calls and log lines go between the
host page and the worker over the logic port, never through the view.

### (d) Outside the bound

This list is closed: a cost of the view not listed here and not inside (a) or (b) is a finding.

| What | Magnitude, measured | Source |
| :--- | :--- | :--- |
| CSS animations and transitions while `allowAnimations: true` (an opt-in), and while they run | 5 000 animated elements: 81–92% busy (Firefox 21–89% by property); transitions 75–87%; scroll-driven animations 47–92%. `false` brings every vector back to idle. | [research 16](research/16_view_isolation/README.md#what-keeps-a-shared-thread-busy); [`allowAnimations`](#allowanimations-and-allowautoplay) |
| What else runs on its own, which `allowAnimations: false` does not stop: animated images, indeterminate `<progress>`, autoplaying media with `allowAutoplay: true` | 2 000 animated PNGs: WebKit 39% (+22 points), Firefox 12%; 5 000 `<progress>`: up to +4 points; 20 looping videos: up to +6 points | research 16 |
| Relayout after image decodes or font swaps: the browser's work after the frame the meter measured; only the load rate and the caps of (c) bound it | One render of 1 000 admitted images without dimensions above 15 000 paragraphs, the responses spread over 2 s, so that each arrival lays the paragraphs out again: over the 3 s after it, Chromium 40%, Firefox 22%, WebKit 37% busy, longest gap 226, 55 and 289 ms (the loads themselves included; (a)'s flood of images with dimensions, 3–8%). One `@font-face` swap over 15 000 paragraphs: 2%, 5% and 23% busy over the 3 s around it, longest gap 31, 54 and 214 ms. | [review round 5](archive/reviews/REVIEW-ROUND-5-2026-10-19.md), "What remains"; `test/e2e/view-bound.spec.ts` (d), on demand |
| The documented single-operation stalls, each one operation's own cost: CSS filters, bidirectional text, small CSS changes over many elements, selectors whose matching grows faster than the elements, `<img>` in Chromium, and WebKit's first value of a 250 000-character textarea | 10 `blur()`s on 1 000 elements: WebKit 3.7 s (100 on 1 000: over 180 s); 240 000 characters of bidirectional text in one paragraph: tens of seconds in Chromium and WebKit; a 31-character `text()` into a `<style>` over 46 000 elements: Firefox 7 s; a rule whose `:has()` looks at every later sibling, over 24 000 elements: Chromium 4.2 s, Firefox 8.9–9.2 s, WebKit 7.1–8.6 s; 6 500 `<img alt>`: Chromium 1.9–2.6 s, Firefox and WebKit about 150 ms (an example, measured 2026-10-18); the first `set()` of a 250 000-character textarea: WebKit over 2 s, an overrun the sandbox survives. Past `VIEW_MAX_OPERATION_MS` each is an overrun, after the stall: charged in full, and the second within `VIEW_OVERRUN_WINDOW_MS` ends the sandbox ((b)). | [broad review](archive/reviews/BROAD-REVIEW-2026-10-14.md), review rounds [1](archive/reviews/REVIEW-ROUND-1-2026-10-15.md), [4](archive/reviews/REVIEW-ROUND-4-2026-10-18.md) and [5](archive/reviews/REVIEW-ROUND-5-2026-10-19.md) |
| Memory: not bounded | No budget counts it. The caps of (c) bound what the document holds, not what that costs in memory (decoded images, the caches of up to `VIEW_MAX_DISTINCT_URLS` URLs, layout structures); measured only where it ended a run: a flood of large rejections took Firefox's content process to 7 GB before the uncaught budget ended such floods | [review round 5](archive/reviews/REVIEW-ROUND-5-2026-10-19.md), N-1 |
| `:hover` restyles driven by the user's pointer over many elements | 80–100% busy while the pointer moves (5 000 elements under a `:hover ~` rule) | research 16 |
| Firefox's cost of the worker's unhandled rejections, which it reports on the view's thread, cancelled or not | Within `UNCAUGHT_PER_SECOND`: 1 000 cancelled a second idle, 1 000 handled a tick later 4–7% busy, 1 Mi characters a second 6%; one rejection of 16 Mi characters about 0.5 s, after which the sandbox ends. A relay worker does not change it. The characters of every object's `name` and `message` count, whatever its `Symbol.toStringTag` says. | `src/lib/egress.ts`; [research 19](research/19_relay_worker/README.md) |

Outside the statement altogether, as everywhere: cooperative mode, whose guest runs in a frame that can freeze the host
page with one loop where it shares its thread ([Modes](#modes)).

---

## Host page policy

<!-- describes: api:viewScriptHash sig:ce76 -->
The sandbox's frames are `srcdoc` documents, and a `srcdoc` document inherits the policies of the page that made it:
a copy of its Content-Security-Policy list, its Trusted Types requirement and its Cross-Origin-Embedder-Policy. Every
policy in the list must allow a load, so your page's policy narrows the sandbox's, never widens it. What your page's
policy must allow:

| Your page's | sealed (default) and strict | cooperative | worker |
| :--- | :--- | :--- | :--- |
| `script-src` | the view bootstrap's hash, `'sha256-…'` (below), or `'unsafe-inline'`; `'unsafe-eval'` for `execute()` | `'unsafe-inline'` (the bootstrap and the guest's inline scripts; its hash changes with every build), plus what the guest loads | `'unsafe-inline'`, `'unsafe-eval'` for `execute()` |
| `worker-src` (or `script-src` without it) | `blob:` | — (`blob:` for workers the guest makes) | `blob:` |
| `style-src` | `'unsafe-inline'`, or the wrapper style's hash `'sha256-jKvfmEYIGlm8DGk4pp05gJ0MwYdTY+NU6tSvyPZyDow='`; while `allowAnimations` is `false` (the default), also the view's animation stylesheet's hash `'sha256-+xgty2clGX4Uw4d4EP9TmDH+dSL1A5dfieXcAO96Zec='`; `'unsafe-inline'` for the guest's own inline styles | the same (no animation stylesheet) | the same (no animation stylesheet) |
| `img-src`, `media-src`, `font-src`, `connect-src` | `blob:` for registered files of that kind; strict mode: every origin in `origins` (in `connect-src`, named by scheme and host, not `'self'`: [below](#your-connect-src)); sealed mode: no origin, it has none | `blob:` for registered files of that kind; every origin in `origins` | the same |
| `frame-src` / `child-src` | nothing (a `srcdoc` frame loads no URL) | the same | the same |
| `base-uri` | `about:` (for example `base-uri 'self' about:`), or omit the directive: the wrapper sets `<base href="about:blank">` so the guest never sees your page's URL, and a policy that refuses it (`'self'`, `'none'`) ends the build, because every bootstrap first checks its document's base URL | the same | the same |
| With `fetchBridge` (not in sealed mode) | the bridge's frame runs the view bootstrap too: the same hash, or `'unsafe-inline'`, admits it; `connect-src`: every origin in `fetchBridge.allow` (the frame's requests inherit your policy; name each origin by scheme and host, [below](#your-connect-src)) | the same: `'unsafe-inline'` admits the frame's script | the same |
| Trusted Types | `require-trusted-types-for 'script'` works: the element and the view assign through one policy named `web-sandbox` from their first write (so the page gets no violation, console error or report from them), which blesses only the sandbox's own documents; a `trusted-types` directive must name it (add `'allow-duplicates'` if two copies of the library share the page). Strings are not evaluated: `execute()` and the guest's `eval` are refused. A browser without Trusted Types (Firefox 146, the version measured) cannot do this itself: pass your page's policy as `hostContentSecurityPolicy` and the library refuses as the others do (a `trusted-types` list that does not name the policy ends the build with the Trusted Types reason, and `execute()` warns and does nothing); without it nothing is applied there ([Trusted Types without the browser](#trusted-types-without-the-browser)) | the guest inherits the requirement: its scripts, the import map and the markup the bootstrap writes for registered files need Trusted Types too; `execute()` is refused | works (the frame starts the worker through the policy); `execute()` is refused |
| `Cross-Origin-Embedder-Policy: require-corp` (without `Cross-Origin-Opener-Policy: same-origin`) | works in Chromium and Firefox; WebKit refuses the view's `blob:` worker | works; resources from `origins` need CORP or CORS headers | as strict |
| `Cross-Origin-Opener-Policy: same-origin` with `Cross-Origin-Embedder-Policy` (`require-corp` or `credentialless`), when the browser makes the page cross-origin isolated (`crossOriginIsolated` is `true`) | **not supported, on any engine**: a guest never runs cross-origin isolated. The element reads `crossOriginIsolated` of your page before it creates a frame and, when it is `true`, ends the build with `the host page is cross-origin isolated …`; no frame exists and nothing of the guest runs. The outcome follows your page's isolation, not the engine (which pairs isolate a page is the browser's: COOP with `require-corp` does everywhere, and with `credentialless` in Chromium and Firefox but not in WebKit, where the sandbox then runs). The library's own bootstraps check the same value in their documents as well | not supported (the same) | not supported (the same) |

- **What a refusal looks like**: the build ends with a reason that names your page's policy: `the sandbox's startup
  script did not run …` (a refused bootstrap), `the sandbox's worker could not be loaded …` (a refused `blob:` worker),
  `… does not allow the policy name 'web-sandbox' …` (Trusted Types), `the sandbox document's base URL is not about:blank
  …` (a `base-uri` without `about:`; the bootstrap stays inert, so nothing of the guest's runs), `the host page is cross-origin isolated …` (COOP and COEP together: an isolated host page; no frame is created). The fetch bridge's frame and the strict view run
  one bootstrap under one hash and one policy, so a host policy that refuses one refuses the other, and strict mode then
  ends the build with the startup reason above. A bridge frame that fails to start alone (its script refused while the
  sandbox runs) leaves the sandbox running and fails the bridge closed: every `sandboxFetch()` rejects with `FETCH_FAILED`,
  each `fetch` record is `refused` with a `reason` that names the hash, and the element warns once. A refused wrapper style leaves the frame 150 px
  high, and the element warns with the hash to allow; so does a refused animation stylesheet (`allowAnimations` `false`, the default),
  whose view then shows no guest stylesheet.
- **Cooperative and worker mode need `'unsafe-inline'` in your page's `script-src`**, and that has a price. Their
  bootstrap is inline and its hash changes with every build, so no hash or nonce can name it. Next to a hash or a nonce a
  browser ignores `'unsafe-inline'`, so a page whose `script-src` carries one (the one `viewScriptHash()` serves, or its
  own nonce) cannot run these modes: the build ends with `the sandbox's startup script did not run …`. A page that allows
  `'unsafe-inline'` allows inline script everywhere on it, and so gives up its defence against an injected `<script>`.
  Prefer strict mode, whose hash sits beside your own hashes and nonces; using `'unsafe-inline'` there instead of the hash
  costs the same.
- **Your `img-src`, `media-src`, `font-src` and the other fetch directives narrow `origins` silently**, in the engines
  that apply the inherited list: an origin listed in `origins` that your page's policy does not allow is refused in the
  sandbox too. The refusal happens in the sandbox's documents, so it arrives as the element's `violation` event (where the
  browser reports it), never as a `securitypolicyviolation` on your page, and nothing warns at `setConfig()`. Your
  `connect-src` is different: the library applies it itself, from `hostContentSecurityPolicy`, with a warning
  ([below](#your-connect-src)).
- **The view bootstrap's hash** is `viewScriptHash()`, the very value the element puts in the view's `script-src`, and in
  the fetch bridge's frame's: the library has one hashed bootstrap, which runs the view in strict mode and, with
  `fetchBridge`, the frame that makes the bridge's requests in every mode, so one hash admits both.
  It is constant for one version of the built package (the bootstrap is a string literal of the package's bundle, so your
  bundler or minifier does not change it), and it changes with the package's version, so it is not listed here: read
  it in a build step (importing the package needs no DOM, in Node or Bun) and put it in your page's policy:

  ```js
  import { viewScriptHash } from 'web-sandbox';
  const policy = `script-src 'self' ${viewScriptHash()}; worker-src blob:`; // viewScriptHash() is 'sha256-…', quoted
  ```

  The sources are not the built package: a project that bundles `src/index.ts` from a checkout has no such literal, and its
  bundler prints the bootstrap's functions its own way, so a build step that imports the sources computes another hash
  than the page's bundle does, and a policy that lists it refuses the view's startup script. `viewScriptHash()` warns, once,
  where it runs from the sources. From a checkout, build the package (`bun run build:lib`) and import `dist/index.js` in
  both places, or read the hash in the page that runs the sources.

  The wrapper style's and the animation stylesheet's hashes are constants of the library, listed in the table above.

### Your `connect-src`

<!-- describes: option:hostContentSecurityPolicy, connect-facts, host-source-rules sig:fb7ce57b109d -->
The engines do not agree on what some sources of your page's `connect-src` admit in a sandbox document
([the table below](#connect-src-by-engine)). So the library applies your policy to the two lists that
open connections, the same on every engine: every origin in `origins.connect` and `fetchBridge.allow` that your
`connect-src` (or `default-src`) does not admit is **dropped with one warning per list**, before the guest's and the
bridge's policies are written. A `wss://` entry whose `https://` twin was dropped goes with it. Nothing else changes:
the other directives, the sandbox's own policy and the rest of the configuration are as configured, and an origin your
policy admits is kept, as is every origin when your policy governs no connections.

**The library takes your policy only from [`hostContentSecurityPolicy`](#configuration).** No browser API returns a
page's policy, and the library does not guess it from the page: it makes no request, adds no frame and listens for no
violation to learn it. So a configuration that lists an `origins.connect` or `fetchBridge.allow` entry passes one of:

- **Your policy as text**: the enforced policy, exactly as your page is served with it (the `Content-Security-Policy`
  header, plus the `content` of any `<meta http-equiv="Content-Security-Policy">`; several policies separated by commas,
  as in a header). A Report-Only policy is not passed. The library narrows both lists by it, as above.
- **`false`**: your page sends no Content-Security-Policy. The lists are kept as configured. If your page does send one
  after all, the library does not apply it: the browser does, and the engines differ ([the table
  below](#connect-src-by-engine)).

```js
sandbox.setConfig({
    mode: 'strict',
    entry: 'main.js',
    origins: { connect: ['https://api.example.com'] },
    hostContentSecurityPolicy: "default-src 'self'; connect-src 'self' https://api.example.com", // or false
});
```

**Left out, both lists are dropped**, whatever your page sends, with one warning that names the dropped entries and
says what to pass (`… hostContentSecurityPolicy was not given, so the library does not know your page's
Content-Security-Policy …`). The guest's `fetch()`, `XMLHttpRequest` and `WebSocket` to those origins are then refused
by the [request gate](#the-request-gate) and reported as a `violation`, and its `sandboxFetch()` with
`FETCH_NOT_ALLOWED`; the sandbox builds and runs. A configuration that lists no such entry needs no option. The text
you pass is the library's only knowledge of your policy: keep it in step with what your page is served with (a build
step that writes both from one value does).

The parser reads `connect-src` only. It keeps an origin only where every engine of the suite admits it, so what it keeps is
admitted everywhere and what it drops is dropped everywhere, even where one engine would have admitted it; anything it
does not understand admits nothing, so it can only narrow. Policies are an intersection: an origin must pass each one
your page sends, header and `<meta>` alike. The grammar:

<!-- generated:begin host-source-rules -->
| Source in your `connect-src` | Admits an `origins.connect` or `fetchBridge.allow` entry when | Example |
| :--- | :--- | :--- |
| `connect-src`, else `default-src` | the directive that governs `fetch()`, `XMLHttpRequest` and `WebSocket`; a policy with neither admits every origin; a directive named twice counts the first time | `connect-src https://a.example; default-src 'none'` admits `https://a.example` |
| `'none'`, or no source | nothing; next to other sources it is ignored | `connect-src 'none'` drops `https://a.example` |
| `'self'` | nothing: in a sandboxed frame one engine lets it admit origins it does not name, so name the origin | `connect-src 'self'` drops `https://app.example` |
| `*` | an origin of the network schemes `http`, `https`, `ws` and `wss` | `connect-src *` admits `https://a.example` |
| `scheme:` | an origin of that scheme; `http:` also `https:`, `ws:` also `wss:`, and no other widening | `connect-src https:` admits `https://a.example` |
| `scheme://host[:port]` | an origin whose host is equal (case folded) and whose port is equal, the scheme's default when the source names none; the scheme as for `scheme:`, except that an upgraded scheme (`http://` for `https://`, `ws://` for `wss://`) needs no port written, or `:*` | `connect-src https://a.example` admits `https://a.example` |
| `*.host` and `:*` | a subdomain of the host (one or more labels, not the bare domain); any port | `connect-src https://*.example` admits `https://a.example` |
| `host/path` | nothing: a path admits some of an origin, never the origin (a lone `/` is the whole origin) | `connect-src https://a.example/api` drops `https://a.example` |
| `host[:port]`, without a scheme | nothing: WebKit reads it against the frame's own scheme, and Chromium does not take it with a port, so write the scheme | `connect-src a.example` drops `https://a.example` |
| anything else | nothing: nonces, hashes, `'unsafe-*'`, `'strict-dynamic'`, `data:`, `blob:`, `filesystem:`, a keyword the parser does not know, a token that is not a source | `connect-src 'unsafe-inline' 'unsafe-eval' 'strict-dynamic'` drops `https://a.example` |
<!-- generated:end -->

Two sources deserve a sentence. **`'self'` admits nothing**: the engines differ on what it admits in a sandboxed frame
(the table below), so the same entry would reach in one and not in another. To let the sandbox, or the bridge, reach
your own origin, name it (`connect-src 'self' https://app.example`). And **write the scheme**: a host without one is read
against the frame's own scheme by some engines. These are the two places the library narrows beyond what your browser
alone would.

<a id="connect-src-by-engine"></a>
What each engine does without the library's rules, and why they exist (the table is the source of these sentences, and of
the rules above):

<!-- generated:begin connect-facts -->
| Engine | A `'self'` source of your `connect-src` admits an origin it does not name | A host written without a scheme admits the `https://` origin it names | A `http://h:P` source admits `https://h:P` | A `wss://h` source also admits `https://h` | Found by |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Chromium | no | yes, not with a port | no | no | 2026-10-23, Playwright 1.58.1, Chromium 145: test/e2e/connect-uniform.spec.ts (every source of the grammar table against fetch and WebSocket requests of a guest, the page's policy left to the browser) |
| Firefox | no | yes | yes | no | 2026-10-23, Playwright 1.58.1, Firefox 146: as Chromium |
| WebKit | yes | no | yes | yes | 2026-10-23, Playwright 1.58.1, WebKit 26: as Chromium |
<!-- generated:end -->

### Trusted Types without the browser

<!-- describes: option:hostContentSecurityPolicy, trusted-types-rules sig:fb7c6b2f -->
A page that sends `require-trusted-types-for 'script'` makes the browser refuse a string at a script sink, and its
`trusted-types` list must name the library's policy `web-sandbox`. Chromium and WebKit enforce both themselves: a list that
does not name the policy ends the build with the Trusted Types reason, and the string of `execute()` is not evaluated in the
guest. Firefox 146 (the version measured) has no Trusted Types, so it would build and run `execute()` on the same page. To
make it answer alike, pass your page's policy as [`hostContentSecurityPolicy`](#configuration): where the browser has no
Trusted Types the library then reads the two directives from your text and refuses as the other browsers do, in every mode;
`execute()` logs one warning ("`execute()` refused") and does nothing. The browsers that have Trusted Types ignore the text
for this and go on enforcing their own, so one configuration gives one result everywhere.

Without the option nothing is applied in a browser that has no Trusted Types: the library never asks your page for its
policy ([above](#your-connect-src)). `hostContentSecurityPolicy: false` applies none of it either. The grammar is the part the browsers that have Trusted Types agree
on; where they differ (the case of the `'script'` keyword, a `require-trusted-types-for` named twice) the library follows the
specification and the table has no row:

<!-- generated:begin trusted-types-rules -->
| In your policy | Rule | Example | Strict and worker mode | Cooperative mode | `execute()` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `require-trusted-types-for 'script'` | the requirement: strings are refused at script sinks, so `execute()` is refused; the directive's name folds case | `require-trusted-types-for 'script'` | builds | builds | refused |
|  |  | `REQUIRE-TRUSTED-TYPES-FOR 'script'` | builds | builds | refused |
|  |  | `require-trusted-types-for 'script'; TRUSTED-TYPES other` | ends the build | ends the build | refused |
|  |  | `require-trusted-types-for 'style'` | builds | builds | runs |
|  |  | `img-src *; connect-src 'self'` | builds | builds | runs |
| `trusted-types` without the requirement | names the policies the page lets be made and refuses nothing by itself: a string is still taken, so the build goes on | `trusted-types other` | builds | builds | runs |
|  |  | `trusted-types 'none'` | builds | builds | runs |
| `trusted-types` naming `web-sandbox`, or `*` | admits the library's policy: the build goes on, with the requirement too | `require-trusted-types-for 'script'; trusted-types web-sandbox` | builds | builds | refused |
|  |  | `require-trusted-types-for 'script'; trusted-types a web-sandbox b 'allow-duplicates'` | builds | builds | refused |
|  |  | `require-trusted-types-for 'script'; trusted-types *` | builds | builds | refused |
|  |  | `require-trusted-types-for 'script'; trusted-types * 'allow-duplicates'` | builds | builds | refused |
| `trusted-types` naming other policies, or `'none'` | with the requirement the library's policy is refused, and the build ends with the Trusted Types reason; names are case-sensitive | `require-trusted-types-for 'script'; trusted-types other` | ends the build | ends the build | refused |
|  |  | `require-trusted-types-for 'script'; trusted-types 'none'` | ends the build | ends the build | refused |
|  |  | `require-trusted-types-for 'script'; trusted-types` | ends the build | ends the build | refused |
|  |  | `require-trusted-types-for 'script'; trusted-types Web-Sandbox` | ends the build | ends the build | refused |
|  |  | `require-trusted-types-for 'script'; trusted-types web-sandbox2` | ends the build | ends the build | refused |
|  |  | `trusted-types other; require-trusted-types-for 'script'` | ends the build | ends the build | refused |
| `trusted-types default` | a page whose every list allows a policy named `default` may have made one, which takes the element's strings in cooperative mode; strict and worker mode make their policy in a frame that has none, so a refused name ends them | `require-trusted-types-for 'script'; trusted-types default` | ends the build | builds | refused |
|  |  | `require-trusted-types-for 'script'; trusted-types default other` | ends the build | builds | refused |
|  |  | `require-trusted-types-for 'script'; trusted-types default web-sandbox` | builds | builds | refused |
| a list of policies | is read as the browsers do: the requirement of any policy counts, and the library's policy must pass every `trusted-types` list | `require-trusted-types-for 'script', trusted-types other` | ends the build | ends the build | refused |
|  |  | `trusted-types web-sandbox, require-trusted-types-for 'script'` | builds | builds | refused |
|  |  | `require-trusted-types-for 'script'; trusted-types web-sandbox, trusted-types other` | ends the build | ends the build | refused |
|  |  | `require-trusted-types-for 'script'; trusted-types web-sandbox, trusted-types default` | ends the build | ends the build | refused |
|  |  | `require-trusted-types-for 'script'; trusted-types default web-sandbox, trusted-types default` | ends the build | builds | refused |
<!-- generated:end -->

---

## Exports

Values:

<!-- generated:begin api-exports-values -->
| Export | What it is |
| :--- | :--- |
| `defineWebSandbox` | Registers `WebSandbox` as a custom element under `tagName` and returns the class. |
| `viewScriptHash` | The CSP hash source of the library's bootstrap for this release of the package, to allow in the host page's own Content-Security-Policy: strict mode's view runs it, and so does the fetch bridge's frame. |
| `SandboxDevTools` | Logs one sandbox's `sandbox-log` lines to the host page's console, safely: the values go after a fixed first argument, so a guest string is never read as a console format string. |
| `WebSandbox` | The `<web-sandbox>` custom element: one sandboxed environment for untrusted web content, rebuilt by `setConfig()`, `load()` and `reset()`. |
| `AUTO_RESIZE_MAX_HEIGHT` | The tallest height, in CSS pixels, a guest can give the element; larger reports are clamped to it. |
| `AUTO_RESIZE_MAX_UPDATES_PER_SECOND` | At most this many height changes per second (and never more than one per animation frame). |
| `EXECUTION_TIMEOUT_GRACE_MS` | How long, in ms, the guest's event loop may still be busy at an `execute()` deadline (`workerExecutionTimeout`): the element pings the guest there, and a guest that has not answered within this time ends the sandbox. |
| `FETCH_ERROR_CODES` | Every `FetchErrorCode`, as a value. |
| `GUEST_WRITE_BYTES_PER_SECOND` | Most bytes of written content recorded per environment in any one-second window (`guestWrites`); later writes are refused with `FILES_BUSY`. |
| `GUEST_WRITES_PER_SECOND` | Most guest write and remove requests handled per environment in any one-second window (`guestWrites`); later ones are refused with `FILES_BUSY`. |
| `LOAD_TIMEOUT_MS` | How long, in ms, a build may stay `loading` before the sandbox terminates; the reason names the host page's policy when the frame loaded and its startup script never checked in. |
| `LOG_EVENTS_PER_SECOND` | Most guest lines dispatched as `sandbox-log` per environment in any one-second window (a sliding window). |
| `LOG_MAX_ARGS` | Most arguments one `SandboxLog` line keeps; later ones are dropped. |
| `LOG_MAX_STRING` | Longest string argument of a `SandboxLog` line, in UTF-16 code units; a longer one is cut. |
| `MAX_INBOUND_IN_FLIGHT` | Most calls from the other side that run at once on one channel: a further request is answered `BUSY` at once and its method is not called. |
| `SAFE_CAPABILITIES` | The values the `capabilities` option accepts: sandbox flags that keep the guest inside the frame. |
| `UNSAFE_CAPABILITIES` | The values the `unsafeCapabilities` option accepts: each reaches outside the frame and warns once when enabled. |
| `UNSAFE_PERMISSIONS` | The Permissions Policy features among `UNSAFE_CAPABILITIES`, granted through the frames' `allow` attribute. |
| `UNSAFE_SANDBOX_FLAGS` | The sandbox flags among `UNSAFE_CAPABILITIES`: each reaches outside the frame and needs an explicit opt-in. |
| `VIEW_INPUT_IN_FLIGHT` | The most batches of the view's events the worker has not acknowledged yet (research 23). |
| `VIEW_LIVENESS_TIMEOUT_MS` | How long, in ms, strict mode's view may go without answering before the sandbox terminates ([ADR-005](ADR-005-strict-mode.md)). |
| `VIEW_RENDER_MAX_LENGTH` | The most characters (UTF-16 code units, 256 Ki) one strict-mode view operation may carry: the `html` of `sandboxView.render()`, the string of `text()` and the value of `set()`. |
| `VIEW_SET_STYLE_LIMITS` | Limits of one `sandboxView.set(id, { css })` (research 23): the properties it names, and the characters of each value (and of a custom property's name). |
| `VIEW_STYLE_PROPERTIES` | The inline style properties `sandboxView.set(id, { css })` may set on an element (research 23): what a drag, a gesture, a slider or a virtual list moves, and nothing else. |
| `VIOLATION_EVENT_LIMIT` | Most `violation` events one environment can produce; later reports are dropped, with one warning. |
<!-- generated:end -->

`document.createElement('web-sandbox')` is typed as a `WebSandbox` (`HTMLElementTagNameMap`), and its
`addEventListener` types each event's `detail`.

Types:

<!-- generated:begin api-exports-types -->
| Type | What it is |
| :--- | :--- |
| `CallLimits` | The per-second budget of the calls the guest makes (`SandboxConfigOptions.callLimits`). |
| `CooperativeSandboxConfig` | The configuration of cooperative mode, for content that cooperates: guest code runs in the guest document, within the documented limits of the mode (README, "Cooperative-mode limits"). |
| `FetchBridgeConfig` | The `fetchBridge` option: what `sandboxFetch()` in the guest may reach. |
| `FetchErrorCode` | Why `sandboxFetch()` rejected: the rejection's `code`, and the `code` of a `FetchRecord`. |
| `FetchRecord` | The `detail` of a `fetch` event: one request through the bridge, reported once when it settled. |
| `FileContent` | A file's content for `registerFiles()`: a string is stored as UTF-8, a `Uint8Array` is copied. |
| `FileEntry` | One `registerFiles()` entry: the content, typed by its path's extension, or `{ content, type }` with an explicit MIME type. |
| `FileError` | The shape of every refusal of the file methods: a plain `Error` with an own `code`. |
| `FileErrorCode` | Why a change to the files was refused: the `code` of a `FileError`. |
| `FileInfo` | One registered file, as `listFiles()` reports it. |
| `GuestWrite` | One pending change of the guest, as `listGuestWrites()` reports it: a write (with its `type`, `size` and a copy of the written bytes in `content`) or a removal. |
| `NetworkSandboxOptions` | The options that open the network: `origins` and `fetchBridge`. |
| `RpcError` | The shape of every rejection of `call()` and `callWithTimeout()`: a plain `Error` with an own `code`. |
| `RpcErrorCode` | Why a call was refused: the `code` of an `RpcError`. |
| `RpcLibraryCode` | The codes a library method (a `sandbox:` name) reports, from one closed set disjoint from `RpcErrorCode`: the fetch bridge's `FetchErrorCode` values and the guest writes' `FileErrorCode` values. |
| `SafeCapability` | A member of `SAFE_CAPABILITIES`: an entry of the `capabilities` option. |
| `SandboxCapability` | A value that may end up in a frame's `sandbox` attribute: a `SafeCapability` or a member of `UNSAFE_SANDBOX_FLAGS`. |
| `SandboxConfig` | The configuration `setConfig()` takes: a union keyed by `mode`. |
| `SandboxConfigOptions` | The options every mode takes, and the ones a mode's config narrows (`SealedSandboxConfig`, `StrictSandboxConfig`, `CooperativeSandboxConfig`, `WorkerSandboxConfig`). |
| `SandboxFiles` | The guest's view of the registered files: the global `sandboxFiles`, present in every environment (empty when no file is registered). |
| `SandboxLog` | The `detail` of a `sandbox-log` event: one log line, frozen. |
| `SandboxLogLevel` | The level of a `SandboxLog` line. |
| `SandboxOrigins` | The `origins` option: the exact origins the guest may load each kind of resource from, one list per kind. |
| `SandboxState` | Where the element is in its lifecycle; read it from `state`. |
| `SandboxViolation` | The `detail` of a `violation` event: the guest's policy refused a load. |
| `SealedSandboxConfig` | The configuration of sealed mode, the default ([ADR-008](ADR-008-sealed-mode.md)): strict mode with no network. |
| `StrictSandboxConfig` | The configuration of strict mode ([ADR-005](ADR-005-strict-mode.md)): sealed mode's view and worker, with the network options. |
| `StrictSandboxOrigins` | `SandboxOrigins` in strict mode: no `scripts`, since the view runs only the library's bootstrap ([ADR-005](ADR-005-strict-mode.md)). |
| `UnsafeCapability` | A member of `UNSAFE_CAPABILITIES`: an entry of the `unsafeCapabilities` option. |
| `UnsafePermission` | A member of `UNSAFE_PERMISSIONS`: a capability granted through the frames' `allow` attribute, not a sandbox flag. |
| `WebSandboxEventMap` | The events the element dispatches, and the `detail` of each: the type map of `addEventListener()`. |
| `WorkerSandboxConfig` | The configuration of worker mode: guest code runs in a worker inside the frame. |
<!-- generated:end -->

The playground's scenarios (`src/lib/presets.ts`) are not part of the package: each preset is a `code` payload
with the `rules` (a config every mode can run) and optional `files` it runs with, shared with the regression
specs.

---

## Examples

**Markup with a host method** (cooperative mode):

```js
const sandbox = document.querySelector('web-sandbox');
sandbox.expose('save', (record) => store.put({ ...record }));
sandbox.setConfig({
    mode: 'cooperative',
    capabilities: ['allow-scripts'],
    html: `<button id="b">Save</button>
           <script>b.onclick = () => bridge.call('save', { at: Date.now() });</script>`,
});
```

**Calling into the guest, branching on codes**:

```js
sandbox.addEventListener('ready', async () => {
    try {
        console.log(await sandbox.callWithTimeout(2000, 'sum', 1, 2));
    } catch (error) {
        if (error.code === 'UNKNOWN_METHOD') console.warn('the guest exposes no sum()');
        else if (error.code === 'TIMEOUT') console.warn('the guest did not answer');
        else throw error;
    }
});
```

**Strict mode with files, a watchdog and the fetch bridge** (sealed mode, the default, has no `fetchBridge`):

```js
sandbox.registerFiles({
    'main.js': `
        sandboxView.render('<button id="load">Load</button><ul id="list"></ul>');
        sandboxView.on('click', 'load', async () => {
            const items = await (await sandboxFetch('https://api.example/items')).json();
            sandboxView.render(items.map((_, n) => '<li id="item-' + n + '"></li>').join(''), 'list');
            // what the API returns is text, never markup: text() assigns it, so nothing needs escaping
            items.forEach((item, n) => sandboxView.text('item-' + n, String(item.name)));
        });`,
});
sandbox.setConfig({
    mode: 'strict',
    entry: 'main.js',
    watchdogTimeout: 2000,
    fetchBridge: { allow: ['https://api.example'] },
});
sandbox.addEventListener('fetch', (e) => console.log(e.detail.outcome, e.detail.url));
sandbox.addEventListener('terminated', (e) => console.warn(e.detail.reason));
```

**Observing a sandbox**:

```js
sandbox.addEventListener('sandbox-log', (e) => console.log(`[${e.detail.source}]`, e.detail.level, ...e.detail.args));
sandbox.addEventListener('violation', (e) => console.warn('violation', e.detail.directive, e.detail.blockedURI));
```
