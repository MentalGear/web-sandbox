# Archive

History, not current state. The code, [ARCHITECTURE.md](../../ARCHITECTURE.md), [API.md](../API.md), the
[ADRs](../README.md#decisions) and the [backlog](../BACKLOG.md) (open items only) say what holds now; what is kept here
says how it came to be. Nothing in the archive is edited to match the code: a statement here may be out of date, and
git history stays the final archive. Files were moved here, never deleted.

**IDs resolve here.** A comment or a doc cites a finding or a backlog item by its stable ID (`R5:M-2`, `BR:CB1`, `BD1:ISO-1`, `S44`,
`BL:B5`; [CONTRIBUTING.md](../../CONTRIBUTING.md#code-and-docs-the-current-state)), and the registry
[ids.ts](../ids.ts) maps the ID to its file and anchor, in this folder for the reports and the done items.

## Reviews

The security review reports, newest last. Each finding has an anchor, and a prefix in the registry.

| Report | Prefix | Covers |
| :--- | :--- | :--- |
| [Adversarial review](reviews/ADVERSARIAL-REVIEW-2026-10.md) | `AR:` | 21 candidates by area (policy, channels, strict mode), and the follow-up audit |
| [Broad review](reviews/BROAD-REVIEW-2026-10-14.md) | `BR:` | Four reviewers: the guest's port announcement, bounded loading, guest-realm hardening, strict mode |
| [Focused review](reviews/FOCUSED-REVIEW-2026-10-14.md) | `FR:` | Two rounds on guest writes and the follow-up's fixes |
| [Independent verification](reviews/VERIFICATION-2026-10-14.md) | `VR:` | Five verifiers of the three reviews: mutations, black box, claims and CI, decisions |
| [Review round 1](reviews/REVIEW-ROUND-1-2026-10-15.md) | `R1:` | The first round under the stopping rule |
| [Review round 2](reviews/REVIEW-ROUND-2-2026-10-15.md) | `R2:` | Lifecycle model, change audit, documented limits measured |
| [Review round 3](reviews/REVIEW-ROUND-3-2026-10-18.md) | `R3:` | Whole RPC frames, the call budget, the view's time budget |
| [Review round 4](reviews/REVIEW-ROUND-4-2026-10-18.md) | `R4:` | The worker's only way out, values read once, the view's URL budget |
| [Review round 5](reviews/REVIEW-ROUND-5-2026-10-19.md) | `R5:` | The recurring classes behind the findings |
| [S74 review board, pass 1](reviews/BOARD-PASS-1-2026-10-20.md) | `BD1:` | Six reviewers (isolation, channels, limits, docs, tests, a newcomer) and three verifiers: 4 confirmed high; the owner's decision, 2026-10-21: fix what leaks data, backlog the rest (S77 to S82) |

## Renamed test files

The reports and the history files name the test files as they were when written: named after the review that added them. They are named by subject now (the finding IDs stay in the test titles), so search the left column of this table for an old name.

| Was | Is |
| :--- | :--- |
| `test/unit/broad-review-bootstrap.test.ts` | `test/unit/guest-realm-hardening.test.ts` |
| `test/unit/broad-review.test.ts` | `test/unit/fetch-and-csp-guarantees.test.ts` |
| `test/unit/focused-review.test.ts` | `test/unit/rate-limits-and-config.test.ts` |
| `test/unit/followup-guarantees.test.ts` | `test/unit/execution-budget-and-violations.test.ts` |
| `test/unit/owner-decisions.test.ts` | `test/unit/allow-forms-and-view-writes.test.ts` |
| `test/unit/review-round-1.test.ts` | `test/unit/relay-and-rpc-budgets.test.ts` |
| `test/unit/review-round-2-lifecycle.test.ts` | `test/unit/lifecycle-edge-cases.test.ts` |
| `test/unit/review-round-2.test.ts` | `test/unit/bootstrap-capture-and-measure.test.ts` |
| `test/unit/review-round-3.test.ts` | `test/unit/rpc-bounds-and-call-limits.test.ts` |
| `test/unit/review-round-4.test.ts` | `test/unit/worker-port-and-listeners.test.ts` |
| `test/unit/review-round-5.test.ts` | `test/unit/call-settling-and-read-once.test.ts` |
| `test/unit/verification.test.ts` | `test/unit/entry-sources-and-callbacks.test.ts` |
| `test/unit/view-round-5.test.ts` | `test/unit/strict-view-budget.test.ts` |
| `test/e2e/broad-review.spec.ts` | `test/e2e/guest-realm-hardening.spec.ts` |
| `test/e2e/broad-strict.spec.ts` | `test/e2e/strict-renderer.spec.ts` |
| `test/e2e/focused-review.spec.ts` | `test/e2e/inert-files-and-smil.spec.ts` |
| `test/e2e/owner-decisions.spec.ts` | `test/e2e/allow-forms-and-view-writes.spec.ts` |
| `test/e2e/review-channels.spec.ts` | `test/e2e/channel-isolation.spec.ts` |
| `test/e2e/review-followup.spec.ts` | `test/e2e/build-failure-and-console.spec.ts` |
| `test/e2e/review-policy.spec.ts` | `test/e2e/policy-injection.spec.ts` |
| `test/e2e/review-round-1.spec.ts` | `test/e2e/relay-and-rpc-budgets.spec.ts` |
| `test/e2e/review-round-2.spec.ts` | `test/e2e/foreign-document-and-view-time.spec.ts` |
| `test/e2e/review-round-3.spec.ts` | `test/e2e/log-errors-and-call-limits.spec.ts` |
| `test/e2e/review-round-4.spec.ts` | `test/e2e/worker-port-and-view-cost.spec.ts` |
| `test/e2e/review-round-5.spec.ts` | `test/e2e/error-cost-and-queued-calls.spec.ts` |
| `test/e2e/review-strict.spec.ts` | `test/e2e/strict-entry-scope-and-links.spec.ts` |
| `test/e2e/verification.spec.ts` | `test/e2e/worker-globals-and-termination.spec.ts` |
| `test/e2e/view-round-5.spec.ts` | `test/e2e/strict-view-budget.spec.ts` |

## ADRs

The [ADRs](../README.md#decisions) state each decision as it stands. What they said before, and how each decision changed
(the dated amendments, review by review), is kept here, verbatim, one file per ADR. The ADR links its file in its last line.
An amendment keeps its heading, so a link to `ADR-00N-history.md#amendment-…` leads to it.

| ADR | History | Holds |
| :--- | :--- | :--- |
| [ADR-001](../ADR-001-continue-or-adopt.md) | [ADR-001-history.md](adr/ADR-001-history.md) | the original status, the correction of the prior analysis, the first hybrid-strategy table and consequences |
| [ADR-002](../ADR-002-host-guest-broker.md) | [ADR-002-history.md](adr/ADR-002-history.md) | how the broker came to be built, and eight amendments: refusal codes, reserved methods, strict-mode renders, the channel, the announcement, byte budgets, whole frames |
| [ADR-003](../ADR-003-lifecycle-and-liveness.md) | [ADR-003-history.md](adr/ADR-003-history.md) | eight amendments: strict-mode bounds, listeners' reset or terminate, one rule per budget, the execution budget, bounded loading, the guest's check-in, the single `ready` flush |
| [ADR-004](../ADR-004-files-as-blob-urls.md) | [ADR-004-history.md](adr/ADR-004-history.md) | the Service-Worker design it replaced, the original decision and next steps, and the amendments: markup, module graph, CSS, strict mode, guest writes, load kinds, raster-image writes |
| [ADR-005](../ADR-005-strict-mode.md) | [ADR-005-history.md](adr/ADR-005-history.md) | the original decision, and the amendments by review: the renderer allowlist, the worker's globals, strict as the default, the view's budgets, the switches, the end of the entry |
| [ADR-006](../ADR-006-fetch-bridge.md) | [ADR-006-history.md](adr/ADR-006-history.md) | four amendments: the platform validates the request, the method bound to its build, one refusal text, one origin parser |
| [ADR-007](../ADR-007-typed-origins.md) | [ADR-007-history.md](adr/ADR-007-history.md) | the guard-rail pipeline the template replaced, the list of what was deleted, the migration table, the strict-default amendment |

## Backlog

- [BACKLOG-done.md](backlog/BACKLOG-done.md): every finished item of the backlog (`S`, `T` and the `B`, `C`, `D`, `H`
  series), verbatim with its anchor, and the capability snapshot as it stood on 2026-10-19.

## Research

Loose notes and finished designs from before the current architecture. Most describe the Service-Worker design that
[ADR-004](../ADR-004-files-as-blob-urls.md) replaced, or compare this library with others as they were then. The
reproductions and design probes of [docs/research](../research/README.md) (01 to 19) stay where their specs run.

- [blob-delivery-probe.md](research/blob-delivery-probe.md): the measurements behind [ADR-004](../ADR-004-files-as-blob-urls.md)
  (blob-URL file delivery); the code that applies them cites its sections.
- [COMPARISON.md](research/COMPARISON.md), [COMPETITOR_ANALYSIS_2.md](research/COMPETITOR_ANALYSIS_2.md): comparisons with
  other sandbox libraries, before [ADR-001](../ADR-001-continue-or-adopt.md)'s field scan.
- [IMPROVEMENTS.md](research/IMPROVEMENTS.md): the early roadmap, replaced by the backlog.
- [ARCHITECTURE_COMPARISON.md](research/ARCHITECTURE_COMPARISON.md), [VIRTUAL_FILES_SECURITY_ANALYSIS.md](research/VIRTUAL_FILES_SECURITY_ANALYSIS.md),
  [VIRTUAL_FILES_PLAN.md](research/VIRTUAL_FILES_PLAN.md), [VFS_ARCHITECTURE.md](research/VFS_ARCHITECTURE.md),
  [RESEARCH_VFS_ACCESS.md](research/RESEARCH_VFS_ACCESS.md), [SW-verify-before-update.md](research/SW-verify-before-update.md):
  the Service-Worker virtual-files design and its analysis.
- [LOCAL_FIRST_ARCH.md](research/LOCAL_FIRST_ARCH.md), [BROWSER_COMPATIBILITY.md](research/BROWSER_COMPATIBILITY.md),
  [RESOURCE_QUOTAS.md](research/RESOURCE_QUOTAS.md), [RESEARCH_SANDBOXING.md](research/RESEARCH_SANDBOXING.md),
  [DEVTOOLS_SECURITY.md](research/DEVTOOLS_SECURITY.md): early architecture and design notes.
- [CSP_CONFIG_RATIONALE.md](research/CSP_CONFIG_RATIONALE.md): why `'unsafe-inline'` and not nonces, in the design the guest policy
  template replaced ([ADR-007](../ADR-007-typed-origins.md)).
- [CSP-Content-Security-Policy-settings.md](research/CSP-Content-Security-Policy-settings.md): general CSP background,
  superseded for this library by [ADR-007](../ADR-007-typed-origins.md).
- [Sandbox_Architecture_Decision.md](research/Sandbox_Architecture_Decision.md),
  [Virtual-Files-Security-Architecture.md](research/Virtual-Files-Security-Architecture.md): pointers left where byte-identical
  copies were removed.
