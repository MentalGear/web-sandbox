# Research 10: Base Tag Hijacking

## Summary

Injecting a `<base href="...">` tag allows an attacker to manipulate the base URL for relative paths.

## Result

**Mitigated (Partial)**. Even if the `<base>` tag is injected, the **Content Security Policy (CSP)** `connect-src` directive still enforces the allowed origins for the *resolved* URL.

Example:
1.  Attacker injects `<base href="https://evil.com">`.
2.  Attacker calls `fetch('data.json')`.
3.  Browser resolves to `https://evil.com/data.json`.
4.  CSP checks `https://evil.com` against `connect-src`.
5.  **Blocked**.

## Improvement

To provide defense-in-depth and prevent confusion (e.g. if an attacker manages to bypass CSP but relies on relative path resolution trickery), we should add `base-uri 'self'` to the CSP. This explicitly forbids `<base>` tags pointing to external origins.
