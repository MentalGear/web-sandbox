# Research 31: the served document's start-up, measured as the design draws it

**Question (before D8 is built).** [03 · The served document](../../design/03-served-document.md) now draws the
served file F as a static file with a `<meta>` policy and one synchronous guard, the view C as an element of F's markup
(`sandbox="allow-scripts allow-forms allow-orientation-lock"`, a hash-pinned `srcdoc` bootstrap) that starts a `blob:`
worker, F framed by the host page with `sandbox="allow-scripts allow-forms"` inside a closed shadow root, and a start-up
order in which the host page sends nothing of the guest's until C has answered on a port. [Review 1](../../design/REVIEW-1.md)
(findings 1, 3 and 4) found that the gates, the policy check and the flags had been measured in other forms. This note
builds the file exactly as drawn and measures:

- **Q1, the start-up order**: does it work, what does it cost, and what does the host page see when `documentUrl` is
  missing, another page, refused framing, not HTML, or not admitted by the host page's `frame-src`?
- **Q2, the gates in C and the worker** (research 28 Q7's canaries without the frame canary, none in F): does each still
  trip under its mutant, and which mutants pass every gate?
- **Q3, the policy check of I18**: under each kind of response header on F, does the check see it, in C and in the
  worker, what reaches the endpoint first, and which policies does it not see?
- **Q4, the sandbox flags**: does a form's `submit` reach C; do research 27 Q2's twelve ways still leave C and its
  worker opaque with `allow-forms` on F; what does C gain when a hostile page frames F with more flags?
- **Q5, a page that frames the host page**: can it reach F's frame (inside the closed shadow root) and navigate it?
- **Q6, a refused canary per directive** (03's "To be measured" under "What the policy check provokes"): does a load the
  `<meta>` itself refuses raise exactly its event, and a second one under the headers Q3 missed; which headers stay
  unseen, and does a guest's URL get reported under them?
- **Q7, the view speaks first** (03's "To be measured" under "Who receives the first port"): is `event.source ===
  frame.contentWindow[0]` a reliable test, what does each forgery get, and what does the order cost?

**Measured on headless Playwright 1.65.1 on a shared 4-core VM** (Chromium 159.0.8154.6 headless shell, Firefox 159.0,
WebKit 27.2), 2026-11-18, from `80701b0` (Q1 to Q5), and 2026-11-19, from `7494042` (Q6 and Q7); no library code. Plain HTML served on loopback by
[`server.mjs`](server.mjs) (research 28's recording server, with arrival times). `localhost` and `127.0.0.1` are two
sites. Raw output is in [`results/`](results/README.md).

## Answer in brief

- **(Q1) The order works on all three engines**, with its positive and negative controls: the correct file answered and
  received content; a file of another version answered with another hash and received nothing; a hello posted first by
  another frame of the host page was ignored by C (its port got nothing) and the host page's own hello was answered. It
  costs **73 ms (Chromium), 77 ms (Firefox) and 85 ms (WebKit) more than the same flow with no gates and no check**, at
  the median of 24 starts (95 / 109 / 119 ms from insertion to the verdict, against 22 / 32 / 34). The gates are 2 to 4
  ms of it, as in research 28 Q7; the policy check is the rest, 60 ms of which are two fixed 30 ms waits of this
  fixture (for the events to arrive, and for the twin canary below). **Every failure mode ended in "no answer"**, except
  an SPA fallback whose page has a frame of its own: **that frame received the hello and its port** (and answered; the
  hash refused it). From outside, the host page **can** tell most of them apart: `contentWindow.length` at the frame's
  load is 1 only for a document with a frame; the host page's own `securitypolicyviolation` names its `frame-src`; an
  `application/octet-stream` response fires no `load`; and a `fetch()` of `documentUrl` by the host page reads the
  status (404), the type, `X-Frame-Options`, `Content-Security-Policy`, `-Report-Only` and whether the body is the file.
- **(Q2) With F static, every gate still trips under its own mutant, the same on all three engines** (no `<meta>`, weakened
  `script-src`, `connect-src`, `img-src`, `style-src`, `base-uri`, the worker's allowlist step skipped, a C that is not
  opaque). **The gates alone pass** the `frame-src`, `worker-src`, `default-src`, `font-src`, `media-src`, `object-src`,
  `form-action` and `manifest-src` mutants; **the policy check catches every `<meta>` mutant** that still refuses one of
  its canaries, because the mutant's text is not the file's (C rebuilds the expected text from a template and the hash of
  its own bootstrap). F's realm has no gate: an F framed without `sandbox` or with `allow-same-origin` is stopped by the
  guard and the host page sees only "no answer", not a named gate; **a file without the guard, framed so, passes every
  gate in C and the worker** (C is opaque by its own attribute), so nothing then reports that F holds the embedder's
  origin.
- **(Q3) The check sees every outside policy that refuses one of its canaries, in C and in the worker, on all three
  engines**: report-only and enforced, `report-uri` and `report-to`, every single-directive `'self'` policy, Trusted
  Types enforced and report-only, and the `<meta>`'s exact text in a header (enforced: through the twin canary;
  report-only: through the disposition). **It does not see**: report-only `worker-src`, `font-src` or `media-src` with
  the `<meta>`'s own sources; `frame-src`, `object-src`, `form-action`, `manifest-src` (any value); `frame-ancestors`
  that admits the host page; `upgrade-insecure-requests`; a header `sandbox`; and an enforced policy that admits
  everything the file does (seen on Chromium only, through a quirk of the base canary). **Under five of those a guest
  can later cause a report on Chromium and Firefox, if the view ever makes the load**: `font-src` (a font URL),
  `media-src` (a media URL) and `form-action` (a form's action, with its query) carry the full URL of the guest's
  choice; `frame-src` and `object-src` carry its origin. WebKit sent none. The renderer's rules keep each of those loads
  from existing (below). **Every report sent before the
  check ended the build carried only library strings, scheme-only blocked URLs and the file's URL, except one field: the
  `referrer`, which was the host page's full URL with its query** (F's reports on all three; C's on Firefox), unless F is
  framed `referrerpolicy="no-referrer"`. **WebKit raises the events in C and the worker but sends no report from an opaque
  document**: from C it sent only the refusals of code from strings (for which it raises no event), filed under F's URL;
  everything else came from F. The Reporting API's `report-to` delivered nothing on Chromium, positive control included
  (void); on Firefox and WebKit it delivered three reports per case (WebKit's all under F's URL; Firefox's bodies
  were not parsed). `originalPolicy` carried each policy's own text on every
  engine, so the `<meta>` and a header are told apart by text, and by disposition or a second event when the text is the
  same.
- **(Q4) `allow-forms` on F makes `submit` reach C on all three engines** (2 of 2, a real click and Enter); without it,
  0 on Chromium and Firefox, 2 on WebKit. **The twelve ways of research 27 Q2 gave the same cells as research 28's static
  and guarded files, cell for cell, on all three engines**: C and its worker opaque in every case and reaching nothing of
  the embedder's origin; WebKit's browser closed in the sandboxed-popup case again. **A hostile page that frames F with
  `allow-popups`, `allow-top-navigation`, `allow-modals`, `allow-downloads` or `allow-popups-to-escape-sandbox` gave C
  nothing** (no popup, no dialog, no top navigation, no download, opaque), on all three; with `allow-same-origin` the
  guard stopped F. The positive control (the flags on C's own attribute) opened a popup, a dialog and navigated the top
  page on all three.
- **(Q5) A page that frames the host page cannot reach F's frame inside the closed shadow root**, before or after its
  first load: the host page's `window.length` is 0 from inside and from outside. **With the same frame in the light DOM
  (the positive control), it navigated F before its first load, received the hello and the port, answered with the
  file's public hash and clean verdicts, and received the content**, on all three engines; the host page saw a normal
  start, with one `load`. Today's `srcdoc` shape behaved the same, except on WebKit, where its `srcdoc` loaded before
  the framer reached it. After the first load, a navigation of F showed the host page a second `load`; C's own
  navigation was refused by F's `frame-src 'none'`.

- **(Q6) A refused canary raised exactly the `<meta>`'s event under the `<meta>` alone, and a second one under every
  header Q3 missed that reports a guest's URL, for `font-src`, `media-src`, `frame-src` and `object-src` on all three
  engines**, with one fixed library URL per kind on a reserved name in `http:` and in `https:` (the pair sees
  `https: blob:`-style headers too). No canary left the browser under the `<meta>`; the positive control reached the
  server. `worker-src` is seen through a `data:` worker (a network worker fails before the policy, with no request).
  **No refused canary**: `manifest-src` (no engine fetched a manifest in C, so neither a canary nor a guest's link
  raised anything) and, **on Chromium, `form-action`: the refused form replaced C with an error page** (Firefox and
  WebKit: one event, C stays). **The residual set** (unseen by both canaries, a guest's URL then reported): on Chromium
  and Firefox, a header that names the canaries' own host (`*.canary.invalid`) for `font-src`, `media-src`,
  `form-action` (full URL) and `frame-src`, `object-src` (origin); on Chromium also every `form-action` header that
  refuses the guest's action (full URL). WebKit: none. The canaries' own reports carried library strings only, with an
  empty `referrer`. They add 63 / 95 / 24 ms at the median (Chromium / Firefox / WebKit, the last two under load); each
  is expected exactly, so a check can wait for the count rather than a fixed time (the latest arrived 99 / 165 / 203 ms
  after issue). A refused frame or object left no trace outside C.
- **(Q7) The view speaking first works, and `event.source === frame.contentWindow[0]` is a reliable test on all three
  engines**, read inside `try`: C's message passed it in every start (100 of 100 per engine, half of them with the host
  page busy 200 ms at insertion), and the reading throws (`TypeError` with no frame, `SecurityError` while F is not
  loaded, opaque `about:blank`, or a page with no frames) rather than returning `undefined`. `event.source.parent ===
  frame.contentWindow` is not enough: it holds for F's second frame. **Forgeries**: another frame of the host page, F
  itself, a second frame inside F and a page that frames the host page were all ignored and received nothing; **an SPA
  fallback's widget that speaks received the port and the content** (it is `frames[0]` of what answered: the trusted
  host's limit), and a silent widget received nothing. A port posted to `event.source` reached a reloaded C (the same
  browsing context) but was lost when F replaced C's frame; a fresh `frame.contentWindow[0]` reached the new C. The
  order costs the same as Q1's (93 / 120 / 288 ms against 93 / 121 / 286 to the verdict). Another site framing F
  receives only `{ version, verdicts }`. Q5 is unchanged: the closed shadow root keeps a framing page out; in the light
  DOM its page took the port and the content.

## Method

- **The file** ([`fixture.mjs`](fixture.mjs)). F: `<meta http-equiv="Content-Security-Policy">` first in `<head>`, then
  the guard `if (!(self.origin === 'null' && top !== self)) window.stop();`, then C in the body. The `<meta>` is the
  design's constant text: `default-src 'none'; script-src <guard> <bootstrap>; script-src-attr 'none'; style-src <still
  sheet> blob:; img-src blob:; font-src blob:; media-src blob:; connect-src 'none'; worker-src blob:; frame-src 'none';
  object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'`. C: the still stylesheet (by hash) and
  one bootstrap (by hash). F has no style attribute and no other script.
- **The start-up order.** The host page H defines an element, attaches a closed shadow root and puts in it
  `<iframe sandbox="allow-scripts allow-forms" src=documentUrl>`. At the frame's first `load` it posts `'ws-hello'` with
  one `MessagePort` to `frames[0]` of F, and nothing else. C answers only the first message whose `source` is
  `parent.parent` and that brings a port. It hashes its own bootstrap text (`crypto.subtle`), starts the worker, runs its
  gates and its check while the worker runs its own, and answers on the port with the hash and every verdict. H compares
  the hash with its own and sends content only when every gate held and both checks were clean. It gives up after a
  timeout.
- **The gates** are research 28 Q7's list without the frame canary (origin, code from strings, connect, image, style,
  base, cookie, storage, parent; the worker's names after its allowlist step).
- **The policy check (I18).** Its canaries are one load of each kind the view makes for a guest. `VIEW_LOAD_KINDS`
  (`src/lib/in-sandbox-view.ts`) lists style, image, font, media and track; to them the check adds a refused request,
  code from a string, `import()`, the Trusted Types sink and policy the view uses, and the worker itself. In C these are
  a `blob:` PNG, a `blob:` stylesheet `<link>`, a `blob:` `FontFace`, a `blob:` `<audio>` and `<track>`, `fetch(blob:)`,
  `eval`, `import(blob:)`, a template's `innerHTML` and `trustedTypes.createPolicy`. The worker runs `fetch(blob:)`,
  `eval`, `import(blob:)`, `importScripts(blob:)` and `createPolicy`. Every canary uses fixed strings and URLs the realm
  minted. A listener for `securitypolicyviolation`, added before anything else in each realm, collects the events. The
  verdict is not clean when any of these holds:
  - an event's normalised `originalPolicy` is not the expected text (C fills the `<meta>` template with the hash it
    computed);
  - an event's disposition is not `enforce`;
  - a canary did not do what the `<meta>` alone makes it do (the image loads, the sheet applies, the request is refused …);
  - the twin canary raised more than one event. The twin is one refused `fetch(blob:)`, run alone after every other
    event has arrived; the `<meta>` raises exactly one event for it.
- **Runs.** Each probe ran once per engine under the machine's shared lock ([`run.mjs`](run.mjs)), Q1's cost with 24
  starts per variant, the variants alternating, one fresh element per start, after one warm-up start each.

## Q1. The start-up order ([`q1-order.mjs`](q1-order.mjs))

| Case | Chromium 159 | Firefox 159 | WebKit 27.2 |
| :--- | :--- | :--- | :--- |
| correct file (positive control) | answered, content sent and acknowledged | the same | the same |
| a file of another version (negative control) | answered, hash refused, nothing sent | the same | the same |
| a sibling frame of the host page posts the hello first | C ignored it ("not from parent.parent"; its port received nothing), then answered the host page | the same | the same |

What the host page sees when `documentUrl` answers with something else. "load (n)" is the frame's `load` event with
`contentWindow.length` read at it; the last column is what the host page's own `fetch(documentUrl)` read.

| `documentUrl` answers | Chromium | Firefox | WebKit | Host page's fetch reads |
| :--- | :--- | :--- | :--- | :--- |
| 404 with an HTML body | load (0), no answer | the same | the same | 404 |
| the server's 404 (`text/plain`) | load (0), no answer | the same | the same | 404, `text/plain` |
| SPA fallback: 200, other HTML | load (0), no answer | the same | the same | 200, HTML, not the file |
| SPA fallback whose page has a frame | load (1); **its frame received the hello and the port** and answered; refused (no hash, no verdicts) | the same | the same | 200, HTML, not the file |
| `X-Frame-Options: DENY` | load (0), no answer | the same | the same | the header |
| `frame-ancestors 'none'` | load (0), no answer | the same | the same | the header |
| `Content-Type: text/plain` | load (0), no answer | the same | the same | the type |
| `Content-Type: application/octet-stream` | **no load**, no answer (no download event) | the same | the same | the type |
| the host page's `frame-src` refuses it | load (0), no answer; **a `frame-src` violation in the host page** | **no load**; the violation | load (0); the violation | 200, the file |

Cost: from the element's insertion, in ms, median (range) of 24 starts per variant. "In C" is from the hello to C's
answer; "gates" and "check" are when each phase ended in C, from the hello. Load average 0.27 to 0.41.

| | Chromium | Firefox | WebKit |
| :--- | ---: | ---: | ---: |
| insertion to F's load | 14 (11–18) | 24 (19–37) | 29 (16–59) |
| **the design: insertion to the verdict** | **95 (85–102)** | **109 (100–133)** | **119 (101–167)** |
| the same flow, no gates and no check | 22 (18–36) | 32 (25–58) | 34 (19–112) |
| in C, the design | 80 (73–86) | 83 (79–96) | 89 (82–106) |
| of which the gates end at | 4 (2–8) | 3 (2–5) | 3 (1–10) |
| of which the check ends at | 77 (70–83) | 73 (70–80) | 89 (81–106) |
| verdict to the content's acknowledgement | < 1 | 1 | 1 |

Research 28 Q7 measured 4 to 6 ms for its gates without the frame canary, F answering 23 / 41 / 17 ms with no gates and
28 / 45 / 23 with them. The gates cost the same here. The policy check is new. Its canaries settle in 15 to 45 ms (the
`<audio>` and `<track>` last), and the fixture then waits 30 ms for their events and 30 ms around the twin canary. Those
two waits are a choice, not a measurement: the shortest wait that still sees every event was not measured.

**Q1b, a host page that is not a secure context** ([`q1-insecure.mjs`](q1-insecure.mjs)). The host page at
`http://app.insecure.test` (through the recording server's proxy), with F on the same origin: C's `isSecureContext` was
`false` and `crypto.subtle` was `undefined` on all three engines. The fixture's C, which hashes its own bootstrap, threw,
and the host page saw "no answer". The control at `http://localhost` answered and received content.

## Q2. The gates in C and the worker ([`q2-gates.mjs`](q2-gates.mjs))

The same on Chromium 159, Firefox 159 and WebKit 27.2 in every row.

| Mutant | Gates that tripped | Policy check | Host page |
| :--- | :--- | :--- | :--- |
| correct file (positive control) | none | clean | content sent |
| no `<meta>` | C: string code, connect, image, style, base; W: string code, connect | not clean (refused loads admitted) | refused |
| `script-src` + `'unsafe-eval'` | C, W: string code | not clean (foreign text) | refused |
| `connect-src * data: blob:` | C, W: connect | not clean | refused |
| `img-src * data: blob:` | C: image | not clean | refused |
| `style-src 'unsafe-inline' blob:` | C: style | not clean | refused |
| `base-uri *` | C: base | not clean | refused |
| `frame-src * data:` | **none** | not clean (foreign text) | refused |
| `worker-src * data: blob:` | **none** | not clean (foreign text) | refused |
| `default-src *` | **none** | not clean (foreign text) | refused |
| `font-src * data: blob:` | **none** | not clean (foreign text) | refused |
| `media-src * data: blob:` | **none** | not clean (foreign text) | refused |
| `object-src *; form-action *; manifest-src *` | **none** | not clean (foreign text) | refused |
| the worker's allowlist step skipped | W: names | clean | refused |
| F framed without `sandbox` | (the guard stopped F; C never existed) | – | no answer |
| F framed `allow-scripts allow-forms allow-same-origin` | (the guard stopped F) | – | no answer |
| **no guard**, F framed without `sandbox` | **none** | clean | **content sent** |
| **no guard**, F framed with `allow-same-origin` | **none** | clean | **content sent** |
| C's attribute + `allow-same-origin`, F framed as designed | none (C shares F's opaque origin) | clean | content sent |
| C's attribute + `allow-same-origin`, no guard, F framed without `sandbox` | C: opaque, cookie, storage, parent; W: opaque, storage | clean | refused |

- **What F's realm loses.** In research 28 Q7, F ran its own gates, and "no `<meta>`" stopped F before C existed. In the
  static file, C exists and runs under no policy. Its gates and its check trip before any content is sent, so nothing of
  the guest's runs. But nothing checks F itself. The guard is F's only defence and reports nothing. When it stops F, the
  host page sees the same "no answer" as for a missing file. When it is missing (a file edited, or rewritten by a CDN),
  an F that holds the embedder's origin passes every gate.
- **The policy check doubles as a text check of the `<meta>`.** Each mutant `<meta>` still refuses the check's
  `fetch(blob:)`, `eval` or `import()`, and its events carry the mutant's text. That is what catches the eight mutants
  that pass the gates. A mutant that refused none of the canaries would pass both.

## Q3. The policy check under headers on F ([`q3-policy.mjs`](q3-policy.mjs), [`q3-report-sources.mjs`](q3-report-sources.mjs))

The host page frames F as designed, without `referrerpolicy` unless stated, from a URL with a query. Every report-only
(RO) and enforced (CSP) header names `report-uri /__report` unless stated. "seen" means the check was not clean, and
the host page sent nothing. "foreign" counts events whose text was not the `<meta>`'s. "twin 2" means the twin canary
raised two events. "off" names a canary that did not do what the `<meta>` alone makes it do.

| # | Header on F | Chromium | Firefox | WebKit |
| ---: | :--- | :--- | :--- | :--- |
| 0 | none (control) | C clean · W clean | C clean · W clean | C clean · W clean |
| 1 | RO default-src 'self'; report-uri | C **seen** (18 foreign, twin 2) · W **seen** (7 foreign, twin 2) | C **seen** (19 foreign, twin 2) · W **seen** (5 foreign, twin 2) | C **seen** (18 foreign, twin 2) · W **seen** (5 foreign, twin 2) |
| 2 | RO default-src 'self' 'report-sample' (and script-src, style-src); report-uri | C **seen** (18 foreign, twin 2) · W **seen** (7 foreign, twin 2) | C **seen** (19 foreign, twin 2) · W **seen** (5 foreign, twin 2) | C **seen** (18 foreign, twin 2) · W **seen** (5 foreign, twin 2) |
| 3 | RO img-src 'self' only | C **seen** (2 foreign) · W clean | C **seen** (2 foreign) · W clean | C **seen** (2 foreign) · W clean |
| 4 | RO style-src 'self' only | C **seen** (3 foreign) · W clean | C **seen** (4 foreign) · W clean | C **seen** (3 foreign) · W clean |
| 5 | RO script-src 'self' only | C **seen** (5 foreign) · W **seen** (4 foreign) | C **seen** (7 foreign) · W **seen** (2 foreign) | C **seen** (4 foreign) · W **seen** (2 foreign) |
| 6 | RO connect-src 'self' only | C **seen** (3 foreign, twin 2) · W **seen** (3 foreign, twin 2) | C **seen** (3 foreign, twin 2) · W **seen** (3 foreign, twin 2) | C **seen** (3 foreign, twin 2) · W **seen** (3 foreign, twin 2) |
| 7 | RO worker-src 'self' only | C **seen** (1 foreign) · W clean | C **seen** (1 foreign) · W clean | C **seen** (2 foreign) · W clean |
| 8 | RO font-src 'self' only | C **seen** (1 foreign) · W clean | C **seen** (1 foreign) · W clean | C **seen** (1 foreign) · W clean |
| 9 | RO media-src 'self' only | C **seen** (4 foreign) · W clean | C **seen** (2 foreign) · W clean | C **seen** (5 foreign) · W clean |
| 10 | RO img-src with the <meta>'s own sources only (no sample) | C **seen** (1 foreign) · W clean | C **seen** (1 foreign) · W clean | C **seen** (1 foreign) · W clean |
| 11 | RO style-src with the <meta>'s own sources only (+ 'report-sample') | C **seen** (1 foreign) · W clean | C **seen** (1 foreign) · W clean | C **seen** (1 foreign) · W clean |
| 12 | RO script-src with the <meta>'s own sources only (+ 'report-sample') | C **seen** (4 foreign) · W **seen** (4 foreign) | C **seen** (6 foreign) · W **seen** (2 foreign) | C **seen** (3 foreign) · W **seen** (2 foreign) |
| 13 | RO connect-src with the <meta>'s own sources only (no sample) | C **seen** (3 foreign, twin 2) · W **seen** (3 foreign, twin 2) | C **seen** (3 foreign, twin 2) · W **seen** (3 foreign, twin 2) | C **seen** (3 foreign, twin 2) · W **seen** (3 foreign, twin 2) |
| 14 | RO worker-src with the <meta>'s own sources only (no sample) | C clean · W clean | C clean · W clean | C clean · W clean |
| 15 | RO font-src with the <meta>'s own sources only (no sample) | C clean · W clean | C clean · W clean | C clean · W clean |
| 16 | RO media-src with the <meta>'s own sources only (no sample) | C clean · W clean | C clean · W clean | C clean · W clean |
| 17 | RO base-uri 'none' | C **seen** (2 foreign) · W clean | C **seen** (1 foreign) · W clean | C **seen** (1 foreign) · W clean |
| 18 | RO frame-src 'none'; object-src 'none'; form-action 'none'; manifest-src 'none' (the <meta>'s own values) | C clean · W clean | C clean · W clean | C clean · W clean |
| 19 | RO form-action 'self' | C clean · W clean | C clean · W clean | C clean · W clean |
| 20 | RO require-trusted-types-for 'script' | C **seen** (4 foreign) · W **seen** (3 foreign) | C **seen** (4 foreign) · W **seen** (3 foreign) | C **seen** (4 foreign) · W **seen** (3 foreign) |
| 21 | RO trusted-types 'none' | C **seen** (1 foreign) · W **seen** (1 foreign) | C **seen** (1 foreign) · W **seen** (1 foreign) | C **seen** (1 foreign) · W **seen** (1 foreign) |
| 22 | CSP require-trusted-types-for 'script' (enforced) | C **seen** (4 foreign, trustedTypesSink+worker off) · W not started (throws TypeError) | C **seen** (4 foreign, trustedTypesSink+worker off) · W not started (throws TypeError) | C **seen** (4 foreign, trustedTypesSink+worker off) · W not started (throws TypeError) |
| 23 | CSP permissive: admits everything the file does (enforced) | C **seen** (1 foreign) · W clean | C clean · W clean | C clean · W clean |
| 24 | CSP worker-src 'none' (refuses the worker) | C **seen** (1 foreign, worker off) · W not started (error event (not started)) | C **seen** (1 foreign, worker off) · W not started (error event (not started)) | C **seen** (1 foreign, worker off) · W not started (error event (not started)) |
| 25 | CSP typical site policy with 'unsafe-inline' (enforced) | C **seen** (12 foreign, twin 2, image+style+worker off) · W not started (error event (not started)) | C **seen** (12 foreign, twin 2, image+style+worker off) · W not started (error event (not started)) | C **seen** (10 foreign, twin 2, image+style+worker off) · W not started (error event (not started)) |
| 26 | CSP script-src 'self' (refuses C's bootstrap) | no answer (C never ran) | no answer (C never ran) | no answer (C never ran) |
| 27 | CSP upgrade-insecure-requests | C clean · W clean | C clean · W clean | C clean · W clean |
| 28 | CSP frame-ancestors 'self' (admits the host page) | C clean · W clean | C clean · W clean | C clean · W clean |
| 29 | CSP sandbox allow-scripts allow-forms (header sandbox) | C clean · W clean | C clean · W clean | C clean · W clean |
| 30 | CSP the <meta>'s exact text (enforced) | C **seen** (twin 2) · W **seen** (twin 2) | C **seen** (twin 2) · W **seen** (twin 2) | C **seen** (twin 2) · W **seen** (twin 2) |
| 31 | RO the <meta>'s exact text | C **seen** (10 foreign, twin 2) · W **seen** (7 foreign, twin 2) | C **seen** (11 foreign, twin 2) · W **seen** (5 foreign, twin 2) | C **seen** (7 foreign, twin 2) · W **seen** (5 foreign, twin 2) |
| 32 | CSP the <meta>'s text + report-uri (enforced) | C **seen** (10 foreign, twin 2) · W **seen** (7 foreign, twin 2) | C **seen** (11 foreign, twin 2) · W **seen** (5 foreign, twin 2) | C **seen** (7 foreign, twin 2) · W **seen** (5 foreign, twin 2) |
| 33 | RO the <meta>'s text + report-uri | C **seen** (10 foreign, twin 2) · W **seen** (7 foreign, twin 2) | C **seen** (11 foreign, twin 2) · W **seen** (5 foreign, twin 2) | C **seen** (7 foreign, twin 2) · W **seen** (5 foreign, twin 2) |
| 34 | RO default-src 'self'; report-uri, F framed with referrerpolicy="no-referrer" | C **seen** (18 foreign, twin 2) · W **seen** (7 foreign, twin 2) | C **seen** (19 foreign, twin 2) · W **seen** (5 foreign, twin 2) | C **seen** (18 foreign, twin 2) · W **seen** (5 foreign, twin 2) |
| 35 | Reporting-Endpoints + RO default-src 'self'; report-to | C **seen** (18 foreign, twin 2) · W **seen** (7 foreign, twin 2) | C **seen** (19 foreign, twin 2) · W **seen** (5 foreign, twin 2) | C **seen** (18 foreign, twin 2) · W **seen** (5 foreign, twin 2) |
| 36 | Reporting-Endpoints + RO default-src 'self'; report-uri; report-to | C **seen** (18 foreign, twin 2) · W **seen** (7 foreign, twin 2) | C **seen** (19 foreign, twin 2) · W **seen** (5 foreign, twin 2) | C **seen** (18 foreign, twin 2) · W **seen** (5 foreign, twin 2) |
| 37 | Reporting-Endpoints + RO img-src blob: (the <meta>'s own); report-to | C **seen** (1 foreign) · W clean | C **seen** (1 foreign) · W clean | C **seen** (1 foreign) · W clean |
| 38 | Reporting-Endpoints + CSP require-trusted-types-for 'script'; report-to | C **seen** (4 foreign, trustedTypesSink+worker off) · W not started (throws TypeError) | C **seen** (4 foreign, trustedTypesSink+worker off) · W not started (throws TypeError) | C **seen** (4 foreign, trustedTypesSink+worker off) · W not started (throws TypeError) |

Reports at the endpoint, by document (F / C / W): F is the file's URL, C `about:srcdoc`, W `blob:`. They were counted
65 s after the last case. Every start-up report arrived before the verdict that ended the build, between 193 ms and
18 ms before it. "guest:" names a report that the later guest step caused (that step ran only where the check was
clean). Such a report carries its marker, or, for a frame or an object load, the guest's origin only: Chromium and
Firefox drop the path of those. Rows 35 and 36 on Firefox: three reports each, whose `application/reports+json` bodies
this probe did not parse. They are counted under F, but their document was not read.

| # | Chromium | Firefox | WebKit |
| ---: | :--- | :--- | :--- |
| 0 | 0/0/0 | 0/0/0 | 0/0/0 |
| 1 | 1/15/7 | 1/24/0 | 3/0/0 |
| 2 | 1/15/7 | 1/24/0 | 3/0/0 |
| 3 | 0/2/0 | 0/2/0 | 0/0/0 |
| 4 | 0/3/0 | 0/4/0 | 0/0/0 |
| 5 | 1/5/4 | 1/9/0 | 3/0/0 |
| 6 | 0/3/3 | 0/6/0 | 0/0/0 |
| 7 | 0/1/0 | 0/1/0 | 0/0/0 |
| 8 | 0/1/0 | 0/1/0 | 0/0/0 |
| 9 | 0/1/0 | 0/2/0 | 0/0/0 |
| 10 | 0/1/0 | 0/1/0 | 0/0/0 |
| 11 | 0/1/0 | 0/1/0 | 0/0/0 |
| 12 | 0/4/4 | 0/8/0 | 2/0/0 |
| 13 | 0/3/3 | 0/6/0 | 0/0/0 |
| 14 | 0/0/0 | 0/0/0 | 0/0/0 |
| 15 | 0/1/0 (guest: font-src) | 0/1/0 (guest: font-src) | 0/0/0 |
| 16 | 0/1/0 (guest: media-src) | 0/1/0 (guest: media-src) | 0/0/0 |
| 17 | 0/2/0 | 0/1/0 | 0/0/0 |
| 18 | 1/3/0 (guest: frame-src (origin only), object-src (origin only), form-action, frame-src (origin only)) | 0/3/0 (guest: frame-src (origin only), object-src (origin only), form-action) | 0/0/0 |
| 19 | 0/1/0 (guest: form-action) | 0/1/0 (guest: form-action) | 0/0/0 |
| 20 | 0/4/3 | 0/7/0 | 0/0/0 |
| 21 | 0/1/1 | 0/2/0 | 0/0/0 |
| 22 | 0/4/0 | 0/4/0 | 0/0/0 |
| 23 | 0/1/0 | 0/0/0 | 0/0/0 |
| 24 | 0/1/0 | 0/1/0 | 0/0/0 |
| 25 | 0/11/0 | 0/12/0 | 2/0/0 |
| 26 | 1/1/0 | 1/1/0 | 1/0/0 |
| 27 | 0/0/0 | 0/0/0 | 0/0/0 |
| 28 | 0/0/0 | 0/0/0 | 0/0/0 |
| 29 | 0/0/0 | 0/0/0 | 0/0/0 |
| 30 | 0/0/0 | 0/0/0 | 0/0/0 |
| 31 | 0/0/0 | 0/0/0 | 0/0/0 |
| 32 | 0/10/7 | 0/16/0 | 2/0/0 |
| 33 | 0/10/7 | 0/16/0 | 2/0/0 |
| 34 | 1/15/7 | 1/24/0 | 3/0/0 |
| 35 | 0/0/0 | 3/0/0 | 3/0/0 |
| 36 | 0/0/0 | 3/0/0 | 3/0/0 |
| 37 | 0/0/0 | 0/0/0 | 0/0/0 |
| 38 | 0/0/0 | 0/0/0 | 0/0/0 |

**Reporting API positive control** (a top-level page of the file's origin, its own `report-to` policy refusing its
image): Chromium 0 reports, also over HTTPS with `--ignore-certificate-errors` (void); Firefox 1; WebKit 1. The
`report-uri` control delivered on all three.

- **Which outside policies the check misses**, on all three engines:
  - report-only `worker-src`, `font-src` or `media-src` that admit `blob:`, as the `<meta>` does;
  - `frame-src`, `object-src`, `form-action` and `manifest-src` at any value: the check makes no load of those kinds;
  - `frame-ancestors` that admits the host page;
  - `upgrade-insecure-requests`;
  - a header `sandbox`;
  - an enforced policy that admits everything the file does. Chromium saw this one only because the base canary's
    `<base>` removal is refused under `base-uri *`.

  A policy that refuses nothing the view does sends no report at start-up.
- **What a guest can make one of those report later**, on Chromium and Firefox:
  - `font-src`, `media-src` and `form-action` reported a guest action with the full URL the guest used: a font URL, a
    media URL, a form's action and its query;
  - `frame-src` and `object-src` reported the guest's frame and object loads with the URL's origin only;
  - on Chromium, after the form submission, F reported C's navigation toward the action under `frame-src`, with the
    origin only, and C was left on an error page. Whether it was the `<meta>`'s `form-action` or F's `frame-src` that
    stopped the navigation was not isolated.

  Under the other policies the check misses, nothing the guest step did was reported. WebKit reported no guest action
  under any header. In the library, the guest's URLs never reach those loads: the renderer's URL rule (`keepsUrl`) and
  the CSS URL cut, the renderer's removal of nested browsing contexts and of form targets, and the view's cancelling of
  every `submit` (from the code, not measured here). Those checks, not I18, stand between these five policies and a
  guest's text.
- **What reaches the endpoint before the check ends the build.** On Chromium, 23 reports under
  `RO default-src 'self'`; on Firefox, 25. Each carried a directive and a blocked URI reduced to `inline`, `eval`,
  `blob`, `data` or empty, and the document (F's URL, `about`, `blob`). Under `'report-sample'`, the samples were the
  library's own text: the guard's first 40 characters, the still sheet, the bootstrap's first line, `(function
  anonymous(`, the gate's `#gstyle` rule, `1`, `Element innerHTML|<b>check</b>`, `web-sandbox-check`. **One field
  carried something else: `referrer`**. It held the host page's full URL with its query, in F's reports on all three
  engines and in C's on Firefox. Framed `referrerpolicy="no-referrer"`, no report carried it.
- **WebKit, exactly** (Q3b, F framed opaque or not, C opaque or not, under `RO default-src 'self'` with no `<meta>`).
  WebKit raises the event in C for every canary but `eval`, and in the worker for its `fetch`. It sends reports:
  - from F, for F's own inline script;
  - from an opaque C, **only** for code from strings, filed with F's URL as `document-uri` and `about` as `source-file`.
    This is the refusal for which it raises no event;
  - from the worker, none;
  - from a C that is not opaque (`allow-same-origin` under a non-opaque F, or no `sandbox`), its `connect-src` and
    `worker-src` refusals, and the worker's `fetch` under C's URL.

  In the design's shape (C opaque), WebKit's only reports from the view are of code from strings, with no sample.
- **Is `originalPolicy` reliable?** Yes, on the three engines. Each event carried the text of the policy that raised
  it: the `<meta>`'s exactly as written, or the header's. Telling them apart is therefore a text comparison. Where the
  header's text equals the `<meta>`'s, the report-only form still differs by its `disposition`. The enforced form differs
  only by raising a second event: the twin canary saw two on every engine. **A duplicate rule by event content does not
  work**: Firefox gives the asynchronous loads line 0, column 1, so two different canaries look alike, and it files the
  worker's `import()` and `importScripts` events in C. Only a canary run alone can be counted.

## Q4. Sandbox flags ([`q4-flags.mjs`](q4-flags.mjs), [`q4-ways.mjs`](q4-ways.mjs), [`compare-ways.mjs`](compare-ways.mjs))

| | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| `submit` in C, F framed `allow-scripts allow-forms` (a real click on the button, then Enter in the field) | 2 of 2, trusted | 2 of 2 | 2 of 2 |
| the same, F framed `allow-scripts` (negative control) | 0 | 0 | 2 |
| twelve ways, static file (each way with F's own policy and with a policy that admits requests) | 48 cells, the same as research 28's `q1s` | 48, the same | 44 (the browser closed in the sandboxed popup), the same |
| twelve ways, guarded file | C built only in the four sandboxed framings (by its own origin or another site; with each policy), stopped in the other eight; 48 cells, the same as research 28's `q1g` | the same | the same (48 cells: the guard stops the sandboxed popup before anything runs) |
| a hostile page (another site) frames F with `allow-popups`, `allow-top-navigation`, `allow-modals`, `allow-downloads`, `allow-popups-to-escape-sandbox`, or all five | C: opaque; `window.open` → `null`; `alert` returned at once, no dialog; the download click gave nothing; `top.location` threw `SecurityError` | the same, but `window.open` threw `InvalidAccessError` | the same as Chromium |
| … with `allow-same-origin` | the guard stopped F: no answer | the same | the same |
| positive control: the five flags on C's own attribute too | popup opened, dialog shown, download, top page navigated | popup, dialog, top navigation; no download event (void) | the same as Firefox |

Cells of the twelve ways: what C and its worker reached of any origin's authority, by research 28's rule (its
`summarize.mjs`). `compare-ways.mjs` compares them with research 28's results for the same file without `allow-forms`.
C and the worker were opaque in every cell. What crosses is research 28's: Chromium's C and WebKit's worker read the
top-level page's geolocation grant, and under the policy that admits requests, a credentialed `no-cors` request carried
the cookies its engine sends to a third party (Chromium `SameSite=None`; Firefox `None` and unspecified; WebKit, in the
first-party cases, `Lax` and unspecified). F's own policy lets no request leave.

## Q5. A page that frames the host page ([`q5-framed-host.mjs`](q5-framed-host.mjs))

A is another site that frames H. "Reach" means A read H's `length`, H's `frames[0]` (F) and F's `frames[0]` (C).
"Early" means A polled every millisecond and navigated F to its own page E as soon as it could reach F. E's frame
answers the hello as C would. "Late" means A navigated F, or C, 2 s after the start.

| H's frame of F | When | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- | :--- |
| **in the closed shadow root** (served file) | reach | H.length 0; `H.frames[0]` threw `SecurityError` | the same | the same |
| | early | never reached F in 4 s; H: one load, C answered, content sent to C | the same | the same |
| | late (F, or C) | no target | the same | the same |
| in the closed shadow root, today's `srcdoc` shape | reach, early, late | the same as the served file | the same | the same |
| H sends `frame-ancestors 'self'` (negative control) | reach, early | A's frame of H was refused; nothing to reach | the same | the same |
| **in the light DOM** (positive control), served file | reach | H.length 1; F and C reached | the same | the same |
| | early | navigated F at 17 ms, before its first load; **E received the hello and the port, answered, and received the content**; H: one load, the verdict from E, content sent | the same, at 26 ms | the same, at 10 ms |
| | late: F | navigated; H saw a **second `load`**; the view gone | the same | the same |
| | late: C | navigated C; it stayed (F's `frame-src 'none'` refuses C's navigation to another URL); H saw nothing | the same | the same |
| in the light DOM, today's `srcdoc` shape | early | taken over, as the served file (27 ms) | taken over (24 ms) | **not taken over**: the `srcdoc` document loaded before A reached it (20 ms), H had posted to the real C, and A's navigation then gave H a second `load` and no answer |
| | late: F, C | as the served file | as the served file | as the served file |

In the light-DOM rows, Firefox's real C refused its own verdict (H: "refused"). The frame is a light child of an element
whose shadow root has no slot. My reading is that this leaves it unrendered, so the style gate cannot measure a computed
style; the rendering was not checked directly. This is an artefact of the positive control only; the take-over did not
depend on it.

## Q6. A refused canary per directive ([`q6-refused-canaries.mjs`](q6-refused-canaries.mjs), [`canaries.mjs`](canaries.mjs), [`tables-q6.mjs`](tables-q6.mjs))

Q3's canaries were loads the `<meta>` admits (a `blob:` font, `blob:` media, the `blob:` worker) or none at all (a frame,
an object, a form, a manifest). Q6 adds, per kind, a load the `<meta>` itself **refuses**: a fixed URL on a reserved name,
one host per kind (`http://font-api.canary.invalid/ws-canary/font-api`, …), so that an event or a report cut down to the
origin still names its canary. Each refused canary runs **in both schemes, `http:` and `https:`**. A header such as
`font-src https: blob:` admits an `https:` canary and would still report a guest's `http:` URL; `font-src http: blob:`
is the reverse. With the pair, a header goes unseen only if it admits both canary URLs: `*`, both scheme sources, or a
host source that names the canary's own host. `*` and scheme sources admit every guest URL on the network as well, so
they report nothing of the guest's (measured below for `*` and `* blob: data:`); the host source is the residual.

**Method.** The browser runs with the recording server as its proxy (as Q1b), so a canary that left the browser is a hit:
an `http:` URL as a proxied request, an `https:` URL as a `CONNECT`. F is the design's file with Q6's view as C (its
bootstrap runs canaries on command and reports every `securitypolicyviolation` of C and of its `blob:` worker, with
arrival times; C also posts each event to the host page as it arrives, so the events before a navigation of C are
kept). F is framed as designed (closed shadow root, `sandbox="allow-scripts allow-forms"`, `referrerpolicy="no-referrer"`)
from a host page whose URL has a query. Per header, each phase in a fresh element: every canary at once (1000 ms);
where the header names `form-action`, and in the baseline, a form submitted with `submit()` and one by a real click on
its button, each to the `http:` and the `https:` canary, each form in an element of its own; then each refused kind again
with a guest's URL (`http(s)://leak.invalid/GUEST-SECRET-<kind>`). The positive control is the same canaries in a file
without the `<meta>`. "Q3's set" below is Q6's admitted loads (`blob:` image, sheet, font, media and worker) with Q3's
refused `fetch(blob:)` and `eval`, in C and the worker: Q3's check without its gates. The verdicts are read from the raw
events against the baseline of the same engine by `tables-q6.mjs`.

**Under the `<meta>` alone** (the baseline, header 0). "1" is one event with the `<meta>`'s text and disposition
`enforce`, per load and scheme. "Control" is the file without the `<meta>`.

| Canary | Chromium 159 | Firefox 159 | WebKit 27.2 |
| :--- | :--- | :--- | :--- |
| `img`, `style`, `fetch`, `script`, `font-api` (`FontFace`), `audio`, `video-source` (`<source>`), `frame` (`<iframe src>`), `object` (`<object data>`) in C; `fetch`, `importScripts`, `import()` in the worker | 1 each; control: each reached the server | the same | the same |
| `font-css` (`@font-face` in a `blob:` sheet, `document.fonts.load`) | 1 | **2**, both the `<meta>`, in every start | 1 |
| `FontFace` in the worker | 1 | **none** (the console shows the refusal); control reached the server | **none**; control: **no request** |
| `form-submit` (`submit()`), `form-click` (a real click) | **none reached C: C was replaced by an error page** (`chrome-error://chromewebdata/`); the console showed the `<meta>`'s `form-action` refusal and F's `frame-src` refusal of C's navigation | 1; C stays | 1; C stays |
| `worker-data` (`new Worker('data:…')`) in C | 1 | **2** (C's and the worker's nested one, both filed in C) | 1 |
| the same in the worker | 1 | filed in C (above) | 1 |
| `worker` (`new Worker(http(s)://…)`), in C and in the worker | **none**: throws `SecurityError` at construction; control: no request | **none**: an `error` event; control: no request | **none**: an `error` event; control: no request |
| `manifest` (`<link rel=manifest>`) | **none**; control: no request | the same | the same |

- **No canary left the browser under the `<meta>`**: no hit in any of the 57 cases on any engine. The control reached the
  server for every `http:` canary (a proxied `GET`) and every `https:` one (a `CONNECT`) except the cross-origin
  workers, the manifest (all three) and WebKit's worker `FontFace`, so for those kinds "no hit" says nothing more than
  "no request is made".
- **The kinds with no refused canary**, and why:
  - `manifest-src`: no engine fetched a manifest linked in C, with or without the `<meta>`; no event can be raised, and
    a guest's manifest link reported nothing under any `manifest-src` header (rows 37 to 42);
  - a network URL for `worker-src`: a worker of another origin than C's (opaque, so every network URL) fails before the
    policy is consulted (Chromium throws; Firefox and WebKit fire `error`), with no request. A `data:` worker is
    refused by the `<meta>`'s `worker-src blob:` and serves as the refused canary: it carries no URL of anyone's, and a
    guest's network worker cannot be built either;
  - `form-action` on Chromium: the refused form replaced C with an error page and C received no event, so the canary
    ends the view; on Firefox and WebKit it raised one event and C stayed. Whether the `<meta>`'s `form-action` or F's
    `frame-src` decided Chromium's navigation was not isolated (Q3 saw the same);
  - a worker `FontFace` on Firefox and WebKit (no event), where C's `FontFace` and `@font-face` serve.

**Under each header** (with `report-uri`). "admitted": Q3's set saw it; "refused: kinds": only Q6's refused canaries saw
it (two events, or one with the header's text or disposition, against the baseline's count; "(http: only)": only the
`http:` canary); "unseen": neither. After the dot, what a guest's URL then made the browser do: "R" a report at the
endpoint carrying the guest's full URL or its origin; "E" an event in the page only (WebKit sends no report from an
opaque document, Q3); "–" nothing.

| # | Header on F | Chromium | Firefox | WebKit |
| ---: | :--- | :--- | :--- | :--- |
| 0 | none (control) | **unseen** · – | **unseen** · – | **unseen** · – |
| 1 | RO font-src blob: (the `<meta>`'s own) | refused: font-api, font-css, w-font-api · R full URL | refused: font-api, font-css · R full URL | refused: font-api, font-css · E full URL |
| 2 | CSP font-src blob: (the `<meta>`'s own, enforced) | refused: font-api, font-css, w-font-api · R full URL | refused: font-api, font-css · R full URL | refused: font-api, font-css · E full URL |
| 3 | RO font-src \* | admitted · – | admitted · – | admitted · – |
| 4 | RO font-src https: blob: | refused: font-api, font-css, w-font-api (http: only) · R full URL | refused: font-api, font-css (http: only) · R full URL | refused: font-api, font-css (http: only) · E full URL |
| 5 | RO font-src \* blob: data: | **unseen** · – | **unseen** · – | **unseen** · – |
| 6 | RO font-src \*.canary.invalid blob: (names the canaries' hosts) | **unseen** · R full URL | **unseen** · R full URL | refused: font-api, font-css · E full URL |
| 7 | RO media-src blob: (the `<meta>`'s own) | refused: audio, video-source · R full URL | refused: audio, video-source · R full URL | refused: audio, video-source · E full URL |
| 8 | CSP media-src blob: (the `<meta>`'s own, enforced) | refused: audio, video-source · R full URL | refused: audio, video-source · R full URL | refused: audio, video-source · E full URL |
| 9 | RO media-src \* | admitted · – | admitted · – | **unseen** · – |
| 10 | RO media-src https: blob: | refused: audio, video-source (http: only) · R full URL | refused: audio, video-source (http: only) · R full URL | refused: audio, video-source (http: only) · E full URL |
| 11 | RO media-src \* blob: data: | **unseen** · – | **unseen** · – | **unseen** · – |
| 12 | RO media-src \*.canary.invalid blob: (names the canaries' hosts) | **unseen** · R full URL | **unseen** · R full URL | refused: audio, video-source · E full URL |
| 13 | RO worker-src blob: (the `<meta>`'s own) | refused: worker-data, w-worker-data · – | refused: worker-data · – | refused: worker-data, w-worker-data · – |
| 14 | CSP worker-src blob: (the `<meta>`'s own, enforced) | refused: worker-data, w-worker-data · – | refused: worker-data · – | refused: worker-data, w-worker-data · – |
| 15 | RO worker-src \* | admitted · E scheme | admitted · E scheme | admitted · E scheme |
| 16 | RO worker-src https: blob: | refused: worker-data, w-worker-data · – | refused: worker-data · – | refused: worker-data, w-worker-data · – |
| 17 | RO worker-src \* blob: data: | **unseen** · – | **unseen** · – | **unseen** · – |
| 18 | RO worker-src \*.canary.invalid blob: (names the canaries' hosts) | refused: worker-data, w-worker-data · – | refused: worker-data · – | refused: worker-data, w-worker-data · – |
| 19 | RO frame-src 'none' (the `<meta>`'s own) | refused: frame · R origin | refused: frame · R origin | refused: frame · E origin |
| 20 | CSP frame-src 'none' (the `<meta>`'s own, enforced) | refused: frame · R origin | refused: frame · R origin | refused: frame · E origin |
| 21 | RO frame-src \* | **unseen** · – | **unseen** · – | **unseen** · – |
| 22 | RO frame-src https: blob: | refused: frame (http: only) · R origin | refused: frame (http: only) · R origin | refused: frame (http: only) · E origin |
| 23 | RO frame-src \* blob: data: | **unseen** · – | **unseen** · – | **unseen** · – |
| 24 | RO frame-src \*.canary.invalid blob: (names the canaries' hosts) | **unseen** · R origin | **unseen** · R origin | refused: frame · E origin |
| 25 | RO object-src 'none' (the `<meta>`'s own) | refused: object · R origin | refused: object · R origin | refused: object · E origin |
| 26 | CSP object-src 'none' (the `<meta>`'s own, enforced) | refused: object · R origin | refused: object · R origin | refused: object · E origin |
| 27 | RO object-src \* | **unseen** · – | **unseen** · – | **unseen** · – |
| 28 | RO object-src https: blob: | refused: object (http: only) · R origin | refused: object (http: only) · R origin | refused: object (http: only) · E origin |
| 29 | RO object-src \* blob: data: | **unseen** · – | **unseen** · – | **unseen** · – |
| 30 | RO object-src \*.canary.invalid blob: (names the canaries' hosts) | **unseen** · R origin | **unseen** · R origin | refused: object · E origin |
| 31 | RO form-action 'none' (the `<meta>`'s own) | **unseen** · R full URL | refused: form-submit, form-click · R full URL | refused: form-submit, form-click · E full URL |
| 32 | CSP form-action 'none' (the `<meta>`'s own, enforced) | **unseen** · R full URL | refused: form-submit, form-click · R full URL | refused: form-submit, form-click · E full URL |
| 33 | RO form-action \* | **unseen** · – | **unseen** · – | **unseen** · – |
| 34 | RO form-action https: blob: | **unseen** · R full URL | refused: form-submit, form-click (http: only) · R full URL | refused: form-submit, form-click (http: only) · E full URL |
| 35 | RO form-action \* blob: data: | **unseen** · – | **unseen** · – | **unseen** · – |
| 36 | RO form-action \*.canary.invalid blob: (names the canaries' hosts) | **unseen** · R full URL | **unseen** · R full URL | refused: form-submit, form-click · E full URL |
| 37 | RO manifest-src 'none' (the `<meta>`'s own) | **unseen** · – | **unseen** · – | **unseen** · – |
| 38 | CSP manifest-src 'none' (the `<meta>`'s own, enforced) | **unseen** · – | **unseen** · – | **unseen** · – |
| 39 | RO manifest-src \* | **unseen** · – | **unseen** · – | **unseen** · – |
| 40 | RO manifest-src https: blob: | **unseen** · – | **unseen** · – | **unseen** · – |
| 41 | RO manifest-src \* blob: data: | **unseen** · – | **unseen** · – | **unseen** · – |
| 42 | RO manifest-src \*.canary.invalid blob: (names the canaries' hosts) | **unseen** · – | **unseen** · – | **unseen** · – |
| 43 | RO default-src blob: | admitted · R full URL, origin | admitted · R origin, full URL | refused (15 kinds) · E full URL, origin |
| 44 | RO default-src 'self' blob: 'unsafe-inline' 'unsafe-eval' | refused (16 kinds) · R full URL, origin | refused (14 kinds) · R origin, full URL | refused (15 kinds) · E full URL, origin |
| 45 | RO default-src https: blob: 'unsafe-inline' 'unsafe-eval' | refused (16 kinds) · R full URL, origin | refused (14 kinds) · R origin, full URL | refused (15 kinds) · E full URL, origin |
| 46 | RO default-src \* blob: data: 'unsafe-inline' 'unsafe-eval' | **unseen** · – | **unseen** · – | **unseen** · – |
| 47 | CSP default-src \* blob: data: 'unsafe-inline' 'unsafe-eval'; base-uri \*; form-action \* (enforced) | **unseen** · – | **unseen** · – | **unseen** · – |
| 48 | RO child-src blob: | refused: worker-data, frame, w-worker-data · R origin | refused: frame, worker-data · R origin | refused: worker-data, frame, w-worker-data · E origin |
| 49 | RO child-src \* | admitted · E scheme | admitted · E scheme | admitted · E scheme |
| 50 | RO img-src blob: (control) | refused: img · R full URL | refused: img · R full URL | refused: img · E full URL |
| 51 | RO style-src the `<meta>`'s own (control) | refused: style · R full URL | refused: style · R full URL | refused: style · E full URL |
| 52 | RO connect-src 'none' (control) | admitted · R full URL | admitted · R full URL | admitted · E full URL |
| 53 | RO script-src the `<meta>`'s own + 'report-sample' (control) | admitted · R full URL | admitted · R full URL | admitted · E scheme, full URL |
| 54 | RO img-src \* (control) | admitted · – | admitted · – | admitted · – |
| 55 | RO connect-src \* (control) | admitted · – | admitted · – | admitted · – |
| 56 | CSP img-src \* blob: (control, enforced) | **unseen** · – | **unseen** · – | **unseen** · – |

- **The second event exists for every header Q3 missed that reports a guest's URL**, on all three engines: report-only and
  enforced `font-src blob:`, `media-src blob:`, `frame-src 'none'` and `object-src 'none'` (the `<meta>`'s own values),
  the `https: blob:` variants (through the `http:` canary), `default-src` with `blob:` or `'self' blob:`, and `child-src
  blob:`. `form-action 'none'` and `form-action https: blob:` (report-only and enforced) on Firefox and WebKit. `worker-src`
  with the `<meta>`'s own `blob:`, enforced or report-only, is now seen by the `data:` worker on all three.
- **WebKit** also saw the headers that name the canaries' host (`*.canary.invalid`), through the refused canaries;
  Chromium and Firefox did not.
- **The residual set**: a header that both canaries pass **and** under which a guest's URL reached the endpoint in a
  report:

  | Engine | Headers | What the report carried |
  | :--- | :--- | :--- |
  | Chromium | `font-src`, `media-src` or `form-action` with `*.canary.invalid blob:` | the guest's full URL (a form's with its query) |
  | | `frame-src` or `object-src` with `*.canary.invalid blob:` | the guest's origin |
  | | **every `form-action` header that refuses the guest's action**: `'none'` report-only and enforced, `https: blob:` | the full URL with its query (no form canary on Chromium) |
  | Firefox | `font-src`, `media-src`, `form-action` with `*.canary.invalid blob:` | the full URL |
  | | `frame-src`, `object-src` with `*.canary.invalid blob:` | the origin |
  | WebKit | none (it saw the `*.canary.invalid` headers, and sends no report from an opaque document) | – |

  Under every other header both canaries passed (`*`, `* blob: data:`, every `manifest-src`, `default-src * blob: data:
  'unsafe-inline' 'unsafe-eval'` report-only and enforced, an enforced `img-src * blob:`), no guest action was reported
  on any engine. Under `worker-src *` and `child-src *` the guest step's only event was the header's refusal of the
  step's own `blob:` worker (scheme only), and no report: a guest's network worker fails before the policy (above).
- **What the canaries' own reports carried** (to `report-uri`, F framed `no-referrer`): 179 reports on Chromium, 189 on
  Firefox, 4 on WebKit (all F's own, blocked `inline` or `eval`, under headers 43 and 53). Every field was a library
  string: the blocked URI a canary URL (`…canary.invalid/ws-canary/<kind>`, for a form with its fixed query
  `?q=ws-canary`; for a frame or object the origin), `blob`, `data`, `inline` or `eval`; the document `about`, `blob` or
  F's URL; **`referrer` empty in every report**; no field held the host page's URL or its query.
- **Cost**, on the baseline file, from issuing the canaries in a fresh C (its worker started in the same run), median
  (range) of 24 starts per mode, the modes alternating:

  | | Chromium | Firefox | WebKit |
  | :--- | ---: | ---: | ---: |
  | Q3's set alone: until every load settled and every event arrived | 22.6 (17–26) | 36.5 (30–63) | 15.5 (10–26) |
  | the refused canaries alone: until the last event | 62.6 (51–84) | 90.5 (76–126) | 27 (19–180) |
  | both at once: until everything | **85.5 (73–111)** | **131 (97–165)** | **39 (33–203)** |
  | added by the refused canaries (both − Q3's set, medians) | 63 | 94.5 | 23.5 |
  | the last refused event, both at once: median / maximum | 73.7 / 98.6 | 131 / 165 | 38 / 203 |
  | the latest canaries (median / maximum) | `object` https 73.7 / 98.6, `frame` https 50 / 69 | the `data:` worker in C 109 / 165, worker `fetch` 121 / 155 | worker `fetch` 37 / 203 (one start; the rest under 60) |

  Load average 0.5–0.7 (Chromium), 3.6–5.1 (Firefox) and 1.3–4.0 (WebKit) during these runs: the machine was shared, and
  Firefox's and WebKit's figures are inflated by it. Each start raised the same number of events (34; WebKit 30). The
  refused canaries of one kind arrive together; the worker's arrive after the worker has started. **No fixed wait is
  needed for completeness**: each refused canary's event is expected exactly (baseline count per engine), so a check
  can wait for that count with a timeout, rather than for a fixed time. The largest arrival seen, 203 ms after issue
  (WebKit, under load), bounds such a timeout here; it is a measurement, not a guarantee.
- **Side effects** (baseline, all three engines). The frame and object canaries: C's `window.length` was 2 while the
  canaries were in place (the two refused `<iframe>`s; the `<object>`s made none) and 0 after their removal, with no
  canary element left; F's `length`, read by the host page, stayed 1 and C's 0 after removal; the host page saw no
  second `load` of F. In C, the refused `<iframe>` fired `load` on Chromium and WebKit and `error` on Firefox; the
  `<object>` fired `error` on Chromium and Firefox and nothing on WebKit. Every refusal printed a console error in its
  realm. The form canary: on Chromium it replaced C with an error page (above), with no `load` of F seen by the host
  page; on Firefox and WebKit, nothing.

## Q7. The view speaks first ([`q7-view-first.mjs`](q7-view-first.mjs))

The order of 03's "To be measured": the host page posts nothing at F's load. C runs its gates and its check at its own
start (the fixture's, as in Q1), then posts `{ version, verdicts }` to `parent.parent` with target origin `'*'`, and
takes the first message from `parent.parent` that is `'ws-port'` with a port. The host page adds a `message` listener
before it inserts the frame, accepts the first message whose `event.source === frame.contentWindow[0]` and that has a
`version` and `verdicts`, checks them, and only then posts the port to `event.source` (or, in (f), to
`frame.contentWindow[0]`) and the content on it (`fixture.mjs`: `cScriptFirst`, `hostPage` with `first`). The host page
compares the version with a constant, as 03 now draws it, not a hash. For every message it records four comparisons:
`event.source === frame.contentWindow[0]`, `=== frame.contentWindow.frames[0]`, `event.source.parent ===
frame.contentWindow`, `=== frame.contentWindow`, each read inside `try`.

**The comparisons** (the same on Chromium 159, Firefox 159 and WebKit 27.2). "index / frames / parent / self" are the four
comparisons above.

| Who posts `{ version, verdicts }` | index / frames / parent / self | The host page | What the poster received |
| :--- | :--- | :--- | :--- |
| C, the correct file (positive control) | true / true / true / false | accepted; port and content sent to C | the port and the content |
| (a) another frame of the host page (posts at 0, 40 and 80 ms after its load, while the listener is in place) | false / false / false / false; before F's first load the first two **threw `SecurityError`** (Chromium, Firefox) | ignored; then accepted C | nothing |
| (b) an SPA fallback whose widget frame speaks (the widget is `frames[0]` of the page that answered) | true / true / true / false | **accepted; port and content sent to the widget**; no answer on it | **the port and the content** |
| (b) the same page, its widget silent | – (no message) | posted nothing; "no answer" | **nothing** |
| (c) F itself (a file with a script of its own) | false / false / false / true | ignored; then accepted C | nothing |
| (d) a page that frames the host page (another site, posting to the host page every 5 ms) | false / false / false / false (16, 23 and 12 messages); one early one threw `SecurityError` on Chromium and WebKit | ignored; then accepted C | nothing |
| (e) a second frame inside F (index 1) | false / false / **true** / false | ignored; then accepted C | nothing |

**Reading `frame.contentWindow[0]`** in each state of the frame (`frames[0]` the same in every state), on all three:

| State | `frame.contentWindow[0]` |
| :--- | :--- |
| before insertion (`contentWindow` is `null`) | throws `TypeError` |
| inserted, its initial `about:blank` (sandboxed, so opaque) | throws `SecurityError` |
| `src` set, before F's load | throws `SecurityError` |
| at F's load, and after the start-up | C's window |
| F navigated to a page with **no frames** | throws **`SecurityError`**, not `undefined` |
| F navigated to `about:blank` | throws `SecurityError` |
| the element removed | throws `TypeError` |

So the reliable test is `event.source === frame.contentWindow[0]` (or `.frames[0]`, which gave the same values),
evaluated inside `try` with a throw read as "no". `event.source.parent === frame.contentWindow` is **not** sufficient:
it is true for every frame inside F, F's second frame included (e). `event.source === frame.contentWindow` is true only
for F itself.

**(f) C posts, then goes before the host page answers.** The host page accepted C's message and answered after a delay.

| | to `event.source` | to `frame.contentWindow[0]` |
| :--- | :--- | :--- |
| C reloads itself right after its post (the same browsing context, a new document); answer after 400 ms | the port and the content reached the reloaded document (its second announcement was ignored) | the same |
| F replaces C's frame by a new one at 600 ms (a new browsing context at index 0); answer after 1200 ms | **nothing arrived anywhere**: the port went to the discarded context; the host page saw "no answer" | the port and the content reached the new C |

The same on all three engines. A posted `event.source` follows the browsing context, not the document; a replaced frame
is a new context, which only a fresh read of `frame.contentWindow[0]` reaches. Either way the recipient is the document
at index 0 of F at the time of the answer.

**The race and the cost.** The listener exists before insertion, so no message can come before it: over 50 starts per
engine, and 50 with the host page's main thread busy for 200 ms right after insertion, C's message was accepted in
every start (100 of 100 on each engine), and content acknowledged in every one. In none did C's message arrive before
F's `load` event (C's gates and check take longer than F's load), so the case "C speaks before the host page's `load`
handler" did not occur on its own and was not forced. Insertion to the verdict, median (range): 91 (85–98), 119
(108–145), 153 (121–451) ms; busy, 294 (287–324), 317 (309–398), 433 (374–947) ms. Against Q1's order, alternating, 24
starts each (Q1's method):

| | Chromium | Firefox | WebKit |
| :--- | ---: | ---: | ---: |
| Q1's order: insertion to the verdict | 93.2 (89–116) | 121 (113–181) | 286 (243–524) |
| the view speaks first | 93.2 (86–129) | 120 (111–136) | 288 (254–370) |
| insertion to F's load: Q1's order / this order | 14.7 / 29.6 | 29.5 / 45.5 | 186 / 190 |

Load average 0.8 to 1.2. The two orders cost the same; WebKit's whole start-up was slower in this run than in Q1 (119 ms
then), on a shared machine. Content followed the verdict within 1 ms in both orders.

**F framed by another site** (a page at `127.0.0.1` framing the file at `localhost` as designed, without the element):
C's one message reached that page, with `event.source === frame.contentWindow[0]` true and no port. It carried
`{ version, verdicts }` and nothing else: the gate names with `held`, and the check's `clean`, counts and empty `off`
list. On all three engines.

**Q5 in this order** (the attack page of Q5, early variant; E's frame speaks first with the public version and clean
verdicts):

| H's frame of F | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| in the closed shadow root | A never reached F; H accepted the real C and sent it the content | the same | the same |
| in the light DOM (positive control) | A navigated F at 14 ms; **E's frame announced itself, H accepted it (it is `frame.contentWindow[0]`), and E received the port and the content**; H saw one `load` | the same, at 27 ms | the same, at 16 ms |

The order changes nothing in Q5's result: what stands between a framing page and the port is the closed shadow root.

**Firefox's positive control, once.** In the run reported here, Firefox's first start (the positive control) was
refused by the host page for `C.policy`: C's own policy check was not clean, while its message was accepted as coming
from `frame.contentWindow[0]`; which part of the check failed was not recorded. In an earlier run of the same probe
(its output replaced by this one, after the sibling forger of (a) was moved after insertion), Firefox refused 1 and 2 of
its 50 race starts, for reasons not recorded; in this run, none. The comparison held in every one of them. Whether the
fixture's check (Q1's two fixed 30 ms waits) is the cause was not isolated; Q6 measured Firefox's canary events arriving
up to 165 ms after issue.

## What this means for the design

Read against [03](../../design/03-served-document.md) as revised after review 2 (`docs/design/REVIEW-2.md`, both at
`claude/amazing-ride-wbmowi`, `5b0fac5`). For each part: whether the measurement supports it as written, supports it with a change,
or contradicts it, and the rung its guarantee then stands on. The last two rows read the two "To be measured" paragraphs
of 03 as revised after this research (`7494042`): under "What the policy check provokes" (Q6) and "Who receives the
first port" (Q7). Facts as measured on the three engines named above; the choices are the owner's.

| Part of 03 | Verdict | Rung | Why |
| :--- | :--- | :--- | :--- |
| **The shape**: C in F's static markup with `allow-scripts allow-forms allow-orientation-lock`; F framed `allow-scripts allow-forms`; capabilities narrowed on F | **supported as written** | impossible to build, for "guest content never runs with an origin's authority" | the twelve ways gave research 28's cells exactly with `allow-forms` on F and C (Q4); `submit` reaches C on all three (and on none of Chromium and Firefox without `allow-forms` on F); a hostile framer's extra flags gave C nothing on all three. WebKit logs `allow-orientation-lock` as an invalid sandbox flag and ignores the token; the other flags apply |
| "**To be measured again** with F framed as the element frames it" | **measured: the same** | – | Q4 |
| **The frame of F in the closed shadow root is load-bearing** | **supported as written** | impossible to reach, for a page that frames the host page | Q5: A saw `length` 0 and could not reach F, before or after its load, on all three engines; the light-DOM positive control was taken over before F's load and received the content, on all three engines. Today's `srcdoc` shape the same, except that on WebKit its `srcdoc` loaded before the framer reached it |
| **One load of F's frame per build** | **supported** | a check | after F's first load, a framer's navigation of F (light DOM) showed the host page a second `load`; the rule ends the build there. It does not catch the take-over before the first load, where the host page saw exactly one `load` (Q5): the shadow root is what covers that |
| **No referrer** (`referrerpolicy="no-referrer"` on F's frame) | **supported; it is needed** | impossible to reach, for the host page's URL in a report | without it, F's start-up reports (all three) and C's (Firefox) carried the host page's full URL with its query in `referrer`; with it, none did (Q3). It also keeps the URL from the file's host |
| **The check of the file** by the host page's own fetch, before framing | **supported for what it reads; one gap** | a check, for honest deployments | the host page's `fetch()` read the 404, the type, `X-Frame-Options`, `frame-ancestors`, `Content-Security-Policy`, `-Report-Only` and the body on all three (Q1), so every failure mode of Q1 and every header of Q3 can be named before F is framed, and under a report-only header no canary report need ever be sent. Not measured: a host page whose `connect-src` refuses it, and a server that answers the fetch and the frame's navigation differently (`Sec-Fetch-Dest: empty` against `iframe`; the fixture's server saw both). Where it cannot read, Q1's outside signals still separate cases: `contentWindow.length` at `load`, the host page's own `frame-src` violation, and no `load` for `application/octet-stream` (and, on Firefox, for a refused `frame-src`) |
| **A version constant** announced by the view, in place of a hash it computes | **supported; the hash this fixture computed is not portable** | a check (an honest stale copy) | this fixture's C hashed its own bootstrap with `crypto.subtle`. Under a host page at `http://app.insecure.test` (not potentially trustworthy; Q1b, [`q1-insecure.mjs`](q1-insecure.mjs)), C's `isSecureContext` was false and `crypto.subtle` undefined on all three engines, so C threw and the host page saw "no answer"; at `http://localhost` it worked. A constant compiled into the bootstrap needs no API and works on both, so the design's change is the right one. What the constant checks is the version, not the file's bytes (review 2, finding 7); the check of the file's digest is the host page's fetch |
| **The start-up order**: C's gates and check, then the app; the worker's gates and its half of the check in its prelude before the entry; `ready` after the worker's verdicts | **supported, with one change** | a check, of the browser | the order works on all three with its controls (Q1). The worker's half sees in the worker what Q3 shows (`script-src`, `connect-src`, `default-src`, Trusted Types, a header with the `<meta>`'s text) whether it runs before or after the app is sent: the policies are fixed when the worker is created, and this fixture's worker ran the same canaries. **The change**: in Q3, C's own check saw report-only `worker-src 'self'` only through the worker it started. With the app's worker started after the verdict, C must start a canary `blob:` worker of its own before answering, as 03's list says ("a `blob:` worker"), or that header is seen only after the app is in C. The SPA case below bears on step 1 |
| **The start-up gates** | **the "To be measured" row is measured; "Not covered" needs a new text** | a check, of the browser | each gate trips its own mutant in C or the worker with F static, on all three, for 2 to 4 ms (Q2). No **gate** sees the `frame-src`, `worker-src`, `default-src`, `font-src`, `media-src`, `object-src`, `form-action` or `manifest-src` mutants. The **policy check** sees every `<meta>` mutant that still refuses one of its canaries, because its text is not the file's |
| **The guard** | **supported, with a limit that should be stated** | a check, which reports nothing | it stopped F in every wrong-way framing (Q2, Q4). **A file without the guard, framed without `sandbox` or with `allow-same-origin`, passed every gate and the policy check, and received content**, on all three (Q2): C is opaque by its own attribute, so nothing in C or the worker can see that F holds the embedder's origin. F then runs nothing of the guest's, so no data path follows, but a file that lost its guard is detected only by the check of the file's digest, where the host page can read the file |
| **I18, the policy check** | **supported with changes** | a check, at start-up | it sees every outside policy that refuses one of its canaries, in C and in the worker, on all three (Q3). (1) Detecting the `<meta>`'s exact text in an enforced header needs a canary run alone (the twin); counting duplicates gives false positives on Firefox. (2) **It does not see** report-only `worker-src`, `font-src` or `media-src` that admit `blob:`; `frame-src`, `object-src`, `form-action` or `manifest-src` at any value; a `frame-ancestors` that admits the host page; `upgrade-insecure-requests`; a header `sandbox`; an enforced policy that admits everything the file does. (3) WebKit raises the events in C and the worker but sends no report from an opaque document, except the refusals of code from strings, filed under F's URL: 03's "**Not measured**" paragraph on WebKit can be replaced by that. (4) Cost: 70 to 85 ms in this fixture, most of it two fixed waits |
| **The five directives under which a guest load would be reported** | **contradicts "a policy that passes this cannot appear later" as a closure of the report channel** | the renderer's rules (a check each), not I18 | under report-only `font-src`, `media-src` and `form-action` with the `<meta>`'s own values, the check passes, and a guest action then reported its full URL on Chromium and Firefox; under `frame-src` and `object-src` (which the check never provokes) the guest's frame and object loads were reported with their origin (Q3; WebKit sent none). What closes each, from the code: **`font-src`, `media-src`**: the view loads a font or media only from a `blob:` URL it minted itself (`keepsUrl`, the CSS URL cut, `VIEW_LOAD_KINDS`); a minted URL carries no guest text, so under such a header the view's own loads raise nothing. **`frame-src`, `object-src`**: the renderer removes nested browsing contexts (`RENDER_REMOVED_ELEMENTS`). **`form-action`**: the renderer drops `action`, `formaction`, `method` and `target` (the form-target rule of `in-sandbox-view.ts`) and the view cancels every `submit` in the capture phase, so no form navigation exists to check. The five are closed while those checks hold; an implementation that relaxed one would reopen a guest-chosen report under a header I18 passes. State them in I18's row as what stands behind the check, with a test that runs a guest font, media, frame, object and form under each of the five headers |
| **The SPA fallback whose page has a frame** | **contradicts "a file of another version receives nothing", for the port** | – | the hello went to `frames[0]` of whatever answered; an SPA shell with an iframe of its own (a widget) received the hello **and its `MessagePort`**, and answered on it (Q1, all three). The host page refused it, since it had no version and no verdicts, and nothing was sent on that port, so no data moved. But the port reached a third party's frame. The check of the file closes this where it can read the answer (the body is not the file); where it cannot, the host page can post the hello only when `contentWindow.length` is 1 and should close the port after a refused verdict |
| What "serve it unchanged" excludes | **supported** | a documented limit | each excluded case either ends the build through the check (report-only, and an enforced header that lets the bootstrap run) or stops C (an enforced header that refuses the bootstrap, a refused framing, a wrong type), on all three (Q1, Q3). The kinds of header the check does not see (above) pass, and the check of the file names them |
| **"To be measured": a refused canary per directive, to lift the five from the renderer's rules to the check** | **supported, with changes** | a check, at start-up, with a residual that is a documented limit; the renderer's rules stay behind it | Q6: a refused canary (one fixed URL per kind on a reserved name, in `http:` and `https:`) raised exactly the `<meta>`'s event and, under every header Q3 missed that reports a guest's URL, a second one, for `font-src`, `media-src`, `frame-src`, `object-src` on all three engines and `form-action` on Firefox and WebKit; `worker-src` through a `data:` worker. **The changes**: (1) **two** URLs per kind, `http:` and `https:` (one scheme leaves `https: blob:`-style headers unseen); (2) the list cannot give every directive a refused canary: `manifest-src` has none (no engine fetched a manifest in C, so there is also no load to report), and **on Chromium the refused form ended the view** (C replaced by an error page), so `form-action` keeps no canary there and stays behind the renderer's form rules; a network `worker-src` canary fails before the policy (the `data:` one serves); (3) **the residual**: a header that admits both canary URLs but not a guest's, measured as one that names the canaries' host (`*.canary.invalid`), is unseen on Chromium and Firefox and then reported a guest's full URL (`font-src`, `media-src`, `form-action`) or origin (`frame-src`, `object-src`); `*` and scheme sources report nothing of the guest's. That residual is constructed (an embedder's header naming a reserved library host), and on Chromium every `form-action` header is in it; both remain closed only by the renderer's rules. (4) Each refused canary's events are expected exactly (a constant count per engine: Firefox raises two for `@font-face`), so the check can wait for that count with a timeout instead of fixed waits: they added 63 / 95 / 24 ms at the median and the last arrived at most 99 / 165 / 203 ms after issue (Chromium / Firefox / WebKit; Firefox and WebKit under load). A list `POLICY_DIRECTIVES` with, per directive, its admitted canary, its refused canary or the reason it has none, fits these facts; the reasons measured are "no load of that kind is made in a framed document" (`manifest-src`), "the refusal ends the view" (`form-action` on Chromium) and "fails before the policy" (a network worker) |
| **"To be measured": the view speaks first** | **supported, with changes** | impossible to reach, for any document that is not at index 0 of the element's frame; a documented limit for one that is | Q7: `event.source === frame.contentWindow[0]` held for C in every start and was false for every forger elsewhere (a frame of the host page, F itself, F's second frame, a framing page), on all three engines; the order costs the same as Q1's; no message was missed with the listener added before insertion, the host page busy or not. **The changes**: (1) the comparison must run inside `try`, with a throw read as "not the view": the read throws `SecurityError` while F is not loaded and when F has no frames (not `undefined`), and `TypeError` without a frame; (2) `event.source.parent === frame.contentWindow` must not stand in for it (true for F's second frame); (3) where to post the port: `event.source` follows the browsing context, so a reloaded C still receives it, but a frame replaced at index 0 is reached only by a fresh `frame.contentWindow[0]`; posting to `event.source` sends to the context that spoke or nowhere. **What it does not change**: a document at index 0 that speaks is accepted. An SPA fallback's widget that announced itself received the port and the content, and so did a framing page's document in the light DOM (Q5). A silent widget received nothing, where Q1's order gave it the port. So "a document that does not announce itself as the view receives no port at all" holds; "the element posts nothing at the frame's load" holds; the check of the file and the closed shadow root remain what keeps a speaking impostor away. What another site framing F receives is `{ version, verdicts }` only |

## Not measured

- Safari, Android, a shipping browser's third-party storage settings (as research 28).
- The Reporting API on Chromium: its positive control failed over HTTP on loopback and over HTTPS with a self-signed
  certificate; whether Chromium's view and worker deliver `report-to` reports is void here.
- Downloads on Firefox and WebKit: the positive control gave no download event under Playwright (void).
- The shortest wait after Q3's canaries that still sees every event in the check as built (Q6 measured the arrival of
  the refused canaries' events and of Q3's set in its own runner, not the fixture's check with its twin canary).
- Q6: a header with both scheme sources (`font-src http: https: blob:`), which by its matching rules admits both canary
  URLs like `*`; a guest's `data:` font or media under `* blob:` (Q3 found such blocked URIs reduced to the scheme);
  `form-action` on Chromium in isolation from F's `frame-src` (which of the two ended C's navigation).
- Q7: C announcing itself before F's `load` (it never did in 150 starts per engine; not forced); a widget of the SPA
  page at another index than 0; the cause of Firefox's three refusals by C's own check.
- The host page's `fetch()` of `documentUrl` under a host policy (`connect-src`) and whether a server answers that fetch
  as it answers the navigation (a server can vary its response by `Sec-Fetch-Dest`).
- The library itself: no bundle was loaded; the guest step's URLs reached the browser directly, not through the
  renderer, the CSS URL cut or the view's `submit` handling.
- The worker's gates and check in a worker made from the app's source after the content was sent (the revised order):
  this fixture's worker was a library worker started at start-up. The policies a worker inherits are fixed at its
  creation, so the same events are expected; not run.
- The fetch-based check's digest of the whole file: the host page's fetch read the body, but no digest was compared.
- Firefox's `report-to` report bodies (rows 35 and 36): counted, not parsed.
- Memory, a second hostname, the bundlers' handling of the file, and the window before F's `<meta>` applies.

## Rerun

From the repository root, with Playwright's browsers installed (`PLAYWRIGHT_BROWSERS_PATH`):

```
WEB_SANDBOX_LOCK=/path/to/lock bun docs/research/31_served_startup/run.mjs      # every probe, three engines, under flock(1)
bun docs/research/31_served_startup/run.mjs q3 webkit                            # one probe, one engine
bun docs/research/31_served_startup/summarize.mjs docs/research/31_served_startup/results/<set>/q3-webkit.txt
bun docs/research/31_served_startup/tables.mjs <set>                             # Q3's tables
bun docs/research/31_served_startup/compare-ways.mjs <set>                       # Q4's twelve ways against research 28
bun docs/research/31_served_startup/tables-q6.mjs <set>                          # Q6's tables (verdicts read from the raw events)
```

Q6 and Q7 are in `run.mjs`'s plan (`q6`, `q7`); `Q6_CASES=0,1,31 bun …/q6-refused-canaries.mjs <engine>` runs a subset of
Q6's headers, and `Q7_RACE_STARTS` sets Q7's race count (default 50).

The scripts are `.mjs`, not `*.spec.ts`, so the repository's Playwright configuration does not run them. None reads a
host page's timer for a share or a stall (`test/unit/host-share.test.ts` passes without an `OUTSIDE` entry).
