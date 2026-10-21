# CSP Design Rationale & Security Findings

> **Superseded** by [ADR-007](../../ADR-007-typed-origins.md) (2026-10-14): the guest policy is a fixed template per mode,
> the embedder lists exact origins per kind (`origins`), and every directive is explicit. The reasoning on
> `'unsafe-inline'` and nonces below still holds; the table of directives does not. Kept as a record.

This document outlines the security architecture of the `WebSandbox` and explains the trade-offs made regarding the Content Security Policy (CSP), specifically the use of `'unsafe-inline'`.

## 1. The Role of `'unsafe-inline'`

In a standard production environment, `'unsafe-inline'` is discouraged as it bypasses the primary protection against Cross-Site Scripting (XSS). However, in this research sandbox, it is enabled for both `script-src` and `style-src` for the following reasons:

### Script Compatibility & Frameworks
Modern web frameworks (e.g., Svelte, React, Vue) often rely on inline scripts for hydration or dynamic component initialization. While these can be handled via cryptographic nonces, doing so requires complex "monkey-patching" of user-provided HTML strings. To ensure that researchers can load interactive web content and local HTML pages without friction, we allow `'unsafe-inline'`.

### Style Manipulation
`style-src 'unsafe-inline'` is required to allow JavaScript to manipulate element styles directly (e.g., `element.style.color = 'red'`) and to support framework-generated scoped CSS.

## 2. Mitigating the Risks

Allowing `'unsafe-inline'` creates potential side-channels for data exfiltration. We mitigate these risks by strictly controlling the "phone home" vectors:

| Directive | Setting | Purpose |
| :--- | :--- | :--- |
| `default-src` | `'none'` | Deny-by-default fallback for all unspecified directives. |
| `script-src` | `'unsafe-inline'`, never `'self'` | `'self'` has no agreed meaning for the guest's opaque origin (WebKit admits any https origin), so it is dropped from every directive, with a warning (backlog S14). |
| `img-src` | `'none'` | Blocks image-based exfiltration. |
| `font-src` | `'none'` | Prevents exfiltration via custom font loading. |
| `media-src` | `'none'` | Prevents exfiltration via audio/video sources. |
| `blob:` | only with registered files | Added to `script-src`, `style-src`, `img-src`, `font-src`, `media-src` and `connect-src` only for the types of the files registered ([ADR-004](../../ADR-004-files-as-blob-urls.md)). A `blob:` URL resolves only in the realm that minted it, so it reaches no network and no other sandbox. |
| `frame-src` | `'none'` | Prevents nested iframes and clickjacking attempts. |
| `object-src` | `'none'` | Disables legacy plugins like Flash. |
| `worker-src` | `blob:` | Allows framework workers while preventing external script execution. |

By blocking images, fonts, and media, we effectively close the most common "blind" exfiltration paths used in CSS injection attacks, even though inline styles are permitted.

## 3. Why not Nonces?

During development, we explored a nonce-based approach where the host would inject a unique token into every `<script>` tag. We found this to be:
1. **Brittle**: Regex-based HTML manipulation is prone to errors with complex or malformed user input.
2. **Incomplete**: It does not easily solve the problem of inline event handlers (e.g., `onclick`) or scripts dynamically injected by third-party libraries.

Given that this is a **security research sandbox**, the priority is to provide a functional environment that mirrors real-world browser behavior while maintaining a controlled perimeter.

## 4. Defense-in-Depth vs. CSP

We have opted to rely on the browser's native CSP implementation rather than JavaScript-level monkey-patching (e.g., overriding `document.createElement`). Native CSP is:
- **More Secure**: It operates at the browser engine level, making it harder to bypass.
- **Cleaner**: It removes the need for a heavy "bootstrap" script inside the sandbox, reducing overhead and potential side-effects.

## Conclusion

The current CSP is a "Secure-but-Functional" configuration. It allows for the execution of complex, interactive web applications (including those built with modern frameworks) while strictly limiting the sandbox's ability to communicate with the outside world or exfiltrate data through traditional side-channels.

---
*Last Updated: February 2024*
*Context: Security Research Sandbox Project*