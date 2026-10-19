# Research 17: machine-checked proofs (Lean) or tests?

**Question.** Should the library use Lean proofs? Backlog S59, asked by the owner after review round 3.

**Decision (owner, 2026-10-18).** No Lean in the repository's checks. This note and its proof of concept are kept as a record.
The cheaper techniques it points to are planned for later (S61). The view's time budget is described as a long-run
average, not a per-second bound.

## How the findings divide

All 48 medium-or-higher findings, from the earlier reviews and review rounds 1–3 (`docs/security/`), were sorted into
three classes:
- (a) a property of our own logic that a formal model could state;
- (b) the gap between such a model and the real JavaScript runtime;
- (c) browser behaviour.

| Source | Med+ | (a) our logic | (b) model vs runtime | (c) browser | Other |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Earlier reviews (adversarial, focused, broad, verification) | 21 | 3 | 3 | 15 | 0 |
| Round 1 | 9 | 2 | 1 | 4 | 2 |
| Round 2 | 10 | 4 | 4 | 1 | 1 |
| Round 3 | 8 | 6 | 1 | 1 | 0 |
| **Total** | **48** | **15** | **9** | **21** | **3** |

- **(a) 15 findings.** A Lean proof could have caught at most 12 of them, and each of those 12 is also caught by a
  cheaper technique once the property is written down:
  - fast-check property tests: 6;
  - model-based lifecycle tests (`fc.commands`, re-entrant listeners, fault injection): 3;
  - a branded type plus a source scan, "every frame passes through the builder": 3.

  The other 3 were limits nobody had written down (R1-1, R3-3, round 3 M-2), which no technique finds before the
  requirement exists. **Findings only a proof would have caught: 0.**
- **(b) 9 findings.** They are outside a model over ideal values: guest-replaced intrinsics, getters, structured
  clone's real behaviour, NaN.
- **(c) 21 findings.** Only measuring on Chromium, Firefox and WebKit finds these.
- **Trend.** The share of (a) grew round by round: 3/21, then 2/9, 4/10 and 6/8. This argues for the tests in S61.

## Proof of concept: the sliding-window rate limiter

The property was `src/lib/rate-limit.ts`'s guarantee, "at most `limit` admitted in any window of `windowMs`", plus the
agreement between the guest's copy of the rule and the host's.

| | Lean 4 ([`RateLimit.lean`](RateLimit.lean)) | fast-check ([`rate-limit.prop.test.ts`](rate-limit.prop.test.ts)) |
| :--- | :--- | :--- |
| Setup | elan through the proxy, Lean 4.35.0: about 90 s, 3.0 GB | one dev dependency: 0.24 s |
| Written | 290 lines: a spec, a model of the implementation, 3 theorems; no `sorry` | 7 properties |
| Checked against | a hand-written model of `rate-limit.ts` | the real `rate-limit.ts`, and the guest's copy lifted from `in-sandbox-script.ts` |
| Check time | 2.1 s | 1.3–1.8 s (2000 runs per property) |
| Effort for a person (estimated) | 0.5–1 day for an experienced Lean user; 1–3 weeks for a team new to Lean | 1–2 hours |

What each found:
- **The window bound.** Both showed it holds.
- **Time must never go back.** Both showed the precondition is needed: the proof by making it explicit, fast-check by
  shrinking a counterexample (admit at 0, probe at 1000, admit at 0).
- **Guest and host agree only while the transit delay never shrinks.** Both found this. It is round 3's L-4, already
  documented.
- **Weights.** Only fast-check found that a weight of NaN is admitted by the host and refused by the guest, and that
  a negative weight is admitted. A proof over natural numbers cannot express either. Both cases are latent: no caller
  passes such a weight.

The three "expected to fail" properties list their known counterexample as a fast-check `examples` entry, so they do
not depend on the random search finding it.

[`view-budget.prop.test.ts`](view-budget.prop.test.ts) simulates the view's time budget arithmetic:
- a budget refilled at 200 ms per second that may owe up to 1000 ms;
- with operations of at most 200 ms, one second of wall time held 398–553 ms of the view's work;
- repeated 20-second operations, charged only up to the debt cap, reached an 82% share.

So the budget bounds the view's long-run share of time for operations shorter than its debt cap, not each single
second. API.md, README and ADR-005 now say so.

## Tying a proof to the code

The options considered:
- **Extracting JavaScript from Lean.** Not viable: there is no maintained JS backend, and the output could not follow the
  guest's captured-intrinsics rule.
- **A Lean model as a test oracle.** It needs the toolchain in CI and a trace harness, a high cost for one 70-line
  module.
- **TLA+ or Alloy.** A design-level model, cheaper to write than Lean, but it drifts from the TypeScript as much.
- **fast-check `commands`, with one model next to the code.** The same language, failures shrink to minimal sequences,
  and the same commands run in jsdom and in Playwright. This is the one recommended (S61).

## Running the files

**Now in CI (backlog S61).** The rate limiter's properties run as `test/unit/rate-limit.prop.test.ts`, against the real
`rate-limit.ts` and the guest's copy of the rule lifted from the built bootstrap; the weight rule they found is fixed
(one rule, `isWeight`, on both sides), and P3 and P5b now pass. The view budget's long-run bound runs as
`test/unit/view-budget.prop.test.ts`, against the real `viewBudget`. The files here are the record of the proof of
concept as it ran; the two in CI are the ones kept in step with the code.

Nothing in this folder runs in CI.
- **The property tests:** with fast-check installed (`bun add -d fast-check`), run
  `bun test docs/research/17_formal_methods/rate-limit.prop.test.ts`, and
  `MAXOP=200 bun test docs/research/17_formal_methods/view-budget.prop.test.ts` for the budget simulation.
- **The proof:** checked with `lean RateLimit.lean` (Lean 4.35.0, core only). It is a snapshot. It is not kept in step
  with `rate-limit.ts`.
