# Web Sandbox

A secure, local-first sandbox implementation using `iframe srcdoc`, Opaque Origins, and Immutable CSP.

## Overview

Web Sandbox provides a mechanism to run untrusted JavaScript code safely in the browser without requiring a backend for isolation. It leverages the browser's own security primitives (Opaque Origins, CSP) to create a secure environment.

**Key Features:**
*   **Local-First:** No server round-trips for code execution.
*   **Secure:** Blocks access to `localStorage`, `Service Workers`, and the parent window.
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

*   **Presets:** Select a scenario from the dropdown to load pre-configured code and security rules. These presets match the automated test cases in `docs/research/`.
*   **Code Editor:** Modify the JavaScript code to test different behaviors.
*   **Rules Editor:** Configure the Content Security Policy (CSP) and execution mode (iframe/worker).
*   **Logs:** View `console.log` output and security events from within the sandbox.

## Architecture

*   **`src/host.ts`**: The core implementation of the `<web-sandbox>` custom element. It handles frame creation, CSP generation, and communication.
*   **`src/lib/frame-documents.ts`**: Builds the wrapper and guest documents (see Security Mitigations).
*   **`src/lib/rpc.ts`**: The broker behind `expose()` and `call()`; the host and the guest run the same code.
*   **`src/lib/files.ts`**, **`src/lib/in-sandbox-files.ts`**: Registered files: the host's store, and the guest's `sandboxFiles`.
*   **`src/lib/markup-references.ts`**: Resolves guest markup references (`<script src="app.js">`) to registered files before the guest is built.
*   **`src/lib/module-specifiers.ts`**, **`src/lib/import-map.ts`**: The module graph: relative imports in registered modules rewritten to virtual URLs (with the bundled es-module-lexer), and the guest's own import maps merged into the one the bootstrap registers.
*   **`src/lib/presets.ts`**: A shared library of test scenarios used by both the Playground and automated tests.
*   **`vite.config.ts`**: The dev server for the playground and the e2e harness.
*   **`test/e2e`**: Playwright e2e specs, plus the shared harness page and fixture every suite runs on.
*   **`docs/research`**: Security findings, each with a Playwright reproduction that guards its mitigation.

## Usage

```js
import { defineWebSandbox } from 'web-sandbox';   // or './src/index.ts' from a checkout

defineWebSandbox();                 // registers <web-sandbox>; pass a name to use your own tag
const sandbox = document.querySelector('web-sandbox');
sandbox.setConfig({ capabilities: ['allow-scripts'] });
sandbox.load('<h1>Hello</h1>');
```

Importing the module registers nothing, so you choose the tag name.

## Lifecycle

`sandbox.state` tells where the sandbox is: `idle` (not in the document), `loading` (a frame is
being built), `ready` (the guest can be reached) or `terminated`. There is no "running" state:
`execute()` does not report when guest code finishes.

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
    leaves it `idle`. Inserting it again builds a fresh one.
*   **Events** are dispatched on the element. `sandbox-log` (guest `console` output and errors) bubbles,
    so a listener on `window` hears every sandbox on the page and `event.target` says which one.
*   **`violation`** reports a load the guest policy refused: `{ directive, blockedURI }`, plus
    `sourceFile`, `lineNumber` and `columnNumber` when the browser gives them. It bubbles like
    `sandbox-log`. The guest's bootstrap listens before any guest code runs, but every field comes from
    the guest and guest code can suppress its own reports, so an event is evidence that the guest tried
    something; no event proves nothing. A frame the guest creates reports to itself, not here, and in
    worker mode it depends on the engine (WebKit raises none in workers; Firefox none for
    `importScripts`). At most 100 per environment (`VIOLATION_EVENT_LIMIT`); type `SandboxViolation`.
*   **`state === 'terminated'` is a second, authoritative signal** next to a call's `TERMINATED`
    code: the element sets both from its own state, so the guest can produce neither.

**Watchdog** (opt-in): with `watchdogTimeout: ms`, the host checks that the guest's event loop keeps
answering and terminates a guest that falls silent for that long (reason: `the guest stopped
responding (watchdog)`). It works in worker mode on every browser, and in iframe mode where the browser
runs the sandboxed frame in its own process. That is the browser's choice, not the page's: Chromium
often does, but not in every environment, and Safari does not. Where the frame shares the host
page's thread, a guest stuck in a loop freezes the host page too, and no watchdog can run until it
stops; the watchdog then only guarantees that the host's own stall is never blamed on the guest. It is off by default because a guest doing long synchronous work on
purpose would be stopped as well. It checks liveness only; `terminate()` is how the host stops a
guest at will.

```js
sandbox.setConfig({ capabilities: ['allow-scripts'], watchdogTimeout: 2000 });
```

Why it is built this way: [ADR-003](docs/ADR-003-lifecycle-and-liveness.md).

## Capabilities

`capabilities` takes the sandbox flags that keep the guest inside the frame: `allow-scripts`,
`allow-forms`, `allow-pointer-lock`, `allow-orientation-lock`.

Capabilities that let the guest act outside the frame — `allow-popups`, `allow-modals`,
`allow-downloads`, `allow-presentation` and `fullscreen` — are dropped from `capabilities` with a
warning. If you really need one, pass it in `unsafeCapabilities`; the sandbox logs a warning for each
one enabled. A popup, for example, is a new top-level window that no CSP governs, so its URL is an
exfiltration channel ([research 13](docs/research/13_popup_exfiltration/README.md)).

```js
sandbox.setConfig({
    capabilities: ['allow-scripts'],
    unsafeCapabilities: ['allow-popups', 'fullscreen'], // explicit opt-in, warns
});
```

`fullscreen` is not a sandbox flag but a Permissions Policy feature: it is set as `allow="fullscreen *"`
(plus the legacy `allowfullscreen`) on both the wrapper and the guest frame, since a feature reaches the
guest only if every frame on the way delegates it. The `*` is needed because a sandboxed `srcdoc` frame
has a fresh opaque origin that the default allowlist never matches. The risk is UI spoofing — a fullscreen guest can draw a fake browser window — which
browsers soften by requiring a user gesture and showing an exit hint.

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
sandbox.setConfig({ capabilities: ['allow-scripts'] });
sandbox.expose('ping', () => 'pong');                       // host method, callable by the guest

sandbox.load(`<script>
    bridge.expose('sum', (a, b) => a + b);                  // guest method, callable by the host
    bridge.call('ping').then(reply => console.log(reply));  // logs "pong"
</script>`);

const total = await sandbox.call('sum', 1, 2);              // 3, once the sandbox is ready
```

*   **Only exposed methods can be called.** Any other name, built-in ones like `toString` or
    `__proto__` included, rejects with `unknown method`. Exposing a name again replaces its handler.
*   **Values are copied, not shared.** Arguments and results are copied the way `structuredClone`
    copies, so they must be cloneable data; a function or a DOM node fails that one call at once.
*   **Treat a handler's arguments as untrusted input.** They are plain data, but the other side
    chose them: validate before use, and copy objects with spread (`{ ...arg }`) rather than
    `Object.assign`, which turns an own `__proto__` key into a prototype change.
*   **Every call times out** after 30 seconds by default. `callWithTimeout(ms, method, ...args)`
    sets a different limit for one call; `0` turns it off.
*   **Host methods belong to the element**, so they survive `reset()`, `load()` and `setConfig()`. Guest
    methods belong to one frame: a new frame starts with none until its own code exposes them.
*   **A reset settles every pending call.** When `reset()`, `load()` or `setConfig()` recreates the
    frame, the element is removed, or the sandbox is terminated, pending calls reject; calls made
    after termination reject at once.
*   **Every rejection has a `code`; branch on it, not on the message.** `TIMEOUT`, `TERMINATED`,
    `ARGS_NOT_TRANSFERABLE`, `SEND_FAILED` and `INVALID_CALL` are set only by the side that made the
    call, so the other side can never produce them. `UNKNOWN_METHOD`, `HANDLER_ERROR` and
    `RESULT_NOT_TRANSFERABLE` come from the other side, and their message is its text. Only `TIMEOUT`
    is worth retrying, and `TERMINATED` only after the next `ready` event (types: `RpcErrorCode`, `RpcError`).
*   **No `scriptUnsafe` needed.** `call()` runs a function the other side registered and never
    evaluates code. A worker-mode guest has no markup, though, so it can only expose methods
    through `execute()`, which does need `scriptUnsafe`.

Why it is built this way: [ADR-002](docs/ADR-002-host-guest-broker.md).

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
sandbox.load(`
    <script type="module" src="app.js"></script>             <!-- markup names files by path -->
    <img src="logo.png">
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
    `application/octet-stream`). The policy gains `blob:` only for the registered types' directives, and
    a directive you set to `'none'` (or `[]`) stays `'none'`, with a warning.
*   **Markup references just work** (iframe mode, when the bootstrap runs: `allow-scripts` and the
    default inline `script-src`): `<script src>` (classic or
    module), stylesheet, icon and preload `<link href>`, and `src` of `img`, `source`, `video`,
    `audio`, `track` plus `video[poster]`, when the URL resolves to a registered path — `app.js`,
    `./app.js`, `/app.js`, `img/logo.svg`. Scripts keep their order (`defer`, `async`, modules and
    `document.currentScript` behave as if served). Anything else — an unregistered path, another case,
    a query or fragment (`logo.svg?v=2`) — stays as written and fails closed: it loads nothing and
    sends no request. The matched attribute reads as the `blob:` URL.
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
*   **Not yet**: `srcset`, `url()` in CSS, and references inside `<template>`. Use `sandboxFiles.url()`
    for those.

Why it is built this way: [ADR-004](docs/ADR-004-files-as-blob-urls.md).

## Backlog

Open work — broken scaffolding, security follow-ups, planned capabilities — is tracked in
[`docs/BACKLOG.md`](docs/BACKLOG.md). Whether to continue this project rather than adopt an
existing solution is argued in [`docs/ADR-001-continue-or-adopt.md`](docs/ADR-001-continue-or-adopt.md).

## Security Mitigations

The sandbox implements several layers of defense:
1.  **Opaque Origin**: Runs in `about:srcdoc`, creating a unique null origin that isolates storage.
2.  **Strict CSP**: Generated per-session, blocking all external connections (except allowed) and nested iframes (`frame-src 'none'`). An empty array means `'none'` for every directive; leave a directive out to fall back to `default-src`. The guest policy never contains `'self'`: for the guest's opaque origin, browsers disagree on what it matches (WebKit admits any https origin), so a configured `'self'` is dropped with a warning. List the origins you need explicitly. `frame-ancestors`, `report-uri`, `report-to` and `sandbox` are dropped with a warning too: browsers ignore them in a `<meta>` policy, which the guest's always is.
3.  **CSP First**: The CSP `<meta>` is prepended before any user markup, so it is always the first element of the parsed `<head>`; user content cannot precede or swallow it.
4.  **Wrapper Frame**: The guest frame is nested in a library-owned frame whose policy is `frame-src 'none'`. That blocks the guest from navigating itself to carry data out in a URL ([research 14](docs/research/14_self_navigation/README.md)).
5.  **One-Shot Channel**: The private `MessagePort` is handed over exactly once per frame. If the frame ever loads a second document, the sandbox is torn down and fires `terminated`.
6.  **Worker Inside the Frame**: Worker mode spawns its worker from inside the sandbox frame, so it shares the opaque origin and CSP.
7.  **Capability Tiers**: Flags that reach outside the frame require the explicit `unsafeCapabilities` opt-in.
8.  **Allowlisted Calls**: Each side can call only the methods the other side exposed, and an answer reaches only the frame that made the request, never a frame that replaced it.
9.  **Realm-Bound Files**: Registered files reach the guest as `blob:` URLs created in its own realm, which no other sandbox and not the host page can load. Lookups are exact, and `blob:` is allowed only for the registered types.
10. **No WebRTC in the Guest**: The bootstrap removes `RTCPeerConnection` from the guest's global scope before guest code runs (workers never have it), since no CSP directive governs ICE traffic. A frame the guest creates is a realm of its own and keeps it, and in Chromium and WebKit its ICE traffic leaves the sandbox ([backlog S13](docs/BACKLOG.md)).
11. **Host URL Hidden**: The guest's base URL is `about:blank` and both frames use the `no-referrer` policy, so the guest cannot read the host page's URL, and relative URLs in guest markup resolve to nothing unless they name a registered file (use absolute URLs or `sandboxFiles` otherwise). Platform limits: Chromium and WebKit show the host origin in `location.ancestorOrigins`; Firefox and WebKit send it as `Referer` on image requests if the guest asks for a referrer; WebKit shows a frame the guest creates the host page URL without its fragment ([backlog S17](docs/BACKLOG.md)).
