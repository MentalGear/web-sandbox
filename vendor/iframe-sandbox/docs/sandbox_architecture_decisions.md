# Sandbox Architecture & Design Decisions

This document outlines the evolution of the `iframe-sandbox` security model, the approaches we attempted, and the reasoning behind our current "Hybrid Firewall" architecture.

## Core Objectives
1.  **Security**: Prevent data exfiltration and unauthorized network access.
2.  **Virtual Files**: Ability to serve in-memory content (files) to the sandboxed code.
3.  **Network Control**: Granular allow/deny lists for fetch/XHR.
4.  **Developer Experience**: Support for standard browser APIs and dynamic content.

## Approaches & Evolution

### 1. The `srcdoc` Approach
*   **Concept**: Use `<iframe srcdoc="...">` to inject content directly.
*   **Pros**: Simple, synchronous content loading, no server round-trip.
*   **Cons**:
    *   **Service Worker Interception**: Browsers (especially Safari and older Chrome) differ on whether `srcdoc` requests are intercepted by the parent page's Service Worker. This made our "Virtual File" system unreliable.
    *   **Origin Issues**: `srcdoc` inherits the parent's origin in complex ways, making strict isolation difficult.

### 2. The Blob URL Approach
*   **Concept**: Create a `Blob`, generate a URL (`URL.createObjectURL`), and set it as the iframe source.
*   **Pros**: Explicit URL, works with some isolation primitives.
*   **Cons**:
    *   **Opaque Origins**: Blob URLs often have "opaque" origins (`null`), which invalidates relative paths and makes standard CSP application difficult.
    *   **Garbage Collection**: Managing the lifecycle of blob URLs added unnecessary complexity.

### 3. Current approach: The "Hybrid Firewall" Model
We settled on a server-backed architecture that layers multiple security controls.

#### Components:
1.  **Subdomain Isolation**: Tests run on `sandbox.localhost:3333`. This ensures the sandbox has a distinct origin from the host/manager application, enabling `Same-Origin Policy` protections.
2.  **Server-Side Dynamic CSP**:
    *   Security policies (CSP) are generated **on the server** based on request parameters.
    *   We use a "Fail-Closed" model: `default-src 'self'`.
    *   Specific permissions (like `script-src` or `connect-src`) are only broadened if explicitly allowed by the configuration passed to the server.
3.  **Service Worker (The Network Firewall)**:
    *   Intercepts *all* HTTP/S traffic from the sandbox.
    *   Enforces the "Network Rules" (allow/block lists).
    *   Serves "Virtual Files" from memory, bypassing the network entirely.

#### Why this wins:
*   **Reliability**: Using a real URL (`/inner-frame.html`) guarantees Service Worker interception across browsers.
*   **Security**: Moving CSP generation to the server prevents client-side tampering.
*   **Flexibility**: We can support "User Code" that uses `fetch` or imports modules dynamically, while still retaining total control over where those requests go.

### 4. Alternative Considered: Single Origin + Host Service Worker
*   **Concept**: Serve the sandbox from `localhost:3333/sandbox` and use the main Host Service Worker to intercept requests.
*   **Why we rejected it**:
    1.  **Security Risk (The "Same-Origin" Trap)**: To reliably use a Service Worker, the iframe usually needs `sandbox="allow-same-origin"`. If the sandbox is on the *same domain* as the Host, this grants the sandboxed code access to the **Host's** cookies, LocalStorage, and indexedDB.
    2.  **Service Worker Scope**: If the sandbox can access the Host's Service Worker registration, a malicious script could potentially unregister or corrupt the application's foundational logic.
    3.  **Conclusion**: To have *both* Service Worker interception ("Virtual Files") AND strong security, we **must** use a separate origin (`sandbox.localhost`). This isolates the potential blast radius to the sandbox domain only.

## Known Limitations & Automated Testing
The most significant challenge we faced is **Automated E2E Testing**.

*   **The Problem**: Our security relies on strict origin checks (`event.origin`). In local development, `localhost` and `127.0.0.1` are often used interchangeably.
*   **The Fix (Manual)**: We implemented logic to treat these as equivalent (`HOST_ALT_ORIGIN`).
*   **The Fix (Automated)**: Playwright's network environment introduces complex aliasing that sometimes causes `postMessage` relay to fail strictly on origin mismatch.
*   **Status**: While the sandbox works correctly in manual verification (browsers), we currently **skip** strict "Code Execution" tests in CI due to this environment-specific flakiness.
