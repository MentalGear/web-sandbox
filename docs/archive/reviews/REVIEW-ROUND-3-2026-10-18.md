# Review round 3 (2026-10-15 to 2026-10-18)

The third round under the stopping rule, on `main` at `16c545b` (round 2's fixes, S55). The rule is unchanged (see the
[round 2 report](REVIEW-ROUND-2-2026-10-15.md#stopping-rule)). The owner reviewed the findings before any fix: part 1
(`32ee7fd`) holds the fixes approved first, part 2 holds the view's time budget and the two strict-mode switches
decided after the measurements in [research 16](../../research/16_view_isolation/README.md). Backlog: S57.

## Reviewers

| | Method | Model family | Completed |
| :--- | :--- | :--- | :--- |
| L | model-based lifecycle testing: 1,407 seeded sequences on 3 engines, plus probes aimed at round 2's mechanisms | Opus | yes |
| C | audit of the code changed since round 2 (`31b8f0d..16c545b`) | Sonnet | yes |
| M | each documented limit measured at its edge on 3 engines, with responsiveness and memory soaks | Opus | yes |

## Findings

Each test named failed at `16c545b` (or on the code just before its change) and passes after it.
Tests: `test/unit/review-round-3.test.ts`, `test/e2e/review-round-3.spec.ts`, `test/unit/view-switches.test.ts`,
`test/e2e/view-switches.spec.ts`, `test/e2e/view-budget.spec.ts`.

| ID | Severity | Class | Finding | Resolution |
| :--- | :--- | :--- | :--- | :--- |
| <a id="r3-c-1"></a>C-1 | high | ours: frame not measured whole | The RPC byte budget measured only arguments and results. A guest's method name (2^27 characters, echoed in `unknown method: …`) and a handler's error text (2^28) crossed whole, stalling the host 0.2–0.7 s per call. | Part 1: every RPC frame is built by one set of builders and measured whole at both ends; method names are capped at 256 characters and never echoed; error text is cut at 64 Ki characters at both ends. |
| <a id="r3-m-1"></a><a id="r3-l-3"></a>M-1 = L-3 | high | ours: budget defeated | CSS animations defeated the view's 200 ms/s time budget: one render kept the host 80–98% busy indefinitely, and WebKit froze for 58 s. | Part 2, by the owner's decision: `allowAnimations` (default `true`). `false` removes animations and transitions from the view, measured back to baseline on all three engines. While `true`, the docs and the option's JSDoc state that the budget does not bound them wherever the view shares the host's thread. |
| <a id="r3-c-2"></a>C-2 | medium | ours: wrong charge | The time budget charged hidden or off-screen time as work: after a 4 s hide, Chromium's view stayed frozen for 389 s. | Part 2: only measured rendering is charged; no time without a frame; at most one measurement outstanding; debt capped at 1000 ms. |
| <a id="r3-m-2"></a>M-2 | medium | ours: unbounded throughput | Guest-initiated call throughput was unbounded: 32 MiB calls kept the host 15–39% busy within every documented cap. | Part 1: a sliding-window call budget in the guest's broker, re-checked by the host, set by `callLimits: { maxPerSecond, maxBytesPerSecond }` (default 5000 calls and 64 MiB per second). |
| <a id="r3-c-3"></a>C-3 | medium | ours: false reason | A nested Error in a logged value was reported as "past the log line's byte budget". | Part 1: Errors anywhere in a logged value are relayed as `{ name, message, stack }`; unknown kinds say "unsupported value: <kind>". |
| <a id="r3-c-4"></a>C-4 | medium | ours: unbounded before posting | The strict view relayed the entry's error text uncut (host stalls of 0.6–1.4 s). | Part 1: cut to 2048 characters and rate-limited in the view before posting. |
| <a id="r3-l-1"></a>L-1 | medium | ours: wrong state | Re-inserting the element from a refused build's `terminated` listener left it connected and `idle`. | Part 1: a connect after a teardown is not short-circuited; the no-loop rule (CB5) lives in one place. |
| <a id="r3-l-2"></a>L-2 | medium | ours: call never settles | A call whose argument getter terminated or removed the element never settled. | Part 1: each call records its environment; a frame for any other environment settles the call with `TERMINATED`. |
| <a id="r3-m-5"></a>M-5 | low | ours | Up to one frame per flush went uncharged (22–25% against a 20% budget). | Part 2: the full measured rendering is charged. |
| <a id="r3-l-4"></a>L-4 | low | ours | Guest lines the host dropped never appeared in `sandbox-log`. | Part 1: one `source: 'host'` warning line per environment. |
| <a id="r3-m-4"></a>M-4 | low | ours | The fetch record cut a valid URL to 2048 characters. | Part 1: the whole URL, `MAX_URL` (8192) enforced and documented. |
| <a id="r3-m-7"></a><a id="r3-c-5"></a><a id="r3-c-6"></a>M-7, C-5, C-6 | info, low | ours: text and docs | A doubled bracket in the over-budget marker; comments overclaiming; an ADR-005 amendment missing; the timer capture undocumented. | Part 1: fixed. |
| <a id="r3-m-3"></a>M-3 | low | documented limit | A 31-character `text()` into `<style>` over 46k elements stalled Firefox 7 s. | Documented as a single-operation stall (style recalculation and layout). |
| <a id="r3-m-6"></a><a id="r3-m-8"></a><a id="r3-m-9"></a>M-6, M-8, M-9 | info | documented limit, platform | Stall magnitudes per machine; an off-screen auto-size delay in Chromium; memory under RPC floods. | none; already documented |

## The process model behind the availability findings

Round 3's two medium-or-higher availability findings (M-1, C-2) and the accepted residual (S42) share one cause: the
view renders on the host page's thread. [Research 16](../../research/16_view_isolation/README.md) measured where it runs:

- **Desktop Chromium 127+**: its own process (sandboxed-iframe isolation).
- **Firefox**: the host's thread. Fission isolates only cross-site frames, and an opaque origin stays with its creator's site.
- **WebKit and Safari**: the host's thread (no site isolation shipped).
- **Chromium headless shell, Android WebView, low-memory Android**: the host's thread.

No design available to a library moves the view off the host's thread in every engine. The guarantee must therefore come
from inside the shared thread:
- `allowAnimations: false` removes the time-driven sources the budget cannot see.
- The budget bounds what operations cost.
- One operation's own cost stays unbounded (documented).

## Behaviour changes for embedders

- **The call budget.** Calls the guest initiates are limited by `callLimits` (default 5000 per second and 64 MiB per second). A call past it is answered `BUSY`.
- **Method names over 256 characters.** They are refused (`INVALID_CALL`), and `expose()` throws for them.
- **`allowAnimations`** (default `true`). `false` removes CSS animations and transitions from the strict view. If the host page's `style-src` refuses the library's stylesheet, the view drops the guest's stylesheets and the element warns with the hash to allow.
- **`allowAutoplay`** (default `false`). The strict view drops `autoplay` from media unless it is `true`.

## Validation

Part 1 (`32ee7fd`):
- 1505 unit tests.
- e2e on Chromium, Firefox and WebKit: 1629 passed, 27 skipped.

Part 2:
- 1523 unit tests.
- e2e per engine: Chromium 555 passed, Firefox 554, WebKit 553. The skips are the research probes and the on-demand measurement spec.
- `bun run typecheck`, `build`, `build:lib` and `scripts/smoke-package.sh` pass on both parts.

The cost of measuring the budget, from research 16:
- No frames are requested while the view is idle. Idle host busy is unchanged (Chromium 0→1%, Firefox 5→5%, WebKit 17→17%).
- About 30–75 µs of accounting per flush, plus a forced layout of 350–460 µs, which moves the rendering work into the flush where it can be measured.
- Nothing runs continuously while animations are allowed.

## Round result

**Not clean.** Two high and six medium findings in our code were fixed or, for M-1, closed by an option the owner chose to
leave off by default. The count stays at 0. Round 4 is held by the owner (S58).
