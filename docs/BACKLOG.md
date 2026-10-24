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
| [S76](#s76) | ⏸️ in progress | Self-explaining code and generated docs: steps 0 to 6 done; the owner reviews the outcome |
| [S79](#s79) | ⏳ open (P2 · M) · medium | Desktop Chromium: the view's liveness ping ends a healthy sandbox on one documented stall (S74 board BD1:LIM-2) |
| [S80](#s80) | ⏳ open (P2 · S) · medium | The event-read scan was never built; reverting R5:N-2 and R5:N-6 passes the suite (S74 board BD1:TST-1) |
| [S81](#s81) | ⏳ open (P3 · S) · low | Tests that fail under heavy machine load (S74 board BD1:CO-1, BD1:NEW-13) |
| [S82](#s82) | ⏳ open (P3 · M) · low | The S74 pass 1 lows, as one checklist; the docs-only ones are marked |
| [S83](#s83) | ⏳ open (P2 · S) · high (reviewer; medium by the availability rule) | A rejected `Symbol` or `BigInt` is counted as 0 characters by the uncaught budget; on Firefox the host page stalls (S74 board BD3:LIM-1, an incomplete part of the fix of BD1:LIM-1) |
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
`sandbox-log` in the README. The element merges no guest data into its own state: its configuration goes through the
config schema, which stores own data keys only (S20; `deepMerge` in `src/lib/utils.ts` is not used by the element). Asserted:
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

**Step 6 done (2026-10-20).** Every export of `src/index.ts`, every member of its classes and interfaces, every parameter and every returned value has its TSDoc: behaviour, units, defaults, bounds, what refuses or throws, which event fires. `test/unit/tsdoc-coverage.test.ts` fails on a gap, reading api-extractor's doc model, which is checked in as [`etc/web-sandbox.api.json`](../etc/web-sandbox.api.json) beside the API report (`bun run api:update` writes both; `api:check` fails when either is stale), so the docs generator needs no build. API.md's reference parts are regions rendered from that TSDoc by `tools/docgen/extractors/api.ts`: the registration, the element's property and methods, the events with their details, the `fetchBridge` and `callLimits` option types, and the lists of exports. The guide parts stay handwritten, and a section that describes an export carries an `api:` marker. Decision D: `FetchRecord` is a union keyed by `outcome`, written out in its type alias so that the public surface gains no name; `FETCH_OUTCOMES` is the runtime list, and `record()` builds each member in an exhaustive switch.

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
board is **clean** (owner, 2026-10-21) when none of a pass's confirmed findings leaks data or can manipulate it, at
any severity, a documentation gap that leads embedders into such a leak included. DoS and availability-only findings
are backlogged and do not count against a pass. Docs drift, test gaps and correctness bugs with no data effect do not
count either, and are fixed right away where that makes sense. The board clears after **two consecutive clean passes**.
**Scope (owner, 2026-10-21): strict mode first.** Strict mode at its default configuration, with its two opt-ins
(`origins` and `fetchBridge`), is the supported baseline: only findings that reach it count toward a clean pass.
Findings that reach only cooperative or worker mode are fixed when cheap, and otherwise documented as those modes'
limits. Findings are
fixed as before: by class, each naming its class and extending its chokepoint and structural test (CONTRIBUTING.md,
"Fixing a finding"), after the owner has seen them.
A finding whose only effect is a bounded cost to the host page that the embedder can end is at most medium, and is
documented rather than mitigated (CONTRIBUTING.md, "Availability findings").

**Pass 1 (2026-10-21, main 9141e4e)** found findings that leak data (BD1:ISO-1, BD1:NEW-1, BD1:NEW-14), so it was not
clean. **The owner's decision on it: fix only what leaks data now; every DoS or availability finding goes to
this backlog**, high ones included, rated as the verifiers confirmed them (S77 to S82; S77 and S78 are fixed). Fixed in their own batches, as
findings that leak data: the fetch bridge running in the host page's fetch environment (BD1:ISO-1, ADR-006), the
same-site origins warning (BD1:NEW-1) and `allow-pointer-lock` as a safe capability (BD1:NEW-14). The board's reports and the verifiers' verdicts are kept in
[BOARD-PASS-1-2026-10-20.md](archive/reviews/BOARD-PASS-1-2026-10-20.md); each item cites its findings by ID (`BD1:`).

**Pass 2 (2026-10-21, main 6d727a8)** found confirmed findings that leak or can manipulate data (BD2:NEW-1, high: a host
`base-uri` blocks the guest document's base, cooperative mode; BD2:ISO-2 with BD2:NEW-2, high: host-site and listed-origin
cookies on guest requests; BD2:CHL-1, high: a re-entrant teardown leaves a guest running after `terminate()`; BD2:ISO-1,
medium: the hashed bootstrap replayed on the host page), so it was not clean either. BD2:CHL-1 is fixed by
detach-then-release (`src/lib/environment.ts`). Its docs-only and comments-only findings were fixed in their own batch (BD2:DOC-1, BD2:DOC-2, BD2:DOC-4 to
BD2:DOC-6, BD2:CHL-2's docs, BD2:NEW-3, BD2:NEW-6, BD2:LIM-4's docs; the S82 checklist's docs items); its
availability-only findings are backlogged: BD2:CHL-2's code half in S79 (the cross-sandbox case), BD2:LIM-3 in S82
(a budget that counts a proxy: the fetch result's head is capped in characters, its size is measured in
structured-clone bytes, so a head of very many small headers can make a response the bridge read in full be refused
on its way to the guest; availability only, low). The board's reports and the verifiers' verdicts are kept in
[BOARD-PASS-2-2026-10-21.md](archive/reviews/BOARD-PASS-2-2026-10-21.md), with how each finding was resolved; each item
cites its findings by ID (`BD2:`).

**Pass 3 (2026-10-23, main be0a34a)** found confirmed findings that leak or can manipulate data and reach strict mode
(BD3:ISO-1 and BD3:ISO-2, high: the same-site refusal fails open when the cookie-domain probe cannot write, and takes the
host origin from `location.origin`, which is `'null'` in a `srcdoc` host; BD3:CHL-1, high: a build that waited on the
host-policy read skips the `connect-src` narrowing when the read's frame left the document; BD3:NEW-7, medium: a
documented residual, an image load to a listed cross-site origin carries its `SameSite=None` cookie on Firefox, which the
owner classifies), so it was not clean either (0 of 2). BD3:ISO-1, BD3:ISO-2 and BD3:CHL-1 are fixed by the same-site rule
without a probe (the host origin from `self.origin`; an entry sharing the host's last two labels is refused; no
`document.cookie` probe) and by a host-policy read that never answers "absent" (it fails closed). BD3:NEW-7 waits on
research 21 (`crossorigin="anonymous"` on the view's loads). BD3:LIM-1 is availability only and is backlogged as
[S83](#s83). Everything else, the docs, the lows and the test gaps, was fixed in a batch of its own, with BD2:DOC-3
recorded as resolved (the comment in `src/lib/frame-documents.ts` names what exists) and BD2:TST-7 as fixed (tests that
kill the `stillOurs` mutant and the fetch bridge's `FORBIDDEN_HEADER` and `MAX_HEADERS` mutants). The board's reports,
the verifiers' verdicts and the coordinator's note on the cookie class are kept in
[BOARD-PASS-3-2026-10-23.md](archive/reviews/BOARD-PASS-3-2026-10-23.md), with how each finding was resolved; each item
cites its findings by ID (`BD3:`).

#### Trajectory

The data findings of every round since the first review, as the coordinator counts them: a data finding is a confirmed
one that leaks or can manipulate data (the board's rule, applied to the earlier rounds afterwards), and the last column
is the count of those that reach strict mode. Highs are as the verifiers confirmed them. There were no criticals.

| Round | Date | Data findings | Reaching strict | High |
| :--- | :--- | ---: | ---: | ---: |
| R1 | 2026-10-15 | 1 | 0 | 0 |
| R2 | 2026-10-15 | 0 | 0 | 2 |
| R3 | 2026-10-18 | 0 | 0 | 2 |
| R4 | 2026-10-18 | 0 | 0 | 0 |
| R5 | 2026-10-19 | 0 | 0 | 1 |
| BD1 | 2026-10-21 | 3 | 2 | 4 |
| BD2 | 2026-10-21 | 5 | 3 | 3 |
| BD3 | 2026-10-23 | 5 | 4 | 4 |

The board's passes find more data findings than the rounds did, because they cover what the rounds did not: the host
page's context, the browsers' own handling of a request, and an opt-in configuration. **The evaluation rule the
coordinator applies after every pass:** if data findings reaching strict do not fall for two passes in a row, or a pass's
data findings sit in code added by the previous pass's fixes, the approach changes before the next pass (shrink the
surface rather than patch it). After pass 3 both conditions hold: the count reaching strict rose from 2 to 3 to 4, and
BD3:ISO-1 and BD3:ISO-2 are incomplete fixes of BD2:ISO-2 and BD2:NEW-2 (the same-site rule), while BD3:CHL-1 sits in the
host-policy read of the same decisions. So the same-site rule and the policy read lose the parts that decided by a
measurement (a test cookie, `location.origin`, an absent policy) before pass 4; the coordinator's note in the archive
sets out the design that removes the class.

### <a id="s79"></a>S79 · Desktop Chromium: the view's liveness ping ends a healthy sandbox on one documented stall — ⏳ **open** (P2 · M · medium)

*S74 board BD1:LIM-2 (with its verdict in the archived report), confirmed medium.* Class B. The 5 s view liveness ping
(`_startViewWatchdog`, `VIEW_LIVENESS_TIMEOUT_MS`, `src/host.ts`) assumes a stall of the view is a stall of the host
page, which the watchdog does not count. Desktop Chromium 127+ runs the view in a process of its own: the host page's
ticks keep counting while the view is busy, so one documented single-operation stall that lasts over about 5 s ends the
sandbox (`the sandbox view stopped responding`) at its first occurrence, though API.md (b) says the first overrun is
survived. It fails closed (the sandbox ends) and has no security effect: the library's own limit ends a healthy sandbox
(CONTRIBUTING.md, "Availability findings", exception 2).

**Evidence.** Desktop Chromium 145 (`PROBE_CHANNEL=chromium`), load 2.2 to 3.7: a 240 000-character bidirectional
paragraph, terminated after 5730 ms, longest host stall 12 ms (the view runs apart). A `:has()` rule over 37 000 later
siblings: ready with the first-overrun line when the operation finished under 5 s, ended when it did not, so the outcome
depends on the machine's load. The headless shell (shared thread) survives both, as documented.

**Fix, by construction.** One predicate rules on a busy view: the view posts `VIEW_BUSY` before each flush and
`VIEW_IDLE` (or its next pong) after it, and the host's view watchdog does not count ticks while an announced
operation is open; the error page of a lost view (ADR-005, A5) stays silent without a BUSY and is still caught.
Structural test: a Playwright project with `channel: 'chromium'` (desktop Chromium) running
`test/e2e/view-bound.spec.ts` (b) with the verdicts of the shared-thread engines. Fallback if that is not wanted: state
the 5 s outer bound in API.md (b) and (d) and in the reasons table.

**The cross-sandbox case (S74 pass 2, BD2:CHL-2).** This extends the mechanism across sandboxes. Desktop Chromium
groups the sandboxed frames of the page in one process, so the view of sandbox B shares a process with the frames of
sandbox A: a plain loop in A's cooperative guest, or one documented stall in A's strict view, stalls B's view while the
host page keeps ticking, and B's liveness ping ends B (`the sandbox view stopped responding`); a cooperative B is
frozen for as long. Measured on desktop Chromium (`PROBE_CHANNEL=chromium`): host gap 55 ms while B was ended at 5 s;
two strict sandboxes rendering a 240 000-character bidirectional paragraph both ended. B fails closed and no data
moves. The predicate of the fix has to be "B's view did not get the thread", so the view stamps each pong with its own
clock and the host counts the view's elapsed time, not its own ticks. Structural test: a desktop-Chromium project
running a two-sandbox spec. Until then the docs state that every sandbox of the page shares the one process
(THREAT-MODEL.md "Where the view runs", API.md "Chromium on the desktop", ADR-005).

**Until then** API.md "(b) The single-operation bound" and THREAT-MODEL.md state it.

**Design constraint for a fix (owner, 2026-10-23).** The host decides liveness; nothing the view reports can extend a
deadline indefinitely, since the view's thread is busy with renders the guest asks for. A design that meets it uses
only what the host knows itself: while the host has a render in flight to its view, the per-operation rule applies
instead of the ping; one registry on the host page, shared by every sandbox, records a render in flight anywhere on
the page, so another sandbox's stall is told apart; and the host's own hard cap always holds. Availability-only and
failing closed, so it stays here until the owner picks it up.

### <a id="s80"></a>S80 · The event-read scan was never built; the guest's event getters are unguarded by any test — ⏳ **open** (P2 · S · medium)

*S74 board BD1:TST-1, medium; class G with E-cpu.* Reverting R5:N-2 and R5:N-6 (the bootstrap's `error` and
`unhandledrejection` listeners read the event through `readEvent`'s getters captured before guest code) passes the whole
suite: 147 unit tests and 107 e2e tests on Chromium with each mutant (the `reason` read, then the `message` and `error`
reads, taken directly). Under the mutant a strict guest that redefines `PromiseRejectionEvent.prototype.reason` (the
class is on `WORKER_GLOBALS`) makes the library count a small string for a rejection whose real, large reason Firefox
reports to the host page's thread, and R5:N-1 is open again. Research 18 promised the scan rule ("after the capture
point, a property read on a listener's parameter or on a value received from the guest is an error, except as an
argument to the helpers"); it does not exist: `read-once.test.ts` allows a single direct read and
`bootstrap-capture-and-measure.test.ts` has a fixed accessor list (`size`, `byteLength`, `byteOffset`, `buffer`,
`data`, `ports`, `source`) without `reason`, `message` or `error`.

**Fix, by construction.** Chokepoint: `readEvent` (exists). Add the promised rule to `usesAfterCapture`: inside a function
passed to `addGlobalListener` or `listen`, or any function whose parameter is named `event`, a member read
`<param>.<name>` other than `isTrusted`, `type` and `defaultPrevented` is an error. The reviewer's two probes become the
positive controls: a unit test and an e2e (a strict entry redefines `PromiseRejectionEvent.prototype.reason` to return
`'x'`, then raises three rejections of 2 Mi characters; the sandbox must end with the uncaught-budget reason), for the
`error` and `unhandledrejection` rows of `bootstrapListeners`. Check that the new test fails with the mutant.

### <a id="s81"></a>S81 · Tests that fail under heavy machine load — ⏳ **open** (P3 · S · low)

*S74 board BD1:CO-1 (the coordinator) and BD1:NEW-13 (the newcomer).* With six reviewers keeping a
4-core machine at load 7 to 18, the local CI mirror failed these on WebKit (and the unit run two more) while GitHub CI
on the same commit was green; each is measured against the load, not against the code:
- `test/e2e/channel-isolation.spec.ts:76`: the positive control `strangerDelivered > 20` got 18. It counts deliveries in a
  fixed window; the T9 scan does not catch that shape.
- `test/e2e/worker-port-and-view-cost.spec.ts:86`: the error-flood busy share was 16% against a bound of 10%; the idle
  baseline was 74 ticks a second against about 84 at low load.
- `test/unit/view-css-loads.test.ts:308`: the scaling helper reached ratio 37.2 against a bound of 24.
- `test/unit/lifecycle-transitions.test.ts:61`: its 5 s timeout.

**Fix, by construction** (candidates). (a) Positive controls wait until N deliveries arrive, with a timeout, plus a scan
(beside T9's) for count-in-window controls. (b) The local CI mirror and the e2e fixture record the load at the start and
refuse or annotate a run above a threshold. (c) The exhaustive exploration in `lifecycle-transitions` gets a
deterministic budget (a count of states) instead of a wall-clock timeout. To confirm first: rerun both e2e specs on WebKit
at low load.

### <a id="s82"></a>S82 · S74 pass 1: the low findings, one checklist — ⏳ **open** (P3 · M · low)

The lows of the S74 board's pass 1, none of which leaks data. Each entry gives its ID in the board's report for that
area ([BOARD-PASS-1-2026-10-20.md](archive/reviews/BOARD-PASS-1-2026-10-20.md): the sections CHL, ISO, LIM, DOC, TST and NEW). **[docs]** marks an item whose fix
is in `docs/`, the README or the ADRs only; **[comments]** a code-comment fix; **[tests]** a test gap; the rest need
code. Each code fix names its class and extends that class's chokepoint and structural test (CONTRIBUTING.md, "Fixing
a finding").

*Channels and lifecycle*
- [ ] BD1:CHL-1: an embedder `console.warn` hook inside `setConfig()`'s `applyConfig` effect is outside the executor's
  generation check; a `terminate()` from there is undone.
- [ ] BD1:CHL-1, second site: the same class at the log cap line (`src/host.ts`, the warning at the cap).
- [x] BD1:CHL-3: L1 ("a guest cannot outlive `terminate()` or `reset()`") is asserted for cooperative and worker mode
  only; not for strict mode, and not for the element's removal (the property holds). **[tests]** Done: L1 is every mode
  × `terminate`, `reset` and `remove` (`test/e2e/worker-globals-and-termination.spec.ts`).

*Isolation*
- [x] BD1:ISO-2: the `keepalive` guard is only a shadow on the worker global; the platform's `fetch` stays on
  `WorkerGlobalScope.prototype`. Done: the request gate (in-sandbox-script.ts) removes every copy of `fetch`,
  `XMLHttpRequest` and `WebSocket` on the global object's prototype chain before guest code, in every mode
  (`test/unit/request-gate.test.ts`, `test/e2e/request-gate.spec.ts`).
- [ ] BD1:ISO-3: cooperative mode: the guest replaces its own document without being ended, and the replacement has none
  of the bootstrap's hardening (a cooperative-mode limit to list, S44).
- [x] BD1:ISO-4: the `origins.connect` reference is wrong for strict and worker mode and omits what an `https:` entry
  opens (`wss:`, EventSource, beacon). **[docs]**

*Limits* Done: the claim about `https:` admitting `wss:` is false (measured: it does not, in Chromium 145, Firefox 146 and
  WebKit 26; WebKit lets a `wss://` entry admit `https://` requests), so API.md, the TSDoc and ADR-007 say that.
- [ ] BD1:LIM-4: `fetchBridge` numeric options fall back or clamp silently.
- [ ] BD1:LIM-5: the strict prelude reads `refused` and `ids` of the view's frames through the guest's
  `Object.prototype` (affects only the guest).
- [ ] BD1:LIM-6: no e2e covers the isolated view (S79 carries the test); the guest-controlled kinds of a rejection are
  covered (`test/e2e/error-cost-and-queued-calls.spec.ts`, `test/unit/egress.test.ts`). **[tests]**
- [ ] BD2:LIM-3 (S74 pass 2, low, availability only; the class of the byte measure, fixed for the values it counted): the
  fetch result's head is capped in characters (`MAX_RESPONSE_HEAD`), its size is measured in structured-clone bytes
  (about 40 bytes of overhead for every header pair), so a head of up to 32 768 small headers measures about 2.5 MB
  against the 1 MiB `FETCH_RESULT_OVERHEAD` that the config invariant allows. With `maxBytes` near 32 MiB the bridge reads
  the response in full, records `ok`, and `sendResult` then refuses it. Fix: bound the number of headers and the head's
  measured bytes in the frame next to `MAX_RESPONSE_HEAD`, and test with the worst head the cap admits.

*Docs*
- [ ] BD1:DOC-1: the owner enables private vulnerability reporting (repository Settings, Code security). SECURITY.md keeps
  the route and says `main` is what is supported. **[owner]**
- [ ] BD1:DOC-2: `load(html)` does not validate; its TSDoc says a non-string is dropped with a warning, and
  `load(() => 1)` terminates strict mode (embedder-only). Code, or the TSDoc.
- [x] BD1:DOC-3: three code comments (`violation.ts`, `in-sandbox-script.ts`, `auto-resize.ts`) say the guest can reach the
  port, against the threat model; `auto-resize.ts` says "cooperative mode only". **[comments]**
- [x] BD1:DOC-4: THREAT-MODEL's "`ready` only follows the guest's check-in" against the no-script cooperative `ready`;
  ARCHITECTURE's "a render never crosses the host page's thread" (the "always stop" half is qualified with S77 to S79).
  **[docs]**
- [x] BD1:DOC-5: ADR-006 says the bridge being off removes `sandboxFetch`; it does not. **[docs]**
- [x] BD1:DOC-6: retry guidance contradicts itself (ADR-002, the `RpcErrorCode` TSDoc, README, API.md). **[docs]** and TSDoc
- [x] BD1:DOC-7: ADR-005 says a consumer's build changes the view bootstrap text; the package pins it. **[docs]**
- [x] BD1:DOC-8: ADR-003's "every budget terminates" is not what the budgets do. **[docs]**
- [x] BD1:DOC-9: README says custom elements are inline and to set `display`; the element is a block. **[docs]**
- [x] BD1:DOC-10: API.md states an invariant that S70 records as false for string bodies. **[docs]**
- [ ] BD1:DOC-11: hand-copied lists and numbers in README and API.md that nothing keeps equal to the code. **[docs]** Not done: it needs a marker or a generated region for the README and a test that compares the file-type list.
- [x] BD1:DOC-12: the Trusted Types row says Firefox has none. **[docs]** Done: the row names Firefox 146 (measured again).
- [ ] BD1:DOC-13: history left in current docs and tests (about 25 test titles with "round N", 28 PR2/3/4 labels, dated
  lines, `CSP_CONFIG_RATIONALE.md`, `deepMerge`), past the ratchet. **[docs]** and test names Done: the docs, the comments of `src/`, `test/` and `scripts/`, `CSP_CONFIG_RATIONALE.md` (moved to
  `docs/archive/research/`) and the `deepMerge` sentence. Left: the test titles with "round N", the `describe` titles with
  PR labels, `deepMerge` itself (dead code, used by two tests only) and the ratchet's extension.
- [x] BD1:DOC-14: the "reproduction under `docs/research/NN_*/`" rule is not what practice follows since research 14;
  the "Enforced by" cell cites `host.test.ts` and omits `capability-presets.spec.ts`. **[docs]**

*Tests*
- [ ] BD1:TST-2: the frame-table scan sees only UPPER_SNAKE `type` literals written first; a `CHANNEL_BUDGETS` row
  deletion is caught only by the docs. **[tests]** Half done: every post in the stringified code must be a literal of a
  row of FRAMES or a forwarded frame (`unreadablePosts`, `test/unit/structural.test.ts`, with the four mutants as the
  scan's own test), including the bridge frame's, in the frame and in the host's posts to it. Left: keying `CHANNEL_BUDGETS` rows by frame type, so that a deleted row of the logic port fails a
  test and not only the docs (a change of the table's shape, and of what the budgets table renders).
- [x] BD1:TST-3: the generation-compare scan matches one spelling of a comparison. **[tests]** Done: `!=`, `==`, orderings,
  `Object.is` and the identity of `_lc` (`GEN_COMPARISON`, `test/unit/lifecycle-reducer.test.ts`, with its own test).
- [x] BD1:TST-4: the host's cap on the guest's own log lines (`LOG_OWN_LINES`) has no test. **[tests]** Done
  (`test/unit/channel-guarantees.test.ts`).
- [x] BD1:TST-5: the wrapper's `frame-src 'none'` is pinned to itself. **[tests]** Done: `WRAPPER_CSP` is asserted as the
  directive list the docs state (`test/unit/host-page-policy.test.ts`).
- [ ] BD1:TST-6: the RESIZE source filter and the view's own listeners against the egress table are unchecked. **[tests]**
  Half done: the RESIZE source filter (`test/unit/channel-guarantees.test.ts`). Left: the egress scan of the view's and the
  strict worker's listeners (`egress.test.ts` reads only the bootstraps'), which needs the view's rows keyed to its
  listeners and the generated `unheard` rows to fail on a contradicting row.
- [x] BD1:TST-7: the Navigation API half of PD4 is tested for `back()` only (not `forward`, `traverseTo`). **[tests]** Done
  (unit and e2e, all three traversals).
- [ ] BD1:TST-8: docs gates: THREAT-MODEL markers and backticked refs, a third copy of the defaults in `@defaultValue`,
  HTML links, unregistered ID prefixes. **[tests]** Left: new gates in the docs generator, not a cheap test.
- [ ] BD1:TST-9: the structural scans read esbuild text, not the shipped bundle; the `RpcFrame` brand is checked by
  `typecheck` only. **[tests]** Left: needs the scans run over the built `dist/`, a build step in the unit run.
- [ ] BD1:TST-10 (info): redundant layers shadow each other; research 17's property tests and research 19's probes are
  not in CI. **[tests]**

*Newcomer*
- [x] BD1:NEW-2: cooperative mode without `allow-scripts` reaches `ready` with no guest (the TSDoc says the frame's
  load, README and API.md say the check-in). **[docs]** and TSDoc
- [ ] BD1:NEW-3: `viewScriptHash()` does not match the view when the package runs from source under Vite (fails
  closed; `dist` matches).
- [ ] BD1:NEW-4: some config refusals name no key (`origins.images: 'https://x'` gives "(TypeError)"); list options are
  dropped with a warning or terminate, inconsistently.
- [ ] BD1:NEW-5: silent config typos (`watchdogTimout`, `unsafeCapablities`); `fetchBridge` without `allow` warns not.
- [x] BD1:NEW-6: a looping `entry` spins the worker until `terminate()` with the watchdog off by default; the quickstart
  does not say so. **[docs]**
- [ ] BD1:NEW-7: `registerFiles()` after a refused entry does not revive the sandbox (as documented); the message does
  not say to `reset()`.
- [x] BD1:NEW-8: the README fetch-bridge example has no `entry` or `mode`, so it does not run in the default strict
  mode. **[docs]**
- [x] BD1:NEW-9: `import 'web-sandbox'` fails while the package is private (D1); `bun run dev` hardcodes port 4444.
  **[docs]**
- [x] BD1:NEW-10: README says the element is block in one place and inline in another (`:host` is block). **[docs]**
- [ ] BD1:NEW-11: the playground assigns to the frozen `sandbox-log` detail (`playground.ts`), a `TypeError` on every
  strict preset; that the detail is frozen is undocumented. **[docs]** and playground Docs half done (the `detail` is deeply frozen: `WebSandboxEventMap`); the playground fix is left.
- [x] BD1:NEW-12: the library's own lines ("strict Ready") are logged with `source: 'guest'`. **[docs]** or code
- [ ] BD1:NEW-13: tests under heavy load: S81.

### <a id="s83"></a>S83 · A rejected Symbol or BigInt is counted as 0 characters by the uncaught budget — ⏳ **open** (P2 · S · high, availability only)

*S74 board BD3:LIM-1, rated high by the reviewer, as an incomplete part of the fix of BD1:LIM-1 (S78); medium by the
availability rule (CONTRIBUTING.md, "Availability findings") if the owner prefers. No verdict.* Class P with B, and
E-cpu: the uncaught budget counts a model of what the browser reports, and the model counts less than the browser reports
for one kind of reason. Availability only: no data moves.

**Path.** `reportOf` (`src/lib/in-sandbox-script.ts`) counts a string's length and the `name` and `message` of an object,
and any other primitive as `characters: 0`. A guest that rejects a `Symbol('x'.repeat(2 ** 24))` once per 100 ms is
counted by `UNCAUGHT_PER_SECOND` only (1000 a second). On Firefox the reasons are reported on the host page's thread,
cancelled or not, and the report of a symbol carries its description: 12 rejections stalled the host page for 5.8 to 7.5 s
in all (longest 3 s) while the sandbox stayed `ready`; the same flood of strings or errors ends the sandbox at the first.
Chromium and WebKit show no cost. A BigInt of 60 000 digits cost nothing, but its report is the same kind of text.
Strict and worker mode; the embedder can end it with `terminate()` or by removing the element, which is why it is
availability only.

**Fix, by construction.** `reportOf` counts an upper bound on the text the browser can make of the reason for every
`typeof`: a symbol by its description's length (through the captured `Symbol.prototype.description` getter), a bigint by
an upper bound of its decimal digits (its hexadecimal digits times 1.21, plus 2), every other primitive by
`String(value).length`, objects and functions as now. Structural test: a property test over a closed list of reason
shapes that enumerates every `typeof` (a `Complete<>` over the `typeof` union, so that a new branch must be listed),
asserting that `characters` is at least the length of the reason's descriptive string; and Symbol rows (a 16 Mi
description; a 1 Mi description ten times a tick) in the uncaught-flood table of `test/e2e/error-cost-and-queued-calls.spec.ts` on
Firefox, expecting the uncaught-budget reason.

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
| Nonce-based CSP instead of `'unsafe-inline'` | General best practice | No benefit under an opaque origin with immutable `srcdoc` CSP — [`CSP_CONFIG_RATIONALE.md`](archive/research/CSP_CONFIG_RATIONALE.md) §3. |
| App identity from a hash of the source | [Lunet](https://gozala.io/lunet) | The embedder already knows what it loaded; two tenants with identical code would share storage, and any edit loses the data. If storage needs scoping, the embedder passes a namespace. |
| Declarative argument rules per method (UCAN policy) | [Dialog DB](https://github.com/dialog-db/dialog-db) | In UCAN a third party writes the policy; here the embedder writes both policy and handler, so checking arguments in code is strictly more expressive. |
| Method-first names so read-only is a prefix | Dialog DB | There are no grants to narrow; an exposed name is the whole grant. |
| UCAN delegation between host and guest | Dialog DB | One host, one guest, no third party: holding the one-shot port already is the authority. Would add keys, signatures and a clock to a self-contained broker. |
| React/Vue adapters (was part of D3) | Backlog D3 | Owner's decision: a custom element already works in every framework, and wrappers would be a second API surface to keep in step with the element. |
| Server-side session quotas (rate limit, TTL, LRU) | [Finding 08](research/08_session_exhaustion/README.md), `IMPROVEMENTS.md` §1 | The local-first architecture has no server. Becomes P1 the moment a hosted mode ships; recorded so the requirement is not lost with the server that was removed. |
