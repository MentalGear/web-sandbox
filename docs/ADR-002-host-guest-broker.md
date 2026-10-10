# ADR-002: How should host and guest call each other?

**Status**: Accepted · **Date**: 2026-10-10

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
([hybrid strategy](ADR-001-continue-or-adopt.md#hybrid-strategy-adopt-the-commodity-keep-the-differentiator),
consequence 4) recommended adopting it, or copying its approach, rather than hand-rolling message
correlation. This record explains why the broker is owned code.

## Decision

**A typed, bidirectional request/response layer over the existing `MessageChannel`.** Each side
exposes its own methods and calls the other side's. The one-shot port handoff and the existing
`EXECUTE` and `LOG` messages are unchanged, and `execute()` stays the `scriptUnsafe`-gated escape
hatch. The design choices, each with its reason:

1. **One self-contained dispatcher, used by both sides.** The guest copy is injected by
   stringifying the same function the host imports, so both sides run identical code. It therefore
   closes over nothing from module scope and avoids syntax the build compiles into module-scope
   helpers.
2. **Allowlist-only dispatch through a `Map`.** A `Map` has no prototype chain, so only explicitly
   exposed names resolve; reserved and inherited names such as `__proto__` or `toString` invoke
   nothing.
3. **Arguments are clone-checked when the call is made.** A value that cannot cross the channel
   fails its own call at once, rather than throwing later in a queue flush and taking other
   messages with it.
4. **Answers go back on the port the request arrived on.** Teardown closes that port, so an answer
   that settles after the frame is recreated is discarded rather than delivered to the next frame.
   This is what keeps frame generations isolated.
5. **Every call has a timeout, and teardown rejects pending calls.** 30 s by default, adjustable per
   call (`0` disables it), so unless a caller opts out no promise waits forever on an unresponsive
   peer, and none outlives the frame it was waiting on.

The mechanism and its reasoning live in the comments of [`src/lib/rpc.ts`](../src/lib/rpc.ts) and
[`src/host.ts`](../src/host.ts). The proof is [`src/lib/rpc.test.ts`](../src/lib/rpc.test.ts) (unit)
and [`test/e2e/broker.spec.ts`](../test/e2e/broker.spec.ts) (end to end, in iframe and worker mode).

## Alternatives considered

### Adopt Penpal

Promise-based message correlation is a solved problem, which is why the backlog preferred this. On
balance it was not adopted, because the fit with this architecture is poor:

- **The guest side is not loaded as a module.** It is a self-contained function stringified into a
  `srcdoc` document, or into the source of the worker that document spawns. A library would have
  to be bundled and inlined into every guest document.
- **It brings its own connection handshake**, which would sit on top of — and duplicate — the
  one-shot port handoff the sandbox already relies on
  ([research 14](research/14_self_navigation/README.md), 14.2).
- **The properties that matter are specific to this element.** Isolation between frame generations
  depends on how the element queues calls, hands over ports and recreates frames, and dispatch of
  untrusted requests has to be auditable line by line. Keeping both in one small file next to their
  tests was judged easier to audit than verifying the same properties through a library:
  `src/lib/rpc.ts` is about 230 lines with its comments, and every guarantee has a test.

This is a judgement about fit, not about Penpal's quality; see *Revisit if* below.

### A fresh broker per frame generation, sharing one registry

Considered for generation isolation: each new frame would get its own broker (its own pending calls
and its own send), while host methods lived in a registry shared between them. Rejected in favour of
replying on the arrival port, which targets the actual cause — an answer went to whichever port was
current when it settled, or was queued for the next one — with a smaller change, and keeps one
broker per element.

## Consequences

The sandbox now guarantees, each covered by a test:

- only explicitly exposed methods can be called; reserved and inherited names invoke nothing;
- inbound messages are validated, and malformed ones are dropped, never thrown on;
- a value that cannot be cloned fails only its own call, promptly;
- pending calls reject on teardown, re-initialisation and termination, and calls made after
  termination reject immediately;
- an answer reaches only the frame generation that asked for it;
- the one-shot port handoff is unchanged.

Costs and limits:

- **Worker mode**: the guest has no markup, so it can expose methods only through `execute()`,
  which needs `scriptUnsafe`. The call path itself never evaluates code.
- **Long-running methods**: anything that legitimately takes longer than 30 s must be called with
  `callWithTimeout`.
- **Ownership**: the project now maintains correlation, timeouts and error mapping — the plumbing
  ADR-001 suggested buying. Keeping the broker self-contained, with a test for every guarantee, is
  what bounds that cost.

### Revisit if

- the guest side comes to be loaded as a script file rather than injected as a stringified
  function, so a library could be loaded instead of inlined; or
- requirements grow (transferable objects, streaming, callbacks across the boundary) until the
  broker is no longer small enough to audit.
