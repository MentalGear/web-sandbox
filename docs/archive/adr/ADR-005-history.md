# ADR-005 history

History, not current state: the text of [ADR-005](../../ADR-005-strict-mode.md) that its current decision replaced, verbatim, as it stood at commit 1aed8ad, and the amendments in the order they were made. Where a passage differs from the ADR, the ADR holds. Only the targets of relative links are changed, to resolve from this folder. The generated port table and the INIT_VIEW line of the original decision are left out: they are generated from the code in the ADR.

## The original status line

**Status**: Accepted · **Date**: 2026-10-13 · **Amended**: 2026-10-14 ([adversarial review](#amendment-2026-10-14-adversarial-review); [follow-up audit](#amendment-2026-10-14-follow-up-audit-c1-c4-and-c5-by-construction); [focused review](#amendment-2026-10-14-focused-review-no-attribute-changes-after-the-renderer); [broad review](#amendment-2026-10-14-broad-review-an-allowlist-renderer-and-a-bounded-view); [independent verification](#amendment-2026-10-14-independent-verification-the-workers-globals-are-an-allowlist); [typed origins](#amendment-2026-10-14-typed-origins-the-view-policy-is-a-template)) · 2026-10-15 ([strict is the default](#amendment-2026-10-15-strict-is-the-default-cooperative-modes-limits-are-frozen); [review round 1](#amendment-2026-10-15-review-round-1-the-views-check-in-its-character-budget-host-page-availability); [the owner's decisions](#amendment-2026-10-15-the-owners-decisions-after-review-round-1)) · 2026-10-17 ([the view's running counts and time budget](#amendment-2026-10-17-the-views-running-counts-and-time-budget))

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

## The original decision

**An opt-in mode, `mode: 'strict'`.** Guest code runs only in a dedicated classic worker. The DOM frame — the
*view* — runs exactly one script, the library's bootstrap, admitted by its SHA-256 hash, and shows what the
worker renders.

```
host page
└─ wrapper   unchanged: frame-src 'none', base about:blank, no-referrer (frame-documents.ts)
   └─ view   srcdoc = CSP <meta> + referrer <meta> + ONE <script> (the bootstrap); no guest bytes
      └─ worker  new Worker(blob:) spawned by the view: comms, sandboxFiles, the strict prelude, the entry
```

Three ports per environment, all `MessageChannel`s. Each frame type is declared once, with its route, its fields and
what bounds each, in `src/lib/frames.ts` (`FRAMES`); [ARCHITECTURE.md](../../../ARCHITECTURE.md#channels-and-frames) lists them
all, with the realms named as there (`strict-worker` is the guest's worker). `VIOLATION` is labelled by the port it arrives
on, and the render port is the view's and the worker's alone
([ADR-002 amendment](ADR-002-history.md#amendment-2026-10-13-strict-mode-renders-bypass-the-host)).

The bootstrap accepts exactly one `INIT_VIEW`, from `parent.parent`, in a
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
- **G2 — guest logic is confined to one worker.** Before any guest code the worker keeps only allowlisted globals
  (amendment below), so it has no `Worker` or `SharedWorker` (a nested blob worker would be admitted by
  `worker-src blob:`, P3); the prelude deletes `WebAssembly` unless `scriptUnsafe` (WebKit compiles it without
  `'unsafe-eval'`, P3) and `URL.createObjectURL` (A8 below); a worker never has `RTCPeerConnection` or a document.
  Its location is its own `blob:null/…` URL. It has no `postMessage`, `onmessage` or `onmessageerror` of its own
  either: what it posted reached the view's `Worker` object, on the host page's thread wherever the view shares it,
  outside every budget; the library's ports are its only way out.
- **G3 — the host can always stop the guest.** The watchdog (`watchdogTimeout`) and `workerExecutionTimeout`
  watch the worker, which never shares the host's thread: the S6 bound holds on every engine
  ([ADR-003 amendment](ADR-003-history.md#amendment-2026-10-13-strict-mode-bounds-execution-on-every-engine)).
- **G4 — egress is the policy, and nothing navigates.** The worker inherits the view policy exactly
  (`connect-src` governs it), and requests only through the four globals of its allowlist that the policy governs on
  every engine (amendment below); the view's loads are governed by `img-src`, `style-src`, `font-src`, `media-src`,
  and a URL in rendered markup is kept only where every engine's policy check admits it (its exact origin is listed,
  or it is an image's `http:` URL whose `https:` upgrade is, off a loopback host), else dropped by the renderer before
  the browser sees it and, an `http(s)` one, reported as a violation; the ones it keeps are bounded in number
  (`VIEW_MAX_URLS`), and every load, charged before the browser can start it (a kept URL attribute when it is
  rendered, what applied CSS can load, counted from its text, when it is applied; backlog S73) and otherwise as the
  browser reports it (resource timing, CSS-borne loads included, and violations), per second (`VIEW_URLS_PER_SECOND`)
  and in distinct URLs over the view's life
  (`VIEW_MAX_DISTINCT_URLS`). The renderer's prediction may only err toward refusing, and no bound depends on it.
  No WebRTC is reachable. The view cancels the default of every click on or inside a link (HTML and SVG `a`,
  `area`, anything with an `href`, including fragment links, which resolve against the inherited `about:blank`
  base and so are navigations) and of every submit; `form-action 'none'` and the wrapper's `frame-src 'none'`
  stand behind that, and `<meta http-equiv=refresh>` cannot exist (A1).
- **G5 — nothing guest code can read reveals the host URL.** Guest code runs only in the worker. Every
  request the worker or rendered markup makes carries no `Referer`: the renderer forces
  `referrerpolicy="no-referrer"` and removes `<meta name=referrer>`, which closes S17 and S18 here.
- **G6 — the view's violation reports are complete and unforgeable** (A6, rescoped). No guest code runs in
  the view, and the host labels reports by the port they arrive on, so `source: 'view'` reports are the
  library's own, complete up to `VIOLATION_EVENT_LIMIT` **per directive** (the view and the host count each
  directive the browser names apart, so the guest's refused loads of one kind cannot hide a report of another;
  the buckets are the known directive names plus one, which bounds the view's events). Worker reports
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
- **Files (A8, [ADR-004 amendment](ADR-004-history.md#amendment-strict-mode-2026-10-13)).** The view
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

## The original consequences and residuals

## Consequences

Each guarantee is asserted on all three engines: `test/e2e/strict.spec.ts` (G1 corpus — script, handlers,
SVG script, `javascript:` link, frames at any depth and namespace, the hashed copy, meta refresh, base,
links, noscript, templates — asserted absent; G4 navigation; G2 worker; the entry; A5; files and A8;
configuration, fetch bridge, auto-sizing), `strict-render-flood.spec.ts` (A4),
`webrtc.spec.ts`, `watchdog.spec.ts`, `host-url.spec.ts`, `violations.spec.ts` (section 5),
`strict-events.spec.ts`, `broad-strict.spec.ts`, and the strict cases of `broker`, `lifecycle` and `events.spec.ts`; unit tests in
`src/lib/in-sandbox-view.test.ts`, `src/lib/csp/script-hash.test.ts`, `test/unit/strict.test.ts`.

**What it does not guarantee (residuals):**

- **Rendering cost on the host's thread.** Firefox, WebKit, Android and Chromium without sandboxed-iframe isolation
  run the view on the host page's thread; desktop Chromium 127+ isolates it (amendment 2026-10-18, research 16). So each
  apply is host-thread work there, and so is every CSS animation it leaves running (`allowAnimations`).
  Flow control bounds it to one apply at a time; since the broad review the DOM one apply builds is linear in its
  markup, and since review round 1 the document is bounded in elements, depth and characters, and the markup parsed
  per second is bounded (amendments below), but what laying it out and painting it costs is not: CSS is not read by the
  renderer, and a filter list on many elements costs their product (measured in WebKit: 10 `blur()` functions on
  1 000 elements, 88 KB, stalled the host 3.7 s; 100 on 1 000, over 180 s; backlog S42). Measured for markup
  (Playwright 1.58 builds, 256 Ki characters per render, flood as fast as allowed): host lag ≤ 10 ms in Chromium,
  50–150 ms in Firefox, 90–470 ms in WebKit; 45 000 elements in one render 0.2–0.3 s on all three. The watchdog
  does not count host stalls against the guest; the bound on termination is the budget plus one apply.
  Stated as one bound since 2026-10-19, which supersedes the figures here and in the amendments below: [API.md, "The
  view's cost to the host page"](../../API.md#the-views-cost-to-the-host-page) ([amendment 2026-10-19](#amendment-2026-10-19-the-views-cost-bound-stated-once)).
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

## Amendment (2026-10-14): adversarial review

**When**: the adversarial review of 2026-10 ([report](../../archive/reviews/ADVERSARIAL-REVIEW-2026-10.md), A1, C1–C5).

- **The view policy cannot be widened from a value (A1).** A `;` inside a passed-through value (for example
  `default-src`) used to emit directives ahead of the fixed ones, and the first occurrence of a directive wins:
  measured, a handler attribute ran in the view in all three engines. Every policy now goes through a grammar
  (`src/lib/csp/policy-grammar.ts`): only known directive names, and only tokens that are one CSP source
  expression, so the fixed directives are the only ones of their name.
- **The entry runs in its own scope (C2).** The worker's source is one classic script, and a script's
  declarations are instantiated before any of it runs, so a top-level `function Reflect() {}` in the entry
  replaced a global before the prelude captured it, and a declared `Worker` made the prelude's deletion fail
  silently (measured: `Worker` stayed, as the guest's function). The host now evaluates the entry inside
  `(function () { … }).call(this)`: **its top-level declarations are local** (a visible change: an entry that
  wants a global assigns it, `globalThis.x = …`; `this` is still the global object). An entry that closes that
  function early to declare at the script's top level is refused before the prelude runs: a top-level function
  declaration is the only thing that leaves a non-configurable function on the global object (measured in all
  three engines), and the first step of the prelude checks for one. A name the prelude cannot delete is now an
  error, not a silent pass.
- **The prelude's lists have no prototype (C3).** Its render queue, handlers and subscribed types are
  null-prototype lists, so guest code with a setter (or a Proxy) in `Array.prototype`'s chain sees none of
  them; flow control holds with such a trap installed.
- **A8 is a content guarantee (C1), and it is narrowed here.** The renderer removes attributes that name a
  `blob:` URL the view did not mint; it does not read `<style>` text or CSS escapes in a `style` attribute. What
  holds is: **the view renders no `blob:` content but registered files.** The worker cannot mint URLs, so the
  only other `blob:` URLs it knows are its copies of registered files (registered content, same type; a copy of
  a JavaScript file is refused as a stylesheet by its type) and its own source URL, which resolves in the view
  but renders nothing there (typed `text/javascript`, it begins with the library's prelude: neither a stylesheet
  nor an image or font signature). Revoking the source URL once the worker exists was tried and rejected: in
  WebKit it makes every `blob:` URL the worker minted unreadable (sandboxFiles fails with `NotReadableError`)
  and mutes its error messages.
- **G6 is complete up to the cap, and the cap is shared (C4).** The view's reports include refusals of the
  guest's own rendered markup, so a guest that renders 100 refused loads uses up the view's cap for the
  environment; later view refusals are not reported. Measured in all three engines.
- **G4 covers the page, not the browser's own UI (C5).** Rendered links keep their `href`, and the view cancels
  every click and submit, but a user's own actions through the browser — "open in new tab", dragging a link —
  are not events the page can cancel. That needs the user's action; it is a residual (backlog S24). *Closed by
  the follow-up amendment below: rendered links now carry one inert href.*

Proof: `test/e2e/review-policy.spec.ts`, `test/e2e/review-strict.spec.ts`, the strict cases of
`test/unit/policy-guarantees.test.ts`, `src/lib/in-sandbox-view.test.ts`, `test/unit/strict.test.ts`.

## Amendment (2026-10-14): follow-up audit, C1, C4 and C5 by construction

**When**: the by-construction audit of the review's fixes ([report](../../archive/reviews/ADVERSARIAL-REVIEW-2026-10.md#follow-up-2026-10-14-by-construction-audit)).

- **C1: the worker's source URL is revoked once its script ran.** The view revokes it on the first message the
  worker sends on the render port (`VIEW_STARTED`, which the prelude posts when it takes `INIT_WORKER`, so only
  after the whole worker script ran; guest code cannot post on that port). From then on the URL resolves nowhere,
  so the only `blob:` URLs rendered CSS could name are the worker's copies of registered files: the narrowed A8
  guarantee, **the view renders no `blob:` content but registered files**, holds by construction instead of by
  the source's type and prefix. *Widened 2026-10-15 (the owner's decisions, below): and raster-image guest writes,
  decoded only.* The earlier attempt revoked when the Worker object existed, before WebKit had read
  the script, and broke `sandboxFiles` there. At this point, measured on all three engines: `sandboxFiles`
  (`url`, `read`, `text`), fetches of the worker's own `blob:` URLs, Blob reads and `execute()` keep working. One
  WebKit effect was found and is handled: inside the worker, a later uncaught error thrown by code from the revoked
  script reads `Script error.` (no error object), while the Worker object in the view still gets its text. So the
  prelude logs the later errors it can describe and leaves a muted one to the view, which logs it as the same
  `Uncaught …` guest line (`GUEST_UNCAUGHT` on the view port). The view tells the entry's own errors (which end the
  sandbox) from later ones without trusting the order of two channels (*superseded 2026-10-19, S75: the prediction
  below was wrong for WebKit; the end of the entry is now a marker error, in the order of the errors themselves*): before `VIEW_STARTED` only the entry's can
  arrive (a later describable one is cancelled in the worker, a muted one needs the revocation, which follows
  `VIEW_STARTED`), and `VIEW_STARTED` carries how many of the Worker object's errors were the entry's (errors on
  one Worker object arrive in the order they were raised). Executed code's late errors, muted in WebKit's worker
  before this change too, now keep their text as well.
- **C4: the view's violations are counted per directive.** G6 above. The logic port and the default modes keep
  one count, since guest code writes the directive name there.
- **C5: rendered links are inert (backlog S24, option B, approved by the owner).** G4 covered the page, not the
  browser's own UI: "copy link address", "open in new tab", hover and dragging a link need no page event, so the
  view could not cancel them, and they carried the guest's URL. The renderer now replaces the value of every
  href that makes a hyperlink (HTML `a` and `area`, SVG `a` with `href` and `xlink:href`, any MathML element)
  with one constant, `INERT_HREF = 'about:blank#'`, before insertion; no option turns it off. The guest's URL is
  discarded; the worker never had it (event details carry ids), so routing is unchanged, and an embedder who wants
  links that leave the sandbox exposes a host method (`openExternal(url)`) that the worker calls on click.
  The constant was measured on all three engines against `#`, `""`, `about:blank`, `about:invalid`,
  `javascript:void(0)` and `data:,` (href property as copied, drag data, what a new top-level navigation loads):
  `about:blank#` is absolute, so it means the same in any document; every engine reports it unchanged as the
  link's URL and its drag data; and opening it loads the empty `about:blank`, no request. `#` resolves to the same
  only through the view's inherited `about:blank` base; `""` fails to resolve only because that base has an opaque
  path, and then differs per engine (no drag in Chromium, an empty one in Firefox and WebKit); `about:invalid`
  and `javascript:` differ per engine; `data:,` opens a document. **Why not remove `href` or rewrite the element
  to a `span`**: an `a` without `href` is not a hyperlink, so it would leave the tab order, lose the role `link`
  for assistive technology and stop matching `:link`/`:any-link`, which the guest's own styles select on; with
  the constant all three hold (asserted), and clicks and Enter are still cancelled and delivered by id.

Refuted alternatives, kept here so they are not tried again: a `data:` URL for the worker (WebKit then cannot
read the worker's own `blob:` URLs, `NotReadableError`, and Chromium mutes the errors of a large `data:` worker);
the entry as a second script loaded with `importScripts(blob:)` (it is checked against `script-src-elem`, and
admitting `blob:` there would admit `<script src=blob:>` in the view). Proof: `test/e2e/review-strict.spec.ts`
("C1", "C4"), `src/lib/in-sandbox-view.test.ts`, `test/unit/followup-guarantees.test.ts` ("C4").

## Amendment (2026-10-14): focused review, no attribute changes after the renderer

**When**: the focused review of 2026-10-14 ([report](../../archive/reviews/FOCUSED-REVIEW-2026-10-14.md), F1). **Why**: the renderer checks attributes once,
before insertion, so its guarantees hold only if no attribute changes afterwards. In the view no script runs and
CSS cannot set an attribute, but SVG animation (SMIL) can: a `<set>` or `<animate>` inside a rendered link animated
its `href` back to the guest's URL after the renderer had made it `about:blank#` (getAttribute and `baseVal` kept the
constant; `animVal` and Chromium's accessibility tree had the guest URL, in all three engines), and one inside an
`<image>` loaded a URL the renderer never saw (Chromium, Firefox).

**Decision**: the renderer removes every SVG animation element with its subtree, compared case-insensitively:
`animate`, `set`, `animateMotion`, `animateTransform`, `animateColor`, `discard` and SVG Tiny's `animation` (`mpath`
only names a path for `animateMotion` and goes with it). That closes every attribute the renderer checks at once —
link hrefs, file references, the `blob:` rule — and any it may check later, rather than one attribute at a time.
Tests: `test/e2e/focused-review.spec.ts` ("F1": `animVal` and Chromium's accessibility URLs read from outside, the
recorder for an animated image), `src/lib/in-sandbox-view.test.ts`, `src/lib/load-kinds.test.ts` (the renderer reads
the load-kind table, ADR-004).

## Amendment (2026-10-14): broad review, an allowlist renderer and a bounded view

**When**: the broad review of 2026-10-14, reviewer C ([report](../../archive/reviews/BROAD-REVIEW-2026-10-14.md), ST1–ST4, I1).
**Why**: the renderer was a list of what to remove, so every mechanism a document has that the list did not name
was open: F1 (SMIL) and ST2 (SVG `<use>`) both came from there. And three bounds held per item but not for the whole:
the files the view shows (ST1), the size of what one render builds (ST2), and the size of one event (ST3).

- **The renderer is an allowlist** (`RENDER_ELEMENTS`, `RENDER_ATTRIBUTES`, `src/lib/in-sandbox-view.ts`; the lists
  and what guests lose are in [API.md](../../API.md#sandboxview-strict-mode)). Per namespace: HTML flow, phrasing,
  sectioning, lists, tables, forms and their controls, details, dialog, media, `style` and the minted `link`; SVG
  shapes, text, structure, gradients, clip paths, masks, patterns; MathML Core presentation elements. Attributes: the
  global ones, `data-*`, `aria-*`, and per element what it needs; never a handler, a form target, an invoker, or a
  URL attribute other than `src`, `srcset`, `poster` and the minted `link` `href`, which keep only `https:`, `http:`,
  a URL the view minted or a relative one (no `data:`, no `javascript:`). **Unknown HTML elements are unwrapped**:
  their children take their place and are checked in turn, so obsolete or unknown wrappers (`center`, `font`,
  `marquee`) keep their text; nothing is serialised or reparsed, so unwrapping cannot change what a child is. The
  elements that hold raw text, a template or a browsing context (`script`, `noscript`, `template`, `iframe`, …)
  and **every SVG or MathML element outside the list are removed with their content** (an unknown SVG element
  renders nothing anyway; `annotation-xml` can hold HTML). A hyphenated custom element name is kept: no script can
  define it in the view, so it is an inert element. Move-not-clone (A2) and the captured primitives hold: the walk
  reads and changes nodes only through prototype getters and methods captured when it starts.
  *Beyond the review's list, by measurement*: `marker` is out like `use` (markers instance their content per
  vertex and nest: 1.4 KB stalled the host 2.9–16.6 s), SVG filter primitives are out (their cost is what their
  parameters say, not what the markup weighs: one 150-character `feMorphology` stalled WebKit 6.4 s), and SVG
  `image` is out (the HTML `img` covers it, under the same rules). Masks, clip paths and patterns nested the same way
  were measured flat (≤ 0.3 s at 10^5 references) and stay, without `href` templates.
- **ST1: nothing the view shows opens as a document.** A user can open a shown image or video in a new tab, a
  navigation the view cannot cancel; a registered SVG opened that way ran its script top-level, outside the policy
  (Chromium, Firefox). The view now mints URLs only for `VIEW_FILE_TYPES`, types that are never a document (CSS,
  raster images, fonts, audio, video, WebVTT), through its own load-kind table derived from load-kinds.ts
  (`VIEW_LOAD_KINDS`, no prefixes: `+xml` types fall under `image/` and `video/` too). Every other file stays the
  worker's (`sandboxFiles`), and the policy adds `blob:` for it only to `connect-src`. And `data:` is dropped from the
  directive that governs images (one warning): no documented use needed it, and the renderer keeps no `data:` URL in
  markup either. What remains: an image from an origin the embedder allowed opens as that origin's document.
- **ST2: the corrected bound.** No element instances referenced content any more, and the view's body holds at most
  `VIEW_MAX_ELEMENTS` (50 000) elements nested at most `VIEW_MAX_DEPTH` (256) deep, counted over the document a
  render would leave (renders accumulate across targets): past either, the render is refused before insertion,
  still acknowledged, and the worker logs why. So **the DOM an apply builds is linear in its markup and the document
  is bounded**; measured after: the 1–1.4 KB fan-outs stall the host ≤ 41 ms (before: 6.1–11.9 s for `use`,
  2.9–16.6 s for markers), 45 000 elements 0.2–0.3 s. Paint cost set by CSS is not bounded (residual above, S42).
- **ST3**: one event detail carries at most `VIEW_EVENT_LIMITS.maxTotal` (256 Ki) characters in all, and
  `truncated: true` when anything was cut (before: 30 fields carried 1.8 M characters).
- **ST4**: the trailer's marker is named per build (`entryDoneName()`, 128 random bits); an entry that closes its
  scope and declares a `let` of the old fixed name had taken it over. C2's check catches escaped functions only;
  escaped lexical declarations are in their dead zone while the prelude runs and cannot name the marker.
- **I1**: the renderer's `<link>` kinds are load-kinds.ts's, as data (`linkRelKinds`), and a unit test holds them
  equal to `linkKinds()` for every `rel`/`as` combination.

Tests: `test/e2e/broad-strict.spec.ts` (all three engines: the allowlist corpus and its positive control, ST1 opened
URLs and `data:`, ST2 fan-out with host lag and the budgets, ST3, ST4); `src/lib/in-sandbox-view.test.ts`
(allowlist property over 300 random corpora, unwrap, URLs, budgets, event budget); `src/lib/load-kinds.test.ts`;
`test/unit/strict.test.ts`. Existing specs that relied on what is gone now probe the same guarantee another way:
the policy's `script-src-attr` with a handler set from outside (`review-policy.spec.ts`, A1), C4's second
directive with a refused audio load, F1's positive control with an HTML image, and the files specs with PNG.

## Amendment (2026-10-14): independent verification, the worker's globals are an allowlist

**When**: the independent verification of 2026-10-14 ([report](../../archive/reviews/VERIFICATION-2026-10-14.md), V1, V2). **Why**: G4
said egress is the policy, and it held for every network API the probes had tried; it did not for one they had not.
In Firefox (146), `new EventSource(url)` from the strict worker reached an origin `connect-src` blocks, and
`new FontFace(name, 'url(…)')` one `font-src` blocks, with no violation; `fetch`, `XMLHttpRequest`, `WebSocket` and
`importScripts` from the same worker were refused, and so was the document's EventSource (re-measured on a plain page
with a header policy: the same; an upstream bug). Worker mode's worker the same. The prelude was a denylist (`Worker`,
`SharedWorker`, `WebAssembly`), so one engine's gap in one API was a gap in the sandbox.

**Decision (G4 amended)**: the worker keeps only an allowlist of globals. Its first statement, in strict mode and in
worker mode (`keepOnlyWorkerGlobals`, `src/lib/worker-globals.ts`), deletes every name off `WORKER_GLOBALS` from the
global object and from its scope prototypes (where the engines keep `fetch`, `fonts`, `caches`, `importScripts`, …),
and every member off `WORKER_NAVIGATOR_MEMBERS` from the navigator's prototype, before the library's scripts and any
guest code. Four listed globals can make a request — `fetch`, `XMLHttpRequest`, `WebSocket` (`connect-src`) and
`importScripts` (`script-src`) — each measured as governed on all three engines; the rest of the list makes none (the
language, timers, events, encoding, streams, crypto, blobs and URLs, IndexedDB, OffscreenCanvas, WebCodecs). So G4
reads: **the worker requests only through APIs the policy governs on every engine, and any other platform API,
present or future, is absent.** A listed name added later must be measured the same way first. A name off the list
that cannot be deleted stops the worker before the channel exists (fails closed); WebIDL constants, primitives, are
left. Worker mode thereby loses nested workers, as strict mode had: a nested worker is a realm the prelude never
reaches.

**Residual**: in iframe mode the guest can still create a worker of its own, and in Firefox its EventSource and
FontFace pass (the S13 class: a realm of its own). Strict mode and worker mode have none.

**V2, the entry's first log lines**: the comms script installed its console relay when the logic port was attached,
which in strict mode is after the entry's top level ran, so those lines were lost. The relay is now installed while
the bootstrap runs and buffers up to 1000 lines (in order with bridge frames) until the port exists.

Tests: `test/e2e/verification.spec.ts` ("V1": every worker global on the list, every network API of every engine
aimed at a blocked listener, the four kept ones reaching an allowed one; "V2"), `src/lib/worker-globals.test.ts`,
`src/lib/in-sandbox-script.test.ts`.

## Amendment (2026-10-14): typed origins: the view policy is a template

**When**: [ADR-007](../../ADR-007-typed-origins.md). The view's policy is no longer the config's subset passed through and
fixed afterwards (`strict-policy.ts`, `strictPolicyOverrides`, both deleted): it is the generator's strict template,
with every directive explicit, and the embedder's `origins` fill `style-src`, `img-src`, `font-src`, `media-src` and
`connect-src` only:

```
default-src 'none'; script-src 'sha256-<B>' ['unsafe-eval']; script-src-attr 'none'; style-src 'unsafe-inline' …;
img-src …; font-src …; media-src …; connect-src …; worker-src blob:; frame-src 'none'; object-src 'none';
base-uri 'none'; form-action 'none'; manifest-src 'none'; upgrade-insecure-requests
```

`origins.scripts` does not type-check in strict mode (`StrictSandboxConfig`) and is dropped with one warning at run
time. `data:` is not an origin, so it reaches no image (ST1) and no font or media either. Tests:
`src/lib/csp/csp-generator.test.ts`, `test/unit/strict.test.ts`, `test/unit/policy-guarantees.test.ts` ("A1"),
`test/e2e/review-policy.spec.ts`, `test/e2e/broad-strict.spec.ts` ("ST1").

## Amendment (2026-10-15): strict is the default; cooperative mode's limits are frozen

**When**: after the [independent verification](../../archive/reviews/VERIFICATION-2026-10-14.md#decisions-after-the-verification)
(decision 2) and typed origins ([ADR-007](../../ADR-007-typed-origins.md)); backlog S48. **Why**: every review since this
ADR found its new issues in the mode where guest script runs in a document, and every one was the S6/S13 class: a
realm the library does not reach, or a platform behaviour no policy governs. Each fix was a guest-realm patch, and the
next finding was another. Strict mode closes that class by construction, so it should be what an embedder gets
without asking.

**Decision**:

- **`mode: 'strict'` is the default** (`DEFAULT_SANDBOX_CONFIG`). A config without `mode` is a strict config, in the
  types too (`StrictSandboxConfig.mode` is optional; `CooperativeSandboxConfig.mode` is required), and `origins` is
  parsed for the mode the build will have, so a config that names no mode drops `scripts`. A default element with only
  `html` renders the cleaned html in the view and runs no guest script: without an `entry` the worker runs only the
  prelude.
- **The modes are `'strict' | 'cooperative' | 'worker'`.** The document mode is `'cooperative'`: it is for cooperative
  content. `'iframe'` is removed, not aliased (nothing is published): it fails closed like any unknown mode (A4), and
  the reason and the one warning say `('iframe' was renamed 'cooperative')`.
- **Markup written for cooperative mode is said to run nothing.** When a strict build's `html` holds a script element
  or an `on…` handler attribute, the element warns once: ``strict mode (the default) runs no script in `html`; name a
  registered file in `entry`, or choose `mode: 'cooperative'`.`` It reads the markup with the host's `DOMParser`,
  which runs and loads nothing (`src/lib/markup-scripts.ts`), and never changes what is rendered: the renderer drops
  both, as before.
- **Cooperative mode's limits are a frozen list.** No new guest-realm patch is made in cooperative mode; a new finding
  there is documented as a limit (README "Cooperative-mode limits", the same in API.md and backlog S44). The list: the
  same-thread execution budget (S6); the pre-policy window over guest markup (S8); frames the guest creates (S13: WebRTC;
  S35: Firefox keepalive, history traversal, naming) and workers it creates (Firefox `EventSource`, `FontFace`); the host
  URL in WebKit's created frames (S17) and to same-site origins (S18), with S15's platform limits; WebKit's preconnect;
  focus, clipboard, messages to the host window, modifier-click tabs and session history (S36, V3, H1); forgeable
  violation reports; guest-only stalls of the CB3 class (a document that never finishes, Firefox's silent
  `<meta refresh>`). The hardening already in the guest realm (S35) stays.
- **Worker mode is frozen as it is.** It duplicates strict mode without a view; folding it into strict mode with
  `entry` is backlog S49.
- **S42 is accepted.** The view renders on the host page's thread in Firefox and WebKit (and in Chromium where it
  shares the page's process), and CSS paint cost is not bounded: a filter list on many elements stalls WebKit's host
  thread for seconds. In WebKit, strict mode protects confidentiality and egress, not the host page's availability.
  Cooperative mode is no better there: a guest `while (true) {}` already freezes WebKit's host page. Revisit with
  ADR-005's "Revisit if" (an out-of-process view).

What remains for the default, the strict list: S42 (above), CSS within the policy, worker violation reports per engine
and guest-influenced, a worker that closes itself, memory, and same-site cookies on requests to allowed origins (every
mode).

Tests: `test/unit/strict-default.test.ts` (the default builds the view, `origins` parsed for it, the types, detection
with no false positives on text, comments, raw text, attribute values or `data-on…`, one warning per element),
`test/unit/policy-guarantees.test.ts` (A4, the rename), `test/unit/presets.test.ts`, `test/unit/api-docs.test.ts`;
`test/e2e/strict-default.spec.ts` on all three engines (the never-configured element and a default mount are views
whose one script is the hashed bootstrap; a `<script>` and an `on…` handler in `html` run in no document and warn
once, while the same html in cooperative mode runs: positive control; `'iframe'` terminates with the rename; the
playground opens in strict mode). Every existing preset and spec names the mode it was written for (the e2e baseline
config is cooperative), so the attack regressions keep testing that mode.

## Amendment (2026-10-15): review round 1, the view's check-in, its character budget, host-page availability

**When**: [review round 1](../../archive/reviews/REVIEW-ROUND-1-2026-10-15.md) (R1-1, R1-2, R2-1 = R3-1, R1's availability
measurements); backlog S50–S52.

**Decision**:

- **`ready` is the view's check-in.** The view's bootstrap posts `VIEW_READY` as the first frame on the view port, which
  only it holds; the host enters `ready` on it, never on the wrapper's load alone. Before, a strict build was `ready` on
  the load, also when the view's bootstrap never ran (refused by the host page's `script-src`, which a `srcdoc`
  document inherits), and 5 s later "the sandbox view stopped responding". A build whose frame loaded but whose
  bootstrap never checked in ends with a reason that names the host page's policy; a worker the host page's policy
  refuses ends with its own reason (a probe worker tells it from Firefox's message-less syntax error). The view's two
  HTML and script sinks go through one Trusted Types policy (`web-sandbox`) where the host page requires them
  (API.md, "Host page policy").
- **The view's budget counts characters and work per second.** Besides `VIEW_MAX_ELEMENTS` and `VIEW_MAX_DEPTH`, the
  view's body holds at most `VIEW_MAX_CHARACTERS` (4 × `VIEW_RENDER_MAX_LENGTH`) characters of serialization, counted
  over the document a render would leave and checked after the renderer, before insertion; and the view parses at most
  `VIEW_RENDER_CHARACTERS_PER_SECOND` characters per second, renders it refused included: a render past it waits, and
  flow control holds the worker meanwhile. Text was outside every budget: renders of 261 000 characters of text into
  200 targets every 20 ms kept the host page 95–100% busy on all three engines, and the view held up to 24 M
  characters. Measured after (host ticks of a 10 ms interval, idle / loaded): Chromium 250/239, Firefox 242/229,
  WebKit 208/153; the view holds 1 048 090 characters.
- **The renderer is linear, and keeps no element whose layout is super-linear.** Its walk takes each parent's children
  from the front and appends the kept ones back; removing middle children one by one cost Chromium 13 s for 38 000
  removals. Runs of text are joined into one node (WebKit lays out a word over many text nodes super-linearly), and
  comments are dropped. `wbr` (Firefox: 43 000 in one paragraph, 23 s) and `ruby`, `rt`, `rp` (WebKit: 10 000 rubies,
  10.7 s) are unwrapped; a measured scan of the other listed elements found them linear.
- **Host-page availability is not protected where the view shares the host page's thread.** This replaces S42's
  "in WebKit": strict mode protects confidentiality and egress; the host page's availability is not protected wherever
  the view shares the host's thread (WebKit always; Firefox; Chromium depending on its process model). The budgets
  bound the common cases; what layout and paint cost beyond what the markup weighs is not bounded: CSS filters (S42)
  and bidirectional text in one paragraph (240 000 characters alternating directions: tens of seconds in Chromium and
  WebKit, seconds in Firefox; engine and machine dependent). "Revisit if" stands: an out-of-process view.

Tests: `test/e2e/host-policy.spec.ts` (each host policy on all three engines, with positive controls),
`test/e2e/view-budget.spec.ts` (R1-1, R1-2, measured), `src/lib/in-sandbox-view.test.ts` (R1-2), `test/unit/review-round-1.test.ts`.

## Amendment (2026-10-15): the owner's decisions after review round 1

**When**: [review round 1](../../archive/reviews/REVIEW-ROUND-1-2026-10-15.md), "Awaiting the owner" (R4-4, R4-5, R2-2); backlog S54.

- **The view shows raster-image guest writes (R4-4)**, from URLs it mints itself out of the bytes the host holds,
  decoded only; the rule is one constant, `VIEW_WRITE_TYPES` = `VIEW_FILE_TYPES` ∩ PNG, JPEG, GIF, WebP, AVIF
  ([ADR-004 amendment](ADR-004-history.md#amendment-2026-10-15-the-strict-view-shows-raster-image-guest-writes)).
  A8's guarantee now reads: **the view renders no `blob:` content but registered files and raster-image guest writes,
  decoded only.** The view port carries `VIEW_WRITE` and its answer `VIEW_WRITTEN`.
- **`sandboxView.text(id, text)` and `sandboxView.set(id, { value?, checked?, focus? })` (R4-5).** `text` makes a string
  an element's only content, assigned and never parsed, so a guest escapes nothing; `set` sets an `input`'s,
  `textarea`'s, `select`'s or `output`'s value (not a file input's) or an `input`'s checked state, or focuses the
  element. Both go over the render port (`VIEW_TEXT`, `VIEW_SET`) under A4's flow control, one operation in flight:
  `render` and `text` share one slot per target, and a `set` merges only into a `set` of the same id queued right before
  it, so no operation passes another. The view finds the element as a render's target, drops an id that names nothing
  and acknowledges, and counts what they leave against `VIEW_MAX_CHARACTERS` and the per-second budget (an input's value
  as its `value` attribute, a textarea's and an output's as their text), so text stays inside every budget (R1-1). The
  worker throws `TypeError` for an id that is no element id, an unknown key or a wrong type, `RangeError` past
  `VIEW_RENDER_MAX_LENGTH`.
- **Focus never leaves the host page for the sandbox on the guest's say.** Measured (broad review PD5): a sandboxed
  frame's `focus()` without user activation takes focus from the host page's focused element in Chromium and Firefox
  (Chromium also its keystrokes); WebKit keeps it. So `set({ focus: true })` focuses only while the view's
  `document.hasFocus()`: the user last clicked or tabbed into the sandbox and the window is focused. Otherwise the view
  refuses it (`VIEW_FOCUS` in the ack, a line in the guest's log) and applies the rest of the call; asserted on all three
  engines with a host input that keeps its focus and keystrokes, and the positive control after a user's click in the
  sandbox.
- **`viewScriptHash()` (R4-5)**, exported: the bootstrap's hash source, the very value `viewBootstrapHash()` puts in the
  view's `script-src`, for an embedder's own policy. The wrapper style's hash is a constant and stays documented in
  API.md; it gets no name.
- **`allow-forms` (R2-2)** is an unsafe capability in cooperative and worker mode (`UNSAFE_SANDBOX_FLAGS`). Strict mode
  is unchanged: the view always has `allow-scripts allow-forms` (`STRICT_VIEW_FLAGS`, `src/host.ts`), since `submit` must
  reach the bootstrap to be forwarded and cancelled (P4), no guest script runs in the view, and its forms keep no
  `action`, `formaction`, `method` or `target`. A strict config that lists `allow-forms` in `capabilities` warns nothing.

Tests: `test/unit/view-api.test.ts`, `test/unit/owner-decisions.test.ts`, `test/e2e/owner-decisions.spec.ts`,
`test/e2e/host-policy.spec.ts` (the exported hash admits strict mode under `script-src 'self'`), `test/e2e/package.spec.ts`
(the bundle's hash), `test/e2e/review-round-1.spec.ts` ("R2-2").

## Amendment (2026-10-17): the view's running counts and time budget

**When**: review round 2 (C-4, M-3), recorded at review round 3 (C-5). Its rendering measure was replaced by the gap
meter (amendment 2026-10-18).

- **Running counts.** The view keeps its body's serialized length (`VIEW_MAX_CHARACTERS`) and element count
  (`VIEW_MAX_ELEMENTS`) as running counts, updated from what each operation changes (the target's old and new content,
  a value attribute), not by serializing the whole body per operation. A `MutationObserver` on the body reports any
  change no operation made (the user opening a `<details>`, find-in-page, an extension); the counts are then dropped
  and the next operation counts the whole body again. What an operation serializes is charged to the per-second
  character budget (`VIEW_RENDER_CHARACTERS_PER_SECOND`) on top of its own text.
- **Time budget.** The view spends at most `VIEW_APPLY_MS_PER_SECOND` (200 ms) of its own time per second applying
  operations: each flush is timed with its forced layout, and the rendering update that follows it is charged as
  measured (the time to the next animation frame, past one frame's length). An operation past the budget waits; nothing
  is dropped. It bounds the slow operations the character budget cannot see (a large control's value, layout of many
  elements), on the machine the view runs on, but not a single operation's own cost
  ([Consequences](#consequences)).
- **The guest's error texts.** The view cuts each `GUEST_ERROR` and `GUEST_UNCAUGHT` text to 2048 characters and sends
  at most `LOG_EVENTS_PER_SECOND` of them per second before posting (review round 3, C-4); the host cuts them again.

## Amendment (2026-10-18): where the view runs, `allowAnimations`, `allowAutoplay`, the rendering meter

**When**: review round 3 (C-2, M-5) and [research 16](../../research/16_view_isolation/README.md), measured on headless
Playwright 1.58.1 on a 4-core VM; the owner's decisions on the two options.

**Where the view runs.** The view (a sandboxed `srcdoc` frame in a sandboxed wrapper) runs on the host page's thread
in Firefox (Fission isolates only cross-site frames; an opaque-origin sandboxed frame is placed with the site that
created it, and Playwright's Firefox isolates nothing), in WebKit and Safari (no site isolation), on Android (Chromium
isolates partially; Android WebView has no out-of-process frames) and in the Chromium headless shell. Desktop Chromium
127+ runs it in a process of its own (`IsolateSandboxedIframes`; turning the feature off brings it back). Rendering
always followed script. So the host-thread residual of [Consequences](#consequences) is the rule outside desktop
Chromium, not an engine detail.

**What the time budget does not bound.** The budget bounds what the view does when the guest renders. What runs
without the view doing anything is outside it; with 5 000 animated elements, measured as host busy time against idle
baselines of 1% (Chromium), 4% (Firefox) and 17% (WebKit): CSS animations of any property 81–92% (Firefox 21–89% by
property), transitions 75–87%, scroll-driven animations 47–92%; a pointer moving over `:hover ~` rules 80–100% while
it moves; 2 000 animated PNGs WebKit 39%, Firefox 12%; 20 autoplaying looping videos up to +6 points; 5 000
indeterminate `<progress>` up to +4.

**Decision**:

- **`allowAnimations`** (strict mode, default `true`; a literal `false` turns it off, any other non-boolean is `false`
  with one warning; ignored with a warning in the other modes; part of the equal-config comparison). **While `true`,
  CSS animations and transitions in the view run on the host page's thread wherever the browser runs the view there,
  and the time budget does not bound them: a guest can keep the host page 80–98% busy for as long as they run.** `false`
  removes them, and the bound holds again:
  - a stylesheet of the library's (`VIEW_STILL_STYLE`) becomes the view head's first element at `INIT_VIEW`, before
    anything is rendered: one ANONYMOUS `@layer` with `animation:none!important;transition:none!important` on `*`. Its
    text is constant (so is its hash); the view appends to the layer, through the CSSOM, a rule of its own for each
    pseudo-element of `VIEW_STILL_PSEUDO_ELEMENTS` this engine supports (`CSS.supports('selector(…)')`, or, for a
    `::-webkit-` name, its parser keeping the rule), once guest CSS it is about to apply names it (an escape or an
    `@import` names them all). Every rule costs style work for every element (Chromium: about one more style resolution
    per element each, `::scroll-button(*)` 2.5–8 times a whole replacement), and only a guest stylesheet can give a
    pseudo-element an animation, so a guest pays for the pseudo-elements it names, in its own time budget.
    `::first-letter` and `::first-line` (only typographic properties apply; with them Firefox took 22–30 s to replace
    37 449 elements), the highlight pseudo-elements (only colours and decorations apply), `::column` and the scrollbar
    parts (no animation ran on them, measured) are not listed. A large replacement costs at most twice what it costs
    with animations on (`test/e2e/view-round-5.spec.ts`, "M-1": 0.8–1.4 times measured). A layered `!important` beats every
    later layer's and every unlayered one; the layer is first because renders reach only the body; it is anonymous so
    no guest rule can join it;
  - the renderer takes every `animation*` and `transition*` declaration, prefixed ones included, out of every kept
    `style` attribute, read through the element's own CSSOM declaration and written back as its serialization: an
    inline `!important` beats any layer (without this, the host stayed 90–95% busy). Which attributes are read is
    decided by their text alone: one without `animation`, `transition` or a backslash stays as written, and one with a
    backslash or a declaration of `all` goes whole;
  - the view checks that the sheet is in force (a probe element's inline transition and animation must compute to
    none). A host page whose `style-src` refuses it (neither `'unsafe-inline'` nor its constant hash, API.md "Host page
    policy") gets a view that drops the guest's `<style>` and stylesheet `<link>` elements instead, and one warning
    with the hash.
  Measured on all three engines: back to the idle baseline against unlayered `!important`, the guest's own anonymous
  and named layers, pseudo-elements (form-control parts included), `@starting-style`, hover transitions, scroll-driven
  animations, `@property`, registered stylesheets and their `@import`s, SVG `<style>` and `style`.
- **`allowAutoplay`** (strict mode, default `false`; a literal `true` enables it, any other non-boolean is `false` with
  one warning; ignored with a warning in the other modes; part of the equal-config comparison). While `false` the
  renderer removes `autoplay` from every element (only `<video>` and `<audio>` keep it at all).
- **The rendering meter (C-2, M-5).** The budget charges a flush's own time, its layout forced by hit testing
  (`elementFromPoint`, which WebKit cannot answer without laying out a textarea's text, unlike `offsetHeight`), and the
  rendering update after it, measured as the time from the end of a frame callback to the first task after it: the
  frame the flush ran in, or the next frame for a flush the timer ran. At most one measurement is outstanding, nothing
  is requested without a flush, and no wall time is charged in which no frame ran (a measure across which the
  document's visibility changed is dropped). Every operation is charged all it took, so the budget is a long-run
  average of `VIEW_APPLY_MS_PER_SECOND`, not a bound on each second: a single second can hold more (simulated: 398–553
  ms with operations of at most 200 ms; [research 17](../../research/17_formal_methods/README.md)). One operation, a flush
  and the rendering measured after it, is bounded by `VIEW_MAX_OPERATION_MS` (2 s) and the repeated-overrun rule
  (2026-10-19, the owner's decision; backlog S72, class P): past it the operation is an overrun, charged in full, and
  the view goes on; the second overrun within `VIEW_OVERRUN_WINDOW_MS` (5 minutes) stops the view and ends the sandbox
  (`the view spent more than 2000 ms on one operation twice within 5 minutes`). The single-operation limit as first
  made (2026-10-19, review round 5, M-2) ended the sandbox at the first overrun; the meter measures wall time, so under
  machine load it ended healthy sandboxes (a large initial view on a loaded CI runner; WebKit's first `set()` of a
  250 000-character textarea, always). A debt cap of one second, which this replaces,
  charged an operation of 7.5 s 1.2 s, and it ran again every 12.5 s (53% busy). This replaces the frame callback per flush that charged its
  own age past one frame: hidden 5 s with one render applied meanwhile, the next render waited 18.3 s (C-2, Chromium,
  Firefox `display:none`, WebKit off-screen); and a frame per flush went uncharged, so a flood took 22–25% (M-5). Now:
  the next render applies within 70 ms, and the flood takes 15–23% of the host page's ticks.
- **What measuring costs**: no idle cost and nothing per frame while guest animations play (no frame callback is
  requested without a flush, on all three engines); per flush 30–75 µs of accounting plus the forced layout (0.35–0.46
  ms for a one-paragraph change, layout the rendering update would otherwise do), host busy time unchanged within noise
  ([research 16](../../research/16_view_isolation/README.md#what-measuring-the-budget-costs)).

**Rejected: a meter and an actuator** (measure the host's load, pause what animates). Pausing animations one by one
(`getAnimations().forEach(a => a.pause())`) made it worse (Chromium reached 100% with a 9.7 s frame). A freeze stylesheet
switched on by the meter held Chromium and Firefox only while the view was visible, held WebKit at 49–66% against a
37% target, and was blind to off-screen views in Firefox and to hidden or off-screen views in WebKit. A switch the
embedder sets, in force from the first render, has neither problem.

**Not removed by the switch** (residuals, README "What strict mode does not cover"): `:hover` restyles over many
elements while the user's pointer moves (one operation's cost, driven by the user), animated images, indeterminate
`<progress>`, and autoplaying media with `allowAutoplay: true`.

Tests: `test/e2e/view-switches.spec.ts` (every vector, the host's ticks with 5 000 animated elements and 300 animated
form-control parts, the host page's `style-src`, autoplay), `test/e2e/view-budget.spec.ts` (C-2 hidden and off-screen,
M-5), `test/unit/view-switches.test.ts`, `test/unit/review-round-3.test.ts` (C-2 and M-5), `test/unit/api-docs.test.ts`.

## Amendment (2026-10-19): the view's cost bound, stated once

**When**: backlog S68, after review round 5 and [research 18](../../research/18_finding_classes/README.md) (about 31% of the
medium-or-higher findings of rounds 1–5 come from the view sharing the host page's thread, which no library design
removes: research 16).

**Decision**: the view's cost to the thread it runs on is one statement, in
[API.md, "The view's cost to the host page"](../../API.md#the-views-cost-to-the-host-page), per engine and process placement:
(a) the long-run bound, `VIEW_APPLY_MS_PER_SECOND` of the view's own time plus the browser's work on at most
`VIEW_URLS_PER_SECOND` loads; (b) at most one operation past `VIEW_MAX_OPERATION_MS` per `VIEW_OVERRUN_WINDOW_MS` beyond the
first (the second within the window ends the sandbox; S72), each that operation's own cost, which is not interruptible; (c) the rates and caps that bound what the meter cannot see; and (d) a
closed list of what is outside it, each item with its measured magnitude. The residuals of
[Consequences](#consequences) and the amendments above (2026-10-15 "host-page availability", 2026-10-17, 2026-10-18)
record how each part came to be; where their figures differ from the statement, the statement holds. README's limits
link it instead of restating it. A cost of the view outside both the bound and its list is a finding.

Tests: `test/e2e/view-bound.spec.ts` (the canonical floods against (a), and (b), on every engine;
`WEB_SANDBOX_SOAK=1` for longer windows and the (d) measurements), `test/unit/view-bound.test.ts` (every constant the
statement names exists and has its value).

## Amendment (2026-10-19): the end of the entry, read from the order of one channel

**When**: backlog S75, PR #47's CI (`review-round-1.spec.ts`, "strict mode: a later uncaught error and an unhandled
rejection …", WebKit: `terminated` with "the guest entry failed to start").

**What was wrong** (class B, a browser decision re-derived). The follow-up amendment of 2026-10-14 (C1) told the entry's
own errors from later ones by `VIEW_STARTED`, on the render port, on the prediction that an error which reaches the
view's Worker object before it can only be the entry's: a later error the worker can describe is cancelled there, and a
muted one "needs the revocation, which follows `VIEW_STARTED`". WebKit refutes the second half. It mutes, inside the
worker, the errors of code compiled from a string (`Function`, `eval`, so every `execute()`) from the start, before any
revocation, and leaves their text to the Worker object; and its render-port messages can arrive after a later error on
the Worker object. Measured before the fix: `execute()`'s `setTimeout(() => { throw … })` ended the sandbox 2–3 runs in
100–200 on a loaded machine; an entry's `queueMicrotask` of compiled code that throws, 8 runs in 8; a timer of it, 5 in 8.

**Decision**: the end of the entry is read from the order of the Worker object's errors alone, which arrive in the order
they were raised. The line after the entry raises the build's marker error (its message is the per-build marker name,
`entryDoneName`, which the view gets in `INIT_VIEW`), through `reportError` so that it is raised before any microtask the
entry queued (Firefox and WebKit report an error thrown at the end of a script only after them). The prelude stops it, so
no listener of the guest's sees it, and leaves it uncancelled; the view cancels it and posts nothing, and looks for it
only until it came, in the first characters of the text. Every error before
it is the entry's; every error after it is later. An entry that threw never reaches the marker, so its errors all end the
sandbox, as before. `VIEW_STARTED` now only triggers the revocation and carries no count. A guest that reads the marker's
name and raises its text itself can only spare its own failing entry the end it would have had (as calling the marker
early could, ST4); it cannot make a later error end the sandbox.

Tests: `test/unit/entry-end-marker.test.ts` (every place `VIEW_STARTED` can arrive among the errors, both engines' marker
texts; the prelude raises the marker at once and stops it), `test/e2e/strict.spec.ts` ("the entry": errors of a
microtask and of compiled code the entry queued, on every engine; failed on WebKit before), `test/e2e/review-round-1.spec.ts`.
