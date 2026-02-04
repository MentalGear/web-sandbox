# Research 07: Data URI Navigation

## Summary

Attempted to navigate the top-level window (`window.top.location`) to a `data:` URI from within the sandbox.

## Result

**Failed (Secure)**. The `iframe` sandbox attribute does not include `allow-top-navigation`. Therefore, the browser blocks any attempt by the inner frame to change the URL of the top frame.

## Reproduction Steps

1.  **Exploit Code**:
    ```javascript
    window.top.location.href = "data:text/html,<h1>PWNED</h1>";
    ```
2.  **Result**: Browser throws `SecurityError` or blocks the navigation.
