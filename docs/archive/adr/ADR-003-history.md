# ADR-003 history

History, not current state: the text of [ADR-003](../../ADR-003-lifecycle-and-liveness.md) that its current decision replaced, verbatim, as it stood at commit 1aed8ad, and the amendments in the order they were made. Where a passage differs from the ADR, the ADR holds. Only the targets of relative links are changed, to resolve from this folder.

## The original status line

**Status**: Accepted · **Date**: 2026-10-11 · **Amended**: 2026-10-13 ([strict mode bounds execution on every engine](#amendment-2026-10-13-strict-mode-bounds-execution-on-every-engine)), 2026-10-14 ([a listener's reset or terminate is never undone](#amendment-2026-10-14-a-listeners-reset-or-terminate-is-never-undone)), 2026-10-14 ([one rule per budget, build and missing environment](#amendment-2026-10-14-one-rule-per-budget-build-and-missing-environment)), 2026-10-14 ([the execution budget is a free event loop at the deadline](#amendment-2026-10-14-the-execution-budget-is-a-free-event-loop-at-the-deadline)), 2026-10-14 ([loading is bounded; one answer per build; one document](#amendment-2026-10-14-loading-is-bounded-one-answer-per-build-one-document)), 2026-10-14 ([`ready` is the guest's check-in](#amendment-2026-10-14-ready-is-the-guests-check-in)), 2026-10-15 ([review round 1](#amendment-2026-10-15-review-round-1-strict-ready-refused-builds-in-a-task-no-rebuild-for-the-same-config)), 2026-10-19 ([review round 5: what waits for `ready` leaves at `ready`](#amendment-2026-10-19-review-round-5-what-waits-for-ready-leaves-at-ready))

## Why this ADR exists

Three backlog items met in one place, the element's lifecycle:

| Item | What was missing |
| :--- | :--- |
| B2 · lifecycle API | teardown was private: no supported way to stop a sandbox, rebuild it, or read its state |
| B3 · per-instance events | log lines were dispatched on `window`, so `SandboxDevTools`, which filters on `event.target`, printed nothing, and two sandboxes could not be told apart |
| S6 · execution budget | in iframe mode nothing could stop a guest stuck in a loop; only worker mode had a timeout |

## What the watchdog can and cannot bound, as first written

**What the watchdog can and cannot bound.** It detects a blocked guest event loop. That holds
where the guest runs on a different thread or process from the host: worker mode on every browser,
and iframe mode where the browser runs the sandboxed frame in its own process. That is browser
policy and varies even within one browser: headless Chromium ran the frame out of process in one
environment (a 3 s guest loop left the host answering in 3 ms) and on the host's thread in CI;
WebKit ran it on the host's thread (the host was blocked for the whole loop). So nothing is claimed
per browser; the iframe-mode test measures the process model at runtime and asserts the contract
that applies. Where the frame shares the host's thread, a guest loop stops the
watchdog's timers too: a platform limit, which strict mode removes (see the amendment below). It
is a liveness check, not a security boundary: a guest that answers pings is only alive, and the
host keeps explicit control through `terminate()`.

## The original consequences

## Consequences

- An element listener hears exactly one sandbox, and `SandboxDevTools` prints its sandbox's logs.
- `state` and the `terminated` event agree, and `terminated` fires once per termination;
  `state === 'terminated'` confirms a call's `TERMINATED` code from the element's own state.
- Pending calls settle on every teardown: reset, terminate, the watchdog and removal.
- With the watchdog on, a guest stuck in a loop is terminated in worker mode everywhere and in
  iframe mode wherever the frame runs out of process, while the host page stays responsive; where
  it shares the host's thread, the host's stall is never charged to the guest.

Costs and limits:

- **Same-thread frames are not bounded**: on WebKit and wherever else the frame shares the host's
  thread, a guest loop in iframe mode freezes the host page until it yields.
- **Watchdog false positives are the embedder's choice**: a budget shorter than the guest's longest
  synchronous task stops it.
- **Memory and inbound traffic remain unbounded**; see S6's open notes.

### Revisit if

- strict mode lands, so guest logic always runs in a worker and the same-thread limit disappears; or
- `execute()` gains completion reporting, which would make a `running` state truthful.

## Amendment (2026-10-13): strict mode bounds execution on every engine

**When**: backlog S6, strict mode ([ADR-005](../../ADR-005-strict-mode.md)), the "Revisit if" above. **Decision**: in
strict mode guest code runs only in a worker, and `watchdogTimeout` and `workerExecutionTimeout` watch that
worker, so a guest loop never blocks the host's timers, on any engine and whatever the browser's process model.

- **Asserted on Chromium, Firefox and WebKit** (`test/e2e/watchdog.spec.ts`): an endless loop at the entry's
  top level and one started through `execute()` are terminated between one and 1.25 budgets after the last
  answer, the host answering in well under 500 ms meanwhile; `reset()` recovers.
- **Rendering is host-thread work where the view shares the host's thread** (Firefox, WebKit). A worker that
  renders and then loops is still stopped, within the budget plus the stall of the one render in flight
  (flow control, ADR-005). Measured for a maximal render (256 Ki characters of one word): ≤ 10 ms in Chromium (the view
  runs out of process), 30–60 ms in Firefox, 0.36–0.47 s in WebKit. Ticks still never count a host stall
  against the guest.
- **A second, always-on liveness check, for the view.** The host pings the view on its own port with a
  5 s budget (`VIEW_LIVENESS_TIMEOUT_MS`). The view runs no guest script, so it answers unless it is gone —
  Chromium replaces a view whose navigation the wrapper refuses with an error page, ending the worker with
  it (research 15, P4) — or rendering keeps its thread busy that long; either way the sandbox terminates with
  `the sandbox view stopped responding` instead of going silent. Not configurable, since it watches the
  library's own document, not guest work.
- **Entry failure is a termination.** An entry that does not start (a syntax error, a throw at its top level)
  terminates with `the guest entry failed to start`; later uncaught errors are logged.

What strict mode does not change: the watchdog is still opt-in for guest logic; a worker that ends itself is
noticed only through it; memory and inbound traffic remain unbounded (S6's open notes).


## Amendment (2026-10-14): a listener's reset or terminate is never undone

**When**: the adversarial review of 2026-10 ([report](../../archive/reviews/ADVERSARIAL-REVIEW-2026-10.md), B5). **Why**: two
host paths dispatched a log line and then acted on the environment: the execution timeout (log, then rebuild)
and an entry that failed to start (log, then terminate). A `sandbox-log` listener that called `terminate()` had
it undone by the rebuild; one that called `reset()` had its new environment torn down.

**Decision**: the element counts environments (every teardown increments the count). A host path that dispatches
an event and then acts compares the count first and does nothing if a listener has torn the environment down
meanwhile. The lifecycle events keep their rule from decision 2 (dispatched after the state is set, last in
their path), so they needed no change. Proof: `test/unit/channel-guarantees.test.ts` ("B5").

**Follow-up (same day, by-construction audit)**: the count is now compared in exactly one place,
`_notifyThenAct(notify, act)` in `src/host.ts`, which every dispatch-then-act path uses (the execution timeout,
an entry that failed). A unit test forces each path with a listener that resets, one that terminates and none,
and fails if the count is compared anywhere else or a path calls the helper without a row in its table.

## Amendment (2026-10-14): one rule per budget, build and missing environment

**When**: backlog B8 and the follow-up audit of the adversarial review
([report](../../archive/reviews/ADVERSARIAL-REVIEW-2026-10.md#follow-up-2026-10-14-by-construction-audit)).

- **`workerExecutionTimeout` is a budget for code still running, and exceeding it terminates.** (Its mechanism, a
  report from the guest, was replaced by the [next amendment](#amendment-2026-10-14-the-execution-budget-is-a-free-event-loop-at-the-deadline): a free event loop at the deadline.) Each `execute()`
  carries a number; the guest bootstrap posts `EXECUTED` with it once the code returned or threw (through the
  captured port primitives, so guest code cannot post it), which stops that call's timer. Code still running at the
  deadline ends the sandbox: a `sandbox-log` line `Execution Timeout` (`source: 'host'`), then `terminated` with
  `the executed code ran longer than workerExecutionTimeout`. Decision: terminate, not rebuild, because it is the
  same situation as the watchdog's (a guest that does not give its thread back) and the watchdog terminates;
  rebuilding would bring back a sandbox the embedder did not ask for and fire no event. One rule for every budget:
  a guest over a budget is terminated, and `reset()` is the embedder's choice. Before, one timer per element was
  restarted by every `execute()` and rebuilt the environment even after code that had finished, with no
  `terminated` event. Work the code scheduled for later is the watchdog's to bound. The "Revisit if" above is met
  only in part: `execute()` reports completion, but guest code as a whole does not, so there is still no `running`
  state.
- **Every build failure is a termination.** A build that threw (a directive given a string instead of a list,
  for example) used to escape `setConfig()` or `reset()` and leave the element `loading`, with no frame and no
  event. Now `initialize()`, the one place a build starts, and the frame's load handler, where it completes, end
  any throw with `terminated` and `the environment could not be built: …`; and `setConfig()` copies its argument
  with `structuredClone` first, so a config that cannot be copied (a `Proxy`, a function value) or is not an object
  terminates with `the configuration could not be used: …`, applies nothing, and keeps every build closed until a
  usable config arrives, like an unknown mode (review A4). Each failed build attempt is one termination with its
  reason. The copy also means that arrays the caller changes later never change the policy a `reset()` builds.
- **No environment, one rule for work.** While `idle` (not in the document) or `terminated`, `call()` rejects at
  once with `TERMINATED` and `execute()` warns and does nothing. While idle, a call used to wait for the insertion,
  whose build then rejected it anyway, and executed code was dropped there silently.

Proof: `test/unit/followup-guarantees.test.ts`, `test/unit/policy-guarantees.test.ts` ("Every build failure is a
termination"), `test/unit/channel-guarantees.test.ts` ("B5"), `test/e2e/worker-timeout.spec.ts`,
`test/e2e/review-followup.spec.ts`.

## Amendment (2026-10-14): the execution budget is a free event loop at the deadline

**When**: the focused review of 2026-10-14 ([report](../../archive/reviews/FOCUSED-REVIEW-2026-10-14.md), F2 and F3). **Why**: the budget above trusted the
guest's word. Code that returned at once but left a loop scheduled (`setTimeout(() => { for (;;) {} }, 0)`) posted
`EXECUTED` and stopped its own timer, then looped; guest code that replaced `globalThis.Function` made the
bootstrap's `new Function(code)` return a function of its choosing, so `EXECUTED` was posted before the embedder's
code had run at all. Worker and strict mode, all three engines: neither was ever terminated.

**Decision**: `workerExecutionTimeout` bounds exactly this: **the guest's event loop is free at each `execute()`'s
deadline**.

- The guest reports nothing (`EXECUTED` is gone). At the deadline, `budget` ms after the element posts the code, the
  host pings the guest through the bootstrap's own `PING` handler, which guest code cannot reach (review B2), and
  terminates with the same line and reason as before unless a `PONG` arrives within `EXECUTION_TIMEOUT_GRACE_MS`
  (1000 ms). Only a free event loop can run the handler, so nothing the guest says or schedules can stand in for
  the answer. The check is a one-off watchdog over the grace (ticks, so a stall of the host page never counts), and
  its pings carry negative numbers, so an answer names its probe and never the liveness watchdog's.
- The bootstrap compiles executed code with the `Function` and `Reflect.construct` it captured before any guest
  code ran, so what runs is the embedder's code, at once.
- Several calls each have a deadline, and every deadline checks the one event loop: a loop started by any code ends
  the sandbox at the first deadline it blocks. Code that ran to its end and left the loop free is never terminated
  by this budget, whatever it scheduled.
- **Relation to `watchdogTimeout`**: the watchdog checks the event loop continuously, from the first `ready`; the
  execution budget checks it at points the embedder chose. A loop that starts after the last deadline is the
  watchdog's to bound. Both terminate; neither is a security boundary (decision 5).
- Alternatives rejected: keeping `EXECUTED` and adding the ping (the report would still be a thing the guest
  could forge or time; it adds nothing the ping does not prove); a grace of zero (a message in flight at the
  deadline would end a free guest); counting the grace in wall time (a host stall would be charged to the guest).

**And one rule for caught errors (F3).** A reason, a host line or a console warning of the element never carries
the text of an error it caught: only a fixed text and the error's name, checked to be a short identifier (a
thrown primitive is named by its type). Chromium's `DataCloneError` quoted the source of the function it could not
clone, a throwing getter's error carried any text, and the strict entry's error text is the guest's. The entry's
text now arrives as a `source: 'guest'` line; the reasons read `the configuration could not be used (DataCloneError)`
and `the environment could not be built (Error)`.

Proof: `test/e2e/focused-review.spec.ts` ("F2"), `test/unit/followup-guarantees.test.ts` ("B8, focused review F2"),
`src/lib/in-sandbox-script.test.ts`, `test/unit/focused-review.test.ts` ("F3").

## Amendment (2026-10-14): loading is bounded; one answer per build; one document

**When**: the broad review of 2026-10-14 ([report](../../archive/reviews/BROAD-REVIEW-2026-10-14.md), CB3, CB5, CB7).

- **`loading` is bounded (CB3).** A guest that called `document.open()` and never closed the document held Chromium
  and WebKit in `loading` indefinitely (measured past 30 s; Firefox completes the load). Decision: a build that has
  not completed within `LOAD_TIMEOUT_MS`, the liveness budget (5000 ms), counted in host ticks like every budget here
  (a host stall never counts), terminates with `the sandbox did not finish loading`. The wrapper's load waits for the
  guest document's subresources, so a guest page that needs longer than that for its images must load them after
  it loaded; that is the stated limit. Rejected: firing `ready` on the announcement alone (guest methods exposed by
  markup scripts would not exist yet at `ready`, which callers rely on); the embedder's `watchdogTimeout` (off by
  default, so `loading` would stay unbounded by default). *Superseded in part by the
  [check-in amendment](#amendment-2026-10-14-ready-is-the-guests-check-in): `ready` now comes with the announcement,
  the deadline bounds only that, and a startup gate in the guest answers the rejection above.*
- **The queue holds only calls still waiting (CB3).** A call made while loading that timed out stayed queued and ran
  at the next flush; a caller that retried ran it twice. A queued request now leaves the queue when its call settles.
- **One answer per build (CB5).** A `terminated` listener that called `reset()` on a refused config re-entered the
  build, which refused again and dispatched again, until the stack ran out (about 590 dispatches). Decision, at the
  build chokepoint: while a build termination is being dispatched, a nested build from the same inputs (no
  `setConfig()`, `load()` or file change in between) returns at once: same inputs, same answer, nothing dispatched
  again. Changing the inputs first builds normally.
- **One document (CB7).** An element moved into another document built an environment there that never connected
  (Chromium, WebKit), or, in Firefox, lost its prototype (Firefox gives an adopted element the new document's
  `HTMLElement` prototype), so its callbacks threw and its guest kept running. Decision: the lifecycle callbacks call
  module functions that use the element's own fields and `WebSandbox.prototype`, never the element's prototype
  chain; `adoptedCallback` tears down like a removal; `connectedCallback` builds only in the document of the realm
  that defined the element, and otherwise stays `idle` with one warning. Back in its own document, an element whose
  prototype Firefox replaced gets the class's prototype back and builds again.

Proof: `test/e2e/broad-review.spec.ts` ("CB3", "CB7"), `test/unit/broad-review.test.ts` ("CB3", "CB5").

## Amendment (2026-10-14): `ready` is the guest's check-in

**When**: after the independent verification of 2026-10-14 ([report](../../archive/reviews/VERIFICATION-2026-10-14.md), decision
1; backlog S46). **Why**: `ready` waited for the wrapper frame's load, and that load waits for the guest document's
own subresources, so `LOAD_TIMEOUT_MS` (the CB3 amendment above) bounded the guest's images too: a legitimate page
whose images took longer than 5 s was terminated. The bound and the subresources were in conflict only because one
event stood for both. Measured: the bootstrap's announcement arrives after about 26, 117 and 93 ms (Chromium,
Firefox, WebKit) while a 3 s image holds the wrapper's load to about 3.1 s; a guest that calls `document.open()` and
never closes it still announces within 22–40 ms.

**Decision**: `ready` means the guest's startup script checked in. In iframe and worker mode the host enters `ready`
when it accepts the announcement (ADR-002), whether or not the wrapper has loaded. The wrapper's load is recorded
and checked: a second load terminates as before (research 14.2), and so does a first load whose guest frame is not
the window that announced (a wrapper navigated before its first load fires one load, for a document the library did
not write). A guest without a bootstrap (no `allow-scripts`, or a policy that refuses it) is still `ready` on the
wrapper's load, and strict mode is unchanged (its view holds no guest bytes). `LOAD_TIMEOUT_MS` now bounds only the
wait for the check-in (or that load): the deadline-versus-subresources trade-off is gone by construction, since the
check-in comes before any guest byte is parsed.

The rejection in the CB3 amendment (methods exposed by markup scripts would not exist yet at `ready`) is answered in
the guest, by a startup gate in the bootstrap (iframe mode): the host's calls (`RPC_REQ`) and `execute()` frames that
arrive while the guest document is being parsed wait in one queue, in arrival order, until a trusted
`DOMContentLoaded` has fired (deferred and module scripts have run) or `readyState` reads `complete`, and never while
it reads `loading` (a guest that reopened its document). The queue is checked on every arriving frame, because
`document.open()` erases listeners. `PING` and `RPC_RES` never wait. At most `MAX_INBOUND_IN_FLIGHT` frames wait; past
that a call is answered `BUSY` and an `execute()` dropped with a log line. All of it runs on primitives captured
before guest code (ADR-002, B2), so guest code cannot open the gate early; it can only keep it closed for itself.

**Consequences**:
- A guest that never finishes parsing (`document.open()` without `close()`) is `ready` and alive, where Chromium and
  WebKit used to end it with `the sandbox did not finish loading`: the calls it is sent time out, and the watchdog,
  where it is on, keeps measuring its event loop.
- Methods a guest exposes from `async` scripts, after an `await`, or from its `load` event are not covered by the
  gate: a call that arrives first is `UNKNOWN_METHOD`, as for any method exposed late.
- `watchdogTimeout` now covers the guest's startup scripts (it starts at `ready`); `autoResize` may report while the
  document is still loading; `load()` and `setConfig()` reach `ready` sooner.
- Rejected: holding `ready` until `DOMContentLoaded` on the host (the host would again wait on guest behaviour, and a
  guest that never finishes parsing would have to be ended by a deadline); a separate `loaded` event or state (a new
  public name, and nothing to decide with it that the gate does not already decide).

Proof: `test/e2e/ready.spec.ts`, `test/e2e/broad-review.spec.ts` ("CB3"), `src/lib/in-sandbox-script.test.ts` ("the
startup gate").

## Amendment (2026-10-15): review round 1: strict `ready`, refused builds in a task, no rebuild for the same config

**When**: [review round 1](../../archive/reviews/REVIEW-ROUND-1-2026-10-15.md) (R3-1, R3-2, R3-7); backlog S50, S53.

- **Strict mode is `ready` on the view's check-in** (`VIEW_READY` on the view port), never on the frame's load alone:
  a view whose bootstrap the host page's policy refused never checks in, and the build ends at `LOAD_TIMEOUT_MS` with a
  reason that names the host page's policy (ADR-005 amendment of the same day). The load deadline tells the two cases
  apart: a frame that did not load, or a frame that loaded whose startup script did not run.
- **A refused build's `terminated` comes in a task**, like `ready`: `state` is `terminated` when `setConfig()`,
  `reset()` or `load()` returns, and a listener added right after hears the event. An answer that is no longer the
  state (another build or the element's removal before the task) is never dispatched. CB5's guard is unchanged: a
  listener that builds again from the same inputs during the dispatch gets the same answer, once.
- **`setConfig()` of the configuration the standing environment was built from is no change**: no rebuild, while the
  environment is `loading` or `ready` and nothing else a build reads (`load()`, the files) changed since.

## Amendment (2026-10-19): review round 5: what waits for `ready` leaves at `ready`

**When**: review round 5 (L-1, class L of [research 18](../../research/18_finding_classes/README.md)). **Why**: strict mode
posted the queued calls and `execute()` code when the wrapper loaded, which hands the view its ports, and the build
became `ready` later, at the view's check-in. A call made while loading whose timeout fell between the two had left
already: its caller was told `TIMEOUT`, and the guest ran it (with a large initial view the window is wide enough to
reproduce on every engine). CB3's rule, that a call which settles while queued never runs, held only where the flush and
`ready` were one moment: the other modes flushed in `setupChannel`, just before `ready`. Two flush points for one rule.

**Decision**: one flush point, the transition to `ready` (`_enterReady`), in every mode. Until then the queue holds
everything, also while a port exists (strict mode has one from the load); after it, calls and `execute()` go straight to
the port. The ports are still handed to the view at the load. This is the first slice of the lifecycle reducer (backlog
S65): the transition to `ready` is the only one with a flush.

Proof: `test/unit/review-round-5.test.ts` ("5:L-1": the owner's repro, and a model of the rule over random schedules in
every mode), `test/e2e/review-round-5.spec.ts` ("L-1", on Chromium, Firefox and WebKit).
