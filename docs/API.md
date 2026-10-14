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

The frame lives in an open shadow root and fills the element (`width: 100%; height: 100%`). Custom elements are
inline by default, so give the element a block display and a size:

```css
web-sandbox { display: block; height: 320px; }
```

With [`autoResize`](#configuration) the element sets its own `style.height`; it still needs a non-inline
`display`. In worker mode the frame is hidden (`display: none`).

---

## Configuration

**`setConfig(config: Partial<SandboxConfig>): void`** replaces the configuration and rebuilds the environment
(see [Lifecycle](#lifecycle)).

- Each call is applied **over the defaults, not over the previous configuration**: an option left out returns
  to its default. That includes `html`, so a `setConfig()` after `load(html)` starts with an empty document
  unless it passes `html` again.
- The argument is copied (structured clone) before anything reads it: changing your objects or arrays afterwards
  changes nothing, not even at the next `reset()`.
- Values are validated before they are applied; what cannot be used is dropped with one `console.warn` per
  element, never applied half-way.
- A config that cannot be used at all (not an object, not cloneable: a `Proxy`, a function value, or a
  `connectionsAllowed` that is not an object) applies nothing, and the sandbox terminates with the reason
  `the configuration could not be used (…)`, as for an unknown mode, until a usable config is set; the previous
  config stays. A build that fails (for example a directive given a string instead of a list) terminates with
  `the environment could not be built (…)`. `setConfig()` never throws.

| Option | Type | Default | Modes | What it does |
| :--- | :--- | :--- | :--- | :--- |
| `mode` | `'iframe' \| 'worker' \| 'strict'` | `'iframe'` | — | Where guest code runs; see [Modes](#modes). Any other value starts no environment: the sandbox terminates with the reason `unknown mode …` until a valid mode is configured. |
| `html` | `string` | `''` | iframe, strict | The guest document (iframe mode) or the initial view (strict mode). Empty means `<div id="root"></div>`. Ignored in worker mode. Also set by [`load()`](#loadhtml). |
| `capabilities` | `SafeCapability[]` | `[]` | all | Sandbox flags that keep the guest inside the frame: `allow-scripts`, `allow-forms`, `allow-pointer-lock`, `allow-orientation-lock`. Anything else is dropped with a warning. Worker mode always adds `allow-scripts`; strict mode always has `allow-scripts allow-forms`. |
| `unsafeCapabilities` | `UnsafeCapability[]` | `[]` | iframe, worker | Capabilities that act outside the frame: `allow-popups`, `allow-modals`, `allow-downloads`, `allow-presentation`, `fullscreen`. Each one enabled warns once. `fullscreen` is granted as `allow="fullscreen *"` (a Permissions Policy feature), the rest as sandbox flags. Dropped with a warning in strict mode. |
| `scriptUnsafe` | `boolean` | `false` | all | Only a literal `true` enables it. Adds `'unsafe-eval'` to the guest policy (strings run as code; WebAssembly too) and enables [`execute()`](#executecode). For testing; warns once per element. |
| `connectionsAllowed` | `CSPDirectives` | see [below](#connectionsallowed) | all (strict: a subset) | The guest's Content Security Policy, merged per directive over the defaults. |
| `entry` | `string` | none | strict | The path of a registered JavaScript file the worker runs first. Ignored with a warning in other modes. If it is not a registered JavaScript file the sandbox terminates (`the guest entry "…" is not a registered JavaScript file`). |
| `watchdogTimeout` | `number` (ms) | `0` (off) | all | Terminates a guest that stops answering for this long (`the guest stopped responding (watchdog)`). Anything but a finite number `> 0` is off. Bounds a looping guest in worker and strict mode on every browser, and in iframe mode only where the browser runs the frame in its own process. Needs the guest bootstrap to run. [ADR-003](ADR-003-lifecycle-and-liveness.md) |
| `workerExecutionTimeout` | `number` (ms) | `0` (off) | worker, strict | A deadline for each `execute()`, this long after the element posts the code, at which the guest's event loop must be free: the element pings the guest, and if no answer arrives within `EXECUTION_TIMEOUT_GRACE_MS` the sandbox ends: a `sandbox-log` line `Execution Timeout` (`source: 'host'`), then `terminated` with `the executed code ran longer than workerExecutionTimeout`. See [`execute()`](#executecode). Anything but a finite number `> 0` is off. |
| `autoResize` | `boolean` | `false` | iframe, strict | Only a literal `true` enables it. The element's height follows the guest's content height; see [Limits](#limits) for the bounds. In worker mode it does nothing, with one warning. Without it, the height is left to your CSS. |
| `fetchBridge` | `FetchBridgeConfig` | off | all | Gives the guest [`sandboxFetch()`](#sandboxfetch); the host makes each request. A config without it turns the bridge off. [ADR-006](ADR-006-fetch-bridge.md) |
| `guestWrites` | `boolean` | `false` | all | Only a literal `true` enables it. The guest's [`sandboxFiles.write()` and `remove()`](#sandboxfiles) are recorded by the element as pending changes of this environment; they reach the files only through [`commitGuestWrites()`](#commitguestwritespaths-options). See [Guest writes](#guest-writes). |

### `connectionsAllowed`

The default guest policy:

```js
{
    "upgrade-insecure-requests": true,
    "default-src": ["'none'"],
    "script-src":  ["'unsafe-inline'"],
    "style-src":   ["'unsafe-inline'"],
    "base-uri":    [],            // 'none'
    "form-action": [],            // 'none'
    "worker-src":  ["blob:", "data:"],
}
```

A directive you pass replaces that directive's default; the others keep theirs. Rules:

- **Names**: `default-src`, `script-src`, `script-src-elem`, `script-src-attr`, `style-src`, `style-src-elem`,
  `style-src-attr`, `img-src`, `font-src`, `connect-src`, `media-src`, `object-src`, `frame-src`, `child-src`,
  `worker-src`, `manifest-src`, `prefetch-src`, `base-uri`, `form-action`, `upgrade-insecure-requests`
  (always on). Any other key is dropped with a warning; so are `frame-ancestors`, `report-uri`, `report-to`
  and `sandbox`, which browsers ignore in the `<meta>` policy the guest always gets.
- **Values**: each entry must be one CSP source expression (`https://api.example`, `data:`, `'none'`, …);
  anything else (including a `;`) is dropped with a warning.
- **`[]` means `'none'`** for every directive. Leave a directive out to fall back to `default-src`.
- **`'self'` is dropped** with a warning: browsers disagree on what it matches for the guest's opaque origin.
  List origins explicitly.
- **`'unsafe-eval'` and `'wasm-unsafe-eval'` are dropped**: only `scriptUnsafe` grants them.
- **Keep `'unsafe-inline'` in `script-src`** (without nonces or hashes) in iframe and worker mode: the
  library's bootstrap is an inline script, and without it there is no `bridge`, no `sandboxFiles`, no
  violation reports (one warning). [CSP_CONFIG_RATIONALE.md](CSP_CONFIG_RATIONALE.md)
- **Registered files add `blob:`** only to the directive that governs each kind of load their types need, as
  the browser picks it (CSP Level 3 fallback): scripts `script-src-elem`, else `script-src`; stylesheets
  `style-src-elem`, else `style-src`; `img-src` for `image/*`; `font-src` for `font/*`; `media-src` for
  `audio/*`, `video/*` and `text/vtt`; `connect-src` for every file. Where only `default-src` governs, the kind's
  own directive is created from `default-src`'s sources plus `blob:`. A governing directive you set to `'none'`
  stays `'none'`, with a warning.
- **Strict mode** takes only `default-src`, `style-src`, `connect-src`, `img-src`, `font-src`, `media-src`,
  `manifest-src` and `prefetch-src` from the config. `script-src`, `script-src-attr`, `base-uri`,
  `form-action`, `worker-src`, `frame-src` and `object-src` are fixed; every other directive is dropped; each
  difference warns once. [ADR-005](ADR-005-strict-mode.md)

### `fetchBridge`

| Field | Type | Default | Bounds | What it does |
| :--- | :--- | :--- | :--- | :--- |
| `allow` | `string[]` | (required) | — | Exact origins the guest may reach: scheme, host, optional port (`https://api.example`, `http://localhost:8080`). An entry with a path, query, fragment, credentials or `*` is dropped with a warning. An empty list refuses everything. |
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

`setConfig(config: Partial<SandboxConfig>): void` — see [Configuration](#configuration). Rebuilds now.

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
document in iframe mode, the worker in worker and strict mode), compiled with the `Function` the bootstrap captured
before any guest code ran. Nothing reaches the host: no return value, no report that it returned.

- Needs `scriptUnsafe: true` and a string; otherwise it warns and does nothing.
- While `idle` (not in the document) or `terminated` there is no environment: it warns and does nothing, as
  `call()` rejects then.
- While `loading` the code is queued and runs when the guest is ready.
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
rejection reaches the guest as `HANDLER_ERROR` with the error's message.

- Methods belong to the element: they survive `reset()`, `load()`, `setConfig()` and `terminate()`.
- Exposing a name again replaces its handler. A non-string name or a non-function is ignored.
- Names starting with `sandbox:` are reserved for the library: refused with a warning.
- Treat arguments as untrusted data from the guest: validate them, and copy objects with spread rather than
  `Object.assign` (an own `__proto__` key survives the copy).

### `call(method, ...args)`

`call<T = unknown>(method: string, ...args: unknown[]): Promise<T>` — calls a method the guest exposed with
`bridge.expose()` and resolves with its result. Works without `scriptUnsafe`: it never evaluates code.

- Arguments and results are copied by structured clone (no functions, DOM nodes or symbols).
- Default timeout: 30 s.
- Calls made while `loading` are queued and sent when the guest is ready. Calls made while `idle` (not in the
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
| `ready` | none | no | The guest can be reached: `state` is now `ready`. Once per environment. (In iframe mode without `allow-scripts` no guest script runs to answer, so calls time out.) |
| `terminated` | `{ reason: string }` | no | The sandbox was terminated: `state` is now `terminated`. Once per termination. |
| `sandbox-log` | `SandboxLog` | yes | A log line from the guest or from the element. |
| `violation` | `SandboxViolation` | yes | The guest policy refused a load. |
| `fetch` | `FetchRecord` | yes | A `sandboxFetch()` request settled (including refusals). |
| `fileschanged` | `{ paths: string[] }` | no | `registerFiles()`, `unregisterFiles()` or `commitGuestWrites()` changed the files; synchronous. |
| `fileswritten` | `{ paths: string[] }` | yes | The element recorded a guest write or removal (`guestWrites`); one path per event, at most `GUEST_WRITES_PER_SECOND` per environment. |

The bubbling events reach a listener on `window` for every sandbox on the page; `event.target` says which one.
Every `detail` is frozen. Fields that come from the guest are validated and clamped, but they remain the
guest's data: read them, don't merge them into your objects.

### `sandbox-log` — `SandboxLog`

| Field | Type | Meaning |
| :--- | :--- | :--- |
| `type` | `'LOG'` | Always `'LOG'`. |
| `level` | `'log' \| 'info' \| 'warn' \| 'error'` | Anything else reads as `'log'`. |
| `args` | `readonly unknown[]` | What was logged, structured-cloned; at most `LOG_MAX_ARGS` values, strings cut at `LOG_MAX_STRING`. |
| `source` | `'guest' \| 'host'` | Set by the element from where the line came from, never from the line. |

Lines with `source: 'guest'`: the guest's `console.log`, `console.info`, `console.warn` and `console.error`; a throw from
`execute()`; one `info` line `<mode> Ready` per environment; in strict mode, `Uncaught …` for an uncaught error
after the entry ran. Guest code can post anything here. Guest lines are limited to `LOG_EVENTS_PER_SECOND` in any
one-second window per environment (one warning; lines past it are dropped).

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
| `bytes` | `number` | Response body bytes read. |
| `durationMs` | `number` | From the request to its settlement. |

### `terminated` reasons

| Reason | Cause |
| :--- | :--- |
| `terminated by the host` | `terminate()` without a reason (or with your own text instead). |
| `the guest stopped responding (watchdog)` | `watchdogTimeout` expired. |
| `the guest entry failed to start` | Strict mode: the entry threw or did not parse. |
| `the guest entry "…" is not a registered JavaScript file` | Strict mode: `entry` names no registered JavaScript file. |
| `the sandbox view stopped responding` | Strict mode: the view did not answer for `VIEW_LIVENESS_TIMEOUT_MS` (always on). |
| `unknown mode …` | `mode` is not `iframe`, `worker` or `strict`. |
| `the configuration could not be used (…)` | `setConfig()` got something that is not an object or cannot be cloned, or `connectionsAllowed` is not an object. |
| `the environment could not be built (…)` | Building the frame failed, e.g. a directive given a string instead of a list. |
| `the executed code ran longer than workerExecutionTimeout` | The guest's event loop was still busy `EXECUTION_TIMEOUT_GRACE_MS` after an `execute()` deadline. |
| `the sandbox frame loaded a second time` | Something navigated or reloaded the library's frame. |
| `the guest frame is missing` | The library's frame has no guest frame. |

Branch on `state` and the event, not on these texts. A reason never carries the text of an error the element
caught (that can quote your config, or be the guest's words): only a fixed text and, in parentheses, the error's
name.

---

## Lifecycle

| State | Meaning |
| :--- | :--- |
| `idle` | Not in the document (constructed, or removed): no frame. |
| `loading` | A frame was built and is loading. |
| `ready` | The guest can be reached; `ready` was dispatched. |
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
| `ARGS_NOT_TRANSFERABLE` | local | The arguments cannot be structured-cloned; nothing was sent. | no |
| `SEND_FAILED` | local | The transport threw while sending. | no |
| `INVALID_CALL` | local | The method name is not a string. | no |
| `UNKNOWN_METHOD` | reported | No method of that name is exposed on the other side. | no |
| `HANDLER_ERROR` | reported | The handler threw or rejected; the message is its text. | depends on the handler |
| `RESULT_NOT_TRANSFERABLE` | reported | The handler's result cannot be structured-cloned. | no |
| `BUSY` | reported | The other side already runs `MAX_INBOUND_IN_FLIGHT` of your calls; the method did not run. | yes |

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
runs; in iframe mode that needs `allow-scripts` and inline scripts allowed by `script-src`.

| Global | iframe | worker | strict (worker) |
| :--- | :--- | :--- | :--- |
| `bridge` | ✓ | ✓ | ✓ |
| `sandboxFiles` | ✓ | ✓ | ✓ |
| `sandboxFetch` | with `fetchBridge` | with `fetchBridge` | with `fetchBridge` |
| `sandboxView` | — | — | ✓ |
| `console` relayed | `log`, `info`, `warn`, `error` | `log`, `info`, `warn`, `error` | `log`, `info`, `warn`, `error` |

Removed before guest code runs: `RTCPeerConnection` (and prefixed variants) in every mode. In strict mode also
`Worker`, `SharedWorker`, `URL.createObjectURL`, and `WebAssembly` unless `scriptUnsafe`. In strict mode the view
document runs no guest code at all.

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
| `url` | `(path: string) => string` | The file's `blob:` URL, minted in the guest's own realm. Throws `NOT_FOUND`. |
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
request under the [`fetchBridge`](#fetchbridge) rules. Only `method`, `headers` and `body` are read from `init`;
the body is a string, an `ArrayBuffer` or a typed array. Resolves with a whole `Response` (no streaming, no
`AbortSignal`); rejects with a [`FetchErrorCode`](#sandboxfetch-fetcherrorcode). `fetch` itself is untouched;
assign `globalThis.fetch = sandboxFetch` to route through the bridge. [ADR-006](ADR-006-fetch-bridge.md)

### `sandboxView` (strict mode)

| Member | Signature | Description |
| :--- | :--- | :--- |
| `render` | `(html: string, into?: string \| null) => void` | Replaces the view's body, or the children of the element with id `into`. At most `VIEW_RENDER_MAX_LENGTH` characters (else `RangeError`). The latest render per target wins; one render is in flight at a time. |
| `on` | `(type, id: string \| null, handler: (detail) => void) => () => void` | Subscribes to `click`, `input`, `change`, `submit` or `keydown` on the element with that id (or inside it), or anywhere with `null`. Returns `off`. |

The renderer removes `iframe`, `frame`, `frameset`, `object`, `embed`, `portal`, `fencedframe`, `script`, `meta`,
`base`, `noscript` and `template` with their content, and the SVG animation elements `animate`, `set`,
`animateMotion`, `animateTransform`, `animateColor`, `discard` and `animation`, so no attribute it checked can change
afterwards; handler attributes and `javascript:` URLs never run; link clicks and form submissions navigate nowhere.
Registered files are named by path in `src`, `href` and `poster`.

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
}
```

Never a URL. Strings are cut at 65536 characters, `ids` at 32 entries, `form` at 1000 fields. A handler that
throws is logged and does not stop the others. [ADR-005](ADR-005-strict-mode.md)

---

## Modes

| | `iframe` (default) | `worker` | `strict` |
| :--- | :--- | :--- | :--- |
| Guest code runs in | the guest document | a worker spawned inside the frame | a worker; the view runs only the library's hash-admitted script |
| Guest markup | `html` / `load()` | none | rendered by `sandboxView.render()`; `html` is the initial view |
| How code starts | markup scripts, `execute()` | `execute()` | `entry`, `execute()` |
| `autoResize` | ✓ | — | ✓ |
| `workerExecutionTimeout` | — | ✓ | ✓ |
| Watchdog bounds a loop | where the frame runs in its own process | ✓ | ✓ |
| `unsafeCapabilities` | ✓ | ✓ | — |
| Files named from markup | ✓ | — | `src`, `href`, `poster` in rendered markup |

Choose strict mode for content you do not trust at all. [ADR-005](ADR-005-strict-mode.md)

---

## Limits

| Limit | Value | Exported constant |
| :--- | :--- | :--- |
| Inbound calls running at once, per side and environment | 256 | `MAX_INBOUND_IN_FLIGHT` |
| Default call timeout (ms) | 30000 | — |
| Guest log lines per second, per environment | 1000 | `LOG_EVENTS_PER_SECOND` |
| Arguments kept per log line | 64 | `LOG_MAX_ARGS` |
| Characters kept per string log argument | 65536 | `LOG_MAX_STRING` |
| `violation` events per environment (strict mode: per source, and per directive for the view) | 100 | `VIOLATION_EVENT_LIMIT` |
| Auto-size: tallest height (px) | 100000 | `AUTO_RESIZE_MAX_HEIGHT` |
| Auto-size: height changes per second (and at most one per frame) | 30 | `AUTO_RESIZE_MAX_UPDATES_PER_SECOND` |
| Strict: characters per `sandboxView.render()` | 262144 | `VIEW_RENDER_MAX_LENGTH` |
| Strict: characters of a render or event target id | 1024 | — |
| Strict: view liveness budget (ms) | 5000 | `VIEW_LIVENESS_TIMEOUT_MS` |
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

## Exports

Values:

| Export | What it is |
| :--- | :--- |
| `defineWebSandbox` | Registers the element; see [above](#registering-the-element). |
| `WebSandbox` | The element class. |
| `SandboxDevTools` | `new SandboxDevTools(element)`, then `activate()`, `deactivate()` or `toggle()`: prints the element's `sandbox-log` lines to the host console. |
| `SAFE_CAPABILITIES`, `UNSAFE_CAPABILITIES`, `UNSAFE_SANDBOX_FLAGS`, `UNSAFE_PERMISSIONS` | The capability lists accepted by `capabilities` and `unsafeCapabilities`. |
| `FETCH_ERROR_CODES` | Every `FetchErrorCode`. |
| `MAX_INBOUND_IN_FLIGHT`, `LOG_EVENTS_PER_SECOND`, `LOG_MAX_ARGS`, `LOG_MAX_STRING`, `VIOLATION_EVENT_LIMIT`, `AUTO_RESIZE_MAX_HEIGHT`, `AUTO_RESIZE_MAX_UPDATES_PER_SECOND`, `VIEW_RENDER_MAX_LENGTH`, `VIEW_LIVENESS_TIMEOUT_MS`, `EXECUTION_TIMEOUT_GRACE_MS`, `GUEST_WRITES_PER_SECOND`, `GUEST_WRITE_BYTES_PER_SECOND` | See [Limits](#limits). |

Types: `SandboxConfig`, `SandboxState`, `RpcError`, `RpcErrorCode`, `SandboxLog`, `SandboxLogLevel`,
`SandboxViolation`, `FetchBridgeConfig`, `FetchErrorCode`, `FetchRecord`, `FileContent`, `FileEntry`,
`FileInfo`, `FileError`, `FileErrorCode`, `SandboxFiles`, `GuestWrite`, `CSPDirectives`, `SafeCapability`,
`UnsafeCapability`, `UnsafePermission`, `SandboxCapability`.

The playground's scenarios (`src/lib/presets.ts`) are not part of the package: each preset is a `code` payload
with the `rules` (a `Partial<SandboxConfig>`) and optional `files` it runs with, shared with the regression
specs.

---

## Examples

**Markup with a host method** (iframe mode):

```js
const sandbox = document.querySelector('web-sandbox');
sandbox.expose('save', (record) => store.put({ ...record }));
sandbox.setConfig({
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

**Strict mode with files, a watchdog and the fetch bridge**:

```js
sandbox.registerFiles({
    'main.js': `
        sandboxView.render('<button id="load">Load</button><ul id="list"></ul>');
        sandboxView.on('click', 'load', async () => {
            const items = await (await sandboxFetch('https://api.example/items')).json();
            sandboxView.render(items.map(i => '<li>' + i.name + '</li>').join(''), 'list');
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
sandbox.addEventListener('violation', (e) => console.warn(e.detail.directive, e.detail.blockedURI));
```
