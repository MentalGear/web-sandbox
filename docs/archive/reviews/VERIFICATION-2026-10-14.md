# Independent verification, 2026-10-14

**Date**: 2026-10-14 · **Code verified**: `main` at `8421d70` (after the [broad review](BROAD-REVIEW-2026-10-14.md)) ·
**Result**: 1 new finding, high on Firefox, fixed by construction (V1); 1 functional bug fixed (V2); 1 user-action
residual measured and documented (V3), with session history (H1) and the WebKit clipboard measured beside it; 9 test
gaps closed, each with a test that fails under the mutation that had survived; the docs corrected; the strict-mode
design probes run in CI · **Backlog**: [S43–S45](../backlog/BACKLOG-done.md#s43--a-guest-worker-keeps-only-allowlisted-globals---done)
· **Earlier**: [adversarial review](ADVERSARIAL-REVIEW-2026-10.md), [focused review](FOCUSED-REVIEW-2026-10-14.md),
[broad review](BROAD-REVIEW-2026-10-14.md)

## Method

Five independent verifiers, each from the code and the reports, none from the reviewers' notes:

- **mutation efficacy** (two verifiers): 66 mutations of the fixes the reviews claim; a mutation that no test fails
  is a gap;
- **black box**: the published guarantees attacked from guest code and from the user's own actions, per engine;
- **claims and CI**: every count, "failed before" and "skipped because" in the three reports re-run;
- **decisions**: what the owner was told against what the code does.

**Results**: 63 of 66 mutations were caught; the test counts in the reports reproduced; 3 of 3 sampled "failed before"
claims reproduced against their base commits. Then, as in the reviews, every defect was reproduced first as a failing
test — unit where library logic decides, end to end on Chromium, Firefox and WebKit where the browser decides, with
evidence from outside the sandbox (the recorder's listeners, the host page's own state) and a positive control beside
each negative — fixed at the chokepoint that closes its class, and re-run green.

## New findings and their fixes

### <a id="vr-v1"></a>V1 · Firefox: a guest worker's EventSource and FontFace ignore the policy (high on Firefox) — fixed by construction

- **Found** (black box): `new EventSource(url)` from the strict-mode worker and from worker mode's worker reached an
  origin `connect-src` blocks, with no violation, while `fetch`, `XMLHttpRequest`, `WebSocket` and `importScripts` from
  the same worker were refused and an EventSource in the document was refused. Contradicts ADR-005 G4 ("egress is the
  policy") and worker mode's claim that its worker shares the frame's policy.
- **Confirmed and widened** (all network-capable worker globals, measured): Firefox also loads
  `new FontFace(name, 'url(…)')` from a worker past `font-src`. Re-measured on a plain page with a header policy,
  outside the sandbox: the same (Firefox only; Chromium and WebKit refuse both). The other worker APIs were refused on
  every engine or are absent: `fetch` (any mode), `XMLHttpRequest` (sync and async), `WebSocket`, `WebSocketStream`
  (Chromium), `importScripts`, `import()`, `caches`, `navigator.serviceWorker`, `Notification`, `WebTransport` (Firefox;
  UDP, which the recorder cannot see), and a nested `Worker`'s own `fetch` (its `EventSource` passed in Firefox, as
  the outer worker's did).
- **Root cause**: a denylist. The prelude deleted what was known to be dangerous (`Worker`, `SharedWorker`,
  `WebAssembly`); every other worker global stayed, so one engine's gap in one API was a gap in the sandbox.
- **Fix**, by construction (ADR-005 G4 amendment): the worker's first statement, in worker mode and strict mode, keeps
  only the globals of an allowlist (`WORKER_GLOBALS`, `src/lib/worker-globals.ts`) and deletes every other name from the
  global object, its scope prototypes and the navigator's prototype, before the library's own scripts and any guest
  code. Exactly four globals on the list can make a request — `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts` —
  each measured as governed by the policy on all three engines. A name that cannot be deleted fails the worker closed
  (WebIDL constants, primitives, excepted). A platform API that is not listed is absent, whatever it does. Worker mode
  loses nested workers as strict mode had.
- **Residual** (default iframe mode): a worker the guest creates is a realm the library never reaches; in Firefox its
  EventSource and FontFace still pass (asserted per engine). Strict mode and worker mode have no such worker.
- **Evidence**: before, Firefox's blocked listener received `/es?x=1` in worker and strict mode, and the allowlist test
  found dozens of names off the list on every engine; after, nothing reaches the blocked listener from any API on any engine,
  the worker holds only listed names, and `fetch`, `XMLHttpRequest`, `WebSocket` and `importScripts` reach the allowed
  listener (positive controls); an EventSource the policy allows reaches it from the document (control of the
  evidence). Tests: `test/e2e/verification.spec.ts` ("V1", 6 tests × 3 engines), `src/lib/worker-globals.test.ts`.
  Upstream report: [broad review appendix](BROAD-REVIEW-2026-10-14.md#v1--firefox-bugzilla-core--dom-security-security-sensitive).

### <a id="vr-v2"></a>V2 · A strict entry's synchronous console lines were lost — fixed

- **Found** (black box): `console.log` at an entry's top level never arrived as `sandbox-log`; the same line in a
  `setTimeout` did. All three engines.
- **Root cause**: the bootstrap installed its console relay when the port was attached, and in strict mode the entry
  runs before the view hands the worker its ports.
- **Fix**: the relay is installed while the bootstrap runs; a line logged before the port exists waits in the outbox
  (in order with bridge frames, written with the captured `defineProperty`), at most 1 000 of them (the host's
  per-second rate), then one warning says how many were dropped.
- **Evidence**: `verification.spec.ts` ("V2") failed on all three engines before (the synchronous lines missing) and
  passes after; `src/lib/in-sandbox-script.test.ts` (order, bound, warning).

### <a id="vr-v3"></a>V3 · The user's modifier clicks open a guest link in a new tab (default mode) — residual, measured

- **Found** (black box): a Ctrl-, Shift- or middle-click, or Ctrl/Shift+Enter, on a guest `<a href>` (HTML or SVG)
  opens a new top-level tab at the guest's URL in Chromium and Firefox without `allow-popups`; a bare sandboxed iframe
  does the same, so it is platform behaviour. The README said popups are closed without `allow-popups`.
- **Measured**: Chromium and Firefox open the tab and the blocked listener receives the request (no policy governs a
  new top-level context); Playwright's WebKit opens none — not even with `allow-popups`, where a `target=_blank` click
  does open one, so WebKit's "none" is a limit of the measurement, not a refusal shown. Strict mode opens nothing on any
  engine: every rendered link is inert (`about:blank#`).
- **Decision** (owner's direction): no new default-mode guest-realm patch; strict mode is the answer. README and
  API.md corrected; the residual is in the one list. Test: `verification.spec.ts` ("V3", 3 tests × 3 engines).

### Measured beside it

- **H1, session history**: each fragment navigation of the guest adds an entry to the tab's history on every engine
  (the host's back button walks the guest's entries first); a navigation the wrapper refuses adds one in Chromium (its
  error page), none in Firefox and WebKit. The host URL never changes. Residual; `verification.spec.ts` ("H1").
- **Clipboard on WebKit**: `navigator.clipboard.writeText()` called in the click's own handler writes in WebKit too
  (and Firefox; Chromium refuses). The broad review's test called it a moment later, after WebKit's activation had
  lapsed. PD5's test now measures both. Residual, as before.
- **Same-site cookies** (the black-box verifier's observation, not re-measured here): Firefox and WebKit attached the
  host site's cookies to a guest's subresource request to an allowed origin that is same-site with the host page.
  README no longer says "no storage shared" without that qualification.

## Test gaps closed

Each was a mutation that no test failed; each now has a test that fails under it (re-run with the mutation applied).

> Since 2026-10-14 the policy steps described here are replaced by typed `origins` and one policy template per mode ([ADR-007](../../ADR-007-typed-origins.md)); their guarantees hold by construction there.

| Gap | Mutation that survived | Test now | Under the mutation |
| :--- | :--- | :--- | :--- |
| A1, the host's first grammar pass | remove `sanitizeDirectives` before the steps: `script-src: ["'unsafe-inline' 'unsafe-eval'"]` re-admitted eval in iframe and worker mode, `worker-src: ['blob: data:']` data: workers, `default-src: ["https://a.example 'wasm-unsafe-eval'"]` wasm-unsafe-eval in strict mode | `test/unit/verification.test.ts` ("A1", per mode) | fails |
| A1, by construction | — | every later step takes only `PolicyTokens`, the grammar's output type, and checks it at run time (`policyTokens`): a raw config does not compile, and a cast fails the build closed | — |
| C3, the outbox | outbox written by assignment (`list[len] = v`) | `src/lib/in-sandbox-script.test.ts` ("C3, the outbox"): a strict entry's bridge calls and console lines with setters on `Array.prototype` indices (reachable: the entry runs before the port is attached) | fails |
| F5, eval never in default-src | `addEvalSource` writes to the directive that governs eval (default-src) | `test/unit/verification.test.ts` ("F5", a property and per mode) | fails |
| B1 stale | remove `event.source !== guestWindow` from the host's announcement listener | `review-channels.spec.ts` ("B1"), retargeted: a stranger frame announcing ports to the host window is never heard, the guest is | fails on 3 engines |
| CB7, Firefox's foreign prototype | `adoptedCallback` a no-op; teardown through the element's own methods; the prototype not restored | `test/unit/verification.test.ts` ("CB7", 3 tests; the e2e test cannot see it, since `disconnectedCallback` runs first with the prototype intact) | each fails |
| PD7, the playground | remove the playground's `event.source` check | `verification.spec.ts` ("PD7", on the playground page; its own message reloads it: control) | fails on 3 engines |
| WebRTC, Firefox | — (the strict "no UDP" assertion had no control on Firefox: 0 packets from the host page too) | `webrtc.spec.ts` runs Firefox with `media.peerconnection.ice.loopback`: the host-page control sends packets on every engine | — |
| WebKit worker violations | — | `violations.spec.ts` says it: WebKit raises none in workers, a documented limit asserted as such; the recorder is the evidence there | — |
| Heavy unit tests | — (two tests passed 5 s only on an idle machine) | the 300-corpus allowlist property collects and asserts once and states a 30 s bound (CPU-bound jsdom parsing, 1.5 s idle, 9 s measured under load); the element-budget test runs the same code at a 500-element budget (the real 50 000 is the e2e test's) | the unit suite passes 5 of 5 with all cores loaded |

Not tested before and now tested: **L1**, a default-mode guest that tries to outlive `terminate()` or `reset()` with
an interval, a timeout chain, a promise loop and (iframe mode) a nested worker — all stop, in iframe and worker mode;
**L2**, an announcement a frame the guest creates posts to `top` — never accepted, the bridge stays the guest's
(`verification.spec.ts`).

## Docs corrected

- The three reports said the skipped tests "are per-engine measurements that do not apply": 24 of the 27 are the
  strict-mode design probes (research 15), which run only under their own config. They now run in CI
  (`bun run test:probes`, every engine; 24 of 24 pass at this commit).
- README mitigation 2 claimed nested iframes are blocked: `frame-src 'none'` refuses frames that load a URL; frames
  the guest creates from markup (`srcdoc`, `about:blank`) exist and are the residuals' common root.
- BACKLOG B8's "Done" described the `EXECUTED` report that S30 removed.
- The adversarial review's "no residual left open" and its "Chromium kept the wrapper out of process every time"
  (the broad review measured both frames in the host page's process), and the comment in `review-strict.spec.ts`.
- One list of default-mode residuals (since 2026-10-15: the cooperative-mode limits), the same in
  [README](../../../README.md#cooperative-mode-limits), the [backlog](../../BACKLOG.md#s44--cooperative-mode-limits-one-frozen-list--documented-limits)
  and the [broad review](BROAD-REVIEW-2026-10-14.md#residuals-with-rationale).

## Not covered

- Safari: Playwright's WebKit is not Safari; WebKit's modifier-click behaviour in particular is unmeasured.
- DNS: lookups are not observable in this harness (loopback listeners), as before.
- WebTransport's UDP: the recorder listens on TCP; the API is absent from the worker now, and refused by
  `connect-src` in the document (violation reported).

## Results

Commands: `bun run typecheck`; `bunx vitest run` (also 5 times with `yes > /dev/null` on all four cores); `bun run
build`; `scripts/smoke-package.sh`; the full Playwright suite per engine; the changed and new specs with
`--repeat-each 3`; `bun run test:probes`.

| | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| Full e2e at `8421d70` (broad review's count) | 443 passed, 8 skipped | 442 passed, 9 skipped | 441 passed, 10 skipped |
| Full e2e after | 471 passed, 8 skipped, 0 failed | 470 passed, 9 skipped, 0 failed | 469 passed, 10 skipped, 0 failed |
| V1 tests at `8421d70` (6 per engine) | 2 failed (the allowlist) | 4 failed (EventSource in both modes, the allowlist) | 2 failed (the allowlist) |
| V2 before the fix | failed | failed | failed |
| Changed and new specs × 3 (`verification`, `review-channels`, `blob-delivery`, `webrtc`, `violations`, `broad-review`; 97 tests per engine) | 291 passed | 291 passed | 291 passed |
| `bun run test:probes` (research 15) | 8 passed | 8 passed | 8 passed |

Skipped (unchanged): the 8 research 15 probes per engine under the root config (run by `test:probes`), research 11 on
Firefox and WebKit, research 01's sanity check on WebKit.

Unit (`bunx vitest run`): 1550 passed in 39 files (1533 in 37 at `8421d70`); 5 of 5 runs green with `yes > /dev/null`
on all four cores (37–40 s each). Mutations re-applied after the fixes, each now failing its test: the host's grammar
call removed, the outbox written by assignment, console lines dropped before attach, eval written into default-src,
`adoptedCallback` a no-op, teardown through the element's methods, the prototype not restored (unit); the announcement
listener's `event.source` check, the playground's, the worker allowlist not applied, the console relay only on attach
(end to end, three engines). `bun run typecheck`, `bun run build` and `scripts/smoke-package.sh` pass.

## Decisions after the verification

1. **`ready` means the guest's startup script checked in** — ✅ done
   ([backlog S46](../backlog/BACKLOG-done.md#s46--ready-is-the-guests-check-in---done); ADR-002 and
   [ADR-003](../../ADR-003-lifecycle-and-liveness.md#amendment-2026-10-14-ready-is-the-guests-check-in) amendments).
   `ready` waited for the wrapper's load, which waits for the guest's subresources, so `LOAD_TIMEOUT_MS` (CB3) also
   ended a legitimate page with slow images. Measured by a verifier: the bootstrap's announcement arrives after about
   26, 117 and 93 ms (Chromium, Firefox, WebKit) while a 3 s image holds the wrapper's load to about 3.1 s, and a
   guest that never closes its document still announces within 22–40 ms. Now the host is `ready` on the
   announcement, the deadline bounds only that, and the guest holds the host's calls and `execute()` code until its
   document is parsed.
2. **Strict mode is the default** — ✅ done (2026-10-15;
   [backlog S48](../backlog/BACKLOG-done.md#s48--strict-is-the-default-iframe-is-renamed-cooperative-cooperative-modes-limits-are-frozen---done);
   [ADR-005 amendment](../../ADR-005-strict-mode.md#amendment-2026-10-15-strict-is-the-default-cooperative-modes-limits-are-frozen)).
   Every finding of the reviews above that strict mode does not close lives in the document mode. A config without a
   mode now builds the strict view; `'iframe'` was renamed `'cooperative'` (it fails closed, saying so); strict `html`
   that holds a script or an `on…` handler warns once per element; every preset names its mode. Cooperative mode's
   limits are a frozen list (no new guest-realm patches; V3 and H1 above are on it), and S42, WebKit's host-page
   availability under CSS paint cost, is accepted and documented: strict mode protects confidentiality and egress there.
