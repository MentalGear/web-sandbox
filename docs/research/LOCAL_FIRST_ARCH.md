# Local-First Secure Sandbox Architecture

This document outlines a fully client-side, local-first architecture that removes the need for a dynamic server (no `bun dev-server.ts` routing logic) while maintaining strict security isolation.

## Core Concept: `srcdoc` + Opaque Origin + VFS Domain

Instead of relying on DNS wildcards (`uuid.sandbox.localhost`) and server-side CSP generation, we use the browser's built-in sandboxing primitives.

### 1. The Container: `iframe` with `srcdoc`

The Host renders the sandbox using an iframe populated via the `srcdoc` attribute.

```html
<iframe
  sandbox="allow-scripts"
  srcdoc="...">
</iframe>
```

*   **Origin**: `about:srcdoc` (Opaque Origin).
    *   **Isolation**: Unique for every instance. No access to `localhost` cookies/storage.
    *   **Storage**: Ephemeral. No `localStorage` persistence (solves Research 03).
    *   **Network**: No Service Worker registration possible (solves Research 02).

### 2. Security: CSP via `<meta>`

The Host generates the HTML content for `srcdoc` dynamically, injecting the CSP directly.

```html
<!-- Host generates this string -->
<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; connect-src http://vfs.localhost https://google.com;">
  <base href="http://vfs.localhost/session-uuid/">
</head>
<body>
  <script src="main.js"></script>
</body>
</html>
```

*   **Solves Research 01 (CSP Bypass)**: The CSP is hardcoded into the document structure by the Host. The user code cannot "request" a relaxed CSP via URL parameters because there are no URL parameters. To change the CSP, the Host must re-render the `srcdoc`.

### 3. Virtual Files: The VFS Domain (`vfs.localhost`)

Since Opaque Origins cannot use relative paths to fetch resources from a "server" (there isn't one), and cannot register Service Workers, we use a dedicated **Host-Level Static Domain** for serving files.

*   **Setup**: The Host loads `http://vfs.localhost` (a static site) in a background iframe to install a Service Worker.
*   **Mechanism**:
    1.  Host sends virtual files to VFS SW via `postMessage`.
    2.  Sandbox HTML includes `<base href="http://vfs.localhost/session-uuid/">`.
    3.  Sandbox requests `<script src="main.js">`.
    4.  Browser resolves to `http://vfs.localhost/session-uuid/main.js`.
    5.  VFS SW intercepts the request, verifies the session/origin (via referrer?), and serves the file.

### 4. Communication: `postMessage`

*   The Host communicates with the Sandbox via `iframe.contentWindow.postMessage`.
*   The Sandbox talks back to `window.parent` (Host).
*   **Security**: Use `MessageChannel` (Research Improvement) to establish a private pipe, avoiding `window.parent` broadcasting.

## Advantages

1.  **No Dynamic Server**: Can be hosted on any static file server (GitHub Pages, Netlify, Vercel). The "Server" just needs to serve the static VFS hub and the Host app.
2.  **Strict Isolation**: Opaque origins are the gold standard for isolation.
3.  **Simplified Security**: No complexity around wildcard DNS, server-side session state, or signature validation. The "State" is the `srcdoc` string itself.

## Limitations

1.  **No Persistence**: `localStorage` inside the sandbox is lost on reload. (Feature, not bug, for secure sandboxes).
2.  **No Cookies**: Cannot use cookies for auth within the sandbox.
3.  **Blob/Data URL constraints**: Some CSP directives might behave strictly with opaque origins.

## Security Validation

The prototype implementation (`vendor/lofi-web-sandbox`) has been verified against the following attack vectors:

| Vector | Result | Notes |
| :--- | :--- | :--- |
| **CSP Bypass** (Nested Iframes) | **Blocked** | `frame-src 'none'` prevents nesting. CSP is immutable. |
| **Service Worker Tampering** | **Blocked** | Opaque origins cannot register Service Workers. |
| **Storage Sharing** | **Mitigated** | Storage is ephemeral (cleared on reload) and isolated. |
| **Parent DOM Access** | **Blocked** | Cross-Origin restriction (`null` vs `localhost`). |
| **Popup/Window Opening** | **Restricted** | `allow-popups` allows it, but content is isolated. |
| **about:blank Injection** | **Blocked** | `window.open` inherits CSP or is restricted. |
| **CSS Exfiltration** | **Blocked** | `img-src` (default 'none') blocks external image loading. |
