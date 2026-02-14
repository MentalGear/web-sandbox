 <!-- from perplexity conversation -->

# Exploring Service Worker Integrity and Update Control

This document summarizes a design exploration around verifying service worker (SW) integrity and controlling updates using custom paths and client‑side checks.

## 1. Constraints of Service Worker Self‑Verification

A service worker verifying **its own** integrity inside its `install` handler has a fundamental bootstrap problem:

- If the SW script is already compromised (e.g., server hacked, MITM before HTTPS is established, or compromised hosting), the verification logic itself can be altered or bypassed.
- Browsers do not provide a built‑in integrity check for the SW script before execution. The downloaded script is parsed and executed directly as the new worker version.
- Therefore, self‑verification is only a *defense-in-depth* mechanism, not a trust anchor. It assumes that the code performing the check is still trusted.

**Key implication:** You cannot rely solely on logic inside the new SW to guarantee its integrity if an attacker can modify the SW script.

## 2. The Service Worker Lifecycle and Updates

Important lifecycle facts used in the reasoning:

- The `install` event fires:
  - On the **first** registration of a SW.
  - On every **update** when the browser detects that the SW script bytes have changed.
- The update flow (simplified):
  1. Browser checks for a new version of the SW (navigation, periodic checks, or explicit `registration.update()`).
  2. If the script bytes differ from the current version, the browser:
     - Creates a new worker.
     - Runs its `install` event.
     - If `install` succeeds, the new SW enters the **waiting** state.
  3. On activation (after old clients release or via `skipWaiting()`), the new SW moves to **active** and the old one becomes **redundant**.
- The **old** SW cannot intercept or block the network request for its own script when the browser fetches a potential update.
- Failing `event.waitUntil()` inside `install` prevents that *particular* new version from installing/activating and marks it as redundant, but:
  - This logic runs **inside** the new SW code.
  - It does not give the *old* SW any veto over the new one.

## 3. Using Custom or Random Paths for Service Workers

You can register a SW from a non‑root, custom path while still letting it control the main origin, for example:

- Site: `https://example.com/`
- Service worker script: `https://example.com/uuid-sw-path/sw.js`
- Registration:

```js
navigator.serviceWorker.register('/uuid-sw-path/sw.js', { scope: '/' });
```

With the proper server header:

```http
Service-Worker-Allowed: /
```

the SW at `/uuid-sw-path/sw.js` can control `/` and any subpath.  

### 3.1. Fixed Random Path and Persistence

If you pick a **fixed random path** like:

- `/sw-random/sw.js`

and always register that exact URL:

- The SW registration is persistent across sessions and browser restarts (subject to browser quota and user clearing data).
- The SW will **not** be updated unless:
  - The client calls `register('/sw-random/sw.js')` again *and* the browser detects changed script bytes, or
  - The browser performs its own update check and finds that `/sw-random/sw.js` has changed on the server.

A fixed path alone does **not** give you any special “cannot be updated” guarantee; it only means “this registration is tied to that URL + scope”.

### 3.2. New Paths Per Version

Alternatively, you can generate a new, unique path for each version, for example:

- `/sw-v1-<hash>/sw.js`
- `/sw-v2-<hash>/sw.js`

In this model:

- Each version is a completely new registration.
- Old registrations (old paths) can be explicitly unregistered once clients migrate.
- This allows a more explicit, versioned update chain controlled from the main thread.

## 4. Can the Old Service Worker Gatekeep New Versions?

The key question explored was:

> Can I use a random path `/sw-random/` so that the SW stays persistent, and require that any update (new SW) must first pass an integrity test enforced by the *old* SW?

Important clarification points:

1. **The old SW cannot block the browser from fetching a new SW script.**  
   The browser’s check for a new SW version is not routed through the old SW’s fetch handler.

2. **The old SW cannot directly “deny” installation of a new SW.**  
   - The `install` event of a new SW runs in the context of the new worker.
   - Failing `event.waitUntil()` in `install` stops that version from installing, but that logic lives inside the new SW—not the old one.

3. **Installing a new SW does not require deregistering the old SW first.**  
   - When a new SW is successfully installed, it coexists in the waiting state while the old one remains active.
   - On activation of the new SW, the old automatically becomes redundant; no explicit deregister is needed for the swap.

**Conclusion:** A design where the *old* SW is the authority that must approve or deny new SW installs on the same path is not supported by the browser model. The old SW cannot “enforce” or veto the integrity of the subsequent version.

## 5. A More Realistic Integrity Strategy

Given the above constraints, a more robust pattern looks like this:

### 5.1. Main-Thread Pre‑Registration Verification

1. **Main thread fetches the candidate SW script as opaque data**, e.g.:

   ```js
   async function fetchAndVerifySw(swUrl, expectedHash) {
     const res = await fetch(swUrl, { cache: 'no-store' });
     const buf = await res.arrayBuffer();
     const hashBuf = await crypto.subtle.digest('SHA-256', buf);
     const hashArr = Array.from(new Uint8Array(hashBuf));
     const hashHex = hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
     return hashHex === expectedHash;
   }
   ```

2. The expected hash can come from:
   - A build‑time manifest.
   - A signed metadata file.
   - Some other trusted configuration channel.

3. **Only if the hash matches does the main thread call `navigator.serviceWorker.register(swUrl, { scope })`.**

This moves the primary integrity decision outside of the SW script itself.

### 5.2. Optional Self‑Check in the New SW

The new SW can still perform a self‑check in `install` for added defense-in-depth:

- E.g., verify that its main code matches a known hash, or verify important assets.
- On mismatch, it throws in `event.waitUntil()`, preventing its own installation.

This doesn’t solve the bootstrap problem (compromised SW can bypass it), but it adds consistency safeguards for accidental corruption or misdeployments.

### 5.3. Versioned Paths for Safer Updates

Combine pre‑verification with versioned paths:

- Each new version is served at `/sw-<version-id>/sw.js`.
- The main thread:
  - Fetches and verifies `/sw-<version-id>/sw.js`.
  - Registers it only if valid.
- The new SW, once active, can:
  - Notify clients via `postMessage`.
  - Coordinate removal of older registrations (unregister old versions).

This pattern avoids depending on the old SW as a gatekeeper while still allowing an auditable, integrity‑checked update chain.

## 6. What Random Paths Actually Give You

Using a random or unique path for the SW script primarily provides:

- **Isolation between versions or experiments:** Different UUID paths map to independent registrations.
- **Reduced risk of stale caches interfering with new code:** Each new path forces a fresh fetch, not served from HTTP cache.
- **Slight obscurity for an attacker:** They must know or discover the path, though security must not rely on this.

It does **not**:

- Give the old SW the ability to cryptographically enforce or deny new SW installs.
- Prevent the browser from updating the SW when the same URL’s content changes.
- Replace the need for main-thread verification and secure server practices.

---

## 7. Summary of Key Takeaways

- A compromised SW cannot be fully trusted to verify its own integrity; integrity decisions should primarily happen in the main thread or via trusted metadata.
- The `install` event runs on both first install and updates, but runs in the **new** SW, not the old one.
- Old SWs cannot intercept or veto the download or installation of new SW scripts.
- Installing a new SW does not require deregistering the old one; activation of the new implicitly makes the old redundant.
- Random or versioned SW paths are useful, but they do not change the fundamental trust model; they mainly help with separation and cache behavior.
