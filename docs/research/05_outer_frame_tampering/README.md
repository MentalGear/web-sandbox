# Research 05: Outer Frame DOM Tampering

## Summary

The `inner-frame` executes user code. It is embedded within an `outer-frame`. Both frames are served from `sandbox.localhost`. Because `inner-frame` has `allow-same-origin`, it is treated as Same-Origin with `outer-frame`.

This allows code in the inner frame to access `window.parent.document` and modify the DOM of the outer frame.

## Reproduction Steps

1.  **Exploit Code**:
    ```javascript
    window.parent.document.body.innerHTML = "<h1>Hacked</h1>";
    ```
2.  **Result**: The content of the outer frame is replaced.

## Impact

**Medium/High**.
*   **UI Redress**: The attacker can replace the entire sandbox UI with a fake login screen or misleading content.
*   **Infrastructure Tampering**: The `outer-frame` contains the scripts that manage the Service Worker and Message Relay. By deleting or modifying these scripts (e.g., removing the `message` event listener), the attacker can disrupt the communication channel between the Host and the Sandbox, effectively "going dark" or spoofing messages.

## Mitigation

1.  **Remove `allow-same-origin`**: As with other findings, this is the root cause.
2.  **Middle-Frame Architecture**: Use an intermediate frame for the logic that needs to be protected, and isolate the user code in a nested, opaque frame.
