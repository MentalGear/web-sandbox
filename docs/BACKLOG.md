# Backlog

The open work on `web-sandbox`: what is not done, is deferred, waits for a decision or is in progress, and the limits
documented as accepted. Finished items keep their anchors in [the archive](archive/backlog/BACKLOG-done.md); a cited
ID (`S6`, `BL:B5`) resolves in this file or there ([ids.ts](ids.ts)). The current state of the library is in
[ARCHITECTURE.md](../ARCHITECTURE.md) and [API.md](API.md), not here.

Whether this project should continue at all, rather than adopting an existing solution, is answered separately in
[ADR-001](ADR-001-continue-or-adopt.md). This backlog assumes its conditional "continue".

**Priority**: P0 blocks everything else · P1 next · P2 planned · P3 opportunistic.
**Effort**: S ≈ hours · M ≈ days · L ≈ week+.

## Open items

| Item | Status | What |
| :--- | :--- | :--- |
| [S49](#s49) | ⏳ open (P3 · M) | Fold worker mode into strict mode with `entry` |
| [S60](#s60) | ⏸️ after we are done | Repository and docs clean-up (stale files and branches) |
| [S69](#s69) | 💤 deferred | Build the relay worker; availability findings are documented (owner, 2026-10-19) |
| [S70](#s70) | ⏸️ decide | For the owner: three edges the schema found |
| [S74](#s74) | ⏸️ after every phase | The final independent adversarial review board |
| [S76](#s76) | ⏸️ in progress | Self-explaining code and generated docs: steps 0 to 4 done; code comments and the public API follow |
| [D1](#bl-d1) | 🟡 ready except the licence | An installable package; waits for H5's `LICENSE` |
| [H5](#bl-h5) | 🟡 partly done | Missing repo basics: the `LICENSE` is the owner's choice |
| [S8](#s8), [S25](#s25), [S36](#s36), [S44](#s44) | documented | Limits stated as accepted: the pre-policy egress window, guest `__proto__` keys, focus and clipboard, and cooperative mode's frozen list of limits |

Done items, review rounds and the capability snapshot are in [the archive](archive/backlog/BACKLOG-done.md).

---

## S · Security & Correctness

### <a id="s8"></a>S8 · Pre-policy egress window — **P3 · accepted risk** (cooperative mode; a limit, S44)

*2026-10-15*: a cooperative-mode limit. Strict mode's view document holds only the policy and the library's script
when it is parsed, and guest markup reaches it later, rendered under the policy.


*From [Research 11.4](research/11_meta_csp_delivery/README.md).*

**Verified**: in 1 of 5 runs a request reached the network from the transient `about:blank`
document, before the meta policy took effect. It is racy and **branch-independent** — it appeared
on the well-formed document, which takes the safest injection path. The CSP violation was still
logged, so the resource was blocked from *use*; the request itself still left, which is sufficient
for exfiltration where the URL is the payload.

**No mitigation exists under `<meta>` delivery** — the window is inherent to the mechanism. It
closes only under header delivery, where the policy arrives with the response carrying the content.
Tracked as a known limitation; see [ADR-001](ADR-001-continue-or-adopt.md).

### <a id="s25"></a>S25 · Guest data can carry own `__proto__` keys — **documented** (by design)

*From the review, B8.*

Structured clone keeps an own `__proto__` key (measured in all three engines), so call arguments, results and
`sandbox-log` args from the guest can hold one. Reading such an object is safe, and it never changes
`Object.prototype`; merging it with `Object.assign` sets the target's prototype. Documented next to `expose()` and
`sandbox-log` in the README; `deepMerge` (the element's own config merge) skips the key (S20). Asserted:
`test/e2e/channel-isolation.spec.ts` ("B8").

### <a id="s36"></a>S36 · Focus, clipboard and messages to the host window — **documented** (a cooperative-mode limit, S44)

*From the broad review, PD5 (medium) and PD7 (low).*

Guest code can take focus from the host page (Chromium, Firefox) and, after a user's click in the guest, write the
clipboard (Firefox `writeText()`, Chromium and Firefox `execCommand('copy')`): measured and asserted per engine. The
guest can post messages to the host window; the playground now checks `event.source`, and README and API.md say so.

### <a id="s44"></a>S44 · Cooperative-mode limits, one frozen list — **documented** (limits)

*From the independent verification, V3 and H1 (measured), with the earlier residuals gathered here; frozen on
2026-10-15 with S48.* The one list, the same in the [README](../README.md#cooperative-mode-limits) and
[API.md](API.md#modes).

**Policy**: cooperative mode is for cooperative content. No new guest-realm patch is made there; a new finding in
cooperative mode is added to this list as a limit (the hardening already in the guest realm, S35, stays). None of these
applies in strict mode, the default; worker mode shares only the reports item.

- same-thread execution: where the frame shares the host page's thread (WebKit always, Chromium in some environments),
  a guest loop freezes the host page and no watchdog can stop it (S6);
- a frame the guest creates is a realm of its own: WebRTC (S13), WebKit's host URL as referrer (S17), Firefox's
  keepalive fetch (S35), history traversal (S35), a frame name the host targets (S35); `frame-src 'none'` refuses
  frames that load a URL, not frames made from markup;
- a worker the guest creates (from its document or a frame it creates): Firefox sends its `EventSource` and loads its
  `FontFace` past the policy (S43);
- WebKit opens a connection for `<link rel=preconnect>` (S35);
- focus (Chromium, Firefox) and, in a user's click, the clipboard (`writeText()` in Firefox and, in the click's own
  handler, WebKit; `execCommand('copy')` in Chromium and Firefox) (S36);
- messages to the host window; embedders check `event.source` (S36);
- the user's Ctrl-, Shift- or middle-click, or Ctrl/Shift+Enter, on a guest link opens a new tab at the guest's URL
  in Chromium and Firefox, without `allow-popups`, as for any sandboxed frame (Playwright's WebKit opens none, a
  measurement limit); so does a modifier click the guest's script synthesizes (Chromium with no gesture where its
  popup blocker lets it, Firefox within a user's activation), and Chromium submits a form that way past `form-action`
  (S53, R2-2), so `allow-forms` is an unsafe capability (S54);
- the host page's Trusted Types requirement reaches the guest: its scripts, the import map and the markup the bootstrap
  writes for registered files need Trusted Types too (S50);
- the guest's fragment navigations add entries to the tab's session history (every engine), and a navigation the
  wrapper refuses adds one in Chromium;
- guest-only stalls (the CB3 class): a guest that never finishes its document stays `ready` and its calls time out;
  Firefox's `<meta refresh>` replaces the guest with a document that announces nothing (S32); the watchdog ends either
  where it is on;
- forgeable reports: every `violation` report comes from the guest's realm, and a frame the guest creates reports to
  itself (S5);
- the host page's URL and origin: the pre-policy window of a `<meta>` policy over guest markup (S8), the host origin in
  `ancestorOrigins` and image `Referer` (S15), and WebKit's full host URL to same-site origins when asked (S18).

**What strict mode, the default, does not cover** (every default user; the same list in the README and API.md): host-page
availability wherever the view shares the host page's thread (S42, S52), CSS within the policy, worker violation reports per engine and guest-influenced,
a worker that closes itself (only the watchdog notices), memory, and the host site's cookies on requests to allowed
origins that are same-site with the host page (Firefox and WebKit, observed by the verification; every mode).

Tests: `worker-globals-and-termination.spec.ts` ("V1 … residual", "V3", "H1"), `guest-realm-hardening.spec.ts` (PD2–PD8), `webrtc.spec.ts`,
`host-url.spec.ts`, `watchdog.spec.ts`.

### <a id="s49"></a>S49 · Fold worker mode into strict mode with `entry` — ⏳ **open** (P3 · M)

Worker mode is frozen as it is (S48). It duplicates strict mode without a view: a worker inside the frame, the same
worker-globals allowlist (S43), code only through `execute()`. What differs, and what folding has to decide:
`importScripts` from origins in `origins.scripts` (strict mode takes no `scripts`); nested workers, which worker mode
lost with the allowlist (S43), so nothing to keep; `WebAssembly`, which worker mode keeps (WebKit compiles it without
`'unsafe-eval'`) and strict mode keeps only with `scriptUnsafe`; and a headless strict build (no view, or a hidden
one). Until then worker mode gets no new features.

### <a id="s60"></a>S60 · Repository and docs clean-up, then independent adversarial reviews — ⏸️ **after we are done**

Once the review rounds end: a proper clean-up of the repository and the docs:
- stale files and branches;
- docs that grew by amendment, consolidated into their current state;
- research notes indexed;
- the backlog compacted.

The independent adversarial reviews by sub-agents of other model families (Sonnet and Haiku) are folded into the
final review board (S74, owner, 2026-10-19), which reviews the cleaned-up repository and docs.

### <a id="s69"></a>S69 · Build the relay worker — 💤 **deferred** (owner, 2026-10-19: availability findings are documented)

The relay closes the worker side of class E-cpu: it moves the cost of the guest's floods off the host page. Those
floods are already bounded: the worker's own `postMessage()` is gone (round 4, M-1), and the uncaught budget ends the
sandbox past its rate (`src/lib/egress.ts`). Under the owner's rule for availability findings (CONTRIBUTING.md,
"Availability findings"), what remains is documented, and the relay is kept as a design to build if the bound is ever
found not to hold.

Research 19's plan:
1. A stringified relay that mints and revokes the guest's URL.
2. One typed frame protocol from guest to relay, charged to the existing budgets.
3. A byte cap per engine after which the relay ends the guest.
4. The relay cancels every error.
5. The rejection budget stays in the guest realm.
6. The view stops listening on the guest's `Worker`.
7. Worker mode after its own probe.
8. The floods as e2e tests, plus a test that a guest which subverts its prelude still cannot exceed a budget.

This closes the worker side of E-cpu and G by construction ([research 18](research/18_finding_classes/README.md)).

### <a id="s70"></a>S70 · For the owner: three edges the schema found — ⏸️ **decide**

- **String fetch request bodies.** A string body is measured at 2 bytes per character. With `fetchBridge.maxBytes` above
  about 16.5 MiB, a string body over about 17.3 million characters is refused `ARGS_NOT_TRANSFERABLE` by the guest's
  broker before it reaches the bridge, although API.md allows request bodies up to 32 MiB. Clamp `maxBytes` for string
  bodies, or document it.
- **A tiny `watchdogTimeout`.** A value such as 0.001 ms may end a healthy guest. Measure it, then set a floor or document it.
- **`mode: null`.** Its capabilities are filtered as strict mode's before the config is refused. This is harmless; it
  is kept as it was.

### <a id="s76"></a>S76 · Self-explaining code, generated reference docs: review the current state — ⏸️ **before S60** (owner, 2026-10-19)

The owner's direction: code that mostly explains itself, with strong types and comments where they are needed, and the
reference docs generated from it. A review first (reported to the owner before anything changes), against five points:
1. **Types that carry the rules.** Where an invariant can be a type, the wrong code does not compile: what is typed
   today (typed origins, the branded `RpcFrame`, the reducer's input and effect unions) and what could be (readonly
   state, branded generations, exhaustive `never` checks, option types narrower than `unknown`).
2. **TSDoc on the public surface, the reference generated from it.** Measure the coverage of `src/index.ts`'s exports.
   Evaluate api-extractor, which generates the reference and a checked-in public-API report that fails CI on an
   unreviewed change (the owner's rule that public names need approval, by construction), against TypeDoc.
3. **Data in code, docs rendered from it**, each with a doc-sync test: `CONFIG_SCHEMA`, `CHANNEL_BUDGETS` and the egress
   table do this already; list the docs that still restate code by hand (limits, reasons, events, host lines).
4. **Comments that say why, briefly.** Many comments tell a fix's history (the round, the measurement, the commit).
   Measure it, and propose a convention: the current reason plus a link to the finding or ADR, with history kept in the
   review reports and ADRs.
5. **Handwritten docs only where code cannot explain:** the threat and security model, ADRs, research, the README's
   tutorial. Which parts of API.md become generated.

Output: a report with measurements and a migration plan in PR-sized steps, for the owner. S60's clean-up applies its
outcome.

**The plan (owner, 2026-10-19).** The code and the docs state the current state only; history is archived, and reached
on demand through stable IDs. Four layers, each linking to the one below:
- **Code:** types, TSDoc and short comments. A comment says what holds now and why, plus a stable ID to the decision
  or finding (`ADR-005#…`, `R5:M-2`). Measured numbers stay only where they justify a constant today.
- **Reference:** generated. api-extractor and api-documenter for the public surface, with a checked-in API report
  that fails CI on an unreviewed public change. Tables rendered from code for config, limits, budgets, reasons and
  events.
- **Current docs:** handwritten prose, with generated regions. README, a new one-page ARCHITECTURE.md, the security
  and threat model, and ADRs that state each decision as it stands.
- **Archive:** `docs/archive/` holds review reports, finished research, done backlog items and superseded ADR text.
  Git history stays the final archive.

Steps, one PR each, merged when green:
0. **Measure.** This review, reported to the owner.
1. **Conventions and guards.** A CONTRIBUTING section on comments and docs, with the ID scheme. A link check: every ID
   resolves. A history-pattern ratchet: SHAs, "before", "at round N" and the like; the count may only go down.
2. **Generated docs.** A small `bun run docs:gen`, using the TypeScript compiler API, rewrites only
   `<!-- generated:begin … -->` regions. It renders:
   - realms and the code each runs;
   - channels and frames, from the frame and egress tables and `CHANNEL_BUDGETS`;
   - the lifecycle's states, inputs and effects from the reducer's types, and a Mermaid state diagram from exploring
     the pure `reduce`;
   - config, limits and reasons;
   - the module map.

   CI regenerates the docs and fails on any difference, so every structural change shows in its PR's diff. Handwritten
   sections declare what they describe (`<!-- describes: channel:view-port, input:frameLoad -->`), with a hash of
   those items' semantic signature only (names, types, values, transitions; never formatting). When an item changes,
   the sections that describe it fail CI until they are reviewed (`docs:gen --accept`). If the markers prove noisy,
   they are dropped without losing the rest. ARCHITECTURE.md is the first document built this way.

   **The tool is built in two parts.**
   - **A generic engine** in `tools/docgen/`, about 200 lines. It rewrites regions, checks markers against hashes, and
     runs in `--check` and `--accept` modes. It knows nothing about this repository: extractors are plugins returning
     items `{ id, signature, render }`. It stays in this repository behind that boundary, and becomes a package once a
     second project needs it. Cog, markdown-magic and embedme rewrite regions, but none flags stale prose.
   - **Extractors, each next to the code it reads.** Built in order of value:
     1. API.md's remaining tables: limits, reasons, events and their details, host log lines, error codes, capability
        lists, each mode's CSP.
     2. ARCHITECTURE.md.
     3. BACKLOG.md's status table, from the item headers.
     4. The ADR and research indexes, from each file's header.
     5. The class registry (class, chokepoint, structural test) as data. Research 18 and CONTRIBUTING render it, and a
        test checks that every class has its structural test.
     6. API.md (d): the closed list of what the cost bound leaves out.

     Measured numbers are never generated: they vary from run to run. The docs state the bound from code, the tests
     assert it, and measurements stay in test output and the archive. Prose that explains why (ADR reasoning, the
     threat model's argument, the README tutorial) gets markers only.
3. **The archive.** Move the reports and research, and compact the backlog to open items. The research reproductions
   stay runnable (Playwright's `testMatch`), and the link check keeps every link.
4. **ADRs.** Each states its current decision; its amendment trail moves to the archive, linked.
5. **Code comments, file by file**, largest first: `host.ts`, `in-sandbox-view.ts`, `in-sandbox-script.ts`, then
   `lib/`. Each comment is rewritten to the current reason plus a link, and any history worth keeping moves into the
   matching archived report. The ratchet keeps history out.
6. **The public API.** TSDoc on every export and the api-extractor report. API.md's reference parts become
   generated; its guide parts stay handwritten.

S60's remaining clean-up (stale files and branches) follows, then the review board (S74), which reviews the current
state.

**Step 3 done (2026-10-20).** The review reports, the finished research notes and the done items of this backlog are in [`docs/archive/`](archive/README.md); every ID resolves there through [ids.ts](ids.ts).

**Step 4 done (2026-10-20).** Each of the seven [ADRs](README.md#decisions) states its decision as it stands: the context, the decision and its reasoning, the alternatives and the consequences, with the current status in its header. The amendment trails and the first texts they replaced are in [`docs/archive/adr/`](archive/README.md#adrs), one file per ADR, verbatim, and each ADR links its file in its last line. Where an ADR disagreed with the code, the code won (the sizes and counts, the lifecycle reducer, the policy template, the config types).

**Step 0 done (2026-10-19), and the owner's decisions on it.** The measurement report has the counts. In short:
- 60% TSDoc coverage of the public surface;
- no exhaustive `never` check;
- ADR-005's port table has drifted by 7 frame types;
- 713 finding-ID citations, 358 of them ambiguous;
- 174 KB of done items in this backlog;
- api-extractor works on `dist/*.d.ts`, and TypeDoc cannot run here.

The owner adopted all of the report's recommendations:
- **A. The plan's amendments.**
  1. The api-extractor gate comes first.
  2. The frame table and the realms registry are written as code before ARCHITECTURE.md.
  3. Input preconditions per state are declared before the state diagram is drawn.
  4. Research 01–15 stay where they are; only loose notes are archived.
  5. The ratchet takes only the strict history patterns (SHAs, dates, rounds, named reviews, "measured at", "used to",
     "no longer").
  6. An ID registry with anchors, so that `R5:M-2` resolves.
  7. Test files named after review events are renamed by subject, and the finding IDs stay in the test titles.
  8. TSDoc is rendered into the docs only after its history has been cleaned.
- **Single source of truth, by construction: values first, types derived from them.** Anything a doc renders exists as
  a runtime value: `CONFIG_SCHEMA`, `CHANNEL_BUDGETS`, the egress table, and the new `FRAMES` table, realms registry and
  registries for limits, reasons and host lines. The types are derived from those values (`as const`, `typeof`,
  `satisfies`), so the generator imports values and needs no compiler.
  - **The reducer.** Its input and effect kinds, and which inputs may arrive in which state, are declared once as data.
    `LcInput` and `Effect` are derived from it. `reduce` asserts the preconditions, the state diagram is drawn from them,
    and the model checks against them. No unstable compiler API is used, and no TypeScript version is pinned.
  - **Public signatures** come from api-extractor's model of the compiled `.d.ts`, and its checked-in report gates them.
  - **The drift checks.** CI regenerates every region and fails on a difference. Exhaustive `never` checks and
    `satisfies` catch a value and its use disagreeing.
- **B. Measured numbers.** A doc states each bound itself, rendered from code and checked by tests. A measured figure
  may stand beside the bound as an example, with its date and engine, but is never generated and never pinned by a test.
  The pin at `worker-port-and-listeners.test.ts:492` goes.
- **C. Public names.** `StrictSandboxConfig`, `CooperativeSandboxConfig`, `WorkerSandboxConfig`, `WebSandboxEventMap`
  and `RpcLibraryCode` are exported as types. `ALLOWED_CAPABILITIES` is marked internal. `ElementBase` is hidden from the
  declaration files.
- **C, continued (owner, 2026-10-19).** `SandboxConfigOptions`, the base the three mode configs extend (the options
  every mode takes), is exported too, so the API report has no forgotten export.
- **The budgets table's cost column (owner, 2026-10-19, following B).** The column rendered from `CHANNEL_BUDGETS`
  states bounds only (a share, a cap, a constant). The measured figures move to a handwritten note under the table,
  dated and naming the engines. Done in step 2b.
- **D.** The public `FetchRecord` becomes a union keyed by `outcome`, in step 6.
- **E.** A threat-model document is written new, in the current-docs layer. Done: [THREAT-MODEL.md](THREAT-MODEL.md),
  in current-state wording.

### <a id="s74"></a>S74 · A final independent adversarial review board — ⏸️ **after every phase is done** (owner, 2026-10-19)

Once S65, the rest of S61, S76 and S60 are merged: an independent adversarial review board of the whole repository and its
docs, with reviewers from several model families (Opus, Sonnet and Haiku; S60's independent reviews are folded in). The
board clears after **two consecutive passes with no finding of high severity or above** (a stricter severity floor than
the review rounds' medium, as the owner set it). Findings are fixed as before: by class, each naming its class and
extending its chokepoint and structural test (CONTRIBUTING.md, "Fixing a finding"), after the owner has seen them.
A finding whose only effect is a bounded cost to the host page that the embedder can end is at most medium, and is
documented rather than mitigated (CONTRIBUTING.md, "Availability findings").

---

## D · Packaging & Distribution

### <a id="bl-d1"></a>D1 · Ship an installable package — 🟡 **ready except the licence**

**Done**: public entry `src/index.ts`; `exports` / `types` / `main` point at `dist/`, built by
`bun run build:lib` (bun bundle + `tsc` declarations). `scripts/smoke-package.sh` runs `bun pm pack`,
installs the tarball into a scratch project, type-checks and bundles a consumer (CI). The e2e spec
`test/e2e/package.spec.ts` mounts a sandbox from `dist/` under a custom tag. **Open**: `private: true`
stays until H5's licence is chosen.

Every solution we compare against installs with one command. We do not install at all, which caps
adoption regardless of how good the isolation is.

**Verified in `package.json`**: `"private": true`; `"main": "dev-server.ts"` — **a file that does
not exist**; no `exports`, no `types`; `build-dist` emits JS without declarations. `README.md`
also documents a `server.ts` that does not exist (the dev server is a Vite plugin in
`vite.config.ts`).

**Work**: drop `private`, add `exports` + `types` with declaration emit, fix `main`, align the
README with the real entry points.

**Acceptance**: a packed tarball imports cleanly in a scratch project with working types, and a
smoke test mounts a sandbox through the public entry point (with B4).

---

## H · Repo & Docs Hygiene

### <a id="bl-h5"></a>H5 · Missing repo basics — 🟡 **partly done**

**Done**: `CONTRIBUTING.md`; `format` / `format:check` scripts; `.prettierrc` stripped of the Svelte
and Tailwind plugins it was copied with. `format:check` is not a CI gate yet (101 files predate the
config). **Open**: the `LICENSE` — the owner's choice, and it still blocks dropping `private` (D1).

No `LICENSE`, no `CONTRIBUTING.md`, and `.prettierrc` exists with no `format` script and no
formatting check. **Work**: add a license (blocks D1 — publishing without one is a non-starter),
a short contributing note, and `format` / `format:check` scripts.

---

## Parity Reference

Where the items above come from. This table covers the solutions named in the repo's original
comparisons; for the 2026 entrants (`quickjs-wasi`, `@tanstack/ai-isolate-quickjs`, `zushi`,
`lifo`, BrowserPod) see the
[field scan in ADR-001](ADR-001-continue-or-adopt.md#field-scan--august-2026). Legend: ✅ shipped · 🟡 partial · ❌ missing · ➖ n/a by design.

| Capability | web-sandbox | websandbox | Penpal | Zoid | cross-origin-embed |
| :--- | :---: | :---: | :---: | :---: | :---: |
| Isolation with no server config | ✅ opaque origin | 🟡 | ➖ | ➖ | ❌ wildcard DNS |
| Private `MessageChannel` | ✅ | ❌ | 🟡 | ✅ | ❌ |
| Promise-based RPC | ✅ **B1** | ✅ | ✅ | ✅ | ➖ |
| Typed package / `d.ts` | 🟡 **D1** | ✅ | ✅ | ✅ | ✅ |
| Headless (worker) execution | ✅ **S1** | ❌ | ❌ | ❌ | ❌ |
| Virtual files | ✅ **C1** | ❌ | ➖ | ❌ | ❌ |
| Host-mediated network | ✅ **B5** | ❌ | ➖ | ✅ | ❌ |
| Auto-sizing | ✅ **B6** | ❌ | 🟡 | ✅ | ✅ |
| Execution quotas | ✅ **S6** (time, strict mode; memory open) | ❌ | ➖ | ❌ | ➖ |

We lead on four rows: isolation without server config, headless (worker) execution and virtual
files outright, and execution quotas as the only solution with any support (a time bound on every
engine in strict mode; memory is still open). Those four,
plus the private channel (matched only by Zoid), are the rows the backlog must not regress.

Larger bets that follow from the same comparison, both **P3**: an **opt-in host-served mode** that
delivers CSP as an HTTP **header** while keeping the opaque origin via the `sandbox` attribute —
which closes S7, S8 and most of S2 at once, and needs no wildcard DNS (see
[ADR-001](ADR-001-continue-or-adopt.md); note this is *not* the unique-origin model, which is a
downgrade on the origin axis); and
a **logic tier evaluation** (upgraded from a speculative spike): as of the
[2026-08 field scan](ADR-001-continue-or-adopt.md#field-scan--august-2026) this is a solved,
MIT-licensed commodity — evaluate [`vercel-labs/quickjs-wasi`](https://github.com/vercel-labs/quickjs-wasi)
(VM snapshot/restore, which also serves B2's `reset()`) and `@tanstack/ai-isolate-quickjs`, with
[`reearth/zushi`](https://github.com/reearth/zushi) as the reference for how a QuickJS logic tier
meets an opaque-origin UI tier. Do not write a JS engine.

---

## Rejected / Out of Scope

| Proposal | Source | Why not |
| :--- | :--- | :--- |
| Wildcard DNS + SSL as the **default** | `cross-origin-html-embed` | Destroys the local-first property, the one thing no competitor offers. Opt-in only. |
| Iframe-scoped Service Worker ("hub" model) | Considered internally | Needs a sandbox origin that can register SWs, re-opening privilege escalation. See [`ARCHITECTURE_COMPARISON.md`](archive/research/ARCHITECTURE_COMPARISON.md). |
| Service-Worker VFS (host-level hub) | The original virtual-files design | Never served a file: the opaque-origin `srcdoc` guest is never a client of any Service Worker. The worker was also served as untranspiled TypeScript, partitioned as a third-party iframe, and lost files sent before it loaded. Replaced by guest-realm blob URLs, [ADR-004](ADR-004-files-as-blob-urls.md). |
| Service Worker update integrity (was C4) | [`SW-verify-before-update.md`](archive/research/SW-verify-before-update.md) | No Service Worker is left to protect (ADR-004). |
| `allow-same-origin` for API compatibility | `websandbox` | Root cause of findings 01, 02 and 05. Enforced by T2's deny-list test. |
| Agent runtime in the trusted base | [`RESEARCH_SANDBOXING.md`](archive/research/RESEARCH_SANDBOXING.md) | Keep the base dumb; agents load as user code so their bugs stay inside the sandbox. |
| BrowserPod / CheerpX as a dependency | [2026-08 field scan](ADR-001-continue-or-adopt.md#field-scan--august-2026) | Proprietary licence — free only for personal and open-source use. Disqualified as a dependency. |
| Building a full OS / Linux tier | Same | BrowserPod and `lifo` are years ahead, and it is not this project's problem. |
| Writing our own JS engine / VM tier | Same | `quickjs-wasi` and `@tanstack/ai-isolate-quickjs` are MIT and maintained. Adopt, don't build. |
| Nonce-based CSP instead of `'unsafe-inline'` | General best practice | No benefit under an opaque origin with immutable `srcdoc` CSP — [`CSP_CONFIG_RATIONALE.md`](CSP_CONFIG_RATIONALE.md) §3. |
| App identity from a hash of the source | [Lunet](https://gozala.io/lunet) | The embedder already knows what it loaded; two tenants with identical code would share storage, and any edit loses the data. If storage needs scoping, the embedder passes a namespace. |
| Declarative argument rules per method (UCAN policy) | [Dialog DB](https://github.com/dialog-db/dialog-db) | In UCAN a third party writes the policy; here the embedder writes both policy and handler, so checking arguments in code is strictly more expressive. |
| Method-first names so read-only is a prefix | Dialog DB | There are no grants to narrow; an exposed name is the whole grant. |
| UCAN delegation between host and guest | Dialog DB | One host, one guest, no third party: holding the one-shot port already is the authority. Would add keys, signatures and a clock to a self-contained broker. |
| React/Vue adapters (was part of D3) | Backlog D3 | Owner's decision: a custom element already works in every framework, and wrappers would be a second API surface to keep in step with the element. |
| Server-side session quotas (rate limit, TTL, LRU) | [Finding 08](research/08_session_exhaustion/README.md), `IMPROVEMENTS.md` §1 | The local-first architecture has no server. Becomes P1 the moment a hosted mode ships; recorded so the requirement is not lost with the server that was removed. |
