# Research 11: CSP Delivery via `<meta>` — Limits and Failure Modes

## Summary

The local-first architecture has no server, so the Content Security Policy is delivered as a
`<meta http-equiv>` tag spliced into the `srcdoc` string (`src/host.ts:256`, injected by
`createIframe()`). This is the only option available to a document with no HTTP response of its
own — but a `<meta>`-delivered policy is **not equivalent** to a header-delivered one.

Three distinct weaknesses were found and reproduced in Chromium 1194 on 2026-08-29. One is a
genuine partial bypass of the sandbox's first defence layer.

---

## Finding 11.1 — Three directives are silently ignored

Per the CSP specification, a policy delivered via `<meta>` **must** ignore `frame-ancestors`,
`report-uri`/`report-to` and `sandbox`. Chromium confirms this with an explicit console warning:

```
The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element.
The Content Security Policy directive 'report-uri'      is ignored when delivered via a <meta> element.
The Content Security Policy directive 'sandbox'         is ignored when delivered via a <meta> element.
```

**Why this matters here**: `CSPDirectives` exposes `frame-ancestors` as a configurable directive
(`src/csp-directives.ts`), and `generateCSP()` will emit it into the policy string whenever the
consumer supplies a non-empty array. Nothing warns them. A consumer who sets `frame-ancestors`
believing they have restricted embedding has configured **nothing at all**.

The default config passes `"frame-ancestors": []`, which `generateCSP()` drops as an empty array,
so the shipped default is unaffected. The hazard is in the public config surface, not the default.

**Impact**: Low severity, high surprise. A silently-ignored security directive is worse than an
absent one, because it reads as protection in the config.

**Mitigation**: reject (or warn on) `frame-ancestors`, `report-uri`, `report-to` and `sandbox` in
`generateCSP()` when the target is `<meta>` delivery. Embedding control belongs on the host element
instead. Note also that this rules out `report-uri`/`report-to` as a violation-reporting mechanism —
the in-sandbox `securitypolicyviolation` event is the only route available (backlog S5).

---

## Finding 11.2 — A policy outside `<head>` is dropped entirely

A `<meta>` CSP is honoured only inside `<head>`. If it lands in `<body>`, the browser does not
apply a partial or degraded policy — **it applies none**.

Reproduced with five document shapes, each loading an image under `default-src 'none'`:

| # | Document shape | Where the meta landed | Policy enforced? |
| :-- | :--- | :--- | :--- |
| A | meta first in `<head>` | HEAD | ✅ blocked |
| B | `<img>` in `<head>` *before* the meta | **BODY** | ❌ **image loaded** |
| C | comment + text before the meta | HEAD | ✅ blocked |
| D | meta placed in `<body>` | **BODY** | ❌ **image loaded** |
| E | user content opens `<body>` early | HEAD | ✅ blocked |

Case B is the instructive one: an `<img>` inside `<head>` implicitly closes the head, so the
*following* meta tag is parsed into the body and the entire policy evaporates. Being textually
"first" in the source is not sufficient — it must be first in the **parsed** head.

**Impact**: High, conditional on 11.3 being reachable.

**Mitigation**: assert the invariant rather than assuming it — after constructing the document,
verify the CSP meta is the first element child of the parsed `<head>`.

---

## Finding 11.3 — The injected security block can be deleted by user content

`createIframe()` splices the security block in by regex (`src/host.ts:267-271`):

```js
if (unsafeContent.toLowerCase().includes('<html')) {
    if (unsafeContent.toLowerCase().includes('<head>')) {
        finalHtml = unsafeContent.replace(/<head>/i, `<head>${securityInjection}`);
    } else { /* insert a fresh <head> after <html> */ }
}
```

`String.replace` with a non-global regex replaces the **first** match anywhere in the string — it
has no notion of document structure. Content that contains the literal text `<head>` inside a
comment therefore captures the injection:

**Payload**
```html
<html><body><!-- <head> --><script>/* reporter */</script></body></html>
```

**Resulting `srcdoc`** (verified):
```html
<html><body><!-- <head>
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; ..."> ... -->
```

The entire security block — CSP meta, `<base>` tag and the host communication script — is now
inside an HTML comment.

**Verified from inside the sandbox**:
```
{"csp": false, "fetch": "blocked: Failed to fetch"}
```

`document.querySelector('meta[http-equiv="Content-Security-Policy"]')` returns **null**: the
document is running with **no CSP at all**.

### What saved it

The `fetch` still failed — but **not because of CSP**. It failed because the frame runs in an
opaque origin, and a cross-origin request from a `null` origin needs CORS headers the target does
not send. The second defence layer held after the first was removed entirely.

This is the defence-in-depth argument working exactly as
[`CSP_CONFIG_RATIONALE.md`](../../CSP_CONFIG_RATIONALE.md) §4 predicts — and it should not be
mistaken for the CSP having done its job.

### Residual risk

With the policy gone, `connect-src` allowlisting is gone. Anything that does not require CORS
remains reachable: `no-cors` image beacons, `navigator.sendBeacon`, form submissions, `<a ping>`,
and any endpoint that returns permissive CORS headers — i.e. any attacker-controlled server. The
URL of such a request carries the exfiltrated data.

**Impact**: **High**. Full loss of the network policy layer, triggerable by content — no execution
privilege needed, since the payload is markup, not script.

**Preconditions**: the consumer passes attacker-influenced HTML to `load()`. That is the library's
stated purpose.

**Mitigation**: stop splicing with regex. Either prepend the security block ahead of all user
content, or parse-then-serialize and insert into the real `<head>` node. Then assert 11.2's
invariant on the result. Tracked as backlog **S2**.

---

## Finding 11.4 — A transient pre-policy window

Across repeated runs, a request occasionally escaped to the network from a frame reported as
`about:blank` — the transient document that exists before `srcdoc` content is parsed and the meta
policy takes effect.

| Document shape | Requests reaching the network |
| :--- | :--- |
| template branch (no `<html>`) | 0 / 5 runs |
| well-formed `<head>` | **1 / 5 runs** |
| `<head lang="en">` | 0 / 5 runs |

The escape is **branch-independent** — it appeared on the well-formed document, which takes the
safest path — and it is racy rather than deterministic. In every run the CSP violation was still
logged, so the resource was blocked from *use*; but the request itself reached the network, which
is sufficient for exfiltration, where the URL is the payload.

Two earlier measurements suggesting a bypass in specific branches (`<head lang="en">`, the template
branch) did **not** reproduce on fresh pages and were traced to state shared between cases in the
probe harness. They are recorded here only so the negative result is not re-discovered.

**Impact**: Low-Medium — racy, small window, blocked from use but not from egress.

**Mitigation**: none available under `<meta>` delivery; the window is inherent to the mechanism.
A header-delivered policy eliminates it, because the policy arrives with the response that carries
the content.

---

## Conclusion

`<meta>` delivery is the price of the local-first architecture, and it is not free:

- three directives are unavailable and silently discarded (11.1);
- correctness depends on a *parsed-document* invariant that the current string-splicing does not
  establish (11.2);
- the injection is text, and user-controlled text can delete it (11.3);
- a small pre-policy egress window exists that cannot be closed (11.4).

The isolation model as a whole survived every case, because the opaque origin is a second,
independent layer that user content cannot remove. That is the correct reading: **the CSP is the
outer wall and it is breachable; the opaque origin is the keep.** Any document claiming
"Immutable CSP" should be read against 11.3 — see
[`COMPETITOR_ANALYSIS_2.md`](../COMPETITOR_ANALYSIS_2.md).

For the architectural consequence — that a host-served build could deliver the policy as a header
while *keeping* the opaque origin via the `sandbox` attribute — see
[ADR-001](../../ADR-001-continue-or-adopt.md).
