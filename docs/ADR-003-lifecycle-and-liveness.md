# ADR-003: How does the host observe and control a sandbox's lifecycle?

**Status**: Accepted · **Date**: 2026-10-11

## Context

Three needs meet in the element's lifecycle:

| Need | What it asks of the element |
| :--- | :--- |
| Lifecycle API (B2) | a supported way to stop a sandbox, rebuild it and read its state |
| Per-instance events (B3) | log lines on the element itself, so `SandboxDevTools`, which filters on `event.target`, prints its sandbox's lines, and two sandboxes can be told apart |
| Execution budget (S6) | a guest stuck in a loop can be stopped |

## Decision

1. **One bubbling event on the element.** `sandbox-log` is dispatched on the sandbox element with `bubbles: true`.
   A listener on the element hears only that sandbox; a listener on `window` hears every sandbox, with the element as
   `event.target`, and `SandboxDevTools` listens on its element. Not `composed`: the element lives in the embedding
   page's DOM, and the library's events have no reason to cross a consumer's shadow boundary. The name stays
   namespaced because it bubbles: a generic `log` would collide with other code listening on `window`.
2. **Four states, no `running`.** `state` is `idle`, `loading`, `ready` or `terminated`. A listener of `ready` or
   `terminated` always reads the state its event announces: the state is stored before any effect runs, and the event
   is dispatched after it. There is no `running` state because nothing could make it true: `execute()` is
   fire-and-forget and the guest never reports that code finished.
3. **`terminate(reason?)` and `reset()`.** `terminate()` goes through the same path as the frame-integrity checks and
   the watchdog, which does nothing when the element is already terminated, so `terminated` fires once per
   termination. `reset()` rebuilds from any state, terminated included, and settles pending calls with `TERMINATED` like
   every other teardown.
4. **Removal tears down.** `disconnectedCallback` releases the frame, port, timers and watchdog, rejects pending calls
   with `TERMINATED` and returns to `idle`, without a `terminated` event: the embedder removed the element, nothing
   failed. Re-insertion builds a fresh environment. A frame outside the document is unusable, so keeping its port
   alive would only let calls hang. Moving the element is therefore a clean rebuild.
5. **An opt-in ping/pong watchdog, outside the broker.** With `watchdogTimeout` set, the host posts
   `{ type: 'PING', n }` on the port and the guest bootstrap answers `{ type: 'PONG', n }` before any broker dispatch.
   Four ticks per budget; termination after four silent ticks in a row, so a guest is stopped between one and 1.25
   budgets after its last answer. Ticks, not timestamps: time in which the host itself was stalled produces no ticks and
   is never held against the guest. The watchdog belongs to one frame generation, starts at `ready` and stops with
   its generation.

**What the watchdog can and cannot bound.** It detects a blocked guest event loop. That holds where the guest runs on a
different thread or process from the host: worker mode on every browser, strict mode on every browser (below), and
cooperative mode where the browser runs the sandboxed frame in its own process. That is browser policy and varies even
within one browser, so nothing is claimed per browser; the cooperative-mode test measures the process model at runtime
and asserts the contract that applies. Where the frame shares the host's thread, a guest loop stops the watchdog's
timers too: a platform limit. It is a liveness check, not a security boundary: a guest that answers pings is only
alive, and the host keeps explicit control through `terminate()`.

### The lifecycle is one reducer

The state is not kept by the code that reacts to the DOM. Every platform callback, timer, embedder call and build
result is an input to one pure function, `reduce(state, input)` (`src/lib/lifecycle.ts`), which returns the next state
and a list of effects; the executor stores the state first and then applies the effects in order.
[ARCHITECTURE.md](../ARCHITECTURE.md#the-lifecycle-one-reducer-one-executor) lists the states, inputs, effects and
transitions, generated from the code. The rules this ADR decides, each one a case of the reducer:

- **Events come after the state, and a listener's reset or terminate is never undone.** Every teardown increments an
  environment count (the generation). Every input from a callback, timer or build carries the generation it was armed
  in, and `reduce` drops one from an environment that is gone. The executor compares the count in one place and stops
  an output's remaining effects once embedder code (a listener of an event just dispatched) tore the environment down,
  so a `sandbox-log` listener that calls `terminate()` is not undone by the rebuild that was to follow, and one that
  calls `reset()` does not have its new environment torn down. `terminate()` and `reset()` called by the embedder carry
  no generation and act on whatever stands.
- **One rule for every budget: a guest over a budget is terminated.** `reset()` is the embedder's choice, because
  rebuilding would bring back a sandbox the embedder did not ask for and fire no event.
- **Every build failure is a termination.** A build that threw (a directive given a string instead of a list, for
  example) ends with `terminated` and `the environment could not be built (<error name>)`. `setConfig()` copies its
  argument with `structuredClone` first, so a config that cannot be copied (a `Proxy`, a function value) or is not an
  object terminates with `the configuration could not be used (<error name>)`, applies nothing, and keeps every build
  closed until a usable config arrives, like an unknown mode. The copy also means that arrays the caller changes later
  never change the policy a `reset()` builds. Each failed build attempt is one termination with its reason.
- **A refused build's `terminated` comes in a task**, like `ready`: `state` is `terminated` when `setConfig()`,
  `reset()` or `load()` returns, and a listener added right after hears the event. An answer that is no longer the state
  (another build, or the element's removal, before the task) is never dispatched. While a build termination is being
  dispatched, a nested build from the same inputs (no `setConfig()`, `load()` or file change in between) ends with the
  same answer and dispatches nothing again, so a `terminated` listener that calls `reset()` cannot recurse.
- **`setConfig()` of the configuration the standing environment was built from is no change**: no rebuild, while the
  environment is `loading` or `ready` and nothing else a build reads (`load()`, the files) changed since.
- **No environment, one rule for work.** While `idle` (not in the document) or `terminated`, `call()` rejects at once
  with `TERMINATED` and `execute()` warns and does nothing.
- **A reason, a host line or a console warning never carries the text of an error it caught**: only a fixed text and
  the error's name, checked to be a short identifier (a thrown primitive is named by its type). The text of an error can
  hold anything: a `DataCloneError` quotes the source of the function it could not clone, and the strict entry's error
  text is the guest's, which arrives as a `source: 'guest'` line.
- **One document.** The lifecycle callbacks call module functions that use the element's own fields and
  `WebSandbox.prototype`, never the element's prototype chain (Firefox gives an element adopted into another document that
  document's `HTMLElement` prototype). `adoptedCallback` tears down like a removal; `connectedCallback` builds only in the
  document of the realm that defined the element, and otherwise stays `idle` with one warning. Back in its own document, an
  element whose prototype Firefox replaced gets the class's prototype back and builds again.

### `ready` is the guest's check-in

`ready` means the guest's startup script checked in. In cooperative and worker mode the host enters `ready` when it
accepts the guest's announcement ([ADR-002](ADR-002-host-guest-broker.md)), whether or not the wrapper has loaded; the
wrapper's load waits for the guest document's subresources, and a deadline on that load would bound the guest's images.
In strict mode the build is `ready` on the view's `VIEW_READY`, the first frame on the view port, never on the frame's load
alone ([ADR-005](ADR-005-strict-mode.md)).

- The wrapper's load is recorded and checked: a second load terminates (research 14.2), and so does a first load whose
  guest frame is not the window that announced (a wrapper navigated before its first load fires one load, for a document
  the library did not write). A guest without a bootstrap (no `allow-scripts`, or a policy that refuses it) is `ready`
  on the wrapper's load.
- **`loading` is bounded.** A build that has not completed within `LOAD_TIMEOUT_MS` (5000 ms, counted in host ticks like
  every budget here, so a host stall never counts) terminates with `the sandbox did not finish loading`. It bounds only
  the wait for the check-in, which comes before any guest byte is parsed, so a guest that calls `document.open()` and
  never closes the document is `ready` and alive. The load deadline also tells two cases apart: a frame that did not load,
  and a frame that loaded whose startup script never ran, which ends with a reason that names the host page's policy.
- **What waits for `ready` leaves at `ready`.** Calls and `execute()` code issued while loading wait in one queue, in
  the order issued, and are posted to the port at the transition to `ready`, in every mode: it is the reducer's only
  transition with a `flush`. A queued call that settles first (its timeout) leaves the queue and is never posted. After
  `ready`, calls go straight to the port.
- **The startup gate in the guest** (cooperative mode): the host's calls (`RPC_REQ`) and `execute()` frames that arrive
  while the guest document is being parsed wait in the bootstrap, in arrival order, until a trusted `DOMContentLoaded`
  has fired (deferred and module scripts have run) or `readyState` reads `complete`, and never while it reads `loading`
  (a guest that reopened its document). The queue is checked on every arriving frame, because `document.open()` erases
  listeners. `PING` and `RPC_RES` never wait. At most `MAX_INBOUND_IN_FLIGHT` frames wait; past that a call is answered
  `BUSY` and an `execute()` dropped with a log line. All of it runs on primitives captured before guest code
  ([ADR-002](ADR-002-host-guest-broker.md)), so guest code cannot open the gate early; it can only keep it closed for
  itself.

### Strict mode bounds execution on every engine

In strict mode guest code runs only in a worker, and `watchdogTimeout` and `workerExecutionTimeout` watch that worker, so
a guest loop never blocks the host's timers, on any engine and whatever the browser's process model.

- **Asserted on Chromium, Firefox and WebKit** (`test/e2e/watchdog.spec.ts`): an endless loop at the entry's top level
  and one started through `execute()` are terminated between one and 1.25 budgets after the last answer, the host
  answering in well under 500 ms meanwhile; `reset()` recovers.
- **Rendering is host-thread work where the view shares the host's thread** (Firefox, WebKit). A worker that renders and
  then loops is still stopped, within the budget plus the stall of the one render in flight (flow control, ADR-005); the
  stall is bounded in [API.md, "The view's cost to the host page"](API.md#the-views-cost-to-the-host-page). Ticks still
  never count a host stall against the guest.
- **A second, always-on liveness check, for the view.** The host pings the view on its own port with a budget of
  `VIEW_LIVENESS_TIMEOUT_MS` (5 s). The view runs no guest script, so it answers unless it is gone — Chromium replaces a
  view whose navigation the wrapper refuses with an error page, ending the worker with it (research 15, P4) — or
  rendering keeps its thread busy that long; either way the sandbox terminates with `the sandbox view stopped responding`
  instead of going silent. Not configurable, since it watches the library's own document, not guest work.
- **Entry failure is a termination.** An entry that does not start (a syntax error, a throw at its top level) terminates
  with `the guest entry failed to start`; later uncaught errors are logged.

The watchdog is still opt-in for guest logic, and a worker that ends itself is noticed only through it.

### `workerExecutionTimeout`: a free event loop at the deadline

`workerExecutionTimeout` (worker and strict mode) bounds exactly this: **the guest's event loop is free at each
`execute()`'s deadline**. The guest reports nothing. At the deadline, `budget` ms after the element posts the code, the
host pings the guest through the bootstrap's own `PING` handler, which guest code cannot reach, and terminates unless a
`PONG` arrives within `EXECUTION_TIMEOUT_GRACE_MS` (1000 ms): a `sandbox-log` line `Execution Timeout` (`source:
'host'`), then `terminated` with `the executed code ran longer than workerExecutionTimeout`. Only a free event loop can
run the handler, so nothing the guest says or schedules can stand in for the answer. The check is a one-off watchdog
over the grace (ticks, so a stall of the host page never counts), and its pings carry negative numbers, so an answer
names its probe and never the liveness watchdog's.

- The bootstrap compiles executed code with the `Function` and `Reflect.construct` it captured before any guest code
  ran, so what runs is the embedder's code, at once.
- Several calls each have a deadline, and every deadline checks the one event loop: a loop started by any code ends the
  sandbox at the first deadline it blocks. Code that ran to its end and left the loop free is never terminated by this
  budget, whatever it scheduled.
- **Relation to `watchdogTimeout`**: the watchdog checks the event loop continuously, from `ready`; the execution budget
  checks it at points the embedder chose. A loop that starts after the last deadline is the watchdog's to bound. Both
  terminate; neither is a security boundary.

The mechanism and its reasoning live in the comments of [`src/lib/lifecycle.ts`](../src/lib/lifecycle.ts),
[`src/host.ts`](../src/host.ts) and [`src/lib/watchdog.ts`](../src/lib/watchdog.ts). The proof is
[`src/lib/watchdog.test.ts`](../src/lib/watchdog.test.ts) (timing, unit), `test/unit/lifecycle-reducer.test.ts` (the
reducer against the reference model), and [`test/e2e/lifecycle.spec.ts`](../test/e2e/lifecycle.spec.ts),
[`events.spec.ts`](../test/e2e/events.spec.ts), [`ready.spec.ts`](../test/e2e/ready.spec.ts),
[`watchdog.spec.ts`](../test/e2e/watchdog.spec.ts) and [`worker-timeout.spec.ts`](../test/e2e/worker-timeout.spec.ts)
(end to end).

## Alternatives considered

### Keep `window` events, add an opt-in global mirror

Dispatch on the element and mirror to `window` behind a flag for the playground. Rejected because a bubbling event
already reaches `window`, with the right target, so the flag would add a setting and a second dispatch path that gives
nothing a bubbling event does not.

### A heartbeat as a broker call

The host could `call('__heartbeat')` on a guest method. Rejected: it would occupy a method name in the guest's
namespace, which guest code could replace or that could collide with a guest's own `expose`, and each beat would be a
pending call with its own timer and refusal path. A dedicated frame type answered before the broker has none of that.

### An always-on watchdog

Rejected: any budget is wrong for some guest. A guest doing legitimate synchronous work longer than the budget (parsing
a large file, a heavy first render) would be terminated, and where the frame shares the host's thread the watchdog
cannot help anyway. The embedder knows the workload, so the embedder opts in and picks the budget.

### A `running` state

Rejected for the reason in decision 2: a state that is not reported by anything would be a guess. If `execute()` ever
reports completion, the state can be added then.

### A report from the guest to end the execution budget

Keeping an `EXECUTED` report and adding the ping would leave a thing the guest could forge or time; it adds nothing the
ping does not prove. A grace of zero would end a free guest when a message is in flight at the deadline; counting the
grace in wall time would charge a host stall to the guest.

### `ready` before the guest document is parsed, without a gate; or a later `ready`

Firing `ready` on the announcement alone, with no startup gate, would leave methods exposed by markup scripts missing at
`ready`, which callers rely on; the gate answers that in the guest. Holding `ready` until `DOMContentLoaded` on the host
would make the host wait on guest behaviour again, and a guest that never finishes parsing would need a deadline to end
it. A separate `loaded` event or state would be a new public name, with nothing to decide with it that the gate does not
already decide. The embedder's `watchdogTimeout` cannot bound `loading` (it is off by default).

## Consequences

- An element listener hears exactly one sandbox, and `SandboxDevTools` prints its sandbox's logs.
- `state` and the `terminated` event agree, and `terminated` fires once per termination; `state === 'terminated'`
  confirms a call's `TERMINATED` code from the element's own state.
- Pending calls settle on every teardown: reset, terminate, the watchdog and removal.
- With the watchdog on, a guest stuck in a loop is terminated in worker and strict mode everywhere and in cooperative
  mode wherever the frame runs out of process, while the host page stays responsive; where it shares the host's thread,
  the host's stall is never charged to the guest.
- A guest that never finishes parsing is `ready` and alive: the calls it is sent time out, and the watchdog, where it
  is on, keeps measuring its event loop.
- `watchdogTimeout` covers the guest's startup scripts (it starts at `ready`); `autoResize` may report while the
  document is still loading; `load()` and `setConfig()` reach `ready` as soon as the guest checks in.

Costs and limits:

- **Same-thread frames are not bounded in cooperative mode**: on WebKit and wherever else the frame shares the host's
  thread, a guest loop in cooperative mode freezes the host page until it yields (a documented cooperative-mode limit,
  S44).
- **Watchdog false positives are the embedder's choice**: a budget shorter than the guest's longest synchronous task
  stops it.
- **Memory is not bounded**; inbound traffic is, per channel ([API.md, Budgets](API.md#budgets)).
- **Methods a guest exposes from `async` scripts, after an `await`, or from its `load` event** are not covered by the
  startup gate: a call that arrives first is `UNKNOWN_METHOD`, as for any method exposed late.

### Revisit if

- `execute()` gains completion reporting, which would make a `running` state truthful.

History: [the amendments to this decision](archive/adr/ADR-003-history.md).
