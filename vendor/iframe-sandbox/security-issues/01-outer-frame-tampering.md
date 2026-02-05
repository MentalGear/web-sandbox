# 01: Outer Frame Tampering

**Severity: HIGH**

## Description

The inner-frame has `sandbox="allow-scripts allow-same-origin"`. With `allow-same-origin`, code running in inner-frame shares origin with outer-frame and can access it via `window.parent`.

## Attack Vectors

### 1. Unregister Service Worker
```javascript
window.parent.navigator.serviceWorker.getRegistrations()
    .then(regs => regs.forEach(r => r.unregister()))
```
**Impact:** Network firewall is disabled. All subsequent requests bypass allow-list.

### 2. Modify SW Controller Reference
```javascript
// Intercept messages to SW
const realController = window.parent.navigator.serviceWorker.controller
Object.defineProperty(window.parent.navigator.serviceWorker, 'controller', {
    get: () => null
})
```
**Impact:** Rule updates don't reach SW.

### 3. Modify Outer Frame DOM
```javascript
window.parent.document.body.innerHTML = "<h1>Hijacked</h1>"
```
**Impact:** Visual tampering, could display fake content.

### 4. Override Message Handlers
```javascript
// Remove existing listeners by replacing the element
const oldFrame = window.parent.document.getElementById('inner')
oldFrame.remove()
```
**Impact:** Break message relay, isolate sandbox from host.

### 5. Inject Script into Outer Frame
```javascript
const script = window.parent.document.createElement('script')
script.textContent = 'console.log("Running in outer-frame context")'
window.parent.document.body.appendChild(script)
```
**Impact:** Execute code in outer-frame context with full access to sandbox origin.
**Note:** Still CANNOT access host (`window.top.document`) - origin isolation is enforced.

### 6. Modify HOST_ORIGIN Variable
```javascript
// If outer-frame has: const HOST_ORIGIN = ...
// Could potentially access via window.parent.HOST_ORIGIN (if not const)
```
**Impact:** Redirect messages to attacker-controlled origin.

### 7. Intercept postMessage
```javascript
const realPostMessage = window.parent.postMessage.bind(window.parent)
window.parent.postMessage = (msg, origin) => {
    console.log('Intercepted:', msg)
    // Could modify or drop messages
    realPostMessage(msg, origin)
}
```
**Impact:** Monitor/modify all host communication.

### 8. Call updateSandboxAttributes (MITIGATED)
```javascript
// Previously possible when it was a global function:
window.parent.updateSandboxAttributes({ scripts: true, popups: true, downloads: true })
```
**Impact:** Could escalate sandbox permissions.
**Status:** MITIGATED - function is now inlined inside message handler, not accessible as global.

## Why allow-same-origin is Required

The SW only intercepts requests from its registered origin (`sandbox.localhost`). Without `allow-same-origin`:
- Inner-frame gets opaque null origin
- SW doesn't intercept its requests
- **Network firewall is completely bypassed**

This is a fundamental tradeoff in the current architecture.

## Mitigation Options

### Option A: PostMessage-Based Fetch Proxy (Recommended)
Replace direct fetch in inner-frame with postMessage-based requests.

```
Inner-frame (null origin, no allow-same-origin)
    |
    +-- fetch() replaced with postMessage proxy
            |
            +-- Outer-frame receives request
                    |
                    +-- Real fetch() goes through SW
                            |
                            +-- Response sent back via postMessage
```

**Pros:** Inner-frame can't access outer-frame at all
**Cons:** Significant refactor, adds latency

### Option B: Freeze Critical Objects
Before loading inner-frame, freeze outer-frame globals:

```javascript
Object.freeze(navigator.serviceWorker)
Object.freeze(window.postMessage)
// etc.
```

**Pros:** Partial protection, easier to implement
**Cons:** Can be bypassed with prototype manipulation

### Option C: Shadow DOM Isolation
Encapsulate outer-frame internals in Shadow DOM.

**Pros:** Harder to access
**Cons:** Doesn't protect navigator, postMessage

### Option D: SW Health Monitoring
Host periodically checks if SW is still registered, re-registers if needed.

**Pros:** Recovery mechanism
**Cons:** Reactive, not preventive

## Current Status

**Not mitigated.** Documented as known limitation.

## Recommendation

Implement Option A (PostMessage Fetch Proxy) for maximum security. This eliminates the need for `allow-same-origin` on the inner-frame entirely.
