# ADR-002: How should host and guest call each other?

**Status**: Accepted · **Date**: 2026-10-10

## Context

`execute()` is fire-and-forget, and without a call layer only log lines travel back from the guest, so neither side
could ask the other for a result. One layer under several features answers that: promise-based calls in both
directions. The features that ride it are the host-mediated `fetch` ([ADR-006](ADR-006-fetch-bridge.md)) and the
guest's file writes ([ADR-004](ADR-004-files-as-blob-urls.md)), both as reserved methods, and the embedder's own
`call()` and `expose()`. Frames that are fire-and-forget or that the library alone sends do not ride it: console
lines, uncaught errors, violation reports, content heights, liveness probes, and strict mode's render updates, which
travel on a port of their own from the worker to the view (below).

The broker is owned code. Penpal supplies the same correlation, and
[ADR-001](ADR-001-continue-or-adopt.md#hybrid-strategy-adopt-the-commodity-keep-the-differentiator)'s hybrid
strategy adopts commodity layers where they fit; this one does not (see the alternatives).

## Decision

**A typed, bidirectional request/response layer over a private `MessageChannel`.** Each side exposes its own
methods and calls the other side's. `execute()` stays the `scriptUnsafe`-gated escape hatch. The design choices, each
with its reason:

1. **One self-contained dispatcher, used by both sides.** The guest copy is injected by stringifying the same
   function the host imports (`createBroker`, `src/lib/rpc.ts`), so both sides run identical code. It therefore closes
   over nothing from module scope, takes every platform function it uses once, before any guest code runs, and avoids
   syntax the build compiles into module-scope helpers (it uses promise chains, never `async`/`await`).
2. **Allowlist-only dispatch through a `Map`.** A `Map` has no prototype chain, so only explicitly exposed names
   resolve; reserved and inherited names such as `__proto__` or `toString` invoke nothing.
3. **Arguments are clone-checked when the call is made.** A value that cannot cross the channel fails its own call
   at once (`ARGS_NOT_TRANSFERABLE`), rather than throwing later in a queue flush and taking other messages with it.
4. **Answers go back on the port the request arrived on.** Teardown closes that port, so an answer that settles after
   the frame is recreated is discarded rather than delivered to the next frame. This is what keeps frame
   generations isolated.
5. **Every call has a timeout, and teardown rejects pending calls.** 30 s by default, adjustable per call with
   `callWithTimeout` (`0` disables it), so unless a caller opts out no promise waits forever on an unresponsive peer,
   and none outlives the frame it was waiting on. A call made when no environment stands rejects at once with
   `TERMINATED`.

### Refusal codes

Every rejection is an `Error` with a single string `code` from a closed set in three disjoint groups:

- **Local-only**, minted by the side whose call is refused, from its own state, and producible by no response:
  `TIMEOUT`, `TERMINATED`, `SEND_FAILED`, `INVALID_CALL`.
- **Reported by the other side**: `UNKNOWN_METHOD`, `HANDLER_ERROR`, `RESULT_NOT_TRANSFERABLE`, `BUSY`,
  `ARGS_NOT_TRANSFERABLE`. The last two are also minted by the calling side for the same condition seen before
  sending (the other side's per-second budget; arguments that could never be carried).
- **Library codes**, reported only by a reserved method (below).

The response frame carries an optional `code`; both sides run the same dispatcher, so the two ends cannot disagree
about it.

- **A property, not an `Error` subclass.** The dispatcher is stringified into the guest and closes over nothing, so
  a class defined next to it would not exist there. And `instanceof` does not work across realms: the host page, the
  frame and the worker each have their own `Error`. A string property on a plain `Error` reads the same in all of them.
- **The other side's code is clamped on receipt.** The local codes drive what a caller does next (stop, retry,
  rebuild), so the other side must not be able to produce them. Only `UNKNOWN_METHOD`, `RESULT_NOT_TRANSFERABLE`,
  `BUSY` and `ARGS_NOT_TRANSFERABLE` pass through, as the receiver's own constants; any other value, including a local
  code, or none, becomes `HANDLER_ERROR`. The message stays the other side's text verbatim (cut at 65 536 characters):
  it is not trustworthy, and nothing needs to trust it.
- **One field with disjoint groups, not a category code plus a detail code.** The guarantee only needs the groups to
  be disjoint and the clamp to enforce that on receipt; a category on top adds a second field to branch on.
- **No separate retry field.** Whether to retry follows from the code: only `TIMEOUT` and `BUSY` are worth
  retrying, and `TERMINATED` only after the next `ready`. A second field would be one more thing that could disagree with the code.
- **How refusals are tested.** Each refusal test asserts the exact code, runs as the refused side (from inside the
  guest for guest-to-host calls), and checks that no handler ran. One test pins the code strings, since they are wire
  protocol.

*Credit*: typed refusal reasons, and the rule for testing them, come from Dialog DB
([repository](https://github.com/dialog-db/dialog-db);
[`dialog-capability/src/access.rs`](https://github.com/dialog-db/dialog-db/blob/facd672/rust/dialog-capability/src/access.rs),
[`.claude/rules/authority-tests.md`](https://github.com/dialog-db/dialog-db/blob/facd672/.claude/rules/authority-tests.md)).
Its separate retry/stop signal was not adopted, for the reason above.

### Reserved methods and library codes

Names starting with `sandbox:` are reserved. They live in a registry of their own, written only by `exposeReserved()`;
`expose()` never registers one, so no embedder or guest method can replace a library method. A reserved method may
refuse with a *library code* from a third closed group, disjoint from both groups above: the fetch bridge's `FETCH_*`
codes ([ADR-006](ADR-006-fetch-bridge.md)) and the file codes `INVALID_PATH`, `INVALID_FILE`,
`FILES_QUOTA_EXCEEDED`, `FILES_NOT_ALLOWED` and `FILES_BUSY`, reported by `sandbox:write`
([ADR-004](ADR-004-files-as-blob-urls.md)); any other handler's code is `HANDLER_ERROR`. The calling side accepts a
library code only for a call to a reserved name and only when created with `acceptLibraryCodes`, which only the
guest's broker is. So on the host every response is clamped exactly as above, and nothing the guest sends can produce
a library code there.

### The channel

- **The guest announces its port.** The bootstrap's first statement makes the `MessageChannel`, keeps `port1` in its
  closure and posts `port2` to the host page (`parent.parent`) as `{ type: 'SANDBOX_PORT' }`; worker mode's frame does
  the same and hands `port1` to its worker as the worker's one `INIT_PORT`. Nothing in the guest realm ever listens
  for a port: the guest's end never leaves the closure and the host's end never enters the guest.
  `document.open()` erases every listener of a window, so a design in which the host posted its port into the guest
  would hand the port to a listener the guest installed.
- **One announcement per environment.** The host installs one `message` listener on its window before it inserts the
  frame, and accepts exactly one announcement: a trusted message whose `source` is the guest frame's window (the
  browser's identity, not message content) carrying exactly one port. The listener stops the accepted announcement, so
  no other listener on the host window sees the port. A second announcement ends the environment (the guest reloaded or
  rewrote its document: `the guest frame announced itself again (it reloaded or rewrote its document)`); a forged
  announcement can only end the guest's own environment. One where no bootstrap runs (no `allow-scripts`, or a policy
  that refuses the inline bootstrap) is refused the same way.
- **The announcement is the guest's check-in.** The host takes the port and enters `ready` at once
  ([ADR-003](ADR-003-lifecycle-and-liveness.md)), without waiting for the wrapper's load. In cooperative mode the
  frames that run guest code (`RPC_REQ`, and `EXECUTE` beside the broker) wait in the bootstrap until the guest
  document is parsed, in one queue, so a call still reaches a method a classic script of the guest exposes;
  `RPC_RES` and `PING` are handled on arrival. The queue holds at most `MAX_INBOUND_IN_FLIGHT` frames; past that a call
  is refused with `BUSY` in the broker's frame shape.
- **The port never reaches guest code.** Every operation on the port and on the events that carry it uses primitives
  captured before guest code runs (`MessagePort.prototype.postMessage`, its `onmessage` setter, the `MessageEvent`
  getters, `stopImmediatePropagation`), called through a captured `Reflect.apply`; internal lists are written with a
  captured `defineProperty`. Patching any prototype afterwards changes nothing the bootstrap does. This makes the
  watchdog's guarantee hold by construction (a guest cannot answer pings from a nested worker while it loops) and
  means guest code cannot post frames of its own; it can still bend what the bootstrap reads (event getters, the
  measured box), so violation reports and heights remain claims, validated on the host.
- **Only the current port is heard.** The host handles a frame only if it arrived on the current environment's port
  (the logic or the view port), so a frame already queued from an environment a listener just reset changes nothing.
- **Logs are normalised and labelled.** `sandbox-log` carries `{ type: 'LOG', level, args, source }`: `level` from
  `log`, `info`, `warn`, `error`; `args` an array of at most 64 with strings cut at 64 Ki characters; `source` set by
  the host, `'guest'` for frames from the port and `'host'` for the element's own lines. Guest lines are limited to
  1000 per second per environment, with one warning; host lines never are. A rate, not a cap like `violation`'s,
  because log lines are a continuous channel of a running guest.

### Bounds

- **At most 256 inbound calls run at once per channel** (`MAX_INBOUND_IN_FLIGHT`). A further request is answered at
  once with `BUSY`, before its method runs. The count is kept per reply channel and the host passes one per port, so
  calls that never settle in one environment do not starve the next. Both sides run the same broker, so the host's
  calls into the guest are capped the same way.
- **Every message has a byte budget.** One measure, `createSizeOf()` (`src/lib/structured-size.ts`), estimates what
  structured clone copies, with every primitive captured when it is made, stringified into the guest like
  `createBroker`. Every RPC message is at most `RPC_MAX_BYTES` (33 MiB, the largest fetch bridge body with its
  headers), measured where it is made (a call is refused with `ARGS_NOT_TRANSFERABLE`; a result is answered
  `RESULT_NOT_TRANSFERABLE`) and where it arrives; the calls a broker runs at once hold at most `RPC_MAX_INBOUND_BYTES`
  (64 MiB) of arguments per channel (`BUSY`). The guest's console relay is the one chokepoint for log lines in every
  mode: it never throws (what clone refuses crosses as a string naming its kind), bounds each line to `LOG_MAX_BYTES`
  and the lines it sends to `LOG_EVENTS_PER_SECOND` and `LOG_BYTES_PER_SECOND` per second, so a flood never reaches
  the host's thread; the host measures every line again.
- **Every frame is bounded as a whole.** All RPC frames are made by one builder inside `createBroker`
  (`requestFrame`, `resultFrame`, `refusalFrame`; a unit test keeps every frame of `src/` there) from parts bounded
  before it is called: a method name of at most 256 characters (longer: `INVALID_CALL` at the caller,
  `UNKNOWN_METHOD` without the name at the receiver, never registered by `expose`), an id that is a number or a short
  string, an error text cut to 65 536 characters with a marker (cut again on receipt), and a snapshot whose whole
  frame is measured when it is posted and when it arrives.
- **The calls the guest makes have a per-second budget per environment**, by default 1000 calls and 64 MiB
  (`callLimits` in the config sets others; it cannot be turned off), a sliding one-second window like the log relay's.
  The guest's broker, the only code that holds the port, refuses a call past it with `BUSY` before sending it, and the
  host counts the same window on receipt and answers `BUSY`. `BUSY` stays a code the other side reports; the guest's
  broker mints it only for the host's budget, applied early. The two fields are one rule (the config schema,
  `src/lib/config-schema.ts`): every call that can be carried fits an empty window, so a call heavier than the byte
  budget, which no wait would let through, is refused with `ARGS_NOT_TRANSFERABLE` at both ends, and a byte budget
  below `RPC_MAX_BYTES` warns once. A value the byte measure does not know (an `Error`) is refused with a message that
  names it, never as past the budget.

The limits are listed with their values in [API.md](API.md#limits) and per channel in [Budgets](API.md#budgets).

### Strict mode: renders bypass the host

In strict mode ([ADR-005](ADR-005-strict-mode.md)) render updates travel on a third port, the *render port*, directly
from the worker to the view; the host is not on the path.

- **Why not through the host.** The host would have to hold, validate and re-post every render, and in Firefox and
  WebKit, where the view shares the host page's thread, every byte would then cost the host twice. The view has the
  document and an inert parser of its own; it validates each frame itself (`VIEW_RENDER`: html at most 256 Ki
  characters, a target id or null) and is the only party that can apply it.
- **Why not through the broker.** A render is fire-and-forget, latest-wins and flow-controlled (one in flight,
  released by the view's `VIEW_ACK`); a call is request/response with a timeout and a pending entry. Events
  (`VIEW_EVENT`) flow the other way, to handlers registered with `sandboxView.on()`, not to exposed methods. Neither fits
  the broker's registry or correlation.
- **Who holds which port.** The logic port (host ↔ worker) carries the broker exactly as in worker mode: `call()`,
  `expose()`, the reserved `sandbox:fetch`, logs, the watchdog and the worker's violation reports. The view port
  (host ↔ view) carries only the library's own frames: the view's violations, its height, an entry failure, its
  liveness answers. The render port (view ↔ worker) is created by the view and kept by the worker's library prelude in
  a closure, used only through primitives captured before guest code ran, so guest code cannot post on it and cannot
  bypass the flow control. Each port belongs to one environment and is closed with it; answers still go back on the
  port the request arrived on.

The mechanism and its reasoning live in the comments of [`src/lib/rpc.ts`](../src/lib/rpc.ts) and
[`src/host.ts`](../src/host.ts). The proof is [`src/lib/rpc.test.ts`](../src/lib/rpc.test.ts) (unit),
[`test/e2e/broker.spec.ts`](../test/e2e/broker.spec.ts) (end to end, in cooperative, worker and strict mode),
[`test/e2e/channel-isolation.spec.ts`](../test/e2e/channel-isolation.spec.ts) (the channel, on every engine),
[`test/e2e/guest-realm-hardening.spec.ts`](../test/e2e/guest-realm-hardening.spec.ts) (the announcement),
[`test/e2e/ready.spec.ts`](../test/e2e/ready.spec.ts) (the check-in), and for strict mode
[`test/e2e/strict.spec.ts`](../test/e2e/strict.spec.ts) and `strict-render-flood.spec.ts`.

## Alternatives considered

### Adopt Penpal

Promise-based message correlation is a solved problem. On balance it was not adopted, because the fit with this
architecture is poor:

- **The guest side is not loaded as a module.** It is a self-contained function stringified into a `srcdoc` document,
  or into the source of the worker that document spawns. A library would have to be bundled and inlined into every
  guest document.
- **It brings its own connection handshake**, which would sit on top of — and duplicate — the one-shot port
  announcement the sandbox already relies on ([research 14](research/14_self_navigation/README.md), 14.2).
- **The properties that matter are specific to this element.** Isolation between frame generations depends on how the
  element queues calls, hands over ports and recreates frames, and dispatch of untrusted requests has to be auditable
  line by line. Keeping both in one file next to their tests (`src/lib/rpc.ts`, with a test for every guarantee) was
  judged easier to audit than verifying the same properties through a library.

This is a judgement about fit, not about Penpal's quality; see *Revisit if* below.

### A fresh broker per frame generation, sharing one registry

Each new frame would get its own broker (its own pending calls and its own send), while host methods lived in a
registry shared between them. Rejected in favour of replying on the arrival port, which targets the actual cause — an
answer went to whichever port was current when it settled, or was queued for the next one — with a smaller change, and
keeps one broker per element.

### A raw frame for the library's own requests

A request that needs an answer but not the registry (a write, a fetch) could be a frame handled before the broker.
Rejected: it would need a second copy of correlation, the timeout, `TERMINATED` on teardown, the in-flight cap, the
current-port check and the clamp that lets only a reserved method report a library code. A reserved method has all of
them, and guest code cannot post a frame of its own either way. `PING` stays a raw frame for the opposite reason: it
is answered in the guest, and answering at all is the signal.

### Other designs for the codes and the handshake

- A category code plus a detail code, a separate retry field, an `Error` subclass: see the refusal codes above.
- The host posting its port into the guest and re-installing the guest's listener: guest code can always remove a
  listener again. A port per message has the same problem. Identifying the guest by message content: anything in the
  guest realm can post any content; only the window identity is the browser's.
- Strict-mode renders through the host or through the broker: see above.

## Consequences

The sandbox guarantees, each covered by a test:

- only explicitly exposed methods can be called; reserved and inherited names invoke nothing;
- inbound messages are validated, and malformed ones are dropped, never thrown on;
- a value that cannot be cloned fails only its own call, promptly;
- pending calls reject on teardown, re-initialisation and termination, and calls made after termination reject
  immediately;
- an answer reaches only the frame generation that asked for it;
- a rejection's code is one of the closed set, and a response cannot produce a local code;
- no guest code holds a port of ours, and no frame, name, text or message exceeds its bound.

Costs and limits:

- **Worker mode**: the guest has no markup, so it can expose methods only through `execute()`, which needs
  `scriptUnsafe`. The call path itself never evaluates code.
- **Long-running methods**: anything that legitimately takes longer than 30 s must be called with `callWithTimeout`.
- **Ownership**: the project maintains correlation, timeouts and error mapping — the plumbing a library would otherwise
  supply. Keeping the broker self-contained, with a test for every guarantee, is what bounds that cost.
- **Violation reports and heights are claims**, validated on the host: guest code can bend what the bootstrap reads.
- A Firefox quirk: a guest's `<meta refresh>` to a document without the bootstrap announces nothing there; the old
  port goes silent, which the watchdog bounds where it is on.

### Revisit if

- the guest side comes to be loaded as a script file rather than injected as a stringified function, so a library
  could be loaded instead of inlined; or
- requirements grow (transferable objects, streaming, callbacks across the boundary) until the broker is no longer
  small enough to audit.

History: [the amendments and the first text of the broker](archive/adr/ADR-002-history.md).
