# Research 02: Service Worker Tampering

## Summary

The `iframe-sandbox` uses a Service Worker on the `sandbox.localhost` origin. Because the inner frame shares the same origin (`sandbox.localhost`) and has `allow-same-origin` enabled, code running within the sandbox has full access to the `navigator.serviceWorker` API.

This allows a malicious payload to unregister the Service Worker.

## Reproduction Steps

1.  **Exploit Code**:
    ```javascript
    navigator.serviceWorker.getRegistrations().then(regs => {
        regs.forEach(r => r.unregister());
    });
    ```
2.  **Result**: The Service Worker is removed.

## Impact

**Medium**.
*   **Virtual Files**: The primary function of the SW in the current architecture is serving "virtual files". Unregistering the SW breaks this functionality for the current session (DoS/Vandalism).
*   **Observability**: The SW also logs network requests to the host. Unregistering it allows an attacker to perform network activity (permitted by CSP) without the host being aware (Logging Bypass).
*   **Firewall**: If the architecture relies solely on CSP for blocking requests, removing the SW does not strictly "bypass" the firewall, but it removes the ability to implement more complex filtering logic in the future.

## Mitigation

1.  **Architecture**: As noted in Research 01, preventing access to `navigator.serviceWorker` requires an opaque origin, which breaks virtual file serving.
2.  **Acceptance**: If the SW is only for virtual files, SW deletion may be an acceptable risk (user breaking their own session). However, for robust logging/auditing, this remains a gap.
