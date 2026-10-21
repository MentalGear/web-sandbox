# ADR-006 history

History, not current state: the text of [ADR-006](../../ADR-006-fetch-bridge.md) that its current decision replaced, verbatim, as it stood at commit 1aed8ad, and the amendments in the order they were made. Where a passage differs from the ADR, the ADR holds. Only the targets of relative links are changed, to resolve from this folder.

## The original status line

**Status**: Accepted · **Date**: 2026-10-13 · **Amended**: 2026-10-14 ([the platform validates](#amendment-2026-10-14-the-platform-validates-the-request), [bound per build](#amendment-2026-10-14-the-method-is-bound-to-its-build), [one refusal text](#amendment-2026-10-14-one-refusal-text-for-every-unlisted-origin), [one origin parser](#amendment-2026-10-14-one-origin-parser))

## Why this ADR exists

Backlog B5 asked for a `sandbox.fetch` bridge: the guest asks, the host makes the request. The guest's
policy controls *whether* a load is allowed, but leaves the host no record of it, and an embedder that
wants a guest to reach one API had only one lever, `connect-src`, which hands the guest a direct channel
to that origin. A bridge gives the host a decision and a log per request.

A fetch made by the host page runs with the host page's authority. Done naively it sends the host's
cookies, follows redirects past any allowlist, buffers without limit and outlives the guest that asked
for it. B5's *bridge discipline* is the requirement this record implements: the bridge grants no more than
a direct guest request would.

## The original costs and limits

Costs and limits:

- DNS rebinding (above); the host origin in `Origin` (decision 6);
- receipt cost: a guest can still flood the port with refused requests, each costing the host a
  validation and an event (S6's open note); requests actually made are bounded by `maxConcurrent`;
- no streaming, no `AbortSignal` from the guest (the timeout is the cancel), no `Request` or `Blob` bodies;
- responses are CORS-filtered for the host origin, so the guest sees only CORS-exposed headers.

## Amendment (2026-10-14): the platform validates the request

**When**: the follow-up audit of the adversarial review (B6). **Why**: the bridge checked header values with a
ByteString regex of its own (review B6), a copy of a rule the browser applies anyway, which could drift from it.
**Decision**: the bridge builds the `Request` itself, from the validated fields and the pinned options, before it
records anything; whatever the constructor throws is `refused` (`FETCH_NOT_ALLOWED`) and `fetch()` is never called;
`fetch()` is given that `Request` and the same init, so what was checked is what is sent. (The init again, whole:
measured in WebKit, an abort that reached the fetch only through the `Request`'s own signal no longer stopped a
response whose headers had arrived, so the timeout and teardown left the upstream connection open; and a partial
init would make the `Request` constructor reset the referrer policy, which brought the `Referer` back on all three
engines. Both were caught by `test/e2e/fetch-bridge.spec.ts`.) `validateRequest()` keeps only policy:
origins, private hosts, methods, header names and sizes. `failed` means that the browser's `fetch()` rejected or
no whole response arrived, not that a request left the page: `fetch()` also rejects before sending (the host
page's own `connect-src`, mixed content, local-network blocking). Proof: `test/unit/channel-guarantees.test.ts`
("B6").

## Amendment (2026-10-14): the method is bound to its build

**When**: the focused review of 2026-10-14 ([report](../../archive/reviews/FOCUSED-REVIEW-2026-10-14.md), hardening). The reserved `sandbox:fetch` method read
the element's current bridge when it ran, and the broker runs a method a microtask after the request arrives, so
correctness relied on no rebuild happening in between. Now every build registers the method again, closed over
that build's bridge, as `sandbox:write` is over its overlay: a request is always handled by the bridge of the
environment it arrived in, which teardown closed, so a request that runs after a rebuild is refused there
(`FETCH_FAILED`) and never made by the next environment. Test: `test/unit/focused-review.test.ts` ("Hardening").

## Amendment (2026-10-14): one refusal text for every unlisted origin

**When**: the broad review of 2026-10-14 (CB6). **Why**: the refusal of an unlisted origin said "the host page's own
origin" for that one origin, so a guest could find the origin that embeds it by probing. **Decision**: the guest is
told `<origin> is not in fetchBridge.allow` for every unlisted origin; what the host knows beyond that (the host
page's own origin; a loopback, private or link-local host) is the `fetch` record's new `reason` field, never sent to
the guest. Proof: `test/unit/broad-review.test.ts` ("CB6"), `test/e2e/fetch-bridge.spec.ts`.

## Amendment (2026-10-14): one origin parser

**When**: [ADR-007](../../ADR-007-typed-origins.md). `fetchBridge.allow` and the guest policy's `origins` read their entries
with one parser (`src/lib/origin.ts`, `parseOrigin`); the bridge's rules are `https:` and `http:` for any host
(`FETCH_ORIGIN_RULES`). The parser compares the host the URL parser read with the host as written, so an entry the
parser would rewrite into another spelling is now refused with the same warning: IPv4 shorthand (`https://127.1`),
percent-encoding, a non-ASCII name (write its `xn--` form), a trailing dot, whitespace, and IPv6 literals (a policy
cannot name one, and the bridge keeps the same grammar). Tests: `src/lib/origin.test.ts`, `src/lib/fetch-bridge.test.ts`.

## Amendment (2026-10-21): the request is made by a frame of the library's

**When**: the S74 review board's BD1:ISO-1 (class E-net). The bridge made each request with the host page's
`globalThis.fetch`, so the host page's Service Worker handled it (a cache-first worker answered the guest from the host
app's cache, in Chromium and WebKit) and any wrapper of the host page's `fetch` applied to it (an auth wrapper added the
user's `Authorization`, in every engine). Decision 6 read: "The request comes from the host page. So the target sees the
host page's origin in `Origin` (never its URL: no `Referer`), and the response must pass CORS for that origin; `*`
works, since no credentials are sent. This is more than a direct guest request reveals (`Origin: null`), and is accepted
because every target is one the embedder listed. Running the bridge from an opaque-origin context of its own would hide
it, at the cost of another frame or worker; see *Revisit if*." Its *Revisit if* item ("hiding the host origin from
targets matters: make the requests from a library-owned opaque-origin worker, keeping this policy code on the host") is
what the new decision 6 does, with a sandboxed frame rather than a worker (a host-made `blob:` worker is controlled by
the host page's Service Worker, and a `data:` worker would need `worker-src data:` in the host page's policy). Tests:
`test/unit/structural.test.ts`, `test/unit/bridge-frame.test.ts`, `test/e2e/fetch-bridge-isolation.spec.ts`.
