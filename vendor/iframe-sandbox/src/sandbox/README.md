# Sandbox Infrastructure

This directory (`src/sandbox/`) contains the core sandbox runtime that executes untrusted code in isolation.

## Files

| File | Purpose |
|------|---------|
| `outer-frame.html` | Outer iframe shell - registers Service Worker and relays messages |
| `inner-frame.html` | Inner iframe - executes untrusted code in isolated context |
| `outer-sw.ts` | Service Worker firewall - enforces network rules, serves virtual files |

## Security Model

```
Host (localhost)
  └── SafeSandbox (custom element)
        └── outer-frame.html (sandbox.localhost)
              ├── Service Worker (network firewall)
              └── inner-frame.html (code execution)
```

- **Origin isolation**: Sandbox runs on `sandbox.localhost`, separate from host origin
- **Network firewall**: SW intercepts all fetch requests and applies allow/block rules
- **iframe sandbox**: Inner frame uses `sandbox="allow-scripts allow-same-origin"`

## Do Not Place Here

This directory is for **infrastructure only**. Do not add:
- Demo/example content (use `/playground/test-assets/`)
- Test fixtures (use `/test/fixtures/`)
- Library code (use `/lib/`)
