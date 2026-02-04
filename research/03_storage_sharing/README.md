# Research 03: Storage Sharing

## Summary

The sandbox architecture relies on a single origin `http://sandbox.localhost:3333` for all sandbox instances. While individual iframes are created for each "session", they all share the same browser storage context (`localStorage`, `IndexedDB`, `sessionStorage`, `cookies`).

This means that if User A runs code in the sandbox that writes to `localStorage`, User B (running in a separate iframe but same origin) can read that data. This violates the principle of isolation between different sandbox sessions.

## Reproduction Steps

1.  **Session A**: Execute code `localStorage.setItem('secret', '123')`.
2.  **Reset/New Session**: Reload the iframe or open a new one.
3.  **Session B**: Execute code `alert(localStorage.getItem('secret'))`.
4.  **Result**: Session B sees '123'.

## Impact

**Medium/High**. If the sandbox is used to process sensitive data, malicious code can persist data or steal data left behind by previous sessions. It also allows for persistent tracking of the user across sandbox resets.

## Mitigation

Use unique origins for each sandbox instance (e.g., `sandbox-1.localhost`, `sandbox-2.localhost`). This requires wildcard DNS and a wildcard SSL certificate (if HTTPS), or `sandbox` attribute without `allow-same-origin` (but this breaks SW).
