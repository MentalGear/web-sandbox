# 03: Message Spoofing

**Severity: LOW**

## Description

Code in inner-frame can send messages to the host that appear to come from sandbox infrastructure.

## Attack Vectors

### 1. Fake READY Signal
```javascript
window.parent.parent.postMessage('READY', '*')
```
**Impact:** Host thinks sandbox is ready before SW is active.

### 2. Fake Log Messages
```javascript
window.parent.parent.postMessage({
    type: 'LOG',
    source: 'outer',
    level: 'log',
    area: 'network',
    message: 'Fake: Everything is fine'
}, '*')
```
**Impact:** Misleading logs, hide real activity.

### 3. Fake Reset Complete
```javascript
window.parent.parent.postMessage({ type: 'RESET_COMPLETE' }, '*')
```
**Impact:** Host proceeds before SW is actually unregistered.

## Why Severity is Low

The host's SafeSandbox component validates `event.origin` to be `sandbox.*`. Messages from inner-frame still come from sandbox origin (via outer-frame relay), so origin check passes.

However, the host cannot distinguish between:
- Legitimate messages from outer-frame
- Spoofed messages from inner-frame via `window.parent.parent.postMessage`

## Mitigation Options

### Option A: Message Signing
Outer-frame signs messages with a secret shared with host at init.

**Pros:** Strong authentication
**Cons:** Complex, need secure key exchange

### Option B: MessageChannel
Use dedicated MessageChannel ports instead of postMessage.

**Pros:** Direct channel, can't be spoofed
**Cons:** Requires refactor

### Option C: Nonce-Based Validation
Each message includes a nonce that host validates.

## Current Status

**Not mitigated.** Low priority due to limited impact.
