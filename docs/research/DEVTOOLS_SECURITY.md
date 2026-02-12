# DevTools Security Analysis

## Concept
A runtime overlay (HTML/CSS) injected into the Host application to monitor the Sandbox state (Logs, VFS, Status).

## Attack Surface

### 1. XSS via Logs
**Risk**: If the sandbox code logs `<script>alert(1)</script>` and the DevTools overlay renders this string as HTML, the sandbox attacks the Host.
**Mitigation**: **Strict Output Encoding**. Always use `textContent` or robust sanitization (DOMPurify) before rendering any data from the sandbox. Never use `innerHTML`.

### 2. UI Redress (Reverse Clickjacking)
**Risk**: The overlay covers important Host UI elements, tricking the user.
**Mitigation**: The Host controls the overlay. The Sandbox cannot manipulate the overlay's position or content directly (only via the strictly typed Log channel).

### 3. Information Leakage
**Risk**: If the DevTools displays sensitive data (e.g. Session IDs, Token), screensharing or shoulder surfing becomes a risk.
**Mitigation**: Mask sensitive values by default.

## Implementation Recommendation

Implement a `SandboxDevTools` class that attaches a Shadow DOM root to the body (to isolate styles).

```javascript
class SandboxDevTools extends HTMLElement {
    // ...
    log(message) {
        const div = document.createElement('div');
        div.textContent = message; // Safe
        this.root.appendChild(div);
    }
}
```
