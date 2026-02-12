# Research 06: Protocol Handlers

## Summary

Attempted to register a custom protocol handler (`navigator.registerProtocolHandler`) from within the sandbox.

## Result

**Failed (Secure)**. Browsers typically block `registerProtocolHandler` calls from within sandboxed iframes unless `allow-top-navigation` or specific permissions are granted. The current configuration correctly prevents this.

## Reproduction Steps

1.  **Exploit Code**:
    ```javascript
    navigator.registerProtocolHandler('web+test', 'https://example.com?q=%s', 'Test Handler');
    ```
2.  **Result**: Browser throws `SecurityError` or ignores the request.
