# Virtual Files Security Architecture Analysis

## Summary

This document analyzes two architectural models for serving virtual files to a sandboxed `<iframe>`. The conclusion is that a **Host-Scoped Service Worker (SW)** model is fundamentally more secure than an Iframe-Scoped SW model.

The decisive factor is that a properly configured sandbox runs on an **opaque (null) origin**, and browsers strictly prohibit Service Worker registration on opaque origins. This prevents the most significant attack vector: in-sandbox privilege escalation.

## Core Question

When providing a sandboxed environment with access to a virtual file system, what is the most secure architecture for serving those files?

## Architectures Considered

### Model A: Iframe-Scoped Service Worker (Insecure)

In this model, the sandboxed `<iframe>` itself would be responsible for registering a Service Worker. This SW would then intercept requests from within the iframe to serve virtual files.

### Model B: Host-Scoped Service Worker (Secure)

In this model, the main host page registers the Service Worker. The sandboxed `<iframe>` is not involved in the SW registration. To access files, the iframe communicates with the host page (e.g., via `postMessage`), and the host-level SW intercepts the host's requests to serve the virtual files.

## Analysis and Conclusion

While both models can be attacked, the potential for damage is vastly different.

### The Decisive Factor: Opaque Origins

A secure `<iframe>` sandbox is created using the `sandbox` or `srcdoc` attributes, which results in the iframe running on a unique, **opaque origin**.

**Browsers do not allow Service Workers to be registered from opaque origins.**

This single browser security rule makes Model A (Iframe-Scoped SW) unworkable in a secure sandbox and makes Model B (Host-Scoped SW) the only viable, secure option. It completely prevents the untrusted code in the sandbox from registering its own malicious SW.

### The Risk of In-Sandbox Privilege Escalation (The Flaw in Model A)

If an iframe *were* configured to allow SW registration (i.e., not on an opaque origin), it would create a major vulnerability.

1.  **The Attack:** Malicious code inside the iframe could register its own SW.
2.  **Privilege Escalation:** The attacker escalates from being a simple script to being the sandbox's network authority.
3.  **The Impact:** This malicious SW could intercept **all** requests made from within the sandbox (including scripts, images, and data fetches). It could then serve fabricated, malicious content, effectively gaining complete control over the application running inside the sandbox. This is a far more powerful and stealthy attack than simple DOM manipulation or monkey-patching `fetch()`.

### Defense-in-Depth for Model B

In the secure Host-Scoped model, the remaining attack surface is minimal. The sandbox can only attempt to send malicious `postMessage` events to the host (which must be validated) or break its own functionality. It cannot compromise the file-serving mechanism.

As a secondary defense, the host should serve the iframe's content with a strict **Content Security Policy (CSP)** to further lock down its capabilities, for example by disallowing SW registration via policy (`service-worker-src 'none'`).

## Final Recommendation

**Model B (Host-Scoped Service Worker) is the only secure architecture.**

The use of opaque origins in sandboxed iframes is the critical feature that prevents privilege escalation attacks via service worker registration. This architecture correctly isolates the powerful file-serving mechanism (the SW) from the untrusted code (the sandbox).
