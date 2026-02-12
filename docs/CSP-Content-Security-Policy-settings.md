# Content Security Policy (CSP) Guide: unsafe-inline, connect-src, and More

## Overview
This document summarizes key CSP concepts, focusing on `unsafe-inline` risks (scripts/styles), `connect-src` vs. other directives, and best practices for iframe sandboxing and policy configuration. All recommendations prioritize security without `'unsafe-inline'` where possible.

## unsafe-inline Risks

`'unsafe-inline'` in `script-src` or `style-src` allows inline code execution/declaration, significantly increasing XSS exposure.

### Scripts (`script-src 'unsafe-inline'`)
- Permits inline `<script>`, event handlers (`onclick=""`), `eval()`.
- **Risks**: Direct code injection; data exfiltration if `connect-src` allows.
- Does **not** bypass `connect-src`—network restrictions still apply. [stackoverflow](https://stackoverflow.com/questions/70759534/content-security-policy-connect-src-sources-unsafe-inline-and-unsafe-eval)

### Styles (`style-src 'unsafe-inline'`)
- Allows `<style>` tags and `style=""` attributes.
- **Risks**:
  - Visual phishing/defacement (hide elements, fake forms).
  - CSS-based data leaks via `attr()`, external resources (if permitted).
- Lower than scripts but amplifies XSS impact. [scotthelme.co](https://scotthelme.co.uk/can-you-get-pwned-with-css/)

**Avoid entirely**; use nonces/hashes/external files instead. [barryvanveen](https://barryvanveen.nl/articles/47-how-to-prevent-the-use-of-unsafe-inline-in-csp/)

## CSP Directives Comparison

Directives are independent; no priority hierarchy—`script-src` often most critical for XSS prevention.

| Directive    | Controls                          | Key Threat Mitigated          | Priority Context                  |
|--------------|-----------------------------------|-------------------------------|-----------------------------------|
| `script-src` | `<script>`, `eval()`, inline JS  | XSS/code execution            | User input → HTML/JS              |
| `img-src`    | `<img>`, CSS backgrounds         | Malicious/tracking images     | Untrusted image sources           |
| `connect-src`| `fetch()`, XHR, WebSockets       | Data exfiltration             | API calls, PII handling           | [content-security-policy](https://content-security-policy.com/connect-src/)

**Note**: `connect-src` does **not** govern images/links (`img-src`, `style-src`); use `default-src` for broad coverage.

## connect-src Specifics
- **Does not**: Allow arbitrary domains—`'unsafe-inline'` irrelevant here.
- **Does**: Block unlisted endpoints for dynamic requests (fetch/XHR).
- Respected even with loose `script-src`. [developer.mozilla](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src)

## No `content-src` Directive
Likely a typo for `connect-src`. Static elements use specifics:
- Images/links: `img-src`, `style-src`, `navigate-to`.
- Fallback: `default-src`. [developer.mozilla](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy)

## default-src Best Practices
- **Yes**, ideal for single allowlist: `default-src 'self' https://trusted.com` covers all unless overridden.
- Lockdown: `default-src 'none'; script-src 'self'; img-src * data:`.
- More granular > blanket for security. [cheatsheetseries.owasp](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)

## iframe Sandbox Recommendations
- Avoid `allow-scripts` + `'unsafe-inline'` for untrusted content.
- Minimal: `sandbox="allow-same-origin"` + strict CSP; use `postMessage` for interaction.
- Safer: No `allow-scripts` for pure display. [stackoverflow](https://stackoverflow.com/questions/35208161/is-it-safe-to-have-sandbox-allow-scripts-allow-popups-allow-same-origin-on-if)

## Safer Alternatives
| Instead of...              | Use...                              |
|----------------------------|-------------------------------------|
| `script-src 'unsafe-inline'` | Nonces: `nonce-r4nd0m`, hashes     |
| Inline styles              | External CSS + SRI                  |
| Broad policies             | `default-src 'none'` + explicit     | [barryvanveen](https://barryvanveen.nl/articles/47-how-to-prevent-the-use-of-unsafe-inline-in-csp/)

**Final Advice**: Audit with CSP evaluators (e.g., report-only mode). Prioritize `script-src` lockdown first. [cheatsheetseries.owasp](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)