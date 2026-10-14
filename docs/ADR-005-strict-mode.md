# ADR-005: Strict mode — guest logic in a worker, a view that runs no guest script

**Status**: Accepted · **Date**: 2026-10-13

## Why this ADR exists

Three guarantees could not be made to hold in the default iframe mode, each for the same structural reason:
guest script runs in a DOM document.

| Item | Default-mode limit |
| :--- | :--- |
| S6 · execution budget | where the browser runs the sandboxed frame on the host page's thread (WebKit always, Chromium in some environments), a guest loop blocks the host's timers too, so no watchdog can stop it |
| S13 · WebRTC | the bootstrap removes `RTCPeerConnection` from the guest's realm, but a frame the guest creates is a realm of its own, runs its own script under the inherited `'unsafe-inline'`, and its ICE traffic leaves in Chromium and WebKit |
| S17 · host URL in WebKit | a frame the guest creates reads the host page URL (path and query) as `document.referrer` in WebKit |

Research 15 then found a fourth one, filed as S18: in WebKit a guest that asks for `unsafe-url` sends the host
page's full URL as `Referer` to any allowed origin that is same-site with the host page (S15 had measured
cross-site targets only).

None of these has a single chokepoint in default mode: frames can be created through `innerHTML`,
`document.write`, `setHTMLUnsafe`, the parser, closed declarative shadow roots and `javascript:` URLs, and a
same-thread loop is a platform limit (S13's and S6's own notes). The structural answer, proposed in S6, is to
take guest script out of every document.

## Decision

**An opt-in mode, `mode: 'strict'`.** Guest code runs only in a dedicated classic worker. The DOM frame — the
*view* — runs exactly one script, the library's bootstrap, admitted by its SHA-256 hash, and shows what the
worker renders.

```
host page
└─ wrapper   unchanged: frame-src 'none', base about:blank, no-referrer (frame-documents.ts)
   └─ view   srcdoc = CSP <meta> + referrer <meta> + ONE <script> (the bootstrap); no guest bytes
      └─ worker  new Worker(blob:) spawned by the view: comms, sandboxFiles, the strict prelude, the entry
```

Three ports per environment, all `MessageChannel`s:

| Port | Ends | Carries |
| :--- | :--- | :--- |
| logic | host ↔ worker | RPC (`call`/`expose`), `LOG`, `PING`/`PONG`, `VIOLATION` (labelled `logic`), `EXECUTE` — as in worker mode |
| view | host ↔ view | `VIOLATION` (labelled `view`), `RESIZE`, `GUEST_ERROR`, `VIEW_PING`/`VIEW_PONG` |
| render | view ↔ worker | `VIEW_RENDER`, `VIEW_ACK`, `VIEW_LISTEN`, `VIEW_EVENT` — the host is not on this path ([ADR-002 amendment](ADR-002-host-guest-broker.md#amendment-2026-10-13-strict-mode-renders-bypass-the-host)) |

On the wrapper's one `load`, the host posts `INIT_VIEW { workerSource, viewFiles, html, autoResize }` to the
view with the logic and view ports. The bootstrap accepts exactly one `INIT_VIEW`, from `parent.parent`, in a
capture listener that stops it there; it creates the render port, spawns the worker from a `blob:` URL
(`worker-src blob:`; worker scripts are checked against `worker-src`, not the script hashes, so the hashed
text stays constant) and hands the worker the logic and render ports.

### The guarantees, on Chromium, Firefox and WebKit

- **G1 — no guest script runs in any document.** The view's policy is
  `script-src 'sha256-<bootstrap>'` with `script-src-attr 'none'`: no inline script, handler or `javascript:`
  URL can run there. Rendered markup is parsed into an inert `<template>`, cleaned by the renderer, then
  **moved** into the document — never cloned or imported (A2: a cloned SVG `<script>` is fresh and runs,
  P6). The renderer **removes** every nested browsing context and document-level control before insertion
  (A1): `iframe`, `frame`, `frameset`, `object`, `embed`, `portal`, `fencedframe`, `script` (HTML and SVG),
  `meta`, `base`, `noscript`, nested `template`, and `link` unless it is a stylesheet or icon naming a file the
  view minted. So no frame exists below the view at all, and a copy of the bootstrap can never run (a copy that
  ran a second time in the view would also return at once).
- **G2 — guest logic is confined to one worker.** Before any guest code the worker prelude deletes `Worker`
  and `SharedWorker` (a nested blob worker would be admitted by `worker-src blob:`, P3), `WebAssembly` unless
  `scriptUnsafe` (WebKit compiles it without `'unsafe-eval'`, P3) and `URL.createObjectURL` (A8 below); a
  worker never has `RTCPeerConnection` or a document. Its location is its own `blob:null/…` URL.
- **G3 — the host can always stop the guest.** The watchdog (`watchdogTimeout`) and `workerExecutionTimeout`
  watch the worker, which never shares the host's thread: the S6 bound holds on every engine
  ([ADR-003 amendment](ADR-003-lifecycle-and-liveness.md#amendment-2026-10-13-strict-mode-bounds-execution-on-every-engine)).
- **G4 — egress is the policy, and nothing navigates.** The worker inherits the view policy exactly
  (`connect-src` governs it); the view's loads are governed by `img-src`, `style-src`, `font-src`, `media-src`.
  No WebRTC is reachable. The view cancels the default of every click on or inside a link (HTML and SVG `a`,
  `area`, anything with an `href`, including fragment links, which resolve against the inherited `about:blank`
  base and so are navigations) and of every submit; `form-action 'none'` and the wrapper's `frame-src 'none'`
  stand behind that, and `<meta http-equiv=refresh>` cannot exist (A1).
- **G5 — nothing guest code can read reveals the host URL.** Guest code runs only in the worker. Every
  request the worker or rendered markup makes carries no `Referer`: the renderer forces
  `referrerpolicy="no-referrer"` and removes `<meta name=referrer>`, which closes S17 and S18 here.
- **G6 — the view's violation reports are complete and unforgeable** (A6, rescoped). No guest code runs in
  the view, and the host labels reports by the port they arrive on, so `source: 'view'` reports are the
  library's own, complete up to `VIOLATION_EVENT_LIMIT`, which is counted per port. Worker reports
  (`source: 'logic'`) are forgeable like any default-mode report and per engine (below).

### API

```js
sandbox.registerFiles({ 'main.js': `sandboxView.render('<button id="go">Go</button>');
    sandboxView.on('click', 'go', (e) => sandboxView.render('<p>clicked ' + e.target.id + '</p>'));` });
sandbox.setConfig({ mode: 'strict', entry: 'main.js' });
```

- `mode: 'strict'`, `entry` (a registered JavaScript path; the worker runs it first, as a classic script);
  `html` / `load()` is the initial view; `execute()` runs in the worker (needs `scriptUnsafe`); `call()` and
  `expose()` talk to the worker's `bridge`; `watchdogTimeout` and `workerExecutionTimeout` watch the worker.
- In the worker, `sandboxView.render(html, into?)` replaces the view's body, or the children of the element
  whose id is `into`; at most 256 Ki characters; latest wins per target. `sandboxView.on(type, id | null,
  handler)` returns `off`: `click`, `input`, `change`, `submit`, `keydown`, trusted only, with a detail of
  `{ type, ids, target: { tag, id, name, value, checked }, key?, form? }` — never a URL.
- An entry that fails to start (a syntax error, or a throw at its top level) ends the sandbox with
  `the guest entry failed to start`; a later uncaught error is logged and does not. An entry that is not a
  registered JavaScript file ends the build with a reason.
- `violation` events carry `source: 'view' | 'logic'` in strict mode.

### The view policy

Built by the same pipeline as every guest policy (S7 drop, file sources without `script-src`, S14 drop), then
from an allowlist as the last step (`src/lib/csp/strict-policy.ts`). With the default config:

```
default-src 'none'; script-src 'sha256-<B>'; script-src-attr 'none'; style-src 'unsafe-inline';
base-uri 'none'; form-action 'none'; worker-src blob:; frame-src 'none'; object-src 'none';
upgrade-insecure-requests;
```

plus the embedder's `connect-src`, `img-src`, `font-src`, `media-src`, `manifest-src`, `prefetch-src` (and
`default-src`, `style-src`); `'unsafe-eval'` only with `scriptUnsafe`. Every other directive is fixed or not
emitted, with one warning each when the config asks otherwise; the sandbox flags are `allow-scripts
allow-forms` plus the configured safe capabilities, and `unsafeCapabilities` are dropped with one warning.

**The hash** is computed synchronously on the host (`src/lib/csp/script-hash.ts`) over the UTF-8 of the
bootstrap text, once per page. The text is the stringified library functions, so it differs between the dev
server, the bundle and a consumer's build; hashing at run time always matches what the page serves. The
parser changes CR, CR LF and NUL (P2), so the text is refused if it contains any, or anything that would end
or re-enter the script element (A3).

### Rendering: the renderer, flow control, files

- **Flow control (A4).** `sandboxView.render()` keeps the latest html per target and posts one render at a
  time; the view applies at most one flush per animation frame (a 100 ms timer stands in where frames are
  throttled) and acknowledges it, which releases the next. The render port is taken from the one trusted
  `INIT_WORKER` message by a capture listener registered before guest code, which stops every trusted
  message on the worker's global; every operation on it uses primitives captured then, called through a
  captured `Reflect.apply`. So guest code cannot post on it — patching `MessagePort`, `MessageEvent`,
  `EventTarget` or `Function` prototypes yields only the logic port, as in worker mode.
- **Files (A8, [ADR-004 amendment](ADR-004-files-as-blob-urls.md#amendment-strict-mode-2026-10-13)).** The view
  mints its own `blob:` URLs for the registered files that are not JavaScript; the renderer resolves the
  default mode's reference attributes (minus `<script src>`) against `https://vfs.invalid/index.html`, and
  removes every attribute that holds a `blob:` URL the view did not mint. The worker gets every file through
  `sandboxFiles`. No `blob:` in `script-src`, ever; strict mode is classic only.
- **DOM clobbering.** `Document` and `HTMLFormElement` let named elements override built-ins
  (`<img name="body">` is `document.body`; in `<form><input name="hasAttribute">` the form's `hasAttribute` is
  the input). The bootstrap and the renderer therefore read and change the DOM only through prototype methods
  and getters captured before any markup exists; the link check cancels if anything unexpected throws; and a
  render the renderer refuses is dropped but still acknowledged, so it can neither be half-inserted nor jam the
  flow control. Found in review after the first commit, asserted by a test that fails without it.
- **Liveness (A5).** The host pings the view on the view port, always (5 s budget, host stalls not counted).
  A view that stops answering — Chromium replaces a view whose navigation the wrapper refuses with an error
  page, which ends the worker with it (P4) — ends the sandbox with `the sandbox view stopped responding`.

## Probe findings that shaped it

[Research 15](research/15_strict_mode/README.md) measured the design before it was built (P1–P8); nine
amendments followed:

| Finding | Change |
| :--- | :--- |
| P1: the hash-only policy reaches every frame guest markup creates, but their refusals never reach the view; P4: a `<meta http-equiv=refresh>` from a template navigates, and in Chromium a refused view navigation commits an error page that ends the worker; P8: a nested srcdoc's own `<meta name=referrer>` works | **A1**: no nested frames, no `meta`, `base`, `noscript`, `template`, and only minted stylesheet/icon links; `referrerpolicy="no-referrer"` forced |
| P6: `importNode` of template content makes SVG `<script>` fresh: the hashed copy runs | **A2**: move, never clone; a unit test pins it |
| P2: the browser hashes the parsed text (CR → LF, NUL → U+FFFD) | **A3**: refuse CR and NUL; hash the UTF-8; unit test against `crypto.subtle` over the parsed text |
| P7: one 1 MiB apply blocks WebKit's host thread for 1.2–1.6 s; an unacknowledged burst holds Firefox's worker round trip near 1 s | **A4**: one render in flight with acks, 256 Ki cap, render port closed over |
| P4: Chromium's error page ends view and worker silently | **A5**: link/submit cancellation for every link form, plus a host-side view liveness check |
| P1, P3: created frames report nothing to the view; worker reports go to the worker (Chromium), partly to the view (Firefox, `importScripts`), nowhere (WebKit) | **A6**: G6 scoped to the view; `source: 'logic'` best effort |
| P3: nested blob workers are admitted; WebKit compiles WebAssembly without `'unsafe-eval'` | **A7**: delete `Worker`, `SharedWorker`, `WebAssembly` before guest code |
| P5: a worker-minted `blob:` URL loads in the view; CSP cannot tell whose it is | **A8**: keep only view-minted `blob:` URLs |
| P8: WebKit sends the full host URL to same-site targets when asked | **A9**: S18 filed for default mode; closed here by A1 |

## Alternatives considered

- **The bootstrap in the wrapper, with the view `sandbox=""`.** The view could then run nothing at all, but
  every render would reload a document (no incremental update), events could not be delivered, and the
  wrapper — which has no script today, the basis of S10/S11 — would gain one.
- **A nonce instead of a hash.** A nonce in the `<meta>` content is readable through CSS attribute selectors
  by anything that can style the document; the hash is not a secret.
- **`crypto.subtle.digest`.** Asynchronous: building an environment is synchronous end to end, and the
  lifecycle invariants (ADR-003) rely on it.
- **A build-time constant hash.** The bootstrap is the text of library functions as this page serves them:
  dev server, bundle and a consumer's bundler each produce different text.
- **Rendered frames with a forced `sandbox=""`** (the design before research 15). It stops the hashed copy
  from running (P1), but leaves frames whose refusals are silent, nested `<meta>` referrer choices (P8) and
  meta refresh in nested documents. Removing them all (A1) is simpler and closes every one of those.
- **No flow control, a 1 MiB cap and per-frame coalescing in the view.** P7: every queued message is still
  deserialised on the view's thread, the host's in Firefox and WebKit.
- **Detecting a lost view by `frames[0]` identity.** A `WindowProxy` belongs to the browsing context and
  survives navigation, so it does not change when the view is replaced; the liveness ping does detect it.
- **Module workers, `importScripts`.** Either needs a script source beyond the hash; the entry is appended to
  the worker's source on the host instead.
- **Default mode's own markup parser for rendering (DOMParser on the host).** It would put the host on the
  render path; the view has the document and an inert template parser of its own.

## Consequences

Each guarantee is asserted on all three engines: `test/e2e/strict.spec.ts` (G1 corpus — script, handlers,
SVG script, `javascript:` link, frames at any depth and namespace, the hashed copy, meta refresh, base,
links, noscript, templates — asserted absent; G4 navigation; G2 worker; the entry; A5; files and A8;
configuration, fetch bridge, auto-sizing), `strict-render-flood.spec.ts` (A4),
`webrtc.spec.ts`, `watchdog.spec.ts`, `host-url.spec.ts`, `violations.spec.ts` (section 5),
`strict-events.spec.ts`, and the strict cases of `broker`, `lifecycle` and `events.spec.ts`; unit tests in
`src/lib/in-sandbox-view.test.ts`, `src/lib/csp/script-hash.test.ts`, `test/unit/strict.test.ts`.

**What it does not guarantee (residuals):**

- **Rendering cost on the host's thread.** Firefox and WebKit run the view on the host page's thread, so each
  apply is host-thread work. Flow control bounds it to one apply at a time, but what one apply costs depends
  on the markup. Measured (Playwright 1.58 builds, 256 Ki characters per render, flood as fast as allowed):
  host lag ≤ 10 ms in Chromium (out of process), 50–150 ms in Firefox, 90–470 ms in WebKit; pathological
  markup (20 000 nested elements) about 0.7 s per apply in Firefox and WebKit. The watchdog does not count
  host stalls against the guest; the bound on termination is the budget plus one apply.
- **CSS exfiltration** within the policy (style-based probing of the view's own content, requests to allowed
  origins); the policy governs it.
- **Worker reports** are per engine: WebKit raises no violations in workers, Firefox raises the worker's
  `importScripts` refusals in the view (they arrive as `source: 'view'`).
- **A worker that ends itself** (`close()`) or crashes is detected only by the opt-in watchdog.
- **Memory, timing side channels, UI spoofing** inside the element's box.
- **Programming model.** No inline guest `<script>`, no nested frames, no `srcset`/`style` file references, no
  module graph; UI updates are whole-subtree renders and coarse events.

### Revisit if

- a platform primitive makes created frames governable from their parent (then nested frames could return);
- `ShadowRealm` or a reliable out-of-process view lands in Firefox and WebKit (the host-thread residual);
- a logic tier such as a QuickJS worker is adopted (backlog parity note): the view and render protocol stay.
