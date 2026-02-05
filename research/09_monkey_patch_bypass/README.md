# Research 09: Monkey Patch Bypass

## Summary

The decision to replace the Service Worker with "Monkey Patching" (overwriting `window.fetch`) for network logging introduces a new vulnerability. Because the user code runs in the same context as the patch, they can easily bypass it.

## Reproduction Steps

1.  **Exploit**:
    ```javascript
    const f = document.createElement('iframe');
    document.body.appendChild(f);
    // f.contentWindow has a clean 'fetch' (unpatched)
    f.contentWindow.fetch('http://secret.com');
    ```
2.  **Result**: The request happens, but the Host receives NO logs.

## Impact

**Medium**. Loss of observability. The "Firewall" (CSP) still holds, but the audit trail is broken.

## Mitigation

1.  **Recursion**: The `inner-frame` could try to patch `HTMLIFrameElement.prototype` to automatically patch new frames? Very hard to get right (cat and mouse).
2.  **Acceptance**: Accept that logging is best-effort and relying on CSP for security.
