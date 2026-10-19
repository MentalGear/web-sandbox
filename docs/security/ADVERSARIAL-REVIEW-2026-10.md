# Adversarial review, 2026-10

**Date**: 2026-10-14 · **Code reviewed**: `main` at `ca2110c` · **Result**: 21 candidates — 19 fixed (16 in the review,
C1, C4 and C5 in the [follow-up](#follow-up-2026-10-14-by-construction-audit)), 1 held (now asserted), 1 documented by
design; none of its candidates is left as a residual (the default-mode residuals stated before it remain, now in
[one list](../../README.md#cooperative-mode-limits)); the follow-up found 2 more gaps, both fixed · **Backlog**: [S19–S26](../BACKLOG.md#s19--a-configured-value-or-key-could-add-csp-directives---done)
· **Next**: [focused review 2026-10-14](FOCUSED-REVIEW-2026-10-14.md) (guest writes and the follow-up's fixes; S27–S31) · **Then**: [broad review 2026-10-14](BROAD-REVIEW-2026-10-14.md) (S32–S37), [independent verification](VERIFICATION-2026-10-14.md) (S43–S45)

## Scope and method

The review tested the library's own security guarantees (README "Security Mitigations", ADR-002 to ADR-006) as
claims that either hold, did not hold, or hold only within a stated limit. It was defensive throughout: every
candidate became a guarantee with a test that asserts it, and this report states what each test proves, not how
to exploit the code it covers.

1. **Phase 1, read-only review by area**, three reviewers working from the code alone:
   - **A, policy and documents**: CSP generation and the policy pipeline (`src/lib/csp/*`), the config merge, the
     guest, wrapper and view documents, markup, CSS and module references;
   - **B, channels and lifecycle**: the bootstrap, INIT_PORT, the broker, the watchdog, events, the fetch bridge;
   - **C, strict mode and files** (partial): the view, the renderer, the worker prelude, the files in strict mode.
   Each produced candidates with a code path, a hypothesis and a proposed fix, and small unit experiments.
2. **Phase 2, verification**: every candidate was reproduced first, with a failing test where it did not hold
   (unit tests where only the library's logic is involved; end-to-end tests on all three engines where browser
   behaviour decides), then fixed at the chokepoint that removes the class, and the test re-run green. End-to-end
   evidence follows the T5 rules (backlog): load outcomes read from outside the sandbox, a recorder listener for
   network effects, the host's `violation` events, and a positive control for each channel in the same test.
   Candidates that held keep their test as a guarantee test.

**Engines** (Playwright 1.58.1 builds, Linux): Chromium 141.0.7390.37, Firefox 146.0.1, WebKit 26.0. Playwright's
WebKit on Linux is not Safari.

## Summary

| Id | Area | Severity | Status | Test (file: name) |
| :--- | :--- | :--- | :--- | :--- |
| <a id="ar-a1"></a>A1 | policy | medium/high | **fixed** | `test/e2e/review-policy.spec.ts`: "A1: an injected default-src value gives the strict view no handler attributes…"; `test/unit/policy-guarantees.test.ts`: "A1: … property, strict and iframe mode"; `src/lib/csp/policy-grammar.test.ts` |
| <a id="ar-a2"></a>A2 | policy | low/medium | **fixed** (by A1) | `test/unit/policy-guarantees.test.ts`: "A2: the S14 'self' drop cannot be bypassed by punctuation" |
| <a id="ar-a3"></a>A3 | policy | low/medium | **fixed**; class closed in the follow-up | `test/unit/policy-guarantees.test.ts`: "A3: … warns once when script-src-elem refuses inline scripts"; `src/lib/markup-references.test.ts` (inlineScriptsAllowed rows); `src/lib/csp/file-sources.test.ts` ("over the one fallback table"); `test/e2e/review-policy.spec.ts`: "A3 class" (3 tests) |
| <a id="ar-a4"></a>A4 | config | low | **fixed** | `test/unit/policy-guarantees.test.ts`: "A4: an unknown mode fails closed" |
| <a id="ar-a5"></a>A5 | policy | low | **fixed** | `test/unit/policy-guarantees.test.ts`: "A5: 'unsafe-eval' and 'wasm-unsafe-eval' come only from scriptUnsafe" |
| <a id="ar-a6"></a>A6 | config | info | **fixed**; by construction in the follow-up | `test/unit/policy-guarantees.test.ts`: "A6: the values interpolated into the bootstrap come from one copy of the config" |
| <a id="ar-a7"></a>A7 | config | info | **fixed**; by construction in the follow-up | `test/unit/policy-guarantees.test.ts`: "A7: a merge never writes prototypes, with no list of keys" (property) |
| <a id="ar-a8"></a>A8 | documents | info | **held**, now asserted | `test/unit/policy-guarantees.test.ts`: "A8: the default bootstrap is parser-safe"; `test/e2e/package.spec.ts`: "… parser-safety assertion for every default bootstrap variant" |
| <a id="ar-b1"></a>B1 | channel | medium/low | **fixed** | `test/e2e/review-channels.spec.ts`: "B1: another frame on the host page racing the host with INIT_PORT…"; `src/lib/in-sandbox-script.test.ts`: "the one INIT_PORT (review B1)" |
| <a id="ar-b2"></a>B2 | channel | medium/low | **fixed** | `test/e2e/review-channels.spec.ts`: "B2: the port never reaches guest code" (3 tests); `src/lib/in-sandbox-script.test.ts`: "the port never reaches guest code (review B2)" |
| <a id="ar-b3"></a>B3 | events | medium/low | **fixed** | `test/unit/channel-guarantees.test.ts`: "B3: every sandbox-log detail is normalised and labelled" |
| <a id="ar-b4"></a>B4 | lifecycle | low/medium | **fixed** (real in Firefox) | `test/e2e/review-channels.spec.ts`: "B4: a listener that resets the sandbox mid-flood…"; `test/unit/channel-guarantees.test.ts`: "B4" |
| <a id="ar-b5"></a>B5 | lifecycle | low | **fixed**; one helper in the follow-up | `test/unit/channel-guarantees.test.ts`: "B5: a listener that resets or terminates the sandbox is never undone" (every path forced, and a source check) |
| <a id="ar-b6"></a>B6 | fetch bridge | low | **fixed**; the platform validates in the follow-up | `test/unit/channel-guarantees.test.ts`: "B6: the platform validates a request before the bridge records it" |
| <a id="ar-b7"></a>B7 | broker | low | **fixed** | `test/e2e/review-channels.spec.ts`: "B7: 300 calls to a host method that never settles…"; `src/lib/rpc.test.ts`: "inbound calls in flight are capped per channel (review B7)" |
| <a id="ar-b8"></a>B8 | broker, events | info | **documented** (by design) | `test/e2e/review-channels.spec.ts`: "B8 (documented): an own "__proto__" key survives structured clone…" |
| <a id="ar-c1"></a>C1 | strict, files | medium/low | claim narrowed; **fixed** by construction in the follow-up | `test/e2e/review-strict.spec.ts`: "C1: the view renders no blob: content but registered files" (3 tests); `src/lib/in-sandbox-view.test.ts` ("revokes the worker's source URL…") |
| <a id="ar-c2"></a>C2 | strict | low/medium | **fixed** | `test/e2e/review-strict.spec.ts`: "C2: the entry runs in its own scope" (3 tests); `src/lib/in-sandbox-view.test.ts`, `test/unit/strict.test.ts` ("review C2") |
| <a id="ar-c3"></a>C3 | strict | low | **fixed** | `test/e2e/review-strict.spec.ts`: "C3: guest code watching every array write…"; `src/lib/in-sandbox-view.test.ts` ("C3") |
| <a id="ar-c4"></a>C4 | strict | low | measured; **fixed** in the follow-up | `test/e2e/review-strict.spec.ts`: "C4: the view counts violations per directive…"; `test/unit/followup-guarantees.test.ts` ("C4") |
| <a id="ar-c5"></a>C5 | strict | low | measured; **fixed** in the follow-up (S24 option B) | `test/e2e/review-strict.spec.ts`: "C5: a rendered link stays a link, but its href is one inert constant" (2 tests); `src/lib/in-sandbox-view.test.ts` |

"Fixed" means the test failed against `ca2110c` and passes now; the engines it failed on are given below.

## Findings

### A1, A2 · A configured value or key could add CSP directives

> Since 2026-10-14 the policy steps described here are replaced by typed `origins` and one policy template per mode ([ADR-007](../ADR-007-typed-origins.md)); their guarantees hold by construction there.

- **Guarantee**: no configuration can add a directive to a guest policy; the directives strict mode fixes are the
  only ones of their name in the view policy.
- **Found**: `generateCSP()` trimmed and joined values; the strict view policy copied passed-through values as they
  were. A `;` or `,` inside a value, or whitespace or `;` inside a key, emitted directives of the config's choosing,
  and a browser keeps the first occurrence of a directive name. In strict mode a `default-src` value carrying
  `script-src-attr 'unsafe-inline'` came before the view's fixed `script-src-attr 'none'`. In iframe mode an injected
  key passed the S7, S14 and bootstrap checks, which look at keys and whole values; `"'self';"` passed the S14 drop (A2).
- **Root cause**: the policy is a string grammar, and nothing held the config to it.
- **Fix**: by construction, a policy grammar (`src/lib/csp/policy-grammar.ts`) at the start of the host's pipeline
  and again inside `generateCSP()`: a directive name must be one of the known names, exactly; each value is split on
  ASCII whitespace and each token must be one CSP source expression (keyword, nonce, hash, scheme, host with optional
  scheme, port and path; no `;`, `,`, quote, whitespace or control character inside). Everything else is dropped
  with a warning. Running it first means every later step (S7, file sources, S14, the bootstrap check) sees exactly
  the tokens the policy will hold. The reviewer's proposal; nothing broader was needed. `CSPDirectives` gained the
  CSP3 directives the runtime accepted silently before (`script-src-elem`, `script-src-attr`, `style-src-elem`,
  `style-src-attr`, `child-src`), so the known set and the type agree.
- **Evidence**: the end-to-end test failed on Chromium, Firefox and WebKit before the fix: the recorder received the
  request a rendered `onerror` handler made from the strict view. After: no request, the view reports a
  `script-src-attr` violation, and the view policy's first `script-src-attr`, `frame-src` and `script-src` are the
  fixed ones. A property test over 200 random configs with injected keys and values builds strict and iframe
  environments and parses each policy the way a browser does.

### A3 · The bootstrap check ignored `script-src-elem`

- **Guarantee**: when the policy refuses the inline bootstrap while scripts are allowed, the element warns (S13), and
  the bootstrap-written markup plan is used only when the bootstrap can run.
- **Found / root cause**: `inlineScriptsAllowed()` read `script-src`, then `default-src`; an inline `<script>` is
  checked against `script-src-elem` first.
- **Fix**: `script-src-elem` → `script-src` → `default-src`, as CSP Level 3 specifies.
- **Evidence**: unit tests failed before (no warning; four table rows); pass now.

### A4 · An unknown mode silently meant iframe mode

- **Guarantee**: strict mode is a security opt-in, so a misspelt mode never gives a weaker mode.
- **Found / root cause**: `mode: 'Strict'` or `' strict'` was not `'strict'` or `'worker'`, so every check treated it
  as iframe mode.
- **Fix** (decision: fail closed at the build chokepoint): `initialize()` terminates with `unknown mode …` while the
  merged config's mode is not `iframe`, `worker` or `strict`; one warning per value; `reset()` and `load()` stay
  closed; a config with a valid mode starts again. Terminating, rather than keeping the previous environment, means
  no environment ever runs with a mode the embedder did not ask for, and `reset()` cannot bring back an old one.
- **Evidence**: unit tests for five invalid values failed before (state `loading`, a frame built); pass now.

### A5 · Eval keywords configured outside `scriptUnsafe`

- **Guarantee**: evaluating strings as code is enabled only by `scriptUnsafe`, which warns (S4).
- **Found / root cause**: `'unsafe-eval'` or `'wasm-unsafe-eval'` in `connectionsAllowed` reached the policy without
  the switch or its warning.
- **Fix** (decision: drop, not warn and keep): both keywords are removed from every configured directive
  (`src/lib/csp/drop-eval.ts`), with a warning once per directive while `scriptUnsafe` is off and silently while it
  is on, since the host then adds `'unsafe-eval'` itself (which covers WebAssembly). One switch, one warning.
- **Evidence**: unit tests failed before in all three modes; pass now.

### A6, A7 · Config read twice; merge follows `__proto__`

- **Guarantee**: the values interpolated into the bootstrap are literal booleans; a merged config is plain data.
- **Found**: `scriptUnsafe` was normalised from the caller's object with two reads (`Object.hasOwn`, then the value),
  so an object whose answers change between reads (a Proxy) could leave its text in the bootstrap call (A6).
  `deepMerge()` iterated with `for…in` and wrote `__proto__` keys through `[[Set]]`, setting the merged config's
  prototype from a JSON config (A7).
- **Fix**: `deepMerge()` reads own keys once each and skips `__proto__`, `constructor` and `prototype`;
  `scriptUnsafe`, `autoResize` and `entry` are normalised again on the merged copy, which is the only thing read later.
- **Evidence**: unit tests failed before (the bootstrap carried the Proxy's text; the element inherited
  `scriptUnsafe: true` and `mode: 'worker'`); pass now.

### A8 · The default bootstrap had no parser-safety assertion

- **Guarantee**: the default bootstrap is parsed back as exactly one script.
- **Found**: strict mode asserted this for its hashed bootstrap; the default bootstrap relied on its literals
  escaping `<`.
- **Result**: **held** — no bootstrap variant contains `</script`, `<script`, `<!--` or NUL, in the sources or the
  bundle. The assertion (`assertParserSafeScript`) now runs whenever a guest document is built. A CR is allowed in
  the default bootstrap, which is not hashed (refusing it would break a CRLF build for nothing).

### B1 · INIT_PORT was accepted from any sender

- **Guarantee**: the guest's bridge talks only to the host.
- **Found**: the bootstrap's `message` listener (`{ once: true }`) took the first INIT_PORT from anyone. Another frame
  on the host page that posted one first either handed the bridge a port of its own or, without a port, left it
  dead (the listener was gone, the genuine INIT_PORT ignored). The worker-mode frame forwarded any INIT_PORT.
- **Fix**: exactly one INIT_PORT is accepted: trusted, with exactly one port, and in iframe mode from
  `parent.parent` (the host page; the guest's parent is the wrapper), read before guest code runs. A capture
  listener that stops the accepted event; anything else is ignored without throwing and does not use it up. Same
  rule in the worker-mode frame.
- **Evidence**: the end-to-end test failed on all three engines before (the bootstrap never announced itself on the
  host's port). After: the stranger's messages reach the guest (its own listener counts them, the positive control),
  the bridge works both ways, and the stranger's ports receive nothing.

### B2 · Guest code could take the port and answer the watchdog

- **Guarantee**: the watchdog terminates a guest whose event loop is blocked (worker mode on every engine, iframe
  mode where the frame runs out of process).
- **Found**: the bootstrap called `port.postMessage` and set `port.onmessage` through prototypes, at call time.
  Guest code that patched `MessagePort.prototype.postMessage` received the port as `this` at the bootstrap's next
  post, transferred it to a nested worker that answered every PING, and looped.
- **Root cause**: the bootstrap's primitives were looked up when used, after guest code could replace them.
- **Fix**: by construction, as in strict mode's prelude: every operation on the port and on the events that carry
  it uses primitives captured before guest code runs, called through a captured `Reflect.apply`; internal lists
  are written with a captured `defineProperty`. Decision: worker mode keeps `Worker` and `SharedWorker` — the
  guarantee no longer depends on their absence, and nested workers are legitimate in the default modes (strict
  mode's G2 deletes them for its own reason).
- **Evidence**: before, on all three engines, guest code held the port after the bootstrap's next post, and a
  looping guest with a delegate was never terminated. After: patching every port, event and call primitive yields
  no port, while a delegate does answer pings on a port the guest owns (the positive control), and the looping
  guest is terminated within the budget. Since guest code can no longer post frames, the specs that forged
  `VIOLATION` and `RESIZE` frames on the port now forge through what the bootstrap reads (violation event getters,
  the root's box), which stays guest-influenced and is still validated on the host.

### B3 · Log frames were dispatched raw

- **Guarantee**: a `sandbox-log` listener receives a well-formed detail and can tell the element's own lines from
  the guest's; a guest cannot make the host run listeners without bound.
- **Found**: LOG frames were dispatched as received (any `level`, `args` of any type, extra keys), the host's own
  lines were indistinguishable, `SandboxDevTools` threw on `level: 1` or non-array `args`, and nothing bounded the
  number of events.
- **Fix** (decisions): the detail is `{ type: 'LOG', level, args, source }` — `level` one of `log`, `info`, `warn`,
  `error` (else `log`); `args` an array of at most 64 values, strings cut at 64 Ki characters (non-arrays become
  `[]`); `source` set by the host, `'guest'` for frames from the port and `'host'` for the element's own lines; frozen.
  Guest lines are limited to 1000 per second per environment, with one warning; host lines are never limited. A
  rate rather than a cap like `violation`'s, because logs are the continuous channel of a running guest.
  `SandboxDevTools` checks again, never throws, and prints guest values after a fixed first argument so none is a
  console format string.
- **Evidence**: unit tests failed before; pass now.

### B4 · Frames from an earlier environment's port

- **Guarantee**: after `reset()`, nothing from the old environment is dispatched.
- **Found**: the host relied on `close()` discarding queued messages. In Firefox it does not: a listener that reset
  the sandbox on the first of 500 log lines still received 574 stale `sandbox-log` and `violation` events (iframe
  mode), 12 in worker mode. Chromium and WebKit discarded them.
- **Fix**: the host handles a frame only if it arrived on the current environment's port (logic and view ports).
- **Evidence**: the end-to-end test failed in Firefox before, passed in Chromium and WebKit; passes on all three now.

### B5 · A listener's `reset()` or `terminate()` could be undone

- **Guarantee**: what a listener does to the lifecycle stands.
- **Found**: the execution timeout dispatched its log line and then rebuilt the environment, undoing a listener's
  `terminate()`; an entry failure dispatched its line and then terminated, tearing down the environment a listener's
  `reset()` had just built (confirmed against `ca2110c`: state `terminated`).
- **Fix**: the element counts environments; a host path that dispatches and then acts re-checks the count first
  ([ADR-003 amendment](../ADR-003-lifecycle-and-liveness.md#amendment-2026-10-14-a-listeners-reset-or-terminate-is-never-undone)).
- **Evidence**: unit tests (the timeout case failed before; the entry-failure case was confirmed against the old code).

### B6 · Fetch header values were not checked as ByteStrings

- **Guarantee**: a request the bridge refuses is recorded as `refused` and never reported as made.
- **Found / root cause**: a header value with code points above U+00FF passed validation; `fetch()` then threw before
  sending, and the record said `failed`.
- **Fix**: a header value must be a ByteString without CR, LF or NUL, else `FETCH_NOT_ALLOWED` before any request.
- **Evidence**: unit tests failed before; pass now (the record is `refused`, `fetch` never called).

### B7 · No cap on inbound calls in flight

- **Guarantee**: the other side cannot hold an unbounded amount of work and memory open on this side.
- **Found / root cause**: every inbound request to a slow or never-settling method stayed pending.
- **Fix** (decisions): at most 256 inbound calls run at once per channel; a further one is answered at once with the
  new code `BUSY`, before its method runs. `BUSY` joins the codes the other side reports (it is the responder's
  refusal), so the local codes stay unforgeable (ADR-002's B7 argument). The count is per reply channel and the host
  passes one per port, so calls that never settle in one environment cannot starve the next. Both sides run the same
  broker, so the cap applies in both directions.
- **Evidence**: the end-to-end test failed on all three engines before (no refusal); now 256 run and the other 44 are
  refused with `BUSY` while those 256 are still pending, and the next environment has its own count.

### B8 · Own `__proto__` keys survive structured clone

- **Result**: by design, documented. Measured on all three engines: an object the guest passes with an own
  `__proto__` key arrives with it; reading it is safe and `Object.prototype` is untouched, but `Object.assign({}, arg)`
  sets the target's prototype. The README says so next to `expose()` and `sandbox-log`; the element's own config
  merge skips the key (A7).

### C1 · A8 was enforced on attributes only

- **Guarantee as stated before**: the view keeps only `blob:` URLs it minted.
- **Found**: the renderer removes attributes naming a `blob:` URL the view did not mint; it does not read `<style>`
  text or CSS escapes in `style` attributes. Since the worker cannot mint URLs, the `blob:` URLs it knows are its own
  source URL and its copies of registered files.
- **Approach** (decision): the proposed fix, revoking the worker's source URL once the worker exists, works in
  Chromium and Firefox but was **rejected**: in WebKit it makes every `blob:` URL the worker minted unreadable
  (`sandboxFiles` fails with `NotReadableError`) and mutes its error messages. Patching the renderer to read CSS would
  chase a grammar (escapes, `@import`, `image-set`) rather than close the class. The guarantee is narrowed to what
  holds by construction: **the view renders no `blob:` content but registered files**. The worker's copies carry
  registered content and type (a copy of a JavaScript file is refused as a stylesheet by its type); the source URL is
  typed `text/javascript` and begins with the library's prelude, so it is neither a stylesheet nor an image or font.
- **Evidence** (all three engines): the source URL resolves in the view but applies no rule from `<style>` (even with a
  CSS rule hidden in the entry's comment), does not decode as an image, and a CSS-escaped reference survives the
  renderer; a CSS copy applies, a JavaScript copy does not.

### C2 · Declarations in the strict entry pre-empted the prelude

- **Guarantee**: the strict worker's prelude runs as written before any guest code (G2).
- **Found**: the entry was appended to the prelude in one classic script, and a script's declarations are
  instantiated before any of it runs. A top-level `function Worker() {}` made the prelude's deletion fail silently
  (the sandbox ran with `Worker` being the guest's function) and `function Reflect() {}` replaced a global the
  prelude captures (measured on all three engines).
- **Fix** (decision on scoping): the entry runs inside `(function () { … }).call(this)`, so **its top-level
  declarations are local** — the visible change: an entry that wants a global assigns it (`globalThis.x = …`); `this`
  is the global object as before; a top-level `return` becomes legal. Because a text wrapper can be closed early, the
  prelude's first step checks that no global is a non-configurable function, which only a top-level function
  declaration leaves (no engine has such a global of its own: measured, only `Infinity`, `NaN` and `undefined` are
  non-configurable), reaching `Object` through an object literal and the global through the script's `this`; a name
  the prelude cannot delete is now an error. The reviewer's two proposals together; neither alone closes the class.
  *Corrected by the [broad review](BROAD-REVIEW-2026-10-14.md) (ST4):* the check catches escaped **functions** only.
  An escaped top-level `let`, `const` or `class` is in its temporal dead zone while the prelude runs (one that shadows
  a global the prelude reads fails it with a `ReferenceError`, which ends the sandbox), but after the entry it could
  shadow the global marker the trailer calls; the marker's name is now drawn per build, so the entry cannot name it.
- **Evidence**: the three end-to-end tests failed on all engines before; now declarations stay local, `Worker` stays
  deleted, and an entry that escapes its scope ends the sandbox with `the guest entry failed to start: … the entry
  declares "Worker" at the top level …`.

### C3 · The prelude's lists reached inherited setters

- **Guarantee**: flow control and handler bookkeeping are out of guest reach.
- **Found / root cause**: the prelude appended with `list[list.length] = …`, which runs a setter or Proxy in
  `Array.prototype`'s chain; guest code saw the render queue and handler entries.
- **Fix**: the lists have no prototype. The default bootstrap's outbox is written with a captured `defineProperty`
  (part of B2).
- **Evidence**: with a Proxy in `Array.prototype`'s chain that counts every write, the guest's own write reaches it
  (positive control) and none of the prelude's does, while five chained renders still apply; failed on all engines
  before.

## Residuals, with rationale

| Id | What remains | Why it is not fixed in-page | Asserted by |
| :--- | :--- | :--- | :--- |
| C1 | ~~The renderer does not read CSS; rendered CSS can name the worker's source URL and its file copies~~ **Closed in the follow-up**: the source URL is revoked once the worker ran; rendered CSS can name only the file copies, registered content | — | `review-strict.spec.ts` "C1" |
| C4 | ~~The view's violation cap (100 per environment) is shared with refusals of the guest's own rendered markup~~ **Closed in the follow-up**: counted per directive, bounded | — | `review-strict.spec.ts` "C4" |
| C5 | ~~A user's own browser actions on a rendered link ("open in new tab", dragging it) are not cancellable~~ **Closed in the follow-up**: they are still not cancellable, but every rendered link's href is `about:blank#`, so they carry nothing of the guest's | — | `review-strict.spec.ts` "C5" |
| B8 | Guest data can carry own `__proto__` keys | Structured clone keeps them; a library cannot change what embedder code does with data | `review-channels.spec.ts` "B8" |

The residuals stated before this review (S8, S13 and S17 in default mode, S15's platform limits, S18) are unchanged.

## Areas reviewed and found sound

From the reviewers' phase-1 notes, confirmed by their experiments or by the existing tests in phase 2:

- **References and the module graph** (reviewer A): `module-specifiers`, `import-map`, `css-references`, `srcset`
  and `markup-references` (resolution against `vfs.invalid`, exact-path lookups, slot nonces, the CSS tokenizer and
  its dependency order, the one merged import map) — no candidate.
- **The fetch bridge's origin check** (reviewer B's experiment, re-run against the fixed code): trailing-dot hosts,
  IDNA, hexadecimal and integer IPv4, IPv4-mapped IPv6, credentials and `%2e` are all refused as not listed or as
  private; only the exact listed origin (with or without its default port) is accepted.
- **The config merge and structured clone** (reviewer A's and B's experiments): neither pollutes `Object.prototype`
  globally; the merge's prototype effect was confined to the merged object (fixed as A7).
- **The broker's allowlist and codes**: `Map` registries, the reserved `sandbox:` namespace, and the clamp of
  reported codes held under every forged response tried; `BUSY` was added to the reported group without touching it.
- **Host-side validation of guest reports**: violation details (directive pattern, clamps, the per-port cap) and
  auto-sizing reports (finite, non-negative, clamped, rate-limited) held against forged values, now forged through
  the bootstrap's reads.
- **Strict mode's view** (reviewer C): the renderer's element removal in every namespace, DOM-clobbering resistance,
  move-never-clone, the view's own INIT_VIEW check, render flow control and the render port (out of guest reach,
  re-asserted with B2's port patches) — no candidate beyond C1, C4, C5.
- **Frame integrity**: the second-load check and the wrapper's `frame-src 'none'` were not questioned.

## Recommendations and next steps

1. **Keep the grammar and the captured primitives as the chokepoints.** New policy steps should run after
   `sanitizeDirectives()`; new bootstrap code that touches a port or an event should use the captured primitives.
   Both are covered by property-style tests that fail if a new path bypasses them.
2. **Decide C5** (backlog S24): done in the follow-up, option B (inert link hrefs).
3. **File sources and `script-src-elem`**: done in the follow-up (one fallback table; `blob:` goes to the governing
   directive).
4. **The `fetch` event** reports every request, refused ones included, so its rate is bounded only by the RPC rate
   (now at most 256 in flight). That is by design (an audit log); an embedder that renders each record should
   throttle on its side.
5. **Re-run the review** when the bootstrap, the broker or the view changes shape, and re-measure C1's WebKit
   behaviour (revocation breaking worker `blob:` URLs) in Safari proper.

## Full-suite results

Commands: `bun run typecheck`; `bunx vitest run`; the full Playwright suite per engine; the changed and new specs with
`--repeat-each 3`, and once more under CPU load (one busy loop per core); `bun run build`; `scripts/smoke-package.sh`.

| | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| Full e2e before the review (`ca2110c`) | 332 passed, 8 skipped | 331 passed, 9 skipped | 330 passed, 10 skipped |
| Full e2e after | 350 passed, 8 skipped | 349 passed, 9 skipped | 348 passed, 10 skipped ¹ |
| Changed and new specs, `--repeat-each 3` (74 tests × 3) | 222 passed | 222 passed | 222 passed |
| The same specs once, under CPU load (a busy loop per core) | 73 passed, 1 failed ² | 74 passed | 74 passed |

Unit (`bunx vitest run`): 1165 passed in 28 files (998 in 25 before). `bun run typecheck`, `bun run build` and
`scripts/smoke-package.sh` pass. The skipped tests (8, 9 and 10 per engine) are the strict-mode design probes of research 15 (8 per engine), which run
only under their own config (`bun run test:probes`, in CI since the [independent verification](VERIFICATION-2026-10-14.md)),
and 3 per-engine measurements that do not apply to that engine (research 11 on Firefox and WebKit, research 01's
sanity check on WebKit).

¹ A first full WebKit run had one failure in `strict-render-flood.spec.ts` ("Execution context was destroyed" on the
host page during the 3 s maximal-render flood). **Root cause: the test server, not the library.** The e2e server was
Vite in dev mode with its hot-reload socket on, which reloads every open page when a file in its module graph is
rewritten (e.g. `dist/index.js` by `scripts/smoke-package.sh`, run alongside); a reload mid-test destroys any
pending `page.evaluate`. Reproduced by rebuilding during the spec (2 of 8 failed, each with a host-page reload).
Fix: e2e runs set `WEB_SANDBOX_E2E`, which turns the reload socket off (`vite.config.ts`), and the test runner only
reuses a server started in that mode (`playwright.config.ts`, probe endpoint `/__e2e`). With 15 rebuilds during the
run: 21 of 21 passed, no host navigation. The view-liveness check was examined at the same time and does not fire
falsely: it counts host ticks, so a render stall on a shared thread is never charged (12 s floods under load, 16 of 16
still `ready`).
² `strict.spec.ts` "a script corpus rendered into the view": under load the harness read the view as `no-context`.
**Root cause: the test helper.** Chromium kept the wrapper out of process every time in these runs (the broad review's
runs later measured the wrapper and the view in the host page's process, ST2; `strict-view.ts` reads either); what varied was Playwright
linking that frame, which in 6 of 100 runs under load it never did, and the helper then fell back to an in-process
read that cannot see the view. Fix: `test/e2e/strict-view.ts` reads every Chromium frame directly over CDP
(`Page.getFrameTree`, `Target.getTargets` by `parentFrameId`, non-flattened `Target.attachToTarget`), independent of
the process model and of Playwright's frame linking: 100 of 100 under load, including the unlinked case. A related
race found on the way: keyboard input sent right after a click could reach the page before focus crossed into an
out-of-process view, so the events and implicit-submission tests now wait for the expected `document.activeElement`
before typing. Without that wait the strict "no navigation" test could pass without the key ever reaching the form.

Changed or new spec files: `review-policy`, `review-channels`, `review-strict`, `package`, `auto-resize`,
`violations`, `strict`, `strict-events`, `strict-render-flood` (repeat and load runs), `events`.

## Follow-up (2026-10-14): by-construction audit

An audit graded every fix of this review by what makes it hold: **construction** (one chokepoint every path passes,
or the bad state cannot be represented), **validation** (an input is checked at a boundary, so the check has to be
right about every input), **discipline** (it holds while code keeps following a convention) or **residual** (a stated
limit). The follow-up moved every fix it could to construction, on `main` at `448f750`; owner's rules: defense not
offense, a test that fails before each change, evidence read from outside the sandbox (T5).

### Grading

| Id | After the review | After the follow-up | What makes it hold now |
| :--- | :--- | :--- | :--- |
| A1, A2 | construction | construction | the policy grammar at the start of the pipeline and in `generateCSP()` |
| A3 | discipline (two copies of the fallback order, one of them missing: file sources) | **construction** | one CSP3 fallback table (`src/lib/csp/effective-directive.ts`) read by every consumer |
| A4 | construction | construction, wider | `initialize()` refuses an unknown mode, an unusable config, and ends any build that throws |
| A5 | validation | validation | eval keywords dropped from the config (`drop-eval.ts`) |
| A6 | validation (normalised twice) | **construction** | one `structuredClone` of the `setConfig()` argument; `=== true` at every bootstrap interpolation |
| A7 | validation (a key denylist) | **construction** | merged keys are defined as own data properties: no key is special, none needs listing |
| A8 | validation | validation | parser-safety assertion on every bootstrap |
| B1 | validation | validation | one trusted INIT_PORT from `parent.parent` |
| B2, C3 | construction | construction | primitives captured before guest code (the prelude's error texts now use a captured `join` too) |
| B3 | validation, with a caller convention | **construction** | `_dispatchLog(line, source)` makes every detail itself |
| B4, B7 | construction | construction | port identity; the broker's in-flight cap |
| B5 | discipline (hand-written re-checks) | **construction, test-enforced** | `_notifyThenAct`, the only reader of the environment count; a test forces every path and fails on a hand-written check |
| B6 | validation (a copy of the platform's rule) | **validation by the platform** | the bridge builds the `Request` before recording; what it throws is `refused` |
| B8 | residual, documented | residual, documented | structured clone keeps own `__proto__` keys |
| C1 | residual (claim narrowed) | **construction** | the worker's source URL is revoked on its first render-port message |
| C2 | construction | construction | the entry's own scope and the scope check |
| C4 | residual | **validation, bounded** | the view's reports counted per directive (known names + one bucket) |
| C5 | residual | **construction** | every rendered hyperlink href is `about:blank#` (backlog S24, option B) |

### What changed

- **A3 class.** `effectiveDirective(policy, kind)` follows CSP Level 3's fallback lists; the bootstrap check reads it,
  file sources add `blob:` to the directive that governs each load (so to `script-src-elem` / `style-src-elem` when
  configured; before, those policies refused every registered script and stylesheet), and strict mode asks only
  the directives its view will hold. Byte-identical for policies without `-elem` directives (500-config property
  test against the previous code). End to end: the -elem config failed on all three engines before (script and
  stylesheet refused); now both load with no violation and nothing else widened.
- **C1 by construction.** The view revokes the worker's source URL on `VIEW_STARTED`, the prelude's first
  render-port message, posted only after the whole worker script ran. Measured on all three engines after the
  revocation: `sandboxFiles` (`url`, `read`, `text`), the worker's own `blob:` URLs, Blob reads, `execute()` and its
  error text work. **New finding**: in WebKit a later uncaught error thrown by code from the revoked script reads
  `Script error.` inside the worker (the audit had measured the Worker object in the view, where the text stays).
  The prelude now leaves such a muted error to the view, which logs it with its text; which errors are the entry's
  is decided from the count `VIEW_STARTED` carries, not from the order of two channels. Executed code's late
  errors, muted in WebKit's worker before this change too, now keep their text.
- **C4.** Per-directive counts on the view port, in the view and on the host; the logic port and the default modes
  keep one count (guest code names the directive there). 150 refused images no longer hide a `script-src-attr`
  report (failed on all three engines before).
- **C5 (S24 option B).** The renderer sets every hyperlink href to `about:blank#`; links stay focusable, keep the role
  `link` and `:link`, and clicks and Enter are still cancelled and delivered by id. The constant was measured
  against `#`, `""`, `about:blank`, `about:invalid`, `javascript:void(0)` and `data:,` (reasoning in `INERT_HREF`).
- **B6.** The bridge builds the `Request` before recording; what the constructor throws is `refused`, and the
  ByteString regex is gone. `fetch()` gets that `Request` with the same init, whole: the first attempt passed the
  `Request` alone, and in WebKit an abort through the `Request`'s own signal then no longer closed a response
  whose headers had arrived (the timeout and teardown specs failed); passing only the signal beside it reset the
  referrer policy and sent a `Referer` on all three engines (the credentials spec failed). `failed` is now
  documented as "the browser's `fetch()` rejected", not "a request was sent".
- **Backlog B8.** `workerExecutionTimeout` is a per-`execute()` budget for code still running and terminates
  (the guest reports `EXECUTED`); `execute()` and `call()` refuse at once while idle; `console.info` is relayed;
  `VIEW_LIVENESS_TIMEOUT_MS` is exported ([ADR-003 amendment](../ADR-003-lifecycle-and-liveness.md#amendment-2026-10-14-one-rule-per-budget-build-and-missing-environment)).

### Two new gaps (backlog S26, fixed)

1. **A build failure was not a termination.** A string directive value (`'img-src': "x; script-src *"`) or a `Proxy`
   array made `setConfig()` throw from the build: the old environment torn down, state `loading`, no frame, no
   `terminated` event. Now every build failure, and every config that cannot be copied, ends in `terminated` with a
   reason, and `setConfig()` never throws.
2. **The config shared the caller's arrays.** An array changed after `setConfig()` changed the policy the next
   `reset()` built. The argument is now copied once, first.

### Refuted alternatives

- **A `data:` URL for the worker** instead of revoking a `blob:` URL: in WebKit the worker then cannot read its own
  `blob:` URLs (`NotReadableError`), and Chromium mutes the errors of a large `data:` worker.
- **The entry as a separate script** (`importScripts(blob:)` from the prelude, to keep its error text away from the
  revoked URL): `importScripts` is checked against `script-src-elem`, and admitting `blob:` there would admit
  `<script src=blob:>` in the view.
- **For C5, removing `href` or rewriting links to `span`**: the element would leave the tab order, lose the role
  `link` and stop matching `:link`.

### Results

Each new or changed test failed before its change (run against `448f750`) and passes after. End to end, the new and
changed tests in `review-policy`, `review-strict`, `review-followup` and `worker-timeout` failed before on every
engine (13 of 22, plus the C5 guarantee; the rest are positive controls that pass before and after); unit: 39
failed before.

| | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| Full e2e at `448f750` | 350 passed, 8 skipped | 349 passed, 9 skipped | 348 passed, 10 skipped |
| Full e2e after | 363 passed, 8 skipped | 362 passed, 9 skipped | 361 passed, 10 skipped |
| Changed and new specs, `--repeat-each 3` | 189 passed (63 tests × 3) | 189 passed | 189 passed |

Unit (`bunx vitest run`): 1225 passed in 30 files (1181 in 29 before). `bun run typecheck`, `bun run build` and `scripts/smoke-package.sh` pass.

## Focused review (2026-10-14)

Two focused rounds after this review and its follow-up, on guest writes (C5) and on the follow-up's fixes, found 11
more candidates and one hardening, all closed: [FOCUSED-REVIEW-2026-10-14.md](FOCUSED-REVIEW-2026-10-14.md)
(backlog S27–S31). Two touch fixes of this report: C5's inert link hrefs could be re-animated by SVG animation (F1),
and B8's execution budget could be evaded (F2).
