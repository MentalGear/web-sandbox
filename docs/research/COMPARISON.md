# Sandbox Library Comparison

This document compares `iframe-sandbox` (this library) with other existing solutions in the ecosystem.

## Competitors

### 1. Zoid (Krakenjs/PayPal)
*   **Focus**: Cross-domain components and communication.
*   **Mechanism**: Uses `postMessage` bridges and sophisticated proxying.
*   **Security**: Relies on standard Cross-Origin isolation.
*   **Difference**: Zoid is primarily for *UI Components* (widgets), not arbitrary code execution sandboxing. It doesn't typically handle "virtual files" or Service Worker interception for network control.

### 2. Penpal
*   **Focus**: Simple promise-based communication with iframes.
*   **Mechanism**: Wraps `postMessage` in a Promise API.
*   **Security**: Agnostic (up to the user to configure the iframe).
*   **Difference**: Penpal is a transport layer, not a security sandbox. It doesn't enforce CSP or network rules.

### 3. Figma Plugin Sandbox (Realms / QuickJS)
*   **Focus**: Secure execution of untrusted plugins.
*   **Mechanism**: Originally used Realms (shimmed), later moved to QuickJS compiled to WebAssembly.
*   **Security**: extremely high (virtual machine approach).
*   **Difference**: Figma's approach isolates *JavaScript execution* context completely from the DOM. `iframe-sandbox` allows DOM access (within the frame) and focuses on network/storage isolation via browser primitives.

### 4. Sandboxed-iframe (Google / AMP)
*   **Focus**: Safe rendering of ads/content.
*   **Mechanism**: Strict CSP, opaque origins.
*   **Difference**: Often restrictive about what code can run.

## Why `iframe-sandbox`?

This library occupies a specific niche: **Browser-native sandboxing with "Virtual Infrastructure"**.

*   **Unique Selling Point**: It attempts to emulate a "Real Server" environment (Virtual Files, Routing) inside the browser using Service Workers (pre-refactor) or Server-Side State (post-refactor).
*   **Comparison**:
    *   vs **Zoid**: More focused on "Full Page" apps/previews than widgets.
    *   vs **Figma**: Less secure for logic (JS sharing), but allows full DOM rendering (HTML/CSS previews).
    *   vs **Penpal**: More opinionated about security architecture (Unique Origins).

## Conclusion

The refactored `iframe-sandbox` (with Unique Origins) brings it closer to industry best practices for "Preview Environments" (like CodeSandbox or StackBlitz), which also use unique subdomains (`*.csb.app`) to ensure origin isolation. The removal of the shared Service Worker makes it less "magical" but significantly more secure and aligned with the browser's security model.
