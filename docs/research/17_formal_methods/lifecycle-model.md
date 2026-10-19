# The lifecycle reference model (for S61)

Review round 4's lifecycle reviewer tested `<web-sandbox>` against a reference model written from README.md and
docs/API.md. It ran 2,100 seeded runs from 1,300 sequences on Chromium, Firefox and WebKit, and reached all 216
(operation, state, mode) combinations on each engine. This note keeps the model and the generator as the reviewers
wrote them. The model described the element at `c7672bb`, before round 4's fixes; round 5 updated it (see the end).

**The model now lives in `test/model/`** (S61.2, the first step of S65), updated to the element at `446017a`. See
[The committed suite](#the-committed-suite-testmodel) for what it covers and how to run it.

## Model state

- `where`: none, own document, or a foreign document.
- `state`: idle, loading, ready or terminated.
- `cfg`, the effective config:
  - mode and html;
  - `scriptUnsafe` (only a literal `true`), `guestWrites`, `autoResize`, capabilities and entry;
  - watchdog and execution timeouts (a finite number > 0, otherwise off);
  - whether the fetch bridge is on;
  - the call budget (a finite number ≥ 1, otherwise the default);
  - `allowAnimations` and `allowAutoplay` (left out gives the default, a boolean is itself, anything else is `false`).
- The refusal, if any.
- `lastCopy` and `lastInputs`, plus an `inputs` counter.
- The files map.
- A teardown counter, `gen`.
- The current environment:
  - its id and mode;
  - whether a bootstrap runs;
  - the agent (yes, no or bad) and the startup gate (yes, maybe or no);
  - `ready`, `busy` and `executed`;
  - budgets, observed line times and host-call times.
- The pending build termination (reason and time).
- A stack of the `terminated` reasons being dispatched, and `buildWithin`.
- Pending guest writes, host methods, and the list of calls.

## Transitions

| Operation | Effect |
| :--- | :--- |
| `initialize()`: setConfig unless it is a no-op, load, reset, insert, move back | `buildWithin` = the reason being dispatched, if any. Teardown: `gen++`, the pending build event is cancelled, every unsettled call must end `TERMINATED`, the environment is dropped. Writes are cleared. Not in its own document: `idle`. Otherwise `loading`; a refusal gives `terminated` plus one pending event in a task, unless the refusal equals `buildWithin`. |
| `stop()`: remove, move to a foreign document | Teardown, writes cleared, `idle`. |
| `terminate(r)` | A no-op when already terminated. Otherwise teardown, `terminated`, and one synchronous event with `r`, or the default reason if `r` is not a non-blank string. |
| `setConfig(c)` | A no-op if the clone succeeds, there is no refusal, the state is loading or ready, `inputs` is unchanged and the copy equals `lastCopy`. Otherwise `inputs++`, refuse ("could not be used (Name)") or store, then `initialize()`. |
| File operations | If something changed: `inputs++` and one synchronous `fileschanged`. |
| `execute` | Accepted only if it is a string, `scriptUnsafe` is on and the state is loading or ready; otherwise exactly one warning. An agent installed by `execute` marks the environment. |
| `call` | The outcome set is decided at call time. `TERMINATED` while idle or terminated (getters in the arguments never run). `INVALID_CALL` for a name longer than 256. `TERMINATED` if `gen` changed during the call. `ARGS_NOT_TRANSFERABLE`. Otherwise, the outcomes the environment allows (agent, gate, bootstrap). `TIMEOUT` only after the timeout has passed. `BUSY` only at a gate, after a flood, or at 256 in flight. |

## Checks on what is observed

- **`ready`.** At most once per environment, only from `loading`, always from a task.
- **`terminated`.** As in the transitions above. A termination the element starts on its own is accepted only if the
  environment allows it:
  - the watchdog needs a timeout > 0 and a busy guest;
  - the execution timeout needs it set, a busy guest and an `execute()`;
  - "entry failed" needs the bad entry.
- **`sandbox-log`.** A guest line needs a standing environment and a matching `[env:N]` tag. A host line must be on a
  whitelist.
- **`fileswritten`.** The paths must already be listed.
- **`fetch`.** The record belongs to the current environment, unless its outcome is `aborted`.
- **End of a sequence.** Wait 300 ms, remove the element, check that every call settled, then require 500 ms with no events.

## Generator

- **Random source.** Seeded mulberry32.
- **Per sequence.** One mode, and 0–3 re-entrant listener plans (`{ event, action, times, when: 'build', match }`) on
  `ready`, `terminated`, `sandbox-log`, `fileswritten` and `fetch`. Their actions are operation descriptors.
- **Prologue.** Register `agent.js`, setConfig, insert, settle.
- **Then 3–6 segments:**
  - churn: 3–7 lifecycle, file and call operations with no gaps;
  - calm: settle, then 3–8 guest steps and calls with waits;
  - scenario: a log bunch, a call flood, hide and show, the strict switches, a height check, many calls at the startup
    gate, 256 in flight, the CB5 rule, a call with an argument getter, the default call budget, a refusal termination.
- **Configs, valid and invalid.**
  - mode: `'iframe'`, `'Strict'`, 7, `null`;
  - configs that are not objects, and functions;
  - `origins` that are not an object or not lists;
  - `callLimits`: `Infinity`, 0, −3, `NaN`, `'10'`, `null`, `'bogus'`, `[]`, a small byte budget;
  - switch values: `'no'`, 0, `null`, `'true'`, 1;
  - configs with getters.
- **Arguments.** Plain data, a function, an Error, or a getter that runs an action.
- **Timeouts.** 0, −1, `NaN`, `Infinity`, 2^31+5, 2^32, 1e12.
- **Guest steps.** They go through an agent that exposes `act(spec)`, installed as the strict entry, as cooperative
  markup, or by `execute()` in worker mode. The step kinds:
  - busy, throw, reject;
  - log bursts, unusual logged values;
  - write, many writes, remove;
  - fetch, background fetch;
  - render, text, set, the strict switches;
  - grow, counter;
  - call the host, call it in the background, timed floods;
  - expose late.

## As a fast-check suite

The plan was a fast-check `commands` suite. fast-check is not a dependency, so the committed suite keeps the reviewers'
own tools instead: a seeded mulberry32 and delta debugging (below).

## Changes for `60814b5` (review round 5)

Round 5's lifecycle reviewer updated the model to the element after round 4's fixes:
- **The no-repeat rule.** `buildWithin` is the innermost `terminated` reason being dispatched, for every `terminated`,
  not only a build's.
- **Notices.** Each notice dispatches one event, and the next runs only if `gen` is unchanged. An entry failure gives
  the host line, then the guest line, then the termination.
- **Build completion.** A frame's load completes a build only in a microtask that re-checks the frame, `gen` and the
  connections. `ready` inside any DOM operation is a divergence.
- **The call budget.**
  - The default `maxPerSecond` is 1000.
  - Each field must be a finite number ≥ 1, otherwise its default with a warning; a `callLimits` that is not an object gives both defaults.
  - The byte budget is modelled too: at `60814b5`, a guest call whose frame weighs more than `maxBytesPerSecond` is always `BUSY` (round 5's L-2).
- **Call outcomes.** `ARGS_NOT_TRANSFERABLE` for a function, an Error, an unknown kind or a throwing getter in the
  arguments. `TERMINATED` when a getter changes `gen`.
- **The worker.** A probe checks that it has no `postMessage`, `onmessage` or `onmessageerror`, own or inherited.
- **Guest writes.** The model applies a change when `fileswritten` arrives:
  - exactly one event per change to the list;
  - none for a removal of a build path the host has unregistered since;
  - a withdrawn write is announced with nothing listed.
- **The view.**
  - Refused `src`, `srcset` and `poster` URLs are dropped and reported as `source: 'view'` violations, at most 100 per directive.
  - Dropped URLs do not count toward `VIEW_MAX_URLS` (1000; a render past it is refused with the documented line).
  - `VIEW_URLS_PER_SECOND` is 200.
  - The error-text drop notice is a guest `warn` line, at most once per environment, in strict mode only.
- **New checks.**
  - Event details are frozen (round 5's L-3).
  - A call made while loading that times out before `ready` never runs (round 5's L-1, failing in strict mode at `60814b5`).
- **Generator additions.**
  - Order and queued-timeout scenarios.
  - A fetch aborted by a teardown.
  - A `terminated` listener that rebuilds into the very reason.
  - Moves to a foreign document from every state, counting frames through `childNodes`: WebKit's `querySelectorAll` on the shadow root lists a removed frame after an adoption round trip.
- **Coverage.**
  - 1,050 sequences (350 per engine), plus 12 sweeps and 6 tight loops per engine.
  - 216 of 216 combinations reached on each engine.
  - The round-4 L-1 loop: 1,438–1,448 iterations per engine, clean.

## The committed suite (`test/model/`)

The model, updated to the element at `446017a` (after round 5's fixes, S64), and its generator are permanent tests. The
lifecycle reducer (S65) is refactored against them.

| File | What it is |
| :--- | :--- |
| `test/model/lifecycle-model.ts` | The model, pure TypeScript: its state, one transition per operation (preconditions, the state it leads to, the events it must dispatch synchronously) and the checks on what is observed afterwards. |
| `test/model/generator.ts` | The seeded generator (mulberry32) and the shrinker (delta debugging over the commands, then the listener plans). |
| `test/model/runner.ts` | Runs one sequence against the real element in the e2e harness page and feeds every observation to the model. |
| `test/e2e/lifecycle-model.spec.ts` | N sequences per engine, plus round 4's L-1 as a property. |
| `test/unit/lifecycle-model.test.ts` | The model itself, on hand-written traces of round 4's L-1 and L-3 and round 5's L-1, L-2 and L-3. |

**The rules of `446017a` it holds the element to.**
- `ready` is the only flush point, in every mode: a call made while `loading` that times out before `ready` never runs.
- One "no repeat" rule for every `terminated`: a build started while a `terminated` is dispatched, and refused with that
  very reason, ends `terminated` without another event.
- Every event detail is frozen, deeply.
- A guest call heavier than `callLimits.maxBytesPerSecond` is `ARGS_NOT_TRANSFERABLE`, guest writes included, and never
  announced.
- One diff for guest writes: exactly one `fileswritten` per change of what `listGuestWrites()` shows at a path; none for
  the same bytes again, nor for a removal of a file the host unregistered since the build; a withdrawn write is announced
  with nothing listed.
- A termination the element starts is accepted only when the environment allows it: the watchdog (a timeout and a busy
  guest), `workerExecutionTimeout` (a timeout and a busy `execute()`), the strict entry's failure (a throwing entry), the
  load deadline (`LOAD_TIMEOUT_MS` of loading). The uncaught budget, `VIEW_MAX_OPERATION_MS` and
  `VIEW_MAX_DISTINCT_URLS` are not approached by the generator, so their terminations are divergences here; their edges
  have their own specs (`review-round-5.spec.ts`, `view-round-5.spec.ts`). The view's first overrun (backlog S72) is
  a host line the model allows in any standing strict environment: the meter measures wall time, which a loaded
  machine can push past `VIEW_MAX_OPERATION_MS` with the generator's small views, and the line changes no state; the
  second overrun's termination stays a divergence.

**What it generates.** One mode per sequence (by seed), 0–3 re-entrant listener plans on `ready`, `terminated`,
`sandbox-log`, `fileswritten` and `fetch`, a prologue, then 3–6 segments of churn, calm guest steps, or a scenario (an
argument getter that runs an action, calls with timeouts around the check-in, a move 12–30 ms into a rebuild, a
termination the element starts, guest writes listed and committed). The operations: insert, remove, move to and from a
foreign document, `setConfig()` (valid, an unknown mode, unusable configs), the same config again, `load()`, `reset()`,
`terminate()`, `registerFiles()` (and a refused batch), `unregisterFiles()`, `expose()`, `call()`, `callWithTimeout()`,
`execute()`, `listGuestWrites()`, `commitGuestWrites()` and the guest steps of the agent's `act(spec)` (logs, a throw, an
uncaught error, busy loops, writes and removals, fetches, calls to the host, a late expose).

**Coverage.** The spec prints the (operation, state, mode) combinations each chunk reached (`MEASURED …`) and the keys
(`COVERAGE …`): 18 operations × 4 states × 3 modes = 216 combinations. At `446017a`, 40 sequences per engine reach
174–176 of them, and 500 sequences per engine all 216 on Chromium, Firefox and WebKit. The other keys count what the
checks saw: a refusal's `terminated` from a task, terminations the element started (strict and worker mode; cooperative
mode's watchdog fires only where the frame has its own process), `fileswritten` announced and not, guest calls answered
`ARGS_NOT_TRANSFERABLE` and `BUSY`, `fetch` records.

**Running it.**
- CI: `bun run test:e2e test/e2e/lifecycle-model.spec.ts` runs 40 sequences per engine (in chunks of 10, which the
  workers share) and the L-1 property (120 moves and removals per mode).
- Nightly: `WEB_SANDBOX_MODEL_RUNS=2000 bun run test:e2e test/e2e/lifecycle-model.spec.ts`; `WEB_SANDBOX_MODEL_SEED`
  moves the first seed, so successive nights cover new sequences.
- A divergence is shrunk and printed with its seed, the minimal sequence as JSON and its trace;
  `WEB_SANDBOX_MODEL_REPRO='<json>'` runs that sequence again.
- The model itself: `bun x vitest run test/unit/lifecycle-model.test.ts`.

**Checked against mutants.** Each rule above was checked to bite: with the detail freeze removed from `fileschanged`,
with round 4's no-repeat rule removed, and with round 5's L-1 flush at the wrapper's load put back, the suite diverged
within 60 sequences on Chromium, and shrank each to a few commands.

**Its first finding (LM-1, open).** At 500 sequences per engine, WebKit seed 73 diverged: a `fetch` record with outcome
`ok`, of an environment a `fetch` listener had just torn down, was dispatched after the teardown, where API.md says only
an `aborted` record of a torn-down environment arrives then. A focused test in `lifecycle-model.spec.ts` makes it
deterministic (the host page's `fetch` answers four requests at once) and fails on all three engines; it is marked
`test.fail()` until the owner decides between reporting such a record `aborted` and documenting it.
