# ADR-001 history

History, not current state: the text of [ADR-001](../../ADR-001-continue-or-adopt.md) that its current decision replaced, verbatim, as it stood at commit 1aed8ad. Where a passage differs from the ADR, the ADR holds. Only the targets of relative links are changed, to resolve from this folder.

## The original status line

**Status**: Proposed · **Date**: 2026-08-29

## Why this ADR exists

The repository contains three prior-art comparisons — [`COMPARISON.md`](../../archive/research/COMPARISON.md),
[`COMPETITOR_ANALYSIS_2.md`](../../archive/research/COMPETITOR_ANALYSIS_2.md) and
[`IMPROVEMENTS.md`](../../archive/research/IMPROVEMENTS.md) — and **none of them asks whether to continue**.
Each ends with a verdict in our own favour ("occupies a specific niche", "fills a gap",
"Best for Local-First… scenarios") without ever stating what would *dis*qualify the project. The
first version of [`BACKLOG.md`](../../BACKLOG.md) inherited that assumption: 28 items about what to
build, none about whether to.

This ADR states the case for and against, and the conditions under which the answer flips.

## Correction to prior analysis

`COMPETITOR_ANALYSIS_2.md` credits `cross-origin-html-embed` with *"Strongest possible network
isolation (Unique Origins)"*. **That claim is wrong**, and it has been corrected in place.
Neither model dominates; they are stronger on different axes.

## The scoping of backlog item A3, as first written

This reframes backlog item A3. Its value is **not** unique origins — those are a downgrade. Its
value is header-delivered CSP, and it should be scoped accordingly: a second delivery mode, not a
second origin model.

## The introduction of the field scan, as first written

The comparisons in this repo predate the 2025-26 wave of "run AI-generated code safely in the
browser" tooling. The entrants below were checked against primary sources on 2026-08-29; two
claims from the brief that prompted this scan did not survive verification.

## The logic-tier consequence of the scan, as first written

What *has* changed is that the logic tier is now a solved, MIT-licensed commodity. Backlog **A4**
(the QuickJS spike) should be upgraded from a speculative P3 bet to a concrete integration
evaluation, with `quickjs-wasi` and `@tanstack/ai-isolate-quickjs` as the candidates and `zushi`
as the reference for how the two layers meet.

## The hybrid strategy table and its supersession note, as first written

| Layer | Position | Rationale |
| :--- | :--- | :--- |
| **Transport / RPC** (backlog B1) | **Adopt Penpal**, or copy its shape | Promise-based `postMessage` correlation is solved, small and well-typed. Hand-rolling message envelopes is undifferentiated work, and `websandbox`, Penpal and Zoid all set the same bar. Our `MessageChannel` layer already exists — Penpal supplies the framing on top. Confirm licence compatibility first. |
| **Logic tier** (backlog A4) | **Adopt `quickjs-wasi` or the TanStack driver** | MIT, browser-capable, actively maintained by established teams. `quickjs-wasi`'s VM snapshot/restore also answers backlog B2's `reset()` far better than recreating a frame. Do not write a JS engine. |
| **UI / DOM tier** | **Keep — this is the project** | No entrant renders untrusted DOM in an opaque origin. This is the differentiator. |
| **CSP policy layer** | **Keep, and fix** | Research 11 shows the current delivery is breachable (S2) and lossy (S7). Nobody else solves it for the local-first case. |
| **Virtual files** | **Keep — but watch `lifo`** | Our VFS is opaque-origin-compatible; theirs is not. If they solve it under opacity, reassess. |
| **Full OS / Linux tier** | **Do not build** | BrowserPod and Lifo are years ahead and it is not this project's problem. |

> The Transport / RPC row above, and consequence 4 below, are superseded by [ADR-002](../../ADR-002-host-guest-broker.md): the broker was built in-house rather than adopted.

## The decision and its consequences, as first written

## Decision

**Continue — conditionally.**

What justifies it, in order of durability:

1. **The research corpus.** Eleven documented attack vectors with reproductions, the CSP
   rationale, the VFS security analysis. This is the knowledge of *which* combination is safe and
   *why*, and it is what an adopter would have to rebuild. It is also the only asset here that is
   genuinely hard to copy — `host.ts` is 286 lines.
2. **Opaque-origin isolation with no server config.** Nothing else in the reference set offers it.
3. **Virtual files over an opaque origin.** The one differentiated *feature* nobody else has.

Explicitly **not** on that list: headless worker mode. It is the third "innovation" claimed in
`COMPETITOR_ANALYSIS_2.md` and it is not real — the worker inherits the host CSP (backlog S1).

### Conditions that flip this decision

- The e2e suite (backlog T1) does not come back green → the research corpus is assertions, not
  facts, and the primary asset does not exist.
- Sandboxed content must have real storage, Service Workers or `crossOriginIsolated` → opaque
  origins can never provide these. Adopt the unique-origin model.
- VM-grade JS isolation with no DOM is required → QuickJS/WASM beats any iframe approach.
- Nobody maintains the research corpus → its value decays to zero and what remains is 286 lines
  anyone could rewrite.

### Consequences

1. Do **M1** of the backlog first (T1–T3 + CI). Until the suite runs, the case for continuing
   cannot actually be made from this repository. This is days, not months — the cheapest possible
   test of the premise.
2. Then **S1** and **S2**: the two claims that back the decision are currently false (worker
   isolation) and breachable (CSP injection, R11.3).
3. Re-scope **A3** as a *CSP-delivery* mode, not a unique-origin mode, per the finding above.
4. Do not build the commodity layer. Adopt Penpal (or its approach) for B1's RPC rather than
   hand-rolling message correlation; the differentiation is the isolation and VFS layers, not the
   plumbing. Confirm licence compatibility before committing.
5. Revisit this ADR when M1 completes, or if any flip condition is met.
