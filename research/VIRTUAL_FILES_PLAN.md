# Virtual File System (VFS) Implementation Plan

This document details the implementation steps for a fully functional Host-Level VFS to replace the stub.

## 1. Data Model

Use `IndexedDB` on the **VFS Origin** (`vfs.localhost`) to store files.

**Database**: `SandboxVFS`
**Store**: `files`
**Key**: `sessionId + path` (e.g., `uuid-123/src/index.js`)
**Value**:
```typescript
interface VirtualFile {
    content: string | Blob;
    mimeType: string;
    lastModified: number;
}
```

## 2. VFS Service Worker (`vfs-sw.ts`)

**Lifecycle**:
1.  **Install/Activate**: Standard skipWaiting/clientsClaim.
2.  **Fetch**:
    *   Parse URL: `http://vfs.localhost/sessionId/path...`
    *   Check `Origin` header (must match `*.sandbox.localhost` or be `null` if checking session secret).
    *   Look up file in IndexedDB.
    *   Return `Response(content, { headers: { 'Content-Type': mimeType, 'Access-Control-Allow-Origin': '*' } })`.
    *   If not found -> 404.

## 3. Host Communication

**Registration**:
*   Host loads `http://vfs.localhost/hub.html` (invisible iframe).
*   Host sends `postMessage({ type: 'PUT_FILES', sessionId, files })`.

**Hub Logic (`hub.html`)**:
*   Listens for `PUT_FILES`.
*   Writes files to IndexedDB.
*   (Optional) Notifies SW via `postMessage` to clear cache for that session.

## 4. Cache Management

*   **Eviction**: Implement a "Least Recently Used" or "Time-to-Live" policy in the Hub.
    *   On `PUT_FILES`, update timestamp.
    *   Periodically scan IDB for old sessions and delete.

## 5. Deployment

*   **Production**: `vfs.my-app.com`.
*   **Dev**: `vfs.localhost` (requires `/etc/hosts` or local DNS).
