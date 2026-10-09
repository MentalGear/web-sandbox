# ADR-001: Continue `lofi-web-sandbox`, or adopt an existing solution?

**Status**: Proposed · **Date**: 2026-08-29

## Why this ADR exists

The repository contains three prior-art comparisons — [`COMPARISON.md`](research/COMPARISON.md),
[`COMPETITOR_ANALYSIS_2.md`](research/COMPETITOR_ANALYSIS_2.md) and
[`IMPROVEMENTS.md`](research/IMPROVEMENTS.md) — and **none of them asks whether to continue**.
Each ends with a verdict in our own favour ("occupies a specific niche", "fills a gap",
"Best for Local-First… scenarios") without ever stating what would *dis*qualify the project. The
first version of [`BACKLOG.md`](BACKLOG.md) inherited that assumption: 28 items about what to
build, none about whether to.

This ADR states the case for and against, and the conditions under which the answer flips.

## Correction to prior analysis

`COMPETITOR_ANALYSIS_2.md` credits `cross-origin-html-embed` with *"Strongest possible network
isolation (Unique Origins)"*. **That claim is wrong**, and it has been corrected in place.
Neither model dominates; they are stronger on different axes.

### Where the opaque origin (ours) is stronger

| | opaque origin (`srcdoc`) | unique origin (`uuid.sandbox.tld`) |
| :--- | :--- | :--- |
| Storage | **does not exist** — access throws | exists; must be purged per instance |
| Service Workers | **cannot be registered** — forbidden for a null origin | can be registered, and persists |
| Cookies | none | **domain-scoped, not origin-scoped** |
| Persistence | nothing survives a reload | state outlives the session unless cleaned |
| Failure mode | no control plane to get wrong | a uuid-reuse bug silently collapses isolation |

The cookie row is decisive and frequently missed: cookie scoping is by *domain*, not origin.
Sandboxed code that sets `document.cookie` with `domain=.sandbox.tld` writes a value readable by
**every other sandbox instance** on that domain. A "unique origin" does not confer a unique cookie
jar unless the domain sits on the Public Suffix List. The opaque origin has no cookie jar at all,
so the channel cannot exist.

Likewise Service Workers: the unique-origin model *permits* what
[finding 02](research/02_sw_tampering/README.md) is about and relies on uuid uniqueness to contain
it. The opaque origin closes it by construction — which is exactly the argument
[`ARCHITECTURE_COMPARISON.md`](research/ARCHITECTURE_COMPARISON.md) makes internally, and then
fails to apply to the competitor.

### Where they are genuinely stronger — and it is not origin strength

**CSP delivery.** Their policy arrives as an HTTP response header. Ours is a `<meta>` tag spliced
into a string. [Research 11](research/11_meta_csp_delivery/README.md) measured what that costs:
three directives silently discarded (11.1), a policy that evaporates if it lands outside the
parsed `<head>` (11.2), an injection that **user markup can delete outright** (11.3), and a small
pre-policy egress window that cannot be closed (11.4).

That is the real gap, and it is a delivery gap — not an isolation gap.

## The key architectural finding

**Origin opacity and header-delivered CSP are independent, and can be combined.**

A unique subdomain is *not* what produces isolation in their design — a real origin is the weaker
half of it. An `<iframe sandbox="allow-scripts">` pointed at a URL on your own host gets an
**opaque origin from the sandbox attribute**, while the document still carries **the CSP header of
the response that served it**. No wildcard DNS. No per-instance certificates. No uuid control
plane to get wrong.

So a host-served build would be strictly stronger than both current options:

| | local-first (today) | host-served + `sandbox` attr | unique origin (competitor) |
| :--- | :---: | :---: | :---: |
| Opaque origin | ✅ | ✅ | ❌ real origin |
| CSP as header | ❌ meta, see R11 | ✅ | ✅ |
| `frame-ancestors`, reporting | ❌ ignored | ✅ | ✅ |
| Deletable by user markup (11.3) | ❌ yes | ✅ no | ✅ no |
| Wildcard DNS + certs | ✅ not needed | ✅ not needed | ❌ required |
| Runs on `file://` / GitHub Pages | ✅ | ❌ needs header control | ❌ |

The cost is precise and limited: it requires a host that can set response headers. That is *not*
the same as "requires infrastructure" — a static host with a headers file (Netlify, Cloudflare
Pages) suffices. What is lost is `file://` and header-less static hosting such as GitHub Pages.

This reframes backlog item A3. Its value is **not** unique origins — those are a downgrade. Its
value is header-delivered CSP, and it should be scoped accordingly: a second delivery mode, not a
second origin model.

## Field scan — August 2026

The comparisons in this repo predate the 2025-26 wave of "run AI-generated code safely in the
browser" tooling. The entrants below were checked against primary sources on 2026-08-29; two
claims from the brief that prompted this scan did not survive verification.

| Project | Date | Licence | Traction | Mechanism | Renders untrusted DOM? |
| :--- | :--- | :--- | :--- | :--- | :---: |
| [`@tanstack/ai-isolate-quickjs`](https://tanstack.com/ai/latest/docs/code-mode/code-mode-isolates) | 2026-04 | MIT | TanStack | QuickJS→WASM isolate driver | **No** |
| [`vercel-labs/quickjs-wasi`](https://github.com/vercel-labs/quickjs-wasi) | 2026-03 | MIT | 113★ | QuickJS-NG→WASM, VM snapshot/restore incl. pending promises | **No** |
| [`reearth/zushi`](https://github.com/reearth/zushi) | 2026-05 | MIT | 3★ | QuickJS WASM for logic **+ sandboxed opaque-origin iframe for UI** | Yes |
| [`lifo-sh/lifo`](https://github.com/lifo-sh/lifo) | 2026-02 | MIT | 529★ | "browser-native OS"; POSIX VFS on **IndexedDB** | Not documented |
| [BrowserPod](https://browserpod.io/docs/more/licensing) (CheerpX) | 2026 | **Proprietary** | Leaning Tech | WASM runtimes; Linux tier via CheerpX slated end-2026 | Yes |
| `webpack-wasm-sandbox-plugin` | — | — | — | **Could not verify this package exists** | — |

### What the scan changes

**1. The field moved to logic-only isolation — which is a different tier, not a substitute.**
TanStack's own driver table states plainly that **no** driver provides DOM or UI rendering; they
execute TypeScript and bridge tool calls back to the host. `quickjs-wasi` is likewise a bare JS
engine. This repo's use case — rendering untrusted HTML and CSS — is not addressed by any of them.
They are candidates for the *logic tier* (backlog A4), not replacements for the iframe tier.

**2. `zushi` independently converged on this repo's target architecture.** A QuickJS WASM VM for
logic plus a sandboxed, opaque-origin iframe for UI, with postMessage as the only channel and
*"only data crosses these boundaries; code and live references do not."* That is meaningful
external validation of the two-layer split. But at 3 stars it is a **reference architecture, not a
dependency**, and its documentation covers neither CSP delivery nor virtual files — the two
hardest problems this repo has actually documented ([Research 11](research/11_meta_csp_delivery/README.md),
`RESEARCH_VFS_ACCESS.md`).

**3. `lifo` is the only real overlap with our differentiator — and it takes the opposite trade.**
It ships the browser VFS this repo is still building (C1–C3), with IndexedDB persistence. But
IndexedDB is unavailable to an opaque origin, so Lifo necessarily runs on a **real origin**: it
buys persistence by giving up opacity, and inherits every row of the opaque-vs-unique table above.
Its own framing is *"browser-level isolation, not VM-level"*, and no threat model or security
documentation was found. It competes on **features**, not on **threat model** — which is precisely
the distinction this project exists to make.

**4. BrowserPod is proprietary**, free only for personal and open-source use, with an Enterprise
licence for self-hosting and commercial use. That disqualifies it as a dependency here, and is
worth noting while this repo still has no licence of its own (backlog H5).

### Effect on this decision

The flip condition stated below — *a credible new entrant doing opaque-origin isolation with
header-delivered CSP* — is **not met**. Nothing found renders untrusted DOM in an opaque origin
with a header-delivered policy. The niche identified in the original comparisons still exists.

What *has* changed is that the logic tier is now a solved, MIT-licensed commodity. Backlog **A4**
(the QuickJS spike) should be upgraded from a speculative P3 bet to a concrete integration
evaluation, with `quickjs-wasi` and `@tanstack/ai-isolate-quickjs` as the candidates and `zushi`
as the reference for how the two layers meet.

## Hybrid strategy: adopt the commodity, keep the differentiator

The build-vs-adopt framing is a false binary. The defensible position is to buy the parts that
have become commodities and keep the parts nobody else is solving.

| Layer | Position | Rationale |
| :--- | :--- | :--- |
| **Transport / RPC** (backlog B1) | **Adopt Penpal**, or copy its shape | Promise-based `postMessage` correlation is solved, small and well-typed. Hand-rolling message envelopes is undifferentiated work, and `websandbox`, Penpal and Zoid all set the same bar. Our `MessageChannel` layer already exists — Penpal supplies the framing on top. Confirm licence compatibility first. |
| **Logic tier** (backlog A4) | **Adopt `quickjs-wasi` or the TanStack driver** | MIT, browser-capable, actively maintained by established teams. `quickjs-wasi`'s VM snapshot/restore also answers backlog B2's `reset()` far better than recreating a frame. Do not write a JS engine. |
| **UI / DOM tier** | **Keep — this is the project** | No entrant renders untrusted DOM in an opaque origin. This is the differentiator. |
| **CSP policy layer** | **Keep, and fix** | Research 11 shows the current delivery is breachable (S2) and lossy (S7). Nobody else solves it for the local-first case. |
| **Virtual files** | **Keep — but watch `lifo`** | Our VFS is opaque-origin-compatible; theirs is not. If they solve it under opacity, reassess. |
| **Full OS / Linux tier** | **Do not build** | BrowserPod and Lifo are years ahead and it is not this project's problem. |

The resulting shape matches `zushi`'s: a VM for logic, an opaque-origin iframe for UI, data-only
across the boundary. The difference is that this repo would carry the CSP and VFS work that zushi
leaves undocumented — which is exactly where its remaining originality lies.

## Are the alternatives actually substitutes?

| | Solves isolation? | Substitute? |
| :--- | :--- | :--- |
| **Penpal** | No — transport only; "agnostic (up to the user to configure the iframe)" | ❌ adopt it *and* still write the security layer |
| **JetBrains/websandbox** | Partial — leans on the `sandbox` attribute; weakens when `allow-same-origin` is needed | ❌ concedes the weakness findings 01/02/05 are about |
| **Zoid** | No — cross-domain UI widgets, not arbitrary code | ❌ |
| **cross-origin-html-embed** | Yes | ⚠️ only where wildcard DNS + SSL are available |
| **CodeSandbox / StackBlitz** | Yes | ⚠️ only as a hosted dependency |
| **QuickJS / WASM (Figma model)** | Yes, for logic | ⚠️ only where no DOM is needed |
| **`quickjs-wasi`, `@tanstack/ai-isolate-quickjs`** | Yes, for logic | ⚠️ logic tier only — **adopt as a component**, not a replacement |
| **`zushi`** | Yes — same two-layer split | ❌ 3★; reference architecture, and silent on CSP delivery and VFS |
| **`lifo`** | Feature overlap (VFS), real origin | ❌ different threat model; no documented security model |
| **BrowserPod** | Yes | ❌ proprietary licence |

Most "competitors" are not alternatives. Penpal and websandbox solve *transport*; this project
solves *isolation*. Adopting either leaves the security layer unwritten.

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
