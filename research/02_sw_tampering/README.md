# Research 02: Service Worker Tampering

## Summary

The `iframe-sandbox` uses a Service Worker on the `sandbox.localhost` origin to act as a network firewall. However, because the inner frame shares the same origin (`sandbox.localhost`) and has `allow-same-origin` enabled, code running within the sandbox has full access to the `navigator.serviceWorker` API.

This allows a malicious payload to simply unregister the Service Worker. Once unregistered, the "Firewall" is effectively turned off. While the CSP might still restrict *where* requests can go, the *logging* and *filtering* provided by the SW are bypassed. Combined with the CSP bypass (Research 01), this grants total network control.

## Reproduction Steps

1.  **Context**: Attacker code running in the sandbox (requires `script-unsafe` or XSS).
2.  **Exploit Code**:
    ```javascript
    navigator.serviceWorker.getRegistrations().then(regs => {
        regs.forEach(r => r.unregister());
    });
    ```
3.  **Result**: The Service Worker is removed. Subsequent requests are not intercepted.

## Impact

**Critical**. The sandbox infrastructure relies on the Service Worker for security monitoring and enforcement. Allowing the guest to dismantle the infrastructure invalidates the security model.

## Mitigation

The `inner-frame` must NOT have `allow-same-origin` if it is to be isolated from the Service Worker. However, removing `allow-same-origin` breaks the current architecture (opaque origin cannot use SW). Alternatively, the `navigator.serviceWorker` property could be deleted or frozen in the `outer-frame` before the `inner-frame` is loaded? No, because `inner-frame` is a separate document.

The only robust fix is to redesign the communication to avoid `allow-same-origin` on the user-code frame (e.g., use a "middle" frame that is same-origin for SW comms, and a nested opaque-origin frame for user code).
