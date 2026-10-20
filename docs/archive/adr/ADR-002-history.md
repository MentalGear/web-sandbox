# ADR-002 history

History, not current state: the text of [ADR-002](../../ADR-002-host-guest-broker.md) that its current decision replaced, verbatim, as it stood at commit 1aed8ad, and the amendments in the order they were made. Where a passage differs from the ADR, the ADR holds. Only the targets of relative links are changed, to resolve from this folder.

## The original status line

**Status**: Accepted · **Date**: 2026-10-10 · **Amended**: 2026-10-11 ([refusal codes](#amendment-2026-10-11-refusals-carry-a-code)), 2026-10-13 ([reserved methods](#amendment-2026-10-13-reserved-methods-and-library-codes)), 2026-10-13 ([strict mode renders bypass the host](#amendment-2026-10-13-strict-mode-renders-bypass-the-host)), 2026-10-14 ([adversarial review: the channel](#amendment-2026-10-14-adversarial-review-the-channel)), 2026-10-14 ([broad review: the guest announces its port](#amendment-2026-10-14-broad-review-the-guest-announces-its-port)), 2026-10-14 ([the announcement completes the build](#amendment-2026-10-14-the-announcement-completes-the-build)), 2026-10-15 ([byte budgets](#amendment-2026-10-15-review-round-1-byte-budgets-on-every-message)), 2026-10-17 ([whole frames and a call budget](#amendment-2026-10-17-review-round-3-whole-frames-and-a-budget-on-the-guests-calls))

## Why this ADR exists

Backlog B1 asked for promise-based calls in both directions. `execute()` is fire-and-forget, and
until this layer only log lines travelled back, so neither side could ask the other for a result.

Breaking the open backlog down into what each item needs showed that this one layer sits underneath
five others, so it was built first:

| Item | What it needs from the call layer |
| :--- | :--- |
| B5 · host-mediated `fetch` | the guest asks, the host performs the request and answers |
| C1 · in-sandbox file API | file operations requested by the guest, answered by the host |
| B6 · auto-sizing | the guest reports its content size to the host |
| S5 · violation reporting | the delivery half: a violation event forwarded from guest to host |
| S6 · strict mode | render updates from guest logic in a worker, applied by the host to the frame |

It was also built in-house. B1 preferred adopting Penpal, and ADR-001
([hybrid strategy](../../ADR-001-continue-or-adopt.md#hybrid-strategy-adopt-the-commodity-keep-the-differentiator),
consequence 4) recommended adopting it, or copying its approach, rather than hand-rolling message
correlation. This record explains why the broker is owned code.

## Amendment (2026-10-11): refusals carry a code

**When**: backlog B7, after the broker shipped. **Why**: every rejection was a plain `Error` with
only a message, and a guest handler's message reached the host verbatim. A guest could throw the
exact text of the host's termination refusal, so host code that matched messages to decide "stop"
or "retry" was acting on a reason the guest chose.

**Decision**: every rejection is an `Error` with a single string `code` from a closed set. `TIMEOUT`,
`TERMINATED`, `SEND_FAILED` and `INVALID_CALL` are minted only by the side whose call is refused, from its
own state, and no response can produce them. `UNKNOWN_METHOD`, `HANDLER_ERROR`, `RESULT_NOT_TRANSFERABLE`,
`BUSY` and `ARGS_NOT_TRANSFERABLE` are the only codes a response from the other side can produce; the last two
are also minted by the calling side for the same condition seen before sending (the other side's per-second
budget; arguments that could never be carried). The response frame gains an optional `code`; both sides run the same
dispatcher, so the two ends cannot disagree about it.

- **A property, not an `Error` subclass.** The dispatcher is stringified into the guest and closes
  over nothing, so a class defined next to it would not exist there. And `instanceof` does not work
  across realms: the host page, the frame and the worker each have their own `Error`. A string
  property on a plain `Error` reads the same in all of them.
- **The other side's code is clamped on receipt.** The local codes drive what a caller does next
  (stop, retry, rebuild), so the other side must not be able to produce them. Only `UNKNOWN_METHOD`
  and `RESULT_NOT_TRANSFERABLE` pass through, as the receiver's own constants; any other value,
  including a local code, or none, becomes `HANDLER_ERROR`. The message stays the other side's text
  verbatim, as B1 requires; it was never trustworthy, and now nothing needs to trust it.
- **One field with disjoint groups, not a category code plus a detail code.** The guarantee only needs
  the two groups to be disjoint and the clamp to enforce that on receipt; a category on top adds a
  second field to branch on, and every name for it was jargon either way.
- **No separate retry field.** Whether to retry follows from the code: only `TIMEOUT` is worth
  retrying, and `TERMINATED` only after the next `ready`. A second field would be one more thing that
  could disagree with the code.
- **How refusals are tested.** Each refusal test asserts the exact code, runs as the refused side
  (from inside the guest for guest-to-host calls), and checks that no handler ran. One test pins the
  code strings, since they are wire protocol.

*Credit*: typed refusal reasons, and the rule for testing them, come from Dialog DB
([repository](https://github.com/dialog-db/dialog-db);
[`dialog-capability/src/access.rs`](https://github.com/dialog-db/dialog-db/blob/facd672/rust/dialog-capability/src/access.rs),
[`.claude/rules/authority-tests.md`](https://github.com/dialog-db/dialog-db/blob/facd672/.claude/rules/authority-tests.md)).
Its separate retry/stop signal was not adopted, for the reason above.

## Amendment (2026-10-13): reserved methods and library codes

**When**: backlog B5, the fetch bridge ([ADR-006](../../ADR-006-fetch-bridge.md)), the first method the library
itself exposes over the broker. **Decision**: names starting with `sandbox:` are reserved. They live in a
registry of their own, written only by `exposeReserved()`; `expose()` never registers one, so no embedder
or guest method can replace a library method. A reserved method may refuse with a *library code* from a
third closed group (`FETCH_*`, type `RpcLibraryCode`), disjoint from both B7 groups; any other handler's
code is still `HANDLER_ERROR`. The calling side accepts a library code only for a call to a reserved name
and only when created with `acceptLibraryCodes`, which only the guest's broker is. So on the host every
response is clamped exactly as the B7 amendment says, and nothing the guest sends can produce a library
code there. Proof: `src/lib/rpc.test.ts` ("reserved methods and library codes").
*Extended (2026-10-14, guest writes, [ADR-004](ADR-004-history.md#amendment-guest-writes-2026-10-14)):
the library codes also hold the file codes `INVALID_PATH`, `INVALID_FILE`, `FILES_QUOTA_EXCEEDED`,
`FILES_NOT_ALLOWED` and `FILES_BUSY`, reported by the reserved `sandbox:write`; same rules, still disjoint.*

## Amendment (2026-10-13): strict mode renders bypass the host

**When**: backlog S6, strict mode ([ADR-005](../../ADR-005-strict-mode.md)). The table above expected strict mode's
render updates to be "applied by the host to the frame" over the broker. **Decision**: they are not. Renders
travel on a third port, the *render port*, directly from the worker to the view; the host is not on the path.

- **Why not through the host.** The host would have to hold, validate and re-post every render, and in
  Firefox and WebKit, where the view shares the host page's thread, every byte would then cost the host twice.
  The view has the document and an inert parser of its own; it validates each frame itself (`VIEW_RENDER`:
  html at most 256 Ki characters, a target id or null) and is the only party that can apply it.
- **Why not through the broker.** A render is fire-and-forget, latest-wins and flow-controlled (one in
  flight, released by the view's `VIEW_ACK`); a call is request/response with a timeout and a pending entry.
  Events (`VIEW_EVENT`) flow the other way, to handlers registered with `sandboxView.on()`, not to exposed
  methods. Neither fits the broker's registry or correlation.
- **Who holds which port.** The logic port (host ↔ worker) carries the broker exactly as in worker mode:
  `call()`, `expose()`, the reserved `sandbox:fetch`, logs, the watchdog and the worker's violation reports.
  The view port (host ↔ view) carries only the library's own frames: the view's violations, its height, an
  entry failure, its liveness answers. The render port (view ↔ worker) is created by the view and kept by the
  worker's library prelude in a closure, used only through primitives captured before guest code ran, so guest
  code cannot post on it and cannot bypass the flow control. Each port belongs to one environment and is
  closed with it; answers still go back on the port the request arrived on.

Proof: `test/e2e/strict.spec.ts` ("the render port is out of guest reach"), `strict-render-flood.spec.ts`,
and the strict cases of `test/e2e/broker.spec.ts`, which runs the whole broker suite in strict mode too.


## Amendment (2026-10-14): adversarial review: the channel

**When**: the adversarial review of 2026-10 ([report](../../archive/reviews/ADVERSARIAL-REVIEW-2026-10.md), B1–B4, B7).
**Why**: the transport under the broker trusted more than it checked. The bootstrap took the first INIT_PORT
from anyone; it called the port through prototypes guest code could patch, so guest code could take the port
(and answer the watchdog from a nested worker while it looped); the host dispatched log frames as they came and
handled frames from a port it had already closed (Firefox delivers those); and nothing bounded how many inbound
calls a side would run at once.

**Decision**:

- **One trusted INIT_PORT.** The default bootstrap and the worker-mode frame accept exactly one: trusted, with
  one port, and in iframe mode from `parent.parent`, the host page, read before guest code runs. Anything else
  is ignored without throwing and does not use up the listener, which is a capture listener that stops the
  accepted event. Strict mode's view already worked this way.
- **The port never reaches guest code.** Every operation on the port and on the events that carry it uses
  primitives captured before guest code runs (`MessagePort.prototype.postMessage`, its `onmessage` setter, the
  `MessageEvent` getters, `stopImmediatePropagation`), called through a captured `Reflect.apply`; internal
  lists are written with a captured `defineProperty`. Patching any prototype afterwards changes nothing the
  bootstrap does. This makes the watchdog's guarantee hold by construction and means guest code can no longer
  post frames of its own; it can still bend what the bootstrap reads (event getters, the measured box), so
  violation reports and heights remain claims, validated on the host. Worker mode keeps `Worker`: nothing in
  this guarantee depends on removing it.
- **Only the current port is heard.** The host handles a frame only if it arrived on the current
  environment's port (the logic or the view port), so a frame already queued from an environment a listener
  just reset changes nothing, whether or not the engine still delivers it.
- **Logs are normalised and labelled.** `sandbox-log` carries `{ type: 'LOG', level, args, source }`: `level`
  from `log`, `info`, `warn`, `error`; `args` an array of at most 64 with strings cut at 64 Ki characters;
  `source` set by the host, `'guest'` for frames from the port and `'host'` for the element's own lines. Guest
  lines are limited to 1000 per second per environment, with one warning; host lines never are. A rate, not
  a cap like `violation`'s, because log lines are a continuous channel of a running guest.
- **At most 256 inbound calls run at once per channel.** A further request is answered at once with the new
  code `BUSY`, before its method runs. It belongs to the group of codes the other side reports (now four:
  `UNKNOWN_METHOD`, `HANDLER_ERROR`, `RESULT_NOT_TRANSFERABLE`, `BUSY`), since it says the responder refused;
  the local group is unchanged, so the B7 disjointness argument stands. The count is kept per reply channel,
  and the host passes one per port, so calls that never settle in one environment do not starve the next.
  Both sides run the same broker, so the host's calls into the guest are capped the same way.

Proof: `test/e2e/review-channels.spec.ts` (all engines), `src/lib/in-sandbox-script.test.ts` (B1, B2),
`src/lib/rpc.test.ts` (B7, pinned codes), `test/unit/channel-guarantees.test.ts` (B3, B4).

## Amendment (2026-10-14): broad review: the guest announces its port

**When**: the broad review of 2026-10-14 ([report](../../archive/reviews/BROAD-REVIEW-2026-10-14.md), CB1, PD8). **Why**: the B1
fix accepted one INIT_PORT, from the host page, in a capture listener of the guest's window, installed before guest
code. `document.open()` erases every listener of the window: guest code that called it before the wrapper's load
(an image held the load open) installed a listener of its own, and the host's INIT_PORT, posted after the load,
reached it, on all three engines. Guest code then held the host's port (and could answer the watchdog from a nested
worker). The class is "a listener in the guest realm that carries the port"; validating its messages more cannot
close it, since the guest can remove the listener.

**Decision**: the handshake is reversed. In iframe mode the bootstrap's first statement makes the `MessageChannel`,
keeps `port1` in its closure (used only through primitives captured before guest code, as before) and posts `port2`
to `parent.parent`, the host page, as `{ type: 'SANDBOX_PORT' }`; worker mode's frame does the same and hands `port1`
to its worker as the worker's one INIT_PORT (a worker has no document to open). Nothing in the guest realm ever
listens for a port. The host installs one `message` listener on its window before it inserts the frame, and accepts
exactly one announcement per environment: a trusted message whose `source` is the guest frame's window (identity,
the wrapper's `frames[0]`) carrying exactly one port. The port stays unstarted until the build completes (the wrapper
loaded and the port arrived, in either order), so the guest's early frames are delivered after `ready`, as before.

- **A second announcement ends the environment** (PD8): a guest that reloads itself (`location.reload()`, a `<meta
  refresh>` without a URL), or rewrites its document so a bootstrap runs again, announces again from the same window;
  the host terminates with `the guest frame announced itself again (it reloaded or rewrote its document)`. A forged
  announcement can only end the guest's own environment. One where no bootstrap runs (no `allow-scripts`, or a
  policy that refuses the inline bootstrap) is refused the same way. Measured: Firefox refreshes a guest's `<meta
  refresh>` to a document without the bootstrap, so nothing announces there; the old port goes silent, which the
  watchdog bounds where it is on.
- **What other listeners see**: the host's listener stops the accepted announcement, so no other listener on the
  host window sees the port. The guest's other messages to the host window are not the library's and reach the
  embedder's listeners, which must check `event.source` (PD7).
- **Rejected**: keeping the host-to-guest INIT_PORT and re-installing the guest's listener (guest code can always
  remove it again); a port per message (the same listener problem); identifying the guest by message content
  (anything in the guest realm can post any content; only the window identity is the browser's).

Proof: `test/e2e/broad-review.spec.ts` ("CB1", "PD8"), `test/e2e/review-channels.spec.ts` (B1, B2 re-run),
`src/lib/in-sandbox-script.test.ts`.

## Amendment (2026-10-14): the announcement completes the build

**When**: backlog S46 ([ADR-003 amendment](ADR-003-history.md#amendment-2026-10-14-ready-is-the-guests-check-in)).
**Decision**: the accepted announcement is the guest's check-in: the host takes its port and enters `ready` at once,
without waiting for the wrapper's load (which waits for the guest's subresources). The guest frame's window whose
announcement was accepted is kept, and the wrapper's load must still hold it. On the guest's side the broker frames
that run guest code (`RPC_REQ`, and `EXECUTE` beside the broker) wait in the bootstrap until the guest document is
parsed, in one queue, so a call still reaches a method a classic script of the guest exposes; `RPC_RES` and `PING` are
handled on arrival. The queue holds at most `MAX_INBOUND_IN_FLIGHT` frames, the bound the broker keeps on calls in
flight; past it a call is refused with `BUSY` in the broker's frame shape.

Proof: `test/e2e/ready.spec.ts`, `src/lib/in-sandbox-script.test.ts` ("the startup gate").

## Amendment (2026-10-15): review round 1: byte budgets on every message

**When**: [review round 1](../../archive/reviews/REVIEW-ROUND-1-2026-10-15.md) (R3-3, R4-1); backlog S51. **Why**: the frames had
counts (`MAX_INBOUND_IN_FLIGHT`, `LOG_MAX_ARGS`) and string caps, but no byte bound: a strict guest's
`console.log(new Uint8Array(64 MiB))` arrived whole, a flood of lines within the caps cut Firefox's host page to a few
ticks per second, and 256 calls of 32 MiB each were held on WebKit's host. And the guest's console threw
`DataCloneError` for a function or a DOM node.

**Decision**: one measure, `createSizeOf()` (`src/lib/structured-size.ts`): a bounded estimate of what structured clone
copies, with every primitive captured when it is made, stringified into the guest like `createBroker`. Every RPC
message is at most `RPC_MAX_BYTES` (33 MiB, the largest fetch bridge body with its headers), measured where it is made
(a call is refused, `ARGS_NOT_TRANSFERABLE`; a result is answered `RESULT_NOT_TRANSFERABLE`) and where it arrives; the
calls a broker runs at once hold at most `RPC_MAX_INBOUND_BYTES` (64 MiB) of arguments per channel (`BUSY`). The
guest's console relay is the one chokepoint for log lines in every mode: it never throws (what clone refuses crosses
as a string naming its kind), bounds each line to `LOG_MAX_BYTES` and the lines it sends to `LOG_EVENTS_PER_SECOND`
and `LOG_BYTES_PER_SECOND` per second, so a flood never reaches the host's thread; the host measures every line again.
No new code: the existing ones say it.

## Amendment (2026-10-17): review round 3: whole frames, and a budget on the guest's calls

**When**: review round 3 (C-1, M-2). **Why**: only a call's arguments and a result were measured. A method name of
2^27 characters came back whole in `unknown method: …`, and a handler's error text of 2^28 characters crossed as it
was, each stalling the host page for most of a second per call. And calls within every cap (32 MiB each, back to back;
or small ones, 44 000 a second) kept the host page busy without bound.

**Decision**: every RPC frame is made by one builder inside `createBroker` (`requestFrame`, `resultFrame`,
`refusalFrame`; a unit test keeps every frame of `src/` there) from parts bounded before it is called: a method name of
at most 256 characters (longer: `INVALID_CALL` at the caller, `UNKNOWN_METHOD` without the name at the receiver, never
registered by `expose`), an id that is a number or a short string, an error text cut to 65 536 characters with a marker
(cut again on receipt), and a snapshot whose whole frame is measured when it is posted and when it arrives. The calls
the guest makes have a per-second budget per environment, by default 1000 calls and 64 MiB (`callLimits` in the
config sets others; it cannot be turned off), a sliding one-second window like the log relay's: the guest's broker, the
only code that holds the port, refuses a call past it with `BUSY` before sending it, and the host counts the same
window on receipt and answers `BUSY`. `BUSY` stays a code the other side reports; the guest's broker mints it only for
the host's budget, applied early. The two fields of the budget are one rule (the config schema, `src/lib/config-schema.ts`):
every call that can be carried fits an empty window, so a call heavier than the byte budget, which no wait would let
through, is refused with `ARGS_NOT_TRANSFERABLE` at both ends, and a byte budget below `RPC_MAX_BYTES` warns once. A value the byte measure does not know (an `Error`) is refused with a message that
names it, never as past the budget.
