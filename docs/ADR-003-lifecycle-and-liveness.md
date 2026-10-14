# ADR-003: How does the host observe and control a sandbox's lifecycle?

**Status**: Accepted · **Date**: 2026-10-11 · **Amended**: 2026-10-13 ([strict mode bounds execution on every engine](#amendment-2026-10-13-strict-mode-bounds-execution-on-every-engine)), 2026-10-14 ([a listener's reset or terminate is never undone](#amendment-2026-10-14-a-listeners-reset-or-terminate-is-never-undone))

## Why this ADR exists

Three backlog items met in one place, the element's lifecycle:

| Item | What was missing |
| :--- | :--- |
| B2 · lifecycle API | teardown was private: no supported way to stop a sandbox, rebuild it, or read its state |
| B3 · per-instance events | log lines were dispatched on `window`, so `SandboxDevTools`, which filters on `event.target`, printed nothing, and two sandboxes could not be told apart |
| S6 · execution budget | in iframe mode nothing could stop a guest stuck in a loop; only worker mode had a timeout |

## Decision

1. **One bubbling event on the element.** `sandbox-log` is dispatched on the sandbox element with
   `bubbles: true`. A listener on the element hears only that sandbox; a listener on `window` still
   hears every sandbox, with the element as `event.target`. The existing window listeners (the
   playground, the e2e harness) keep working unchanged, and `SandboxDevTools` now listens on its
   element. Not `composed`: the element lives in the embedding page's DOM, and the library's events
   have no reason to cross a consumer's shadow boundary. The name stays namespaced because it
   bubbles: a generic `log` would collide with other code listening on `window`.
2. **Four states, no `running`.** `state` is `idle`, `loading`, `ready` or `terminated`, changed in
   one method that also dispatches `ready` and `terminated` after setting it, so a listener always
   reads the state its event announces. There is no `running` state because nothing could make it
   true: `execute()` is fire-and-forget and the guest never reports that code finished.
3. **`terminate(reason?)` and `reset()`.** `terminate()` goes through the same path as the
   frame-integrity checks and the watchdog, which returns early when already terminated, so
   `terminated` fires once per termination. `reset()` rebuilds from any state, terminated included,
   and settles pending calls with `TERMINATED` like every other teardown.
4. **Removal tears down.** `disconnectedCallback` releases the frame, port, timers and watchdog,
   rejects pending calls with `TERMINATED` and returns to `idle`, without a `terminated` event: the
   embedder removed the element, nothing failed. Re-insertion builds a fresh environment. A frame
   outside the document is unusable, so keeping its port alive would only let calls hang. As a side
   effect, moving the element is now a clean rebuild instead of tripping the second-load check.
5. **An opt-in ping/pong watchdog, outside the broker.** With `watchdogTimeout` set, the host posts
   `{ type: 'PING', n }` on the port and the guest bootstrap answers `{ type: 'PONG', n }` before any
   broker dispatch. Four ticks per budget; termination after four silent ticks in a row, so a guest
   is stopped between one and 1.25 budgets after its last answer. Ticks, not timestamps: time in
   which the host itself was stalled produces no ticks and is never held against the guest. The
   watchdog belongs to one frame generation and stops with it.

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

The mechanism and its reasoning live in the comments of [`src/host.ts`](../src/host.ts) and
[`src/lib/watchdog.ts`](../src/lib/watchdog.ts). The proof is
[`src/lib/watchdog.test.ts`](../src/lib/watchdog.test.ts) (timing, unit) and
[`test/e2e/lifecycle.spec.ts`](../test/e2e/lifecycle.spec.ts),
[`events.spec.ts`](../test/e2e/events.spec.ts) and
[`watchdog.spec.ts`](../test/e2e/watchdog.spec.ts) (end to end, iframe and worker mode).

## Alternatives considered

### Keep `window` events, add an opt-in global mirror

What B3 originally proposed: dispatch on the element and mirror to `window` behind a flag for the
playground. Rejected because a bubbling event already reaches `window`, with the right target, so
the flag would add a setting and a second dispatch path that gives nothing a bubbling event does
not.

### A heartbeat as a broker call

The host could `call('__heartbeat')` on a guest method. Rejected: it would occupy a method name in
the guest's namespace, which guest code could replace or that could collide with a guest's own
`expose`, and each beat would be a pending call with its own timer and refusal path. A dedicated
frame type answered before the broker has none of that.

### An always-on watchdog

Rejected: any budget is wrong for some guest. A guest doing legitimate synchronous work longer than
the budget (parsing a large file, a heavy first render) would be terminated, and where the frame
shares the host's thread the watchdog cannot help anyway. The embedder knows the workload, so the
embedder opts in and picks the budget.

### A `running` state

Rejected for the reason in decision 2: a state that is not reported by anything would be a guess.
If `execute()` ever reports completion, the state can be added then.

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

**When**: backlog S6, strict mode ([ADR-005](ADR-005-strict-mode.md)), the "Revisit if" above. **Decision**: in
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

**When**: the adversarial review of 2026-10 ([report](security/ADVERSARIAL-REVIEW-2026-10.md), B5). **Why**: two
host paths dispatched a log line and then acted on the environment: the execution timeout (log, then rebuild)
and an entry that failed to start (log, then terminate). A `sandbox-log` listener that called `terminate()` had
it undone by the rebuild; one that called `reset()` had its new environment torn down.

**Decision**: the element counts environments (every teardown increments the count). A host path that dispatches
an event and then acts compares the count first and does nothing if a listener has torn the environment down
meanwhile. The lifecycle events keep their rule from decision 2 (dispatched after the state is set, last in
their path), so they needed no change. Proof: `test/unit/channel-guarantees.test.ts` ("B5").
