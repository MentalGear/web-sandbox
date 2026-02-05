# 04: Resource Exhaustion

**Severity: MEDIUM**

## Description

Sandboxed code can consume system resources, affecting browser and host stability.

## Attack Vectors

### 1. CPU Exhaustion
```javascript
while(true) {} // Infinite loop
```
**Impact:** Tab freezes, may require force-close.

### 2. Memory Exhaustion
```javascript
const arr = []
while(true) arr.push(new Array(1000000))
```
**Impact:** Browser memory pressure, potential crash.

### 3. Network Flooding
```javascript
for(let i = 0; i < 10000; i++) {
    fetch('https://allowed-domain.com/endpoint')
}
```
**Impact:** Even if blocked, processing 10k requests consumes resources.

### 4. Storage Exhaustion
```javascript
const huge = 'x'.repeat(5 * 1024 * 1024) // 5MB
for(let i = 0; i < 1000; i++) {
    localStorage.setItem(`key${i}`, huge)
}
```
**Impact:** Fill disk quota, affect other sites on same origin.

### 5. Worker Spawning
```javascript
for(let i = 0; i < 100; i++) {
    new Worker(URL.createObjectURL(new Blob(['while(true){}''])))
}
```
**Impact:** Spawn many CPU-consuming workers.

## Mitigation Options

### Option A: Web Worker Isolation
Run sandbox code in a Web Worker with `terminate()` capability.

**Pros:** Can forcefully terminate runaway code
**Cons:** Workers have different API surface

### Option B: Execution Timeout
Wrap eval in a timeout that terminates execution.

```javascript
const controller = new AbortController()
setTimeout(() => controller.abort(), 5000)
```

**Pros:** Simple concept
**Cons:** JavaScript can't abort synchronous code

### Option C: Iframe Reload
If sandbox becomes unresponsive, reload the iframe.

**Pros:** Guaranteed recovery
**Cons:** Loses state, reactive not preventive

### Option D: execution.workers: false
Block worker creation via sandbox attribute.

**Pros:** Prevents worker spawning
**Cons:** Already possible, just not exposed in config

## Current Status

**Partially mitigated.**
- `maxContentLength` limits response sizes
- Iframe sandbox can block workers if configured
- No protection against sync CPU loops
