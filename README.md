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
    bun run typecheck   # app + service worker
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
*   **`src/lib/presets.ts`**: A shared library of test scenarios used by both the Playground and automated tests.
*   **`vite.config.ts`**: The dev server, which also serves the virtual files hub on `virtual-files.*` hosts.
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

Importing the module registers nothing, so you choose the tag name. The element fires `ready` when
the sandbox is up and `terminated` if it had to be torn down.

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
*   **Every call times out** after 30 seconds by default. `callWithTimeout(ms, method, ...args)`
    sets a different limit for one call; `0` turns it off.
*   **Host methods belong to the element**, so they survive `load()` and `setConfig()`. Guest
    methods belong to one frame: a new frame starts with none until its own code exposes them.
*   **A reset settles every pending call.** When `load()` or `setConfig()` recreates the frame, or
    the sandbox is terminated, pending calls reject; calls made after termination reject at once.
*   **No `scriptUnsafe` needed.** `call()` runs a function the other side registered and never
    evaluates code. A worker-mode guest has no markup, though, so it can only expose methods
    through `execute()`, which does need `scriptUnsafe`.

Why it is built this way: [ADR-002](docs/ADR-002-host-guest-broker.md).

## Backlog

Open work — broken scaffolding, security follow-ups, planned capabilities — is tracked in
[`docs/BACKLOG.md`](docs/BACKLOG.md). Whether to continue this project rather than adopt an
existing solution is argued in [`docs/ADR-001-continue-or-adopt.md`](docs/ADR-001-continue-or-adopt.md).

## Security Mitigations

The sandbox implements several layers of defense:
1.  **Opaque Origin**: Runs in `about:srcdoc`, creating a unique null origin that isolates storage.
2.  **Strict CSP**: Generated per-session, blocking all external connections (except allowed) and nested iframes (`frame-src 'none'`). An empty `base-uri` or `form-action` means `'none'`, since those directives have no `default-src` fallback.
3.  **CSP First**: The CSP `<meta>` is prepended before any user markup, so it is always the first element of the parsed `<head>`; user content cannot precede or swallow it.
4.  **Wrapper Frame**: The guest frame is nested in a library-owned frame whose policy is `frame-src 'none'`. That blocks the guest from navigating itself to carry data out in a URL ([research 14](docs/research/14_self_navigation/README.md)).
5.  **One-Shot Channel**: The private `MessagePort` is handed over exactly once per frame. If the frame ever loads a second document, the sandbox is torn down and fires `terminated`.
6.  **Worker Inside the Frame**: Worker mode spawns its worker from inside the sandbox frame, so it shares the opaque origin and CSP.
7.  **Capability Tiers**: Flags that reach outside the frame require the explicit `unsafeCapabilities` opt-in.
8.  **Allowlisted Calls**: Each side can call only the methods the other side exposed, and an answer reaches only the frame that made the request, never a frame that replaced it.
