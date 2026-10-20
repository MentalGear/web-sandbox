# ADR-006: A host-mediated fetch bridge

**Status**: Accepted · **Date**: 2026-10-13

## Context

The guest's policy controls *whether* a load is allowed, but leaves the host no record of it, and an embedder that wants a
guest to reach one API has only one lever, `connect-src`, which hands the guest a direct channel to that origin. A bridge
gives the host a decision and a log per request: the guest asks, the host makes the request.

A fetch made by the host page runs with the host page's authority. Done naively it sends the host's cookies, follows
redirects past any allowlist, buffers without limit and outlives the guest that asked for it. The *bridge discipline* is
the requirement this record implements: the bridge grants no more than a direct guest request would.

## Decision

**Opt-in `fetchBridge: { allow, maxBytes?, timeoutMs?, methods?, headers?, maxConcurrent? }`.** The guest gets
`sandboxFetch(url, init)`, which resolves with a `Response` or rejects with a `FETCH_*` code. The guest policy is
unchanged: `connect-src` stays what the embedder set (`'none'` by default), so the bridge is the only way out unless the
embedder also allows direct connections.

1. **A reserved broker method, not a new frame type.** The request rides the broker ([ADR-002](ADR-002-host-guest-broker.md))
   as a call to `sandbox:fetch`, so it reuses correlation, the per-call timeout, clone checks, teardown rejection and the
   answer-on-arrival-port rule that keeps frame generations apart. A dedicated frame type would have duplicated all of
   that. What a frame type gives for free — no collision with exposed names — is made true by construction instead: names
   starting with `sandbox:` live in a registry of their own, written only by `exposeReserved()`, and `expose()` never
   registers such a name (the element also warns). So no embedder or guest method can replace the bridge, and the bridge
   never answers to a name someone else exposed. **The method is bound to its build**: every build registers it again,
   closed over that build's bridge, as `sandbox:write` is over its overlay. A request is always handled by the bridge of the
   environment it arrived in, which teardown closed, so a request that runs after a rebuild is refused there
   (`FETCH_FAILED`) and never made by the next environment.
2. **Refusals carry a library code through the broker's rejection path.** A closed set, disjoint from the call codes:
   `FETCH_NOT_ALLOWED`, `FETCH_BUSY`, `FETCH_REDIRECT`, `FETCH_TOO_LARGE`, `FETCH_TIMEOUT`, `FETCH_FAILED`. Only a reserved
   method's error forwards one; any other handler's code is `HANDLER_ERROR`. The calling side accepts one only for a call
   to a reserved name and only when created with `acceptLibraryCodes` — the guest's broker. The host's broker is not, so
   nothing the guest sends can give a host call a library code. Retry follows from the code: `FETCH_BUSY`, `FETCH_TIMEOUT`
   and `FETCH_FAILED` may succeed later; the others will not.
3. **A separate global, never a replacement for `fetch`.** Silently replacing `fetch` would hand libraries something that
   looks like `fetch` but has no streaming, no `AbortSignal`, no `Request` bodies and different failure codes. Guest code
   that wants it as `fetch` writes `globalThis.fetch = sandboxFetch`.
4. **The discipline, all enforced on the host** (`src/lib/fetch-bridge.ts`); the guest side only shapes the request and
   builds the `Response`:
   - `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, `cache: 'no-store'`, `mode: 'cors'`, `keepalive: false`. From
     `init`, only `method`, `headers` and `body` are read.
   - **Redirects are never followed**: `redirect: 'manual'`, and the opaque redirect it yields is refused with
     `FETCH_REDIRECT`. Same guarantee as `'error'` (the second request is never made), but the refusal is told apart from a
     network failure.
   - **An exact-origin allowlist** (scheme, host, port), read by the one origin parser (`src/lib/origin.ts`, `parseOrigin`,
     shared with the guest policy's `origins`; [ADR-007](ADR-007-typed-origins.md)); the bridge's rules are `https:` and
     `http:` for any host (`FETCH_ORIGIN_RULES`). An entry the parser would rewrite into another spelling — IPv4 shorthand
     (`https://127.1`), percent-encoding, a non-ASCII name (write its `xn--` form), a trailing dot, whitespace, an IPv6
     literal — or one with a path, query, credentials or wildcard is dropped with a warning. No CSP source expressions. Only
     `http:` and `https:` request URLs, never with credentials in the URL; the fragment is dropped.
   - **The host page's origin and loopback, private and link-local hosts** (`localhost`, `*.localhost`, 127/8, 10/8,
     172.16/12, 192.168/16, 169.254/16, 100.64/10, `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped forms, …) are refused unless
     listed. The exact allowlist already refuses them; they are checked again by name so the refusal says why and the check
     survives any later widening of the allowlist. Every spelling the URL parser canonicalises (`127.1`, `2130706433`,
     `0x7f.1`, `[::ffff:127.0.0.1]`) is caught. **DNS rebinding is a limit, not a guarantee**: a page cannot see DNS
     answers, so a listed public name that resolves to a private address is not detected.
   - **One refusal text for every unlisted origin.** The guest is told `<origin> is not in fetchBridge.allow`, whatever the
     reason; what the host knows beyond that (the host page's own origin; a loopback, private or link-local host) is the
     `fetch` record's `reason` field, never sent to the guest. Otherwise a guest could find the origin that embeds it by
     probing.
   - **Methods** from an allowlist: `GET`, `HEAD`, `POST` by default; `PUT`, `PATCH`, `DELETE` when listed.
   - **Request headers** from an allowlist: the CORS-safelisted names (`accept`, `accept-language`, `content-language`,
     `content-type`) plus names the embedder lists. `Cookie` can never be listed (nor any name `fetch` forbids, `proxy-*`,
     `sec-*`); `Authorization` only when listed. A header the guest may not set refuses the request rather than being
     dropped, so the guest never believes it sent it.
   - **The platform validates the request.** The bridge builds the `Request` itself, from the validated fields and the pinned
     options, before it records anything; whatever the constructor throws is `refused` (`FETCH_NOT_ALLOWED`) and `fetch()` is
     never called. `fetch()` is given that `Request` and the same init, so what was checked is what is sent. The init goes
     again, whole: an abort that reaches the fetch only through the `Request`'s own signal does not stop a response whose
     headers arrived in WebKit (so the timeout and teardown left the upstream connection open), and a partial init makes the
     `Request` constructor reset the referrer policy, which brings the `Referer` back (all three engines).
     `validateRequest()` keeps only policy: origins, private hosts, methods, header names and sizes, so the bridge keeps no
     copy of a rule the browser applies anyway (a header value is a `ByteString` without NUL, CR or LF, and so on).
   - **Bodies**: a request body is a string, `ArrayBuffer` or typed array, at most `maxBytes`. The response body is capped at
     `maxBytes` (1 MiB by default, at most 32 MiB): a declared `Content-Length` over the cap refuses before reading;
     otherwise the body is read chunk by chunk and abandoned as soon as the total passes the cap, so at most the cap plus one
     chunk is read. `Content-Length` is never trusted.
   - **Time and lifetime**: one `AbortController` per request, fired by the per-call timeout (10 s by default, at most 120 s;
     covers the body too) and by teardown — `reset()`, `load()`, `setConfig()`, `terminate()` and removal abort every request
     of that environment, closing the upstream connection.
   - **Whole responses only.** No streaming. If it is ever needed, it uses one dedicated port per request so closing that port
     is the cancel; chunks never go on the broker port.
   - **Concurrency**: at most `maxConcurrent` (4 by default, at most 16) requests in flight per sandbox; one more is refused
     with `FETCH_BUSY`. So the bridge's memory is bounded by `maxConcurrent × maxBytes`.
5. **Every request is logged.** The element dispatches a `fetch` event, bubbling like `violation`, once per request when it
   settles: `{ method, url, outcome, status?, code?, reason?, bytes, durationMs }`, with `outcome` one of `ok`, `refused` (no
   request made), `failed` (`fetch()` was called and no response was handed over) and `aborted` (torn down). `failed` is not
   proof that a request left the page: the browser's `fetch()` also rejects some requests before sending them (the host
   page's own `connect-src`, mixed content, local-network blocking), and a page cannot tell those apart. No path to the
   network skips the record, refusals included. The record is built by the host from validated fields, and guest-supplied
   strings are clamped: the URL is the whole URL without its fragment, up to `MAX_URL` (8192 characters; a longer one is
   refused, and reported cut to that, unparsed), and a method that is not a method is reported as `''`.
6. **The request comes from the host page.** So the target sees the host page's origin in `Origin` (never its URL: no
   `Referer`), and the response must pass CORS for that origin; `*` works, since no credentials are sent. This is more than a
   direct guest request reveals (`Origin: null`), and is accepted because every target is one the embedder listed. Running
   the bridge from an opaque-origin context of its own would hide it, at the cost of another frame or worker; see *Revisit
   if*.

## Alternatives considered

- **A dedicated frame type** (`FETCH_REQ`/`FETCH_RES`). Collision-free like `PING` and `VIOLATION`, but a request needs
  everything the broker already does (ids, timeouts, teardown, clone checks, generation isolation); the reserved namespace
  gets the collision property without the duplication.
- **Polyfilling `fetch` by default.** Rejected for the reasons in decision 3; it is one line of guest code when wanted.
- **`redirect: 'error'`**. Same no-follow guarantee, but a redirect then reads as a network failure.
- **Dropping disallowed headers silently.** The guest would believe a header was sent; refusing is explicit.
- **Capping `fetch` events per environment** like `violation`. The cap that matters is on requests made (concurrency);
  refused attempts cost the host what any port message costs (S6's open note), and an event cap would let requests go
  unlogged.
- **A ByteString check of header values of the bridge's own.** A copy of a rule the browser applies anyway, which could drift
  from it; the `Request` constructor is the check.

## Consequences

Guaranteed, each with a test (`src/lib/fetch-bridge.test.ts`, `src/lib/origin.test.ts`, `src/lib/rpc.test.ts`,
`src/lib/in-sandbox-script.test.ts`, `test/unit/host.test.ts`, `test/unit/channel-guarantees.test.ts`,
`test/unit/broad-review.test.ts`, `test/unit/focused-review.test.ts`, and `test/e2e/fetch-bridge.spec.ts` on Chromium,
Firefox and WebKit against the recorder's two listeners outside the browser and an echo on the harness origin):

- an allowlisted origin is reached and the request logged; any other is refused before a request leaves, and nothing reaches
  the blocked listener (positive control: the same request, listed, reaches it);
- a cookie on the harness origin never reaches it through the bridge, while the host page's own request carries it; no
  `Cookie`, `Authorization` or `Referer` reaches the target;
- a redirect from an allowlisted origin to another is refused and the other origin records nothing (positive control: a
  following fetch from the host page reaches it);
- an oversized body is refused by its `Content-Length` unread, or after the cap plus one chunk (exact in the unit test with a
  counted stream; end to end, the upstream connection closes long before the end);
- `reset()` during a slow response, and the timeout, close the upstream connection;
- the host origin, and every spelling of a loopback host, are refused unless listed, with one text to the guest;
- the reserved name cannot be taken by `expose()` on either side; with the bridge off there is no `sandboxFetch` and a direct
  call to the reserved method is refused without a request;
- the guest policy is unchanged: a direct `fetch` and `WebSocket` to the listed origin are still refused and reported as
  violations.

Costs and limits:

- DNS rebinding (above); the host origin in `Origin` (decision 6);
- receipt cost: a guest can still flood the port with refused requests, each costing the host a validation and an event
  (bounded by the guest call budget, [ADR-002](ADR-002-host-guest-broker.md)); requests actually made are bounded by
  `maxConcurrent`;
- no streaming, no `AbortSignal` from the guest (the timeout is the cancel), no `Request` or `Blob` bodies;
- responses are CORS-filtered for the host origin, so the guest sees only CORS-exposed headers.

### Revisit if

- hiding the host origin from targets matters: make the requests from a library-owned opaque-origin worker, keeping this
  policy code on the host;
- embedders need patterns rather than exact origins: re-implementing CSP source matching is then a separate, tested
  component, and the private-host check above is what keeps it safe;
- streaming is needed: one port per request, as above.

*Credit*: the no-redirect, timeout and size-cap discipline follows Dialog DB's `did:web` fetcher
([`dialog-did-web/src/fetch.rs`](https://github.com/dialog-db/dialog-db/blob/facd672/rust/dialog-did-web/src/fetch.rs));
the one-port-per-request stream shape follows Lunet
([`docs/lunet/data.js.flow`](https://github.com/Gozala/lunet/blob/master/docs/lunet/data.js.flow)).

History: [the amendments to this decision](archive/adr/ADR-006-history.md).
