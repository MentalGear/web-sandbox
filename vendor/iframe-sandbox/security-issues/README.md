# Security Issues

This directory documents known security considerations, risks, and mitigations for SafeSandbox.

## Severity Levels

| Level | Description |
|-------|-------------|
| **Critical** | Can escape sandbox to host origin |
| **High** | Can break sandbox infrastructure |
| **Medium** | Can abuse sandbox capabilities |
| **Low** | Minor concerns, limited impact |

## Issues

| File | Severity | Summary |
|------|----------|---------|
| [01-outer-frame-tampering.md](01-outer-frame-tampering.md) | High | Code can access outer-frame via window.parent |
| [02-storage-sharing.md](02-storage-sharing.md) | Medium | Storage shared between sandbox sessions |
| [03-message-spoofing.md](03-message-spoofing.md) | Low | Fake messages within sandbox origin |
| [04-resource-exhaustion.md](04-resource-exhaustion.md) | Medium | CPU/memory/disk abuse |
| [05-websocket-bypass.md](05-websocket-bypass.md) | Medium | WS connections bypass SW |

## Guaranteed Security Properties

These cannot be broken by any configuration or malicious code:

- Host cookie/storage access (origin isolation)
- Host DOM access (cross-origin policy)
- Credentialed requests to host (CORS)
