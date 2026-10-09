# Documentation

## Decisions

- [**ADR-001 — Continue, or adopt an existing solution?**](ADR-001-continue-or-adopt.md) —
  the build-vs-adopt case, an axis-by-axis comparison of opaque vs unique origins, a
  [field scan of 2026 entrants](ADR-001-continue-or-adopt.md#field-scan--august-2026), and the
  hybrid strategy (adopt the commodity layers, keep the differentiator).
- [Sandbox_Architecture_Decision.md](Sandbox_Architecture_Decision.md) — host-level vs
  iframe-level Service Worker. *(Duplicate of `research/ARCHITECTURE_COMPARISON.md`; backlog H1.)*

## Planning

- [**BACKLOG.md**](BACKLOG.md) — all open work, verified against the code: broken foundations,
  security, API surface, virtual files, packaging, hygiene.

## Security research

- [research/](research/README.md) — twelve documented attack vectors with reproductions, plus the
  CSP and virtual-files architecture analyses.
- [CSP_CONFIG_RATIONALE.md](CSP_CONFIG_RATIONALE.md) — why `'unsafe-inline'`, why not nonces.
- [CSP-Content-Security-Policy-settings.md](CSP-Content-Security-Policy-settings.md) — directive
  reference.

## Reading order

Start with the [backlog snapshot](BACKLOG.md#snapshot) for the current state, then
[ADR-001](ADR-001-continue-or-adopt.md) for why the project exists in the form it does. The
research index is the primary asset — ADR-001 argues it is the hardest part to replicate.
