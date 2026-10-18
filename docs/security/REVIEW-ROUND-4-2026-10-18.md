# Review round 4 (2026-10-18)

The fourth round under the stopping rule, on `main` at `c7672bb`, with round 3's fixes (S57) and research 17. The rule is
unchanged (see the [round 2 report](REVIEW-ROUND-2-2026-10-15.md#stopping-rule)). The owner reviewed the findings before
any fix and decided three of them. Backlog: S62. The next round is S63.

## Reviewers

| | Method | Model family | Completed |
| :--- | :--- | :--- | :--- |
| L | model-based lifecycle testing: 2,100 seeded runs from 1,300 sequences; all 216 (operation, state, mode) combinations reached on each engine | Opus | yes |
| C | audit of the code changed since round 3 (`16c545b..c7672bb`) | Sonnet | yes |
| M | each documented limit measured at its edge on 3 engines, with responsiveness and memory soaks | Opus | yes |

The lifecycle reviewer's reference model and generator are kept for S61 in
[research 17](../research/17_formal_methods/lifecycle-model.md).

## Findings

**No high finding**, the first round without one. Every documented numeric limit held at its edge, in every mode, on all
three engines. Each test named failed at `c7672bb` and passes after the fix. Tests: `test/unit/review-round-4.test.ts`,
`test/e2e/review-round-4.spec.ts`, `test/e2e/view-switches.spec.ts`, `test/unit/channel-guarantees.test.ts`.

| ID | Severity | Class | Finding | Resolution |
| :--- | :--- | :--- | :--- | :--- |
| M-1 | medium | ours: a channel outside every budget | The guest worker kept its own `postMessage()`, which reached the view (strict mode) or the frame (worker mode) outside every budget. Firefox's host was 61–83% busy, WebKit's 26–30%. | Removed from the worker's allowlist: the library's port is the worker's only way out. Worker mode also cancels uncaught errors after relaying them (16 Mi-character errors had kept the host 89–98% busy). Host busy under the flood: 0% on all three engines. |
| C-1 | medium | ours: a value read twice | `errorMessage` read `error.message` twice, so a getter could post an unmeasured object of 200 MiB after a string had passed the check (host stalls of 280–362 ms). | Read once; every refusal text is a string; refusal frames are measured on receipt. A source scan forbids a second read of a property after a type check in guest-realm code (15 such reads changed). |
| C-2 | medium | ours: work amplified | With `allowAnimations: false`, rewriting `style` attributes expanded shorthands. One render stalled WebKit 10.3 s and Firefox 2.7 s, then was refused as too large. | Only attributes that may name an animation or transition are read, and only those properties are removed. CSS-wide keywords are kept. An attribute that would expand is removed whole. Now 385–581 ms against 81–312 ms with `true`; the remaining difference is the still stylesheet's own style work. |
| L-1 | medium | ours: a fix that did not hold (round 2's L-6) | `ready` was dispatched from inside the embedder's own `remove()` or `appendChild()` while loading. Over 150 iterations: Chromium 4–16 times, WebKit 8–12. | A frame's load completes the build in a microtask, re-checking the frame, both connections and the environment. 0 in 150 iterations, tested in the browser. |
| M-2 | medium | ours: work outside the time budget | Image loads and CSP violation processing after a render were not charged. With 6500 images per render, WebKit stalled 7.5 s; refused sources kept Firefox 42% busy. | The renderer drops any `src`, `srcset` or `poster` URL the view policy would refuse, and reports a synthetic violation within the existing cap. New limits approved by the owner: `VIEW_MAX_URLS` (1000) and `VIEW_URLS_PER_SECOND` (200). Refused-source floods now cost 13–19%. |
| M-6 | low | ours: a default too high | Within the default call budget (5000 per second), Firefox's host was 32–37% busy. | Owner's decision: the default is 1000 per second. Measured at the new default, the host stayed 0–1% busy. The fix agent could not reproduce the 32–37% on its machine either. |
| L-3 | low | ours: a rule in two places | The "no repeat" rule for a rebuild from a `terminated` listener covered build terminations only. | Owner's decision: one rule. Every `terminated` goes through one dispatch path. |
| L-2 | low | ours | Two events dispatched in one notify callback: the second reached a torn-down or new environment. | `_notifyThenAct` takes a list and stops at the first teardown. |
| L-4 | low | ours | A guest removal could be announced in `fileswritten` but never listed. | Recording and listing use one rule; the element announces only a change to the list. |
| M-4, M-5 | low | ours | The view's error lines reached 2057 characters. WebKit dropped lines past the rate limit silently. | The line is cut once, after it is composed. The first drop is reported as one warning. |
| C-5 | low | ours | An argument that can never be carried was answered with the retryable `BUSY`. | `ARGS_NOT_TRANSFERABLE`, also for arguments too large to carry, which goes slightly beyond the finding. |
| C-6, C-7, C-8 | info | ours | `callLimits` below 1 was accepted silently; two Chromium media-control parts were missing from the still list; a long fetch URL was parsed before its length check. | Below 1 falls back to the default with a warning. The two parts are added, and an e2e reads Chromium's own part list. The parse is skipped past `MAX_URL`. |
| M-3, C-3, C-4, I-1, I-2 | low, info | docs | Chromium `<img>` cost; ADR-006's 2048; the `allowAnimations` value rule; `aborted` records after `reset()`; no `fetch` event while the bridge is off. | Docs corrected. |

## What remains

- **URLs named in CSS** (`url()` and `image-set()` in `style` attributes, `<style>` and registered stylesheets) are not
  dropped at render time: that would mean parsing CSS. With 3000 refused backgrounds per render, the host was 33% busy
  in Firefox, 18% in Chromium and 9% in WebKit. README states it.
- **Synthetic violations** name the URL as written. Engines may report an upgraded `https:` form, and WebKit reports
  duplicates.

## Validation

- `bun run test:unit`: 1562 passed. 35 of the 39 new unit tests failed at `c7672bb`; the other 4 are controls and edges.
- e2e, full run per engine: Chromium 575 passed and 1 failed, Firefox 574 passed, WebKit 571 passed and 2 failed. The three
  failures were then fixed and their specs re-run:
  - a new spec's image origin;
  - a new spec's log pattern;
  - a positive control that depended on machine speed and failed at `c7672bb` too.
- The view-switches form-control test now reads the animation in the view, instead of host timing that varied by machine. It passed 5 of 5 runs on each engine.
- `bun run typecheck`, `build`, `build:lib`, `scripts/smoke-package.sh` and the strict-mode probes (24) pass.

## Severity trend

| | Round 2 | Round 3 | Round 4 |
| :--- | :--- | :--- | :--- |
| High in our code | 2 | 2 | 0 |
| Medium in our code | 8 | 6 | 5 |

Of round 4's five mediums:
- three are in code round 3 added or changed: C-1 (the frame builders), C-2 (the still style) and M-2 (the budget's reach);
- one is an earlier fix that did not hold (L-1);
- one is a channel no review had looked at (M-1).

## Round result

**Not clean.** Five medium findings in our code were fixed. The count stays at 0. Round 5 follows directly (S63), at the
owner's request.
