# Architecture Decision: Virtual Files Access for Sandboxed Iframes

This document summarizes the analysis of two proposed architectures for providing virtual file access to untrusted code running within a sandboxed `<iframe>`.

## The Challenge

The core challenge is to allow a sandboxed environment, which runs untrusted user code, to read and interact with a set of "virtual" files, while maintaining strict security isolation. The untrusted code must not be able to access the host page's resources, compromise the host environment, or access arbitrary network resources.

---

## Scenario 1: Host-level Service Worker

In this model, the main application page (the "host") registers a Service Worker on its own origin. The sandboxed `<iframe>` is created with a `null` origin. When code inside the sandbox attempts to fetch a file, the host's Service Worker intercepts the request and serves the appropriate virtual file content.

![Host-SW Architecture](https://i.imgur.com/8a1t3tB.png)

### Pros

*   **High Security Isolation:** The Service Worker operates on the host's origin, making it completely inaccessible and unmodifiable by the sandboxed code.
*   **Leverages `null` Origin Security:** The decisive security advantage comes from using a `null` origin for the sandbox. **A `null` origin is syntactically forbidden from registering its own service workers.** This entirely eliminates the threat of the untrusted code installing a malicious service worker to hijack requests or escalate privileges.
*   **Centralized Control:** All file access logic is managed in one place (the host SW), simplifying security policies.

### Cons

*   The sandboxed code can still disrupt its *own* functionality by tampering with its internal DOM or client-side fetch calls, but it cannot break out of the sandbox or affect the host.

---

## Scenario 2: Iframe-based Service Worker (Virtual Files Hub)

This model proposed using a second, dedicated `<iframe>` (the "hub") served from a specific `virtual-files.domain`. This hub would contain its own Service Worker responsible for serving files. The sandboxed `<iframe>` would then communicate with this hub, likely via `postMessage` or by having its requests routed to the hub's service worker.

![Iframe-SW Architecture](https://i.imgur.com/S1r3Y3o.png)

### Cons

*   **Critical Security Flaw:** This architecture would require the sandboxed iframe to have an origin capable of registering service workers to communicate with the hub's worker. This opens a critical vulnerability: the untrusted code within the sandbox could simply **register its own malicious service worker**.
*   **Malicious SW Capabilities:** A malicious service worker could intercept all network requests from the sandbox, serve fake or malicious content (e.g., phishing pages disguised as legitimate components), exfiltrate data, or probe the local network.
*   **Additional Tampering Points:** Relies on communication mechanisms like `postMessage` or `<base>` tags, which themselves can be monitored or modified by the sandboxed code, creating a larger attack surface.

---

## Conclusion

**Scenario 1 (Host-level Service Worker) is the decisively superior and more secure architecture.**

The inability for a `null` origin `<iframe>` to register a service worker is the critical factor. It closes the most significant attack vector—privilege escalation via a malicious service worker. By keeping the Service Worker entirely on the host's origin, we ensure it remains outside the reach of the untrusted code, providing robust and reliable security for the virtual file system.
