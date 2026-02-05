# 02: Storage Sharing Between Sessions

**Severity: MEDIUM**

## Description

All sandbox sessions share the same origin (`sandbox.localhost`), which means they share:
- localStorage
- sessionStorage
- IndexedDB
- Cache API

## Attack Vectors

### 1. Data Exfiltration
```javascript
// Malicious code stores sensitive data
localStorage.setItem('stolen', JSON.stringify(sensitiveData))

// Later session (different user/code) reads it
const stolen = JSON.parse(localStorage.getItem('stolen'))
```

### 2. Persistent Malware
```javascript
// Store malicious script
localStorage.setItem('payload', 'alert("pwned")')

// Inject into future sessions that eval storage
```

### 3. Session Confusion
```javascript
// Multiple tabs running different sandbox code
// They interfere with each other via shared storage
```

## Mitigation Options

### Option A: Unique Subdomains Per Session
Use `sandbox-<uuid>.localhost` for each session.

**Pros:** Complete isolation
**Cons:** Requires DNS wildcard or /etc/hosts entries, complicates deployment

### Option B: Clear Storage on Init
Clear all storage when sandbox initializes.

```javascript
localStorage.clear()
sessionStorage.clear()
indexedDB.databases().then(dbs => dbs.forEach(db => indexedDB.deleteDatabase(db.name)))
```

**Pros:** Simple, prevents persistence
**Cons:** Can't prevent cross-tab sharing in same session

### Option C: Storage API Blocking
Override storage APIs to throw or no-op.

```javascript
Object.defineProperty(window, 'localStorage', { get: () => { throw new Error('blocked') }})
```

**Pros:** Prevents all storage
**Cons:** Breaks legitimate use cases

## Current Status

**Not mitigated.** Consider Option B for basic protection.
