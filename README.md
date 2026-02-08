# Lofi Web Sandbox

A secure, local-first sandbox implementation using `iframe srcdoc`, Opaque Origins, and Immutable CSP.

## Overview

Lofi Sandbox provides a mechanism to run untrusted JavaScript code safely in the browser without requiring a backend for isolation. It leverages the browser's own security primitives (Opaque Origins, CSP) to create a secure environment.

**Key Features:**
*   **Local-First:** No server round-trips for code execution.
*   **Secure:** Blocks access to `localStorage`, `Service Workers`, and the parent window.
*   **Unified:** Use the same "Preset" definitions for both manual testing (Playground) and automated regression testing.

## Getting Started

1.  **Install Dependencies**
    This project relies on [Bun](https://bun.sh).
    ```bash
    bun install
    ```

2.  **Start the Development Server**
    You **must** use `bun start` to serve the project. This starts a custom Bun server that transpiles TypeScript files on-the-fly, which is required for the Playground to function.
    ```bash
    bun start
    ```
    *   **Playground:** [http://localhost:4444/](http://localhost:4444/)
    *   **VFS Demo:** [http://localhost:4444/virtual-files](http://localhost:4444/virtual-files)

3.  **Run Tests**
    Automated security research tests verify that known vulnerabilities are mitigated.
    ```bash
    bun test
    ```

## Playground Usage

Navigate to [http://localhost:4444/](http://localhost:4444/).

*   **Presets:** Select a scenario from the dropdown to load pre-configured code and security rules. These presets match the automated test cases in `research/`.
*   **Code Editor:** Modify the JavaScript code to test different behaviors.
*   **Rules Editor:** Configure the Content Security Policy (CSP) and execution mode (iframe/worker).
*   **Logs:** View `console.log` output and security events from within the sandbox.

## Architecture

*   **`src/host.ts`**: The core implementation of the `<lofi-sandbox>` custom element. It handles iframe creation, CSP generation, and communication.
*   **`src/lib/presets.ts`**: A shared library of test scenarios used by both the Playground and automated tests.
*   **`server.ts`**: The Bun web server that serves static files and transpiles TypeScript.
*   **`research/`**: Playwright test suites for security regression testing.

## Security Mitigations

The sandbox implements several layers of defense:
1.  **Opaque Origin**: Runs in `about:srcdoc`, creating a unique null origin that isolates storage.
2.  **Strict CSP**: Generated per-session, blocking all external connections (except allowed) and nested iframes (`frame-src 'none'`).
3.  **Runtime Hardening**: Dangerous APIs like `navigator.serviceWorker` and `document.createElement('iframe')` are monkey-patched or removed at runtime.
