# Review round 5 (2026-10-18 to 2026-10-19)

The fifth round under the stopping rule, on `main` at `60814b5`, after round 4's fixes (S62). The rule is unchanged (see
the [round 2 report](REVIEW-ROUND-2-2026-10-15.md#stopping-rule)).

The owner reviewed the findings before any fix. They then asked whether the findings share a class.
[Research 18](../research/18_finding_classes/README.md) found that the classes which recur are the ones whose earlier
fixes were per instance. The owner adopted every recommendation: each fix below is the first slice of its class's design,
and every fix names its class (CONTRIBUTING.md, "Fixing a finding"). Backlog: S63 (the round) and S64 (its fixes).

## Reviewers

| | Method | Model family | Completed |
| :--- | :--- | :--- | :--- |
| C | audit of the code changed since round 4 (`c7672bb..60814b5`) | Sonnet | yes |
| L | model-based lifecycle testing from [the reference model](../research/17_formal_methods/lifecycle-model.md): 1,050 sequences, 12 sweeps and 6 tight loops per engine; all 216 (operation, state, mode) combinations on each | Opus | yes |
| M | each documented limit at its edge on 3 engines, with soaks | Opus | yes |

The audit's reviewer killed two browser processes of another reviewer by mistake. Both other reviewers discarded the runs
that window touched and ran them again.

## Findings and fixes

Every documented numeric limit held at its edge on all three engines. Each test named failed at `60814b5` and passes
after the fix. Tests:
- unit: `test/unit/view-round-5.test.ts`, `test/unit/egress.test.ts`, `test/unit/config-schema.test.ts`,
  `test/unit/element-events.test.ts`, `test/unit/read-once.test.ts`;
- e2e: `test/e2e/view-round-5.spec.ts`, `test/e2e/review-round-5.spec.ts`, `test/e2e/egress.spec.ts`.

| ID | Severity | Class | Finding | Fix (the class's design it starts) |
| :--- | :--- | :--- | :--- | :--- |
| M-1 | high | P: the library's own mitigation adds cost | With `allowAnimations: false`, replacing about 37,000 elements froze Firefox's host page for 22–25 s; the still stylesheet's `*::first-letter` rule took 20 s alone. | The still stylesheet is the `*` rule, plus one rule for each pseudo-element the guest's CSS names, added through the CSSOM. An escape or an `@import` adds them all. `first-letter`, `first-line`, the highlight pseudo-elements, `::column` and the scrollbar parts are removed. False/true cost ratio for a 37k replacement: Chromium 0.85–1.36 (was 4.7–7.1), Firefox 0.84–1.25 (was 37–148), WebKit 1.12–1.8 (was 3.4–4.5). An e2e on every engine keeps it bounded. |
| N-1 | medium | E-cpu | Unhandled rejections were relayed, not cancelled. A flood of large ones kept Firefox's host page 99% busy (7 GB) and Chromium's 11–39%. | **The egress table** (`src/lib/egress.ts`): every surface of guest activity on the host page's thread, with its handling and bound. The bootstrap installs exactly its rows' listeners, and an e2e on every engine enumerates the realms' event surfaces and fails on any unlisted. Rejections are cancelled, and a budget of 1000 uncaught errors and rejections per second (and 1 Mi characters) ends the sandbox past it, because cancelling does not stop Firefox's cost. |
| L-1 | medium | L | In strict mode, a call made while loading that timed out before `ready` still ran: queued work was flushed at the wrapper's load. | Queued calls and `execute()` leave only at `ready`, in every mode: one flush point, the first slice of the lifecycle reducer (S65). |
| L-2 = N-5 | medium | C | A byte budget smaller than one call answered `BUSY` forever, with no warning. | **One config schema** (`src/lib/config-schema.ts`), its first rules. A call heavier than the byte budget is answered `ARGS_NOT_TRANSFERABLE`, which is not retryable. A `maxBytesPerSecond` below `RPC_MAX_BYTES` warns once. Cross-field invariants are declared once and tested. |
| M-2 | medium | P | The time budget capped what one operation was charged (1000 ms), so a 7.5 s Chromium layout repeated; host 53% busy with 8 s gaps. | The full measured cost is charged (`VIEW_APPLY_MAX_DEBT_MS` removed), and the arithmetic is a pure, tested function. An operation over `VIEW_MAX_OPERATION_MS` (2000 ms) ended the sandbox: "the view spent more than 2000 ms on one operation" (since S72, the owner's decision of 2026-10-19: the second within 5 minutes does; see "What remains"). Operations of 1–1.5 s in a row keep the host 14–20% busy. |
| M-3 | medium | E-net / B | CSS `url()` to an allowed origin bypassed the URL budget (Firefox 1,400 requests per second). | **Observe and charge.** Every load the view's resource timing reports, CSS-borne ones included, and every violation are charged to `VIEW_URLS_PER_SECOND`. Kept attribute URLs are still charged at render, because WebKit reports no entry for a failed load. CSS-background floods now cost 0–17% (allowed origin) and 1–6% (refused source). A load is charged when its response ends, so a slow server lets up to about 2× the rate through; documented. |
| M-4 | medium | P | A long allowed-image flood within the URL rate ended in a 13–28 s WebKit stall. | `VIEW_MAX_DISTINCT_URLS` (10,000 per environment), measured where WebKit's stalls grow (1.2 s near 8k distinct, 8.8 s near 43k). Past it a render that adds new URLs is refused, and so is one that carries CSS which can name a URL. The longest stall at the cap: Chromium 297 ms, Firefox 654 ms, WebKit 809 ms. |
| N-2 | low | G | The strict prelude's error listener read replaceable `ErrorEvent.prototype` getters. | The getters are captured at the capture point and read inside try/catch. Genuinely muted WebKit errors stay uncancelled, because cancelling them loses their text. |
| N-3 | low | B | The renderer's URL match disagreed with the engines' CSP (media upgrade, loopback, `:443`). | One-sided: a URL is kept only on an exact scheme, host and port match, or an image's `http:` upgrade (not for loopback hosts, which Chromium does not upgrade). |
| N-4, L-4 | low, info | D | A removal of an unregistered file was not sent to the view; a withdrawn write was announced with nothing listed. | **One diff** of the guest-write state drives the view, the list and the announcement. |
| L-3 | low | D/L | `terminated` and `fileschanged` details were not frozen. | **One constructor** for every event the element dispatches, freezing deeply. A source scan forbids any other. |
| N-6 | info | G | `sandboxFetch` read `init.method` twice. | **One reader** for guest option and event objects in the bootstrap, plus a scan: a property of a guest value is read at most once per function. |
| N-7, L-2, L-3 (M) | low | docs | The still-style rewrite's rule; `all` beside an animation in Chromium; the URL budget's "link `href`" wording. | The rule matches `animation`/`transition`/`\` only. `all` beside an animation removes the attribute on every engine. The wording is corrected. |

## What remains

- **The 2 s operation limit ended some real apps: decided (owner, 2026-10-19), the repeated-overrun rule.** In
  WebKit, the first `set()` of a 250,000-character textarea value takes longer than 2 s, and slower or loaded machines
  reach 2 s with smaller operations (the meter measures wall time: class P). The owner decided that the sandbox ends
  only after repeated overruns: an operation past `VIEW_MAX_OPERATION_MS` is charged in full and survived, with one
  `warn` line per environment, and the second within `VIEW_OVERRUN_WINDOW_MS` (5 minutes) ends the sandbox ("the view
  spent more than 2000 ms on one operation twice within 5 minutes"). What remains: at most one stall past 2 s per
  5 minutes beyond the first, each bounded only by the view's caps
  ([API.md (b)](../API.md#b-the-single-operation-bound); backlog S72).
- **Some browser work is outside the time meter.** Relayouts after an image decodes or a font swaps happen outside the
  frame the meter measures; only the load rate bounds them.
- **Chromium charges a refused load twice**, once as an entry and once as a violation. That errs toward slowing.
- **Unhandled rejections in Firefox** cost the host page whatever is done with them. The per-second budget is the
  bound ([research 19](../research/19_relay_worker/README.md): a relay worker does not change this).

## Validation

- Each half was tested on its own branch: unit, typecheck, `build`, `build:lib`, the smoke test, the strict-mode probes
  (24) and e2e on Chromium, Firefox and WebKit.
  - View half: 1762 passed. Its three failures were two tests fixed and re-run green, and one that fails at `60814b5`
    too under load.
  - Host half: see its commits.
- Both halves merged:
  - `bun run test:unit`: 1631 passed.
  - `bun run typecheck`, `build:lib` and `scripts/smoke-package.sh` pass.
  - The new and changed specs (`review-round-5`, `view-round-5`, `egress`, `view-switches`) on Chromium: 38 passed.
  - The full suite runs on all three engines in CI.

## Round result

**Not clean.** One high and six medium findings in our code were fixed, so the count stays at 0. This time the fixes
are slices of their classes' designs. The phases that follow are S65 (one lifecycle reducer with the model-based
suite), S67 (one config schema), S68 (the view's cost bound) and S69 (the relay worker).
