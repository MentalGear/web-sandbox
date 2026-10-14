# Focused review, 2026-10-14

**Date**: 2026-10-14 · **Code reviewed**: `main` at `affe25e` (guest writes, C5) · **Result**: 11 findings and one
hardening — 10 fixed (F4 was latent: the grammar dropped the injected prototype before it mattered), 1 documented
by design (W5), the hardening done; no residual left open; two limits of W1 stated
· **Backlog**: [S27–S31](../BACKLOG.md#s27--a-committed-inert-file-could-run-as-a-script-of-the-next-build---done)
· **Earlier review**: [adversarial review 2026-10](ADVERSARIAL-REVIEW-2026-10.md) · **Next**: [broad review 2026-10-14](BROAD-REVIEW-2026-10-14.md)

## Scope and method

Two focused adversarial rounds, after the [main review](ADVERSARIAL-REVIEW-2026-10.md) and its follow-up, on what
had changed or not been looked at closely: **W**, guest writes and files (C5, the store, references); **F**, the
follow-up's fixes (strict view, execution budget, config and policy steps). Same method as the main review:

1. Reviewers read the code and proposed candidates with a code path, a hypothesis and a fix.
2. Every candidate was reproduced first as a **failing test** — a unit test where only library logic decides, an
   end-to-end test on Chromium, Firefox and WebKit where browser behaviour decides — run against `affe25e`, then
   fixed at the chokepoint that closes the class, and the test re-run green. End-to-end evidence follows T5
   ([backlog](../BACKLOG.md)): read from outside the sandbox (a host method the guest's scripts call, recorded on the
   host page; the view's DOM and Chromium's accessibility tree over DevTools; the element's own events), the
   recorder's listeners for network effects, and a positive control beside each negative. Candidates that held keep
   their test as a guarantee test.

**Engines**: the Playwright 1.58.1 builds of the main report (Linux); Playwright's WebKit is not Safari.

## Summary

| Id | Area | Severity | Status | Test (file: name) |
| :--- | :--- | :--- | :--- | :--- |
| W1 | files, guest writes | high | **fixed** | `test/e2e/focused-review.spec.ts`: "W1" (6 tests); `src/lib/load-kinds.test.ts`; `test/unit/focused-review.test.ts`: "W1" |
| W2 | guest writes, logs | low | **fixed** | `test/unit/focused-review.test.ts`: "W2" (5 tests, one a guarantee for auto-sizing) |
| W3 | guest writes | info | **fixed** | `test/unit/focused-review.test.ts`: "W3" |
| W4 | guest writes | info | **fixed** | `test/unit/focused-review.test.ts`: "W4" |
| W5 | guest writes | info | **documented** (by design) | API.md, "Guest writes" |
| F1 | strict view | medium | **fixed** | `test/e2e/focused-review.spec.ts`: "F1" (2 tests); `src/lib/in-sandbox-view.test.ts` |
| F2 | liveness | medium | **fixed** | `test/e2e/focused-review.spec.ts`: "F2" (5 tests × worker, strict); `test/unit/followup-guarantees.test.ts`: "B8, focused review F2"; `src/lib/in-sandbox-script.test.ts` |
| F3 | config, events | low | **fixed** | `test/unit/focused-review.test.ts`: "F3" (4 tests) |
| F4 | policy steps | low | **fixed** (latent) | `test/unit/focused-review.test.ts`: "F4" (per step, and a property over every step) |
| F5 | policy | info | **fixed** | `test/unit/focused-review.test.ts`: "F5" (source check) |
| F6 | config | info | **fixed** | `test/unit/focused-review.test.ts`: "F6" |
| H | fetch bridge | hardening | **done** | `test/unit/focused-review.test.ts`: "Hardening" |

"Fixed" means the test failed against `affe25e` and passes now: 19 of the 27 new unit tests in
`test/unit/focused-review.test.ts` failed there (the other 8 are guarantees: auto-sizing, and F4 for the seven steps
that were already safe), and 36 of the 54 new end-to-end tests (W1 12, F1 6, F2 18; the rest are guarantees and
positive controls).

## Findings

### W1 · A committed inert file ran as a script of the next build

- **Guarantee**: nothing the guest writes runs unless the embedder commits it with `{ code: true }`.
- **Found**: a guest-written `app.js` with a type override, `{ content, type: 'text/plain' }`, is inert, so
  `commitGuestWrites(['app.js'])` needs no `{ code: true }`; the next build's markup `<script src="app.js">` resolved
  to it (`resolveReference`, `REFERENCES` in `markup-references.ts` had no kind), and engines run a classic `blob:`
  script whatever the blob's type. Measured with the store's types: Chromium and Firefox ran every inert type
  (text, JSON, CSS, fonts, images, audio, video); WebKit text, JSON, CSS and fonts. Host-registered files the same:
  `x.js` registered as `text/plain` ran.
- **Root cause**: reference resolution ignored the load kind, so the type the store gave a file — which the inert
  list judges — did not decide how it was loaded.
- **Fix**, by construction: one table, `src/lib/load-kinds.ts`, says which types each kind of load admits (script:
  JavaScript types; style: `text/css`; image: `image/*`; font: `font/*` via `@font-face`; media: audio and video;
  track: `text/vtt`; fetch: any). Every resolver reads it — `resolveReference(value, files, kinds)` for markup and
  inline CSS (link kinds from `rel` and `as`), `FileStore.snapshot()` for registered stylesheets (each CSS reference
  carries its kind from the tokenizer: `@import`, `@font-face`, other `url()`), the strict renderer (the table as
  data), the import map and the strict entry (`isJavaScriptType` is the table's script row) — and so does the
  policy: `kindsForTypes` gives a type `blob:` in exactly the directives of the loads that may name it, byte-identical
  policies as before (existing property test). A mismatch stays as written and fails closed, with one warning.
  **Effect on host-registered files**: the same; a mistyped script no longer loads as one (API.md, ADR-004).
- **Limits, stated** (API.md, ADR-004): committed `text/css` is inert and still CSS, so it restyles markup of the
  next build that links it (info: CSS runs nothing and sets no attribute); code that passes `sandboxFiles.url()` to a
  script element or `importScripts()` decides itself what it loads — measured: Chromium runs a `text/plain` file both
  ways, Firefox and WebKit refuse it in `importScripts()` (asserted per engine, "limit (measured)").
- **Evidence**: before, on all three engines, the host page recorded `app` (and the recorder `/w1-app.svg`) for
  writes made in iframe, worker and strict mode, and `x` for the host-registered file. After: only the positive
  controls, `ok.js` committed with `{ code: true }` and `y.js` registered as JavaScript, run, in order; the inert
  file's `<script>` keeps its relative `src` and loads nothing; a strict entry committed as `text/plain` is refused
  (guarantee). Unit: every kind × every type of the extension table plus overrides, through the table, 25 markup loads, 8 CSS
  contexts and 8 renderer loads.

### W2 · Rate windows were fixed windows

- **Guarantee** (API.md): at most `GUEST_WRITES_PER_SECOND` requests, `GUEST_WRITE_BYTES_PER_SECOND` bytes and
  `LOG_EVENTS_PER_SECOND` guest lines in any one-second window.
- **Found / root cause**: fixed windows opened by a first event: 199 writes, twice the bytes and 1999 log lines
  passed within milliseconds around a boundary.
- **Fix**: one sliding-window limiter, `src/lib/rate-limit.ts`, for both guest-write rates and the log rate (a token
  bucket would admit up to twice its capacity in one window, so it would not hold the stated property either).
  Auto-sizing already held it, by spacing its writes (now asserted); the fetch bridge states no per-second rate.
- **Evidence**: unit tests with a fake clock (boundary cases and a 20-seed property) failed before; pass now.

### W3 · A removal mark could outlive its stored path · W4 · `write()` could throw

- **W3**: a removal is recorded only for a stored path, but the host could unregister the path afterwards; the mark
  was still listed and committed. Now a mark whose path the store no longer holds is forgotten before marks are
  listed or committed (the two places marks are read).
- **W4**: `sandboxFiles.write()` inspected its entry (`instanceof`, which runs a Proxy's trap) outside its `try`, so
  a revoked Proxy made it throw instead of rejecting. Everything that inspects the entry is inside the `try` now.
- **Evidence**: unit tests failed before; pass now.

### W5 · Guest and host can disagree about a write (by design)

The element records a change before it announces it (`fileswritten`), and the guest's view changes only on the
answer. A listener that calls `terminate()` (the change stays, the asking environment is gone) or blocks past the
guest's 30 s call timeout (`TIMEOUT`, the change listed anyway) leaves them apart; `listGuestWrites()` is the truth.
Stated in API.md.

### F1 · SVG animation re-animated a checked link href in the strict view

- **Guarantee**: every rendered link's href is `about:blank#` (S24); the view renders no URL the renderer did not
  check.
- **Found**: `<set attributeName="href" to="…">` or `<animate>` inside a rendered `<a>` animated its href after the
  renderer had replaced it: `getAttribute` and `baseVal` kept the constant, `animVal` and Chromium's accessibility
  tree carried the guest's URL — all three engines; on an `<image>` it loaded a URL the renderer never saw
  (Chromium, Firefox; WebKit changed `animVal` without a request).
- **Root cause**: the renderer checks attributes once, before insertion; in the view nothing runs and CSS cannot set
  attributes, so SMIL is the one mechanism that changes them afterwards.
- **Fix**, the class: the renderer removes every SVG animation element (`animate`, `set`, `animateMotion`,
  `animateTransform`, `animateColor`, `discard`, `animation`; `mpath` goes with its parent), case-insensitively. That
  closes every attribute the renderer checks at once — link hrefs, file references, the `blob:` rule — and any it
  may check later.
- **Evidence**: read from outside (`test/e2e/strict-view.ts`): before, `animVal` was the guest URL for `<set>`,
  `<animate>` and `xlink:href` on all three engines, and the recorder received the animated image in Chromium and
  Firefox. After: `animVal` and `baseVal` are `about:blank#`, no animation element is left, Chromium's
  accessibility tree (`Accessibility.getFullAXTree`, new helper `chromiumViewLinkUrls`) exposes no guest URL, the
  animated image and an animated `<use href>` load nothing, while the static image of the same policy reaches the
  listener (positive control). An animated `blob:` URL the view did not mint was already dropped by the `blob:` rule
  (its `to` attribute); asserted.

### F2 · `workerExecutionTimeout` could be evaded

- **Guarantee**: an `execute()` that does not give the event loop back ends the sandbox.
- **Found** (worker and strict mode, all three engines): (A1) `setTimeout(() => { for (;;) {} }, 0)` returned, the
  guest posted `EXECUTED`, the timer stopped, and the loop ran forever; (A2) guest code that replaced
  `globalThis.Function` made the bootstrap's `new Function(code)` return a deferring function, so `EXECUTED` was
  posted before the embedder's code ran.
- **Root cause**: the budget ended on the guest's word, and the bootstrap looked `Function` up when used.
- **Fix** (decision, ADR-003 amendment): the budget is **"the event loop is free at the deadline"**. The guest
  reports nothing (`EXECUTED` is gone); at each deadline the host pings through the bootstrap's captured `PING`
  handler and terminates unless a `PONG` arrives within `EXECUTION_TIMEOUT_GRACE_MS` (1000 ms, counted in watchdog
  ticks so a host stall never counts; negative ping numbers, so an answer names its probe). The bootstrap compiles
  with the `Function` and `Reflect.construct` it captured before guest code. Each `execute()` has its deadline and
  each checks the one event loop; a loop that starts after the last deadline is `watchdogTimeout`'s.
- **Evidence**: before, A1, A2 and the concurrent case failed on all three engines in both modes (state stayed
  `ready`; A2's replacement was used). After: all terminate with the reason; code that finished and left the loop
  free stays `ready` past the deadline and grace with its state (positive control); the plain loop terminates
  (control).

### F3 · Error text in reasons

- **Found**: `setConfig()`'s reason and the console warning carried the caught error's message — Chromium's
  `DataCloneError` quotes the source of the function it could not clone, a throwing getter's message is any text;
  the build-failure reason likewise; the strict entry's error text was part of a `source: 'host'` line.
- **Fix**, one rule (`errorName` in `host.ts`): a reason or host line is a fixed text plus the error's name (checked
  to be a short identifier; a thrown primitive is named by its type). The entry's text arrives as a guest line;
  the lexer warning keeps only its position. Checked the other places a caught error reaches the host's own output:
  none left. (`HANDLER_ERROR` carries a host handler's message to the guest by documented design; not the host's
  output.)
- **Evidence**: unit tests, including a source check, failed before; pass now.

### F4 · A configured `__proto__` became a prototype in a CSP step

- **Found**: `drop-meta-ignored.ts` wrote `output[name] = values` before the grammar ran, so a JSON `__proto__`
  directive (kept as an own key by the merge and by structured clone) became its output's prototype. Latent: the
  grammar reads own keys only and dropped it.
- **Fix**, the class: every CSP step and config transform writes config-derived keys with the one `defineData`
  helper (`utils.ts`, already the merge's), and reads directives as own keys only (`directiveOf`).
- **Evidence**: a per-step test and a 200-config property over every step (`__proto__`, `constructor`, `prototype` at
  any depth) failed before for `dropMetaIgnoredDirectives`; pass for every step now.

### F5 · Two writers of `'unsafe-eval'` · F6 · A refused config was stored

- **F5**: the host appended `'unsafe-eval'` with `directives["script-src"]?.push(…)`, beside the effective-directive
  table, and the strict view wrote it itself. Now `addEvalSource` (`effective-directive.ts`) is the one writer: it
  appends to the directive that governs `'eval'` and, when only `default-src` would, creates `script-src` from
  `default-src`'s sources — never `default-src`. A source check fails on any other writer (failed before).
- **F6**: `_applyConfig` stored the config and then ran the strict warnings, which threw for
  `connectionsAllowed: null`: refused, but stored. Now every check and warning reads the candidate, which is stored
  last, and a `connectionsAllowed` that is not an object is refused in every mode (before, iframe mode failed later,
  in the build).

### Hardening · `sandbox:fetch` bound per build

The method read the current bridge when it ran, a microtask after the request arrived; correctness relied on no
rebuild in between. Now each build registers it closed over its own bridge, like `sandbox:write`: a request from
environment N that runs after a rebuild is refused by N's closed bridge, never made by N+1's (unit test failed
before: N+1's bridge made the request).

## Areas reviewed and found sound

- **Guest writes** (round W): writes off refuse by both routes and nothing is recorded; no raw frame reaches the
  overlay; nothing written reaches a later environment without a commit; the type assigned is the store's, by one
  `CheckedFile.from()`; the quota is the store's, with every pending change applied; requests keep call order and
  every entry's bytes are copied when called; the lifecycle (builds discard, terminations keep, the method bound to
  its overlay); the strict view never sees the overlay.
- **The effective-directive table** matches CSP Level 3's fallback lists.
- **C1's revocation** (the worker's source URL revoked on `VIEW_STARTED`) and **notify-then-act** (`_notifyThenAct`,
  the only reader of the environment count) held under the reviewers' attempts.
- **C4's bounds** (per-directive view counts, known names plus one bucket) held.
- **`deepMerge` and its consumers**: own keys only, defined not assigned, at any depth.

## Full-suite results

Commands: `bun run typecheck`; `bunx vitest run`; `bun run build`; `scripts/smoke-package.sh`; the full Playwright
suite per engine; the changed and new specs with `--repeat-each 3`.

| | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| Full e2e at `affe25e` | 401 passed, 8 skipped | 400 passed, 9 skipped | 399 passed, 10 skipped |
| Full e2e after | 419 passed, 8 skipped | 418 passed, 9 skipped | 417 passed, 10 skipped |
| Changed and new specs, `--repeat-each 3` (60 tests × 3) | 180 passed | 180 passed | 180 passed |
| New `focused-review.spec.ts` before each fix | 12 failed, 6 passed | 12 failed, 6 passed | 12 failed, 6 passed |

The skipped tests are per-engine measurements that do not apply to that engine. The new spec has 18 tests per
engine; the 12 that failed before are W1's four non-guarantee tests (run against `affe25e`), F1's two (against the
W1 commit) and F2's A1, A2 and concurrent cases in two modes (against the F1 commit). Changed and repeated specs:
`focused-review`, `worker-timeout`, `strict`, `review-strict`, `review-followup`.

Unit (`bunx vitest run`): 1470 passed in 34 files (1367 in 32 at `affe25e`). `bun run typecheck`, `bun run build`
and `scripts/smoke-package.sh` pass.

One failure on the way, root-caused: after the F2 commit, `test/unit/channel-guarantees.test.ts` did not parse (a
line comment inside a one-line object literal swallowed its closing brace), so vitest reported the file as failed
rather than its tests; typecheck caught it too. Fixed in its own commit. And the W2 property test first allocated
about 12 GB of write buffers across its seeds and ran past vitest's 5 s default while an e2e run shared the CPU; it
now makes 600 requests per seed (still failing against `affe25e`) with an explicit timeout.
