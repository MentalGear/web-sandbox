# Research 01: CSP Bypass via Nested Iframe

## Summary

The `iframe-sandbox` relies on a dynamically generated Content Security Policy (CSP) based on query parameters (`allow` and `unsafe`) passed to `inner-frame.html`. Since the inner frame is served from the same origin (`sandbox.localhost`) as the outer frame and has `allow-same-origin` set in its sandbox attribute, code running within the inner frame can create a nested `iframe` pointing to `inner-frame.html` with manipulated query parameters.

This allows an attacker to spawn a child iframe with a relaxed CSP (e.g., allowing specific domains or enabling `unsafe-eval`), effectively bypassing the restrictions imposed on the original sandbox.

## Reproduction Steps

1.  **Context**: The attack assumes the ability to execute code within the initial sandbox.
2.  **Exploit Code**:
    ```javascript
    const iframe = document.createElement('iframe');
    // Request a relaxed CSP allowing google.com
    iframe.src = "/inner-frame.html?allow=google.com&unsafe";
    document.body.appendChild(iframe);
    ```
3.  **Result**: The nested iframe loads with a permissive CSP, allowing the attacker to fetch data from `google.com`.

## Impact

**High**. This bypass renders the network restrictions ineffective against an attacker who can execute code. They can simply instantiate a new environment with the permissions they desire.

## Mitigation

1.  **Server-Side Validation (Recommended)**: The server should not blindly trust query parameters for generating CSP.
    *   *Implementation*: The host should generate a cryptographic signature (HMAC) of the allowed configuration (e.g., `sig=HMAC(allow=google.com)`). The `inner-frame` request must include this signature. The server validates that the signature matches the requested parameters. Since the inner frame does not know the secret key, it cannot generate valid signatures for relaxed permissions.

2.  **Middle-Frame Architecture (Rejected)**: Moving user code to an opaque origin (nested iframe without `allow-same-origin`) would solve this but introduces significant drawbacks:
    *   *Drawback*: Opaque origins cannot register Service Workers. This means "local webpages" inside the sandbox would fail to load resources (images, scripts) via relative paths that depend on the Service Worker to serve virtual files. Intercepting these requests would require complex DOM rewriting, making this approach impractical for this use case.

3.  **Frame Restrictions**: Setting CSP `frame-src 'none'` would prevent the creation of nested iframes entirely. This is a simple fix if nested iframes are not a required feature.
