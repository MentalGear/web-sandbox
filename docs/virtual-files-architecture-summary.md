# Summary: Virtual File System Architectures in the Browser

This document summarizes the research into two primary methods for serving and executing virtual files (user-generated code) within a web-based IDE or sandbox environment.

## 1. The Core Trade-off

| Feature | Host-Level SW (vf Server) | Iframe + Hub (Router) |
| :--- | :--- | :--- |
| **Isolation Type** | **Logical**: Enforced by JS logic in the SW. | **Physical**: Enforced by Browser Origin (SOP). |
| **Security Model** | Secure by Logic (Fragile) | Secure by Design (Robust) |
| **Implementation** | Low Complexity | High Complexity (Cross-origin comms) |
| **Primary Risk** | Accidental Host Compromise | Implementation Overhead |

## 2. Key Findings

### A. The "Same-Origin" Trap
Serving virtual files from the host origin (even if filtered by a Service Worker) exposes the host to **Ambient Credential Leakage** and **Storage Hijacking**. Because the browser associates the virtual file's execution context with the host's domain, scripts can access sensitive `localStorage`, `cookies`, and `IndexedDB` data belonging to the IDE itself.

### B. Soft vs. Hard Isolation
- **Soft Isolation (Path-based):** Using `/session_id/` prevents file collisions but fails to isolate browser-level features like permissions (Camera/Microphone), storage quotas, and cookie jars.
- **Hard Isolation (Origin-based):** Using unique subdomains for the Hub/Sandbox ensures the browser treats the virtual environment as a completely separate entity, providing process isolation via "Site Isolation" features.

### C. The Role of the Host Service Worker
In both models, the Host SW is a **Root of Trust**. However, its functional responsibility changes:
- In the **vf Server** model, it is a complex logic provider (high attack surface).
- In the **Hub** model, it acts as a simple **Data Pipe (Router)**. This follows the **Principle of Least Privilege**, where the SW doesn't need to "understand" the content, only move it between isolated containers.

## 3. Security Analysis

1. **Defense in Depth:** The Iframe + Hub model provides two layers of security. Even if the Host SW logic is bypassed, the browser's Same-Origin Policy (SOP) prevents the sandboxed content from interacting with the host DOM or storage.
2. **Blast Radius:** By isolating the execution context, a crash or infinite loop in the user's virtual code only affects the ephemeral sandbox, leaving the Host IDE responsive and stable.
3. **Cache Integrity:** Dedicated origins prevent "Cache Poisoning," where a virtual file might inadvertently overwrite a critical application script in the shared `CacheStorage`.
4. **Storage Quota Exhaustion (Cache Stuffing):** In a shared-origin model, runaway scripts can exhaust the origin's storage quota. This "stuffs" the host's storage (IndexedDB/Cache), potentially preventing the IDE from saving state or loading assets. Isolated origins ensure the sandbox has its own independent quota. E.g. the sandboxed LLM could still try to "overload" the virtual-files storage at host. If virtual-files have their own iframe/sandbox, it can just be stopped or restarted.

## 4. Conclusion

While the **Host-Level SW** approach is viable for trusted content or low-risk environments, the **Iframe + Hub** model is the industry standard for executing arbitrary user code. It leverages the browser's native security boundaries to create a "Web-Native Virtualization" layer that is significantly more resilient to XSS, CSRF, and data exfiltration.

---
*Research conducted: February 2026*
*Architectural Recommendation: Iframe + Hub for untrusted code execution.*