# SafeSandbox Library

A secure JavaScript sandbox Custom Element featuring subdomain isolation, network virtualization, and transparent CORS handling.

## Features

- **`<safe-sandbox>` Custom Element**: Easy integration with automatic setup
- **Subdomain Isolation**: Strict origin separation between Host and Sandbox
- **Network Firewall**: Allowlist-based request filtering via Service Worker
- **CORS Proxy**: Optional server-side proxy for non-CORS APIs
- **Virtual Files**: In-memory file injection without disk writes

## Quick Start

```html
<safe-sandbox id="sandbox"></safe-sandbox>

<script type="module" src="/lib/SafeSandbox.ts"></script>
<script>
  const sandbox = document.getElementById('sandbox');

  sandbox.addEventListener('ready', () => {
    sandbox.setNetworkRules({
      allow: ['api.example.com'],
      files: { '/config.json': '{"key": "value"}' }
    });

    sandbox.execute('fetch("/config.json").then(r => r.json()).then(console.log)');
  });

  sandbox.addEventListener('log', (e) => console.log(e.detail));
</script>
```

## Architecture: The Hybrid Firewall

For a detailed deep-dive into our design choices, see [docs/sandbox_architecture_decisions.md](docs/sandbox_architecture_decisions.md).

We use a "Hybrid Firewall" model that layers multiple security controls to ensure robust isolation while enabling powerful features.

### Components
1.  **Host Application** (`http://localhost:3333`): The main application/playground. It embeds the sandbox but is isolated from it.
2.  **Sandbox Frame** (`http://sandbox.localhost:3333`): The isolated environment served from a dedicated subdomain.
3.  **CSP Firewall**: Enforced via server headers. This is the primary **Security Layer**, strictly blocking unauthorized requests and preventing implementation defects (Fail-Closed).
4.  **Service Worker**: Acts as the **Virtual Filesystem**. It intercepts network requests to serve in-memory files and provides granular proxy capabilities.

```
┌─────────────────────────────┐
│ Host Application            │
│ (http://localhost:3333)     │
└──────────────┬──────────────┘
               │
       [ Strict Origin Boundary ]
               │
┌──────────────▼──────────────┐
│ Sandbox Frame               │
│ (http://sandbox.localhost)  │
│                             │
│  ┌───────────────────────┐  │
│  │  Server-Side set CSP  │  │ <--- 1. CSP Firewall
│  └──────────┬────────────┘  │
│             │               │
│  ┌──────────▼────────────┐  │
│  │ Service Worker        │  │ <--- 2. Serves Virtual Files
│  └──────────┬────────────┘  │
│             │               │
│  ┌──────────▼────────────┐  │
│  │ Inner Frame (Code)    │  │ <--- 3. Executes User Code
│  └───────────────────────┘  │
└─────────────────────────────┘
```
| Layer | Mechanism | What It Controls |
|-------|-----------|------------------|
| **Network** | Content Security Policy (CSP) | Allowed domains (`connect-src`). Blocked requests trigger browser security violations. |
| **Virtual Files** | Service Worker | Serves in-memory files (bypassing network). |
| **Execution** | iframe sandbox attr | Capabilities (scripts, popups, etc). |
> [!IMPORTANT]
> **Shared Origin Model**: The Outer and Inner frames share the same origin (`sandbox.localhost`). Code in the Inner Frame *can* access the Outer Frame (`window.parent`).
> **Mitigation**: We explicitly Harden the Outer Frame with a strict CSP that forbids `unsafe-eval` and restricts network access to `'self'`. Even if a user "escapes" to the parent frame, they cannot execute arbitrary code or exfiltrate data.
### NetworkRules
```ts
interface NetworkRules {
  // Network Firewall (CSP)
  allow?: string[]              // Allowed domains (added to connect-src)
  allowProtocols?: ('http' | 'https')[]  // (Mapped to CSP scheme sources)
  // Note: allowMethods is no longer enforced by CSP (Standard fetch/XHR)

  // Proxy / Virtual Files (Service Worker)
  proxyUrl?: string             // CORS proxy URL
  files?: Record<string, string> // Virtual files

  // Execution Firewall (iframe sandbox attribute)
  execution?: {
    scripts?: boolean      // allow-scripts (default: true)
    formSending?: boolean  // allow-forms (default: true)
    popups?: boolean       // allow-popups (default: false)
    modals?: boolean       // allow-modals (default: true)
    downloads?: boolean    // allow-downloads (default: false)
  }
}
```

### LogMessage

```ts
interface LogMessage {
  type: 'LOG'
  timestamp: number
  source: 'outer' | 'inner'
  level: 'log' | 'warn' | 'error'
  area?: 'network' | 'security' | 'user-code'
  message: string
  data?: Record<string, unknown>
}
```

## Configuration

Set via environment variables:

```bash
PORT=3333 HOST=localhost bun server.ts
```

## Security Model

1. **Origin Isolation**: Sandbox on dedicated subdomain, no shared cookies/storage
2. **Network Firewall**: All external requests blocked unless in allowlist
3. **CSP Hardening**: Strict policies per origin

## Future Work
- postMessage: Do a comphrensive analysis of the whole codebase if we replace this with MessageChannel and the security impact
- is the sandbox server safe from request of other origins? eg can other origins/website use our sandbox subdomain for their own CSP or does it block all request from other sources ?
- [ ] **WebSocket Support**: Intercept and filter WS connections
> WebSocket (ws:, wss:) falls under connect-src in CSP. Looking at the current sandbox CSP in server.ts
connect-src *
It already allows all connections, including WebSockets. The SW firewall is what gates WebSocket connections - the SW intercepts fetch requests but cannot intercept WebSocket connections directly.
Important caveat: Service Workers cannot intercept WebSocket handshakes. So if you allow a domain in the SW's allow list, and the CSP permits it (connect-src *), WebSocket connections to that domain will go through without SW control.


- new JS REALMS API: browser support. to run without iframe
- [] MessageChannel: allow only passing primitives and callables. This prevents "prototype pollution" attacks from leaking out by preventing all complex objects from passing the messageChannel
- [ ] **MessageChannel IPC**: Replace postMessage wildcards with secure port transfer
- [ ] **Security Audits**: Automated CSP validation on startup
- [ ] **captureContentDebug**: When enabled, inject telemetry into `loadSrc()` content to capture console.log/error and thrown exceptions from external URLs
- [ ] **CSP-based Execution Control**: For finer control like blocking `eval()` while allowing scripts, or blocking inline scripts while allowing external - implement via meta tag injection in SW. Current execution firewall uses iframe sandbox attributes which are coarse-grained.
- [ ] add quickjs sandbox: https://sebastianwessel.github.io/quickjs/use-cases/ai-generated-code.html


## Service Worker Caching

Set via `cacheStrategy` in NetworkRules or URL param `outer-sw.js?strategy=<value>`:

| Strategy | Behavior |
|----------|----------|
| `network-first` | Try network, fallback to cache (default) |
| `cache-first` | Use cache if available, else network |
| `network-only` | Always fetch, no caching |

> [!WARNING]
> `cache-first` may serve stale content. Use `network-first` (default) for development. And/or clear your page data: Dev Tools > Application > Clear Data.

## Testing

E2E tests use **Playwright**. Run them using the script defined in `package.json`:

```bash
# Run all tests (Playwright)
bun run test

# Or run directly via playwright
bunx playwright test
```

> [!NOTE]
> **Skipped Tests**: Some E2E tests (specifically "Code Execution" and "Security Isolation") are currently skipped in the automated suite due to Playwright-specific network aliasing issues with `localhost` vs `127.0.0.1`. These features are verified manually. See `docs/sandbox_architecture_decisions.md` for details.

## Playground

```bash
bun server.ts
# Open http://localhost:3333
```