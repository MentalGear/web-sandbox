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

<!-- describes: options, capabilities, api:SandboxConfig, api:SandboxConfigOptions, api:StrictSandboxConfig, api:CooperativeSandboxConfig, api:WorkerSandboxConfig sig:10835a2538da91d012d1923da001 -->
[`setConfig(config)`](#setconfigconfig) takes a `SandboxConfig`, a union keyed by `mode` (`StrictSandboxConfig`,
`CooperativeSandboxConfig`, `WorkerSandboxConfig`, each extending `SandboxConfigOptions`, the options every mode takes):
strict mode's `origins` has no `scripts`, and a config without `mode` is a strict config (strict mode is the default).
How a call is applied (over the defaults, copied, validated, and what a config that cannot be used does) is under
[`setConfig()`](#setconfigconfig) below.

- `SandboxConfig` narrows each mode: `entry`, `allowAnimations` and `allowAutoplay` only in strict mode, `workerExecutionTimeout` not in cooperative mode,
  `html` and `autoResize` not in worker mode, `unsafeCapabilities` not in strict mode. A config from JSON is held to
  the same rules at run time: an option outside its modes (the Modes column) is ignored and takes its default, with one
  warning for `entry`, `allowAnimations`, `allowAutoplay`, `unsafeCapabilities` and `autoResize`, silently for `html`
  and `workerExecutionTimeout`.
- Each option's default, accepted values, bounds, warnings and modes are declared once (`src/lib/config-schema.ts`), and
  so are the checks across options, which hold for every config: every call that `callLimits` can carry fits an empty
  window ([below](#calllimits)); a `fetchBridge` response of `maxBytes` fits one call result; a `fetchBridge` request
  body of `maxBytes`, and a guest write of the whole file quota, fit one call, unless a `maxBytesPerSecond` below
  `RPC_MAX_BYTES` caps calls, which it says once. `watchdogTimeout` and `workerExecutionTimeout` are independent: either
  may be the shorter.

<!-- generated:begin configuration -->
| Option | Type | Default | Modes | What it does |
| :--- | :--- | :--- | :--- | :--- |
| `mode` | `'strict' \| 'cooperative' \| 'worker'` | `'strict'` | — | Where guest code runs; see [Modes](#modes). Any other value starts no environment: the sandbox terminates with the reason `unknown mode …` until a valid mode is configured. `'iframe'` was renamed `'cooperative'`: refused the same way, and the reason says so. |
| `html` | `string` | `''` | strict, cooperative | The initial view (strict mode) or the guest document (cooperative mode). In strict mode its `<script>` elements and `on…` handler attributes never run, and markup that holds any warns once per element: ``strict mode (the default) runs no script in `html`; …``. Empty means `<div id="root"></div>`. Ignored in worker mode. Also set by [`load()`](#loadhtml). |
| `capabilities` | `SafeCapability[]` | `[]` | all | Sandbox flags that keep the guest inside the frame: `allow-orientation-lock`, `allow-scripts`. Anything else is dropped with a warning. Worker mode always adds `allow-scripts`; strict mode always has `allow-scripts allow-forms` (listing either there changes nothing). |
| `unsafeCapabilities` | `UnsafeCapability[]` | `[]` | cooperative, worker | Capabilities that act outside the frame: `allow-downloads`, `allow-forms`, `allow-modals`, `allow-pointer-lock`, `allow-popups`, `allow-presentation`, `fullscreen`. Each one enabled warns once. `allow-forms` lets guest forms submit: `form-action 'none'` refuses the submission inside the frame, but one opened in a new tab by a modifier click (the user's, or one the guest's script synthesizes) is not checked against it in Chromium. `allow-pointer-lock` and `fullscreen` let a guest hide the cursor, capture relative input or draw over the whole screen, so each can imitate host or browser UI. `fullscreen` is granted as `allow="fullscreen *"` (a Permissions Policy feature), the rest as sandbox flags. Dropped with a warning in strict mode. Without `allow-popups` guest code opens no window, but in cooperative mode the user's own Ctrl-, Shift- or middle-click, or Ctrl/Shift+Enter, on a guest link opens it in a new tab in Chromium and Firefox (platform behaviour of any sandboxed frame; see [Modes](#modes)). |
| `scriptUnsafe` | `boolean` | `false` | all | Only a literal `true` enables it. Adds `'unsafe-eval'` to the guest policy (strings run as code; WebAssembly too) and enables [`execute()`](#executecode). For testing; warns once per element. |
| `origins` | `SandboxOrigins` | none | all (strict: no `scripts`) | The exact origins the guest may load each kind from: connections, images, styles, fonts, media, scripts. See [below](#origins). |
| `entry` | `string` | none | strict | The path of a registered JavaScript file the worker runs first. Ignored with a warning in other modes. If it is not a registered JavaScript file the sandbox terminates (`the guest entry "…" is not a registered JavaScript file`). |
| `watchdogTimeout` | `number` (ms) | `0` (off) | all | Terminates a guest that stops answering for this long (`the guest stopped responding (watchdog)`). Anything but a finite number `> 0` is off. Bounds a looping guest in strict and worker mode on every browser, and in cooperative mode only where the browser runs the frame in its own process. Starts at `ready`, so it covers the guest's startup scripts too. Needs the guest bootstrap to run. [ADR-003](ADR-003-lifecycle-and-liveness.md) |
| `workerExecutionTimeout` | `number` (ms) | `0` (off) | strict, worker | A deadline for each `execute()`, this long after the element posts the code, at which the guest's event loop must be free: the element pings the guest, and if no answer arrives within `EXECUTION_TIMEOUT_GRACE_MS` the sandbox ends: a `sandbox-log` line `Execution Timeout` (`source: 'host'`), then `terminated` with `the executed code ran longer than workerExecutionTimeout`. See [`execute()`](#executecode). Anything but a finite number `> 0` is off. |
| `autoResize` | `boolean` | `false` | strict, cooperative | Only a literal `true` enables it. The element's height follows the guest's content height, from `ready` on (the guest document may still be loading then); see [Limits](#limits) for the bounds. In worker mode it does nothing, with one warning. Without it, the height is left to your CSS. |
| `fetchBridge` | `FetchBridgeConfig` | off | all | Opens [`sandboxFetch()`](#sandboxfetch); the host makes each request. A config without it turns the bridge off (`sandboxFetch()` rejects with `FETCH_NOT_ALLOWED`). [ADR-006](ADR-006-fetch-bridge.md) |
| `callLimits` | `CallLimits` | 1000 calls and 64 MiB per second | all | The per-second budget of the calls the guest makes, per environment; see [below](#calllimits). |
| `allowAnimations` | `boolean` | `true` | strict | Whether CSS animations and transitions run in the view. **While `true`, they run on your page's main thread wherever the browser runs the view there (Firefox, Safari and WebKit, Android, Chromium without sandboxed-iframe isolation), and the view's time budget does not bound them: a guest can keep your page 80–98% busy.** `false` removes them (elements show their end state). Left out or `true` keeps them; any other value turns them off, with one warning when it is not a boolean. Ignored with a warning in other modes. See [below](#allowanimations-and-allowautoplay). |
| `allowAutoplay` | `boolean` | `false` | strict | Whether `<video autoplay>` and `<audio autoplay>` in the view start on their own; while `false` the `autoplay` attribute is removed and media plays only when the user starts it. With `true`, playing media costs your page's main thread where the view shares it (measured up to +6 points for 20 looping videos), outside the time budget. Only a literal `true` enables it: left out or `false` keeps it off, and so does any other value, with one warning when it is not a boolean. Ignored with a warning in other modes. See [below](#allowanimations-and-allowautoplay). |
| `guestWrites` | `boolean` | `false` | all | Only a literal `true` enables it. The guest's [`sandboxFiles.write()` and `remove()`](#sandboxfiles) are recorded by the element as pending changes of this environment; they reach the files only through [`commitGuestWrites()`](#commitguestwritespaths-options). See [Guest writes](#guest-writes). |
<!-- generated:end -->

### `origins`

<!-- describes: origins, csp:cooperative, csp:strict, api:SandboxOrigins, api:StrictSandboxOrigins sig:d2625d10c742493659f5 -->
The guest's policy is one fixed template per mode. `origins` adds exact origins to six of its directives, one list per
kind of load, and can change nothing else:

```js
sandbox.setConfig({ origins: { connect: ['https://api.example.com', 'wss://ws.example.com'], images: ['https://cdn.example.com'] } });
```

| Kind | Directive | What loads from it |
| :--- | :--- | :--- |
| `connect` | `connect-src` | `fetch()`, `XMLHttpRequest`, `WebSocket` (`wss:` origins too), `EventSource`, `sendBeacon()`. |
| `images` | `img-src` | Images, CSS backgrounds, icons. |
| `styles` | `style-src` | Stylesheets: `<link rel=stylesheet>`, `@import`. Inline styles are always allowed. |
| `fonts` | `font-src` | `@font-face` fonts. |
| `media` | `media-src` | Audio, video, text tracks. |
| `scripts` | `script-src` | `<script src>`, modules, `importScripts()`. Not in strict mode. |

- **An entry is one exact origin**, `https://host[:port]`; in `connect` also `wss://host[:port]`; plain `http://` only
  for `localhost` and `127.0.0.1` (local development: an engine that upgrades insecure requests, as WebKit does, asks
  over https). Case is folded and a default port dropped. The host must be written as it is meant: no IPv6 literal (a
  policy cannot name one), IPv4 shorthand, percent-encoding, non-ASCII name (write its `xn--` form) or trailing dot.
  An `xn--` label is checked by the browser's own URL parser, and engines differ on invalid Punycode: one that an engine
  refuses is dropped there, so write the form your registrar gives.
- **Anything else is dropped** with one warning per entry: `https:` and other schemes, `*` and `*.example.com`,
  `'self'` and every other keyword, `data:`, `blob:`, paths, queries, credentials, whitespace, `;`. Dropping only
  narrows: a kind left with no origin admits none (`'none'`). A key that is not a kind is dropped with a warning.
- **An origin that reaches the host page's site or the user's machine warns**, in every mode, once per kind: the warning
  names the kind, each such origin and why. That covers the host page's own origin on any scheme or port, a
  subdomain or a parent of the host page's host (`api.example.com` and `example.com` for a page on `app.example.com`),
  and a loopback, private or link-local host (`localhost`, `127.0.0.1`, `10.x`, `192.168.x`, `169.254.x`). Firefox and
  WebKit attach the host site's `SameSite=None` cookies to a guest request to a same-site origin, so prefer
  [`fetchBridge`](#fetchbridge), which sends no credentials. The entry is kept; the warning is the only effect. The
  same-site check compares names and uses no public-suffix list: a sibling (`a.example.com` for a page on
  `b.example.com`) is not recognised, though a cookie set with `Domain=example.com` reaches it, and a public suffix
  above the host page counts as its parent. A name that only resolves to a private address is not recognised either.
- **Refused**: an `origins` that is not an object, or a kind that is not a list: the configuration could not be used.
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
form-action 'none'; manifest-src 'none'; upgrade-insecure-requests
```
<!-- generated:end -->

`'unsafe-inline'` in `script-src` admits inline scripts: the library's bootstrap is one, and it always runs. Strict
mode's view (its worker inherits it), where `<bootstrap>` is the hash of the library's one view script:

<!-- generated:begin csp-strict -->
```
default-src 'none'; script-src 'sha256-<bootstrap>'; script-src-attr 'none'; style-src 'unsafe-inline';
img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; worker-src blob:; frame-src 'none';
object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'; upgrade-insecure-requests
```
<!-- generated:end -->

[ADR-007](ADR-007-typed-origins.md)

### `fetchBridge`

<!-- generated:begin api-fetch-bridge -->
The `fetchBridge` option: what `sandboxFetch()` in the guest may reach. Only `allow` is required.

Every request the host makes is pinned to no credentials, no `Referer`, no redirects (refused with `FETCH_REDIRECT`),
`cache: 'no-store'` and CORS for the host page's origin. The host page's own origin and loopback, private and
link-local hosts are refused unless listed. A listed public name that resolves to a private address cannot be detected
from a page. A number that is not finite or is below 1 takes its default, and one above its bound takes the bound.
See [ADR-006](ADR-006-fetch-bridge.md).

| Field | Type | Default | What it does |
| :--- | :--- | :--- | :--- |
| `allow` | `string[]` | (required) | The exact origins the guest may reach: scheme, host and optional port, like `https://api.example` or `http://localhost:8080`. An entry with a path, query, fragment, credentials or `*` is dropped with a warning, and so is a value that is not a list. An empty list refuses everything. Listing the host page's own origin or a loopback, private or link-local host works, with one warning each. |
| `maxBytes` | `number` | `1048576` (1 MiB) | Most bytes of one response body, and of one request body. At most `33554432` (32 MiB). |
| `timeoutMs` | `number` | `10000` | Most ms for one request, response body included. At most `120000`. |
| `methods` | `string[]` | `['GET', 'HEAD', 'POST']` | The methods the guest may use, from `GET`, `HEAD`, `POST`, `PUT`, `PATCH` and `DELETE`. Replaces the default list. |
| `headers` | `string[]` | none | Header names the guest may set beyond `accept`, `accept-language`, `content-language` and `content-type`. `Authorization` only this way; `Cookie`, `Host`, `Origin`, `Referer`, `Sec-*`, `Proxy-*` and other forbidden names never. |
| `maxConcurrent` | `number` | `4` | Most requests in flight at once; a request past it is refused with `FETCH_BUSY`. At most `16`. |
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
| Chromium on the desktop | A process of its own from Chromium 127 (sandboxed frames are isolated); your page's thread where that isolation is off, as in the headless shell. |

Rendering follows script: wherever the view's script runs on your page's thread, so does its rendering.

**`allowAnimations: true`, the default: CSS animations and transitions in the view run on your page's main thread
wherever the browser runs the view there, and the view's time budget does not bound them.** A guest can keep your page
busy for as long as they run (measured with 5 000 animated elements: 80–98% of its main thread; scroll-driven
animations and transitions too). The budget bounds what the view does when the guest renders; an animation, once
rendered, runs without the view doing anything. Set `false` to remove animations and transitions from the view: every
element shows its end state, and the bound holds again. With `false` the view puts a stylesheet of its own before
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

Sets `html` (the guest document, or the initial view in strict mode), keeps the rest of the configuration and
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
the worker in worker and strict mode. It is compiled with the `Function` the bootstrap captured before any guest
code ran. Nothing reaches the host: no return value and no report that it returned.

- Needs `scriptUnsafe: true` and a string; otherwise it warns and does nothing.
- While the element is `'idle'` (not in the document) or `'terminated'` there is no environment: it warns and does
 nothing, where `call()` rejects.
- While `'loading'` the code is queued and sent when the build becomes `ready`. In cooperative mode it runs once the
 guest document is parsed (see [Ready and the startup gate](#ready-and-the-startup-gate)), in order with calls.
- A synchronous throw becomes a `sandbox-log` line (`level: 'error'`, `source: 'guest'`).
- In worker and strict mode each call has its own `workerExecutionTimeout` deadline. What it bounds is precise:
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
survives the copy).

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
- Calls made while `'loading'` are queued and sent when the build becomes `ready`, in every mode (strict mode
 included, whose view has its ports before it checks in); one that settles while queued (its timeout) leaves the queue
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
clamped, but remain the guest's data: read them, do not merge them into your objects.

| Event | `detail` | Bubbles | When |
| :--- | :--- | :--- | :--- |
| `ready` | none | no | The guest checked in and `state` is now `'ready'`. Once per environment. In cooperative mode the guest document may still be loading (see [Ready and the startup gate](#ready-and-the-startup-gate)). Without `allow-scripts` no guest script runs: `ready` comes with the frame's load, and calls time out. |
| `terminated` | `{ reason: string }` | no | The sandbox was terminated: `state` is `'terminated'` and `detail.reason` says why. Once per termination, for a call to `terminate()`, a budget or liveness check that ended the guest, a failed frame check, or a configuration or build that was refused (that one in a task of its own, and not at all if another build started meanwhile). Removing the element ends its environment without this event. Branch on `state` and the event, not on the reason's text. |
| `sandbox-log` | `SandboxLog` | yes | A log line from the guest's console or written by the element; see `SandboxLog`. Guest lines are limited to `LOG_EVENTS_PER_SECOND` per environment per second. |
| `violation` | `SandboxViolation` | yes | The guest's policy refused a load; see `SandboxViolation`. At most `VIOLATION_EVENT_LIMIT` per environment. A report is a claim by the guest, not a host fact. |
| `fetch` | `FetchRecord` | yes | A `sandboxFetch()` request settled, refusals included; see `FetchRecord`. Dispatched only with `fetchBridge` configured. Without it `sandboxFetch()` rejects with `FETCH_NOT_ALLOWED` and no event is dispatched. |
| `fileschanged` | `{ paths: string[] }` | no | `registerFiles()`, `unregisterFiles()` or `commitGuestWrites()` changed the files; `detail.paths` lists the paths that changed. Dispatched synchronously, once per call that changed something. |
| `fileswritten` | `{ paths: string[] }` | yes | The guest's write or removal changed what `listGuestWrites()` shows at a path (with `guestWrites`); `detail.paths` holds that one path. At most `GUEST_WRITES_PER_SECOND` per environment per second. |
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
| `args` | `readonly unknown[]` | What was logged, structured-cloned: at most `LOG_MAX_ARGS` values, strings cut at `LOG_MAX_STRING` characters, all of them together at most `LOG_MAX_BYTES` (1 MiB). An argument past what is left of that is replaced by a string that says so. |
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
together, whatever they are (a typed array, an object of 100 000 keys), measured as [`call()`](#callmethod-args)
measures a message: an argument past what is left of it is a string saying so (`[Uint8Array: past the log line's byte
budget (1048576)]`), and one holding a value the measure does not know (an `ImageData`) a string naming it
(`[unsupported value: ImageData]`); when even that string would not fit, the line ends with one string saying how many
arguments it dropped (`[Sandbox] 3 more argument(s) past the log line's byte budget (1048576)`), so a line never
measures past `LOG_MAX_BYTES` where it arrives. An `Error` anywhere in an argument (in an object, an array, a `Map`, a `Set`,
`Promise.allSettled`'s results; within 64 levels and 10 000 objects) is sent as `{ name, message, stack }` first.
The guest applies them before a line is posted, and sends at most `LOG_EVENTS_PER_SECOND` lines and 4 MiB in any one-second window (one `warn` line when it
starts dropping), so a flood never reaches the host page's thread. In cooperative mode the browser's own console gets a
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
| `[Sandbox] …` | error | host | the host page's policy refused a frame of the library's: … is the termination's reason, which follows |
| `[Sandbox] the guest logged more than 1000 lines in one second; lines past that rate are not dispatched as 'sandbox-log' events.` | warn | host | once per environment, when the element first drops guest lines past LOG_EVENTS_PER_SECOND |
| `[Sandbox] the view spent more than 2000 ms on one operation; a second such operation within 5 minutes ends the sandbox.` | warn | host | strict mode, once per environment: the view's first overrun (VIEW_FIRST_OVERRUN) |
| `[Sandbox] the guest raised more than 1000 uncaught errors in one second that only the view could describe; errors past that are dropped in the view.` | warn | guest | strict mode, once per environment: the view dropped a guest error text past its window (GUEST_TEXT_DROPPED) |
<!-- generated:end -->

### `violation` — `SandboxViolation`

<!-- generated:begin api-violation -->
The `detail` of a `violation` event: the guest's policy refused a load. Guest-supplied: validated and clamped, but not
trusted.

A report is evidence that the guest attempted something the policy refused, never a host fact: guest code can suppress
its own reports, a frame the guest creates reports to itself, and worker reports depend on the engine (WebKit raises
none in workers). At most `VIOLATION_EVENT_LIMIT` events per environment; in strict mode per `source`, and for the
view per directive, so refused loads of one kind never hide a report of another. See [ADR-005](ADR-005-strict-mode.md).

| Field | Type | Meaning |
| :--- | :--- | :--- |
| `directive` | `string` | The effective directive that refused the load, e.g. `'connect-src'` or `'img-src'`. |
| `blockedURI` | `string` | What was refused: a URL (possibly reduced to its origin by the browser; a `data:` or `blob:` URL is reported by its scheme alone), or `'inline'`, `'eval'` and the like. At most 2048 characters. |
| `sourceFile` | `string?` | Where the refused code ran, when the browser says (a `blob:` URL, `about:srcdoc` and the like). At most 2048 characters. |
| `lineNumber` | `number?` | The line of the refused code, a positive integer, when the browser gives one. |
| `columnNumber` | `number?` | The column of the refused code, a positive integer, when the browser gives one. |
| `source` | `'view' \| 'logic'?` | Strict mode only ([ADR-005](ADR-005-strict-mode.md)): which document's report this is, set by the element from the port it arrived on, never read from the report. `'view'` is the view document, which runs no guest code, so its reports are the library's own and complete up to the cap. `'logic'` is the worker, whose reports guest code can forge or suppress like any cooperative-mode report, and which depend on the engine (WebKit raises none in workers; Firefox raises the worker's `importScripts()` refusals in the view, so those arrive as `'view'`). |
<!-- generated:end -->

### `fetch` — `FetchRecord`

<!-- generated:begin api-fetch-record -->
The `detail` of a `fetch` event: one request through the bridge, reported once when it settled. A union keyed by
`outcome`; each member has exactly the fields its outcome has, and the fields it lacks are typed `never`, so reading
one is allowed and gives `undefined`.

- `'ok'`: a response was handed to the guest, whatever its HTTP status. Has `status`; has no `code`.
- `'refused'`: no request was made; the bridge's rules, or the browser's `Request`, refused it. `code` says why
 (`FETCH_NOT_ALLOWED`, `FETCH_BUSY` or `FETCH_TOO_LARGE` for a request body). `bytes` is `0`. `reason` is present for
 a refusal of an origin that is not listed: what the host knows beyond the text the guest gets (the host page's own
 origin, or a loopback, private or link-local host).
- `'failed'`: `fetch()` was called and no whole response was handed over; `code` says why (`FETCH_REDIRECT`,
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
URL. `bytes` counts the response body bytes read. `durationMs` runs from the request to its settlement.

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
| `the guest entry failed to start` | Strict mode: the entry threw or did not parse. |
| `the sandbox's startup script did not run: the host page's Content-Security-Policy must allow it (see docs/API.md#host-page-policy)` | The frame loaded but the library's startup script (strict mode's view bootstrap, cooperative and worker mode's bootstrap) never checked in: the host page's policy refused it. See [Host page policy](#host-page-policy). |
| `the sandbox's worker could not be loaded: the host page's policy refuses blob: workers (worker-src; WebKit also under Cross-Origin-Embedder-Policy; see docs/API.md#host-page-policy)` | Strict and worker mode: the worker's script could not be loaded at all; nothing of the guest's ran. Worker mode is never `ready` then. |
| `the host page's Trusted Types policy does not allow the policy name 'web-sandbox' (trusted-types; see docs/API.md#host-page-policy)` | The host page enforces Trusted Types and its `trusted-types` directive does not name `web-sandbox`, also when the host page's own default policy takes the element's strings (the view and worker mode's frame need the policy themselves). |
| `the guest entry "…" is not a registered JavaScript file` | Strict mode: `entry` names no registered JavaScript file. |
| `the sandbox view stopped responding` | Strict mode: the view did not answer for `VIEW_LIVENESS_TIMEOUT_MS` (always on). |
| `the view spent more than 2000 ms on one operation twice within 5 minutes` | Strict mode: an operation of the view (a render, `text()` or `set()` applied, with its layout and the rendering update that showed it) took longer than 2000 ms, measured as the view's time budget measures it, and another one had, at most 5 minutes before it. The first such operation only logs a `warn` line (see [`sandbox-log`](#sandbox-log--sandboxlog)); see [`sandboxView`](#sandboxview-strict-mode). |
| `unknown mode …` | `mode` is not `strict`, `cooperative` or `worker`. For `'iframe'` the reason ends `('iframe' was renamed 'cooperative')`. |
| `the configuration could not be used (…)` | `setConfig()` got something that is not an object or cannot be cloned, an `origins` that is not an object, or a kind of it that is not a list. |
| `the environment could not be built (…)` | Building the frame failed. |
| `the executed code ran longer than workerExecutionTimeout` | The guest's event loop was still busy `EXECUTION_TIMEOUT_GRACE_MS` after an `execute()` deadline. |
| `the sandbox frame loaded a second time` | Something navigated or reloaded the library's frame (also before its first load, once the guest had checked in). |
| `the guest frame announced itself again (it reloaded or rewrote its document)` | Cooperative and worker mode: the guest frame announced a second port (it reloaded itself, rewrote its document so the bootstrap ran again, or posted a forged announcement), or announced one where no bootstrap runs. |
| `the sandbox did not finish loading` | The build was still `loading` after `LOAD_TIMEOUT_MS` of host time and its frame had not loaded (without `allow-scripts`: subresources included). |
| `the guest frame is missing` | The library's frame has no guest frame. |
| `the guest raised more uncaught errors or unhandled rejections in one second than their budget allows` | Worker and strict mode: past the budget of uncaught errors and rejections (see [`sandbox-log`](#sandbox-log--sandboxlog) and [Limits](#limits)). |
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
| `FETCH_FAILED` | Network error, CORS, or the environment was torn down. | yes |

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
| `NOT_FOUND` | guest `sandboxFiles` | Any lookup of a path that is not there, exactly as written; a `remove()` of a path that is in neither the files nor the guest's writes. |

In the guest, the codes other than `NOT_FOUND` come from the element through the broker, so `write()` and
`remove()` can also reject with a [call code](#calls-rpcerrorcode) such as `BUSY` or `TERMINATED`.

---

## Guest globals

<!-- describes: worker-globals sig:389e -->
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
also `WebAssembly` unless `scriptUnsafe` (WebKit compiles it without `'wasm-unsafe-eval'`, so the policy alone does not
keep it out; cooperative mode keeps it, a frozen limit), and in strict mode `URL.createObjectURL`. In strict mode the view document
runs no guest code at all, and acts only on trusted events: a synthetic event is never forwarded to `sandboxView.on`.

**The worker's globals are an allowlist** (worker and strict mode): before anything else runs in it, the worker keeps
only the names listed in `src/lib/worker-globals.ts` (`WORKER_GLOBALS`, and `WORKER_NAVIGATOR_MEMBERS` for
`navigator`) and deletes every other one, so a platform API that is not listed is absent. Four listed globals can make
a request, each governed by the policy on every engine: `fetch`, `XMLHttpRequest` and `WebSocket` (`connect-src`) and
`importScripts` (`script-src`). Kept: the language's built-ins, timers, events, `MessageChannel` within the worker,
encoding, streams, `crypto`, `Blob`, `File`, `URL`, IndexedDB, `OffscreenCanvas` with 2D and WebGL, WebCodecs,
`performance`, `scheduler`, `BroadcastChannel`. Absent: `EventSource`, `WebTransport`, `WebSocketStream`, `FontFace`
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
| `url` | `(path: string) => string` | The file's `blob:` URL, minted in the guest's own realm. Throws `NOT_FOUND`. In strict mode's worker, only for the types the view shows (below); any other file is `read()` and `text()` only. |
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
has accepted them: `list()`, `read()` and `text()` show them, `url()` of a written path is `NOT_FOUND` (the guest
gets no URL for anything it wrote). The element checks each request as `registerFiles()` would (path, entry, type, the
quota with every pending change applied) and at most `GUEST_WRITES_PER_SECOND` requests and
`GUEST_WRITE_BYTES_PER_SECOND` bytes in any one-second window; a refused request changes nothing on either side. Nothing the
guest writes reaches the files, a policy or another environment until the host calls
[`commitGuestWrites()`](#commitguestwritespaths-options); it is listed by
[`listGuestWrites()`](#listguestwrites) and announced by `fileswritten`. Without `guestWrites`, both methods
reject with `FILES_NOT_ALLOWED`, and so does the element for any request that reaches it. Treat written
content as the guest's data. [ADR-004](ADR-004-files-as-blob-urls.md)

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

`sandboxFetch(url: string, init?: { method?, headers?, body? }): Promise<Response>` — asks the host to make the
request under the [`fetchBridge`](#fetchbridge) rules; without `fetchBridge` every request rejects with
`FETCH_NOT_ALLOWED`. Only `method`, `headers` and `body` are read from `init`, each once;
the body is a string, an `ArrayBuffer` or a typed array. Resolves with a whole `Response` (no streaming, no
`AbortSignal`); rejects with a [`FetchErrorCode`](#sandboxfetch-fetcherrorcode). `fetch` itself is untouched;
assign `globalThis.fetch = sandboxFetch` to route through the bridge. [ADR-006](ADR-006-fetch-bridge.md)

### `sandboxView` (strict mode)

<!-- describes: limit:VIEW_MAX_ELEMENTS, limit:VIEW_MAX_DEPTH, limit:VIEW_MAX_CHARACTERS, limit:VIEW_RENDER_CHARACTERS_PER_SECOND, limit:VIEW_EVENT_LIMITS.maxString, limit:VIEW_EVENT_LIMITS.maxIds, limit:VIEW_EVENT_LIMITS.maxFields, limit:VIEW_EVENT_LIMITS.maxTotal sig:7329ee0cf6ced5b39f62b689f003b322 -->
| Member | Signature | Description |
| :--- | :--- | :--- |
| `render` | `(html: string, into?: string \| null) => void` | Replaces the view's body, or the children of the element with id `into`. At most `VIEW_RENDER_MAX_LENGTH` characters (else `RangeError`). The latest render per target wins; one operation is in flight at a time. |
| `text` | `(id: string, text: string) => void` | Makes `text` the only content of the element with that id, as text: the view assigns it and parses nothing, so nothing needs escaping. At most `VIEW_RENDER_MAX_LENGTH` characters (else `RangeError`). Shares its slot with `render`: the latest of the two per target wins. |
| `set` | `(id: string, fields: { value?: string, checked?: boolean, focus?: boolean }) => void` | Sets the value of an `input`, `textarea`, `select` or `output` (not a file input), the checked state of an `input`, or focuses the element. Any other key, or a field of another type, is a `TypeError`; a value past `VIEW_RENDER_MAX_LENGTH` characters a `RangeError`. |
| `on` | `(type, id: string \| null, handler: (detail) => void) => () => void` | Subscribes to `click`, `input`, `change`, `submit` or `keydown` on the element with that id (or inside it), or anywhere with `null`. Returns `off`. |

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
Never an event handler. `src`, `srcset` and `poster` keep a registered file's path, a relative URL (which loads
nothing), or an `https:` or `http:` URL of an origin [`origins`](#origins) lists for that load (`images` for `img`,
`srcset` and `poster`, `media` for `audio`, `video`, their `source` and `track`), never `data:` or `javascript:`. A URL
the view's policy might refuse is dropped before insertion, so the browser never loads or refuses it: an `https:` or
`http:` URL is kept only when its scheme, host and port are exactly those of a listed origin, or, for an image, when it
is an `http:` URL whose `https:` form is (the policy upgrades an image's `http:` URL on every engine; not on a loopback
host, which Chromium does not upgrade). So write URLs in the form you list them. A dropped `https:` or `http:` URL is
reported as a `violation` with the directive and the URL (without credentials or fragment), within the same cap; a URL
of any other scheme is dropped without a report (no engine would request it). CSS is not rewritten: a URL a stylesheet
or a `style` attribute names (`url()`, `image-set()`) is left to the browser, which refuses and reports a refused one. SVG `fill`, `stroke`, `clip-path` and `mask`
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
drag) carry no URL of the guest's. To open external URLs, expose a host method and call it from a click handler:

```js
sandbox.expose('openExternal', (url) => { if (allowed(url)) window.open(url, '_blank', 'noopener'); });
// in the worker: sandboxView.on('click', 'docs', () => bridge.call('openExternal', 'https://example.com/docs'));
```

An event handler receives:

```ts
{
    type: 'click' | 'input' | 'change' | 'submit' | 'keydown',
    ids: string[],                       // ids of the target and its ancestors, nearest first
    target: { tag: string, id: string, name: string, value: string, checked: boolean },
    key?: string,                        // keydown
    form?: [name: string, value: string][], // submit
    truncated?: true,                    // something in this detail was cut
}
```

Never a URL. Strings are cut at 65536 characters, `ids` at 32 entries, `form` at 1000 fields, and all strings of
one detail together at 262144 characters; a detail that was cut has `truncated: true`. A handler that throws is
logged and does not stop the others. [ADR-005](ADR-005-strict-mode.md)

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

| | `strict` (default) | `cooperative` | `worker` |
| :--- | :--- | :--- | :--- |
| For | content you do not trust | cooperative content | headless code (frozen) |
| Guest code runs in | a worker; the view runs only the library's hash-admitted script | the guest document | a worker spawned inside the frame |
| Guest markup | `html` is the initial view, rendered without scripts or handlers; then `sandboxView.render()` | `html` / `load()` | none |
| How code starts | `entry`, `execute()` | markup scripts, `execute()` | `execute()` |
| `autoResize` | ✓ | ✓ | — |
| `workerExecutionTimeout` | ✓ | — | ✓ |
| Watchdog bounds a loop | ✓ | where the frame runs in its own process | ✓ |
| `unsafeCapabilities` | — | ✓ | ✓ |
| Files named from markup | `src`, `href`, `poster` in rendered markup | ✓ | — |
| Worker globals | allowlist | — | allowlist |

A config without `mode` is strict. `'iframe'` was renamed `'cooperative'`; it starts nothing, like any value that is not
a mode. [ADR-005](ADR-005-strict-mode.md)

**What strict mode does not cover**: the host page's availability wherever the view shares the host page's thread
(Firefox, Safari and WebKit, Android, Chromium without sandboxed-iframe isolation; desktop Chromium 127+ runs it in a
process of its own): there the view's cost is the bound stated in [The view's cost to the host page](#the-views-cost-to-the-host-page),
and what it lists as outside it. Cooperative mode is no better there. Also
CSS within what the policy allows, the worker's `violation` reports (per engine, guest-influenced), a worker that closes itself (only the watchdog notices), memory, and the host site's
cookies on requests to allowed same-site origins (every mode).

**Cooperative-mode limits**, a frozen list (cooperative content only: the library adds no guest-realm patches for
new findings there, it lists them): same-thread execution; frames and workers the guest creates; WebKit's preconnect;
focus and the clipboard; messages to the host window; the user's link actions and modifier clicks the guest's script
synthesizes (a new top-level tab without `allow-popups`; with `allow-forms`, Chromium submits a form that way past
`form-action`); session history; guest-only stalls; forgeable reports; the host page's URL and origin; the host page's
Trusted Types requirement. Each is described in the
[README](../README.md#cooperative-mode-limits). Worker mode shares only the reports: the worker's are per engine, as
in strict mode.

---

## Limits

<!-- generated:begin limits -->
| Limit | Value | Exported constant |
| :--- | :--- | :--- |
| Inbound calls running at once, per side and environment | 256 | `MAX_INBOUND_IN_FLIGHT` |
| Guest calls per second, per environment (any one-second window; default of `callLimits.maxPerSecond`) | 1000 | — |
| Bytes of guest calls per second, per environment (any one-second window; default of `callLimits.maxBytesPerSecond`) | 67108864 (64 MiB) | — |
| Default call timeout (ms) | 30000 | — |
| Characters of a method name | 256 | — |
| Characters of an error message a call carries | 65536 | — |
| Guest log lines per second, per environment | 1000 | `LOG_EVENTS_PER_SECOND` |
| Guest log lines kept until the guest is connected | 1000 (and 4 MiB) | — |
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
| Fetch: characters of a URL, as written and as parsed | 8192 | — |
| Guest writes: requests per second, per environment | 100 | `GUEST_WRITES_PER_SECOND` |
| Guest writes: bytes per second, per environment | 8388608 (8 MiB) | `GUEST_WRITE_BYTES_PER_SECOND` |
<!-- generated:end -->

The same limits by channel of guest activity, each with the test that checks it: [Budgets](#budgets).

---

## Budgets

Every channel through which guest activity makes the host page, the view or the network do work, with its bounds in
count, bytes and time, the constant behind each, the bound on what it costs the host page, and the test that checks it.
A channel with no bound in one of the three says why in that cell. The table is `CHANNEL_BUDGETS` of
`src/lib/egress.ts` rendered with the code's values (`test/unit/budgets.test.ts` keeps the rest equal), next to the egress
table of every surface those channels cross: a surface that relays, budgets or caps and is no channel's fails that test.

It is also where a documented cost to the host page lives: a finding whose only effect is that the guest slows the host
page, within a stated bound the embedder can end, is fixed by that bound in the cost column (for the strict view, by
[The view's cost to the host page](#the-views-cost-to-the-host-page)). The cost column states bounds only: a share, a cap
or a constant. Measured figures stand in the note under the table, with their date and engines.

<!-- generated:begin budgets -->
| Channel | Count | Bytes | Time | Bound on the cost to the host page | Test |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Guest log lines, to `sandbox-log`: the console relay, and the uncaught errors and rejections it relays | `LOG_EVENTS_PER_SECOND` (1000) lines in any second, counted by the guest and again by the host; `LOG_MAX_ARGS` (64) arguments a line | `LOG_MAX_BYTES` (1048576) a line, measured by both ends, placeholders included; `LOG_BYTES_PER_SECOND` (4194304) a second, by the guest; a string argument cut at `LOG_MAX_STRING` (65536) characters | none of its own: one event a line | none beyond the count and the bytes | test/unit/relay-and-rpc-budgets.test.ts (R3-3); test/unit/structural.test.ts |
| Uncaught errors and unhandled rejections of the guest's worker, which the browser reports (worker and strict mode) | `UNCAUGHT_PER_SECOND` (1000) in any second, rejections handled later included; past it the sandbox ends | `UNCAUGHT_CHARACTERS_PER_SECOND` (1048576) characters of their names and messages in any second; past it the sandbox ends | none of its own: the count and the characters | Firefox reports each on the host page's thread, cancelled or not: bounded by the count and the characters, and past them the sandbox ends; one report is not bounded, since the browser makes it before the sandbox can end | test/e2e/error-cost-and-queued-calls.spec.ts (N-1); test/unit/egress.test.ts |
| Calls the guest makes (`bridge.call`), to the embedder's methods | `callLimits.maxPerSecond` in any second, by default `GUEST_CALLS_PER_SECOND` (1000), counted by the guest and again by the host; `MAX_INBOUND_IN_FLIGHT` (256) running at once | `RPC_MAX_BYTES` (34603008) a call, its whole frame measured by both ends; `callLimits.maxBytesPerSecond` a second, by default `GUEST_CALL_BYTES_PER_SECOND` (67108864); `RPC_MAX_INBOUND_BYTES` (67108864) of arguments running at once; a method name of at most `MAX_NAME_LENGTH` (256) characters | none of its own: the embedder's methods run as long as they take | none beyond the count and the bytes | test/unit/rpc-bounds-and-call-limits.test.ts (M-2, C-1); test/unit/config-schema.test.ts; test/unit/rate-limit.prop.test.ts |
| Answers to the host's calls (`bridge.expose`) | one a call the host made: the host's pending calls | `RPC_MAX_BYTES` (34603008) an answer, measured by both ends; an error text cut at `MAX_TEXT_LENGTH` (65536) characters by both ends | the host's call timeout (`callWithTimeout`; by default `DEFAULT_TIMEOUT_MS` (30000) ms) | none beyond the host's pending calls and the bytes | test/unit/rpc-bounds-and-call-limits.test.ts (C-1); test/unit/structural.test.ts |
| Guest writes (`sandboxFiles.write`, `remove`) | `GUEST_WRITES_PER_SECOND` (100) requests in any second, and each as a call; what is kept, at most `MAX_FILES` (1000) files with the registered ones | `GUEST_WRITE_BYTES_PER_SECOND` (8388608) in any second; what is kept, at most `MAX_TOTAL_BYTES` (8388608) with the registered files | none of its own: the count and the bytes | none beyond the count and the bytes | test/unit/guest-writes.test.ts; test/e2e/guest-writes.spec.ts |
| `sandboxFetch()`: the host page's fetch, on the guest's behalf | `fetchBridge.maxConcurrent` at once, at most `MAX_MAX_CONCURRENT` (16); and each as a call | `fetchBridge.maxBytes` a response, at most `MAX_MAX_BYTES` (33554432) | `fetchBridge.timeoutMs` a request, at most `MAX_TIMEOUT_MS` (120000) ms | none beyond the count, the bytes and the time: each request is the host page's own fetch | src/lib/fetch-bridge.test.ts; test/e2e/fetch-bridge.spec.ts |
| CSP violation reports, to `violation` | `VIOLATION_EVENT_LIMIT` (100) events an environment (strict mode: per source, and per directive for the view) | each string cut at `VIOLATION_MAX_STRING` (2048) characters before it is posted, by the bootstrap and by the view, and again by the host on receipt | none of its own: the count | none beyond the count | src/lib/in-sandbox-script.test.ts (violation reports); test/e2e/violations.spec.ts; test/unit/structural.test.ts |
| Content heights (`autoResize`), to the frame's height | `AUTO_RESIZE_MAX_UPDATES_PER_SECOND` (30) a second, and one a frame | a number, at most `AUTO_RESIZE_MAX_HEIGHT` (100000) px | none of its own: one relayout of the host page's frame a change | a cap: `AUTO_RESIZE_MAX_UPDATES_PER_SECOND` (30) relayouts of the host page's frame a second | src/lib/auto-resize.test.ts; test/e2e/auto-resize.spec.ts |
| Liveness answers (PONG, VIEW_PONG), to the host's probes | one a probe of the host's | a number | `VIEW_LIVENESS_TIMEOUT_MS` (5000) ms for the view to answer; `EXECUTION_TIMEOUT_GRACE_MS` (1000) ms past a deadline for the worker (`workerExecutionTimeout`) | none: the library's own | src/lib/watchdog.test.ts; test/e2e/watchdog.spec.ts |
| Strict: the guest's error texts the view relays (GUEST_ERROR, GUEST_UNCAUGHT), to `sandbox-log` | `LOG_EVENTS_PER_SECOND` (1000) a second, counted in the view | each cut at `VIEW_OPTIONS.guestText.maxLength` (2048) characters in the view, before it is posted | none of its own: one line each | none beyond the count and the bytes | test/unit/rpc-bounds-and-call-limits.test.ts (C-4); test/e2e/worker-port-and-view-cost.spec.ts (M-5) |
| Strict: the view's operations (`sandboxView.render`, `text`, `set`) | one at a time; the body holds at most `VIEW_MAX_ELEMENTS` (50000) elements, `VIEW_MAX_DEPTH` (256) deep | `VIEW_RENDER_MAX_LENGTH` (262144) characters an operation; `VIEW_RENDER_CHARACTERS_PER_SECOND` (1048576) a second; `VIEW_MAX_CHARACTERS` (1048576) in the body | `VIEW_APPLY_MS_PER_SECOND` (200) ms a second on average, each operation charged in full; the second operation past `VIEW_MAX_OPERATION_MS` (2000) ms within `VIEW_OVERRUN_WINDOW_MS` (300000) ms ends the sandbox | a share: at most `VIEW_APPLY_MS_PER_SECOND` (200) ms of each second, averaged; see [The view's cost to the host page](#the-views-cost-to-the-host-page) | test/e2e/view-bound.spec.ts; test/e2e/view-budget.spec.ts; test/unit/view-budget.prop.test.ts |
| Strict: the view's loads (URL attributes, CSS, and what the browser reports) | `VIEW_URLS_PER_SECOND` (200) a second, each charged before it can start; `VIEW_MAX_URLS` (1000) URL attributes in the body; `VIEW_MAX_DISTINCT_URLS` (10000) distinct URLs over the view's life | what the policy's origins serve: no budget of the library's | none of its own: the rate | a rate: at most `VIEW_URLS_PER_SECOND` (200) loads a second; see [The view's cost to the host page](#the-views-cost-to-the-host-page) | test/e2e/worker-port-and-view-cost.spec.ts (M-2); test/e2e/strict-view-budget.spec.ts; test/unit/view-css-loads.test.ts; test/unit/view-budget.prop.test.ts |
| Strict: the view's events, to the guest's `sandboxView.on` handlers | as the user raises them, of the types a handler listens to; `VIEW_EVENT_LIMITS.maxIds` (32) ids and `VIEW_EVENT_LIMITS.maxFields` (1000) form fields a detail | each string cut at `VIEW_EVENT_LIMITS.maxString` (65536) characters, all of one detail at `VIEW_EVENT_LIMITS.maxTotal` (262144) | none of its own: the user's input | none beyond the user's own input | test/e2e/strict-events.spec.ts |
| Strict: the view's overrun notices (VIEW_FIRST_OVERRUN, VIEW_OVERRUN), to `sandbox-log` and `terminated` | a first overrun's at most once per 9 s of its debt, and one host line an environment; the second ends the sandbox | none: no field | none of its own: the count | a stall past `VIEW_MAX_OPERATION_MS` (2000) ms at most once per `VIEW_OVERRUN_WINDOW_MS` (300000) ms beyond the first; see [The view's cost to the host page](#the-views-cost-to-the-host-page) | test/unit/strict-view-budget.test.ts (the repeated-overrun rule); test/e2e/view-bound.spec.ts |
| Cooperative: the guest's own document | none: the guest runs on the host page's thread wherever the engine puts its frame there | none | none: one loop can freeze the host page ([Modes](#modes)) | unbounded: a cooperative-mode limit | README (cooperative-mode limits) |
<!-- generated:end -->

<!-- describes: budgets sig:f207 -->
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
| Desktop Chromium 127+ (`IsolateSandboxedIframes`) | a process of its own | the view's own process; the host page's thread gets only the view's bounded notices (VIOLATION, GUEST_ERROR, RESIZE) |
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

The server's latency is in none of the first three: nothing an operation can load waits for its response to be charged
(review round 5, M-3, where it did: behind a slow server every render applied meanwhile got through, and Firefox made
5 000 loads over an 11.1 s flood). A load the browser itself defers (an image with `loading="lazy"` until it is
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

### (b) The single-operation bound

An operation that took longer than `VIEW_MAX_OPERATION_MS` (2000) ms as the meter measures it (its flush, forced layout
and rendering update) is an **overrun**. The view charges it in full, like any other, so the next operation waits until
the debt is repaid (at least 9 s, five times its cost less the 200 ms the budget held), and goes on; the first overrun of
an environment is said in one `warn` line on `sandbox-log`. The **second overrun within `VIEW_OVERRUN_WINDOW_MS`
(300000 ms, 5 minutes)** of the one before it ends the sandbox (`the view spent more than 2000 ms on one operation
twice within 5 minutes`), and no operation runs after it; an overrun later than that is a first overrun again, and the
window runs from it. Why not the first: the meter measures wall time on a thread the view shares with your page and the
machine, so under load it passes 2000 ms for operations that are healthy ([ADR-005](ADR-005-strict-mode.md)).

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
`VIEW_MAX_DISTINCT_URLS`, the host page's longest stall: Chromium 297 ms, Firefox 654 ms, WebKit 809 ms (review round 5,
M-4).

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
| `LOG_EVENTS_PER_SECOND` | 1000 | The guest's error texts the view posts to the host page per second (GUEST_ERROR and GUEST_UNCAUGHT frames, each cut to 2048 characters before posting). |
| `VIOLATION_EVENT_LIMIT` | 100 | `violation` events the host page dispatches from the view, per directive; every refusal is charged to `VIEW_URLS_PER_SECOND` all the same. |
| `UNCAUGHT_PER_SECOND` | 1000 | Uncaught errors and unhandled rejections of the guest's worker per second, which Firefox reports on the view's thread; past it the sandbox ends. |
| `UNCAUGHT_CHARACTERS_PER_SECOND` | 1048576 | Their characters per second; past it the sandbox ends. |

The call budgets (`callLimits`) and the worker's log budget do not touch the view: calls and log lines go between the
host page and the worker over the logic port, never through the view.

### (d) Outside the bound

This list is closed: a cost of the view not listed here and not inside (a) or (b) is a finding.

| What | Magnitude, measured | Source |
| :--- | :--- | :--- |
| CSS animations and transitions while `allowAnimations: true` (the default), and while they run | 5 000 animated elements: 81–92% busy (Firefox 21–89% by property); transitions 75–87%; scroll-driven animations 47–92%. `false` brings every vector back to idle. | [research 16](research/16_view_isolation/README.md#what-keeps-a-shared-thread-busy); [`allowAnimations`](#allowanimations-and-allowautoplay) |
| What else runs on its own, which `allowAnimations: false` does not stop: animated images, indeterminate `<progress>`, autoplaying media with `allowAutoplay: true` | 2 000 animated PNGs: WebKit 39% (+22 points), Firefox 12%; 5 000 `<progress>`: up to +4 points; 20 looping videos: up to +6 points | research 16 |
| Relayout after image decodes or font swaps: the browser's work after the frame the meter measured; only the load rate and the caps of (c) bound it | One render of 1 000 admitted images without dimensions above 15 000 paragraphs, the responses spread over 2 s, so that each arrival lays the paragraphs out again: over the 3 s after it, Chromium 40%, Firefox 22%, WebKit 37% busy, longest gap 226, 55 and 289 ms (the loads themselves included; (a)'s flood of images with dimensions, 3–8%). One `@font-face` swap over 15 000 paragraphs: 2%, 5% and 23% busy over the 3 s around it, longest gap 31, 54 and 214 ms. | [review round 5](archive/reviews/REVIEW-ROUND-5-2026-10-19.md), "What remains"; `test/e2e/view-bound.spec.ts` (d), on demand |
| The documented single-operation stalls, each one operation's own cost: CSS filters, bidirectional text, small CSS changes over many elements, selectors whose matching grows faster than the elements, `<img>` in Chromium, and WebKit's first value of a 250 000-character textarea | 10 `blur()`s on 1 000 elements: WebKit 3.7 s (100 on 1 000: over 180 s); 240 000 characters of bidirectional text in one paragraph: tens of seconds in Chromium and WebKit; a 31-character `text()` into a `<style>` over 46 000 elements: Firefox 7 s; a rule whose `:has()` looks at every later sibling, over 24 000 elements: Chromium 4.2 s, Firefox 8.9–9.2 s, WebKit 7.1–8.6 s; 6 500 `<img alt>`: Chromium 1.9–2.6 s, Firefox and WebKit about 150 ms (an example, measured 2026-10-18); the first `set()` of a 250 000-character textarea: WebKit over 2 s, an overrun the sandbox survives. Past `VIEW_MAX_OPERATION_MS` each is an overrun, after the stall: charged in full, and the second within `VIEW_OVERRUN_WINDOW_MS` ends the sandbox ((b)). | [broad review](archive/reviews/BROAD-REVIEW-2026-10-14.md), review rounds [1](archive/reviews/REVIEW-ROUND-1-2026-10-15.md), [4](archive/reviews/REVIEW-ROUND-4-2026-10-18.md) and [5](archive/reviews/REVIEW-ROUND-5-2026-10-19.md) |
| Memory: not bounded | No budget counts it. The caps of (c) bound what the document holds, not what that costs in memory (decoded images, the caches of up to `VIEW_MAX_DISTINCT_URLS` URLs, layout structures); measured only where it ended a run: a flood of large rejections took Firefox's content process to 7 GB before the uncaught budget ended such floods | [review round 5](archive/reviews/REVIEW-ROUND-5-2026-10-19.md), N-1 |
| `:hover` restyles driven by the user's pointer over many elements | 80–100% busy while the pointer moves (5 000 elements under a `:hover ~` rule) | research 16 |
| Firefox's cost of the worker's unhandled rejections, which it reports on the view's thread, cancelled or not | Within `UNCAUGHT_PER_SECOND`: 1 000 cancelled a second idle, 1 000 handled a tick later 4–7% busy, 1 Mi characters a second 6%; one rejection of 16 Mi characters about 0.5 s, after which the sandbox ends. A relay worker does not change it. | `src/lib/egress.ts`; [research 19](research/19_relay_worker/README.md) |

Outside the statement altogether, as everywhere: cooperative mode, whose guest runs in a frame that can freeze the host
page with one loop where it shares its thread ([Modes](#modes)).

---

## Host page policy

<!-- describes: api:viewScriptHash sig:ce76 -->
The sandbox's frames are `srcdoc` documents, and a `srcdoc` document inherits the policies of the page that made it:
a copy of its Content-Security-Policy list, its Trusted Types requirement and its Cross-Origin-Embedder-Policy. Every
policy in the list must allow a load, so your page's policy narrows the sandbox's, never widens it. What your page's
policy must allow:

| Your page's | strict (default) | cooperative | worker |
| :--- | :--- | :--- | :--- |
| `script-src` | the view bootstrap's hash, `'sha256-…'` (below), or `'unsafe-inline'`; `'unsafe-eval'` for `execute()` | `'unsafe-inline'` (the bootstrap and the guest's inline scripts; its hash changes with every build), plus what the guest loads | `'unsafe-inline'`, `'unsafe-eval'` for `execute()` |
| `worker-src` (or `script-src` without it) | `blob:` | — (`blob:` for workers the guest makes) | `blob:` |
| `style-src` | `'unsafe-inline'`, or the wrapper style's hash `'sha256-jKvfmEYIGlm8DGk4pp05gJ0MwYdTY+NU6tSvyPZyDow='`; with `allowAnimations: false`, also the view's animation stylesheet's hash `'sha256-+xgty2clGX4Uw4d4EP9TmDH+dSL1A5dfieXcAO96Zec='`; `'unsafe-inline'` for the guest's own inline styles | the same (no animation stylesheet) | the same (no animation stylesheet) |
| `img-src`, `media-src`, `font-src`, `connect-src` | `blob:` for registered files of that kind; every origin in `origins` | the same | the same |
| `frame-src` / `child-src` | nothing (a `srcdoc` frame loads no URL) | the same | the same |
| Trusted Types | `require-trusted-types-for 'script'` works: the element and the view assign through one policy named `web-sandbox`, which blesses only the sandbox's own documents; a `trusted-types` directive must name it (add `'allow-duplicates'` if two copies of the library share the page). Strings are not evaluated: `execute()` and the guest's `eval` are refused (Chromium, WebKit; Firefox has no Trusted Types) | the guest inherits the requirement: its scripts, the import map and the markup the bootstrap writes for registered files need Trusted Types too; `execute()` is refused | works (the frame starts the worker through the policy); `execute()` is refused |
| `Cross-Origin-Embedder-Policy: require-corp` | works in Chromium and Firefox; WebKit refuses the view's `blob:` worker | works; resources from `origins` need CORP or CORS headers | as strict |

- **What a refusal looks like**: the build ends with a reason that names your page's policy: `the sandbox's startup
  script did not run …` (a refused bootstrap), `the sandbox's worker could not be loaded …` (a refused `blob:` worker),
  `… does not allow the policy name 'web-sandbox' …` (Trusted Types). A refused wrapper style leaves the frame 150 px
  high, and the element warns with the hash to allow; so does a refused animation stylesheet (`allowAnimations: false`),
  whose view then shows no guest stylesheet.
- **Your `connect-src`, `img-src` and the other fetch directives narrow `origins` silently**: an origin listed in
  `origins` that your page's policy does not allow is refused in the sandbox too. The refusal happens in the sandbox's
  documents, so it arrives as the element's `violation` event (where the browser reports it), never as a
  `securitypolicyviolation` on your page, and nothing warns at `setConfig()`.
- **The view bootstrap's hash** is `viewScriptHash()`, the very value the element puts in the view's `script-src`.
  It is constant for one version of the package (the bootstrap is a string literal of the package's bundle, so your
  bundler or minifier does not change it), and it changes with the package's version, so it is not listed here: read
  it in a build step (importing the package needs no DOM, in Node or Bun) and put it in your page's policy:

  ```js
  import { viewScriptHash } from 'web-sandbox';
  const policy = `script-src 'self' ${viewScriptHash()}; worker-src blob:`; // viewScriptHash() is 'sha256-…', quoted
  ```

  The wrapper style's and the animation stylesheet's hashes are constants of the library, listed in the table above.

---

## Exports

Values:

<!-- generated:begin api-exports-values -->
| Export | What it is |
| :--- | :--- |
| `defineWebSandbox` | Registers `WebSandbox` as a custom element under `tagName` and returns the class. |
| `viewScriptHash` | The CSP hash source of strict mode's view bootstrap for this release of the package, to allow in the host page's own Content-Security-Policy. |
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
| `VIEW_LIVENESS_TIMEOUT_MS` | How long, in ms, strict mode's view may go without answering before the sandbox terminates ([ADR-005](ADR-005-strict-mode.md)). |
| `VIEW_RENDER_MAX_LENGTH` | The most characters (UTF-16 code units, 256 Ki) one strict-mode view operation may carry: the `html` of `sandboxView.render()`, the string of `text()` and the value of `set()`. |
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
| `RpcError` | The shape of every rejection of `call()` and `callWithTimeout()`: a plain `Error` with an own `code`. |
| `RpcErrorCode` | Why a call was refused: the `code` of an `RpcError`. |
| `RpcLibraryCode` | The codes a library method (a `sandbox:` name) reports, from one closed set disjoint from `RpcErrorCode`: the fetch bridge's `FetchErrorCode` values and the guest writes' `FileErrorCode` values. |
| `SafeCapability` | A member of `SAFE_CAPABILITIES`: an entry of the `capabilities` option. |
| `SandboxCapability` | A value that may end up in a frame's `sandbox` attribute: a `SafeCapability` or a member of `UNSAFE_SANDBOX_FLAGS`. |
| `SandboxConfig` | The configuration `setConfig()` takes: a union keyed by `mode`. |
| `SandboxConfigOptions` | The options every mode takes, and the ones a mode's config narrows (`StrictSandboxConfig`, `CooperativeSandboxConfig`, `WorkerSandboxConfig`). |
| `SandboxFiles` | The guest's view of the registered files: the global `sandboxFiles`, present in every environment (empty when no file is registered). |
| `SandboxLog` | The `detail` of a `sandbox-log` event: one log line, frozen. |
| `SandboxLogLevel` | The level of a `SandboxLog` line. |
| `SandboxOrigins` | The `origins` option: the exact origins the guest may load each kind of resource from, one list per kind. |
| `SandboxState` | Where the element is in its lifecycle; read it from `state`. |
| `SandboxViolation` | The `detail` of a `violation` event: the guest's policy refused a load. |
| `StrictSandboxConfig` | The configuration of strict mode ([ADR-005](ADR-005-strict-mode.md)), the default: guest code runs only in a worker that a view document spawns, and the worker draws into the view with `sandboxView.render()`. |
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

**Strict mode (the default) with files, a watchdog and the fetch bridge**:

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
sandbox.addEventListener('violation', (e) => console.warn(e.detail.directive, e.detail.blockedURI));
```
