# Virtual File System (VFS) Implementation Plan

This document details the implementation steps for a fully functional Host-Level VFS.

## 1. Data Model

Use a Hybrid Storage model on the **VFS Origin** (`virtual-files.localhost`):

1.  **L1 Cache (In-Memory Map)**:
    *   Fastest access (sub-millisecond).
    *   Volatile (lost on SW restart).
2.  **L2 Storage (IndexedDB)**:
    *   Persistent (survives SW restart/tab close).
    *   Handles large files (Blob support).
    *   Async access.

**Configuration**: Users can choose `storage: 'memory' | 'indexeddb'` to balance performance vs persistence.

## 2. VFS Service Worker (`sw.ts`)

**Strategy**: "Stale-While-Revalidate" / "Cache First with IDB Fallback".

**Lifecycle**:
1.  **Install/Activate**: Standard.
2.  **Startup**: Hydrate L1 from L2 (if IDB enabled).

**Fetch Logic**:
1.  Parse URL: `http://virtual-files.localhost/sessionId/path...`
2.  **Access Control**: Check `Origin` header matches `*.sandbox.localhost` (or `null` + session verification).
3.  **Read**:
    *   Check `memoryCache`. If hit -> Return.
    *   Await `idb.get(key)`. If hit -> Update `memoryCache`, Return.
    *   Return 404 / "Access Denied" HTML.

## 3. Relative Path Routing

**Problem**: User code running in the sandbox (Opaque Origin) expects relative paths (e.g., `<script src="./utils.js">`) to work.
**Challenge**: Since the origin is `about:srcdoc` (or `null`), there is no "server" to resolve relative paths against.
**Solution**: **Base Tag Injection**.

The Host injects `<base href="http://virtual-files.localhost/sessionId/">` into the sandbox HTML.
*   **Mechanism**: The browser resolves `./utils.js` to `http://virtual-files.localhost/sessionId/utils.js`.
*   **Interception**: The request is sent to the VFS domain. The VFS Service Worker intercepts it and serves the content.
*   **Security**: This avoids the need for a dynamic server or a local Service Worker (which requires a secure origin and is vulnerable to tampering).

## 4. Host Communication

**Registration**:
*   Host loads `http://virtual-files.localhost/hub.html` (invisible iframe).
*   Host sends `postMessage({ type: 'PUT_FILES', sessionId, files })`.

**Hub Logic (`hub.html`)**:
*   Listens for `PUT_FILES`.
*   Writes files to IndexedDB directly (sharing IDB connection with SW).
*   Notifies SW via `postMessage` to invalidate/update its L1 cache.

## 5. Deployment

*   **Production**: `vfs.my-app.com`.
*   **Dev**: `virtual-files.localhost`.
