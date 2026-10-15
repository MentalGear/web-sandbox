# Fresh review round 2 (2026-10-15)

The second round under the stopping rule, on `main` at `31b8f0d` (round 1's fixes and the owner's decisions, S50–S54).
Every finding below was reproduced as a failing test first, unit tests where library logic decides and e2e on Chromium, Firefox and WebKit
where the browser decides. Each one was then fixed or documented on branch `round2-fixes`. Backlog: S55; round 3 is S56.

## Stopping rule

The owner adjusted the rule after round 1 (see the [round 1 report](REVIEW-ROUND-1-2026-10-15.md#stopping-rule)):

> Done = two consecutive review rounds, each made up of the same three defensive reviews, that find zero
> medium-or-higher issues in our own code. The three reviews are model-based lifecycle testing, an audit of the code
> changed since the last round, and measuring each documented limit on Chromium, Firefox and WebKit. They use at least
> two different model families. Browser bugs and documented limits are counted separately and don't reset the count.
> Any medium-or-higher finding in our code resets the count to zero once fixed.

## Reviewers

| | Method | Model family | Completed |
| :--- | :--- | :--- | :--- |
| L | model-based lifecycle testing: a reference model from README and API.md; 1,206 seeded sequences on 3 engines, shrunk to minimal ones | Opus | yes |
| C | audit of the code changed since round 1 (`5ede7ba..31b8f0d`) | Sonnet | yes |
| M | each documented limit measured at its edge, in every mode, on 3 engines, plus responsiveness and memory soaks | Opus | yes |

## Findings

Severity is as the reviewers rated it. Each test named failed at `31b8f0d`, or, for L and M, just before its fix (same behaviour).
Tests: `test/unit/review-round-2.test.ts` (C, M), `test/unit/review-round-2-lifecycle.test.ts` (L),
`test/e2e/review-round-2.spec.ts`, `test/e2e/host-policy.spec.ts`, `test/e2e/package.spec.ts`, `scripts/smoke-package.sh`.

| ID | Severity | Class | Finding | Fix |
| :--- | :--- | :--- | :--- | :--- |
| C-1 | high | ours: guest-mutable intrinsic | The relay's token buckets called `Math.min` at call time. A guest that set `Math.min = () => Infinity` lifted the 1000 lines/s and 4 MiB/s caps (Firefox host 229 → 87 ticks/s). | Every function stringified into the guest starts with one captured list ending at `CAPTURE_POINT` and reads nothing guest-mutable after it. A unit test scans their text for globals, method calls, spread, iteration, destructuring and prototype accessors, with a positive control. |
| C-3 | high | ours: a measure that did not measure | `structured-size` walked only own enumerable keys. An Error, a RegExp or an ImageData (Firefox) measured about 16 bytes, so a 120 MB Error result resolved `call()` past the 33 MiB cap on all 3 engines. Senders measured the live value, so a getter could answer small and clone large. | Senders clone with a captured `structuredClone`, measure that snapshot with an allow-list of the types clone produces (each sized exactly), and post the snapshot, transferring its buffers. Anything else measures past every limit. The receiver and the log path use the same measure. |
| C-2 | medium | ours: guest-mutable intrinsic | `console.trace` and `console.assert` built arguments with spread. A patched array iterator made that throw, and the catch forwarded the raw arguments to the browser console. | Index loops over captured intrinsics. A wrapper that throws forwards nothing. `count`, `time*`, `timeStamp` and `profile*` are bounded and budgeted too. |
| C-4 | medium | ours: unbounded work | Each `set({ value })` re-serialized the whole view body but was charged only its own characters (Firefox 233 → 67 ticks/s). | Running character and element counts. A MutationObserver resets them on any change the view did not make. |
| C-5 | medium | ours: `ready` without a guest | Worker mode announced its port before `new Worker`. Under a host `worker-src` without `blob:` it was `ready` with no worker, and calls hung. | The worker is constructed first. The port is announced on `WORKER_STARTED`; a refusal is the announcement and maps to the documented worker reason. |
| C-6 | medium | ours: a documented reason never given | Under a host `trusted-types` default policy the `web-sandbox` policy was never created. Strict mode ended with a generic reason; worker mode was `ready` with no worker. | The view and worker frame probe `createPolicy` before checking in and report the documented Trusted Types reason. |
| C-7 | medium | ours: exponential comparison | The equal-config check had no visited set: 24 levels of shared references blocked `setConfig()` for 2.4 s. | A visited-pair set with a 10,000-pair cap. Past the cap the configs count as different, so the element rebuilds. |
| C-8 | medium | ours: documented usage broken | `import { viewScriptHash }` threw `HTMLElement is not defined` outside a browser, and the hash was of `Function.toString()`, so a minified app got a different hash and ended with `STARTUP_BLOCKED`. | `scripts/build-lib.ts` bakes the view bootstrap into the bundle as a literal with a build-time hash. The element extends a guarded base, so the import needs no DOM. The hash matches across Bun, Node, a minified consumer bundle and the browser. |
| L-1 | medium | ours: gap in CB7 | `setConfig()`, `load()` and `reset()` still built while the element was in another window's document (the cooperative guest ran there in Chromium). It then ended with a false CSP reason. | One `buildsHere()` predicate used by both `connected()` and `initialize()`. |
| L-2 | medium | ours: timer overflow | Delays of 2^31 ms or more fired at once: a `watchdogTimeout` of 2^33 killed a healthy guest, and `callWithTimeout(Infinity)` timed out after the request was sent. | One long-delay helper (`src/lib/long-timer.ts`, chained, `Infinity` = off) for every config- or caller-supplied delay. A unit test guards other `setTimeout` uses. |
| C-9 | low | ours | Same-slot coalescing reordered ops. | The old op is removed and the new one appended. |
| C-10 | low | ours: comments | Stale comments on strict readiness, `unsafeCapabilities`, `frame-documents`, the view header. | Edited. |
| C-11 | low | ours: build | The declaration-specifier regex also rewrote paths inside comments. | `scripts/js-tokens.ts` (the TypeScript scanner) drives the rewrite. |
| C-12 | info | ours: test | A linearity timing test failed once under full-suite load. | Best-of-3 at 1k vs 8k elements, asserted as a ratio. |
| L-3 | low | ours | While loading, queued `execute()` frames went before earlier calls. | One queue in issue order. |
| L-4 | low | ours: gap in CB5 | A `terminated` listener re-applying a config whose entry was unregistered rebuilt forever. | The entry refusal moved into `_buildRefusal()`. |
| L-6 | low | ours | Removing a loading cooperative sandbox about 12 ms after insertion dispatched `ready` from inside `remove()` (Chromium, WebKit). | A frame load counts only for the current frame while frame and element are connected. |
| L-7 | low | ours | `terminate('')` fired with reason `''`. | A blank reason becomes the default. |
| M-1 | low | ours | The guest's "starts dropping" warning was itself dropped by the host's line window. | The relay's own lines are marked and the host admits up to 4 per environment outside the window. Both sides count in sliding windows derived from one constant. |
| M-2 | low | ours | 1000 lines before connect cost `strict Ready` and the drop warning, and the warning named the wrong cap. | The pre-connect buffer is one window's worth; the warning names the cap that triggered. |
| M-3 | low | ours: work not budgeted | The view's budget counted characters, not work: `'<i></i>'` floods took 80–95% of the host's thread within every budget. | A view time budget of 200 ms per second, measured per flush including layout and the following rendering update. Element floods measured 603, 544 and 530 host ticks per 800 (Chromium, Firefox, WebKit), up from 122, 162 and 38. |
| M-5 | info | ours | Chromium retained worker console lines (+445 MiB in 90 s at the maximum log rate). | Worker and strict guest logs no longer go to the worker's own console. |
| L-5 | low | platform | Firefox does not upgrade the element in another document, so its methods were missing. | The prototype is restored on adoption; methods work. |
| L-8 | info | documented limit | Reasons quote up to 256 characters of the embedder's own config. | none |
| L-9 | info | platform | WebKit's shadow root lists a removed wrapper after a move and move-back. | none |
| M-4 | info | documented limit | The RPC call rate is bounded only by 256 in flight. | none (stated in API.md) |
| M-6 | info | documented limit | WebKit's bidi stall measured 43 s against a documented 20 s. | The docs no longer give a number: "tens of seconds, engine and machine dependent". |

## Behaviour changes for embedders

- **No Errors or platform objects in `call()`.** An Error, an ImageData or another platform object in `call()` arguments or results is refused
  (`ARGS_NOT_TRANSFERABLE` / `RESULT_NOT_TRANSFERABLE`). Send `{ name, message, stack }` instead. Console lines already do this.
- **Worker mode is `ready` slightly later**, once its worker is running.
- **Guest logs only through `sandbox-log`.** Worker and strict guest logs reach only `sandbox-log`, not the browser's devtools console.
- **Startup logging uses the first second's budget.** A strict entry that logs 1000 lines at startup has used its first second's budget when it connects.
- **One expensive view op is not bounded.** The time budget throttles what follows a single expensive view operation, not the operation itself; API.md says so.

## What held

M measured every documented limit at its exact edge, with its documented code or text, in every mode, on all three
engines; none failed. L's invariants held over 1,206 sequences:
- one live environment;
- no stale events;
- every call settled exactly once;
- no leaked timers or listeners;
- refused builds dispatch asynchronously, once;
- an equal config is a no-op;
- guest writes match the model.

The exceptions are those listed above.

## Severity trend

Both highs are in code added by round 1's fixes: the relay's budget (S51) and the size measure (S51). L-1 and L-4 are
gaps in earlier fixes (CB7, CB5). The reviewed-before code yielded no high. The same pattern as round 1: new code brings
new highs, so a clean round needs a round in which the code under review is not new.

## Validation

On the branch:
- `bun run typecheck` clean.
- 1472 unit tests passed.
- `bun run build`, `bun run build:lib` and `scripts/smoke-package.sh` passed.
- Playwright on Chromium, Firefox and WebKit: 1596 passed, 27 skipped (the research probes, as before).
- The strict-mode design probes: 24 passed.

Two older specs relied on what C-1 and M-3 closed and were updated with the reason in place:
- `auto-resize.spec.ts` now forges its reports through the root element's real height.
- `view-budget.spec.ts` R1-1 waits up to 30 s, because WebKit now applies at the time budget.

## Round result

**Not clean.** Two high and eight medium findings in our code were fixed, so the count stays at 0. Round 3 is held by
the owner and recorded as S56.
