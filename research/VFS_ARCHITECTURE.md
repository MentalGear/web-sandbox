# Secure Virtual File System (VFS) Architecture

This document outlines a secure architecture for serving virtual files to the sandbox using a dedicated Host-Level Service Worker.

## Problem
The previous architecture served virtual files from a Service Worker within the sandbox origin (`sandbox.localhost`). This was insecure because the sandbox user code (Same-Origin) could unregister the Service Worker.
Removing the Service Worker broke the ability to serve virtual files (e.g., `import './utils.js'`) without a backing server.

## Solution: VFS Domain

We introduce a dedicated domain (e.g., `vfs.localhost`) solely for serving virtual files. This domain is managed by a Service Worker that acts as a secure file server.

### Architecture Components

1.  **VFS Hub (`vfs.localhost`)**:
    *   An invisible iframe loaded by the Host.
    *   Registers the `virtual-files-sw.js` Service Worker.
    *   Accepts file content from the Host via `postMessage` and caches it (IndexedDB/CacheStorage).

2.  **VFS Service Worker (`virtual-files-sw.js`)**:
    *   Intercepts requests to `vfs.localhost`.
    *   **Access Control**: Checks the `Origin` or `Referer` header of incoming requests.
        *   If Origin is `*.sandbox.localhost` (valid sandbox): Serve the requested virtual file.
        *   If Origin is external (e.g., direct navigation by user): Serve a "403 Access Denied" HTML page.
    *   **Content Serving**: Maps the URL path (e.g., `/session-uuid/main.js`) to the stored content.

3.  **Sandbox (`uuid.sandbox.localhost`)**:
    *   Loads resources from the VFS.
    *   Example: `<script src="http://vfs.localhost/session-123/main.js"></script>`.
    *   Requires `Access-Control-Allow-Origin: *` (or specific sandbox origin) on the VFS responses.

### Security Properties

1.  **Tamper-Proof**: The sandbox runs on `uuid.sandbox.localhost`, while the VFS SW runs on `vfs.localhost`. The sandbox **cannot** unregister or modify the VFS SW due to Cross-Origin isolation.
2.  **Access Control**: The VFS SW explicitly validates the requester. If a user tries to open a VFS link directly in a new tab, the Origin will be empty (or the browser's), and the SW will deny access, displaying a warning:
    > "⚠️ This is a virtual file restricted to the sandbox environment."

### Implementation Plan

1.  **DNS**: Map `vfs.localhost` to `127.0.0.1`.
2.  **Host Logic**:
    *   Create `<iframe src="http://vfs.localhost/hub.html" style="display:none"></iframe>`.
    *   Wait for ready.
    *   Send `postMessage({ type: 'REGISTER_FILES', sessionId, files })`.
3.  **Sandbox Logic**:
    *   Instead of relative paths, use absolute URLs pointing to VFS?
    *   *Better*: Keep relative paths, but use a `<base href="http://vfs.localhost/session-id/">` tag?
        *   If we use `<base>`, then `./utils.js` resolves to `http://vfs.localhost/session-id/utils.js`.
        *   The VFS SW sees the request and serves it.
        *   The Sandbox CSP must allow `connect-src/script-src vfs.localhost`.

### Trade-offs

*   **Complexity**: Requires an extra domain and messaging coordination.
*   **Offline Support**: Allows offline usage (since VFS SW serves from cache).
*   **Performance**: Slight overhead for cross-origin fetches, but cached by SW.
