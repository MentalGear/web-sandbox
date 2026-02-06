# Resource Quotas & Isolation

To prevent Denial of Service (DoS) from malicious or buggy user code (e.g., `while(true)`), strict resource quotas are necessary.

## 1. Execution Time (CPU)

### Iframe Mode
*   **Limitation**: The main thread cannot be easily interrupted by the Host.
*   **Mitigation**: `allow-scripts` is all-or-nothing.
*   **Watcher**: Run a separate `Watcher Worker` that pings the main thread. If the main thread doesn't respond (heartbeat) within N seconds, the Host assumes the sandbox is stuck.
*   **Action**: **Reload the Iframe**. This is the only way to kill a stuck main thread script in an iframe.

### Worker Mode
*   **Feature**: `worker.terminate()`.
*   **Mitigation**: The Host can set a `setTimeout`. If the Worker doesn't respond/complete in time, call `terminate()`.
*   **Recommendation**: This is the strongest argument for using Worker mode for compute-heavy tasks.

## 2. Memory Usage

*   **API**: `performance.memory` (Chrome only, non-standard).
*   **Isolation**: Cross-Origin-Embedder-Policy (COEP) + Cross-Origin-Opener-Policy (COOP).
    *   If enabled, the browser *may* put the cross-origin iframe in a separate process.
    *   If the process crashes (OOM), the Host survives.
    *   The Host detects the crash via `iframe.onload` or lack of heartbeat.

## 3. Network Bandwidth

*   **Mitigation**: The VFS Service Worker can throttle requests.
*   **API**: `fetch` monitoring in the `inner-frame` proxy (or VFS SW) can count bytes and abort requests if a limit is exceeded.

## Recommended Strategy

1.  **Default**: Use Worker mode for untrusted logic. Enforce strict timeouts.
2.  **Iframe Mode**: Use COOP/COEP headers on the Host to encourage Process Isolation. Implement a "Heartbeat" mechanism. If heartbeat fails, re-render the iframe.
