# Lofi Web Sandbox

A secure, local-first sandbox implementation using `iframe srcdoc`, Opaque Origins, and Immutable CSP.

## Features

-   **Zero Server Logic**: No dynamic routing or session management required on the server.
-   **Strict Isolation**: Uses `about:srcdoc` to ensure an opaque origin (`null`), preventing access to `localStorage`, `cookies`, or `Service Workers` of the host.
-   **Virtual Files**: Supports loading virtual files via a dedicated `virtual-files` domain.
-   **Immutable CSP**: Security policies are injected via `<meta>` tags at render time, making them tamper-proof from within the sandbox.
-   **Modes**: Supports `iframe` (DOM access) and `worker` (Headless/No DOM) execution modes.

## Usage

```html
<script type="module" src="/src/host.ts"></script>

<lofi-sandbox></lofi-sandbox>

<script>
  const sandbox = document.querySelector('lofi-sandbox');

  // Configure
  sandbox.setConfig({
    allow: ['https://api.example.com'],
    scriptUnsafe: true, // Allow unsafe-eval
    virtualFilesUrl: 'http://virtual-files.localhost:3000',
    mode: 'iframe' // or 'worker'
  });

  // Register Files
  sandbox.registerFiles({
      'main.js': 'console.log("Loaded Virtual File")'
  });

  // Execute
  sandbox.execute('console.log("Hello Sandbox")');
</script>
```

## Security Guarantees

1.  **Network**: Only domains in `allow` are accessible. Nested iframes are blocked.
2.  **Storage**: Ephemeral. Cleared on reload.
3.  **DOM**: No access to `window.parent`.
4.  **Popups**: Blocked or restricted based on sandbox attributes.

## Architecture

See `research/LOCAL_FIRST_ARCH.md` for details.
