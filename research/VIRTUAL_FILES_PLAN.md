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

## 2. VFS Service Worker (`sw.ts`)

**Strategy**: "Stale-While-Revalidate" / "Cache First with IDB Fallback".

**Lifecycle**:
1.  **Install/Activate**: Standard.
2.  **Startup**: (Optional) Hydrate hot keys from IDB to Memory? Or just read IDB on miss?
    *   *Optimization*: Keep L1 empty initially. On Fetch, check L1. If miss, check IDB, then populate L1.

**Fetch Logic**:
1.  Parse URL: `http://virtual-files.localhost/sessionId/path...`
2.  **Access Control**: Check `Origin` header matches `*.sandbox.localhost` (or `null` + session verification).
3.  **Read**:
    *   Check `memoryCache`. If hit -> Return.
    *   Await `idb.get(key)`. If hit -> Update `memoryCache`, Return.
    *   Return 404.

**Write Logic (Message)**:
1.  Receive `PUT_FILES`.
2.  Update `memoryCache` (Sync, instant availability).
3.  Write to `idb.put()` (Async, durability).

## 3. Host Communication

**Registration**:
*   Host loads `http://virtual-files.localhost/hub.html` (invisible iframe).
*   Host sends `postMessage({ type: 'PUT_FILES', sessionId, files })`.

**Hub Logic (`hub.html`)**:
*   Listens for `PUT_FILES`.
*   Writes files to IndexedDB directly (sharing IDB connection with SW).
*   Notifies SW via `postMessage` to invalidate/update its L1 cache.

## 4. Cache Management

*   **Eviction**: Implement a "Least Recently Used" or "Time-to-Live" policy in the Hub.
    *   Periodically scan IDB for sessions `lastAccessed < (Now - 1 hour)`.
    *   Delete them to free space.

## 5. Deployment

*   **Production**: `vfs.my-app.com`.
*   **Dev**: `virtual-files.localhost`.
