# Documentation

## Reference

- [**API.md**](API.md) — the public surface: the element, every configuration option, methods, events,
  lifecycle, refusal codes, the globals guest code gets in each mode, and the limits. Checked against the
  source by `test/unit/api-docs.test.ts`.

## Decisions

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
- [**ADR-005 — Strict mode**](ADR-005-strict-mode.md) — guest logic in a worker, a view that runs only
  the library's hash-admitted bootstrap: the guarantees, the renderer, flow control, the probe findings that
  shaped it, and the residuals.
- [**ADR-006 — A host-mediated fetch bridge**](ADR-006-fetch-bridge.md) — `sandboxFetch()`: why a
  reserved broker method, the bridge discipline (no credentials, no redirects, exact origins, caps), the
  `fetch` log and what the bridge cannot hide.
- [research/ARCHITECTURE_COMPARISON.md](research/ARCHITECTURE_COMPARISON.md) — host-level vs
  iframe-level Service Worker (superseded by ADR-004).

## Planning

- [**BACKLOG.md**](BACKLOG.md) — all open work, verified against the code: broken foundations,
  security, API surface, virtual files, packaging, hygiene.

## Security research

- [**security/ADVERSARIAL-REVIEW-2026-10.md**](security/ADVERSARIAL-REVIEW-2026-10.md) — the adversarial review of
  2026-10: 21 candidates by area (policy, channels, strict mode), each fixed, asserted or stated as a residual, with
  the tests that prove it on Chromium, Firefox and WebKit.
- [**security/FOCUSED-REVIEW-2026-10-14.md**](security/FOCUSED-REVIEW-2026-10-14.md) — two focused rounds after it,
  on guest writes and the follow-up's fixes: load kinds for file references, the strict view's SVG animation, the
  execution budget, rate windows and config hygiene, each reproduced as a failing test first.
- [**security/BROAD-REVIEW-2026-10-14.md**](security/BROAD-REVIEW-2026-10-14.md) — a broad review by four reviewers:
  the guest announces its own port (no listener in the guest realm carries one), bounded loading, no `data:` workers,
  guest-realm hardening against platform gaps (keepalive, history, `window.name`), residuals measured per engine, and
  paste-ready upstream reports for WebKit and Firefox.

- [research/](research/README.md) — fourteen documented attack vectors with reproductions, design probes
  (blob delivery, strict mode), plus the CSP and virtual-files architecture analyses.
- [CSP_CONFIG_RATIONALE.md](CSP_CONFIG_RATIONALE.md) — why `'unsafe-inline'`, why not nonces.
- [CSP-Content-Security-Policy-settings.md](CSP-Content-Security-Policy-settings.md) — directive
  reference.

## Reading order

To integrate the sandbox, read the [API reference](API.md). To work on it, start with the
[backlog snapshot](BACKLOG.md#snapshot) for the current state, then
[ADR-001](ADR-001-continue-or-adopt.md) for why the project exists in the form it does. The
research index is the primary asset — ADR-001 argues it is the hardest part to replicate.
