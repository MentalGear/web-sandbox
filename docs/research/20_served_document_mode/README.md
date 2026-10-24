# Research 20: a served-document mode, probed before building

**Question (owner, S74 class review).** Every sandbox document is a `srcdoc` frame, so each inherits the host page's policy
container: its CSP (`base-uri` and `img-src` included) and Trusted Types. The candidate hardening is an opt-in
**served-document mode**: the library ships one static file, `frame.html`, that the host serves with its own response
headers, and the wrapper, view and fetch-bridge frames are that document, the role picked by the host's first message. A
network-fetched document starts a fresh policy container, and its `srcdoc` children inherit the served document's
policy, not the host's. The header proposed for it:

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'sha256-<frame bootstrap>';
                         frame-src 'none'; base-uri 'self'; frame-ancestors 'self'
```

`sandbox` makes the document opaque even when an attacker frames it without the attribute; `frame-ancestors` is meant to
stop cross-site framing; the guests stay `srcdoc` children. Four things were open before deciding whether to build it,
and this note measures them on all three engines: the host's Service Worker (Q1), a COEP host (Q2), `frame-ancestors`
with sandboxed ancestors (Q3) and Chromium's process grouping (Q4). Side measurements (what the served frame sees and
inherits) close the note.

**Measured on headless Playwright 1.58.1 on a 4-core VM** (Chromium 145.0.7632.6 as the headless shell and as the full build with `channel: 'chromium'`, Firefox 146.0.1, WebKit 26.0), 2026-10-23, from `aa7bcaf`. The numbers are this
machine's. The decisions rest on their shapes. The probes use no library code: they build the proposed topology (a host
page, an iframe with `sandbox="allow-scripts"` that loads a same-origin `frame.html`, a `srcdoc` child in it) with plain
HTML, served by a real HTTP server on `localhost`.

## Answer in brief

- **Service Worker (Q1): out of reach on all three engines.** A host page's controlling SW saw no fetch event for the
  navigation of a `sandbox`-attribute iframe to a same-origin URL, for the served frame's own `fetch`, script and image
  requests, or for its `srcdoc` child's. The network answered each. The positive controls (the host's own `fetch`, a
  non-sandboxed same-origin iframe and its subresources) were answered by the SW on all three. One exception: when the
  iframe has no `sandbox` attribute and only the response says `sandbox`, the SW sees the navigation on all three and can
  answer it with a document that has no sandbox. The attribute, not the header, keeps the SW out.
- **COEP (Q2): the frame is refused unless `frame.html` sends COEP, plus CORP `cross-origin` in Firefox.** Chromium needs
  COEP only; WebKit needs `require-corp` only (a `credentialless` frame is refused, and WebKit ignores a `credentialless`
  host). Isolation of the served frame and its child follows the engine as for `srcdoc` today: Firefox and WebKit
  isolate with no attribute, Chromium only with `allow="cross-origin-isolated"` on each iframe in the chain.
  `SharedArrayBuffer` constructs exactly where the document is isolated.
- **`frame-ancestors 'self'` (Q3): allowed for a normal host, refused cross-site, and refused behind any opaque
  ancestor.** All three engines agree. A sandboxed ancestor of any kind (the iframe attribute, a `sandbox` header,
  `srcdoc`, `data:`, `blob:`, a sandboxed host page) makes `'self'` fail, so the served frame cannot sit inside another
  served frame and a host that is itself sandboxed cannot use it. No source list fixes that in Chromium and WebKit
  without admitting cross-site framing. The refused document sends a CSP report to `report-uri` on all three.
- **Processes (Q4): no change.** The served frame, its `srcdoc` child and today's `srcdoc` frame are in the same renderer in
  every configuration. That is the host's own where site isolation or `IsolateSandboxedIframes` is off (the headless shell's
  default), where a busy loop in either kind delays a host timer for its whole length (1200 ms of 1200); and one other
  renderer, shared by all of a host's sandboxes, in desktop Chromium and with `--site-per-process`, where the host timer is
  not delayed.
- **Side measurements:** the served frame's `baseURI`, `origin`, `referrer` and `ancestorOrigins` are in
  [the table below](#side-measurements-what-the-served-frame-sees-and-inherits); the host's `base-uri 'none'` and
  `img-src 'none'` bind today's `srcdoc` frame and do not bind the served frame or its child, on all three engines.
  The served header is a ceiling its `srcdoc` children inherit: The proposal's hash-only `script-src` stops a child's inline script.
- **Verdict for the owner:** nothing measured blocks the mode, and nothing measured gives it an availability gain. Its
  value stays what the proposal states (the host CSP no longer narrows the sandbox). Six amendments to the proposal are in
  [What it means for the mode](#what-it-means-for-the-mode).

## Method

- **A real server, no Playwright routing.** [`server.mjs`](server.mjs) is a `node:http` server on loopback that records
  every request and every CSP report. `http://localhost:PORT` and `http://127.0.0.1:PORT` reach the same process and are
  two origins (two sites), which makes the cross-origin cases. `localhost` is a secure context, so a Service Worker can
  register. `page.route` and `context.route` are never used: they stop Service Worker registration on Firefox and WebKit.
- **Topology.** Host page → `iframe[sandbox="allow-scripts"]` with `src=/frame.html` (the `sandbox` header on the response is
  a second layer) → `srcdoc` child with `sandbox="allow-scripts"`. A document reports to `top` with `postMessage`, so no
  frame needs to be reached from outside.
- **One script per question,** each runnable alone and each printing one tagged JSON line per result (`q1.scenario`,
  `q2.served`, ...). [`run.mjs`](run.mjs) runs them in sequence and writes [`results/`](results/), which holds the output
  behind every number below.
- **Q4 is Chromium only and timing-sensitive.** It runs alone, waits while the 1-minute load average is above 6, repeats
  each case 5 times and reports the median and the range.

Run from the repository root (the probes use the repository's `playwright` and need no other server or build):

```
bun docs/research/20_served_document_mode/run.mjs                 # everything, about 30 minutes
bun docs/research/20_served_document_mode/run.mjs q3 firefox      # one question on one engine
bun docs/research/20_served_document_mode/q4-processes.mjs desktop 5
```

## Q1. The host page's Service Worker

The host page registers `/sw.js` (scope `/`) and is controlled by it. The SW answers `/nav-*.html`, `/sub.json`,
`/sub.js` and `/img.svg` itself (a different body from the network's, so "who answered" is visible) and relays
`/frame*.html` to the network unchanged. It reports every fetch event it receives to the host page. An empty event list
means the request never reached it.

- **Controls** (the SW is live and can intercept this kind of request): the host page's own `fetch`; a non-sandboxed
  same-origin iframe navigating to `/nav-target.html`; the same iframe's fetch, script and image requests.
- **(a)** an iframe with `sandbox="allow-scripts"` navigating to a same-origin URL; and the header-only variant: no
  `sandbox` attribute, the response sends `Content-Security-Policy: sandbox allow-scripts`.
- **(b)** the sandboxed served frame's own `fetch`, `<script src>` and `new Image()` of same-origin URLs the SW answers.
- **(c)** the same three from the frame's `srcdoc` child, and from today's `srcdoc` frame in the host page.

| | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| Registers on a real localhost server under Playwright | yes | yes | yes |
| Host page controlled | yes (`clients.claim()`), and after a reload | only the page that registered, by `clients.claim()`; not after a reload (see below) | yes, and after a reload |
| Controls: host `fetch`; non-sandboxed same-origin iframe navigation; its subresources | `SW`; `SW`; `SW` | `SW`; `SW`; `SW` | `SW`; `SW`; `SW` |
| **(a)** navigation of `sandbox`-attribute iframe to same-origin `/nav-target.html` | **network**, no fetch event | **network**, no fetch event | **network**, no fetch event |
| **(a)** with the library's wrapper attributes (`sandbox`, `credentialless`, `referrerpolicy="no-referrer"`), navigation and the frame's subresources | **network**, no events | **network**, no events (`credentialless` is ignored) | **network**, no events (ignored) |
| **(a)** header-only sandbox (no attribute) | fetch event fires, **SW substituted the document**, which then had no sandbox: origin `http://localhost:PORT` | same | same |
| **(b)** the sandboxed served frame's `fetch`, script, image (attribute variant) | **network** ×3, no events | **network** ×3, no events | **network** ×3, no events |
| **(b)** the same, header-only variant (SW relays the navigation) | network ×3, navigation event only | network ×3, navigation event only | network ×3, navigation event only |
| **(c)** `fetch`, script, image from the served frame's `srcdoc` child | **network** ×3, no events | **network** ×3, no events | **network** ×3, no events |
| Today's `srcdoc` frame in the (controlled) host page, same three | network ×3, no events | network ×3, no events | network ×3, no events |
| `navigator.serviceWorker` inside the opaque frame | throws `SecurityError` | object present, `controller` false | throws `SecurityError` |

- **A sandboxed frame is out of the host SW's reach on all three engines**, for its navigation (when the iframe element
  carries `sandbox`), its subresources and its `srcdoc` children's. The SW spec's opaque-origin rule holds, and Firefox
  and WebKit agree with Chromium.
- **The attribute carries this, not the header.** When only the response says `sandbox` (the iframe element has no
  attribute), the navigation is made before the browser has read the header, so the SW sees it, and a SW that answers
  with a document without the header gets an unsandboxed same-origin document with full access to the host. The mode
  must keep the iframe attribute and treat the header as the second layer for an attacker's frame.
- **Registration needed a real server.** Under Playwright's request routing (`page.route` / `context.route`)
  registration did not work on Firefox and WebKit; against `node:http` on `http://localhost:PORT` it works on all three.
- **Firefox under Playwright** controls the page that registered (`clients.claim()`) but not a page loaded
  afterwards: a reload, `page.goto`, a clicked link and `location.href=` all gave `controller === null` and `network`
  answers, with a registration present. The probe therefore does not reload there. Cause not determined (Playwright's
  Juggler navigation or Firefox; not tried outside Playwright, where this build is not available). Also in Firefox, a
  navigation the SW saw but did not answer with `respondWith` left the document's subresources un-intercepted
  (`controller === true`, requests went to the network), so the controls are only valid when the SW relays the navigation
  (`respondWith(fetch(request))`), which `/frame*.html` do.
- **Cost for an offline PWA:** the served frame document never comes from the host SW's cache on any engine (in the
  attribute variant); only the HTTP cache serves it.

## Q2. COOP + COEP host

The host page is served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy:
require-corp` (and separately `credentialless`). `frame.html` is sent with `Content-Security-Policy: sandbox
allow-scripts` plus a variant of COEP and CORP headers. The iframe has `sandbox="allow-scripts"` with and without
`allow="cross-origin-isolated"`; the served frame embeds two `srcdoc` children (`sandbox="allow-scripts"`), one with and one
without that `allow`. Every document reports `crossOriginIsolated`, `typeof SharedArrayBuffer`, and the result of
`new SharedArrayBuffer(8)`.

| Engine, host COEP | `frame.html` must send | Served frame, iframe without / with `allow="cross-origin-isolated"` | Its `srcdoc` child | Today's `srcdoc` frame, same hosts |
| :--- | :--- | :--- | :--- | :--- |
| Chromium, `require-corp` | `Cross-Origin-Embedder-Policy` (either value). CORP is not needed; CORP alone is refused (`ERR_BLOCKED_BY_RESPONSE`) | not isolated / **isolated**, `SharedArrayBuffer` constructs | isolated only if its own iframe also has the `allow` (with: yes; without: no) | isolated only with the `allow` |
| Chromium, `credentialless` | the same | the same | the same | the same |
| Firefox, `require-corp` | COEP (either value) **and** `Cross-Origin-Resource-Policy: cross-origin`. COEP alone is refused ("blocked due to its Cross-Origin-Resource-Policy header (or lack thereof)") | **isolated** either way (the permission-policy name is unknown to Firefox; it only warns) | isolated, SAB ok | isolated, no attribute |
| Firefox, `credentialless` | the same | the same | the same | the same |
| WebKit, `require-corp` | COEP `require-corp`. CORP is not needed; CORP alone, and a `credentialless` frame, are refused ("Refused to display ... because of Cross-Origin-Embedder-Policy") | **isolated** either way | isolated, SAB ok | isolated, no attribute |
| WebKit, `credentialless` | nothing: the engine ignores the header, the host is not isolated (`crossOriginIsolated` false), and the frame loads without headers | not isolated | not isolated, `SharedArrayBuffer` undefined | not isolated |
| All three, no COEP on the host (control) | nothing | not isolated | not isolated, `SharedArrayBuffer` undefined | not isolated |

- **A frame without the right headers is refused, not degraded.** Under a COEP host the unadorned `frame.html` never
  loads on any engine (Chromium and WebKit fire the iframe's `load` event on an error page, Firefox fires none; Playwright's
  `requestfailed` reports the block), so a host that turns COEP on and forgets the static file's headers sees an empty
  sandbox. The library currently refuses an
  isolated host; with this mode the refusal would move from the element to the header.
- **The isolation the guest gets follows the engine, as it does today.** In Firefox and WebKit a `srcdoc` guest under a
  COEP host is already `crossOriginIsolated` with `SharedArrayBuffer`, and so is the served one; in Chromium both need
  `allow="cross-origin-isolated"` on each iframe in the chain. Serving the frame does not add or remove guest capability
  here; it adds a requirement on the file's headers.
- **WebKit:** `credentialless` is not implemented, so a `credentialless` host is not isolated and the question does not
  arise; a `credentialless` frame under a `require-corp` host is refused.

## Q3. `frame-ancestors 'self'` with sandboxed ancestors

`frame.html` is sent with `Content-Security-Policy: sandbox allow-scripts; frame-ancestors 'self'; report-uri
/__report`. `http://localhost:PORT` is the host origin; `http://127.0.0.1:PORT` is another origin (and site) served by
the same process. A scenario is "allowed" when the document ran and posted to `top`.

| # | Embedding chain (outermost first) | Ancestor opaque? |
| :-- | :--- | :--- |
| S1 | host → `iframe[sandbox]` `frame.html` | no |
| S2 | host → `iframe` (no attribute; the header makes it opaque) `frame.html` | no |
| S3 | host → `iframe[sandbox]` same-origin `embedder.html` → `frame.html` | yes, URL is same-origin |
| S4 | host → `iframe[sandbox][srcdoc]` → `frame.html` | yes, `about:srcdoc` |
| S5 | host → `iframe[sandbox]` `data:` → `frame.html` | yes |
| S6 | host → `iframe[sandbox]` `blob:` → `frame.html` | yes |
| S7 | host → `iframe[sandbox]` `frame.html` → `frame.html` (a served frame in a served frame) | yes, the outer served frame |
| S8 | host → `iframe` `embedder-sb.html` (opaque by its own `sandbox` header) → `frame.html` | yes |
| T1 | a host page that is itself opaque (served with `sandbox allow-scripts`) → `iframe[sandbox]` `frame.html` | the top-level page |
| S9 | host (localhost) → `embedder.html` on 127.0.0.1 → `frame.html` on localhost | no, cross-site middle |
| S10, X1, X2 | a page on one origin framing `frame.html` on the other (X1 with the `sandbox` attribute, X2 without) | no, cross-site |

Outcomes with `frame-ancestors 'self'` (identical on the three engines unless a cell says otherwise):

| Engine | S1, S2 (and S1L: the library's `credentialless` + `referrerpolicy` attributes) | S3, S4, S5, S6, S8, T1 (an opaque ancestor) | S7 (served frame in served frame) | S9, S10, X1, X2 (cross-site) | Violation report (`report-uri`) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Chromium | allowed, origin `null`, `ancestorOrigins` = `[host origin]` | **refused** (`ERR_BLOCKED_BY_RESPONSE`) | outer allowed, **inner refused** | **refused** | `blocked-uri` = the frame's origin, `violated-directive` = `frame-ancestors 'self'`, `disposition` = `enforce`; **none arrived for X2** (cross-site, no `sandbox` attribute) in every run |
| Firefox | allowed, origin `null`, `ancestorOrigins` unsupported | **refused** | outer allowed, **inner refused** | **refused** | `blocked-uri` empty, `document-uri` = the frame's full URL |
| WebKit | allowed, origin `null`, `ancestorOrigins` = `[host origin]` | **refused** | outer allowed, **inner refused** | **refused** | `blocked-uri` and `document-uri` = the frame's full URL |

- **Every opaque ancestor is refused, whatever its URL.** S3 is a same-origin `embedder.html`, sandboxed by the
  iframe attribute; S8 is sandboxed by its own header; S4, S5 and S6 are `srcdoc`, `data:` and `blob:`; T1 is a host
  page that is itself sandboxed. The comparison is made on the ancestor's origin, which is opaque, and `'self'` does not
  match it, so a host that runs inside a sandboxed frame (a playground, an embedding page, a preview pane) cannot use a
  `frame-ancestors 'self'` document, and the served frame cannot contain another served frame (S7's inner one).
- **No source list admits an opaque ancestor and refuses another site in Chromium and WebKit.** Table below. An explicit
  origin (`http://localhost:PORT`) and a bare `host:port` behave like `'self'`. `*` admits cross-site and still refuses
  the opaque ancestors in Chromium and WebKit; in Firefox `*` admits everything. In Chromium and WebKit only dropping
  `frame-ancestors` admits an opaque ancestor, and then cross-site framing is admitted too, with the `sandbox` header the
  only protection.
- **The report is a CSP report, sent by the refused document.** All three engines delivered it to the same-origin
  `report-uri`; the field values differ per engine as the table shows.

Source lists tried for `frame-ancestors` (one probe run per list; cells are the three engines' outcomes, C / F / W):

| List | S1 | S3 to S6 (opaque ancestor) | S7 inner (served in served) | S9, S10, X1 (cross-site) |
| :--- | :--- | :--- | :--- | :--- |
| `'self'` | allowed | refused (C F W) | refused (C F W) | refused (C F W) |
| `http://localhost:PORT` | allowed | refused (C F W) | refused (C F W) | refused (C F W) |
| `localhost:PORT` | allowed | refused (C F W) | refused (C F W) | refused (C F W) |
| `*` | allowed | refused (C, W), **allowed (F)** | refused (C, W), allowed (F) | **allowed** (C F W) |
| (none; `sandbox` alone) | allowed | allowed | allowed | allowed |

## Q4. Chromium: process grouping and the host timer

One host page with nine sandboxed documents at once (three `srcdoc` frames and three served frames, each served frame
with a `srcdoc` child; the third pair carries the attributes the library puts on its wrapper, `credentialless` and
`referrerpolicy="no-referrer"`), and a non-sandboxed same-origin frame as the control. The renderer of each frame is
the one whose CPU time (CDP `SystemInfo.getProcessInfo`) rises while that frame loops for 900 ms. CDP
`Target.getTargets` lists the frames that are out of process. The table gives the host timer's longest gap (ms, 10 ms
interval, 2000 ms window) while the named frame loops for 1200 ms: median over 5 runs, range in brackets. 1200 means the
loop stalled the host for its whole length. The two builds are Playwright's headless shell (`chromium`) and the full
build (`channel: 'chromium'`, new headless), both 145.0.7632.6. Each flag set is appended to Playwright's own arguments
(`q4-processes.mjs` lists them); the machine's load average stayed below 0.7 during the run.

| Build, flags | Sandboxed frames' renderer | Idle | `srcdoc` frame (today) | Served frame | Served frame's `srcdoc` child | Non-sandboxed same-origin (control) | `srcdoc` + library attributes | Served child + library attributes |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Shell, default | the host's (1 renderer) | 11 (10–12) | **1200** (1200–1201) | **1201** (1200–1201) | **1201** (1201–1201) | 1201 | **1200** | **1201** |
| Shell, `IsolateSandboxedIframes` off | the host's | 11 (10–22) | 1201 | 1200 | 1201 | 1201 | 1201 | 1201 |
| Shell, site isolation off | the host's | 11 (10–12) | 1200 | 1201 | 1201 | 1200 | 1201 | 1201 |
| Shell, `--site-per-process` | **another** (3 renderers) | 11 (10–14) | 30 (11–75) | 11 (10–43) | 12 (11–29) | 1201 | 11 (10–15) | 10 (10–14) |
| Desktop, default | **another** (3 renderers) | 11 (10–15) | 12 (11–477) | 11 (10–54) | 11 (11–11) | 1201 | 10 (10–12) | 11 (10–72) |
| Desktop, `IsolateSandboxedIframes` off | the host's (2 renderers, no out-of-process frame) | 12 (10–60) | 1201 | 1201 | 1201 | 1201 | 1201 | 1201 |
| Desktop, site isolation off | the host's (1 renderer) | 11 (11–37) | 1201 | 1201 | 1201 | 1201 | 1201 | 1201 |
| Desktop, `--site-per-process` | **another** (3 renderers) | 12 (11–25) | 10 (10–14) | 10 (10–14) | 11 (10–17) | 1201 | 10 (10–10) | 11 (10–74) |

- **The served frame is in the same renderer as the `srcdoc` frame in every configuration.** So is its `srcdoc` child, and
  so are the frames with the library's attributes. Where sandboxed frames are out of process (desktop default,
  `--site-per-process` in either build) all nine share one renderer that is not the host's; where they are not (the shell's default
  and every flag set that turns site isolation or `IsolateSandboxedIframes` off), all nine are in the host's. The
  non-sandboxed same-origin control is in the host's renderer in every configuration.
- **A busy loop in the served frame's `srcdoc` child delays the host timer exactly as much as one in today's `srcdoc`
  frame:** 1200 ms where they share the host's renderer, and 10–30 ms (medians) where they do not. Of the 75 runs with a loop in a
  separate renderer (three configurations, five frame cases, five runs), one showed a gap above 75 ms (477 ms, desktop
  default, `srcdoc` frame); the other 74 stayed at or below 75 ms, so a loop in a separate renderer never stalled the host for its length.
- **The shell does not isolate sandboxed frames by default; `--site-per-process` makes it.** This is the only difference
  between the shell and the full build here (research 16's table says the same for the view).
- **One renderer for all of a host's sandboxes.** The first and second `srcdoc` frames, the first and second served
  frames and their children report the same renderer, so a loop in one sandbox stalls the others (same site). That
  is today's grouping and the served mode does not change it.
- **Not measured:** the same timer on Firefox and WebKit (research 16 puts a sandboxed `srcdoc` frame on the host
  page's thread in both; whether a served sandboxed frame is placed differently there was not probed).

## Side measurements: what the served frame sees and inherits

The host page is `http://localhost:PORT/app/secret-path?token=HOSTSECRET#frag` with `Content-Security-Policy:
default-src 'self' 'unsafe-inline' data: blob:; img-src 'none'; base-uri 'none'`. Every frame is
`sandbox="allow-scripts"`, carries `<base href="about:blank">`, and requests an image from `http://127.0.0.1:PORT`. The
served frame is sent with one of four headers:
- **V1** `sandbox allow-scripts; frame-ancestors 'self'` (no fetch directives);
- **V2** the proposal above, literally: `sandbox allow-scripts; default-src 'none'; script-src 'sha256-<frame bootstrap>';
  frame-src 'none'; base-uri 'self'; frame-ancestors 'self'`;
- **V3** V2 with the child's script hash added to `script-src`;
- **V4** `sandbox allow-scripts; script-src <both hashes>; img-src <the image origin>; base-uri about:; frame-ancestors 'self'`.

| Engine | Today's `srcdoc` frame | Served frame (V1), and its `srcdoc` child |
| :--- | :--- | :--- |
| Chromium | `baseURI` = the host's full URL, query and fragment included. The host's `base-uri 'none'` refuses its `<base>`; `img-src 'none'` blocks its image. `referrer`: `http://localhost:PORT/` (the origin), `""` with `referrerpolicy=no-referrer` | `baseURI` `about:blank` (V1, V4), or the frame's own URL `http://localhost:PORT/frame.html` where the header's `base-uri 'self'` refuses the `<base>` (V2, V3) or there is none. Origin `null`. The image loads, no violation: **the host's policy does not bind the frame or its child**. `ancestorOrigins`: frame `[host]`, child `["null", host]`. `referrer`: frame = the host's full URL with query (`…/app/secret-path?token=HOSTSECRET`), child `""`; both `""` with `referrerpolicy=no-referrer` |
| Firefox | as Chromium, except `referrer` is `""` | the same, except no `ancestorOrigins` (unsupported), and the child's `referrer` equals the frame's (the host's full URL; `""` with `no-referrer`) |
| WebKit | as Chromium (`referrer` = the origin; `""` with the policy) | the same as Chromium; the child's `referrer` is the host origin `http://localhost:PORT/` (`""` with the policy) |

- **3.1 re-confirmed on a fresh server, on all three engines.** The `srcdoc` frame under the host is bound by both host
  directives and sees the host's full URL as its base. The served frame and its `srcdoc` child are not bound by them, and
  inherit the served document's own policy instead: V2 and V3 bind the child through the served header (`img-src`
  falls back to `default-src 'none'`; `<base>` is refused by `base-uri 'self'`).
- **The `Referer` of the frame's own request carries the host page's full URL by default.** `frame.html` is requested with
  `Referer: http://localhost:PORT/app/secret-path?token=HOSTSECRET` (same-origin, so the default policy sends the whole
  URL, fragment removed), and `document.referrer` repeats it. The iframe attribute `referrerpolicy="no-referrer"` removes
  both on all three engines (the library sets it on its wrapper iframe today).
- **The header is a ceiling that every guest document inherits, and a `<meta>` can only narrow it** (all three engines). Under V1 a
  `<meta>` with `img-src 'none'` in the child blocked the child's image and left the frame's loading. Under V2 the child's
  inline script never ran, with or without a `<meta script-src 'unsafe-inline'>` in the child; under V3 (its hash
  admitted) it ran. So a header with a hash-only `script-src` cannot serve a cooperative guest whose scripts are inline,
  and the header's `img-src`, `connect-src`, ... cap what every instance may be granted. `frame-src 'none'` does not stop
  the `srcdoc` iframe from being created or from running (V3 ran under it).
- **`base-uri 'self'` (V2, V3) refuses the library's inert `<base href="about:blank">`.** The base then falls back to the
  served frame's own URL, which reveals nothing of the host page but is a real, resolvable URL where `about:blank` made
  relative URLs fail closed. `base-uri about:` (V4) keeps `about:blank`.
- **`location.ancestorOrigins`** still lists the host origin in Chromium and WebKit (as the proposal expects), for the frame and, after
  `"null"`, for its child; Firefox does not implement it.

## What it means for the mode

Nothing here changes the proposal's purpose. The amendments:

1. **Keep the iframe `sandbox` attribute; the header is the second layer, not the first.** With the attribute, the host's
   SW never sees the navigation or the frame's subresources (Q1). With only the header, a SW (the host's own) can answer
   the navigation with a document that has no header. The attribute also decides `document.referrer`: the iframe's
   `referrerpolicy="no-referrer"` is needed because the frame's request carries the host's full URL, query included
   (side measurements). Both attributes are what the library sets on its wrapper iframe today.
2. **`frame-ancestors` needs a stated limit and a second header.**
   - The served document can only be embedded by a host page whose chain of ancestors has no opaque origin: not by a
     host running inside a sandboxed frame (a playground, a preview pane, an embedding page), and not by itself (Q3). The
     topology the library has (host → wrapper → `srcdoc` guest or view; bridge frame beside the wrapper) does not nest
     the served document, so that restriction costs nothing there; the role split ("the wrapper, the view and the
     bridge are this one document") must not nest it either. The view stays a `srcdoc` child of the wrapper.
   - A host that is itself sandboxed has no `frame-ancestors` list that works in Chromium and WebKit. It would need a
     header without `frame-ancestors` (the `sandbox` directive alone), which allows cross-site framing. The mode would
     ship two header templates, and documents which one a host picks.
3. **The header is a ceiling for every guest, so it cannot be the strict, per-mode policy the proposal sketches.** A `<meta>` in the
   `srcdoc` child narrows the header's policy and never relaxes it (side measurements, V1 and V2). The proposed
   `script-src 'sha256-<bootstrap>'` therefore stops cooperative guests whose scripts are inline, and the header's
   `img-src`, `connect-src` and the rest cap what any instance may be given, while the instance's own origins still
   arrive by `<meta>` (a static file cannot vary per instance). So the gains the proposal lists (the host CSP no longer narrows the sandbox; no `<meta>`-delivery limits) hold for the
   policy the header carries, which is one policy per mode; the part of the policy that depends on `origins` is still
   delivered by `<meta>` and keeps the `<meta>` limits (research 11). Per-mode header templates (strict: hash-only; cooperative: the
   guest-script ceiling) are needed, and the gains to re-score are those that depend on per-instance directives.
4. **`base-uri 'self'` in the header refuses the library's inert `<base href="about:blank">`.** Use `base-uri about:` to keep
   relative URLs failing closed; with `'self'` the base falls back to the frame's own URL (no host data in it, but a
   resolvable URL).
5. **COEP hosts.** The library refuses an isolated host today. In this mode a COEP host would need `frame.html` served with
   COEP (and, for Firefox, `Cross-Origin-Resource-Policy: cross-origin`), or the sandbox does not load at all; with the headers
   the guest is as isolated as a `srcdoc` guest is today. Lifting the refusal is a separate decision that this mode does
   not simplify. Offline/PWA hosts cannot count on their SW for the frame document: it comes from the HTTP cache on all three engines.
6. **No availability gain.** The served frame shares its renderer with the `srcdoc` frames in every configuration of Q4, so
   research 16's placement table is unchanged: where a sandboxed frame is on the host's thread today it is there when served.

Costs, as measured: one static file plus two header templates (and a per-mode variant); dev servers must send the headers;
the host must send COEP/CORP headers when it is isolated; not `file://`; no nesting of the served document.

## Open items

- **Not measured:** Safari on macOS and iOS (WebKit 26.0 on Linux only), Firefox outside Playwright, Android Chromium
  (site isolation is partial there), the host timer on Firefox and WebKit with a served frame, and the served mode with
  the library itself (no code was built).
- **Firefox under Playwright** controls only the page that registered a Service Worker; the cause is not known (Q1).
- **Chromium sends no `frame-ancestors` report** for the cross-site, no-`sandbox`-attribute case (X2) in any run. The
  other nine refused cases reported.
- **A server-side check as the alternative to `frame-ancestors`** (`Sec-Fetch-Site` / `Sec-Fetch-Dest` on the frame
  request): on all three engines the frame request carries `Sec-Fetch-Site: same-origin` when the chain is normal and `cross-site` in every refused case, including each opaque ancestor (S3 to S8, T1) and S7's inner request. A server cannot tell a sandboxed host from another site by that header, so it would not admit the sandboxed ancestors that `frame-ancestors` refuses either.
- **Header deployment** (Vite, Bun, GitHub Pages) was not probed.
- **Under a COEP host,** the guest's own cross-origin subresources (they need CORP/CORS) were not probed.
