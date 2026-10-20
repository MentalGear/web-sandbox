# Documentation

## Reference

- [**ARCHITECTURE.md**](../ARCHITECTURE.md) — how the library is put together, on one page: the modes and realms, the
  channels and frames, the lifecycle reducer and its state diagram, the budgets and the module map, with the tables
  generated from the code.
- [**API.md**](API.md) — the public surface: the element, every configuration option, methods, events,
  lifecycle, refusal codes, the globals guest code gets in each mode, and the limits. Its configuration, limits,
  reasons, host lines, policies and budgets are generated from the code; the rest is checked against it by
  `test/unit/api-docs.test.ts`.

## Decisions

Each ADR states its decision as it stands; how it changed is in [the archive](archive/README.md#adrs).

- [**ADR-001 — Continue, or adopt an existing solution?**](ADR-001-continue-or-adopt.md) —
  the build-vs-adopt case, an axis-by-axis comparison of opaque vs unique origins, a
  [field scan of 2026 entrants](ADR-001-continue-or-adopt.md#field-scan--august-2026), and the
  hybrid strategy (adopt the commodity layers, keep the differentiator).
- [**ADR-002 — How should host and guest call each other?**](ADR-002-host-guest-broker.md) —
  why the call broker was built in-house rather than adopted, its design choices, and the
  guarantees they give.
- [**ADR-003 — How does the host observe and control a sandbox's lifecycle?**](ADR-003-lifecycle-and-liveness.md) —
  per-instance events, the lifecycle states, `terminate()` / `reset()`, and the opt-in liveness
  watchdog with what it can and cannot bound.
- [**ADR-004 — Files are guest-realm blob URLs**](ADR-004-files-as-blob-urls.md) — why the
  virtual-files Service Worker was removed, how registered files reach the guest, and the
  alternatives rejected.
- [**ADR-005 — Strict mode**](ADR-005-strict-mode.md) — the default mode: guest logic in a worker, a view that runs
  only the library's hash-admitted bootstrap: the guarantees, the renderer, flow control, the probe findings that
  shaped it, the residuals, and why cooperative mode's limits are a frozen list.
- [**ADR-006 — A host-mediated fetch bridge**](ADR-006-fetch-bridge.md) — `sandboxFetch()`: why a
  reserved broker method, the bridge discipline (no credentials, no redirects, exact origins, caps), the
  `fetch` log and what the bridge cannot hide.
- [**ADR-007 — Typed origins**](ADR-007-typed-origins.md) — the guest policy is a fixed template per mode and the
  embedder lists exact origins per kind of load (`origins`); why that replaced the raw-CSP `connectionsAllowed` and
  its guard rails, the accepted origin grammar, what became unrepresentable.

## Planning

- [**BACKLOG.md**](BACKLOG.md) — the open work: what is not done, is deferred or waits for the owner, and the
  limits documented as accepted. Finished items are in the archive.

## Research and CSP

- [research/](research/README.md) — fourteen documented attack vectors with reproductions, design probes (strict mode,
  view isolation, the relay worker), the formal-methods evaluation and the finding classes. The reproductions run with
  `bun run test:e2e`.
- [CSP_CONFIG_RATIONALE.md](CSP_CONFIG_RATIONALE.md) — why `'unsafe-inline'`, why not nonces (superseded for
  the policy itself by [ADR-007](ADR-007-typed-origins.md)).

## Archive

- [**archive/**](archive/README.md) — history, not current state: the security review reports (adversarial, broad,
  focused, verification, review rounds 1 to 5), the done backlog items, and the finished research notes. A finding or a
  backlog item cited by ID (`R5:M-2`, `S44`) resolves there through [ids.ts](ids.ts).

## Reading order

To integrate the sandbox, read the [API reference](API.md). To work on it, start with
[ARCHITECTURE.md](../ARCHITECTURE.md) for the current state and the [backlog](BACKLOG.md) for the open work, then
[ADR-001](ADR-001-continue-or-adopt.md) for why the project exists in the form it does. The
research index is the primary asset — ADR-001 argues it is the hardest part to replicate.
