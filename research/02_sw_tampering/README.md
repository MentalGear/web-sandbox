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

1.  **Remove `allow-same-origin`**: As with Research 01, removing `allow-same-origin` is the only way to prevent access to `navigator.serviceWorker`. The user code must run in an opaque origin.
    *   *Implementation*: Adopt the "Middle Frame" architecture. The Middle Frame (Same Origin) manages the SW. The User Frame (Opaque) runs the code and has no access to `navigator.serviceWorker`.

2.  **API Hardening (Partial)**: In the `outer-frame` (before loading `inner-frame`), one could try to delete `ServiceWorkerContainer.prototype.unregister`. However, since `inner-frame` is a fresh document, it gets a fresh set of prototypes.
    *   *Note*: This mitigation is ineffective because the iframe gets a clean global scope.
