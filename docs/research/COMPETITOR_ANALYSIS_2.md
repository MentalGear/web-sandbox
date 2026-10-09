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
*   **Pros**: Solves *cross-instance* `localStorage` sharing and Service Worker tampering (as per our Research 03/02), and delivers CSP as an HTTP **header** rather than a `<meta>` tag — see [Research 11](11_meta_csp_delivery/README.md) for what meta-delivery costs us.
*   **Correction (2026-08-29)**: this section previously read *"Strongest possible network isolation (Unique Origins)"*. That was wrong. A unique origin is a **real** origin: it has storage, can register Service Workers, and — because cookies are scoped by *domain*, not origin — sandboxed code can set a cookie readable by every other instance on that domain. Our opaque origin has none of those channels, because it has no storage and no cookie jar at all. Neither model dominates; see [ADR-001](../ADR-001-continue-or-adopt.md) for the axis-by-axis comparison.
*   **Cons**:
    *   **Infrastructure Heavy**: Requires setting up wildcard DNS and SSL certificates. Cannot run "Local-First" or on simple static hosts (GitHub Pages) easily without config.
*   **Verdict**: Best for "Production SaaS" where infrastructure control is available.

### 3. lofi-web-sandbox (Our Solution)
*   **Approach**: Uses `iframe srcdoc` to create an **Opaque Origin**. This achieves strict isolation (no storage sharing, no SW access) *without* needing wildcard subdomains. Security is enforced via CSP injected into the `srcdoc` string.
*   **Correction (2026-08-29)**: this previously described the injected policy as **"Immutable CSP"**. It is not immutable. [Research 11.3](11_meta_csp_delivery/README.md) reproduces user-supplied markup deleting the entire security block from the document, leaving it with no CSP. Isolation held in that test — but via the opaque origin, not the policy. The CSP is the outer wall; the opaque origin is the keep.
*   **Innovations**:
    *   **Local-First**: Runs on `localhost`, `file://`, or any static host without DNS config.
    *   **Virtual Files**: Solves the "Asset Loading" problem for Opaque Origins using a dedicated VFS domain and `<base>` tag routing.
    *   **Headless**: Offers a `Worker` mode for pure-logic sandboxing using the same API. **Not yet real** — the worker is spawned on the host document and inherits the host CSP (backlog S1).
*   **Verdict**: Best for "Local-First", "Offline-Capable", and "Low-Ops" scenarios while maintaining high security.

## Conclusion

`lofi-web-sandbox` fills a gap between the simple RPC of `websandbox` and the heavy infrastructure of `cross-origin-html-embed`. It provides the security benefits of unique origins (via opacity) with the deployment simplicity of a static site.
