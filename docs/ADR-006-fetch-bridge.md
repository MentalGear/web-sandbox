# ADR-006: A host-mediated fetch bridge

**Status**: Accepted · **Date**: 2026-10-13

## Why this ADR exists

Backlog B5 asked for a `sandbox.fetch` bridge: the guest asks, the host makes the request. The guest's
policy controls *whether* a load is allowed, but leaves the host no record of it, and an embedder that
wants a guest to reach one API had only one lever, `connect-src`, which hands the guest a direct channel
to that origin. A bridge gives the host a decision and a log per request.

A fetch made by the host page runs with the host page's authority. Done naively it sends the host's
cookies, follows redirects past any allowlist, buffers without limit and outlives the guest that asked
for it. B5's *bridge discipline* is the requirement this record implements: the bridge grants no more than
a direct guest request would.

## Decision

**Opt-in `fetchBridge: { allow, maxBytes?, timeoutMs?, methods?, headers?, maxConcurrent? }`.** The guest
gets `sandboxFetch(url, init)`, which resolves with a `Response` or rejects with a `FETCH_*` code. The
guest policy is unchanged: `connect-src` stays what the embedder set (`'none'` by default), so the bridge
is the only way out unless the embedder also allows direct connections.

1. **A reserved broker method, not a new frame type.** The request rides the broker (ADR-002) as a call
   to `sandbox:fetch`, so it reuses correlation, the per-call timeout, clone checks, teardown rejection and
   the answer-on-arrival-port rule that keeps frame generations apart. A dedicated frame type would have
   duplicated all of that. What a frame type gives for free — no collision with exposed names — is made
   true by construction instead: names starting with `sandbox:` live in a registry of their own, written
   only by `exposeReserved()`, and `expose()` never registers such a name (the element also warns). So no
   embedder or guest method can replace the bridge, and the bridge never answers to a name someone else
   exposed.
2. **Refusals carry a library code through the broker's rejection path.** A closed set, disjoint from
   B7's codes: `FETCH_NOT_ALLOWED`, `FETCH_BUSY`, `FETCH_REDIRECT`, `FETCH_TOO_LARGE`, `FETCH_TIMEOUT`,
   `FETCH_FAILED`. Only a reserved method's error forwards one; any other handler's code is
   `HANDLER_ERROR` as before. The calling side accepts one only for a call to a reserved name and only
   when created with `acceptLibraryCodes` — the guest's broker. The host's broker is not, so nothing the
   guest sends can give a host call a library code: B7's guarantee is untouched. Retry follows from the
   code: `FETCH_BUSY`, `FETCH_TIMEOUT` and `FETCH_FAILED` may succeed later; the others will not.
3. **A separate global, never a replacement for `fetch`.** Silently replacing `fetch` would hand libraries
   something that looks like `fetch` but has no streaming, no `AbortSignal`, no `Request` bodies and
   different failure codes. Guest code that wants it as `fetch` writes `globalThis.fetch = sandboxFetch`.
4. **The discipline, all enforced on the host** (`src/lib/fetch-bridge.ts`); the guest side only shapes
   the request and builds the `Response`:
   - `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, `cache: 'no-store'`, `mode: 'cors'`,
     `keepalive: false`. From `init`, only `method`, `headers` and `body` are read.
   - **Redirects are never followed**: `redirect: 'manual'`, and the opaque redirect it yields is refused
     with `FETCH_REDIRECT`. Same guarantee as `'error'` (the second request is never made), but the
     refusal is told apart from a network failure.
   - **An exact-origin allowlist** (scheme, host, port), normalised by the URL parser; entries with a path,
     query, credentials or wildcard are dropped with a warning. No CSP source expressions in v1. Only
     `http:` and `https:` URLs, never with credentials in the URL; the fragment is dropped.
   - **The host page's origin and loopback, private and link-local hosts** (`localhost`, `*.localhost`,
     127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, `::1`, `fc00::/7`, `fe80::/10`,
     IPv4-mapped forms, …) are refused unless listed. The exact allowlist already refuses them; they are
     checked again by name so the refusal says why and the check survives any later widening of the
     allowlist. Every spelling the URL parser canonicalises (`127.1`, `2130706433`, `0x7f.1`,
     `[::ffff:127.0.0.1]`) is caught. **DNS rebinding is a limit, not a guarantee**: a page cannot see DNS
     answers, so a listed public name that resolves to a private address is not detected.
   - **Methods** from an allowlist: `GET`, `HEAD`, `POST` by default; `PUT`, `PATCH`, `DELETE` when listed.
   - **Request headers** from an allowlist: the CORS-safelisted names (`accept`, `accept-language`,
     `content-language`, `content-type`) plus names the embedder lists. `Cookie` can never be listed (nor
     any name `fetch` forbids, `proxy-*`, `sec-*`); `Authorization` only when listed. A header the guest
     may not set refuses the request rather than being dropped, so the guest never believes it sent it.
   - **Bodies**: a request body is a string, `ArrayBuffer` or typed array, at most `maxBytes`. The response
     body is capped at `maxBytes` (1 MiB by default, at most 32 MiB): a declared `Content-Length` over the
     cap refuses before reading; otherwise the body is read chunk by chunk and abandoned as soon as the
     total passes the cap, so at most the cap plus one chunk is read. `Content-Length` is never trusted.
   - **Time and lifetime**: one `AbortController` per request, fired by the per-call timeout (10 s by
     default, at most 120 s; covers the body too) and by teardown — `reset()`, `load()`, `setConfig()`,
     `terminate()` and removal abort every request of that environment, closing the upstream connection.
   - **Whole responses only.** No streaming in v1. If it is ever needed, it uses one dedicated port per
     request so closing that port is the cancel; chunks never go on the broker port.
   - **Concurrency**: at most `maxConcurrent` (4 by default, at most 16) requests in flight per sandbox;
     one more is refused with `FETCH_BUSY`. So the bridge's memory is bounded by
     `maxConcurrent × maxBytes`.
5. **Every request is logged.** The element dispatches a `fetch` event, bubbling like `violation`, once
   per request when it settles: `{ method, url, outcome, status?, code?, bytes, durationMs }`, with
   `outcome` one of `ok`, `refused` (no request made), `failed` (`fetch()` was called, no response handed over;
   amended 2026-10-14, below) and
   `aborted` (torn down). No path to the network skips the record, refusals included. The record is
   built by the host from validated fields, and guest-supplied strings are clamped (the URL to 2048
   characters, a method that is not a method reported as `''`).
6. **The request comes from the host page.** So the target sees the host page's origin in `Origin` (never
   its URL: no `Referer`), and the response must pass CORS for that origin; `*` works, since no
   credentials are sent. This is more than a direct guest request reveals (`Origin: null`), and is
   accepted because every target is one the embedder listed. Running the bridge from an opaque-origin
   context of its own would hide it, at the cost of another frame or worker; see *Revisit if*.

## Alternatives considered

- **A dedicated frame type** (`FETCH_REQ`/`FETCH_RES`). Collision-free like `PING` and `VIOLATION`, but a
  request needs everything the broker already does (ids, timeouts, teardown, clone checks, generation
  isolation); the reserved namespace gets the collision property without the duplication.
- **Polyfilling `fetch` by default**, as `IMPROVEMENTS.md` §2 suggested. Rejected for the reasons in
  decision 3; it is one line of guest code when wanted.
- **`redirect: 'error'`**. Same no-follow guarantee, but a redirect then reads as a network failure.
- **Dropping disallowed headers silently.** The guest would believe a header was sent; refusing is explicit.
- **Capping `fetch` events per environment** like `violation`. The cap that matters is on requests made
  (concurrency); refused attempts cost the host what any port message costs (S6's open note), and an
  event cap would let requests go unlogged.

## Consequences

Guaranteed, each with a test (`src/lib/fetch-bridge.test.ts`, `src/lib/rpc.test.ts`,
`src/lib/in-sandbox-script.test.ts`, `test/unit/host.test.ts`, and `test/e2e/fetch-bridge.spec.ts` on
Chromium, Firefox and WebKit against the recorder's two listeners outside the browser and an echo on the
harness origin):

- an allowlisted origin is reached and the request logged; any other is refused before a request leaves,
  and nothing reaches the blocked listener (positive control: the same request, listed, reaches it);
- a cookie on the harness origin never reaches it through the bridge, while the host page's own request
  carries it; no `Cookie`, `Authorization` or `Referer` reaches the target;
- a redirect from an allowlisted origin to another is refused and the other origin records nothing
  (positive control: a following fetch from the host page reaches it);
- an oversized body is refused by its `Content-Length` unread, or after the cap plus one chunk (exact in
  the unit test with a counted stream; end to end, the upstream connection closes long before the end);
- `reset()` during a slow response, and the timeout, close the upstream connection;
- the host origin, and every spelling of a loopback host, are refused unless listed;
- the reserved name cannot be taken by `expose()` on either side; with the bridge off there is no
  `sandboxFetch` and a direct call to the reserved method is refused without a request;
- the guest policy is unchanged: a direct `fetch` and `WebSocket` to the listed origin are still refused
  and reported as violations.

Costs and limits:

- DNS rebinding (above); the host origin in `Origin` (decision 6);
- receipt cost: a guest can still flood the port with refused requests, each costing the host a
  validation and an event (S6's open note); requests actually made are bounded by `maxConcurrent`;
- no streaming, no `AbortSignal` from the guest (the timeout is the cancel), no `Request` or `Blob` bodies;
- responses are CORS-filtered for the host origin, so the guest sees only CORS-exposed headers.

### Revisit if

- hiding the host origin from targets matters: make the requests from a library-owned opaque-origin
  worker, keeping this policy code on the host;
- embedders need patterns rather than exact origins: re-implementing CSP source matching is then a
  separate, tested component, and the private-host check above is what keeps it safe;
- streaming is needed: one port per request, as above.

*Credit*: the no-redirect, timeout and size-cap discipline follows Dialog DB's `did:web` fetcher
([`dialog-did-web/src/fetch.rs`](https://github.com/dialog-db/dialog-db/blob/facd672/rust/dialog-did-web/src/fetch.rs));
the one-port-per-request stream shape follows Lunet
([`docs/lunet/data.js.flow`](https://github.com/Gozala/lunet/blob/master/docs/lunet/data.js.flow)).

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
