# Fresh review round 1 (2026-10-15)

The first round under the stopping rule, on `main` at `5ede7ba` (strict mode the default, S48). Every finding below was
reproduced as a failing test first (unit where library logic decides; e2e on Chromium, Firefox and WebKit where the
browser decides) and then fixed or documented on branch `round1-fixes`. Backlog: S50–S53.

## Stopping rule

Done = two consecutive independent rounds, each with at least four reviewers using different methods and model families, that find zero medium-or-higher issues in our own code; browser bugs and documented limits counted separately and do not reset the count; any medium-or-higher finding in our code resets the count to zero after it is fixed.

## Reviewers

| | Method | Model family | Completed |
| :--- | :--- | :--- | :--- |
| R1 | fuzzing (inputs, sizes, timing) | Opus | yes |
| R2 | spec conformance (HTML, CSP3, Trusted Types, Fetch) | Sonnet | yes |
| R3 | embedder (a host page integrating the element) | Fable | yes |
| R4 | real apps (applications ported into the sandbox) | Sonnet | yes |
| R5 | black box | Opus | **no**: stopped by a safety classifier before any probe ran; recorded as not completed |

Four reviewers completed, with four methods and three model families: the round counts as a round.

## Findings

Severity as the reviewers rated it. "Ours" is our code; "platform" is a browser behaviour or a documented limit,
counted apart. Each test named failed at `5ede7ba`.

| ID | Severity | Class | Finding | Status | Tests |
| :--- | :--- | :--- | :--- | :--- | :--- |
| R3-1 = R2-1 | medium | ours: environment inheritance | The frames inherit the host page's CSP, Trusted Types and COEP. Host `script-src 'self'`: strict `ready`, then "the sandbox view stopped responding"; cooperative "did not finish loading". Host `worker-src` without `blob:`: "the guest entry failed to start". Trusted Types: "could not be built (TypeError)". `style-src 'self'`: the frame 150 px high. COEP: WebKit's worker failed. | fixed (S50): strict `ready` on the view's check-in; reasons that name the host policy; one Trusted Types policy `web-sandbox` (the element, the view, worker mode's frame); a style warning with the constant hash; API.md "Host page policy". Residuals: the wrapper's height needs CSS; WebKit's COEP worker and no string evaluation under Trusted Types (platform). | `test/e2e/host-policy.spec.ts` |
| R4-1 = R2-3 | medium | ours: a relay's input domain | The console relay threw `DataCloneError` for functions, Symbols, DOM nodes, Events, Responses, Proxies, WeakMaps, Promises (cooperative, worker, strict). | fixed (S51): one relay for every mode, never throws, names refused values by kind | `test/unit/review-round-1.test.ts`, `test/e2e/review-round-1.spec.ts` |
| R1-1 | medium | ours: unbounded resource | Text was in no view budget: renders of 261 000 characters into 200 targets every 20 ms kept the host 95–100% busy on all three engines; the document grew without bound. | fixed (S52): `VIEW_MAX_CHARACTERS`, `VIEW_RENDER_CHARACTERS_PER_SECOND` | `test/e2e/view-budget.spec.ts` |
| R1-2 | medium | ours: super-linear layout admitted | `'x<wbr>'.repeat(43000)` stalled Firefox's host about 20 s. The scan found `ruby` in WebKit (10.7 s), the renderer's own middle-child removals (Chromium 13 s) and WebKit's layout of a word over many text nodes. | fixed (S52): `wbr`, `ruby`, `rt`, `rp` unwrapped; a linear walk that joins text and drops comments | `test/e2e/view-budget.spec.ts`, `src/lib/in-sandbox-view.test.ts` |
| R3-3 | medium | ours: unbounded resource | No byte caps: a 64 MiB typed array logged arrived whole; 100 000-key objects; a flood within the log caps cut Firefox's host to ~7 ticks/s; 256 × 32 MiB RPC arguments held on WebKit. | fixed (S51): `LOG_MAX_BYTES` and a per-second budget in the guest, `RPC_MAX_BYTES` and 64 MiB of running inbound arguments, measured at both ends | as R4-1 |
| R4-2 | medium | ours: a documented promise unmet | Cooperative (and worker) uncaught errors and rejections never reached `sandbox-log`. | fixed (S51); WebKit's muted "Script error." documented (platform) | as R4-1 |
| R4-3 | medium | ours: packaging | The published `.d.ts` broke under NodeNext (TS2834), and with skipLibCheck every type read as `any`. | fixed: `.js` specifiers in declarations; the smoke test type-checks a NodeNext consumer and asserts wrong configs are type errors | `scripts/smoke-package.sh` |
| R2-2 | medium | platform: cooperative-mode limit | A modifier click the guest's script synthesizes opens a new top-level tab (Chromium with no gesture, Firefox in a user's activation); Chromium submits a form that way past `form-action`. | documented (S53, S44) and measured per engine; decided: `allow-forms` is an unsafe capability (S54) | `test/e2e/review-round-1.spec.ts` |
| availability | medium | ours: a claim | S42 said availability was lost "in WebKit"; R1 measured host stalls from strict renders on all three engines where the view shares the host thread. | restated (S52, ADR-005 amendment): not protected wherever the view shares the host's thread; bidirectional text layout added as a measured residual (platform) | `test/e2e/view-budget.spec.ts` |
| R1-3 | low | ours | Values that should be dropped refused the whole config (`capabilities: 5`, `{}`, BigInt or cyclic fetch bridge entries; `JSON.stringify` in a warning threw). | fixed | unit |
| R1-4 | low | ours | `parseOrigin` accepted U+212A KELVIN SIGN (lowercased to "k"). | fixed | unit |
| R1-5 | info | platform | Invalid Punycode labels behave per engine. | documented (API.md `origins`) | — |
| R2-4 | low | ours | The strict worker minted `blob:` URLs for types the view will not show (SVG), which the view admitted as CSS images. | fixed: URLs only for `VIEW_FILE_TYPES` | unit, e2e |
| R2-5 | low | ours | Worker mode kept `WebAssembly` without `scriptUnsafe`. | fixed (cooperative: frozen, documented) | unit |
| R3-2 | low | ours | `terminated` fired synchronously inside `setConfig()`/`reset()`. | fixed: a refused build's event in a task | unit |
| R3-4 | low | ours | Cooperative mode without `allow-scripts` silently ignored scripts and bootstrap-dependent options. | fixed: one warning | unit |
| R3-5 | low | ours | `fetchBridge.allow` naming the host page or a private host was silent; a non-list too. | fixed: warnings | unit |
| R3-6 | low | ours | Types did not narrow per mode. | fixed: `SandboxConfig` per mode | type tests (`bun run typecheck`) |
| R3-7 | low | ours | `setConfig()` of the same config rebuilt. | fixed: no change | unit |
| R3-8 | low | ours | `autoResize` dropped the embedder's inline height. | fixed: restored | unit |
| R3-9 | low | ours | `expose()` with a non-function was ignored. | fixed: TypeError | unit |
| R3-10, R3-11, R3-12, R4-9 | info | docs | `for…in` follows own `__proto__`; handler messages reach the guest verbatim; the element's announcement and embedder `message` listeners; the view ignores synthetic events. | documented (API.md) | — |
| R4-6 | low | ours | Strict mode relayed no unhandled rejection. | fixed (S51) | unit, e2e |
| R4-7 | low | ours | Errors as text, other console methods, "Uncaught Uncaught", Firefox's "Uncaught the worker failed". | fixed (S51; Firefox's message-less worker error told apart by a probe worker) | unit, e2e |
| R4-8 | low | ours | `sandboxFetch` was missing without the bridge (API.md said `FETCH_NOT_ALLOWED`). | fixed: always defined, the host refuses | e2e |
| R4-11 | info | docs | Plugins whose async init outlives `ready`. | documented (API.md) | — |
| R4-12 | low | ours | No `display: block` default; no tag map or event map in the typings. | fixed (constructed stylesheet; `WebSandboxEventMap`) | e2e, type tests |
| R4-4, R4-5 | — | owner decision | See below. | decided and done (S54) | `test/e2e/owner-decisions.spec.ts` |

Measured before and after (host ticks of a 10 ms interval in 2.5 s, idle / loaded):

| | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| R3-3 log flood, before | 250 / 168 | 242 / 47 | did not finish |
| R3-3 log flood, after | 250 / 249 | 241 / 236 | 208 / 209 |
| R1-1 render flood, before | 250 / 100 (24 M chars held) | 242 / 34 (10 M) | 206 / 36 (5.5 M) |
| R1-1 render flood, after | 250 / 239 (1 M) | 242 / 229 (1 M) | 208 / 153 (1 M) |
| R1-2 43 000 `<wbr>`, render to layout | 0.3 s before and after | 23 s before; after, shown within the 2 s measuring window | 0.35 s before; after, within the window (the walk and the text runs) |

## Overlap

Two findings were found twice, by different methods: the host page's policy (R2 by reading CSP3 and Trusted Types, R3
by embedding the element in a real host page) and the console relay (R2 by reading structured clone, R4 by porting
applications that log DOM nodes and functions). Both sit on a boundary the earlier reviews never crossed from the
outside: the environment the element is placed in, and the full input domain of a channel the library owns. Every
earlier review attacked the guest; this round's mediums came from the embedder's side and from real content. It
suggests the next rounds keep an embedder and a real-application reviewer, and that the boundary tests be written from
the embedder's environment (a served host policy, real application code) rather than from the harness.

## Awaiting the owner

*Decided on 2026-10-15 and done in S54: the strict view shows raster-image guest writes, decoded only (R4-4);
`viewScriptHash()`, `sandboxView.text()` and `sandboxView.set()` (R4-5); `allow-forms` is an unsafe capability in
cooperative and worker mode (R2-2). The items as they were raised:*

- **R4-4**: showing guest-written images in the strict view.
- **R4-5**: a new public name: an exported view-hash function, and a `sandboxView.text()` / `set()` API. API.md says how
  to read the hash today, from the wrapper's `srcdoc`.
- **R2-2**: moving `allow-forms` between the capability lists. The residual is documented and measured.

## Validation

On the branch: `bun run typecheck` clean; 1413 unit tests; `bun run build` and `scripts/smoke-package.sh` (now with a
NodeNext consumer); the full Playwright suite on Chromium, Firefox and WebKit, 1542 passed and 27 skipped (as before);
the strict-mode design probes, 24 passed; the new and changed specs three times over (`--repeat-each 3`), no failure.
The suite's first run after the fixes failed 7 tests on each engine, each one asserting behaviour the round changed on
purpose (the same config no longer rebuilds, the strict worker mints fewer URLs, the view's character budget,
`sandboxFetch` always defined, a test that matched text inside the bootstrap's source); they were updated with the
reason in place. A baseline run at `5ede7ba` taken while sources were being edited is not counted: the dev server
served the edited files mid-run.

## Round result

**Not clean.** Eight medium findings in our code were fixed, so the count stays at 0. The next round starts from the
branch that closes these.
