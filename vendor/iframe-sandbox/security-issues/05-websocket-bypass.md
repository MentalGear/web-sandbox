# 05: WebSocket Bypass

**Severity: MEDIUM**

## Description

Service Workers cannot intercept WebSocket connections. Once the handshake completes, data flows directly between client and server.

## Attack Vectors

### 1. Unrestricted Communication
```javascript
const ws = new WebSocket('wss://allowed-domain.com/socket')
ws.onopen = () => {
    ws.send('Can send anything without SW monitoring')
}
```
**Impact:** Data exfiltration without logging.

### 2. Long-Lived Connections
WebSockets remain open indefinitely, allowing persistent communication that bypasses per-request controls.

### 3. Binary Data Transfer
WebSockets can transfer binary data that's harder to inspect.

## Why This Happens

The Fetch API and Service Worker interception only apply to HTTP requests. WebSocket uses a different protocol (ws:/wss:) with its own upgrade handshake.

The initial HTTP upgrade request IS intercepted by SW, but once the connection is established, the SW is out of the loop.

## Mitigation Options

### Option A: Block WebSocket Constructor
Override WebSocket in inner-frame.

```javascript
window.WebSocket = function() {
    throw new Error('WebSocket blocked by sandbox')
}
```

**Pros:** Simple, effective
**Cons:** Breaks legitimate WS use cases

### Option B: WebSocket Proxy
Intercept WS constructor, route through postMessage to host.

**Pros:** Full control
**Cons:** Complex, performance overhead

### Option C: CSP connect-src Restriction
Use CSP to restrict ws:/wss: to specific domains.

```
connect-src https: wss://allowed.com
```

**Pros:** Browser-enforced
**Cons:** Requires knowing allowed WS domains upfront

### Option D: Document Limitation
Clearly document that WS connections to allowed domains are not monitored.

## Current Status

**Not mitigated.** If domain is in allow-list, WS connections are permitted and unmonitored.

## Recommendation

Implement Option A (block WebSocket) by default, with an opt-in `allowWebSocket: true` config option.
