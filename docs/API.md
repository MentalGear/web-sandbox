# API reference

The complete public surface of `web-sandbox`: the element, its configuration, methods and events, and the
globals the guest gets in each mode. For an overview start with the [README](../README.md); for why each part
is built the way it is, follow the links to the decision records (ADRs).

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
- [Host page policy](#host-page-policy)
- [Exports](#exports)
- [Examples](#examples)

---

## Registering the element

```ts
import { defineWebSandbox } from 'web-sandbox';

defineWebSandbox();                  // <web-sandbox>
defineWebSandbox('my-sandbox');      // or a tag name of your own (instead, not as well)
```

**`defineWebSandbox(tagName = 'web-sandbox'): typeof WebSandbox`** registers the `WebSandbox` class as a custom
element and returns it. Importing the package registers nothing, so you pick the name.

- Calling it again with the same name does nothing.
- It throws an `Error` if that name is already defined by another element.
- The class can be registered under one name only: a second, different name throws the browser's
  `NotSupportedError`.

---

## The element

The element has no observed attributes; everything is set through [`setConfig()`](#setconfigconfig) and the
other methods. It has one property:

| Property | Type | Description |
| :--- | :--- | :--- |
| `state` | `SandboxState` (read-only) | `'idle'`, `'loading'`, `'ready'` or `'terminated'`; see [Lifecycle](#lifecycle). |

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
back, it builds again.

The guest can post messages to the host page's window (any frame can; it reaches your own `message` listeners).
Act on a message only from a sender you know, by `event.source`, never by the message's shape. Do not give host
windows or frames names that host links, forms or `window.open()` target: a frame the guest creates can take such a
name (the guest's own frame cannot; its `window.name` is inert).

---

## Configuration

**`setConfig(config: SandboxConfig): void`** replaces the configuration and rebuilds the environment
(see [Lifecycle](#lifecycle)). `SandboxConfig` is a union keyed by `mode`: strict mode's `origins` has no `scripts`, and
a config without `mode` is a strict config (strict mode is the default).

- Each call is applied **over the defaults, not over the previous configuration**: an option left out returns
  to its default. That includes `html`, so a `setConfig()` after `load(html)` starts with an empty document
  unless it passes `html` again.
- The argument is copied (structured clone) before anything reads it: changing your objects or arrays afterwards
  changes nothing, not even at the next `reset()`.
- Values are validated before they are applied; what cannot be used is dropped with one `console.warn` per
  element, never applied half-way: an entry that is not allowed, a list option that is not a list, `html` that is not
  a string.
- The configuration the environment already stands on, set again, changes nothing: no rebuild and no event, so read
  `state` rather than wait for `ready` (anything a build reads
  that changed since, `load()` or the files, rebuilds as usual).
- A config that cannot be used at all (not an object, not cloneable: a `Proxy`, a function value; an `origins` that
  is not an object, or a kind of it that is not a list) applies nothing, and the sandbox terminates with the reason
  `the configuration could not be used (…)`, as for an unknown mode, until a usable config is set; the previous
  config stays. A build that fails terminates with `the environment could not be built (…)`. `setConfig()` never
  throws. `state` is `terminated` when it returns; the `terminated` event of a refused build comes in a task, like
  `ready`, and not at all if another build started meanwhile.
- `SandboxConfig` narrows each mode: `entry` only in strict mode, `workerExecutionTimeout` not in cooperative mode,
  `html` and `autoResize` not in worker mode, `unsafeCapabilities` not in strict mode. A config from JSON is held to
  the same rules at run time.

| Option | Type | Default | Modes | What it does |
| :--- | :--- | :--- | :--- | :--- |
| `mode` | `'strict' \| 'cooperative' \| 'worker'` | `'strict'` | — | Where guest code runs; see [Modes](#modes). Any other value starts no environment: the sandbox terminates with the reason `unknown mode …` until a valid mode is configured. `'iframe'` was renamed `'cooperative'`: refused the same way, and the reason says so. |
| `html` | `string` | `''` | strict, cooperative | The initial view (strict mode) or the guest document (cooperative mode). In strict mode its `<script>` elements and `on…` handler attributes never run, and markup that holds any warns once per element: ``strict mode (the default) runs no script in `html`; …``. Empty means `<div id="root"></div>`. Ignored in worker mode. Also set by [`load()`](#loadhtml). |
| `capabilities` | `SafeCapability[]` | `[]` | all | Sandbox flags that keep the guest inside the frame: `allow-scripts`, `allow-forms`, `allow-pointer-lock`, `allow-orientation-lock`. Anything else is dropped with a warning. Worker mode always adds `allow-scripts`; strict mode always has `allow-scripts allow-forms`. |
| `unsafeCapabilities` | `UnsafeCapability[]` | `[]` | cooperative, worker | Capabilities that act outside the frame: `allow-popups`, `allow-modals`, `allow-downloads`, `allow-presentation`, `fullscreen`. Each one enabled warns once. `fullscreen` is granted as `allow="fullscreen *"` (a Permissions Policy feature), the rest as sandbox flags. Dropped with a warning in strict mode. Without `allow-popups` guest code opens no window, but in cooperative mode the user's own Ctrl-, Shift- or middle-click, or Ctrl/Shift+Enter, on a guest link opens it in a new tab in Chromium and Firefox (platform behaviour of any sandboxed frame; see [Modes](#modes)). |
| `scriptUnsafe` | `boolean` | `false` | all | Only a literal `true` enables it. Adds `'unsafe-eval'` to the guest policy (strings run as code; WebAssembly too) and enables [`execute()`](#executecode). For testing; warns once per element. |
| `origins` | `SandboxOrigins` | none | all (strict: no `scripts`) | The exact origins the guest may load each kind from: connections, images, styles, fonts, media, scripts. See [below](#origins). |
| `entry` | `string` | none | strict | The path of a registered JavaScript file the worker runs first. Ignored with a warning in other modes. If it is not a registered JavaScript file the sandbox terminates (`the guest entry "…" is not a registered JavaScript file`). |
| `watchdogTimeout` | `number` (ms) | `0` (off) | all | Terminates a guest that stops answering for this long (`the guest stopped responding (watchdog)`). Anything but a finite number `> 0` is off. Bounds a looping guest in strict and worker mode on every browser, and in cooperative mode only where the browser runs the frame in its own process. Starts at `ready`, so it covers the guest's startup scripts too. Needs the guest bootstrap to run. [ADR-003](ADR-003-lifecycle-and-liveness.md) |
| `workerExecutionTimeout` | `number` (ms) | `0` (off) | worker, strict | A deadline for each `execute()`, this long after the element posts the code, at which the guest's event loop must be free: the element pings the guest, and if no answer arrives within `EXECUTION_TIMEOUT_GRACE_MS` the sandbox ends: a `sandbox-log` line `Execution Timeout` (`source: 'host'`), then `terminated` with `the executed code ran longer than workerExecutionTimeout`. See [`execute()`](#executecode). Anything but a finite number `> 0` is off. |
| `autoResize` | `boolean` | `false` | strict, cooperative | Only a literal `true` enables it. The element's height follows the guest's content height, from `ready` on (the guest document may still be loading then); see [Limits](#limits) for the bounds. In worker mode it does nothing, with one warning. Without it, the height is left to your CSS. |
| `fetchBridge` | `FetchBridgeConfig` | off | all | Opens [`sandboxFetch()`](#sandboxfetch); the host makes each request. A config without it turns the bridge off (`sandboxFetch()` rejects with `FETCH_NOT_ALLOWED`). [ADR-006](ADR-006-fetch-bridge.md) |
| `guestWrites` | `boolean` | `false` | all | Only a literal `true` enables it. The guest's [`sandboxFiles.write()` and `remove()`](#sandboxfiles) are recorded by the element as pending changes of this environment; they reach the files only through [`commitGuestWrites()`](#commitguestwritespaths-options). See [Guest writes](#guest-writes). |

### `origins`

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
- **Refused**: an `origins` that is not an object, or a kind that is not a list: the configuration could not be used.
- **Strict mode has no `scripts`**: a type error in TypeScript (`SandboxConfig` is a union keyed by `mode`), and dropped
  with one warning at run time, for a config from JSON. With a mode chosen at run time, type `origins` as
  `StrictSandboxOrigins`.
- **Registered files** add `blob:` to the directive of each kind of load their types are for (JavaScript: `scripts`;
  `text/css`: `styles`; `image/*`: `images`; `font/*`: `fonts`; `audio/*`, `video/*`, `text/vtt`: `media`; every
  file: `connect`), whatever `origins` lists. Strict mode never adds it to `script-src`.
- **`'unsafe-eval'`** is added to `script-src` by `scriptUnsafe` only.
- A `connectionsAllowed` key is ignored, with one warning: the policy is built from `origins` alone.

Every directive is always emitted (`'none'` when it admits nothing), so no browser falls back to `default-src`. With no
origins and no files, cooperative and worker mode get:

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none';
media-src 'none'; connect-src 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none';
form-action 'none'; manifest-src 'none'; upgrade-insecure-requests
```

`'unsafe-inline'` in `script-src` admits inline scripts: the library's bootstrap is one, and it always runs. Strict
mode's view (its worker inherits it), where `<bootstrap>` is the hash of the library's one view script:

```
default-src 'none'; script-src 'sha256-<bootstrap>'; script-src-attr 'none'; style-src 'unsafe-inline';
img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; worker-src blob:; frame-src 'none';
object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'; upgrade-insecure-requests
```

[ADR-007](ADR-007-typed-origins.md)

### `fetchBridge`

| Field | Type | Default | Bounds | What it does |
| :--- | :--- | :--- | :--- | :--- |
| `allow` | `string[]` | (required) | — | Exact origins the guest may reach: scheme, host, optional port (`https://api.example`, `http://localhost:8080`). An entry with a path, query, fragment, credentials or `*` is dropped with a warning; so is a value that is not a list. An empty list refuses everything. Listing the host page's own origin or a loopback, private or link-local host works, with one warning each. |
| `maxBytes` | `number` | `1048576` (1 MiB) | at most `33554432` (32 MiB) | Most bytes of one response body, and of one request body. |
| `timeoutMs` | `number` | `10000` | at most `120000` | Most time for one request, body included. |
| `methods` | `string[]` | `GET`, `HEAD`, `POST` | from `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` | Methods the guest may use. Replaces the default list. |
| `headers` | `string[]` | none | names only | Request headers the guest may set beyond `accept`, `accept-language`, `content-language`, `content-type`. `Authorization` only this way; `Cookie`, `Host`, `Origin`, `Referer`, `Sec-*`, `Proxy-*` and other forbidden names never. |
| `maxConcurrent` | `number` | `4` | at most `16` | Most requests in flight at once. |

A number that is not finite or is below 1 takes the default; one above the bound takes the bound.

What every request is pinned to: no credentials (`credentials: 'omit'`), no `Referer`, no redirects (refused
with `FETCH_REDIRECT`), `cache: 'no-store'`, CORS for the host page's origin. The host page's own origin and
loopback, private and link-local hosts are refused unless listed. A listed public name that resolves to a
private address cannot be detected from a page.

---

## Methods

Every method can be called in any state. Methods that build an environment do so only while the element is in
the document; otherwise they take effect when it is inserted.

### `setConfig(config)`

`setConfig(config: SandboxConfig): void` — see [Configuration](#configuration). Rebuilds now.

### `load(html)`

`load(html: string): void` — sets `html`, keeps the rest of the configuration, and rebuilds now. In worker mode
the markup is ignored but the environment is still rebuilt.

### `reset()`

`reset(): void` — rebuilds now from any state, `terminated` included: a fresh frame, a fresh opaque origin, the
current configuration and a new snapshot of the files. Guest-exposed methods are gone, host-exposed ones stay,
pending calls reject with `TERMINATED`. Wait for `ready` before relying on the new environment.

### `terminate(reason?)`

`terminate(reason: string = 'terminated by the host'): void` — removes the frame now, sets `state` to
`terminated` and fires `terminated` with `{ reason }` (a non-string reason uses the default). Pending calls
reject with `TERMINATED`; later calls reject at once. Calling it while terminated does nothing. The sandbox stays
terminated until `reset()`, `load()` or `setConfig()`.

### `execute(code)`

`execute(code: string): void` — runs `code` in the guest's global scope as the body of a function (the guest
document in cooperative mode, the worker in strict and worker mode), compiled with the `Function` the bootstrap captured
before any guest code ran. Nothing reaches the host: no return value, no report that it returned.

- Needs `scriptUnsafe: true` and a string; otherwise it warns and does nothing.
- While `idle` (not in the document) or `terminated` there is no environment: it warns and does nothing, as
  `call()` rejects then.
- While `loading` the code is queued and sent when the guest is ready. In cooperative mode it runs once the guest
  document is parsed (see [the startup gate](#ready-and-the-startup-gate)), in order with calls.
- A synchronous throw becomes a `sandbox-log` line (`level: 'error'`, `source: 'guest'`).
- In worker and strict mode each call has its own `workerExecutionTimeout` deadline. What it bounds is precise:
  **the guest's event loop is free at the deadline.** The element pings the guest there; the bootstrap answers from
  a handler guest code cannot reach, and only a free event loop can run it. No answer within
  `EXECUTION_TIMEOUT_GRACE_MS` (counted so that a stall of the host page never counts) terminates the sandbox.
  - Code that is still running at the deadline, or that returned but left work running then (a loop in a
    `setTimeout`), is terminated. Code that ran to its end and left the loop free stays ready, whatever it scheduled
    for later.
  - Several calls each have their own deadline, and every deadline checks the one event loop: a loop started by
    any code ends the sandbox at the first deadline it blocks.
  - A loop that starts after the last deadline is not bounded by it: `watchdogTimeout` checks the event loop
    continuously and covers that case.

### `expose(name, fn)`

`expose(name: string, fn: (...args: any[]) => unknown): void` — publishes a host method the guest calls with
`bridge.call(name, ...args)`. The guest receives `fn`'s return value (awaited if it is a promise); a throw or
rejection reaches the guest as `HANDLER_ERROR` with the error's message, verbatim: throw errors whose message you
would show the guest, or wrap the handler.

- Methods belong to the element: they survive `reset()`, `load()`, `setConfig()` and `terminate()`.
- Exposing a name again replaces its handler. A name that is not a string, or a handler that is not a function,
  throws a `TypeError`.
- Names starting with `sandbox:` are reserved for the library: refused with a warning.
- Treat arguments as untrusted data from the guest: validate them, and copy objects with spread rather than
  `Object.assign` or a `for…in` loop (an own `__proto__` key survives the copy, and `for…in` visits it).

### `call(method, ...args)`

`call<T = unknown>(method: string, ...args: unknown[]): Promise<T>` — calls a method the guest exposed with
`bridge.expose()` and resolves with its result. Works without `scriptUnsafe`: it never evaluates code.

- Arguments and results are copied by structured clone (no functions, DOM nodes or symbols), at most
  `RPC_MAX_BYTES` (33 MiB) per message, measured on both sides: past it a call is refused before anything is sent
  (`ARGS_NOT_TRANSFERABLE`) and a result is answered `RESULT_NOT_TRANSFERABLE`.
- Default timeout: 30 s.
- Calls made while `loading` are queued and sent when the guest is ready; one that settles while queued (its
  timeout) leaves the queue and never runs. In cooperative mode a call reaches the guest's method once the guest
  document is parsed (see [the startup gate](#ready-and-the-startup-gate)). Calls made while `idle` (not in the
  document) or `terminated` reject at once with `TERMINATED`, as `execute()` does nothing then.
- Rejects with an `RpcError` (an `Error` with a `code`); see [Refusal codes](#refusal-codes).

### `callWithTimeout(timeoutMs, method, ...args)`

`callWithTimeout<T = unknown>(timeoutMs: number, method: string, ...args: unknown[]): Promise<T>` — like
`call()` with a timeout for this one call; `0` (or any value that is not `> 0`) disables it.

### `registerFiles(files)`

`registerFiles(files: Record<string, FileEntry>): void` — adds or replaces files in the element's store.
`FileEntry` is a `string` (stored as UTF-8), a `Uint8Array` (copied), or `{ content, type }` to set the MIME
type instead of deriving it from the extension.

- The whole batch is validated first. A refusal throws an `Error` with a `code` (`INVALID_PATH`,
  `INVALID_FILE`, `FILES_QUOTA_EXCEEDED`) and changes nothing.
- Fires `fileschanged` when something changed (re-registering identical content changes nothing).
- The guest sees the files from the next build on (`reset()`, `load()`, `setConfig()`); a running guest never
  changes. Files survive every rebuild and `terminate()`.
- **Paths** are relative (`src/main.js`): segments of letters, digits and `._~!$&'()*+,;=@-`, separated by
  single slashes, at most 256 characters, no `.` or `..` segment. They are checked, never normalised.
- **Types** come from the extension (`.js`/`.mjs` `text/javascript`, `.css` `text/css`, `.json`
  `application/json`, `.svg` `image/svg+xml`, `.png`, `.woff2`, `.mp4`, …); unknown extensions are
  `application/octet-stream`.
- **A reference names a file only for the kind of load its type is for**: `<script src>`, `modulepreload`,
  `preload as=script` and module imports only JavaScript types; a stylesheet `<link>`, `preload as=style` and
  `@import` only `text/css`; `img`, `srcset`, `poster`, icon links and CSS `url()` only `image/*`; `url()` in
  `@font-face` and `preload as=font` only `font/*`; `audio`, `video` and `source` only `audio/*` and `video/*`;
  `track` only `text/vtt`. A reference to a file of another type stays as written and fails closed, with one
  warning. This holds for registered files as for committed ones: `x.js` registered as `text/plain` is never a
  script. Code that passes `sandboxFiles.url()` to a script element or `importScripts()` itself decides what it
  loads (Chromium runs such a file whatever its type; Firefox and WebKit refuse it in `importScripts()`).
- How the guest names files (markup, module imports, stylesheets) is described in the README's
  [Files](../README.md#files) section; why: [ADR-004](ADR-004-files-as-blob-urls.md).

### `unregisterFiles(paths?)`

`unregisterFiles(paths?: string[]): void` — removes the given paths, or every file when called without
arguments. Unregistered paths are ignored; an invalid path throws `INVALID_PATH` and removes nothing. Fires
`fileschanged` when something was removed. Takes effect at the next build.

### `listFiles()`

`listFiles(): FileInfo[]` — the registered files, sorted by path, as `{ path, type, size }` (`size` in bytes,
as registered).

### `listGuestWrites()`

`listGuestWrites(): GuestWrite[]` — the guest's pending changes, sorted by path: `{ path, change: 'write', type,
size, content }` (`type` as the files would give it, `content` a copy of the bytes) or `{ path, change: 'remove' }`.
Empty without [`guestWrites`](#configuration). See [Guest writes](#guest-writes).

### `commitGuestWrites(paths, options?)`

`commitGuestWrites(paths: string[], options?: { code?: boolean }): void` — applies the pending changes at `paths`
to the files, as one `registerFiles()` / `unregisterFiles()` would, and removes them from the pending list.

- `paths` is required: there is no "commit everything". A path with no pending change is skipped.
- A write whose type is not inert is refused with `FILES_NOT_ALLOWED` unless `options.code === true`. Inert:
  `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`, `image/x-icon`, `image/bmp`, `font/woff`,
  `font/woff2`, `font/ttf`, `font/otf`, `audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/mp4`, `audio/flac`,
  `video/mp4`, `video/webm`, `video/ogg`, `text/plain`, `application/json`, `text/css`. Everything else (JavaScript,
  HTML, SVG, XML, WebAssembly, unknown types, any other type the guest set) can run or be parsed as code. The
  type checked is the one the file will be loaded as, never just its name.
- All checks come first, as for `registerFiles()`, including the quota with what module and stylesheet rewrites
  add, against the files as they are now: a refusal throws `INVALID_PATH`, `FILES_NOT_ALLOWED` or
  `FILES_QUOTA_EXCEEDED` and changes neither the files nor the pending list.
- Fires `fileschanged` when the files changed. The guest sees committed files from the next build on.
- A committed file loads only as what its type is for (see [`registerFiles()`](#registerfilesfiles)): an inert
  file never runs as a script. Committed `text/css` is inert but still CSS: markup of the next build that links it
  is styled by it.

---

## Events

All events are `CustomEvent`s dispatched on the element. None is `composed`.

| Event | `detail` | Bubbles | When |
| :--- | :--- | :--- | :--- |
| `ready` | none | no | The guest checked in: its startup script announced itself (strict mode: the view's bootstrap, on its port), and `state` is now `ready` (see [the startup gate](#ready-and-the-startup-gate)). Once per environment. In cooperative mode its document may still be loading. (Without `allow-scripts` no guest script runs: `ready` comes with the frame's load, and calls time out.) |
| `terminated` | `{ reason: string }` | no | The sandbox was terminated: `state` is `terminated`. Once per termination; a refused build's in a task of its own. |
| `sandbox-log` | `SandboxLog` | yes | A log line from the guest or from the element. |
| `violation` | `SandboxViolation` | yes | The guest policy refused a load. |
| `fetch` | `FetchRecord` | yes | A `sandboxFetch()` request settled (including refusals). |
| `fileschanged` | `{ paths: string[] }` | no | `registerFiles()`, `unregisterFiles()` or `commitGuestWrites()` changed the files; synchronous. |
| `fileswritten` | `{ paths: string[] }` | yes | The element recorded a guest write or removal (`guestWrites`); one path per event, at most `GUEST_WRITES_PER_SECOND` per environment. |

The bubbling events reach a listener on `window` for every sandbox on the page; `event.target` says which one.
Every `detail` is frozen. Fields that come from the guest are validated and clamped, but they remain the
guest's data: read them, don't merge them into your objects. The element's own startup message, the guest frame's
port announcement (`{ type: 'SANDBOX_PORT' }` from the guest frame's window), is taken by a capture listener the
element adds to your window at each build; a `message` listener of yours added before it, in the capture phase, sees
it first. Act on a message only by `event.source` (above), never by its shape.

### `sandbox-log` — `SandboxLog`

| Field | Type | Meaning |
| :--- | :--- | :--- |
| `type` | `'LOG'` | Always `'LOG'`. |
| `level` | `'log' \| 'info' \| 'warn' \| 'error'` | Anything else reads as `'log'`. |
| `args` | `readonly unknown[]` | What was logged, structured-cloned; at most `LOG_MAX_ARGS` values, strings cut at `LOG_MAX_STRING`, all of them together at most `LOG_MAX_BYTES` (1 MiB); an argument past it is a string saying so. |
| `source` | `'guest' \| 'host'` | Set by the element from where the line came from, never from the line. |

Lines with `source: 'guest'`, from one relay in every mode: the guest's `console` (`log`, `info`, `warn`, `error`;
`debug`, `dir`, `dirxml`, `table`, `group` and `groupCollapsed` as `log`; `trace` as `log` after `console.trace()`; a
failed `assert` as `error` after `Assertion failed:`); `Uncaught …` for an uncaught error (strict mode: after the entry
ran) and `Uncaught (in promise) …` for an unhandled rejection; a throw from `execute()`; one `info` line
`<mode> Ready` per environment. Guest code can post anything here. The guest's console never throws: a value
structured clone refuses (a function, a Symbol, a DOM node, an `Event`, a `Response`, a `Proxy`, a `WeakMap`, a
`Promise`) arrives as a string naming its kind (`[function]`, `[object HTMLDivElement]`), and an `Error` or
`DOMException` as `{ name, message, stack }`. WebKit mutes the errors of a cooperative guest's inline scripts and
handlers and of worker mode's worker: they arrive as `Uncaught Script error.`, all the browser gives.

The bounds: `LOG_MAX_ARGS` and `LOG_MAX_STRING` bound the strings; `LOG_MAX_BYTES` bounds all arguments of a line
together, whatever they are (a typed array, an object of 100 000 keys). The guest applies them before a line is
posted, and sends at most `LOG_EVENTS_PER_SECOND` lines and 4 MiB per second (one `warn` line when it starts dropping),
so a flood never reaches the host page's thread; the browser's own console gets a dropped line not at all and a cut
line cut. The element measures every line again on receipt, and dispatches at most `LOG_EVENTS_PER_SECOND` guest
lines in any one-second window per environment (one warning). Lines logged before the guest is connected (a strict
entry's top level runs before the worker has its port) are kept, at most 1000 and 4 MiB, and arrive in order once it
is; past that, one `warn` line says how many were dropped.

Lines with `source: 'host'` (never rate-limited): `Execution Timeout` (`workerExecutionTimeout`), and
`[Sandbox] the guest entry failed to start` (strict mode; the entry's error text follows as a guest line,
`Uncaught …`).

### `violation` — `SandboxViolation`

| Field | Type | Meaning |
| :--- | :--- | :--- |
| `directive` | `string` | The effective directive, e.g. `'connect-src'`. |
| `blockedURI` | `string` | What was refused: a URL (possibly reduced to its origin), or `'inline'`, `'eval'`, … |
| `sourceFile` | `string?` | Where the refused code ran, when the browser says. |
| `lineNumber` | `number?` | Positive integer, when given. |
| `columnNumber` | `number?` | Positive integer, when given. |
| `source` | `'view' \| 'logic'?` | Strict mode only, set by the element: `'view'` for the view document's reports (complete and unforgeable up to the cap), `'logic'` for the worker's. |

At most `VIOLATION_EVENT_LIMIT` per environment; in strict mode per source, and for the view per directive, so
refused loads of one kind never hide a report of another. Outside the view, a report is
evidence that the guest tried something; guest code can suppress its own reports, so no event proves nothing.
A frame the guest creates reports to itself, and worker reports depend on the engine (WebKit raises none in
workers). [ADR-005](ADR-005-strict-mode.md)

### `fetch` — `FetchRecord`

| Field | Type | Meaning |
| :--- | :--- | :--- |
| `method` | `string` | Upper case; `''` when the guest sent no valid method. |
| `url` | `string` | Without fragment; the guest's string cut to 2048 characters when it is not a URL. |
| `outcome` | `'ok' \| 'refused' \| 'failed' \| 'aborted'` | `ok`: a response was handed over (any HTTP status). `refused`: no request was made (the bridge's rules, or the browser's `Request` refused it). `failed`: the browser's `fetch` rejected or no whole response was handed over; not proof that a request left the page, since `fetch` also rejects before sending (the host page's own `connect-src`, mixed content, local-network blocking). `aborted`: the environment was torn down meanwhile. |
| `status` | `number?` | The HTTP status, when a response arrived. |
| `code` | `FetchErrorCode?` | Why it was refused, failed or aborted. |
| `reason` | `string?` | For a refusal of an origin that is not listed, what the host knows beyond the guest's text: the host page's own origin, or a loopback, private or link-local host. The guest is told the same for every unlisted origin. |
| `bytes` | `number` | Response body bytes read. |
| `durationMs` | `number` | From the request to its settlement. |

### `terminated` reasons

| Reason | Cause |
| :--- | :--- |
| `terminated by the host` | `terminate()` without a reason (or with your own text instead). |
| `the guest stopped responding (watchdog)` | `watchdogTimeout` expired. |
| `the guest entry failed to start` | Strict mode: the entry threw or did not parse. |
| `the sandbox's startup script did not run: the host page's Content-Security-Policy must allow it (see docs/API.md#host-page-policy)` | The frame loaded but the library's startup script (strict mode's view bootstrap, cooperative and worker mode's bootstrap) never checked in: the host page's policy refused it. See [Host page policy](#host-page-policy). |
| `the sandbox's worker could not be loaded: the host page's policy refuses blob: workers (worker-src; WebKit also under Cross-Origin-Embedder-Policy; see docs/API.md#host-page-policy)` | Strict mode: the worker's script could not be loaded at all; nothing of the guest's ran. |
| `the host page's Trusted Types policy does not allow the policy name 'web-sandbox' (trusted-types; see docs/API.md#host-page-policy)` | The host page enforces Trusted Types and its `trusted-types` directive does not name `web-sandbox`. |
| `the guest entry "…" is not a registered JavaScript file` | Strict mode: `entry` names no registered JavaScript file. |
| `the sandbox view stopped responding` | Strict mode: the view did not answer for `VIEW_LIVENESS_TIMEOUT_MS` (always on). |
| `unknown mode …` | `mode` is not `strict`, `cooperative` or `worker`. For `'iframe'` the reason ends `('iframe' was renamed 'cooperative')`. |
| `the configuration could not be used (…)` | `setConfig()` got something that is not an object or cannot be cloned, an `origins` that is not an object, or a kind of it that is not a list. |
| `the environment could not be built (…)` | Building the frame failed. |
| `the executed code ran longer than workerExecutionTimeout` | The guest's event loop was still busy `EXECUTION_TIMEOUT_GRACE_MS` after an `execute()` deadline. |
| `the sandbox frame loaded a second time` | Something navigated or reloaded the library's frame (also before its first load, once the guest had checked in). |
| `the guest frame announced itself again (it reloaded or rewrote its document)` | Cooperative and worker mode: the guest frame announced a second port (it reloaded itself, rewrote its document so the bootstrap ran again, or posted a forged announcement), or announced one where no bootstrap runs. |
| `the sandbox did not finish loading` | The build was still `loading` after `LOAD_TIMEOUT_MS` of host time and its frame had not loaded (without `allow-scripts`: subresources included). |
| `the guest frame is missing` | The library's frame has no guest frame. |

Branch on `state` and the event, not on these texts. A reason never carries the text of an error the element
caught (that can quote your config, or be the guest's words): only a fixed text and, in parentheses, the error's
name.

---

## Lifecycle

| State | Meaning |
| :--- | :--- |
| `idle` | Not in the document (constructed, or removed): no frame. |
| `loading` | A frame was built; waiting for the guest to check in (without `allow-scripts`, and in strict mode, for the frame to load); at most `LOAD_TIMEOUT_MS` (host time), then `terminated`. |
| `ready` | The guest can be reached; `ready` was dispatched. In cooperative mode the guest document may still be loading. |
| `terminated` | Torn down by `terminate()`, a budget (watchdog, `workerExecutionTimeout`), an integrity check or a failed build; `terminated` was dispatched. |

There is no `running` state: nothing reports that guest code is running or that it stopped.

| From | Action | To |
| :--- | :--- | :--- |
| any | inserted into the document; `setConfig()`, `load()` or `reset()` while in it | `loading`, then `ready` (or `terminated` if the build is refused or fails, once per attempt) |
| any | removed from the document | `idle`, no event |
| any but `terminated` | `terminate()`, watchdog, `workerExecutionTimeout`, integrity check | `terminated` |

Every rebuild and teardown rejects pending calls with `TERMINATED`, aborts in-flight `sandboxFetch()` requests,
and resets the per-environment caps (log rate, violations). Listeners run synchronously; a listener that calls
`reset()` or `terminate()` is never undone by what the element was doing.

### `ready` and the startup gate

`ready` means the guest's startup script checked in: the bootstrap, the first script of the guest document (cooperative
mode) or of the worker's frame (worker mode), announced its port; in strict mode the view's bootstrap posted its
check-in on the port only it holds. It does not wait for the guest's images or its own scripts, so `LOAD_TIMEOUT_MS`
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

From `call()`, `callWithTimeout()` and, in the guest, `bridge.call()` / `bridge.callWithTimeout()`.

| Code | Set by | Meaning | Retry? |
| :--- | :--- | :--- | :--- |
| `TIMEOUT` | local | No answer within the call's timeout. | yes |
| `TERMINATED` | local | The environment was reset, terminated or removed. | after the next `ready` |
| `ARGS_NOT_TRANSFERABLE` | local | The arguments cannot be structured-cloned, or measure more than `RPC_MAX_BYTES`; nothing was sent. | no |
| `SEND_FAILED` | local | The transport threw while sending. | no |
| `INVALID_CALL` | local | The method name is not a string. | no |
| `UNKNOWN_METHOD` | reported | No method of that name is exposed on the other side. | no |
| `HANDLER_ERROR` | reported | The handler threw or rejected; the message is its text. | depends on the handler |
| `RESULT_NOT_TRANSFERABLE` | reported | The handler's result cannot be structured-cloned, or measures more than `RPC_MAX_BYTES`. | no |
| `BUSY` | reported | The other side already runs `MAX_INBOUND_IN_FLIGHT` of your calls, or 64 MiB of their arguments, or the call measures more than `RPC_MAX_BYTES`; the method did not run. | yes |

**Local** codes are set only by the side that made the call, from its own state, so the other side can never
produce them. **Reported** codes come from the other side, and their message is its text; any other code the
other side claims reads as `HANDLER_ERROR`. `state === 'terminated'` confirms `TERMINATED` from the element's
own state. [ADR-002](ADR-002-host-guest-broker.md)

### `sandboxFetch()`: `FetchErrorCode`

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
`importScripts` (`script-src`). Kept: the language's built-ins, timers, events and messages, encoding, streams,
`crypto`, `Blob`, `File`, `URL`, IndexedDB, `OffscreenCanvas` with 2D and WebGL, WebCodecs, `performance`, `scheduler`,
`BroadcastChannel`. Absent: `EventSource`, `WebTransport`, `WebSocketStream`, `FontFace` and `fonts`, `caches`,
`Notification`, `Worker` and `SharedWorker` (no nested workers), the Service Worker, Push, RTC, MediaSource and
Reporting interfaces, `navigator.serviceWorker` and `navigator.connection`.

### `bridge`

| Member | Signature | Description |
| :--- | :--- | :--- |
| `expose` | `(name: string, fn: (...args) => unknown) => void` | Publishes a guest method the host calls with `sandbox.call(name, ...)`. Last registration wins; `sandbox:` names are ignored. |
| `call` | `(method: string, ...args) => Promise<unknown>` | Calls a host method exposed with `sandbox.expose()`. 30 s timeout. |
| `callWithTimeout` | `(timeoutMs: number, method: string, ...args) => Promise<unknown>` | With a timeout for this call; `0` disables it. |

Usable at once: calls and exposes made before the channel is connected are buffered. Rejections carry the
[`RpcErrorCode`](#calls-rpcerrorcode)s. Guest methods belong to one environment and are gone after a rebuild.

### `sandboxFiles`

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

With `guestWrites: true`, `sandboxFiles.write()` and `remove()` change the guest's own view once the element
has accepted them: `list()`, `read()` and `text()` show them, `url()` of a written path is `NOT_FOUND` (nothing
the guest writes gets a URL). The element checks each request as `registerFiles()` would (path, entry, type, the
quota with every pending change applied) and at most `GUEST_WRITES_PER_SECOND` requests and
`GUEST_WRITE_BYTES_PER_SECOND` bytes in any one-second window; a refused request changes nothing on either side. Nothing the
guest writes reaches the files, a policy or another environment until the host calls
[`commitGuestWrites()`](#commitguestwritespaths-options); it is listed by
[`listGuestWrites()`](#listguestwrites) and announced by `fileswritten`. Without `guestWrites`, both methods
reject with `FILES_NOT_ALLOWED`, and so does the element for any request that reaches it. Treat written
content as the guest's data. [ADR-004](ADR-004-files-as-blob-urls.md)

The element records a change before it announces it, and `listGuestWrites()` is the truth; the guest's view
changes only when the element's answer arrives. They disagree by design in two cases: a `fileswritten` listener
that calls `terminate()` (the change stays listed and committable, and the environment that asked is gone before
any answer), and a listener that blocks longer than the guest's call timeout, 30 s (the guest's `write()` rejects
with `TIMEOUT`, and the change is listed all the same). A listener's `reset()` discards the change with the rest.

### `sandboxFetch`

`sandboxFetch(url: string, init?: { method?, headers?, body? }): Promise<Response>` — asks the host to make the
request under the [`fetchBridge`](#fetchbridge) rules; without `fetchBridge` every request rejects with
`FETCH_NOT_ALLOWED`. Only `method`, `headers` and `body` are read from `init`;
the body is a string, an `ArrayBuffer` or a typed array. Resolves with a whole `Response` (no streaming, no
`AbortSignal`); rejects with a [`FetchErrorCode`](#sandboxfetch-fetcherrorcode). `fetch` itself is untouched;
assign `globalThis.fetch = sandboxFetch` to route through the bridge. [ADR-006](ADR-006-fetch-bridge.md)

### `sandboxView` (strict mode)

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
Never an event handler. `src`, `srcset` and `poster` keep an `https:` or `http:` URL, a registered file's path, or
nothing (no `data:` or `javascript:`); SVG `fill`, `stroke`, `clip-path` and `mask` reference only `url(#id)`. Link
clicks and form submissions navigate nowhere.

Not available in strict mode: `use`, markers, SVG filters, SVG `image`, `foreignObject` and animation; `canvas`,
`slot`, `selectedcontent` (customizable `select`); popovers (`popover`, `popovertarget`) and invoker commands
(`commandfor`, `command`); `autofocus`, `contenteditable`; form `action`, `formaction`, `method` and `target`;
`target` and `download` on links; SVG gradient and pattern templates (`href`). CSS filters, HTML images and inline
SVG cover most of it.

Text is kept, each run of adjacent text joined into one node; comments are dropped. The view holds
at most 50000 elements, nested at most 256 deep below its body, and at most 1048576 characters (its body's
serialization: text, attributes and markup alike), counted over the document a render would leave (what is outside the target stays): a render past
any of them is dropped as a whole, the next one still applies, and the guest's log says
`[Sandbox] sandboxView.render: the view refused a render: …`. The view parses at most 1048576 characters of markup
per second, renders it refused included: a render past that waits, and so does the worker's next one (one render in
flight), so a flood of renders is slowed, not dropped.

Registered files are named by path in `src`, `href` and `poster`. The view shows only files that never open as a
document: CSS, PNG, JPEG, GIF, WebP, AVIF, APNG, BMP and ICO images, WOFF, WOFF2, TTF and OTF fonts, MP3, WAV, Ogg,
MP4, FLAC, WebM and AAC audio, MP4, WebM and Ogg video, and WebVTT. Any other file (SVG, HTML, XML, JSON …) is the
worker's through `sandboxFiles` only; a reference to it stays as written and loads nothing. Show vector graphics as
inline `<svg>`.

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
(WebKit always, Firefox, Chromium depending on its process model): the view's budgets bound the common cases, but not
layout and paint costs beyond what the markup weighs (CSS filters; bidirectional text in one paragraph), and
cooperative mode is no better there. Also CSS within what the policy allows, the worker's `violation` reports (per
engine, guest-influenced), a worker that closes itself (only the watchdog notices), memory, and the host site's
cookies on requests to allowed same-site origins (every mode).

**Cooperative-mode limits**, a frozen list (cooperative content only: the library adds no guest-realm patches for
new findings there, it lists them): same-thread execution; frames and workers the guest creates; WebKit's preconnect;
focus and the clipboard; messages to the host window; the user's link actions and modifier clicks the guest's script
synthesizes (a new top-level tab without `allow-popups`; Chromium submits a form that way past `form-action`); session
history; guest-only stalls; forgeable reports; the host page's URL and origin; the host page's Trusted Types
requirement. Each is described in the
[README](../README.md#cooperative-mode-limits). Worker mode shares only the reports: the worker's are per engine, as
in strict mode.

---

## Limits

| Limit | Value | Exported constant |
| :--- | :--- | :--- |
| Inbound calls running at once, per side and environment | 256 | `MAX_INBOUND_IN_FLIGHT` |
| Default call timeout (ms) | 30000 | — |
| Guest log lines per second, per environment | 1000 | `LOG_EVENTS_PER_SECOND` |
| Guest log lines kept until the guest is connected | 1000 (and 4 MiB) | — |
| Arguments kept per log line | 64 | `LOG_MAX_ARGS` |
| Characters kept per string log argument | 65536 | `LOG_MAX_STRING` |
| Bytes per log line, all arguments together | 1048576 (1 MiB) | — |
| Bytes of guest log lines sent per second | 4194304 (4 MiB) | — |
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
| Guest writes: requests per second, per environment | 100 | `GUEST_WRITES_PER_SECOND` |
| Guest writes: bytes per second, per environment | 8388608 (8 MiB) | `GUEST_WRITE_BYTES_PER_SECOND` |

---

## Host page policy

The sandbox's frames are `srcdoc` documents, and a `srcdoc` document inherits the policies of the page that made it:
a copy of its Content-Security-Policy list, its Trusted Types requirement and its Cross-Origin-Embedder-Policy. Every
policy in the list must allow a load, so your page's policy narrows the sandbox's, never widens it. What your page's
policy must allow:

| Your page's | strict (default) | cooperative | worker |
| :--- | :--- | :--- | :--- |
| `script-src` | the view bootstrap's hash, `'sha256-…'` (below), or `'unsafe-inline'`; `'unsafe-eval'` for `execute()` | `'unsafe-inline'` (the bootstrap and the guest's inline scripts; its hash changes with every build), plus what the guest loads | `'unsafe-inline'`, `'unsafe-eval'` for `execute()` |
| `worker-src` (or `script-src` without it) | `blob:` | — (`blob:` for workers the guest makes) | `blob:` |
| `style-src` | `'unsafe-inline'`, or the wrapper style's hash `'sha256-jKvfmEYIGlm8DGk4pp05gJ0MwYdTY+NU6tSvyPZyDow='`; `'unsafe-inline'` for the guest's own inline styles | the same | the same |
| `img-src`, `media-src`, `font-src`, `connect-src` | `blob:` for registered files of that kind; every origin in `origins` | the same | the same |
| `frame-src` / `child-src` | nothing (a `srcdoc` frame loads no URL) | the same | the same |
| Trusted Types | `require-trusted-types-for 'script'` works: the element and the view assign through one policy named `web-sandbox`, which blesses only the sandbox's own documents; a `trusted-types` directive must name it (add `'allow-duplicates'` if two copies of the library share the page). Strings are not evaluated: `execute()` and the guest's `eval` are refused (Chromium, WebKit; Firefox has no Trusted Types) | the guest inherits the requirement: its scripts, the import map and the markup the bootstrap writes for registered files need Trusted Types too; `execute()` is refused | works (the frame starts the worker through the policy); `execute()` is refused |
| `Cross-Origin-Embedder-Policy: require-corp` | works in Chromium and Firefox; WebKit refuses the view's `blob:` worker | works; resources from `origins` need CORP or CORS headers | as strict |

- **What a refusal looks like**: the build ends with a reason that names your page's policy: `the sandbox's startup
  script did not run …` (a refused bootstrap), `the sandbox's worker could not be loaded …` (a refused `blob:` worker),
  `… does not allow the policy name 'web-sandbox' …` (Trusted Types). A refused wrapper style leaves the frame 150 px
  high, and the element warns with the hash to allow.
- **Your `connect-src`, `img-src` and the other fetch directives narrow `origins` silently**: an origin listed in
  `origins` that your page's policy does not allow is refused in the sandbox too. The refusal happens in the sandbox's
  documents, so it arrives as the element's `violation` event (where the browser reports it), never as a
  `securitypolicyviolation` on your page, and nothing warns at `setConfig()`.
- **The view bootstrap's hash** is `viewScriptHash()`, the very value the element puts in the view's `script-src`.
  It is constant for one build of the library (it is the hash of the library's own function text, which a bundler or
  minifier can change), so it cannot be listed here: read it from the build you serve, for example in a build step,
  and put it in your page's policy:

  ```js
  import { viewScriptHash } from 'web-sandbox';
  const policy = `script-src 'self' ${viewScriptHash()}; worker-src blob:`; // viewScriptHash() is 'sha256-…', quoted
  ```

  The wrapper style's hash is a constant of the library, listed in the table above.

---

## Exports

Values:

| Export | What it is |
| :--- | :--- |
| `defineWebSandbox` | Registers the element; see [above](#registering-the-element). |
| `WebSandbox` | The element class. |
| `SandboxDevTools` | `new SandboxDevTools(element)`, then `activate()`, `deactivate()` or `toggle()`: prints the element's `sandbox-log` lines to the host console. |
| `viewScriptHash` | `viewScriptHash(): string`: the strict view bootstrap's hash source, `'sha256-…'`, for your page's policy; see [Host page policy](#host-page-policy). |
| `SAFE_CAPABILITIES`, `UNSAFE_CAPABILITIES`, `UNSAFE_SANDBOX_FLAGS`, `UNSAFE_PERMISSIONS` | The capability lists accepted by `capabilities` and `unsafeCapabilities`. |
| `FETCH_ERROR_CODES` | Every `FetchErrorCode`. |
| `MAX_INBOUND_IN_FLIGHT`, `LOG_EVENTS_PER_SECOND`, `LOG_MAX_ARGS`, `LOG_MAX_STRING`, `VIOLATION_EVENT_LIMIT`, `AUTO_RESIZE_MAX_HEIGHT`, `AUTO_RESIZE_MAX_UPDATES_PER_SECOND`, `VIEW_RENDER_MAX_LENGTH`, `VIEW_LIVENESS_TIMEOUT_MS`, `LOAD_TIMEOUT_MS`, `EXECUTION_TIMEOUT_GRACE_MS`, `GUEST_WRITES_PER_SECOND`, `GUEST_WRITE_BYTES_PER_SECOND` | See [Limits](#limits). |

`document.createElement('web-sandbox')` is typed as a `WebSandbox` (`HTMLElementTagNameMap`), and its
`addEventListener` types each event's `detail`.

Types: `SandboxConfig`, `SandboxState`, `RpcError`, `RpcErrorCode`, `SandboxLog`, `SandboxLogLevel`,
`SandboxViolation`, `FetchBridgeConfig`, `FetchErrorCode`, `FetchRecord`, `FileContent`, `FileEntry`,
`FileInfo`, `FileError`, `FileErrorCode`, `SandboxFiles`, `GuestWrite`, `SandboxOrigins`, `StrictSandboxOrigins`,
`SafeCapability`, `UnsafeCapability`, `UnsafePermission`, `SandboxCapability`.

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
