# Competitor Analysis: Local-First Sandbox vs Market

This document compares `lofi-web-sandbox` with two established solutions: `JetBrains/websandbox` and `Perspective-Software/cross-origin-html-embed`.

## Summary Table

| Feature | `lofi-web-sandbox` | `JetBrains/websandbox` | `cross-origin-html-embed` |
| :--- | :--- | :--- | :--- |
| **Architecture** | **Local-First** (srcdoc + Meta CSP) | **Dynamic/Static Host** (iframe src) | **Multi-Origin** (Wildcard Subdomains) |
| **Isolation** | **Opaque Origin** (`null`) | Sandboxed Origin (Same/Cross) | **Unique Origin** (`uuid.host.com`) |
| **Server Req.** | **None** (Static File Server) | Minimal (Static) | **High** (Wildcard DNS + SSL) |
| **Communication** | `MessageChannel` (Private) | `postMessage` RPC (Promise) | `postMessage` (Sizing/Content) |
| **Virtual Files** | **Yes** (Host-Level Service Worker) | No (Script Injection) | No (Embeds HTML) |
| **Headless** | **Yes** (Worker Mode) | No | No |

## Detailed Breakdown

### 1. JetBrains/websandbox
*   **Approach**: Creates a sandboxed iframe and uses a robust RPC layer (`Connection`) to execute functions and manage state.
*   **Pros**: Excellent developer experience for calling functions inside the sandbox.
*   **Cons**:
    *   Relies on the `sandbox` attribute for security. If `allow-same-origin` is used (often needed for some APIs), isolation weakens.
    *   No concept of "Virtual Files" or modules; relies on stringifying functions.
*   **Verdict**: Best for "Remote Function Execution", less suitable for "Full App Preview".

### 2. Perspective-Software/cross-origin-html-embed
*   **Approach**: Focuses heavily on the **Network/Origin Isolation** aspect. It mandates hosting a "helper" HTML file on a wildcard subdomain (`*.sandbox.com`).
*   **Pros**: Strongest possible network isolation (Unique Origins). Solves `localStorage` sharing and Service Worker tampering by design (as per our Research 03/02).
*   **Cons**:
    *   **Infrastructure Heavy**: Requires setting up wildcard DNS and SSL certificates. Cannot run "Local-First" or on simple static hosts (GitHub Pages) easily without config.
*   **Verdict**: Best for "Production SaaS" where infrastructure control is available.

### 3. lofi-web-sandbox (Our Solution)
*   **Approach**: Uses `iframe srcdoc` to create an **Opaque Origin**. This achieves strict isolation (no storage sharing, no SW access) *without* needing wildcard subdomains. Security is enforced via **Immutable CSP** injected into the `srcdoc` string.
*   **Innovations**:
    *   **Local-First**: Runs on `localhost`, `file://`, or any static host without DNS config.
    *   **Virtual Files**: Solves the "Asset Loading" problem for Opaque Origins using a dedicated VFS domain and `<base>` tag routing.
    *   **Headless**: Offers a `Worker` mode for pure-logic sandboxing using the same API.
*   **Verdict**: Best for "Local-First", "Offline-Capable", and "Low-Ops" scenarios while maintaining high security.

## Conclusion

`lofi-web-sandbox` fills a gap between the simple RPC of `websandbox` and the heavy infrastructure of `cross-origin-html-embed`. It provides the security benefits of unique origins (via opacity) with the deployment simplicity of a static site.
