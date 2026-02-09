# Roadmap & Improvements

Based on the comparison with other libraries (Zoid, Figma, Penpal) and the recent architectural refactor, here are practical steps to further improve `iframe-sandbox`.

## 1. Solve Session Exhaustion (High Priority)

**Problem**: The current server-side session storage is unbounded and in-memory.
**Lesson**: Robust systems (like Cloudflare Workers) apply strict quotas.

**Action Plan**:
*   **Rate Limiting**: Implement a middleware in `dev-server.ts` to limit `POST /api/session` requests per IP address (e.g., 10/minute).
*   **TTL (Time-To-Live)**: Add a `lastAccessed` timestamp to the `SessionConfig` interface. Run a cleanup interval (garbage collector) every minute to delete sessions older than 5 minutes.
*   **LRU Cache**: Replace the standard `Map` with an LRU (Least Recently Used) cache implementation to enforce a hard memory limit (e.g., max 1000 active sessions).

## 2. Strengthen Network Observability (Medium Priority)

**Problem**: Removing the Service Worker (to support Unique Origins) forced us to use "Monkey Patching" for logging, which is fragile and bypassable (Research 09).
**Lesson**: Zoid uses a strict "Bridge".

**Action Plan**:
*   **Proxy Object**: Instead of patching `window.fetch`, expose a `sandbox.fetch` API that communicates with the host via `postMessage`.
*   **CSP Enforcement**: Set `connect-src 'none'` (except for the Host API). This forces user code to use the provided `sandbox.fetch` bridge, ensuring all traffic is logged and controlled by the Host.
    *   *Trade-off*: This breaks standard libraries that expect global `fetch`. We would need to polyfill `window.fetch` to use our bridge.

## 3. Communication Hardening: MessageChannel

**Concept**: Use `MessageChannel` (`port1`, `port2`) for direct, private communication between Host and Sandbox, instead of `window.postMessage` (which broadcasts to `window` and requires strict origin checks).

**Benefits**:
*   **Security**: Reduces surface area. Other frames or browser extensions cannot snoop on the channel.
*   **Performance**: Direct point-to-point communication.

**Implementation Plan**:
1.  **Host**: Create `const channel = new MessageChannel()`.
2.  **Handshake**: Host sends `channel.port2` to the sandbox via `iframe.contentWindow.postMessage('init', '*', [channel.port2])`.
3.  **Sandbox**: Listen for the initial handshake, store the port, and use `port.onmessage` for all subsequent traffic.
4.  **Refactor**: Update `SafeSandbox.ts` and `inner-frame.ts` to use `port.postMessage()` instead of `window.parent.postMessage()`.

## 4. Headless Sandbox & State Machines

**Concept**: Decouple the "Sandboxed Environment" from the "DOM Rendering". Run user code in a purely headless context (e.g., a Web Worker or a hidden iframe) managed by a State Machine.

**Architecture**:
*   **State Machine (Host)**: Uses a library like XState to manage the lifecycle of the sandbox:
    *   `Idle` -> `Initializing` -> `Running` -> `Paused` -> `Terminated`.
    *   Handles timeouts, crashes, and resets deterministically.
*   **Headless Execution**:
    *   If DOM access is *not* required: Use `new Worker()`. This eliminates XSS, Clickjacking, and DOM tampering vectors entirely.
    *   If DOM access *is* required: Use a hidden iframe, but strictly controlled by the state machine (e.g., recreating the iframe on every 'Reset' transition).

## 5. WebAssembly Isolation (Future / High Security)

**Problem**: Iframes share the main thread and rely on DOM security (Same-Origin Policy). Zero-day browser bugs can compromise this.
**Lesson**: Figma uses QuickJS in WebAssembly.

**Action Plan**:
*   **Headless Mode**: Offer a configuration option to run the code in a `Worker` inside the iframe (or just a Worker).
*   **WASM Container**: Explore integrating a JS engine compiled to WASM (like `quickjs-emscripten`). This provides "VM inside a VM" isolation, making breakout virtually impossible without a V8/WASM engine bug.
