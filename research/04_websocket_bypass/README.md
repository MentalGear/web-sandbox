# Research 04: WebSocket Bypass

## Summary

Service Workers only intercept HTTP/HTTPS requests (fetch API). They do **not** intercept the WebSocket protocol upgrade or subsequent frames. Therefore, any network traffic sent via `WebSocket` completely bypasses the Service Worker.

While the CSP (`connect-src`) can restrict *which* domains can be contacted, the Service Worker (which acts as the logging/monitoring layer and potentially a firewall with logic beyond CSP) is blind to this traffic.

## Reproduction Steps

1.  **Context**: Sandbox allows connection to `echo.websocket.events` (either via config or CSP bypass).
2.  **Exploit Code**:
    ```javascript
    const ws = new WebSocket('wss://echo.websocket.events');
    ws.send('Secret Data');
    ```
3.  **Result**: Connection succeeds. Data is sent. **No logs** appear in the host console regarding this traffic.

## Impact

**Medium**. Loss of observability. If the security model relies on the SW to audit network traffic, WebSockets provide a covert channel.

## Mitigation

1.  **Block WebSockets**: If not needed, block `wss:` scheme in CSP `connect-src`.
    *   *Implementation*: `connect-src http: https:;` (omit `ws:` and `wss:`).
2.  **Wrapper**: Overwrite `window.WebSocket` in the sandbox to wrap it in a proxy that logs activity before creating the real socket. However, sophisticated attackers can potentially recover the original constructor if not done perfectly (e.g. via iframe).
