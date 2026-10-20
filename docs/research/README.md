# Sandbox Security Research

This repository documents security research into the `iframe-sandbox` environment.

## Definition of "Breakout"

For the purposes of this research, a "Breakout" or "Vulnerability" is defined as any mechanism that allows code running within the sandbox to:

1.  **Bypass Network Restrictions**: Successfully establishing a connection (fetch, XHR, WebSocket) to a domain not explicitly allowed in the sandbox configuration.
2.  **Access Host Context**: Gaining access to the `window.parent` or `window.top` DOM or JavaScript objects in a way that violates the intended Same-Origin Policy isolation.
3.  **Compromise Infrastructure**: Tampering with the sandbox control mechanisms (e.g., Service Workers, Shared Storage) to degrade security for the current or future sessions.

## Backlog

Open work from this research — and from the rest of the project — is tracked in the
[backlog](../BACKLOG.md); its done items are in the [archive](../archive/backlog/BACKLOG-done.md). Every reproduction suite below runs with `bun run test:e2e` against the
shared harness in [`test/e2e/fixture.ts`](../../test/e2e/fixture.ts), and in CI on Chromium, Firefox
and WebKit.

The loose notes (comparisons, the Service-Worker virtual-files designs, early plans) and the design probe of blob-URL
delivery are history and live in [the archive](../archive/README.md#research). What stays here is current: the
reproductions 01 to 15 (their specs run in `bun run test:e2e` and the presets name their folders), and the design
probes and evaluations 16 to 19 that the code and the docs cite.

## Findings

Each subdirectory documents one investigated attack vector. **Status** reflects the *current*
opaque-origin architecture — several findings describe the older shared-origin design and are
closed by construction rather than by a fix.

| # | Vector | Status |
| :-- | :--- | :--- |
| [01](01_csp_bypass/README.md) | Nested iframe with a manipulated CSP | Closed by construction — no `inner-frame.html`; a nested `srcdoc` frame inherits the sandbox policy (asserted by the spec) |
| [02](02_sw_tampering/README.md) | Unregistering the Service Worker | Closed by construction — an opaque origin cannot register one |
| [03](03_storage_sharing/README.md) | Data leaking between instances via `localStorage` | Closed by construction — an opaque origin has no storage |
| [04](04_websocket_bypass/README.md) | WebSockets bypass request logging | Bridge requests are logged — `fetch` events, `BL:B5`. **Remains:** a direct `WebSocket` or `fetch` to an origin in `origins.connect` is governed by the policy but not logged ([threat model](../THREAT-MODEL.md)) |
| [05](05_outer_frame_tampering/README.md) | Reaching the outer frame's DOM | Closed by construction — no `allow-same-origin`; guarded by the deny-list test (backlog T2) |
| [06](06_protocol_handlers/README.md) | `registerProtocolHandler` | Secure — browser refuses it in a sandboxed frame |
| [07](07_data_uri_navigation/README.md) | Top-level navigation to a `data:` URI | Secure — no `allow-top-navigation` |
| [08](08_session_exhaustion/README.md) | Unbounded server-side sessions | Not applicable — the local-first design has no server; see backlog E2 |
| [09](09_monkey_patch_bypass/README.md) | Undoing monkey-patched `fetch` | **Open** — why observability needs a bridge, backlog B5 |
| [10](10_base_tag_hijacking/README.md) | Injected `<base href>` | Fixed — `base-uri` now defaults to `'none'` (finding 12) |
| [11](11_meta_csp_delivery/README.md) | Limits of delivering CSP via `<meta>` | Partial — 11.3 fixed (security block is prepended, backlog S2); 11.1 and 11.4 remain inherent to `<meta>` delivery (S7, S8) |
| [12](12_non_fallback_directives/README.md) | Empty-array directives that do not fall back | Fixed — empty `base-uri` / `form-action` are emitted as `'none'` (backlog S9) |
| [13](13_popup_exfiltration/README.md) | Popup to an attacker URL | Fixed by default — `allow-popups` needs the explicit `unsafeCapabilities` opt-in (backlog S12) |
| [14](14_self_navigation/README.md) | Guest navigates itself; host re-sends the port | Fixed — wrapper frame with `frame-src 'none'`, one-shot channel (backlog S10, S11) |

Findings 11 and 12 include probe scripts and the environment they were measured in; see
[`11_meta_csp_delivery/probes/METHOD.md`](11_meta_csp_delivery/probes/METHOD.md).

## Design probes

Measurements taken before building a planned design, each backed by an e2e spec.

| Probe | Question | Result |
| :--- | :--- | :--- |
| [Blob-URL file delivery (δ)](../archive/research/blob-delivery-probe.md) | Can guest-created blob: URLs plus an import map replace the virtual-files Service Worker? | Viable with changes: `blob:` in five directives, rewrite relative specifiers, one import map before any module. Also found the `script-src 'self'` egress route fixed by S14. Adopted: [ADR-004](../ADR-004-files-as-blob-urls.md) |
| [Strict mode (15)](15_strict_mode/README.md) | Does the strict-mode design hold, measured before building it (P1–P8)? | Holds with nine amendments (A1–A9): no nested frames, move never clone, hash the parsed text, render flow control, a view liveness check, worker hardening. Found S18 (WebKit same-site Referer). Adopted: [ADR-005](../ADR-005-strict-mode.md) |
| [View isolation (16)](16_view_isolation/README.md) | Where does the strict view run, and what can it cost the host page that its time budget does not see? | On the host page's thread everywhere but desktop Chromium 127+; CSS animations and transitions keep it 75–92% busy, outside the budget. A stylesheet in one anonymous layer plus inline-style stripping brings every vector back to idle (`allowAnimations: false`); a meter-and-actuator design was rejected; the budget's rendering measure became a gap meter. Adopted: [ADR-005](../ADR-005-strict-mode.md) |
| [Formal methods (17)](17_formal_methods/README.md) | Should the library use machine-checked proofs (Lean)? | No: of 48 medium-or-higher findings, none only a proof would have caught; the 12 a proof could reach are caught as well by property tests, model-based lifecycle tests or a type plus a source scan, at a fraction of the cost. A Lean and a fast-check proof of concept on the rate limiter; the view's time budget restated as a long-run average. Planned: S61 |
| [Finding classes (18)](18_finding_classes/README.md) | Do the findings that keep coming up share a class, and can each class be closed by construction? | Yes: 60 medium-or-higher findings fall into a few structural classes; the ones that recur had per-instance fixes, the ones closed for good were closed by an allowlist with an enumerating test. One design per class (an egress table, one boundary reader, one lifecycle reducer, one config schema, observe-and-charge for browser decisions), a probe for a trusted relay worker. Adopted: S64–S68, CONTRIBUTING.md |
| [Relay worker (19)](19_relay_worker/README.md) | Should a library-only relay worker spawn the guest as a nested worker, so its events land off the host page's thread and are measured in a trusted realm (S66)? | Build it, with caveats: nested `blob:` workers start under the view's policy on all three engines; the guest's own `postMessage` (98% / 58–63% / 29% host busy) and its uncaught errors cost the host page 0–2% through a relay that cancels them; unhandled rejections are not closed (Firefox 96–98% busy in every layout); +1.9 MB and +14–21 ms to ready per sandbox; the relay needs a byte budget that ends the guest |
