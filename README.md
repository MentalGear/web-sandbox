# Lofi Web Sandbox

A secure, local-first sandbox implementation using `iframe srcdoc`, Opaque Origins, and Immutable CSP.

## Architecture

This project implements a web sandbox that requires no server-side logic for security. It relies on standard browser primitives:
-   **Opaque Origins**: The sandbox runs in `about:srcdoc`, creating a unique `null` origin.
-   **CSP**: Content Security Policy is injected via `<meta>` tags at runtime.
-   **Mitigations**: Runtime monkey-patching prevents dangerous APIs (e.g., `navigator.serviceWorker`, nested `iframe`).

## Installation

This project uses [Bun](https://bun.sh).

```bash
bun install
```

## Usage

### Development Server

**Important**: You must use `bun start` to run the playground. Do NOT use static file servers (like `serve` or `http-server`) because the playground relies on Bun to transpile TypeScript files on the fly.

```bash
bun start
```

-   **Playground**: [http://localhost:4444/](http://localhost:4444/)
-   **Virtual Files Demo**: [http://localhost:4444/virtual-files](http://localhost:4444/virtual-files)

### Running Tests

Automated security regression tests are located in `research/`. They use Playwright to verify the sandbox against known attack vectors.

```bash
bun test
```

## Security Research

The `research/` directory contains reproduction scripts for various attack vectors:
-   CSP Bypass (Nested Iframes)
-   Service Worker Tampering
-   Protocol Handler Registration
-   Data URI Navigation
-   etc.

These tests are unified with the Playground "Presets". You can run them manually in the Playground or automatically via `bun test`.

## Project Structure

-   `src/`: Core sandbox implementation (`host.ts`, `lib/`).
-   `playground/`: User interface for testing and demonstration.
-   `research/`: Automated security tests (Playwright).
-   `server.ts`: Development server.
