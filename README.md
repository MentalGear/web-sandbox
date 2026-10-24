# Web Sandbox

A secure, local-first sandbox implementation using `iframe srcdoc`, Opaque Origins, and Immutable CSP.

## Overview

Web Sandbox provides a mechanism to run untrusted JavaScript code safely in the browser without requiring a backend for isolation. It leverages the browser's own security primitives (Opaque Origins, CSP) to create a secure environment.

**Key Features:**
*   **Local-First:** No server round-trips for code execution.
*   **Secure by default:** [strict mode](#strict-mode), the default, runs guest code only in a worker; the visible
    frame runs no guest script. Every guest runs in an opaque origin: no access to the host origin's storage, Service
    Workers, DOM or scripts. Strict mode admits no `origins` entry on the host page's site (a guest request to one can
    carry the host site's cookies in some engines, except a `fetch()` or `XMLHttpRequest`; see [Cookies](#limits)). [Cooperative mode](#modes) runs guest script
    in a document, for content that cooperates, with the [limits listed below](#limits).
*   **Unified:** Use the same "Preset" definitions for both manual testing (Playground) and automated regression testing.

## Getting Started

1.  **Install Dependencies**
    This project relies on [Bun](https://bun.sh).
    ```bash
    bun install
    ```

2.  **Start the Development Server**
    The Vite dev server transpiles the TypeScript sources on the fly.
    ```bash
    bun run dev
    ```
    *   **Playground:** [http://localhost:4444/playground/index.html](http://localhost:4444/playground/index.html)

3.  **Run Tests**
    Unit tests, then the e2e and security research suites (Playwright starts the dev server itself).
    ```bash
    bun run test        # everything
    bun run test:unit   # vitest only
    bun run test:e2e    # playwright only; add --project=chromium for one browser
    bun run test:probes # the strict-mode design probes (research 15), on their own server
    ```
    Use `bun run test`, not `bun test`: the latter is Bun's built-in runner, not the project script.

4.  **Type-check and build the package**
    ```bash
    bun run typecheck   # src, tests, playground
    bun run build:lib   # dist/: ESM bundle + .d.ts
    ```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow.

## Playground Usage

Navigate to [http://localhost:4444/playground/index.html](http://localhost:4444/playground/index.html).

*   **Presets:** Select a scenario from the dropdown to load pre-configured code and security rules; the playground opens on a strict-mode demo, the default mode. Every preset names the mode it was written for. The regression specs run the very same presets (`fromPreset()` in `test/e2e/presets.ts`), and a unit test fails if a security preset has no spec. A preset says whether to use "Run Code" or "Run as HTML".
*   **Code Editor:** Modify the JavaScript code to test different behaviors.
*   **Rules Editor:** The configuration as JSON: execution mode, capabilities, the `origins` the guest may load from.
*   **Logs:** View `console.log` output and security events from within the sandbox.

## Architecture

The whole picture, on one page, with the realms, channels, frames and lifecycle drawn from the code: [ARCHITECTURE.md](ARCHITECTURE.md).

*   **`src/host.ts`**: The core implementation of the `<web-sandbox>` custom element. It handles frame creation, configuration, and communication.
*   **`src/lib/origin.ts`**, **`src/lib/csp/origins.ts`**, **`src/lib/csp/csp-generator.ts`**: The guest policy: the one origin parser (shared with `fetchBridge.allow`), `origins` parsed at the boundary, and one policy template per mode.
*   **`src/lib/frame-documents.ts`**: Builds the wrapper, guest and fetch bridge frame documents (see Security Mitigations).
*   **`src/lib/rpc.ts`**: The broker behind `expose()` and `call()`; the host and the guest run the same code.
*   **`src/lib/files.ts`**, **`src/lib/in-sandbox-files.ts`**: Registered files: the host's store, and the guest's `sandboxFiles`.
*   **`src/lib/markup-references.ts`**: Resolves guest markup references (`<script src="app.js">`) to registered files before the guest is built.
*   **`src/lib/module-specifiers.ts`**, **`src/lib/import-map.ts`**: The module graph: relative imports in registered modules rewritten to virtual URLs (with the bundled es-module-lexer), and the guest's own import maps merged into the one the bootstrap registers.
*   **`src/lib/auto-resize.ts`**: Auto-sizing on the host: validates, clamps and rate-limits the guest's height reports.
*   **`src/lib/fetch-bridge.ts`**, **`src/lib/bridge-frame.ts`**, **`src/lib/in-bridge-frame.ts`**: The fetch bridge: on the host, the allowlist, the request discipline and the `fetch` log; the frame with an opaque origin that makes every request.
*   **`src/lib/in-sandbox-view.ts`**, **`src/lib/csp/script-hash.ts`**: Strict mode: the view's hashed bootstrap and renderer, the worker's prelude (`sandboxView`), and the synchronous SHA-256 that admits the bootstrap.
*   **`src/lib/presets.ts`**: The scenarios both the Playground and the regression specs run: one definition per attack (payload, rules, research folder).
*   **`vite.config.ts`**: The dev server for the playground and the e2e harness.
*   **`test/e2e`**: Playwright e2e specs, plus the shared harness page and fixture every suite runs on.
*   **`docs/research`**: Security findings, each with a Playwright reproduction that guards its mitigation.

## Usage

```js
import { defineWebSandbox } from 'web-sandbox';   // or './src/index.ts' from a checkout

defineWebSandbox();                 // registers <web-sandbox>; pass a name to use your own tag
const sandbox = document.querySelector('web-sandbox');
sandbox.load('<h1>Hello</h1>');     // strict mode, the default: shown, and no script in it runs
```

Importing the module registers nothing, so you choose the tag name. The element is a block by default; give it a
height. The package is private and not published yet ([D1](docs/BACKLOG.md#bl-d1)), so `import … from 'web-sandbox'`
resolves only in a project that links or packs a checkout; from a checkout, import `./src/index.ts`. `bun run dev` serves the
playground on port 4444 only (`strictPort`).

**Your page's own policy applies inside the sandbox.** Its frames are `srcdoc` documents, which inherit the host
page's Content-Security-Policy, Trusted Types and Cross-Origin-Embedder-Policy. A host policy that refuses what the
sandbox needs ends the build with a reason that names it; what to allow, per mode, is in
[API.md](docs/API.md#host-page-policy). Cooperative and worker mode need `'unsafe-inline'` in your `script-src`, which
browsers ignore next to a hash or a nonce: they cost a page its own nonce- or hash-based script policy, so prefer strict mode.

### Modes

| Mode | Guest code runs in | For |
| :--- | :--- | :--- |
| `strict` (default) | a worker; the view runs only the library's own script, admitted by its hash, and shows what the worker renders | content you do not trust ([Strict mode](#strict-mode)) |
| `cooperative` | the guest document: its scripts, handlers and `execute()` | cooperative content: code that does not attack the page, such as your own, within the [cooperative-mode limits](#cooperative-mode-limits) |
| `worker` | a worker inside a hidden frame; no markup, code through `execute()` | headless code; frozen, to be folded into strict mode |

In strict mode `html` (and `load()`) is the initial view: its `<script>` elements and `on…` handlers never run, and
the element says so once (`strict mode (the default) runs no script in html; …`). Put the code in a registered file
named by `entry`, or choose `mode: 'cooperative'`. `mode: 'iframe'` is not a mode: it starts nothing,
and the `terminated` reason names `'cooperative'`.

**The guest reaches nothing by default.** List the exact origins it may load each kind from in `origins`
(`connect`, `images`, `styles`, `fonts`, `media`, `scripts`); everything else in its policy is fixed:

```js
sandbox.setConfig({
    entry: 'main.js',
    origins: { connect: ['https://api.example.com'], images: ['https://cdn.example.com'] },
});
```

An entry is one origin (`https://host[:port]`, `wss://` for `connect` beside its `https://` twin, plain `http://` only for
`localhost` and `127.0.0.1`); a scheme, wildcard, keyword, `data:` or path is dropped with a warning, and so is a
`wss://` entry without its `https://` twin. Strict mode takes no `scripts`, so `scripts` needs `mode: 'cooperative'` or
`'worker'` ([API](docs/API.md#origins), [ADR-007](docs/ADR-007-typed-origins.md)).

**Your page's `connect-src` applies to `origins.connect` and `fetchBridge.allow`, the same on every engine.** An origin
it does not admit by scheme and host (`'self'` admits nothing) is dropped with a warning. `hostContentSecurityPolicy`
gives the library the policy as text, or `false` to skip; left out, the library reads it once per page, when a build
first lists a connect origin, by one deliberate violation in a hidden frame that reaches neither the network nor the DNS
(it costs a console error and, when a policy refuses it, a CSP report; [API](docs/API.md#your-connect-src)).

<!-- generated:begin connect-sentence -->
Without the library's own rules the engines disagree: a `'self'` source of the host page's `connect-src` admits origins it does not name in WebKit only, a `wss://host` source also admits `https://host` requests in WebKit only, and a host written without a scheme is read differently by each. The library applies the page's policy and these two rules itself, so `origins.connect` and `fetchBridge.allow` mean the same everywhere.
<!-- generated:end -->

**API reference**: [`docs/API.md`](docs/API.md) lists every option, method, event, refusal code, guest global
and limit. The sections below walk through each feature.

## Lifecycle

`sandbox.state` tells where the sandbox is: `idle` (not in the document), `loading` (a frame is
being built), `ready` (the guest's startup script checked in; its document may still be loading) or `terminated`. There is no "running" state: nothing the
guest reports could make it truthful. `workerExecutionTimeout` checks that the event loop is free at each
`execute()`'s deadline ([API](docs/API.md#executecode)).
A config or build the element cannot use ends in `terminated` with a reason; `setConfig()` never throws.

```js
sandbox.addEventListener('ready', () => { /* state is 'ready' */ });
sandbox.addEventListener('terminated', (e) => console.warn(e.detail.reason));
sandbox.addEventListener('sandbox-log', (e) => console.log(e.detail.level, ...e.detail.args));
sandbox.addEventListener('violation', (e) => console.warn(e.detail.directive, e.detail.blockedURI));

sandbox.terminate('user pressed stop');  // tears it down; 'terminated' fires once
sandbox.reset();                         // a fresh frame and opaque origin, from any state
```

*   **`terminate(reason?)`** removes the frame now and fires `terminated` with `{ reason }`. Calling
    it again while terminated does nothing. The sandbox stays terminated until `reset()`, `load()` or
    `setConfig()`.
*   **`reset()`** builds a fresh environment with the current config, from any state. Guest methods
    are gone, host methods stay; pending calls reject with `TERMINATED`.
*   **Removing the element** tears the sandbox down the same way, without a `terminated` event, and
    leaves it `idle`. Inserting it again builds a fresh one. Moved into another window's document, it builds
    nothing there (one warning) until it is back.
*   **`ready` is the guest's check-in**, not its load: slow images never delay it. In strict mode it is the view's
    check-in, on the port only its bootstrap holds; in worker mode it comes once the worker runs. A cooperative frame
    without `allow-scripts` has no guest script to check in: `ready` comes with the frame's load, and calls time out. Calls and `execute()` sent while
    the guest document is still being parsed wait in the guest until it is, in order, so methods its scripts expose
    are there ([API](docs/API.md#ready-and-the-startup-gate)). A build whose guest has not checked in within
    `LOAD_TIMEOUT_MS` (5 s of host time) ends with `the sandbox did not finish loading`, or, when its frame loaded and
    its startup script never ran, with a reason that names the host page's policy. A guest that reloads or
    rewrites its own document ends its environment (`the guest frame announced itself again …`).
*   **A build that is refused** (a config that cannot be used, an unknown mode, an entry that is not registered) sets
    `state` to `terminated` at once and dispatches `terminated` in a task, like `ready`, so a listener added right
    after the call hears it. `setConfig()` with the configuration the environment already stands on changes nothing.
*   **Events** are dispatched on the element. `sandbox-log` (guest `console` output and errors) bubbles,
    so a listener on `window` hears every sandbox on the page and `event.target` says which one. Its detail
    is `{ type: 'LOG', level, args, source }` (type `SandboxLog`): `level` is `log`, `info`, `warn` or
    `error`; `source` is `'host'` for the element's own lines (an execution timeout, an entry that failed, guest lines
    it dropped past its per-second window) and
    `'guest'` for everything from the guest, whatever it claims. Guest lines carry the guest's `console` calls (every
    method), uncaught errors and unhandled rejections (`Uncaught …`), in every mode (in worker and strict mode they are
    cancelled once relayed, and more than 1000 of them, or 1 Mi characters of the names and messages of them, in one second end the sandbox;
    whatever the reason says it is, its `name` and `message` are counted);
    the guest's console never throws:
    a function, a DOM node or anything else structured clone refuses arrives as a string naming its kind, an `Error`
    (also inside an object, an array or `Promise.allSettled`'s results) as `{ name, message, stack }`. Bounded in the
    guest before anything is posted: 64 arguments, strings cut at
    64 Ki characters, 1 MiB per line (`LOG_MAX_BYTES`), 1000 lines and 4 MiB per second; the element measures each
    line again. Lines logged before the guest is connected (a strict entry's top level) are kept, up to 1000, and
    arrive once it is. `args` are the guest's data: read them, don't merge them into your objects with
    `Object.assign` (an own `__proto__` key survives the copy).
*   **`violation`** reports a load the guest policy refused: `{ directive, blockedURI }`, plus
    `sourceFile`, `lineNumber` and `columnNumber` when the browser gives them. It bubbles like
    `sandbox-log`. The guest's bootstrap listens before any guest code runs, but every field comes from
    the guest and guest code can suppress its own reports, so an event is evidence that the guest tried
    something; no event proves nothing. A frame the guest creates reports to itself, not here. A `fetch()`,
    `XMLHttpRequest` or `WebSocket` to an origin `origins.connect` does not list is refused by the library's request
    gate and reported by it, the same on every engine and in every mode (`sourceFile: 'web-sandbox:request-gate'`);
    what the browser reports itself in a worker depends on the engine (WebKit raises none there; Firefox none for
    worker mode's `importScripts`). At most 100 per environment (`VIOLATION_EVENT_LIMIT`; for the strict view, per directive);
    type `SandboxViolation`. In
    strict mode each report also carries `source`, `'view'` or `'logic'` (see [Strict mode](#strict-mode)).
*   **Every string a guest can set is attacker text**: a log line's `args`, a violation's `blockedURI` and `sourceFile`,
    a `fetch` record's `url` (it can be `javascript:`), the message of a call rejected by a guest handler, and the
    arguments of a method you `expose()`. "Validated and clamped" bounds its size and shape; it does not make it safe to
    display. Show it with `textContent`, and never pass it to an HTML (`innerHTML`, `insertAdjacentHTML`), URL (a link
    `href`), `eval` or template sink. (`terminated.reason` is the library's own text.)
*   **`state === 'terminated'` is a second, authoritative signal** next to a call's `TERMINATED`
    code: the element sets both from its own state, so the guest can produce neither.

**Watchdog** (opt-in): with `watchdogTimeout: ms`, the host checks that the guest's event loop keeps
answering and terminates a guest that falls silent for that long (reason: `the guest stopped
responding (watchdog)`). In strict and worker mode guest code runs only in a worker, so the bound holds on every
browser. In cooperative mode it holds only where the browser runs the sandboxed frame in its own process. That is
the browser's choice, not the page's: Chromium often does, but not in every environment, and Safari does not. Where
the frame shares the host page's thread, a guest stuck in a loop freezes the host page too, and no watchdog can run
until it stops; the watchdog then only guarantees that the host's own stall is never blamed on the guest. It is off
by default because a guest doing long synchronous work on purpose would be stopped as well: in strict mode an `entry`
that loops forever spins its worker until `terminate()` (the host page stays responsive), unless `watchdogTimeout` is set. It checks liveness only;
`terminate()` is how the host stops a guest at will.

```js
sandbox.setConfig({ entry: 'main.js', watchdogTimeout: 2000 });
```

Why it is built this way: [ADR-003](docs/ADR-003-lifecycle-and-liveness.md).

## Auto-sizing

With `autoResize: true` (strict and cooperative mode, off by default) the element's height follows the guest's
content, growing and shrinking with it, a frame or two after the content changes.

```js
sandbox.setConfig({ entry: 'main.js', autoResize: true });
```

*   **How**: the guest bootstrap watches the guest's root element with a `ResizeObserver` and reports its
    height over the private port; the host sets the element's `style.height` in pixels (the element is a block, so
    the height applies).
*   **What is measured**: the root element's box, which follows content in normal flow, plus the scroll
    height when content overflows the frame. A guest that pins its root to the viewport
    (`html { height: 100% }`) still grows the frame but never shrinks it.
*   **Reports are untrusted.** Guest code cannot post on the private port, but it can make the bootstrap
    measure any height (it can replace what the bootstrap reads), at most once per rendering update. The
    host accepts only a finite number `>= 0`, rounds it up to whole pixels, clamps it to 100 000 px
    (`AUTO_RESIZE_MAX_HEIGHT`), and writes at most once per animation frame and at most 30 times a second
    (`AUTO_RESIZE_MAX_UPDATES_PER_SECOND`), always ending at the newest report. So a guest whose height
    oscillates costs the host page a bounded number of relayouts. Off, nothing a guest does changes the element.
*   **Lifecycle**: the height stays across `reset()`, `load()` and `setConfig()` until the new guest
    reports; a config without `autoResize` gives the height back to your CSS. Like the bridge, it needs the
    bootstrap to run (`allow-scripts`, inline `script-src`). In worker mode it does nothing, with one warning.

## Capabilities

`capabilities` takes the sandbox flags that keep the guest inside the frame: `allow-scripts`,
`allow-orientation-lock`.

Capabilities that let the guest act outside the frame — `allow-forms`, `allow-popups`, `allow-modals`,
`allow-downloads`, `allow-presentation`, `allow-pointer-lock` and `fullscreen` — are dropped from `capabilities` with a
warning. If you really need one, pass it in `unsafeCapabilities` (cooperative and worker mode; strict mode drops
them); the sandbox logs a warning for each one enabled. A popup, for example, is a new top-level window that no CSP
governs, so its URL is an exfiltration channel ([research 13](docs/research/13_popup_exfiltration/README.md)). Without
`allow-popups` guest code opens no window, but in cooperative mode the user still can: a Ctrl-, Shift- or
middle-click, or Ctrl/Shift+Enter, on a guest link opens it in a new tab in Chromium and Firefox, as for any sandboxed
frame (strict mode's links are inert). On Chromium the sandbox's frame is credentialless, so a popup that `allow-popups`
lets the guest open has no opener: the guest's `window.open()` returns `null`, though the page opens. `allow-forms` is among them because a submission opened in a new tab that way
is not checked against `form-action` in Chromium. Strict mode's view always has `allow-scripts allow-forms`: no guest
script runs there, and it cancels every submit.

```js
sandbox.setConfig({
    mode: 'cooperative',
    capabilities: ['allow-scripts'],
    unsafeCapabilities: ['allow-popups', 'fullscreen'], // explicit opt-in, warns
});
```

`fullscreen` is not a sandbox flag but a Permissions Policy feature: it is set as `allow="fullscreen *"`
(plus the legacy `allowfullscreen`) on both the wrapper and the guest frame, since a feature reaches the
guest only if every frame on the way delegates it. The `*` is needed because a sandboxed `srcdoc` frame
has a fresh opaque origin that the default allowlist never matches. The risk is UI spoofing — a fullscreen guest can draw a fake browser window — which
browsers soften by requiring a user gesture and showing an exit hint. `allow-pointer-lock` is unsafe for the same
reason: a guest that holds the pointer lock can hide the cursor and capture relative input, so it can draw a cursor of its own over fake host UI.

`allow-same-origin` and the `allow-top-navigation*` flags are never accepted.

**`scriptUnsafe` is for testing.** It adds `'unsafe-eval'` to the guest policy, so guest code can run
strings as code (`eval`, `new Function`), and it enables `execute()`. The e2e suite and most playground
presets turn it on; content you do not trust should run without it. Enabling it logs one warning per
element.

## Calling between host and guest

The host and the guest can call each other's functions and await the result. Each side publishes
functions with `expose(name, fn)` and calls the other side's with `call(method, ...args)`, which
returns a promise for the handler's return value; if the handler throws, the promise rejects with
the same message. On the host these are methods of the element; in the guest they live on the
global `bridge`.

```js
sandbox.expose('ping', () => 'pong');                       // host method, callable by the guest
sandbox.registerFiles({ 'main.js': `
    bridge.expose('sum', (a, b) => a + b);                  // guest method, callable by the host
    bridge.call('ping').then(reply => console.log(reply));  // logs "pong"
` });
sandbox.setConfig({ entry: 'main.js' });                    // strict mode runs the entry in its worker

const total = await sandbox.call('sum', 1, 2);              // 3, once the sandbox is ready
```

In cooperative mode the same code can sit in a `<script>` of the guest's markup.

*   **Only exposed methods can be called.** Any other name, built-in ones like `toString` or
    `__proto__` included, rejects with `unknown method`. Exposing a name again replaces its handler.
*   **Values are copied, not shared.** Arguments and results are copied the way `structuredClone`
    copies, so they must be cloneable data; a function or a DOM node fails that one call at once.
*   **Treat a handler's arguments as untrusted input.** They are plain data, but the other side
    chose them: validate before use, and copy objects with spread (`{ ...arg }`) rather than
    `Object.assign`, which turns an own `__proto__` key into a prototype change.
*   **Every call times out** after 30 seconds by default. `callWithTimeout(ms, method, ...args)`
    sets a different limit for one call; `0` turns it off. A call made while loading that times out
    before the guest is ready never runs.
*   **Host methods belong to the element**, so they survive `reset()`, `load()` and `setConfig()`. Guest
    methods belong to one frame: a new frame starts with none until its own code exposes them.
*   **A reset settles every pending call.** When `reset()`, `load()` or `setConfig()` recreates the
    frame, the element is removed, or the sandbox is terminated, pending calls reject; calls made
    after termination reject at once.
*   **Every rejection has a `code`; branch on it, not on the message.** `TIMEOUT`, `TERMINATED`, `SEND_FAILED`
    and `INVALID_CALL` are set only by the side that made the call, so the other side can never produce them.
    `UNKNOWN_METHOD`, `HANDLER_ERROR`, `RESULT_NOT_TRANSFERABLE` and `BUSY` come from the other side, and their
    message is its text. `ARGS_NOT_TRANSFERABLE` comes from either: arguments that can never be carried are refused
    before sending, and answered so by the other side if they arrive. Only `TIMEOUT` and `BUSY` are worth retrying,
    and `TERMINATED` only after the next `ready` event (types: `RpcErrorCode`, `RpcError`).
*   **At most 256 calls run at once** on each side for one environment (`MAX_INBOUND_IN_FLIGHT`): a further
    call is refused at once with `BUSY`, before its method runs, so calls to a slow method cannot pile up
    without bound. The guest makes at most 1000 calls and 64 MiB of calls in any one second (`callLimits` sets
    other values); past that its `bridge` refuses a call with `BUSY` before sending it, and the element answers `BUSY`
    to one that arrives anyway. A call heavier than `maxBytesPerSecond` could never fit, so both ends refuse it with
    `ARGS_NOT_TRANSFERABLE`, which is not worth retrying.
*   **Every message is bounded as a whole**: a method name is at most 256 characters, an error message at most
    65536 (cut, with a marker), and arguments or a result at most 33 MiB (`RPC_MAX_BYTES`), measured on both sides (the
    measure counts what a clone delivers: a `File`'s name, a `Blob`'s type, a sparse array's `length`).
*   **No `scriptUnsafe` needed.** `call()` runs a function the other side registered and never
    evaluates code. A worker-mode guest has no markup, though, so it can only expose methods
    through `execute()`, which does need `scriptUnsafe`.

Why it is built this way: [ADR-002](docs/ADR-002-host-guest-broker.md).

## Fetch bridge

By default the guest reaches no network at all (`connect-src 'none'`). With `fetchBridge`, the guest gets
`sandboxFetch(url, init)`: the **host** decides each request under a fixed discipline and logs it, and a hidden
frame of the library's, with an opaque origin of its own, makes it. The guest policy does not change: direct `fetch`
and `WebSocket` stay refused unless `origins.connect` lists them.

```js
// strict mode, the default: the guest's code is a registered file, named by `entry`
sandbox.registerFiles({ 'main.js': `
    sandboxFetch('https://api.example/items', { headers: { accept: 'application/json' } })
        .then(response => response.json())
        .then(items => console.log(items.length));
` });
sandbox.setConfig({
    entry: 'main.js',
    fetchBridge: { allow: ['https://api.example'], maxBytes: 1024 * 1024, timeoutMs: 10000 },
});
sandbox.addEventListener('fetch', (e) => console.log(e.detail.method, e.detail.url, e.detail.outcome, e.detail.status ?? e.detail.code));
```

*   **Exact origins only.** `allow` lists origins (`https://api.example`, `http://localhost:8080`); an entry
    with a path, query or wildcard is dropped with a warning. Anything else is refused before a request is
    made, including the host page's own origin and loopback, private and link-local hosts (`localhost`,
    `127.0.0.1`, `10.x`, `192.168.x`, `[::1]`, …) and names private by convention (`printer.local`,
    `host.docker.internal`, a single label such as `intranet`) unless you list them (a private host is kept only when the host page is itself on one). A listed public name that resolves to
    a private address (DNS rebinding) cannot be detected from a page.
*   **No host authority.** Requests never carry cookies or other credentials (`credentials: 'omit'`) nor a
    `Referer`, and never follow redirects. Your page's `fetch` never makes them: its Service Worker never answers
    them (from your app's cache, say) and a wrapper of your `fetch` (an auth header, a tracing header) never applies
    to them. Only `method`, `headers` and `body` are read from `init`.
    Methods: `GET`, `HEAD`, `POST`, plus `PUT`, `PATCH`, `DELETE` if listed in `methods`. Headers:
    `accept`, `accept-language`, `content-language`, `content-type`, plus names listed in `headers`
    (`Authorization` only that way; `Cookie` never). A header the guest may not set refuses the request.
*   **Bounded.** The response body is capped at `maxBytes` (1 MiB by default, at most 32 MiB): a larger
    `Content-Length` is refused unread, and an undeclared body is abandoned as soon as it passes the cap.
    Each request has `timeoutMs` (10 s by default, body included) and at most `maxConcurrent` (4) run at
    once. `reset()`, `load()`, `setConfig()`, `terminate()` and removal abort every request in flight.
    Whole responses only: no streaming, no `AbortSignal`; bodies are strings, `ArrayBuffer`s or typed arrays.
*   **Refusals have a code**, on the rejection's `code` (type `FetchErrorCode`): `FETCH_NOT_ALLOWED`
    (URL, origin, method, header or body), `FETCH_BUSY`, `FETCH_REDIRECT`, `FETCH_TOO_LARGE`,
    `FETCH_TIMEOUT`, `FETCH_FAILED` (network error, CORS, the bridge's frame could not start, or teardown).
    `FETCH_BUSY`, `FETCH_TIMEOUT` and
    `FETCH_FAILED` may succeed if retried. HTTP error statuses resolve, as with `fetch`.
*   **Every request is logged** as a `fetch` event on the element (it bubbles): `{ method, url, outcome, bytes,
    durationMs, … }`, `outcome` being `ok` (with `status`), `refused` (no request made; with `code`),
    `failed` (with `code`, and `status` when a response arrived) or `aborted`. Each outcome has its own fields:
    `FetchRecord` is a union keyed by `outcome`. Fields that come from the guest are validated or clamped first.
*   **The target sees `Origin: null`**, as for a direct request from the sandbox, never your page's origin or URL:
    its CORS must allow `*` or `null`. A target that allows only your page's origin refuses the bridge's requests
    (`FETCH_FAILED`). Answer `Access-Control-Allow-Origin: *` (or `null`) only for public data, and never with
    `Access-Control-Allow-Credentials: true`: every sandboxed frame on the web, an attacker's too, has the origin
    `null`, so a target must not treat `null` as trusted. The bridge itself never sends credentials (no cookies, no HTTP
    authentication), so it gets what any anonymous page gets.
*   **Your page's policy**: the bridge's frame runs the same hashed bootstrap as the strict view, under the same hash, so
    the policy that admits the sandbox admits it (`viewScriptHash()`, or `'unsafe-inline'`; see
    [Host page policy](docs/API.md#host-page-policy)), and one that refuses the view refuses it too (in strict mode the
    build then ends with the startup reason). Your `connect-src` must allow the listed origins, as for any request. A
    frame whose script never runs while the sandbox does fails closed: every request is refused with `FETCH_FAILED`.
*   `sandboxFetch` is a separate global; `fetch` itself is untouched (assign `globalThis.fetch = sandboxFetch`
    in the guest if you want that). It works in every mode. The name `sandbox:fetch`, like every
    method name starting with `sandbox:`, is reserved: `expose()` refuses it on both sides.

Why it is built this way: [ADR-006](docs/ADR-006-fetch-bridge.md).

## Files

The host registers files on the element; the guest reads them through the global `sandboxFiles`.

```js
sandbox.registerFiles({
    'app.js': 'import { greet } from "./lib/greet.js"; greet();',  // modules import by relative path
    'lib/greet.js': 'export const greet = () => console.log("hello");',
    'data.json': '{ "answer": 42 }',
    'logo.png': pngBytes,                                    // a Uint8Array
    'notes': { content: 'plain text', type: 'text/plain' },  // explicit type
});
sandbox.registerFiles({
    'css/site.css': '@import "base.css"; body { background: url(../logo.png); }',  // stylesheets too
    'css/base.css': 'p { margin: 0; }',
});
sandbox.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'] });
sandbox.load(`
    <script type="module" src="app.js"></script>             <!-- markup names files by path -->
    <link rel="stylesheet" href="css/site.css">
    <img src="logo.png" srcset="logo.png 1x">
    <script>
        sandboxFiles.text('data.json').then(JSON.parse);     // code reads them through sandboxFiles
        const url = sandboxFiles.url('logo.png');            // a blob: URL made in the guest
    </script>`);
```

*   **Files belong to the element.** They survive `reset()`, `load()`, `setConfig()` and `terminate()`.
    Each new environment gets a snapshot of them; a running guest never changes, so a file you register
    or remove reaches the guest at the next `reset()`, `load()` or `setConfig()`.
*   **Host API**: `registerFiles(files)` adds or replaces (a string is stored as UTF-8, a `Uint8Array`
    is copied); `unregisterFiles(paths?)` removes the given paths, or all of them; `listFiles()` returns
    `{ path, type, size }`. `fileschanged` fires with `{ paths }` when a call changed something.
*   **Guest API**: `sandboxFiles.list()`, `url(path)`, `read(path)` (a `Uint8Array`) and `text(path)`.
    It always exists: with no files, `list()` is empty and every lookup fails with `NOT_FOUND`. In
    worker mode the worker has its own.
*   **Paths** are relative, like `src/main.js`: letters, digits and `._~!$&'()*+,;=@-`, separated by
    single slashes, at most 256 characters, no `.` or `..` segments. They are checked, never rewritten.
*   **Lookups are exact.** Anything other than a registered path — `../x`, `/x`, `%2e%2e/x`, another
    sandbox's path — fails with `code: 'NOT_FOUND'`, the same as a missing file.
*   **Refusals** throw an `Error` with a `code` and change nothing: `INVALID_PATH`, `INVALID_FILE`, or
    `FILES_QUOTA_EXCEEDED` past 8 MiB in total or 1000 files.
*   **Types** come from the extension (`.js` is `text/javascript`, `.css` is `text/css`, …; unknown is
    `application/octet-stream`). The policy gains `blob:` only for the kinds of load the registered types are for
    (`.js` scripts, `.css` styles, `image/*` images, …; every file for `connect`).
*   **Markup references just work** (cooperative mode, when the bootstrap runs: with `allow-scripts`; strict mode's view names files in `src`, `href` and `poster`): `<script src>` (classic or
    module), stylesheet, icon and preload `<link href>`, and `src` of `img`, `source`, `video`,
    `audio`, `track` plus `video[poster]`, when the URL resolves to a registered path — `app.js`,
    `./app.js`, `/app.js`, `img/logo.svg`. Scripts keep their order (`defer`, `async`, modules and
    `document.currentScript` behave as if served). Anything else — an unregistered path, another case,
    a query or fragment (`logo.svg?v=2`) — stays as written and fails closed: it loads nothing and
    sends no request. The matched attribute reads as the `blob:` URL.
*   **A reference names a file only for the kind of load its type is for**: `<script src>` and
    `modulepreload` only JavaScript, a stylesheet `<link>` and `@import` only `text/css`, images
    (`img`, `srcset`, `poster`, icons, CSS `url()`) only `image/*`, `@font-face` only `font/*`, media
    only `audio/*` and `video/*`, `<track>` only `text/vtt`. Anything else stays as written, with a
    warning. This holds for files you register too: `x.js` registered as `text/plain` is a text file,
    never a script.
*   **Modules import each other by relative path** (same conditions): `import { a } from './lib/a.js'`,
    `'../x.js'`, `'/x.js'`, `export * from …`, and `import('./lazy.js')` with a string literal, from a
    registered module or an inline `<script type="module">`. The host rewrites those specifiers to
    `https://vfs.invalid/<path>` when you register the file, and the guest gets one import map from
    those URLs to its `blob:` URLs, so a module is evaluated once however it is reached. `read()` and
    `text()` return the file as you registered it; `url()` serves the rewritten module. A guest
    `<script type="importmap">` is merged into that one map (entries for `https://vfs.invalid/` are
    ignored), so it works the same in every engine.
*   **Modules: what does not work** (fails closed): `import()` of a computed string,
    `new URL('./x', import.meta.url)` (`import.meta.url` is a `blob:` URL; use `sandboxFiles.url()`),
    module workers, and module graphs in worker mode (no import map there). A relative import of an
    unregistered file is refused by the policy. A file the lexer cannot parse is delivered unchanged,
    with a warning. A rewritten JavaScript file counts its registered bytes plus what the rewrite adds
    against the 8 MiB cap.
*   **Stylesheets name files by `url()` and `@import`** (same conditions): in a registered `.css`
    file, relative to that file (`url(../img/bg.svg)`, `@import "base.css"`, `@font-face` `src`,
    `image-set()`), and in inline `<style>` and `style=""`, relative to the page. `srcset` on `<img>`
    and `<source>` works per candidate. The host finds the references with a CSS tokenizer when you
    register the file (comments, strings like `content: "x.png"`, `format()` and `local()` are left
    alone), and the guest writes its own `blob:` URLs in, each stylesheet after the files it names.
    `read()` and `text()` return the stylesheet as you registered it; `url()` serves the rewritten one.
    Each reference that could name a file counts its path plus 72 bytes against the 8 MiB cap.
*   **CSS: what does not work** (fails closed, left as written): a query or fragment
    (`url(bg.svg?v=2)`), an unregistered path, and references that lie on a cycle (`a.css` imports
    `b.css` which imports `a.css`, or a sheet that imports itself), which get one warning — the
    sheets' other rules and references still apply. URLs that only exist at run time (`url(var(--x))`,
    styles set from script), `imagesrcset`, SVG `<style>`, at-rule preludes other than `@import`, and
    a stylesheet that is not UTF-8 (delivered unchanged, with a warning).
*   **Not yet**: references inside `<template>`. Use `sandboxFiles.url()` for those, and for anything
    built at run time.

### Guest writes

Off by default. With `guestWrites: true` the guest can write and remove files; the host decides what is kept.

```js
sandbox.setConfig({ guestWrites: true, /* … */ });
// in the guest
await sandboxFiles.write('out/report.json', JSON.stringify(result));  // a string, Blob, ArrayBuffer or typed array
await sandboxFiles.remove('draft.txt');
// on the host
sandbox.addEventListener('fileswritten', (e) => console.log(e.detail.paths));
sandbox.listGuestWrites();                        // [{ path, change: 'write', type, size, content }, …]
sandbox.commitGuestWrites(['out/report.json']);   // now a registered file, from the next build on
sandbox.commitGuestWrites(['gen/app.js'], { code: true });  // code needs the flag
```

*   **The host checks every write** as `registerFiles()` would (paths, types, the 8 MiB / 1000-file cap with
    every pending write counted) and at most 100 writes and 8 MiB in any one second; a refusal has the same codes,
    plus `FILES_BUSY` past the rate and `FILES_NOT_ALLOWED` when writes are off.
*   **The guest sees its own writes** in `list()`, `read()` and `text()` once the host accepted them, but
    `url()` of a written path is `NOT_FOUND`: the guest gets no URL for anything it wrote.
*   **Strict mode shows written images**: a PNG, JPEG, GIF, WebP or AVIF the guest wrote (a chart drawn on an
    `OffscreenCanvas`) can be named by path in an `<img>` of the next render, without a rebuild. The view makes the URL
    from the bytes the host holds, and only decodes it; a later write replaces it, a removal ends it. Nothing else the
    guest writes loads anywhere.
*   **Nothing is kept unless you commit it.** Pending writes belong to the environment: `reset()`, `load()`,
    `setConfig()` and removing the element discard them; `terminate()` keeps them so you can still inspect and
    commit them. `commitGuestWrites(paths)` takes an explicit list.
*   **Code needs `{ code: true }`.** Only images, fonts, audio, video, `text/plain`, `application/json` and
    `text/css` commit without it; JavaScript, HTML, SVG, XML, WebAssembly and anything else is refused with
    `FILES_NOT_ALLOWED`, judged by the type the file will be loaded as. A committed file loads only as what its
    type is for, so an inert file never runs as a script. Committed CSS is still CSS: markup of the next build
    that links it is styled by it.

Why it is built this way: [ADR-004](docs/ADR-004-files-as-blob-urls.md).

## Strict mode

Strict mode, the default (`mode: 'strict'`, or no `mode`), takes guest script out of every document. Guest code runs
only in a worker; the visible frame (the *view*) runs one script, the library's own, admitted by its hash, and shows
what the worker renders.

```js
sandbox.registerFiles({
    'main.js': `sandboxView.render('<button id="go">Go</button><p id="out"></p>');
                sandboxView.on('click', 'go', () => sandboxView.render('clicked', 'out'));`,
    'logo.png': pngBytes,
});
sandbox.setConfig({ entry: 'main.js', watchdogTimeout: 2000 });
```

*   **Guest API (in the worker)**: `sandboxView.render(html, into?)` replaces the view's body, or the children of
    the element with id `into` (at most 256 Ki characters; the latest render per target wins);
    `sandboxView.text(id, text)` sets an element's text (assigned, never parsed: nothing to escape);
    `sandboxView.set(id, { value?, checked?, focus?, scroll?, css? })` sets a form control, focuses an element while the
    user's focus is in the sandbox (never taking it from the host page), sets an element's own scroll position, or sets
    inline style properties of it from a closed list (transforms, opacity, visibility, geometry, `z-index`, `cursor`,
    custom properties); `sandboxView.on(type, id | null, handler, options?)` returns `off` and receives `click`,
    `input`, `change`, `submit`, `keydown`, `pointerdown`, `pointermove`, `pointerup`, `pointercancel`, `wheel`,
    `scroll`, `focusin` and `focusout` as `{ type, ids, target: { tag, id, name, value, checked }, key?, form?,
    pointer?, wheel?, scroll?, rect?, modifiers?, time?, coalesced?, truncated? }`. Pointer moves, wheel and scroll
    events are coalesced to one per pointer or element and animation frame, and pointer coordinates are clamped to the
    view's box; the options capture the pointer for a drag (`pointerCapture`), give the handler its element's
    rectangle (`rect`), or cancel a wheel's scrolling (`preventDefault`). So drag-and-drop within the view, gestures,
    custom sliders and virtual lists are guest code in the worker; native drag-and-drop with data from outside the view
    is not available. `bridge`, `sandboxFiles` and `sandboxFetch` work as in worker mode.
*   **Host API**: `entry` names a registered JavaScript file the worker runs first (a classic script, in a
    function scope of its own: its top-level declarations stay local, so assign `globalThis.x` to share; `this`
    is the global object); `html` and `load()` set the initial view (without an `entry` the worker runs only the
    library's own code: the view shows the cleaned `html`, and nothing of the guest's runs); `execute()` runs in the worker (needs
    `scriptUnsafe`); `call()`/`expose()` talk to the worker. An entry that fails to start ends the sandbox
    (`the guest entry failed to start`).
*   **What it guarantees**, on Chromium, Firefox and WebKit: no guest script runs in any document — the renderer
    keeps only allowlisted elements and attributes (no handlers, frames, `object`/`embed`, `meta`, `base`,
    `template`, SVG `use`, markers, filters or animation), so no nested frame exists and no checked attribute
    changes afterwards; the view holds at most 50 000 elements, 256 deep, 1 Mi characters and 1 000 URL-bearing
    attributes (`src`, `srcset`, `poster`, `<link>`'s `href`), parses at most 1 Mi characters of markup, makes at most 200
    loads per second, each charged before it can start (every URL attribute it keeps, and what the CSS it applies can
    load, counted from its text; any other load or refused load the browser reports for it once that prepayment is
    spent), loads at most 10 000 distinct URLs in its life, and ends the sandbox when an operation
    takes longer than 2 s for the second time within 5 minutes (the first is charged in full, and logged once); it shows only files that never open as
    a document (no SVG, HTML or XML; no `data:` images); a URL in rendered markup is kept only when it names a listed
    origin exactly (an image's `http:` URL may name a listed `https:` one), else dropped before the browser sees it,
    and an `http(s)` one reported as a `violation`; guest code has no
    `Worker`, no `RTCPeerConnection` (no WebRTC at all), no document, and no host URL (no request carries a
    `Referer`); the worker keeps only allowlisted globals, so it can request only through `fetch`, `XMLHttpRequest` and
    `WebSocket`, the library's request gate (each request checked against `origins.connect` and reported when refused,
    the same on every engine; `fetch` and `XMLHttpRequest` without credentials), and reaches its parent only through
    the library's port (it has no `postMessage` of its own); the view forwards only trusted events, never a URL, never
    where focus went, and no pointer coordinate outside its own box (a press that began in it is clamped to its edge),
    coalesces the continuous ones, holds them while the worker has not taken the last ones, and charges their cost to
    its time budget; links and form submissions navigate nowhere, and every rendered link's `href` is `about:blank#`, so
    the browser's own link actions (copy, open in a new tab, drag) carry no guest URL (open external URLs through
    a method you `expose()`); the watchdog stops a looping guest on every
    browser; the view's `violation` reports (`source: 'view'`) are complete up to the cap, which counts each
    directive apart, and cannot be forged; the view renders no `blob:` content but registered files and raster-image
    guest writes, decoded only (the worker's own source URL is revoked once its script ran).
*   **Animations and autoplay (`allowAnimations`, `allowAutoplay`)**: **while `allowAnimations` is `true` (an
    opt-in), CSS animations and transitions in the view run on your page's main thread wherever the browser runs the
    view there (Firefox, Safari and WebKit, Android, Chromium without sandboxed-iframe isolation; desktop Chromium 127+
    isolates it), and the view's time budget does not bound them: a guest can keep your page 80–98% busy for as long as
    they run.** Left out, or `false`, the default, removes animations and transitions from the view (elements show their end
    state), which keeps the bound on every browser. `allowAutoplay` is `false` by default: media in the view plays only when the user
    starts it. [API.md](docs/API.md#allowanimations-and-allowautoplay)
*   **What it does not**: [below](#what-strict-mode-does-not-cover), with the host page's availability first.
*   **Programming model**: no inline `<script>`, nested frames or the elements listed in API.md as unavailable (popovers,
    invoker commands, `canvas`, SVG `use`/filters/`image`) in rendered markup; files are named by path in
    `src`/`href`/`poster` (not `srcset` or inline styles; a registered stylesheet's own `url()` works), and
    JavaScript files reach only the worker; no modules or `importScripts`; `unsafeCapabilities` and
    `origins.scripts` are dropped, with a warning if configured. `autoResize` and `fetchBridge` work.

Why it is built this way: [ADR-005](docs/ADR-005-strict-mode.md).

## Backlog

Open work — broken scaffolding, security follow-ups, planned capabilities — is tracked in
[`docs/BACKLOG.md`](docs/BACKLOG.md). Whether to continue this project rather than adopt an
existing solution is argued in [`docs/ADR-001-continue-or-adopt.md`](docs/ADR-001-continue-or-adopt.md).

## Security Mitigations

What the sandbox defends, against whom, and what it leaves to the embedder and the browser, property by property with
the code and the test behind each: [the threat model](docs/THREAT-MODEL.md). To report a vulnerability, see [SECURITY.md](SECURITY.md). The sandbox implements several layers of
defense:
1.  **Opaque Origin**: Runs in `about:srcdoc`, creating a unique null origin that isolates storage.
2.  **Strict CSP, from a typed config**: One fixed template per mode, every directive emitted (`'none'` when it admits nothing), so no browser falls back to `default-src`. The embedder adds only exact origins, per kind of load (`origins`), parsed by the same origin parser as `fetchBridge.allow`; everything else is dropped with a warning, so no value can add a directive or a source expression: no `'self'` (browsers disagree on what it matches for the guest's opaque origin; WebKit admitted any https origin), no `data:`, no wildcard or scheme. Frames that load a URL are refused (`frame-src 'none'`; frames the guest makes from markup, `srcdoc` or `about:blank`, still exist in cooperative mode and are realms of their own: see the [limits](#cooperative-mode-limits) below); `base-uri`, `form-action`, `object-src` and `manifest-src` are `'none'`; `'unsafe-eval'` comes only from `scriptUnsafe`. ([ADR-007](docs/ADR-007-typed-origins.md))
3.  **CSP First**: The CSP `<meta>` is prepended before any user markup, so it is always the first element of the parsed `<head>`; user content cannot precede or swallow it.
4.  **Wrapper Frame**: The guest frame is nested in a library-owned frame whose policy is `frame-src 'none'`. That blocks the guest from navigating itself to carry data out in a URL ([research 14](docs/research/14_self_navigation/README.md)).
5.  **One Channel, Announced by the Bootstrap**: The guest bootstrap's first statement makes the private `MessageChannel`, keeps one end in its closure and posts the other to the host page; the host accepts exactly one such announcement per environment, from the guest frame's own window, and ends the environment on a second (a guest that reloads or rewrites itself). No listener in the guest realm ever carries a port of the library's, and guest code can never reach the bootstrap's end (it uses only primitives captured before guest code runs), so it cannot answer the watchdog for a looping guest. The host hears only the current environment's port. If the wrapper frame ever loads a second document, the sandbox is torn down and fires `terminated`.
6.  **Worker Inside the Frame**: Worker mode spawns its worker from inside the sandbox frame, so it shares the opaque origin and CSP. The worker keeps only allowlisted globals (`src/lib/worker-globals.ts`, worker and strict mode): it requests only through `fetch`, `XMLHttpRequest` and `WebSocket`, which are the library's request gate in every mode, and (worker mode) `importScripts`, each governed by the policy on every engine (Firefox sent a worker's `EventSource` and loaded its `FontFace` past the policy), and has no nested workers.
7.  **Capability Tiers**: Flags that reach outside the frame require the explicit `unsafeCapabilities` opt-in.
8.  **Allowlisted Calls**: Each side can call only the methods the other side exposed, and an answer reaches only the frame that made the request, never a frame that replaced it.
9.  **Realm-Bound Files**: Registered files reach the guest as `blob:` URLs created in its own realm, which no other sandbox and not the host page can load. Lookups are exact, `blob:` is allowed only for the registered types, and a reference names a file only for the kind of load its type is for (a text file is never a script).
10. **No WebRTC in the Guest**: The bootstrap removes `RTCPeerConnection` from the guest's global scope before guest code runs (workers never have it), since no CSP directive governs ICE traffic. A frame the guest creates is a realm of its own and keeps it, and its ICE traffic leaves the sandbox ([backlog S13](docs/BACKLOG.md)); strict mode closes this.
11. **Host URL Hidden**: The guest's base URL is `about:blank` and both frames use the `no-referrer` policy, so the guest cannot read the host page's URL, and relative URLs in guest markup resolve to nothing unless they name a registered file (use absolute URLs or `sandboxFiles` otherwise). Platform limits: Chromium and WebKit show the host origin in `location.ancestorOrigins`; Firefox and WebKit send it as `Referer` on image requests if the guest asks for a referrer, and WebKit sends the full host URL to a same-site origin ([backlog S18](docs/BACKLOG.md)); WebKit shows a frame the guest creates the host page URL without its fragment ([backlog S17](docs/BACKLOG.md)). Strict mode closes S17 and S18.
12. **Mediated Network, Opt-In**: With `fetchBridge`, the host decides the guest's requests, to exact listed origins only, without credentials, referrer or redirects, with capped bodies, time and concurrency, and logs each one; a hidden frame of the library's with an opaque origin makes them, so the host page's Service Worker and `fetch` wrappers never apply, and the target sees `Origin: null`. The guest policy stays as strict as configured ([ADR-006](docs/ADR-006-fetch-bridge.md)).
13. **Strict Mode, the Default**: Guest code only in a worker; a view whose one script is the library's, admitted by its hash, with rendered markup cleaned before it is inserted and moved, never cloned ([ADR-005](docs/ADR-005-strict-mode.md)).
14. **Fail Closed on Configuration**: A `mode` the element does not know starts no environment (the sandbox terminates with a reason) rather than falling back to the default (`'iframe'`, renamed `'cooperative'`, is refused like any unknown mode).
15. **Guest-Realm Hardening (cooperative and worker mode)**: Gaps no CSP directive covers are closed in the guest's realm before guest code runs: `fetch()` with `keepalive` is refused (Firefox sends it past `connect-src`); `history.back()`, `forward()`, `go()` and the Navigation API's traversal do nothing (Firefox and WebKit let them move the host page); `window.name` is inert (a named guest frame received the host's named navigations and `window.open()` handles); DNS prefetching is off; no worker loads from `data:` (WebKit runs a `data:` SharedWorker outside the policy). [Broad review](docs/archive/reviews/BROAD-REVIEW-2026-10-14.md). This list is frozen: a new gap in cooperative mode is a [limit](#cooperative-mode-limits), not a new patch.

## Limits

One list, the same in [API.md](docs/API.md#modes) and the [backlog](docs/BACKLOG.md#s44--cooperative-mode-limits-one-frozen-list--documented-limits).

### What strict mode does not cover

What remains for the default:

*   **The host page's availability**: strict mode protects confidentiality and egress. It does not protect the host
    page's availability wherever the view shares the host page's thread: Firefox, Safari and every WebKit browser,
    Android WebView, and Chromium without sandboxed-iframe isolation (the headless shell). There the view's cost
    is one stated bound, [API.md, "The view's cost to the host page"](docs/API.md#the-views-cost-to-the-host-page),
    measured on every engine by `test/e2e/view-bound.spec.ts`: on average at most 20% of the thread for the view's own
    work, plus at most 20 points for the browser's work on the loads it makes; at most one stall past 2 s per 5 minutes
    beyond the first (the second operation past 2 s within 5 minutes ends the sandbox), each that operation's own
    cost, which nothing can interrupt; the rates and caps that bound the rest;
    and a closed list of what is outside it: animations and transitions while `allowAnimations` is `true` (an opt-in),
    animated images, indeterminate `<progress>` and autoplaying media, relayout after image decodes and font swaps, the
    documented single-operation stalls (CSS filters, bidirectional text, small CSS changes over many elements,
    Chromium's `<img>`, WebKit's 250 000-character textarea), memory, `:hover` restyles while the user's pointer moves,
    and Firefox's cost of unhandled rejections.

    One gap is open in the bounds above, backlogged and not mitigated now (owner, 2026-10-21): on
    desktop Chromium one documented stall over about 5 s ends the sandbox ([S79](docs/BACKLOG.md#s79)), and because all the
    sandboxed frames of the page can share the view's process, one sandbox's loop or stall can end another's view too
    ([research 16](docs/research/16_view_isolation/README.md)). `terminate()` ends
    such a flood, after the reports already queued are processed.

    Cooperative mode is no better: there a guest `while (true) {}` freezes the host page wherever the frame shares its
    thread.
*   **CSS within what the policy allows**: style-based probing of the view's own content, and loads from the origins
    you allow.
*   **Worker `violation` reports** (`source: 'logic'`): the request gate's are the same on every engine; the browser's own
    worker reports (a redirect it refuses) are per engine (WebKit raises none in workers); all are influenced by guest
    code. The view's reports are complete and unforgeable up to the cap.
*   **A worker that closes itself** is noticed only by the watchdog; **memory** is not bounded.
*   **Cookies**: `fetch()` and `XMLHttpRequest` send none, on any engine. The sandbox's frame is credentialless, which
    only some engines honour, for the rest: a WebSocket handshake (a listed `wss://` server must check `Origin`) and the
    loads of rendered markup and CSS. Every mode drops an `origins`
    entry on the host page's site from every kind, with a warning. The site is the browser's registrable domain of the
    page's host (`example.com` for `app.example.com`), so a sibling subdomain is on it. A loopback, private or link-local
    host is kept, with a warning, only when the host page is itself on one, and dropped otherwise. Use the fetch bridge for
    an API that knows the user: it sends no credentials. What the engines would send ([the table](docs/API.md#cookies-by-engine)):

<!-- generated:begin cookie-sentence -->
`fetch()` and `XMLHttpRequest` of the sandbox carry no cookie in any engine: the library sends them without credentials. A request it cannot strip (a WebSocket handshake, or a load of the guest's markup or CSS) to an origin on the host page's site carries these cookies: Chromium: none (the sandbox's frame is credentialless); Firefox: `SameSite=None` (none with Total Cookie Protection, Firefox's default); WebKit: `SameSite=None, Lax and Strict`. To an origin on another site it carries that site's own cookies: Chromium: none; Firefox: `SameSite=None` (none with Total Cookie Protection, Firefox's default); WebKit: `SameSite=None` (none with Safari, which blocks third-party cookies; not measured). The fetch bridge sends none in any engine.
<!-- generated:end -->

### Cooperative-mode limits

Cooperative mode is for cooperative content. Its limits are a frozen list: the library adds no new guest-realm
patches there, and a new finding in cooperative mode is added here as a limit. None of them applies in strict mode,
the default. Measured per engine and asserted by tests; worker mode shares the reporting item, and nothing else here.

*   **Same-thread execution**: where the browser runs the guest frame on the host page's thread (WebKit always,
    Chromium in some environments), a guest loop freezes the host page and no watchdog can stop it.
*   **A frame the guest creates** (from markup: `srcdoc`, `about:blank`) is a realm of its own, with the platform's
    WebRTC (its ICE leaves), `fetch` (Firefox sends its `keepalive` past `connect-src`), history traversal (moves the
    host page in Firefox and WebKit) and naming (do not use named targets on a host page that embeds sandboxes); in
    WebKit it reads the host page URL as its referrer. `frame-src 'none'` refuses only frames that load a URL.
*   **A worker the guest creates** (from the guest document or a frame it creates): in Firefox its `EventSource` and
    `FontFace` pass the policy.
*   **WebKit's preconnect**: `<link rel=preconnect>` opens a connection to any origin.
*   **Focus and the clipboard**: guest code takes focus from the host page (Chromium, Firefox) and, in a user's click,
    writes the clipboard (`writeText()` in Firefox and, in the click's own handler, WebKit; `execCommand('copy')` in
    Chromium and Firefox).
*   **Messages**: the guest can post to the host window; check `event.source`.
*   **The user's link actions**: Ctrl-, Shift- or middle-click, or Ctrl/Shift+Enter, on a guest link opens a new tab at
    the guest's URL in Chromium and Firefox, without `allow-popups`. So does a modifier click the guest's own script
    synthesizes: in Chromium with no user gesture (where its popup blocker lets it), in Firefox within a user's
    activation; on a submit button (with `allow-forms`, an unsafe capability) Chromium opens the submission in a new
    tab past `form-action`.
*   **Trusted Types**: under a host page's `require-trusted-types-for 'script'` the guest inherits the requirement, so
    its own scripts, the import map and the markup the bootstrap writes for registered files need Trusted Types too
    (strict mode renders as usual: its view assigns through its own policy; in every mode `execute()` is refused). A browser
    without Trusted Types applies a page's requirement only from `hostContentSecurityPolicy`
    ([API.md](docs/API.md#trusted-types-without-the-browser)).
*   **Session history**: the guest's fragment navigations add entries to the tab's history (the back button walks
    them first), and in Chromium so does a navigation the wrapper refuses.
*   **Guest-only stalls**: a guest that never finishes its document stays `ready`, and its calls time out; Firefox
    replaces a guest's `<meta refresh>` with a document that announces nothing. The watchdog ends either where it
    is on.
*   **Forgeable reports**: every `violation` report comes from the guest's realm, so guest code can forge or suppress
    it; a frame the guest creates reports to itself (worker mode: per engine, as in strict mode's worker).
*   **The host page's URL and origin**: the pre-policy window of a `<meta>` policy over guest markup; the host origin
    in `ancestorOrigins` and, when the guest asks, in image `Referer` (Firefox, WebKit); WebKit's full host URL to
    same-site origins when the guest asks. Strict mode's view holds no guest markup when its policy arrives, and no
    guest request carries a `Referer`.

Each guarantee above names its code and the test that keeps it closed in [THREAT-MODEL.md](docs/THREAT-MODEL.md). The adversarial reviews of the design are kept in [the archive](docs/archive/README.md): [adversarial review report](docs/archive/reviews/ADVERSARIAL-REVIEW-2026-10.md), [focused review](docs/archive/reviews/FOCUSED-REVIEW-2026-10-14.md), [broad review](docs/archive/reviews/BROAD-REVIEW-2026-10-14.md), [independent verification](docs/archive/reviews/VERIFICATION-2026-10-14.md).
