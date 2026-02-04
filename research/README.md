# Sandbox Security Research

This repository documents security research into the `iframe-sandbox` environment.

## Definition of "Breakout"

For the purposes of this research, a "Breakout" or "Vulnerability" is defined as any mechanism that allows code running within the sandbox to:

1.  **Bypass Network Restrictions**: Successfully establishing a connection (fetch, XHR, WebSocket) to a domain not explicitly allowed in the sandbox configuration.
2.  **Access Host Context**: Gaining access to the `window.parent` or `window.top` DOM or JavaScript objects in a way that violates the intended Same-Origin Policy isolation.
3.  **Compromise Infrastructure**: Tampering with the sandbox control mechanisms (e.g., Service Workers, Shared Storage) to degrade security for the current or future sessions.

## Findings

The `research/` directory contains subdirectories for each investigated attack vector.

- [01_csp_bypass](01_csp_bypass/README.md): Bypassing network firewall by spawning nested iframes with manipulated CSP.
- [02_sw_tampering](02_sw_tampering/README.md): Disabling the network firewall by unregistering the Service Worker.
- [03_storage_sharing](03_storage_sharing/README.md): Leaking data between sandbox instances via shared LocalStorage.
