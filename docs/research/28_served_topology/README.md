# Research 28: the served topology, and what it can guarantee by construction

**Question (before D8 is built).** D8 ([research 24](../24_sealed_mode/README.md)) moves sealed mode from `srcdoc`
documents to a served document; [research 27](../27_served_document_headerless/README.md) measured that a header-less
file with a `<meta>` policy, framed with `sandbox="allow-scripts"`, starts a policy of its own on all three engines, and
that the file is opaque only when its embedder sets the attribute. This note measures five proposed tightenings of D8
and one feasibility spike, each aimed one rung up the ladder "impossible to build > impossible to reach > a check > a
documented limit":

- **Q1, the trampoline.** The served file F sets `sandbox` on its own child C (the view), and the worker W is started
  by C, so C and W are opaque **whatever way F was opened**: does that hold, for the twelve ways of opening F of
  research 27 Q2, and which placement of the worker (by F or by C) keeps it opaque? **Q1b:** what an attacker still gets
  from a wrongly opened F with no self-check, with `self.origin === 'null'`, and with `top !== self` too.
- **Q2, a constant policy.** One static `<meta>` text with no `'unsafe-inline'` (scripts by hash, the worker under
  `worker-src blob:`), with F opaque and not; what of today's policy is per build, and whether it can be static.
- **Q3, the channel.** The host holds a `MessagePort` into C and one into W, F hands them on once and relays nothing;
  the cost against today's topology.
- **Q4, a file on another site.** (a) Do research 27 Q1 and Q1 above still hold? (b) Does a busy loop in F, C or W stall
  the host's timer when F is on another site, on the headless shell, full Chromium, Firefox and WebKit?
- **Q5, a thin host** (from the code): which of the host realm's passes over guest content could leave it.
- **Q6, feasibility**: what in `src/` assumes `srcdoc`, and a spike that runs `examples/sealed-app` in the topology.
- **Q7, start-up gates**: canaries each realm runs before any guest content exists, that confirm the browser enforces
  what the design assumes; whether each fails closed under mutants, what it costs, and what it cannot see.

**Measured on headless Playwright 1.65.1 on a shared 4-core VM** (Chromium 159.0.8154.6 headless shell, Firefox 159.0,
WebKit 27.2; Q4b also full Chromium 159 in new headless mode, `channel: 'chromium'`), 2026-11-15, from `298811d` (the
probes changed nothing outside this folder). No library code but in Q6, which loads the default build's bundle
(`dist/index.js` as built at that commit, sha256 `f1a00b976f1c40a3…`). Plain HTML served by research 27's recording
server on loopback (copied into [`server.mjs`](server.mjs), which now also records each request's `Cookie` and
`Origin`). Every cell names its engine; what was not measured says so. Raw output is in
[`results/`](results/README.md). Each probe ran once per engine for the tables (Q1 twice: the first run, in one browser
per engine, is kept in `results/2026-11-15_pw-1.65.1-q1-one-browser/` and agrees with the second in every cell it has).

## Answer in brief

- **(Q1) The trampoline holds, with the worker started by C, on all three engines.** In all twelve ways of opening F
  (eleven on WebKit, whose browser closed in the twelfth, see below), C and the worker C starts (W_C) had an opaque origin
  and reached nothing of any origin's authority: cookies, `localStorage`, `sessionStorage`, IndexedDB, Cache Storage,
  OPFS, Service Worker registrations and Web Locks threw or answered from an empty opaque partition, `parent`/`top`
  documents threw, no `BroadcastChannel` message reached the host's tab, and under the file's own policy no request left.
  **F itself, and a worker F starts (W_F), took F's real origin in every wrong-way case without the attribute** (top
  level, popups, framed without `sandbox` or with `allow-same-origin`, by any embedder) and reached the origin's cookies,
  storage, IndexedDB (they listed the host's database), caches, Service Worker registrations, Web Locks, and posted to
  the host's `BroadcastChannel` (11 to 14 such items in F and 6 to 8 in W_F; 5 and 3 on WebKit when another site framed F). So the worker must be started by
  C, never by F. What still crosses into C and W_C is keyed to the **top-level** page, not to F's origin: Chromium's C
  and WebKit's W_C read the top-level origin's geolocation grant (research 27 Q4's shape), whatever way F was opened.
  **A variant with no script in F at all** (C written in F's markup, as today's wrapper holds the view; the embedder
  posts to `frames[0]` of F) gave the same: C and W_C opaque in every case on every engine, and F runs nothing, so
  nothing ever runs with F's origin.
- **(Q1b) What a wrongly opened F still gives an attacker is its URL.** With the trampoline, the attacker's content runs
  opaque in every case; what is left without a self-check is (1) attacker-chosen content shown in a document whose
  address is the embedder's file (top level and popups: C's text was visible at the file's URL on all three engines), and
  (2) in the scripted variant, F's own code running with the embedder's origin and handling the attacker's message,
  which is safe only while F's code touches nothing origin-scoped. `self.origin === 'null'` leaves the
  sandboxed popup (opaque and top-level: the same URL issue) and hostile sandboxed framing; adding `top !== self` leaves
  only hostile sandboxed framing, where the address bar is the attacker's. The guarded static file (its only script the
  check, before C's markup, then `window.stop()`) created C only when F was framed with `sandbox="allow-scripts"` (by its own origin or another site), and in no other case, on all three engines.
- **(Q2) A constant policy works on all three engines**, F opaque or not: F's script and C's `srcdoc` script ran by
  hash, a third inline script and an inline handler were refused, `eval` was refused in C and its worker, the
  library's one inline stylesheet applied by its hash while another `<style>` was refused, CSSOM declarations, a
  constructed sheet and a `blob:` stylesheet applied, a `blob:` image loaded and a `data:` image did not. A per-build
  narrowing in C's own `<meta>` (`img-src 'none'`) intersected with F's (the `blob:` image was refused). C read
  `about:srcdoc` and base `about:blank` (F's `<base>` before its policy). Unlike the brief's expectation, **`'self'`
  matched the file's own URL when F was opaque** on all three; a hash with `integrity` admitted an external script only
  with `crossorigin` (and CORS) when F was opaque.
- **(Q3) The ports work with F out of the path after start-up**, on all three engines: the host held a port into the
  worker and one into C, F's post on a port it had transferred never arrived, and the round trip was the same as today's
  (the same hop). The extra served document cost 3 to 5 ms of start-up at the median on loopback.
- **(Q4) A file on another site keeps Q1 and research 27 Q1** on all three engines (the host's policy refused nothing
  in the cross-site file, its child or their workers; the file's `<meta>` refused the canary in each), and in the
  wrong-way cases F's authority is the file host's, never the embedder's. **Placement is the engine's process model's, not the
  file's site's:** a loop in F or C on another site or registrable domain stalled the host's timer for its whole length on
  the headless shell, Firefox and WebKit, as today's `srcdoc` view does; on full Chromium (default) and with
  `--site-per-process`, every sandboxed frame, today's view included, ran out of the host's renderer, and another site only
  gave the file a renderer apart from the host site's other sandboxed frames. A second hostname buys no host thread by
  construction where the engine does not already give one.
- **(Q5) Five host passes could leave the host realm** (the entry scan, the module rewrite, the stylesheet scans, the
  stylesheet cut, the worker-source assembly) and one disappears (the policy from file kinds); the config schema, the
  file registry and its quota, guest writes and the validation of every typed frame the host acts on must stay.
- **(Q6) The library's own default build runs `examples/sealed-app` in the served topology on all three engines with no
  edit to `src/`**: a shim in the host page turned the library's wrapper `srcdoc` into a served file at the host's origin,
  byte for byte; the app mounted, loaded, rendered, and a typed todo reached the host's store, including under a strict
  host policy (no `'unsafe-inline'`, no `blob:`, `base-uri 'none'`) where today's `srcdoc` build is refused with the
  library's own reason.
- **(Q7) Start-up gates fail closed for what they can provoke, the same on all three engines.** Twelve canaries (origin,
  framing, code from strings, connect, image, style, base, frame, cookie, storage, parent, the worker's network names)
  held on the correct file; each single-directive mutant tripped its own gate, no `<meta>` tripped six and stopped F
  before C existed, and an unsandboxed or `allow-same-origin` F tripped four. Three mutants passed every gate:
  `frame-src` alone (the frame canary is blind while `script-src` holds), `worker-src` (no canary tells a `blob:` worker
  apart) and `default-src` (never read, since every directive is listed). Without the frame canary the list costs 4 to
  6 ms of start-up (median); with it, about 1.6 s. Under an outside report-only policy the canaries' reports carried only
  fixed library strings and the file's URL, and no canary made a request.

## Method

- **Topology** ([`topology.mjs`](topology.mjs)). F is a static file sent with `Content-Type` only; its `<meta>` is the
  first element of `<head>` and has no `'unsafe-inline'`: `default-src 'none'; script-src <F's hash> <C's hash>;
  script-src-attr 'none'; connect-src 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none';
  form-action 'none'`. Its one script is constant: on a message `{ init: <worker source> }` from anyone it creates C
  (`sandbox="allow-scripts"`, a constant `srcdoc` whose bootstrap is admitted by hash), hands C a `MessagePort` and the
  worker source, and starts W_F from a `blob:` URL it mints. C's bootstrap answers only its parent's first message, mints
  its own `blob:` URL and starts W_C. **Static variant:** C is in F's markup and F has no script; the poster posts to C
  directly. **Guarded static variant:** F's only script is research 27's check (opaque and framed), placed before C's
  markup; when it fails it calls `window.stop()`.
- **The checks** (`CHECKS` in [`topology.mjs`](topology.mjs)): each realm reads `self.origin`, `isSecureContext`,
  `crossOriginIsolated`, then tries `document.cookie` (read and write), `localStorage`, `sessionStorage`, the `parent`,
  `top` and `opener` documents, `indexedDB.open` and `indexedDB.databases()`, `caches.has`/`open`,
  `navigator.storage.estimate` and `getDirectory` (OPFS), a `BroadcastChannel` post, Service Worker registrations, Web
  Locks, `permissions.query({ name: 'geolocation' })`, and a `fetch`, an `XMLHttpRequest` and a credentialed `no-cors`
  fetch to the file's origin. Before the cases a tab on the file's origin (and one on the other site) sets three cookies
  (`SameSite=Lax`, unspecified, `None; Secure`), a `localStorage` key, an IndexedDB database, a cache and a Service Worker
  registration, is granted geolocation, and keeps a `BroadcastChannel` listener. Every check is bounded (2 s); a
  "reached" item is an answer that shows access to that state ([`summarize.mjs`](summarize.mjs) lists the rule per check).
- **The twelve ways** of research 27 Q2, each with F's own policy and with a control policy in which `connect-src` names
  the file's origin (so requests leave and the server records their cookies). `L` is `http://localhost:P` (the file's
  origin), `L2` another port of `localhost` (same site), `I` `http://127.0.0.1:P` (another site). Q4a runs the same
  cases with the file on `I` and the legitimate host on `L`.
- **One browser per part.** Each policy variant, and the sandboxed-popup case, runs in a browser launch of its own: on
  WebKit that case closed the browser in every run ([below](#webkit-closes-the-browser-in-the-sandboxed-popup-case)).
- **Runs** under the machine's shared lock, one engine at a time; [`run.mjs`](run.mjs) writes
  `results/<set>/<q>-<engine>.txt`; [`summarize.mjs`](summarize.mjs) prints the compact view the Q1 tables were read from.

## Q1. The trampoline: C and W whatever way F was opened

The file's own policy (`connect-src 'none'`), the scripted topology
([`results/2026-11-15_pw-1.65.1/q1-*.txt`](results/2026-11-15_pw-1.65.1/)). Each cell: the realm's origin (**real**:
F's own origin, or opaque) and how many items of an origin's authority it reached, Chromium, Firefox, WebKit (of 17 a
document checks, 10 a worker does, the two requests among them; the top-level-keyed permission grant is counted apart,
below).

| Way F was opened | F | C | W_C (started by C) | W_F (started by F) |
| :--- | :--- | :--- | :--- | :--- |
| Top-level navigation | **real**: 12, 12, 11 | opaque: 0 | opaque: 0 | **real**: 7, 8, 6 |
| Popup opened by a cross-site page | **real**: 12, 12, 11 | opaque: 0 | opaque: 0 | **real**: 7, 8, 6 |
| Framed by `L`, `sandbox="allow-scripts"` (legitimate) | opaque: 0 | opaque: 0 | opaque: 0 | opaque: 0 |
| the same, `referrerpolicy="no-referrer"` | opaque: 0 | opaque: 0 | opaque: 0 | opaque: 0 |
| Framed by `L`, no attribute | **real**: 14, 14, 13 (`parent.document` among them) | opaque: 0 | opaque: 0 | **real**: 7, 8, 6 |
| Framed by `L`, `allow-scripts allow-same-origin` | **real**: 14, 14, 13 | opaque: 0 | opaque: 0 | **real**: 7, 8, 6 |
| Framed by `L2` (same site), no attribute | **real**: 12, 12, 7 | opaque: 0 | opaque: 0 | **real**: 7, 8, 3 |
| Framed by `I` (cross-site), no attribute | **real**: 11, 12, 5 | opaque: 0 | opaque: 0 | **real**: 7, 8, 3 |
| Framed by `I`, `allow-scripts allow-same-origin` | **real**: 11, 12, 5 | opaque: 0 | opaque: 0 | **real**: 7, 8, 3 |
| Framed by `I`, `sandbox="allow-scripts"` | opaque: 0 | opaque: 0 | opaque: 0 | opaque: 0 |
| the same, `referrerpolicy="no-referrer"` | opaque: 0 | opaque: 0 | opaque: 0 | opaque: 0 |
| Popup from `I`'s frame `sandbox="allow-scripts allow-popups"` | opaque: 0, 0, – | opaque: 0, 0, – | opaque: 0, 0, – | opaque: 0, 0, – (WebKit: the browser closed) |

- **What "reached" was, in the real-origin cells:** the host's cookies read and a cookie written, its `localStorage`
  value, `sessionStorage`, IndexedDB (opened, and `databases()` listed the host's), its cache (`caches.has` true), OPFS
  (Chromium, Firefox; WebKit threw `UnknownError`), Service Worker registrations (1, in documents; Firefox's worker too),
  Web Locks, a `BroadcastChannel` message the host's tab received, and, framed by `L`, `parent.document`. In the control
  policy the same realms' `fetch` and `XMLHttpRequest` to the origin were **read** (status 200) and carried all of the
  host's cookies. Cross-site framing without the attribute reached the origin's storage too on Chromium and Firefox
  (WebKit partitioned it: 5 items in F, no cookies, no database listed); Playwright's Chromium runs with
  `ThirdPartyStoragePartitioning` disabled (research 20's flag list), and Firefox's third-party settings under Playwright
  were not examined, so those cells say what these builds do, not what a shipping browser does (inferred; not measured).
- **C and W_C reached nothing of an origin, in every case on every engine:** every storage API threw `SecurityError`
  (Chromium's W_C has no `caches` at all: it is not a secure context, as research 27 Q4 found), the `BroadcastChannel`
  post went nowhere the host's tab could hear, `parent.document` and `top.document` threw, and `document.cookie` threw
  (Chromium, Firefox) or read `''` and kept nothing (WebKit). Two answers are not F's origin's but the **top-level
  page's**, and do not depend on how F was opened: Chromium's C read `granted` for the top-level origin's geolocation
  grant, and WebKit's W_C read `granted` (and could open a cache of its own opaque partition, which listed none of the
  host's). Research 27 Q4 found the same in `srcdoc` and in the served frame; sealed mode's worker gets no permission API
  for this reason, and the trampoline does not change it.
- **Requests from C and W_C, in the control policy** (where `connect-src` admits the origin): `Sec-Fetch-Site:
  cross-site`, unreadable (CORS), no cookies with the default credentials. A credentialed `no-cors` fetch carried the
  cookies the engine sends to a cross-site request: `hostnone` on Chromium; `hostdefault` and `hostnone` on Firefox;
  `hostlax` and `hostdefault` on WebKit (WebKit also refused to store the `Secure` cookie on `http://localhost`). So the
  opaque origin alone does not stop a credentialed request: `connect-src 'none'` does (under it nothing left any realm,
  on any engine), and that is what Q7's `connect` gate confirms.
- **The static variant** ([`q1s-*.txt`](results/2026-11-15_pw-1.65.1/)): C and W_C opaque and reaching nothing in all
  twelve cases on Chromium and Firefox and in eleven on WebKit (the browser closed in the sandboxed-popup case again),
  with F running no script.

### Q1b. What a self-check still buys

From the cells above and the variants' runs; "UI at the embedder's URL" means the attacker's text shown in C, in a
document whose address is F's (C's text was read in every case where C existed, on all three engines).

| F's self-check | Cases where C starts | What is left for an attacker who opens F the wrong way |
| :--- | :--- | :--- |
| none (scripted F) | all twelve | UI at the embedder's URL when F is top level (navigation, both popups); F's constant code runs with the embedder's origin in seven cases and handles the attacker's message, so it must never read or write anything origin-scoped, never make a request, never put message data into its own DOM or a parser, never start the worker; the content runs opaque |
| none (static F) | all twelve | UI at the embedder's URL when F is top level; nothing runs with the embedder's origin (F has no script; an attacker cannot add one to a static file) |
| `self.origin === 'null'` | the legitimate case, hostile sandboxed framing (×2), the sandboxed popup | UI at the embedder's URL in the sandboxed popup (opaque and top level); a hostile embedder that sandboxes F drives the library under an opaque origin (research 27 Q2) |
| also `top !== self` | the legitimate case and hostile sandboxed framing | a hostile embedder that sandboxes F, in a frame of its own page (the address bar is the attacker's); narrowed further where `location.ancestorOrigins` names the embedder (research 27 Q2: not on Firefox with `no-referrer`) |

The guarded static file measured the last row ([`q1g-*.txt`](results/2026-11-15_pw-1.65.1/)):

| F opened | C created? (Chromium 159, Firefox 159, WebKit 27.2; both policy variants) |
| :--- | :--- |
| framed `sandbox="allow-scripts"`, by the file's origin or by another site, with or without `no-referrer` | yes; C and W_C opaque |
| top level; popup of a cross-site page; framed without the attribute or with `allow-same-origin`, by any embedder | **no**: the guard read `stopped`, F had no child frame |
| popup from a cross-site sandboxed frame (opaque and top level) | **no** (WebKit's browser stayed connected: C, where the triage's trigger runs, never existed) |

On WebKit a frame that stops its own load keeps the embedding page's `load` from firing (the first run of the framed
cases timed out waiting for it; `results/2026-11-15_pw-1.65.1-superseded/q1g-webkit-framed-load.txt`); an embedder that
waits for `load` would wait forever there. Chromium's and Firefox's top-level stopped documents never fired `load`
either (the first run's top-level cases timed out; `-superseded/q1g-chromium.txt`).

### WebKit closes the browser in the sandboxed-popup case

The case "popup opened from a cross-site frame `sandbox="allow-scripts allow-popups"`" ended, on WebKit 27.2, with
Playwright reporting the browser context closed, in every run of the scripted and the static topology (4 of 4 runs with
the policy variants, and in the first runs, where it also ended every case after it). The triage
([`q1-webkit-popup.mjs`](q1-webkit-popup.mjs); [`q1w-webkit.txt`](results/2026-11-15_pw-1.65.1/q1w-webkit.txt), each step
in a browser of its own):

| Popup content (opened from the sandboxed frame) | WebKit 27.2 |
| :--- | :--- |
| a page with one script; one that starts a `blob:` worker; one that adds a sandboxed `srcdoc` child | ran, browser connected |
| F, with and without the init message (its checks run in F, C, W_C, W_F) | ran, browser connected |
| the same after a tab on F's origin set cookies, storage, a database and a cache, with and without a Service Worker registration | ran, browser connected |
| the same with **F's origin granted geolocation** (`grantPermissions`), with or without the seed tab | **the context closed** |

Chromium and Firefox ran every step (`q1w-all.txt`). So the trigger needs a geolocation grant on the file's origin
and the probe's checks (among them `permissions.query`) in an opaque top-level document; it was not narrowed further,
and whether it is a crash of WebKit's web process or of Playwright's WebKit is not known. The guarded file, which stops
before C exists, passed the case on WebKit. The library's sealed worker has no permission API, and no document of the
library's queries permissions; that the same could happen to a production page was not measured.

## Q2. A constant policy

F's `<meta>` ([`q2-constant-policy.mjs`](q2-constant-policy.mjs); [`q2-*.txt`](results/2026-11-15_pw-1.65.1/)):
`default-src 'none'; script-src <F> <C>; script-src-attr 'none'; style-src <still sheet> blob:; img-src blob:;
font-src blob:; media-src blob:; connect-src 'none'; worker-src blob:; frame-src 'none'; object-src 'none';
base-uri 'none'; form-action 'none'; manifest-src 'none'`, with `<base href="about:blank">` before it.

| In C (a `srcdoc` child of F), F framed sandboxed and F top level | Chromium 159 | Firefox 159 | WebKit 27.2 |
| :--- | :--- | :--- | :--- |
| C's bootstrap (by hash) / a second inline script (not listed) / an inline handler | ran / refused / refused | the same | the same |
| `eval` in C; in C's `blob:` worker | refused (`EvalError`); refused | the same | the same |
| the still sheet as a `<style>` by script (its hash listed) / another `<style>` | applied / refused | the same | the same |
| a CSSOM declaration; a constructed sheet; a `blob:` stylesheet `<link>` | applied; applied; applied | the same | the same |
| a `blob:` image / a `data:` image | loaded / refused | the same | the same |
| C's own `<meta>` `img-src 'none'` added (narrowing): the `blob:` image | refused | refused | refused |
| C's origin, URL, base URL | `null`, `about:srcdoc`, `about:blank` | the same | the same |
| F's origin (framed / top level) | `null` / the file's origin; C opaque either way | the same | the same |

External scripts, a page whose only script is `<script src="/ext.js">` (the same on Chromium 159, Firefox 159 and
WebKit 27.2):

| Policy | framed sandboxed (opaque) | top level |
| :--- | :--- | :--- |
| `script-src 'self'` | **ran** | ran |
| `script-src <the file's origin>` | ran | ran |
| `script-src <hash>`, `integrity`, `crossorigin` (response has `Access-Control-Allow-Origin: *`) | ran | ran |
| `script-src <hash>`, `integrity`, no `crossorigin` | **did not run** | ran |
| `script-src <hash>`, no `integrity` | did not run | did not run |

- **No part of the policy needs to be per load.** Today's sealed policy (`sealedViewPolicy`,
  [`csp-generator.ts`](../../../src/lib/csp/csp-generator.ts)) has two variable parts: the bootstrap's hash, constant per
  build of the library (`viewBootstrapHash()`, computed once per page from a constant text), and the `blob:` source of
  `style-src`, `img-src`, `font-src` and `media-src`, chosen per build from the registered files' types
  (`_sealedPolicy`, host.ts:1832; with `guestWrites`, `img-src blob:` always). It has no nonce. `style-src` carries
  `'unsafe-inline'` for the still sheet, which its hash replaces (applied above, on all three). The sandbox flags
  (`allow-scripts allow-forms`, plus `allow-orientation-lock` if configured) are an attribute, not policy.
- **The per-build part has two constant forms:** admit `blob:` for all four kinds always (the renderer's URL rule,
  `keepsUrl`, is then what keeps a kind with no registered file from loading: a check, not the policy), or keep F's text
  constant and let C carry the per-build narrowing as a `<meta>` of its own, which intersects (measured: refused on all
  three). C's document text then varies per build, but its script, and so its hash, does not.
- **Nothing measured needed to stay per load.** What cannot be static is only what is not policy: the worker source
  (the guest's entry and files) and the per-build marker (`entryDoneName`), both of which travel as data.
- **`'self'` does match when F is opaque**, on all three engines, against the expectation in the brief: for a served
  document the policy's `'self'` is the URL's origin, not the document's opaque origin (inferred from CSP3's "self-origin"
  rule; the library's generator avoids `'self'` because engines disagree on it in `srcdoc` documents, S14, which this does
  not test). A hash with `integrity` needs `crossorigin` and a CORS response when F is opaque (the request is
  cross-origin). An inline script by hash needs neither, and is what the constant policy uses.

## Q3. The channel

Today's topology (host > wrapper `srcdoc` > view `srcdoc` > `blob:` worker; the host posts the view its ports, as
`INIT_VIEW` does) against the scripted trampoline (host > F served > C `srcdoc` > worker; F hands both ports to C at C's
load, removes its listener, and then posts once on the port it transferred) ([`q3-channel.mjs`](q3-channel.mjs);
[`q3-*.txt`](results/2026-11-15_pw-1.65.1/)). Twelve runs per topology, alternating, each a fresh frame. Start-up: from
the iframe's insertion to the worker's `ready` on the host's port. Round trips: the mean of 200 sequential small
messages (50 of a 64 KiB string) on the host's port to the worker, and 200 on its port to the view, each timed as one
span; the table gives the median of the twelve runs' means (range). Load average 0.47–0.94.

| | Chromium 159 | Firefox 159 | WebKit 27.2 |
| :--- | :--- | :--- | :--- |
| start-up, today | 18.4 ms (15.2–46.8) | 37 (31–43) | 20 (14–31) |
| start-up, trampoline | 23.7 (20.5–29) | 40.5 (38–57) | 23 (17–33) |
| host ↔ worker, small, today / trampoline | 0.055 / 0.060 ms | 0.278 / 0.315 | 0.415 / 0.422 |
| host ↔ worker, 64 KiB, today / trampoline | 0.186 / 0.188 | 1.20 / 1.35 | 0.53 / 0.50 |
| host ↔ view, small, today / trampoline | 0.013 / 0.015 | 0.235 / 0.253 | 0.280 / 0.282 |
| F's post on the port it had transferred | – | – | – |
| … arrived at the host | never (12 of 12 runs) | never | never |

- **The host holds a port whose other end is in the worker, and one in C, in both topologies; nothing relays.** A
  transferred port is detached in the realm that sent it: F's later post on it went nowhere, on all three. So F is out
  of the path once it has handed the ports on; in the static form (Q1) it never had them (the host posts to C).
- **The round trip is the same** in both (the same hop: host ↔ worker), within the runs' spread on every engine.
- **The extra served document costs 3 to 5 ms of start-up** at the median (Chromium +5.3, Firefox +3.5, WebKit +3),
  one request for the file on a loopback server here; a real network adds the file's fetch, which the HTTP cache serves
  after the first (research 27 Q5).

## Q4. A file on another site

### (a) Policy and authority

- **Policy** ([`q4-policy.mjs`](q4-policy.mjs), research 27's probe content with the file on `I` and the host on `L`;
  [`q4p-*.txt`](results/2026-11-15_pw-1.65.1/)): under the host's strict header (`connect-src 'none'`, `worker-src 'none'`
  or `blob:`, `require-trusted-types-for`, `frame-src I`), the cross-site served frame, its `srcdoc` child and both
  workers ran every action the file's M-open `<meta>` admits (fetch, image, `<base>`, inline style, `eval`, a Trusted
  Types sink, a `blob:` worker) and were refused the canary by the `<meta>`, on all three engines; M-closed refused all of
  them by the `<meta>`. No violation of the served topology fired on the host page or reached the host's `report-uri`
  (the only host violations were the host's own control fetch and, on Firefox, its favicon). Today's `srcdoc` frame under
  the same host was refused every action by the host's policy (the control). The frame request was `Sec-Fetch-Site:
  cross-site`, with no `Referer` (`referrerpolicy="no-referrer"`).
- **Authority** ([`q4a-*.txt`](results/2026-11-15_pw-1.65.1/)): the twelve cases with the file on `I`. The shape is the
  table of Q1 cell for cell (C and W_C opaque and reaching nothing; F and W_F real in the seven cases without the attribute or with `allow-same-origin`), but
  F's real origin is now `I`, the file's host: a wrong-way opening reaches what that host holds and never the
  embedder's cookies, storage or `BroadcastChannel` (no message reached the `L` tab from any realm, in any case).
  The legitimate case is now the cross-site sandboxed one.

### (b) Process placement

One host page (`http://app.example.test:P`, reached through the server as a proxy) holds at once today's topology
(wrapper `srcdoc` > view `srcdoc` > worker), the served topology with F on the host's origin, on another site
(`http://127.0.0.1:P`) and on another registrable domain (`http://files.other.test:P`), each F > C > W with the
library's attributes on F's iframe (`sandbox="allow-scripts"`, `referrerpolicy="no-referrer"`), and a cross-site frame
without the attribute as the control site isolation exists for ([`q4-thread.mjs`](q4-thread.mjs);
[`q4b-*.txt`](results/2026-11-15_pw-1.65.1/)). The host runs a 10 ms interval for 2000 ms while the named realm loops
for 1200 ms; the cell is the host's longest gap in ms, median of 5 (range; the `fission.autostart` column's ranges are in its file). 1-minute load average 0.1 to 0.8 during
every run. Renderers on Chromium: the process whose CPU time rose while the frame looped (research 20 Q4's method).

| Busy realm | Shell, default | Shell, `--site-per-process` | Full, default | Full, `--site-per-process` | Firefox 159 | Firefox, `fission.autostart` | WebKit 27.2 |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none (idle) | 11 (10–15) | 15 (11–36) | 11 (11–15) | 23 (11–38) | 23 (13–57) | 11 (11–12) | 13 (12–14) |
| today's view (`srcdoc`) | **1200** (1200–1201) | 10 (10–57) | 11 (10–13) | 11 (10–15) | **1201** (1200–1202) | **1201** | **1210** (1200–1211) |
| today's worker | 11 (10–17) | 12 (10–51) | 15 (11–27) | 11 (10–18) | 19 (12–49) | 12 (11–17) | 12 (12–14) |
| F on the host's origin | **1200** (1200–1201) | 16 (10–21) | 13 (11–32) | 11 (10–12) | **1208** (1200–1210) | **1201** | **1211** (1200–1211) |
| its C | **1201** (1200–1201) | 14 (10–47) | 14 (10–46) | 10 (10–14) | **1202** (1199–1203) | **1200** | **1210** (1201–1210) |
| its W | 12 (10–16) | 11 (10–11) | 11 (11–15) | 28 (12–42) | 12 (12–20) | 12 | 14 (12–16) |
| F on another site | **1200** (1200–1201) | 11 (10–16) | 15 (11–46) | 11 (10–18) | **1201** (1199–1202) | **1201** | **1201** (1200–1211) |
| its C | **1201** (1200–1201) | 10 (10–45) | 11 (10–48) | 13 (10–15) | **1200** (1200–1204) | **1200** | **1209** (1201–1210) |
| its W | 11 (10–12) | 28 (10–48) | 10 (10–38) | 11 (10–18) | 13 (12–19) | 11 | 13 (13–13) |
| F on another registrable domain | **1200** (1200–1201) | 18 (10–30) | 14 (11–30) | 12 (10–14) | **1201** (1199–1211) | **1202** | **1200** (1200–1201) |
| its C | **1200** (1200–1201) | 11 (10–24) | 11 (10–15) | 10 (10–21) | **1202** (1201–1211) | **1201** | **1210** (1209–1210) |
| its W | 11 (11–13) | 11 (10–20) | 12 (11–28) | 11 (10–13) | 15 (12–26) | 12 | 15 (13–26) |
| control: cross-site frame, no `sandbox` | **1200** (1200–1201) | 14 (13–20) | 11 (10–17) | 10 (10–13) | **1201** (1200–1202) | **1201** | **1200** (1200–1211) |

| Chromium build, flags | Renderers with every frame present | Which renderer runs which frame |
| :--- | ---: | :--- |
| Shell, default | 1 | every frame in the host's renderer |
| Shell, `--site-per-process` | 6 (one not attributed to a frame) | the host's; one for today's view **and** the same-origin F and its C; one for the cross-site F and C; one for the other-domain F and C; one for the control |
| Full, default | 7 (two not attributed) | the same grouping as the shell with `--site-per-process` |
| Full, `--site-per-process` | 7 (two not attributed) | the same |

- **Where the frame runs is decided by the engine's process model, not by the file's site, on every engine measured.**
  The headless shell (site isolation off by default), Firefox under Playwright and WebKit ran every frame, the
  cross-site and other-domain F and C and the non-sandboxed cross-site control included, on the host page's thread: a
  loop in F or C stalled the host for its whole length. Full Chromium (default) and either build with
  `--site-per-process` ran every sandboxed frame out of the host's renderer, today's `srcdoc` view included, and the host
  timer was not stalled (medians 10–28 ms, idle included; single gaps up to 57 ms under the machine's load).
- **What a second hostname adds on Chromium with site isolation: its own process, apart from the host site's other
  sandboxed frames.** Sandboxed frames are grouped by the site of their URL: today's `srcdoc` view and an F on the host's
  origin shared one renderer; an F on another site, and one on another registrable domain, each got a renderer of its
  own. It does not give the host its thread back where it was not already given (today's view is already out of
  process there).
- **`fission.autostart` changed nothing under Playwright's Firefox**: the non-sandboxed cross-site control still shared
  the host's thread, so the pref did not turn on site isolation in this build (inferred from the control; Fission as
  shipped was not measured). The worker never stalled the host on any engine.

So a second hostname gives the embedder **no** availability by construction on Firefox and WebKit as measured here, and
on Chromium only what site isolation gives (which today's `srcdoc` view already has); its value is the authority one of
Q4a (a wrongly opened F holds the file host's origin, not the embedder's).

## Q5. A thin host: the host realm's passes over guest content (from the code)

Not a measurement: read from `HOST_PASSES` ([`src/lib/host-passes.ts`](../../../src/lib/host-passes.ts)) and the code its
rows name, at `298811d`. Every row whose `modes` include `sealed` is listed, and nothing else was found: the host-pass
test follows guest content from every entry (`GUEST_ENTRIES`, host-passes.ts:62-84) through the call graph and fails on a
function no row names. "Could move" means: into a realm of the served topology that runs only library code (F, C, or the
worker's prelude before the entry), so that the host realm forwards the guest's bytes as opaque data and validates typed
messages coming back.

| Row (host-passes.ts) | What it does with guest content, where | Could move? | Why, or what must stay |
| :--- | :--- | :--- | :--- |
| `configCopy` (:110) | `structuredClone` of the config, `sameData` compare (host.ts:802 `setConfig`, :443 `sameData`) | **stays** | The element's own state; a copy, no parse. It is the forwarding itself. |
| `configSchema` (:116) | `html`'s type and length, refused before it is stored (config-schema.ts:207 `htmlRefusal`, :522 `normaliseConfig`) | **stays** | A synchronous refusal to the embedder (`setConfig()` throws or warns) needs the host realm; it reads a type and a length, never the text. |
| `entryScan` (:127) | atob + TextDecoder + `dynamicImportAt` over the entry (host.ts:1804 `_buildRefusal`, entry-imports.ts:75) | **could move, or go** | Its reason is the inherited host policy: an `import()` would be checked against the host page's list and reported to its endpoint (BD6:ISO-2). In the served topology the worker's policy is the file's `<meta>` (Q4a, research 27 Q1), whose `report-uri` the engines ignore, so the reason disappears; what is left is a better error message, which C's or the worker's prelude can give (the build then fails asynchronously, with the same reason). |
| `fileStore` (:133) | path rules, quota, copies, encode, reference-graph order (files.ts:386 `FileStore`, :192 `checkPath`, :559 `snapshot`) | **stays** | The registry, its quota and `registerFiles()`'s synchronous `TypeError` are the embedder's API and state; paths and byte counts only. |
| `moduleRewrite` (:143) | es-module-lexer over a registered JS file, specifier edits (files.ts:735 `rewriteModule`, module-specifiers.ts:68) | **could move** | A lexer over guest JavaScript is the largest parser of guest text the host realm runs. Nothing it produces is acted on by the host: the edited bytes only travel to the worker. It can run in C or in the worker's prelude, on the bytes posted as data. |
| `stylesheetReferences` (:149) | the library's CSS tokenizer over a registered stylesheet (files.ts:701, css-references.ts:526) | **could move** | As `moduleRewrite`; it feeds `snapshot()`'s ordering, which can be done where the sheets are applied (C). |
| `viewStylesheets` (:155) | cuts every URL the view's rule does not keep (files.ts:801, css-references.ts:484 `keepsUrl`), warns | **could move; the warning's text comes back as typed data** | Its first reason (no report of the host page's names a guest URL, BD7:ISO-1) disappears with the served file; its second (no network URL is ever loaded in sealed mode) stays, and belongs in C, where the sheet is applied. The warning becomes a typed note C sends (a path and a count, as `VIEW_INITIAL`'s notes are). |
| `viewBuild` (:161) | concatenates the library's prelude, `toInlineScriptLiteral(files)` and the entry text into the worker's source (host.ts:1917 `_prepareViewFrame`, :1990 `_getStrictWorkerSource`, frame-documents.ts:89) | **could move** | The host realm builds code out of guest text today (as an escaped literal and an appended body). The same assembly can run in C's bootstrap from the entry and the files posted as data (C already mints the worker's `blob:` URL). The host then never handles guest text as code. |
| `policyFromKinds` (:172) | each file's type picks which directives admit `blob:` (host.ts:1832 `_sealedPolicy`, :1838 `_viewFileKinds`, csp-generator.ts:147) | **goes** | With a constant policy (Q2) there is no per-build policy; a per-build narrowing, if kept, is a `<meta>` C carries (Q2: it intersects). |
| `guestWrites` (:203) | path check, quota, record, a copy of an image's bytes to the view (host.ts:1009 `_handleGuestWrite`, guest-writes.ts:155) | **stays** | It updates the host's registry and quota and dispatches `fileswritten`; paths and counts only. |
| `rpcFrames` (:212) | the broker validates and measures every frame (host.ts:1390 `_onGuestMessage`, rpc.ts:306) | **stays** | This is the typed validation of what comes back: the host acts on it (it calls the embedder's methods), so the host must validate it itself. |
| `logLines` (:218), `violations` (:224), `viewFrames` (:230) | cut and measure log lines, violation reports, the view's frames (sandbox-log.ts:110, violation.ts:126, host.ts:1457 `_onViewMessage`) | **stay** | The same: data the host dispatches to the embedder, validated where it is dispatched. |
| `announcement` (:246) | a name looked up in the library's table (host.ts:1351) | **stays** | Constant work; the identity check (`source === guestWindowOf(iframe)`) is the host's. |
| `carried` (:252) | hands content on (INIT_VIEW, events, `setLibrarySrcdoc`) | **stays** (fewer) | `setLibrarySrcdoc` (trusted-types.ts:61) leaves: the host sets the frame's `src`, a URL, which no Trusted Types policy governs. |

So five rows can leave the host realm (`entryScan`, `moduleRewrite`, `stylesheetReferences`, `viewStylesheets`,
`viewBuild`) and one disappears (`policyFromKinds`). What must stay is the embedder's API and state (the config schema,
the file registry and its quota, guest writes) and the validation of every typed frame the host acts on (RPC, logs,
violations, the view's frames, the announcement). Two qualifications: (1) moving a pass out of the host **realm** moves it off
the host **thread** only where its new realm is on another thread: the worker is on every engine; F and C are on the host's
thread on the headless shell, Firefox and WebKit (Q4b), so a pass moved into C takes the realm out of the host page's
policy and Trusted Types but not its cost; (2) in the static topology F runs no script, so "into F" means into C or the
worker's prelude.

## Q6. What assumes `srcdoc`, and the spike

Read from the code at `298811d` (file:line):

| Where | What it assumes | In the static served topology |
| :--- | :--- | :--- |
| host.ts:1917-1950 (`_prepareViewFrame`) | the wrapper is an iframe whose `srcdoc` the element writes (`setLibrarySrcdoc`), holding the view document with the per-build policy | the wrapper becomes F, set by `src`; the per-build parts (policy, flags) must become constant or move into C (Q2) |
| frame-documents.ts:184-200 (`buildWrapperDocument`), :162 (`WRAPPER_PREFIX`), :18-22 (`WRAPPER_CSP`) | the wrapper is a string, with `frame-src 'none'` as its only directive because a srcdoc's policy binds its child | the same string as a static file works as it is (the Q6 spike), the policy then being F's own |
| frame-documents.ts:25-43 (`WRAPPER_BASE`), environment-check.ts:44-46 (`base` row) | the view takes its base URL (`about:blank`) from the wrapper's `<base>` | holds if F's `<base href="about:blank">` precedes its policy, or the policy admits `about:` in `base-uri` (Q2, the spike) |
| environment-check.ts:39-40 (`url` row, `about:srcdoc`), :32 (`origin` row) | every library document is a srcdoc with an opaque origin | holds for C (a srcdoc in F); F itself runs no bootstrap in the static topology, so nothing checks it but its own guard (Q1b) |
| host.ts:496-502 (`guestWindowOf`), :1359-1367 (`_listenForAnnouncement`), :1454 (INIT_VIEW to the view's window) | the view is the wrapper's `frames[0]`, posted to directly by the host | unchanged: C is F's `frames[0]` |
| trusted-types.ts:61-64 (`setLibrarySrcdoc`), host-passes.ts:278-302 (`LIBRARY_SINKS`), host.ts:1882 and :1894 (`_refuseByTrustedTypes`) | the wrapper is written through the library's Trusted Types policy, which the host page's `trusted-types` must name | no HTML sink in the host realm: `src` is not a Trusted Types sink; the host page's TT list stops mattering for the build |
| in-sandbox-view.ts:2283-2289 (still stylesheet), :4187-4193 (`buildViewDocument`) | the still stylesheet may be refused by the host page's inherited `style-src`; the view's policy is a `<meta>` in its srcdoc | the still sheet is admitted by its hash in F's constant policy (Q2); the view's `<meta>` becomes F's (or a narrowing in C) |
| worker-bootstrap.ts:22, reasons.ts:36-43 and :76, engine-ledger.ts:133 and :181, inherited-context.ts:3, :84, :147, :208 | texts and rows that explain an inheritance from the host page through srcdoc | rewritten: the policy rows (`cspPolicyText`, `cspReporting`, the host's Trusted Types) close by construction; permissions, secure context, thread and `ancestorOrigins` stay (research 27 Q4) |
| host.ts:1804-1810 (`_buildRefusal`, isolation) | a COEP host is refused before a frame exists | still needed and now also forced: a header-less file cannot load under COEP at all (research 27 Q4) |
| config (none today) | the library needs no URL of its own | a new option names F's URL (a public name: the owner's) |

### The spike ([`q6-spike.mjs`](q6-spike.mjs); [`q6-*.txt`](results/2026-11-15_pw-1.65.1/))

The library's default build as it is (`dist/index.js`, sha256 `f1a00b976f1c40a3…`), unmodified, loaded by a host page
that mounts `examples/sealed-app` through its own `host.js`. One shim in the host page, installed before the bundle:
when the library assigns an iframe's `srcdoc` (its one sink for the wrapper, `setLibrarySrcdoc`), the shim stores that
exact text on the server (a synchronous POST) and sets the iframe's `src` to it instead, at the host's origin, sent with
`Content-Type` only. So the browser loads the library's own wrapper (its `<meta>`, its `<base href="about:blank">`, the
view as a `srcdoc` child with the per-build policy and the hashed bootstrap) as a **served document**: the static
topology of Q1, with the library's code in C and W. The spike then calls `load` with two todos, types a third into the
view and presses Enter.

| Case | Chromium 159 | Firefox 159 | WebKit 27.2 |
| :--- | :--- | :--- | :--- |
| Served wrapper, host page with a strict policy (`default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self'; img-src 'self'; frame-src 'self'; worker-src 'none'; base-uri 'none'`) | **mounted**; the two todos shown; the typed one in the host's store; view `about:srcdoc`, origin `null`, base `about:blank`; no `violation`, no termination | the same | the same |
| Served wrapper, no host policy | the same | the same | the same |
| Control: today's `srcdoc` wrapper, the same strict host policy | **refused**: the host's `base-uri`, `style-src` and `script-src` refused the wrapper's `<base>`, its style and the bootstrap; the library ended the sandbox with its own reason ("the sandbox's startup script did not run: the host page's Content-Security-Policy must allow it") | refused, the same refusals | refused, the same refusals |
| Control: today's wrapper, no host policy | mounted, the same as served | the same | the same |

- **What broke: nothing the app or the element could see**, on any engine. The element's own identity checks
  (`guestWindowOf`: the wrapper's `frames[0]`), the environment check (`about:srcdoc`, `null`, `about:blank`, not
  isolated), the ports in `INIT_VIEW`, the view's renderer, the worker, guest writes and the RPC all ran unchanged.
- **What the spike does not show:** a design D8 can ship. The file here is the per-build wrapper (a new document per
  build, written by the host page through a test-only endpoint); the shipped form is one static file per library version
  with the constant policy of Q2, which this spike did not run. The host page's Trusted Types (a `srcdoc` sink today) and
  a host policy that does not admit `frame-src 'self'` were not tried. Firefox printed its warning about the shim's
  synchronous request (the shim's, not the library's).

## Q7. Start-up gates

Design under test ([`q7-gates.mjs`](q7-gates.mjs); [`q7-*.txt`](results/2026-11-15_pw-1.65.1/)): F runs its gates
first; only if all hold does it create C, which runs its own and only then starts W, which runs its own; F then posts
the host `passed` or `refused` with the names of the gates that did not hold. No guest content exists before
`passed`. Every canary's URL is `data:`, a `blob:` URL the realm minted, or `http://gate.invalid/` in a `<base>` (never
requested). F is framed `sandbox="allow-scripts"` in a 300×150 frame.

### The gates

| Guarantee | Canary | Realm | Observable as | Held on the correct file | A mutant trips it |
| :--- | :--- | :--- | :--- | :--- | :--- |
| the origin is opaque | `self.origin === 'null'` | F, C, W | a value | C F W | framed without `sandbox`; `allow-same-origin` (F) |
| F is framed (not top level) | `top !== self` | F | a value | C F W | not mutated here (Q1b: top level and popups) |
| no code from strings (`script-src` without `'unsafe-eval'`) | `new Function('')` throws | F, C, W | a thrown `EvalError` | C F W | `'unsafe-eval'` added; no `<meta>` |
| no connection (`connect-src 'none'`) | `fetch(<own blob: URL>)` rejects | F, C, W | a rejected promise | C F W | `connect-src * data: blob:`; no `<meta>` |
| no image but `blob:` (`img-src`) | a `data:` image fires `error` | F, C | the element's `error` event (a load event, fired by every engine) | C F W | `img-src * data:`; no `<meta>` |
| no inline style but the hashed one (`style-src`) | a `<style>` of other text does not apply | F, C | computed style (waits up to 1 s for one; none counts as broken) | C F W | `style-src 'unsafe-inline'`; no `<meta>` |
| no `<base>` (`base-uri 'none'`) | `<base href="http://gate.invalid/">` leaves `document.baseURI` | F, C | a value | C F W | `base-uri *`; no `<meta>` |
| no frame (`frame-src 'none'`) | a `data:` frame whose script posts back does not post within 800 ms | F, C | a message, or its absence | C F W | **no `<meta>` only**: with `frame-src * data:` alone the gate held; inferred: the `data:` document inherits F's policy, whose `script-src` refuses its script, so a loaded frame never posts either (blind) |
| no cookie (sandbox without `allow-same-origin`) | write a cookie of a fixed name; it throws, or is not kept | F, C | a thrown error or a value (WebKit's opaque `srcdoc` does not throw: it reads `''` and keeps nothing) | C F W | framed without `sandbox`; `allow-same-origin` (F) |
| no storage | `localStorage` (documents) / `indexedDB.open` (worker) throws | F, C, W | a thrown `SecurityError` | C F W | the same two (F) |
| no parent document | `parent.document` throws | F, C | a thrown `SecurityError` | C F W | the same two (F) |
| the worker reaches no network name | after the allowlist step, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts` are gone | W | `typeof` | C F W | the allowlist step skipped |

C, F, W: Chromium 159, Firefox 159, WebKit 27.2. With no `<meta>` at all, F's six policy gates fired (string code,
connect, image, style, base, frame) and F never created C, on all three. With F framed without `sandbox` or with
`allow-same-origin`, F's opaque, cookie, storage and parent gates fired, on all three.

### Mutants that no gate saw

| Mutant | Chromium, Firefox, WebKit | Why |
| :--- | :--- | :--- |
| `frame-src * data:` | passed | the frame canary's own script is refused by the inherited `script-src` (inferred), so a loaded frame and a refused one look alike; no canary that observes a frame's load without a script, an event or the network was found |
| `worker-src * data:` | passed | the library's worker is a `blob:` worker, which both admit; a `data:` worker is refused by origin rules whatever the policy, so it proves nothing; no canary distinguishes them |
| `default-src *` | passed | every directive is listed, so `default-src` is never read: a weaker one changes nothing the file does. Not a gap (the policy's shape makes it inert), but a gate cannot show it |

### Cost and what reaches an outside report-only policy

Start-up, from the host's insertion of F to F's answer, median of 12 (range), the variants alternating
(load average 0 to 0.56):

| | Chromium 159 | Firefox 159 | WebKit 27.2 |
| :--- | ---: | ---: | ---: |
| no gates (the same flow) | 22.9 ms (18–45) | 41 (35–52) | 17 (15–24) |
| every gate but the frame canary | 27.7 (25–41) | 45 (38–60) | 23 (20–34) |
| every gate | 1636 (1631–1644) | 1662 (1653–1668) | 1631 (1627–1635) |

The gates cost 4 to 6 ms at the median without the frame canary; the frame canary's two 800 ms waits (in F and in C)
are almost all of the full list's cost, for a gate no single-directive mutant trips.

Under an outside `Content-Security-Policy-Report-Only: default-src 'none'; report-uri …` on the file (research 27 Q3's
case), the gates still passed (report-only refuses nothing), and the site's endpoint received 15 reports (Chromium,
Firefox) or 6 (WebKit, none from C or W, as research 27 found). Their content: the directive (`script-src-elem`,
`script-src`, `connect-src`, `img-src`, `style-src-elem`, `frame-src`, and `worker-src` for the library's own `blob:`
worker), the blocked URI reduced to a scheme or keyword (`inline`, `eval`, `blob`, `data`, or empty), the document
(the file's URL, `about` for C, `blob` for W), and no sample (the outside policy had no `'report-sample'`; with it, the
samples would be the canaries' own fixed texts). Nothing of the guest's exists yet, and nothing but library strings and
the file's URL reached the endpoint. No canary made a request: the server saw none but the file (and Firefox's favicon
request of the top-level page) in any case.

### What a start-up gate cannot see

- **Guarantees with no canary that meets the three conditions:** `frame-src` alone (blind while `script-src` holds,
  above), `worker-src` (no observable difference for a `blob:` worker), `form-action` and `allow-top-navigation` (only a
  navigation shows them), `object-src`, `media-src` and `font-src` (a load's `error` event would do, as for `img-src`; not
  built here), `manifest-src`, and every directive whose refusal shows only as a `securitypolicyviolation` event (none in
  this list relies on one).
- **What changes after start-up:** a gate is a snapshot. A guarantee the browser enforces differently later (a policy
  added by navigation, an extension, a devtools override), or a bypass through an API no canary exercises (an engine bug
  in a path the canaries do not take), passes the gates and is not seen.
- **What the gates check is the browser, not the file's text.** The file's policy, the sandbox attribute C carries and
  the worker's placement are constants of the library's own file (Q1, Q2); the gates confirm the engine honours them, as
  defence in depth. They cannot stand in for the construction: a gate that every mutant trips still only proves what it
  provokes.

## What this means for D8

Each tightening, what was measured for it, and the rung its guarantee then stands on. Facts as measured on the three
engines named above; the choice is the owner's.

| Tightening | Verdict | Rung of its guarantee | Why |
| :--- | :--- | :--- | :--- |
| **Trampoline** (Q1, Q1b) | **adopt, with a change: F runs no script.** C is an element of F's static markup (as today's wrapper holds the view), with the `sandbox` attribute and no `allow-same-origin`; the worker is started by C; the host posts to `frames[0]` of F as it posts to the wrapper's today | **impossible to build**, for "guest content never runs with an origin's authority": the only document that could hold that authority (F) runs nothing, an attacker cannot add a script to a static file, and C's attribute is a byte of that file no embedder setting removes. Measured: C and W_C opaque and reaching nothing in every way of opening F, on all three (WebKit: eleven of twelve, its browser closing in the twelfth) | F's script, in the brief's form, ran with the embedder's origin in seven of the twelve cases and handled the attacker's message: safe only by a rule on what F's code may do (a check, at best). A worker started by F took the real origin and reached storage, caches and the host's `BroadcastChannel`: that placement must be impossible, and with no script in F it is |
| the residual "attacker content at the embedder's URL" (Q1b) | **adopt the guard as F's only script** (opaque and framed, then `window.stop()` before C's markup), or document it | **a check** (in F, before C exists); the URL itself stays a **documented limit** for hostile sandboxed framing, where the address bar is the attacker's | the guarded file created C only when framed sandboxed, on all three engines; it adds one hash-admitted script to F, which runs with the embedder's origin only to stop |
| **Constant policy** (Q2) | **adopt.** One `<meta>` text per library version: scripts by hash, the still sheet by hash, `blob:` for the four file kinds, `worker-src blob:`, the rest `'none'`; per-build narrowing, if kept, as a `<meta>` in C (it intersects) | **impossible to build** for the policy's text (one value, a file of the package; no input reaches it); per-build `blob:` kinds move down to **a check** (the renderer's `keepsUrl`) unless C carries the narrowing | measured on all three, F opaque and not; the only per-build part today is which kinds admit `blob:`; no nonce exists; `'self'` would work for an opaque F but is not needed |
| **Channel** (Q3) | **adopt** | **impossible to build** a relay: F has no script, so the ports go from the host to C directly (C is F's `frames[0]`) and C hands one to W; in the brief's scripted form, a port F transferred was detached and F's later post on it never arrived | the round trip is today's (measured), the start-up 3 to 5 ms more on loopback; the static form needs no relay code at all |
| **A file on another site** (Q4) | **adopt as an option for embedders who have a second hostname; do not require it** | **impossible to reach**, for the authority of a wrongly opened F: on another site it holds that host's origin, never the embedder's (Q4a, all three). **Not** a construction for availability: placement is the engine's process model's | a loop in F or C stalled the host for its whole length on the headless shell, Firefox and WebKit whatever F's site; on full Chromium every sandboxed frame, today's included, is already out of process. Q4a's policy independence held cross-site on all three |
| **Start-up gates** (Q7) | **adopt with a change: without the frame canary**, as defence in depth after the construction, never instead of it | **a check**, of the browser, not of the library's file | every gate fails closed under the mutant it provokes, on all three, for 4 to 6 ms; the frame canary is blind to its own directive and costs 1.6 s; `worker-src`, `frame-src`, `form-action` and top navigation have no canary that meets the conditions, and a gate sees nothing that changes after start-up |
| **Thin host** (Q5) | **adopt for the five passes that can leave** (entry scan, module rewrite, stylesheet scans and cut, worker-source assembly into C); keep the API state and the typed validation in the host | moves the guest's text out of the host realm (**impossible to reach** for a parser of the host's); the cost leaves the host's thread only for what moves into the worker | from the code; nothing measured |

**What the served topology still does not change** (research 27 Q4, confirmed here): the permission state keyed to the
top-level page (Chromium's C and WebKit's worker read the host's geolocation grant, in every way of opening F), the
secure-context bit, and, on the headless shell, Firefox and WebKit, the host's thread. **What it adds:** a URL any site
can frame (research 27 Q2), a framing requirement on the host's policy (research 27 Q1c), and the WebKit browser
closing in one wrong-way case (below Q1).

## Not measured

- Safari on macOS and iOS, Android, Firefox with Fission as shipped (the pref was set in Q4b; its effect on process
  placement was read only through the host's timer), Chromium's site isolation on Android.
- A shipping browser's third-party storage and cookie settings: Playwright's Chromium runs with
  `ThirdPartyStoragePartitioning` disabled, and Firefox's settings under Playwright were not examined, so the
  cross-site-without-attribute cells of Q1 say what these builds do (WebKit partitioned).
- The constant policy of Q2 in the library itself: the Q6 spike ran the library's per-build wrapper as a served file,
  not one static file per library version; a static F with the library's real bootstrap hash, still sheet and
  capability flags was not built.
- The host page's Trusted Types and a host policy without `frame-src` for the file, in the spike (research 27 Q1c
  measured the latter for plain HTML: an empty frame and a host-side violation).
- Navigation of a wrongly opened F or of C by its embedder (the embedder can always navigate a frame it holds;
  not tried), `document.domain`, and `allow-top-navigation` (Q7 has no canary for it that does not navigate).
- Why WebKit closed the browser in the sandboxed-popup case of Q1 beyond the triage's steps (a crash is suspected and
  not confirmed: Playwright reported the context closed).
- The window before F's `<meta>` applies (research 27 inferred it from research 11 and the file's shape; not provoked
  here either).
- Memory and the cost of the extra document beyond start-up time (Q3 measured start-up and round trips only).
- A real second hostname (a registrable domain the machine does not own): Q4 used `127.0.0.1` against `localhost` and,
  for placement, `files.other.test` against `app.example.test` through the server's proxy.

## Rerun

From the repository root, with Playwright's browsers installed (`PLAYWRIGHT_BROWSERS_PATH`). Each run writes
`results/<date>_pw-<Playwright version>/` (or the set named by `WEB_SANDBOX_RESULTS_SET`):

```
bun docs/research/28_served_topology/run.mjs                    # everything, one run per probe and engine
bun docs/research/28_served_topology/run.mjs q1 webkit          # one probe, one engine
WEB_SANDBOX_LOCK=/path/to/lock bun docs/research/28_served_topology/run.mjs   # each run under flock(1)
bun docs/research/28_served_topology/summarize.mjs 2026-11-15_pw-1.65.1 q1    # the compact view of Q1
bun docs/research/28_served_topology/q1-webkit-popup.mjs webkit               # the WebKit triage
```

Probes: `q1` [`q1-trampoline.mjs`](q1-trampoline.mjs) (Q1; `q4a` with `file-at-ip`, `q1s` with `static`, `q1g` with
`guarded`), `q2` [`q2-constant-policy.mjs`](q2-constant-policy.mjs), `q3` [`q3-channel.mjs`](q3-channel.mjs), `q4p`
[`q4-policy.mjs`](q4-policy.mjs), `q4b` [`q4-thread.mjs`](q4-thread.mjs), `q6` [`q6-spike.mjs`](q6-spike.mjs), `q7`
[`q7-gates.mjs`](q7-gates.mjs). The scripts are `.mjs`, not `*.spec.ts`, so the repository's Playwright configuration does
not run them with the suite. `q4-thread.mjs` reads the host page's timer as research 27's `q6-thread.mjs` does (a
standalone probe that reports a gap per run and bounds nothing), so it needs its entry in `OUTSIDE` of
`test/unit/host-share.test.ts`; no other script here reads a host timer.
