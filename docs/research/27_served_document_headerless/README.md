# Research 27: the served document with no response headers

**Question (before the owner chooses between D8 and the "no backend" promise).** D8
([research 24](../24_sealed_mode/README.md)) moves sealed mode to a **served document**: one static file the embedder
serves, loaded in an `iframe[sandbox="allow-scripts"]`, with the view and the worker created inside it.
[Research 20](../20_served_document_mode/README.md) measured that design with response headers (`sandbox`,
`frame-ancestors`, the policy). The README and `package.json` promise "local-first … no backend", and
[ADR-001](../../ADR-001-continue-or-adopt.md) counts "no server config" among the project's reasons (GitHub Pages, `file://`).
This note measures what holds when the file is served **with no headers at all**, its policy in a `<meta>` tag, and what
the file can do for itself: whether the host page's policy still reaches it (Q1), whether the file can stay inert when it
is opened the wrong way (Q2), whether it can see a policy the embedder's server adds (Q3), what it still takes from the
host page (Q4), which hosts can serve it (Q5) and where it runs (Q6).

**Measured on headless Playwright 1.58.1 on a shared 4-core VM** (Chromium 145.0.7632.6 headless shell, Firefox 146.0.1,
WebKit 26.0), 2026-11-14, from `cd12c26`. No library code: plain HTML served by a `node:http` server on loopback, as in
research 20. Every cell below names its engine; a cell not measured says so. Raw output is in [`results/`](results/README.md).

## Answer in brief

- **(Q1) A header-less file with a `<meta>` policy starts a policy of its own, on all three engines.** Under a host page
  whose policy refuses every action of the probe (fetch, image, `<base>`, inline style, `eval`, Trusted Types sinks,
  blob: worker), today's `srcdoc` frame and its worker were refused each one by the **host's** policy; the served frame,
  its `srcdoc` child and both workers were refused **none** by the host's policy, and were bound by the file's `<meta>`
  (a canary the `<meta>` refuses was refused, with the `<meta>` named as the refusing policy, in every document and
  worker). No violation of the served frame reached the host page's `report-uri` or fired on the host page. The one
  thing the host's policy must admit is the frame itself: `frame-src` or `child-src` `'self'` (or the file's URL).
- **(Q2) The file can make itself inert by construction, but "opaque" is not "embedded by my host".** A first statement
  that reads `self.origin` saw an opaque origin in the legitimate case and the real origin in every wrong-way case
  without the attribute (top level, popup, same-origin, same-site and cross-site framing, `allow-same-origin`), on all
  three engines. It also saw an opaque origin when a **hostile cross-site page** frames the file with
  `sandbox="allow-scripts"`, or opens it from a sandboxed frame; there it cannot tell the attacker from the host, except
  through `location.ancestorOrigins` on Chromium and WebKit (Firefox has no equivalent; `document.referrer` is the
  embedder's to remove). Against an inert document, a cross-site embedder could only count its frames (0) and post a
  message nobody listens to.
- **(Q3) An outside policy that refuses something the file can provoke is detectable; one that refuses nothing it can
  provoke is not, and is then inert for the file.** Canaries plus the `originalPolicy` of each
  `securitypolicyviolation` detected every enforced and report-only site policy tried on all three engines (Firefox has
  no Trusted Types, so a `require-trusted-types-for` header changes nothing there and is not seen). A site policy
  without `'unsafe-inline'` for scripts stops the file before any code runs (fails closed by itself, and its
  report goes to the site). Not detected: `frame-ancestors`, `upgrade-insecure-requests`, a header `sandbox`, directives
  no canary covers (`object-src`, `form-action`), and permissive policies. **A report-only site policy received every
  refused canary URL, including the `srcdoc` child's and the worker's**: an outside `report-uri` is a channel out of the
  document as long as the document keeps running.
- **(Q4) What the served frame does not change:** permission state (Chromium's documents and WebKit's worker read the
  host origin's grants in the served frame exactly as in `srcdoc`, so BD5:ISO-1's shape holds there), the secure-context
  bit (follows the top-level page, in both topologies), and `location.ancestorOrigins` (lists the host origin). It
  changes two rows: the base URL (the file's own URL instead of the host page's full URL) and `document.referrer` (the
  host page's **full URL with its query** by default, where `srcdoc` showed the origin; `referrerpolicy="no-referrer"`
  empties it on all three).
- **(Q5) Hosting.** A file sent with `Content-Type` alone, or with typical static-host headers, works on all three engines.
  `X-Frame-Options: DENY` and a non-HTML content type stop it. A `file://` host page loads the whole topology on all
  three, with the `<meta>` binding. Offline: the host's Service Worker never saw the frame's navigation; the HTTP cache
  served a file sent with `Cache-Control: max-age` when the server was down, on all three; without cache headers the
  offline frame is empty.
- **(Q6) No change in placement on Firefox and WebKit:** a 1200 ms loop in the served frame or its `srcdoc` child stalls
  the host timer for its whole length (1200–1211 ms), exactly as today's `srcdoc` frame; the worker does not.

## Method

- **A real server, no Playwright routing.** [`server.mjs`](server.mjs) (adapted from research 20's) records every request
  and every CSP report. A route sends exactly the headers it names, and by default only
  `Content-Type: text/html; charset=utf-8` (node adds `Date`, `Connection`, `Keep-Alive`, `Content-Length`). It is also its
  own forward proxy, so a browser launched with `proxy` reaches it as `http://app.insecure.test:P`, a host that is not
  potentially trustworthy. `localhost` and `127.0.0.1` are two sites; another port of `localhost` is same-site,
  cross-origin. It can drop every connection (`srv.down`) for the offline case.
- **The probe content** ([`probe-doc.mjs`](probe-doc.mjs)) is the same markup and script in every document: a static
  `<base>`, a style attribute and a `<style>` element, `eval`, a string to `innerHTML`, an image and a fetch to the other
  loopback origin, a fetch to the host origin (the **canary** the served file's `<meta>` refuses), a blob: worker that
  repeats the fetches and `eval`. Each document posts its results to `top`, with every `securitypolicyviolation` it saw
  and which policy raised it (by a token in the policy text: `from=host` in the host's header; the file's `<meta>`
  otherwise).
- **Controls.** Every negative has its positive: the host page's own refused fetch (event and report seen), today's
  `srcdoc` frame under the same host (the inheritance, events and reports seen), a `<meta>` that refuses every action of
  the probe (M-closed: shows the probe sees refusals inside the served topology, and that the `<meta>` binds the child and
  the worker), a non-sandboxed frame for caching, the host's own fetch reaching its Service Worker.
- **One browser run per question and engine,** under the machine's shared lock; [`run.mjs`](run.mjs) runs them and writes
  `results/<q>[-<parts>]-<engine>.txt`; [`summarize.mjs`](summarize.mjs) prints the compact view the tables were read from.

## Q1. A header-less file, its policy in a `<meta>`, under a strict host policy

Host page (`/host.html`), header:
`default-src 'none'; script-src 'nonce-…' 'report-sample'; style-src 'self' 'report-sample'; img-src 'none'; connect-src 'none'; frame-src 'self'; worker-src 'none' | blob:; base-uri 'none'; require-trusted-types-for 'script'; trusted-types host probe 'allow-duplicates'; report-uri /__report?from=host`
(`worker-src blob:` is the variant in which today's worker starts, so its own inheritance shows). The served file
`/frame.html` carries only `Content-Type`; its first element of `<head>` is the `<meta>`:
- **M-open**: `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src <other origin>; connect-src <other origin>; worker-src blob:; base-uri <other origin>; report-uri …` (admits every action but the canary);
- **M-closed**: `default-src 'none'; script-src <the two scripts' hashes>; worker-src blob:; base-uri 'none'; require-trusted-types-for 'script'; trusted-types probe` (refuses every action).

Results ([`results/q1-inherit-*.txt`](results/)): "host" means refused by the host's policy (the event's
`originalPolicy` is the host's), "meta" refused by the file's, "ran" took effect.

| Document | Chromium 145 | Firefox 146 | WebKit 26.0 |
| :--- | :--- | :--- | :--- |
| Today's `srcdoc` frame: style attr, `<style>`, `<base>`, `eval`, TT sink, image, fetch, canary | all **host** | all **host**, except TT sink ran (no Trusted Types in Firefox 146; `typeof trustedTypes` is `undefined`) | all **host** |
| Today's `srcdoc` frame's worker (host `worker-src blob:`): `eval`, fetch, canary | all **host** | all **host** | all refused (WebKit fires no `securitypolicyviolation` in a worker) |
| Today's worker, host `worker-src 'none'` | refused to start (**host**) | refused to start (**host**) | refused to start (**host**) |
| Served frame and its `srcdoc` child, M-open: the same seven actions | all **ran**; canary refused by **meta** | all **ran**; canary refused by **meta** | all **ran**; canary refused by **meta** |
| Their workers, M-open (host `worker-src 'none'` and `blob:` alike) | started; `eval`, fetch ran; canary **meta** | the same | the same (no event in the worker) |
| Served frame and child, M-closed (positive control) | all refused by **meta** (worker created only with a TT policy) | all refused by **meta**, TT sink ran | all refused by **meta** |
| Workers, M-closed | `eval`, fetch, canary refused by **meta** | the same | refused (no event) |
| Host's own refused fetch (control): event on the host page, report at its `report-uri` | yes, yes | yes, yes | yes, yes |
| Reports at the host's `report-uri` from today's frame and worker | one per refusal, `document-uri` `about` / `blob` | one per refusal | **none** (WebKit sent no report from the opaque `srcdoc` document; the host's own report arrived) |
| Reports at the host's `report-uri`, or events on the host page, from the served topology | **none** | **none** (Firefox's favicon `img-src` report is the host page's own) | **none** |
| `<meta>`'s `report-uri` | ignored (console: "ignored when delivered via a `<meta>` element"); no report | ignored; the policy text in events omits it | ignored; no report |

- **The host's policy binds nothing in the served topology,** on any engine and in any document: not the fetch
  directives, `base-uri`, `style-src` on inline styles, Trusted Types, `script-src` on `eval`, or `worker-src`. The served
  frame's `srcdoc` child and both blob: workers inherit the file's `<meta>` policy instead (M-closed refuses them; the
  canary is refused in each under M-open). This holds without any response header on the file.
- **No report of the served topology reaches the host.** The host's `report-uri` received the host's own report in every
  case and, on Chromium and Firefox, each refusal of today's frame, so a report from the served topology would have been
  seen there. On WebKit the `srcdoc` control sent no report either; there the evidence is the events, whose
  `originalPolicy` never names the host's policy in the served topology.
- **Firefox's events carry the `<meta>` policy text without the ignored `report-uri`;** Chromium's keep it. A check that
  compares texts must normalise (Q3 does).

### What the host page must admit (Q1c)

The same host header with its framing directive varied ([`results/q1-framesrc-*.txt`](results/)):

| Host policy | Chromium 145 | Firefox 146 | WebKit 26.0 |
| :--- | :--- | :--- | :--- |
| `frame-src 'self'` (control) | loads, runs | loads, runs | loads, runs |
| `child-src 'self'` only (no `frame-src`) | loads, runs | loads, runs | loads, runs |
| neither (`default-src 'none'` governs) | **not requested**; `frame-src` event on the host page, report; the iframe's `load` fires (error page) | **not requested**; event, report; **no `load` event** | **not requested**; event, report; the iframe's `load` fires |
| `frame-src 'none'`; `frame-src blob: data:` | the same as "neither" | the same as "neither" | the same as "neither" |

So a host page with a strict policy must list the file's URL (or `'self'`) in `frame-src` or `child-src`. If it does not,
the browser refuses the navigation before any request, the host page gets a `securitypolicyviolation` for `frame-src`
and a report, and the sandbox is an empty frame (Chromium and WebKit still fire `load`; Firefox does not). Today's `srcdoc` frame
needs nothing of the kind.

### What a `<meta>` does not carry (Q1b)

A file whose `<meta>` is `sandbox allow-scripts; frame-ancestors 'none'; img-src 'none'; report-uri /__report?from=meta`
([`results/q1-ignored-*.txt`](results/README.md), `q1-framesrc-ignored-webkit.txt`):

| | Chromium 145 | Firefox 146 | WebKit 26.0 |
| :--- | :--- | :--- | :--- |
| Opened top-level: origin | `http://L` (no sandbox) | `http://L` | `http://L` |
| Framed by a cross-site page without the attribute | loads (no `frame-ancestors`), origin `http://L` | the same | the same |
| `img-src 'none'` in the same `<meta>` (control: the `<meta>` is read) | image refused, event | refused, event | refused, event |
| Report at the `<meta>`'s `report-uri` | none | none | none |
| Console | "The Content Security Policy directive 'sandbox' / 'frame-ancestors' / 'report-uri' is ignored when delivered via a `<meta>` element." | "Ignoring source 'sandbox' / 'frame-ancestors' / 'report-uri' (Not supported when delivered via meta element)." | the same as Chromium, "via an HTML meta element" |

From research 11 and the rows above, for this file:
- **`sandbox`**: ignored in a `<meta>`, so the file has no sandbox of its own; it is opaque only when its embedder puts the
  attribute on the iframe. Q2 measures what the file can do about that.
- **`frame-ancestors`**: ignored, so any site can frame the file. Research 20's `frame-ancestors 'self'` is not
  available; Q2's check is what is left.
- **`report-uri` / `report-to`**: ignored, so the library's own policy reports nowhere. Each document still sees its
  refusals as `securitypolicyviolation` events (all three engines; not in WebKit's workers), as the library uses today.
- **The window before the `<meta>` applies**: a `<meta>` policy applies from the point it is parsed, and only in `<head>`
  (research 11, 11.2). When it is the first element of `<head>` and the file holds no markup but the library's own,
  nothing precedes it that could load or run; no guest markup is ever parsed into the file (the guest's content goes into
  the `srcdoc` child and the worker, which inherit the policy at creation). Inferred from research 11 and the file's
  shape; not measured separately here.

## Q2. The file opened the wrong way: can it stay inert by itself?

`/guarded.html` is sent with `Content-Type` only. Its `<head>` starts with `<meta>` `default-src 'none'; script-src
<hash of the guard>; base-uri 'none'` and holds one script, the guard, which reads `self.origin` and the other signals
and sets a verdict: `run` if the origin is opaque, else `inert`. It posts nothing and adds no listener. Playwright reads
the verdict from outside. `L` is the file's origin, `L2` another port of `localhost` (same site), `I` `127.0.0.1` (another
site). ([`results/q2-*.txt`](results/))

| Case | `self.origin` (C / F / W) | verdict | `top === window` | `ancestorOrigins` (C, W; Firefox: unsupported) | `document.referrer` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Top-level navigation | real (`http://L`) ×3 | inert | true | `[]` | `""` |
| Popup opened by a cross-site page | real ×3 | inert | true | `[]` | `http://I/` |
| Framed by `L`, no attribute | real ×3 | inert | false | `[L]` | the embedder's URL |
| Framed by `L`, `sandbox="allow-scripts allow-same-origin"` | real ×3 | inert | false | `[L]` | the embedder's URL |
| Framed by `L2` (same site), no attribute | real ×3 | inert | false | `[L2]` | `http://L2/` |
| Framed by `I` (cross-site), no attribute | real ×3 | inert | false | `[I]` | `http://I/` |
| Framed by `I`, `sandbox="allow-scripts allow-same-origin"` | real ×3 | inert | false | `[I]` | `http://I/` |
| **Framed by `L`, `sandbox="allow-scripts"` (the legitimate case)** | **opaque ×3** | **run** | false | `[L]` | the host's URL; `""` with `no-referrer` |
| **Framed by `I`, `sandbox="allow-scripts"`** | **opaque ×3** | **run** | false | `[I]` | `http://I/`; `""` with `no-referrer` |
| **Popup opened from `I`'s frame `sandbox="allow-scripts allow-popups"`** | **opaque ×3** | **run** | **true** | `[]` | `http://I/` (C: `""`) |

What a hostile embedder (`L2`, `I`, the opener) could do against the inert document, the same on all three engines:
reading `document`, `location.href`, the guard's global and `name` threw `SecurityError`; `contentDocument` was `null`;
`length` read `0`; `postMessage` was delivered to a document with no listener. Navigating the frame or the popup away is
always the embedder's to do and was not tried.

- **The check sees an opaque origin in the legitimate case and the real origin in every case where the file would run
  with the embedder's origin,** on all three engines. In those cases the document reads storage and cookies (the guard
  saw `localStorage` readable and `document.cookie` a string), which is exactly what the check keeps it from touching.
  The file's static text and the guard's code are public and run nothing else.
- **What remains exposed.** (1) The check passes for any embedder that sets `sandbox` without `allow-same-origin`,
  including a hostile site and a sandboxed popup: the library then starts for that embedder, with an opaque origin and
  the file's `<meta>`. It reaches nothing of the embedder's origin (no storage, no cookies from script); its only
  difference from the attacker shipping the library is the URL (`location.href` is the embedder's file). Its
  navigation request carries the embedder's site cookies as any cross-site frame request does. (2) The check can narrow
  this where the engine allows: `location.ancestorOrigins` on Chromium and WebKit lists the real embedder (`[I]` above),
  and a file that requires its last entry to equal its own URL's origin admits only same-origin hosts; Firefox has no
  `ancestorOrigins`, and `document.referrer` is under the embedder's control (`no-referrer` empties it). `top === window`
  separates the sandboxed popup. (3) The check must be the first statement of the first script, and the file must hold no
  other active content; a same-origin embedder without the attribute is the embedder's own origin and is not a threat
  the check addresses.
- **The new boundary this creates:** today the wrapper exists only inside the host page that built it. A served file is
  a URL that any site can frame sandboxed and drive with the library's protocol; whatever the file does on its parent's
  messages, it does for any parent that passes the check.

## Q3. A policy added from outside

The file carries a `<meta>` shaped like sealed mode's view policy (`sealedViewPolicy`: hash-only scripts,
`script-src-attr 'none'`, `style-src 'unsafe-inline' blob:`, `img-src blob:`, `connect-src 'none'`, `worker-src blob:`,
`base-uri about:`, the rest `'none'`). Its one script runs canaries the `<meta>` refuses (http and `data:` images, a
fetch, a font, a media load, a frame, an inline script, `eval`, a `<base>`) and canaries it admits (a blob: image, a style
attribute and a `<style>` element added by script, a string to `innerHTML`, a blob: worker), then counts events whose
normalised `originalPolicy` is not its own `<meta>` and admitted canaries that failed. The `srcdoc` child and the worker
repeat the fetch canary. The server adds one outside header to the file. ([`results/q3-*.txt`](results/))

| Outside header on the file | Chromium 145 | Firefox 146 | WebKit 26.0 | Reports at the site's `report-uri` (C / F / W) |
| :--- | :--- | :--- | :--- | :--- |
| none (control) | not detected, 0 foreign events | not detected | not detected | 0 / 0 / 0 |
| `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; report-uri` (enforced) | **detected**: 8 foreign events, blob: image and worker refused; binds the child | **detected** (8; same) | **detected** (7; same) | 9 / 9 / 7 |
| `default-src 'self'; report-uri` (**report-only**) | **detected** (13 foreign `report` events, child and worker included) | **detected** (13) | **detected** (13; worker: no events) | **16 / 16 / 12**, the canaries' URLs, the child's and the worker's included |
| `script-src 'self'` | the file's script never runs (no message); fails closed | the same | the same | 2 / 2 / 1 (`script-src-elem inline`) |
| `require-trusted-types-for 'script'` | **detected** (TT sink, inline script, worker refused) | not detected: no Trusted Types, the header does nothing | **detected** | 4 / 0 / 4 |
| permissive (`default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; base-uri *; report-uri`) | not detected | not detected | not detected | 0 / 0 / 0 |
| `frame-ancestors 'self'; report-uri` | not detected | not detected | not detected | 0 / 0 / 0 |
| `upgrade-insecure-requests` | not detected | not detected | not detected | – |
| `object-src 'none'; form-action 'self'; report-uri` (no canary covers them) | not detected | not detected | not detected | 0 / 0 / 0 |
| `sandbox allow-scripts allow-same-origin` (header) | not detected (the attribute's sandbox still applies: origin opaque) | not detected | not detected | – |

- **Detection works per directive, not per policy.** The document learns of an outside policy only through what that
  policy refuses: a second `securitypolicyviolation` (any disposition) whose `originalPolicy` is not its own `<meta>`, or an
  action its own policy admits that fails. No engine exposes the list of a document's policies (`originalPolicy`
  appears only on a violation). So a check can cover each fetch directive and each scheme the library uses (http(s),
  `data:`, `blob:`), `script-src`, `style-src`, `base-uri`, `worker-src`, `frame-src` and Trusted Types, by provoking them;
  an outside policy that refuses none of those is not seen.
- **What goes undetected:** directives the document cannot provoke or that refuse nothing it does
  (`frame-ancestors`, `upgrade-insecure-requests`, a header `sandbox`, `form-action`, `object-src`, and any source list
  that admits the canary's exact URL while refusing another of the same directive), and permissive policies. Those that
  never refuse anything the library does never send a report either, so they leave the document's behaviour and data as
  they are; `upgrade-insecure-requests` changes requests, which sealed mode does not make; `frame-ancestors` refuses the
  load itself, which the document never sees (the host sees an empty frame).
- **The case that matters is report-only.** A report-only outside policy refuses nothing and reports everything it would
  have refused, from the file, its `srcdoc` child and its worker, with the URLs, to the site's endpoint: the
  `cspReporting` row of `INHERITED_CONTEXT` returns through the server instead of through the host page. It is
  detectable (its events fire with `disposition: "report"` in the document and the child; not in WebKit's worker), so a
  file can stop on it, but only after the canaries' own reports were sent; the canaries must carry nothing of the guest.
- **Engine differences:** WebKit raised no event for `eval` refused by the `<meta>` and none in workers; Firefox has no
  Trusted Types. A detector's list of canaries is per engine.

## Q4. What the served frame still takes from the host page

Host page without a policy; today's `srcdoc` frame and the served frame side by side in the same page, each with its
worker; the served frame's `srcdoc` child too. ([`results/q4-*.txt`](results/); Chromium's referrer rows from
[`q4-referrer-chromium.txt`](results/q4-referrer-chromium.txt): the referrer part of `q4-chromium.txt` reused the page across a fragment-only navigation, so its second case also lists the first case's frames.)

| Row | Engine | Today's `srcdoc` frame (document / worker) | Served frame (document / worker); its `srcdoc` child |
| :--- | :--- | :--- | :--- |
| `isSecureContext`, host at `http://localhost` | C | true / false | true / false; child true |
| | F | true / true | true / true; child true |
| | W | true / true | true / true; child true |
| `isSecureContext`, host at `http://app.insecure.test` | C | false / false | false / false; child false |
| | F | false / false | false / false; child false |
| | W | false / false | false / false; child false |
| `permissions.query`, no grants (geolocation, notifications, camera, microphone) | C | denied, prompt, denied, denied / prompt ×4 | the same |
| | F | denied ×4 / denied ×4 | the same |
| | W | denied, prompt, denied, denied / prompt ×4 | the same |
| `permissions.query`, host origin granted geolocation and notifications | C | **granted, granted**, denied, denied / prompt ×4 | **the same: the document reads the host's grants** |
| | F | denied ×4 / denied ×4 | the same |
| | W | denied, **granted**, denied, denied / **granted, granted**, denied, denied | **the same: the worker reads the host's grants (BD5:ISO-1's shape)** |
| `crossOriginIsolated`, COOP + COEP `require-corp` host | C | false (Chromium needs `allow`) | **the file is refused** (`ERR_BLOCKED_BY_RESPONSE`): a header-less file cannot load under a COEP host |
| | F | true / true | **refused** |
| | W | true / worker blocked by COEP | **refused** ("Load request cancelled") |
| `document.referrer`, default | C | `http://L/` (origin) | **`http://L/app/secret?token=HOSTSECRET`** (full URL, query included); child `""` |
| | F | `""` | **the full URL**; child the full URL |
| | W | `http://L/` | **the full URL**; child `http://L/` |
| `document.referrer`, iframe `referrerpolicy="no-referrer"` | C F W | `""` | `""`; child `""`; the frame request carries no `Referer` |
| `Referer` of the file's request, default | C F W | – | `http://L/app/secret?token=HOSTSECRET` |
| `baseURI` (no `<base>`) | C F W | **`http://L/app/secret?token=HOSTSECRET#frag`** | `http://L/frame.html`; child the same |
| `location.ancestorOrigins` | C W | `[L]` | `[L]`; child `["null", L]` |
| | F | unsupported | unsupported |

- **Permissions do not follow the policy container.** The state an engine answers with is keyed to the top-level origin,
  so serving the frame changes nothing: Chromium's documents and WebKit's worker read the host origin's grants in the
  served topology exactly as in `srcdoc`. Sealed mode's construct for this row (no permission API in the worker) stays
  needed; D8 does not replace it.
- **Secure context follows the top-level page in both topologies** (Chromium's worker is never secure); the served file
  is same-origin with the host page, so it cannot be "more secure" than its host either.
- **COEP**: a header-less file cannot be framed by a cross-origin-isolated host on any engine (research 20 Q2 needed COEP,
  and CORP on Firefox, on the file). The library refuses isolated hosts today, so this costs nothing now, and closes the
  option of lifting that refusal without headers.
- **Two rows change, one for the better, one not:** the base URL no longer carries the host page's URL (closed by the
  served file), and the referrer carries more by default (the host page's full URL with its query, where `srcdoc` gave
  the origin or nothing). `referrerpolicy="no-referrer"`, which the library sets on its wrapper today, empties both the
  header and `document.referrer` on all three.

## Q5. Hosting facts

**(a) Header sets.** The served file of Q1 (M-open) sent with each set; "runs" means the frame, its `srcdoc` child and
both workers reported, with the `<meta>`'s canary refused in each. ([`results/q5-headers-chromium.txt`](results/q5-headers-chromium.txt),
[`q5-firefox.txt`](results/q5-firefox.txt), [`q5-webkit.txt`](results/q5-webkit.txt); each case under a URL of its own.)

| Headers on the file | Chromium 145 | Firefox 146 | WebKit 26.0 |
| :--- | :--- | :--- | :--- |
| `Content-Type` only | runs | runs | runs |
| typical static host, no CSP (`Cache-Control: max-age=600`, `ETag`, `Last-Modified`, `Access-Control-Allow-Origin: *`, `Vary`, `Server`, `Accept-Ranges`) | runs | runs | runs |
| the same + `X-Content-Type-Options: nosniff` | runs | runs | runs |
| `X-Frame-Options: SAMEORIGIN` (the host is same-origin) | runs | runs | runs |
| `X-Frame-Options: DENY` | **refused** (empty frame; `load` fires) | **refused** | **refused** |
| `Content-Type: text/plain` | **does not run** (shown as text) | does not run | does not run |

Chromium's first run (`q5-chromium.txt`, headers part) used one URL for every case, so the cached `max-age=600` response
of the second case answered the later ones and `DENY` appeared to load; that part is superseded by
`q5-headers-chromium.txt`, where each case has a URL of its own, as in the Firefox and WebKit runs.

**(b) `file://`.** Host page and file written to a temporary directory; the host opened at `file:///…/host.html`.

| | Chromium 145 | Firefox 146 | WebKit 26.0 |
| :--- | :--- | :--- | :--- |
| Host page origin, `isSecureContext` | `null`, true | `null`, true | `null`, true |
| Served frame (`sandbox`, `src="frame.html"`), its child, workers | run; `<meta>` binds (canary refused) | run; binds | run; binds |
| Today's `srcdoc` frame (control) | runs | runs | runs |

The topology loads from a `file:` host page on all three engines, with the `<meta>` policy binding the frame, the child
and the workers. (The probe's fetches went to the loopback server; a real `file:` app has no server.)

**(c) Offline.** The file sent with `Cache-Control: max-age=3600` and an `ETag`; frames made in one host page.

| | Chromium 145 | Firefox 146 | WebKit 26.0 |
| :--- | :--- | :--- | :--- |
| Second sandboxed frame, server up: request made? | no (HTTP cache) | no | no |
| Third sandboxed frame, server down: runs? | **yes, from the HTTP cache** | **yes** | **yes** |
| Non-sandboxed frame, same steps (control) | the same | the same | the same |
| Host's cache-first Service Worker: fetch event for the sandboxed frame's navigation | **none** (host's own fetch: seen) | none (seen) | none (seen) |
| Server down, host page reloaded (served by its SW), sandboxed frame of a file sent without cache headers | empty frame (`load` fires, nothing runs) | empty, no `load` | empty, no `load` |

The host's Service Worker never serves the frame (research 20 Q1, confirmed with a header-less file); the HTTP cache does,
when the file carries freshness headers. A host that cannot set `Cache-Control` depends on its server's defaults (GitHub
Pages sends `max-age=600`; not probed here) for offline use.

## Q6. Thread placement on Firefox and WebKit

One host page holds today's `srcdoc` frame, the served frame (with its `srcdoc` child and worker), and a non-sandboxed
cross-site and same-origin frame; the host runs a 10 ms interval for 2000 ms while the named target busy-loops for
1200 ms; the host's longest gap, median of 5 (range); 1-minute load average 0.3–1.2 throughout
([`results/q6-*.txt`](results/)).

| Busy target | Firefox 146 | WebKit 26.0 |
| :--- | ---: | ---: |
| none (idle) | 12 (12–17) | 14 (13–19) |
| today's `srcdoc` frame | 1201 (1199–1205) | 1210 (1201–1211) |
| served frame | 1201 (1200–1201) | 1210 (1206–1211) |
| served frame's `srcdoc` child | 1201 (1200–1203) | 1211 (1210–1211) |
| served frame's blob: worker | 15 (12–24) | 14 (13–14) |
| cross-site frame, no sandbox (control) | 1201 (1201–1202) | 1210 (1209–1211) |
| same-origin frame, no sandbox (control) | 1200 (1198–1208) | 1208 (1200–1210) |

On both builds every frame, the cross-site control included, runs on the host page's thread; serving the frame changes
nothing. **What these builds do not represent:** Playwright's Firefox runs with site isolation (Fission) off, so the
cross-site control shares the thread here and would not in a shipping Firefox; whether a shipping Firefox puts a
sandboxed same-site frame in another process was not measured ([research 16](../16_view_isolation/README.md)). WebKit on
Linux is not Safari. Chromium is research 20 Q4.

## What this means for the decision

Facts, as measured on the three engines named above; no recommendation.

| | Holds? | Chromium 145 | Firefox 146 | WebKit 26.0 |
| :--- | :--- | :--- | :--- | :--- |
| **(i)** a header-less static file is enough for the policy to be the library's own | **yes**, for every directive a `<meta>` carries | host policy binds nothing in frame, child, workers; `<meta>` binds all | the same | the same |
| | but not `sandbox`, `frame-ancestors`, `report-uri` | ignored in `<meta>` | ignored | ignored |
| **(ii)** the file can make itself safe without a `sandbox` header | **partly**: inert whenever it would have the embedder's origin; not able to refuse a hostile embedder that sandboxes it | origin check exact in 12 cases; `ancestorOrigins` names the embedder | origin check exact; **no `ancestorOrigins`**, embedder unknown | as Chromium |
| **(iii)** an outside policy can be detected | **partly**: every one that refuses something the file provokes, enforced or report-only; not those that refuse nothing it can provoke | 8 of 10 headers' effects seen or failing closed | TT header has no effect (no TT) | as Chromium (no events for `eval` or in workers) |
| **(iv)** what stays inherited either way | permission state, secure context, `ancestorOrigins`, thread; referrer (more, by default) | documents read host grants | nothing (denied) | **worker reads host grants** |
| **(v)** hosts that cannot use it | a host CSP without `frame-src`/`child-src` for the file; `X-Frame-Options: DENY`; a non-HTML content type; any COEP host | refused, empty frame | refused | refused |

- **(i) holds by construction.** The served document starts a policy container of its own whether or not the server sends
  a header; the `<meta>` is the whole policy, and the host page's policy no longer reaches the frame, its child or its
  workers. What a `<meta>` cannot carry is the file's own `sandbox`, `frame-ancestors` and reporting.
- **(ii)** The file's origin check makes every wrong-way opening that would give it the embedder's origin inert, on all
  three engines, with nothing but the file. It does not make the file refuse other embedders: any site can frame it with
  `sandbox="allow-scripts"` and the check passes. What such an embedder gets is the library running under an opaque
  origin; where it matters, `ancestorOrigins` (Chromium, WebKit) can limit the file to same-origin embedders, and Firefox
  offers nothing equivalent.
- **(iii)** An outside policy is visible only through what it refuses. The file can provoke each directive and scheme
  the library uses and stop when another policy answers; an enforced site policy that blocks inline scripts stops the file
  by itself; a report-only policy is detectable but only after it has received the canaries' reports, and while it is
  undetected it receives every refused URL of the frame, its child and its worker.
- **(iv)** Not closed by the served document: the permission state of the host origin (BD5:ISO-1's shape: WebKit's worker
  and Chromium's documents), the secure-context bit, `location.ancestorOrigins`, the host's thread on Firefox and WebKit,
  and the referrer, which the served frame gets in full unless `referrerpolicy="no-referrer"`.
- **(v)** Hosts that cannot use it: a host page whose own CSP does not admit the file in `frame-src`/`child-src` (an
  empty frame and a host-side violation, not a degraded sandbox); a server that sends `X-Frame-Options: DENY` or serves
  `.html` as anything but HTML; a cross-origin-isolated host (the file needs COEP, which a `<meta>` cannot send); a page
  that cannot place a file next to itself (a host that serves only one document, a CMS embed). `file://` and a server that
  sends no headers at all both work. Offline needs the file to be HTTP-cacheable; the host's Service Worker cannot help.

**The new boundaries the served design creates,** each measured above: a public URL any site can frame and drive (Q2);
a server whose site-wide headers now apply to the library's document, including a reporting endpoint (Q3); a framing
requirement on the host's own policy (Q1c); and a referrer that carries the host page's full URL by default (Q4).

## Not measured

- Safari on macOS and iOS, Firefox with Fission, Chromium with site isolation (research 20 Q4 has it), Android.
- A real static host (GitHub Pages, Netlify): its header sets were imitated, not fetched (no network).
- `file://` beyond loading: a `file:` app with no server (the probe's fetches went to loopback); Firefox's
  `security.fileuri.strict_origin_policy` variants.
- The library itself in this topology (no code was built), and a detector run before the view and worker start.
- The window before the `<meta>` applies (inferred from research 11 and the file's shape, not provoked).
- Navigation of a wrong-way-opened file by its embedder, and `document.domain` relaxation (the inert file never sets it).
- Cache partitioning across top-level sites for the offline case (one site only).

## Rerun

From the repository root, with Playwright's browsers installed (`PLAYWRIGHT_BROWSERS_PATH`):

```
bun docs/research/27_served_document_headerless/run.mjs                      # everything, one run per question and engine
bun docs/research/27_served_document_headerless/run.mjs q3 firefox           # one question, one engine
bun docs/research/27_served_document_headerless/run.mjs q1 framesrc webkit   # one part
WEB_SANDBOX_LOCK=/path/to/lock bun docs/research/27_served_document_headerless/run.mjs   # each run under flock(1)
bun docs/research/27_served_document_headerless/summarize.mjs q1             # the compact view of results/
```

The scripts are `.mjs`, not `*.spec.ts`, so the repository's Playwright configuration does not run them with the suite.
