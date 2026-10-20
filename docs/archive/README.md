# Archive

History, not current state. The code, [ARCHITECTURE.md](../../ARCHITECTURE.md), [API.md](../API.md), the
[ADRs](../README.md#decisions) and the [backlog](../BACKLOG.md) (open items only) say what holds now; what is kept here
says how it came to be. Nothing in the archive is edited to match the code: a statement here may be out of date, and
git history stays the final archive. Files were moved here, never deleted.

**IDs resolve here.** A comment or a doc cites a finding or a backlog item by its stable ID (`R5:M-2`, `BR:CB1`, `S44`,
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
- [CSP-Content-Security-Policy-settings.md](research/CSP-Content-Security-Policy-settings.md): general CSP background,
  superseded for this library by [ADR-007](../ADR-007-typed-origins.md).
- [Sandbox_Architecture_Decision.md](research/Sandbox_Architecture_Decision.md),
  [Virtual-Files-Security-Architecture.md](research/Virtual-Files-Security-Architecture.md): pointers left where byte-identical
  copies were removed.
