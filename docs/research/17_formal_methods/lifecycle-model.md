# The lifecycle reference model (for S61)

Review round 4's lifecycle reviewer tested `<web-sandbox>` against a reference model written from README.md and
docs/API.md. It ran 2,100 seeded runs from 1,300 sequences on Chromium, Firefox and WebKit, and reached all 216
(operation, state, mode) combinations on each engine. This note keeps the model and the generator, so that S61 can
commit them as a permanent fast-check `commands` suite. The model describes the element at `c7672bb`, before round 4's
fixes. Round 4 changed some of these rules, for example the "no repeat" rule now applies to every `terminated`, so
update the model when it is committed.

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

- One command class per operation: `check()` comes from the model's preconditions, and `run()` performs the operation,
  updates the model and asserts.
- It runs in the page through Playwright, because the real element needs a browser. fast-check's shrinking replaces the
  reviewer's delta debugging.
- Keep round 4's L-1 loop (remove or move the element 12–30 ms into a rebuild) as its own e2e property.
