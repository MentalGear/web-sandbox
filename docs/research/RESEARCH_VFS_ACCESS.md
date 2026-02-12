# Virtual File System (VFS) Access API

This document proposes the API methods for interacting with the Virtual File System from the Host and the Sandbox.

## Goal
Enable dynamic loading of project files (e.g. `src/`) and runtime modification/download.

## Host API (LofiSandbox)

The Host controls the VFS state via the `registerFiles` method, which communicates with the VFS Hub.

```typescript
interface LofiSandbox {
    /**
     * Overwrites or adds files to the VFS for the current session.
     * @param files Map of path -> content
     */
    registerFiles(files: Record<string, string>): void;

    /**
     * (Proposed) Deletes files from the VFS.
     */
    deleteFiles(paths: string[]): void;

    /**
     * (Proposed) Downloads all files as a ZIP blob.
     * Useful for "Export Project".
     */
    downloadZip(): Promise<Blob>;
}
```

## Sandbox API (User Code)

Inside the sandbox, the user interacts with files via standard Fetch or `<script src>` tags (read-only from VFS domain).

To support **Writes** (e.g. a transpiler writing output), we need a writable interface.

### Option A: HTTP PUT (Fetch)
User code calls `fetch('http://virtual-files.localhost/session/file.js', { method: 'PUT', body: ... })`.
*   **Pros**: Standard API.
*   **Cons**: VFS SW needs to handle PUT. Requires Cross-Origin CORS setup for PUT.

### Option B: Message Bridge
User code sends `postMessage({ type: 'FS_WRITE', path, content })` to the Host.
*   **Pros**: Host can validate/audit writes. Host updates VFS Hub.
*   **Cons**: Async coordination.

### Recommendation

Use **Option B (Message Bridge)** for writes.
1.  User code: `sandbox.fs.writeFile('dist/out.js', code)`.
2.  Bridge: Sends to Host.
3.  Host: Validates (quotas), then calls `hub.postMessage('PUT_FILES', ...)` to update VFS SW cache.
4.  Result: The new file is available for subsequent `fetch` or `script src` requests.

## Preloading Content

To preload a `svelte` src folder:
1.  Host reads local files (or fetches from API).
2.  Host calls `sandbox.registerFiles({ 'src/App.svelte': '...', ... })` *before* loading the user code.
3.  Host calls `sandbox.execute('import "./src/main.js"')`.
