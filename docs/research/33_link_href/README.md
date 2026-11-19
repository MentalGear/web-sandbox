# Research 33: a listed link's real `href` in the view, and what the browser fetches before the click

**Question.** [02 · What an app hands over](../../design/02-what-an-app-hands-over.md#links-the-users-click-on-a-listed-link-opens-it)
lets an embedder list URLs (`links`); the view marks a link whose `href` is one of them, the user's click on it is the
request, and the host page opens the listed URL in a new tab. Today the marked link's `href` in the view stays inert
(`INERT_HREF`), and [05 · Build order](../../design/05-build-order.md) asks, under step 2: before 2.6 promises that a marked
link's `href` can be the listed URL, measure on three engines that a real `href` in the view fetches nothing on hover,
focus or pointer press (preconnect, prefetch, speculation). **Does it?** For each engine, with the link as the design
would write it (with and without `target="_blank" rel="noopener noreferrer"`), does anything reach the listed site when
the link is rendered, scrolled into view, hovered, focused, pressed, touched, or given a context menu; and what does a
guest add with `<link rel=…>`, speculation rules or `ping`, or the file's host with `Link` and `Speculation-Rules`
headers?

**Measured** on Playwright 1.65.1's builds on a shared 4-core VM, 2026-11-19: Chromium 159.0.8154.6 (the full build,
`channel: 'chromium'`, in new headless mode and headed under Xvfb; and the headless shell of the same revision),
Firefox 159.0 and WebKit 27.2 (WPE headless, GTK headed). No library code: plain HTML in a fixture of this folder. Raw
output is in [`results/`](results/README.md).

## Answer in brief

- **No. A real `href` in the view makes Chromium and Firefox reach the listed site before any click, so the `href`
  stays the inert one.** In the view as designed (two sandboxed frames, the `<meta>` policy with `default-src 'none'`
  and `connect-src 'none'`), with no guest code in the view and the click cancelled by the view:
  - **Chromium (full build): a pointer press on the link opens a TLS connection to the listed host** (its DNS lookup,
    then a ClientHello whose SNI is the listed host, 6 to 22 ms after `mousedown`): 8 of 8 trials of each link form,
    headless, headed, and with real X server input. **A touch start does the same** (8 of 8). The view's policy does not
    stop it; cancelling `pointerdown` and `mousedown` does not stop it; `target`/`rel` and `draggable` change nothing.
  - **Firefox: rendering the link resolves its host** (a DNS query for the listed name while the view loads; none for
    the inert link, and none for the same link in a top-level `https:` page), **a press resolves it again and opens a
    TLS connection** (9 to 26 ms after `mousedown`; the connection only once speculative connections are on, which
    Playwright turns off), and **a press held one second fetches the page itself**: a `GET` of the listed URL with
    `Sec-Fetch-Dest: document` and no `Sec-Fetch-User`, 1011 to 1062 ms after the press began, at Playwright's settings
    too. That fetch is Firefox's **link preview** on long press: it was gone with `browser.ml.linkPreview.enabled` off
    (run), and the build's defaults turn it on with a 1000 ms long press (read in its `defaults/preferences/firefox.js`).
    A 300 ms press fetched nothing. Cancelling `pointerdown`/`mousedown` removed the press connection, not the long-press
    fetch; cancelling `dragstart` and `draggable="false"` removed neither.
  - **WebKit (Playwright's WPE and GTK builds): nothing before the click**, in any phase, for any link form, headless,
    headed and with real input, and no DNS query.
  - **Hover (2 s at rest), scrolling into view, focus by Tab or by script, and the context menu reached nothing on any
    engine** (no connection, no request; Firefox's DNS query above is at render, before any of them).
- **The inert alternatives fetched nothing on any engine, in any configuration**: today's `href="about:blank#"` and a link
  with no `href` (a `data-` marker, `tabindex="0"`, `role="link"`, Enter handled by the view). No DNS query, no connection,
  no request before the click, and the click, handled by the view and opened by the host page, reached the listed URL in
  every trial.
- **Positive controls, per engine**: the click (cancelled by the view; the host page's
  `window.open(…, '_blank', 'noopener,noreferrer')`) reached the recorder as a `GET` of the listed URL in every trial whose
  view handled it, on Chromium (full build and shell), Firefox and WebKit, headless and headed; and in the DNS pass its
  lookup appeared on all three. The top-level control page showed each engine's preloading at all (Chromium's prefetch
  and speculation rules, Firefox's prefetch, WebKit's preconnect).
- **Playwright's defaults would have hidden most of it.** Chromium's press connection appeared only in a browser with a
  profile on disk (`launchPersistentContext`): Playwright's usual off-the-record context (`browser.newContext()`) and
  Chromium's headless shell (Playwright's default Chromium) showed none, nor any `<link rel=preconnect>`. Firefox's press
  connection appeared only with `network.http.speculative-parallel-limit` above 0 (Playwright sets 0). Playwright's two
  Chromium switches that look related (`--disable-field-trial-config`, `--disable-background-networking`) changed nothing
  here. Every "nothing" above is from the configurations that did show the effects.
- **What a guest could add in the view, whatever the `href`** (the view's renderer keeps these elements from existing;
  measured here as if it did not): `<link rel="preconnect">` connects at load on Chromium, Firefox (speculative
  connections on) and WebKit, under the view's policy: CSP does not govern a preconnect. `rel="dns-prefetch"` resolves
  the host at load on Chromium; `rel="prerender"` connects on Chromium. `rel="prefetch"` was refused by `default-src
  'none'` (Chromium, Firefox; WebKit fetched none even in the top-level page), inline speculation rules by `script-src`,
  and `ping` by `connect-src 'none'` (and the view cancels the click it rides on). With the rules' hash admitted (outside
  the design), they fetched nothing in the view's subframe.
- **What the file's host adds** (response headers on the served file: the host's, not the guest's): `Link: <…>;
  rel=preconnect` connects at load on all three engines (Chromium's full build, Firefox with speculative connections,
  WebKit), `Link: <…>; rel=prefetch` fetches the URL on Chromium (full and shell), `rel=dns-prefetch` resolves on
  Chromium; a `Speculation-Rules` header on the sandboxed file was not fetched.

## Method

### The fixture ([`fixture.mjs`](fixture.mjs))

- **Host page H** (`https://app.test:PORT/H.html`): a custom element with a closed shadow root holds
  `<iframe sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" src="F.html">` (F), as research 31's fixture
  frames the served file.
- **F**, the served file: its `<meta http-equiv="Content-Security-Policy">` first in `<head>`, then the guard, then the
  view **C** as `<iframe sandbox="allow-scripts allow-forms allow-orientation-lock" srcdoc="…">`. The `<meta>` is the
  design's constant text as [research 31's fixture](../31_served_startup/fixture.mjs) writes it
  ([03, "The policies in force"](../../design/03-served-document.md#the-policies-in-force)), with this fixture's hashes:
  `default-src 'none'; script-src <guard> <bootstrap>; script-src-attr 'none'; style-src <F's sheet> <C's sheet> blob:;
  img-src blob:; font-src blob:; media-src blob:; connect-src 'none'; worker-src blob:; frame-src 'none'; object-src
  'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'`. The referrer policy is the frame's `no-referrer`.
- **C** holds a tall spacer, the link below the fold, and a bootstrap (by hash) that cancels every click on a link and
  posts `{ ws: 'open', i: 0 }` to `parent.parent`, as the design's view sends a link's index; H then calls
  `window.open(links[0], '_blank', 'noopener,noreferrer')` with its own copy of the URL.
- **Layouts**: `view` (the above), `nometa` (F without its `<meta>`: what the sandbox alone does), and `open` (C's markup
  and bootstrap as a top-level page with no policy and no frame: what the engine does at all, the sensitivity control).
- **Every listed URL is on its trial's own host**, `t<n>.listed-r33.com` (on `listed.example` in the DNS pass), so a
  connection or a query names its trial by its name alone. Outside the DNS pass the name never resolves outside the
  browser (below).

**Cases** (the link form is C's markup):

| Case | The link, and what is around it |
| :--- | :--- |
| `plain` | `<a href="https://…/guide">` |
| `blank` | the same with `target="_blank" rel="noopener noreferrer"` |
| `inert` | `<a href="about:blank#" data-ws-link="0">`, today's `INERT_HREF` |
| `nohref` | `<a data-ws-link="0" tabindex="0" role="link">`, no `href` (Enter handled by the view's listener) |
| `*-nodrag`, `*-undraggable`, `*-nopress` | `plain` and `blank` with the view cancelling `dragstart` on links, with `draggable="false"`, or with the view cancelling `pointerdown` and `mousedown` on links (each listener a hashed script of its own) |
| `*-nohandler` | `plain` and `blank` without the view's click handler: the click is the browser's own navigation |
| `preconnect`, `dnsprefetch`, `prefetch`, `prerender` | `plain`, with `<link rel=…>` to the listed host in C's `<head>` |
| `specrules` | `plain`, with an inline `<script type="speculationrules">`: list rules (`immediate`) for two other paths on the host, and document rules for `https://host/*` at `moderate` (hover) and `conservative` (press) |
| `specrules-admitted` | the same with the rules' hash in the `<meta>`'s `script-src` (outside the design: what the rules do if admitted) |
| `ping`, `ping-nohandler` | `plain` with `ping="https://host/ping"` |
| `hdr-preconnect`, `hdr-dnsprefetch`, `hdr-prefetch`, `hdr-specrules` | `plain`, and on **F's response** (the file host's) `Link: <https://host>; rel=preconnect` (or `dns-prefetch`, or `<…/hdr-prefetch>; rel=prefetch`), or `Speculation-Rules: "/rules.json"` (served by the file host as `application/speculationrules+json`, the same rules); in `open`, on the page's own response |

### Phases ([`probe.mjs`](probe.mjs))

Each trial is a fresh browser with a fresh profile, and runs these phases in order, each a window of time; every
connection the recorder sees is filed under the phase in whose window it was accepted, with its offset from the phase's
start, and each request inside it with the phase it was sent in.

| Phase | What happens |
| :--- | :--- |
| `load`, `render` | the page loads; then 1.5 s with the link below the view's fold |
| `scroll` | the link scrolled into view, 2.5 s (viewport-based prefetch) |
| `hover` | the pointer moved onto the link (5 steps), rests 2 s, leaves (0.7 s) |
| `tab` | focus by keyboard: Tab from the host page until the link has focus, 1.2 s, then blur |
| `focus` | focus by script (`focus()`), 1.2 s, then blur |
| `press` | pointer down on the link, held 1 s (`--hold=ms` changes it) |
| `drag` | then moved away, off the link, and released in the view's document, 1 s: no click |
| `touch` | Chromium only (CDP `Input.dispatchTouchEvent` with touch emulation): a touch start on the link, 1 s, then a touch cancel |
| `context` | a right click on the link (the context menu), 1.2 s, then Escape |
| `click` | the positive control: a left click; the view cancels it and H opens the listed URL in a new tab |

A listener in C (installed by Playwright, outside the page's policy) records what reached the link (`pointerover`,
`pointerdown`, `focus`, `contextmenu`, `click`, `touchstart`, `dragstart`, …), so that a phase whose input never arrived
is not read as "nothing fetched". Every phase's input reached the link in every trial, except the Tab focus in one
Chromium trial of 160 (`inert`), the click of the `*-nohandler` cases (whose own navigation replaced or errored the view),
and the real click after the context menu phase in headed Chromium and WebKit (the native menu took the press; the
`*-real-press` sets repeat those without it).

### The recorder ([`recorder.mjs`](recorder.mjs))

One listener records every TCP connection when it is accepted, then classifies its first bytes: a `CONNECT host:port`
(recorded, answered `200`), a TLS ClientHello (its SNI and ALPN recorded), or a plain HTTP request. TLS is terminated
with a self-signed certificate made per run with `openssl` (the browser ignores certificate errors), so the request
inside is recorded too: method, path, `Sec-Purpose`/`Purpose`, `Sec-Fetch-*`, `Referer`, `Ping-To`. Every listed
response is `Connection: close`. The fixture's pages come from the same listener, on `app.test`. A connection that never
names a host is kept as `bare`: two were seen, at load in two Firefox trials through the proxy, and none in any direct run.

How the browser reaches it:

- **Chromium and Firefox: directly**, no proxy: Chromium maps the names to the listener with
  `--host-resolver-rules=MAP app.test 127.0.0.1, MAP *.listed-r33.com 127.0.0.1`, Firefox with
  `network.dns.forceResolve=127.0.0.1`, and every URL carries the listener's port. Through the listener as a proxy
  (`*-proxy-lite`), Chromium's results were the same, but Firefox's press connection and `<link rel=preconnect>` did not
  appear: a proxy would have hidden them.
- **WebKit: through the listener as its HTTP proxy** (`CONNECT`, then the tunnel's ClientHello and request), as research
  31 did; WebKit has neither switch. Its preconnect did reach the proxy (`<link rel=preconnect>` below).
- **DNS** ([`dns.mjs`](dns.mjs)): a separate pass with the listed names on `listed.example`, resolved for real by the
  browser, while `app.test` still reaches the listener (Chromium: a resolver rule for it alone; Firefox:
  `network.dns.localDomains`; WebKit: the proxy, bypassed for `*.listed.example`). The whole browser runs under
  `strace -f`; every datagram to port 53 that carries the trial's name in DNS wire format is a query, filed by its time.
  Connections to a resolver's port 853 or 443 (DNS over TLS or HTTPS) were looked for and none was seen. Names that
  named no trial: none.

### Configurations, and what Playwright's launch turns off

| Configuration | What it is |
| :--- | :--- |
| `chromium-on` | the full build, without Playwright's `--disable-field-trial-config` and `--disable-background-networking` (`ignoreDefaultArgs`) |
| `chromium-full` | the full build with Playwright's arguments |
| `chromium-shell` | the headless shell (Playwright's default Chromium), Playwright's arguments |
| `chromium-on --context` | `chromium-on` in off-the-record contexts of one browser (`browser.newContext()`, Playwright's usual way) |
| `firefox-on` | Playwright's prefs with `network.http.speculative-parallel-limit` at 6 |
| `firefox` | Playwright's prefs (`network.http.speculative-parallel-limit` 0) |
| `firefox-on-nopreview` | `firefox-on` with `browser.ml.linkPreview.enabled` false: the control of the long press |
| `webkit` | Playwright's WebKit; nothing changed |

Except `--context`, every trial is a browser of its own with a fresh profile on disk.

**Read, not run.** Playwright 1.65.1's Chromium switches (`chromiumSwitches.ts`, bundled in `playwright-core`) include
`--disable-field-trial-config`, `--disable-background-networking`, `--disable-component-update`, and
`--disable-features=…,OptimizationHints,PreconnectToSearch,…`; none names link preconnect or speculation rules. Its
Firefox `playwright.cfg` sets `network.http.speculative-parallel-limit` to 0 ("Disable speculative connections so they
are not reported as leaking") and nothing on prefetch, DNS prefetch or link preview. The Firefox build's own
`defaults/preferences/firefox.js` sets `network.http.speculative-parallel-limit` to 20 (this study turned it back on at
6, which showed the same connections), `network.prefetch-next` true, and `browser.ml.linkPreview.enabled` true,
`.longPress` true, `.longPressMs` 1000.

**Run.** The press connection on the full Chromium build appears with or without Playwright's two switches
(`chromium-full-lite`), only in a profile on disk (`chromium-on-context-lite`: nothing, `<link rel=preconnect>`
included), and never in the headless shell (`chromium-shell-full`: no press, touch or `<link rel=preconnect>` connection
in any layout).

**Headless and headed.** Everything headless; headed under Xvfb for the `lite` set on `chromium-on`, `firefox-on` and
`webkit`; and with **real pointer input** (`--real`: hover, press, drag and click as X server events through XTest,
[`xtest.py`](xtest.py), not Playwright's input protocol) on the same three, so that the press and drag paths are the
browser's own.

**Repetitions.** In `view`, 8 trials per link form and 3 per guest or header case, per configuration of the full plan;
2 in `open`, 1 in `nometa`; the other sets as in [`results/`](results/README.md). Every result below held in every trial
of its cell, unless a count says otherwise. The machine was shared and loaded (1-minute load 0.3 to 8.3, median 2.5,
during the full runs, two or three runs at a time): the results are the presence of connections, not times, and the only
time that decides one (Firefox's long press) was measured on its own at 300 and 2500 ms.

## Results

"TLS" is a connection whose ClientHello named the listed host, with no request in it before the click; "GET" a request
of the listed URL; "DNS" a query for the listed name (DNS pass). A dash is nothing, in every trial of the cell.

### Chromium 159

The link in the view, the full build (`chromium-on`, 8 trials per form; `chromium-full`, headed and real input 3 each,
the same cells):

| Phase | `plain`, `blank` (and `*-nodrag`, `*-undraggable`, `*-nopress`, `*-nohandler`) | `inert`, `nohref` |
| :--- | :--- | :--- |
| render, scroll into view | – | – |
| hover, 2 s | – (also with real input, and in `open`) | – |
| Tab, `focus()` | – | – |
| press | **TLS, 6–22 ms after `mousedown`**, and DNS (DNS pass) | – |
| touch start | **TLS, 5–66 ms after it** | – |
| drag and release off the link | – (the press's connection) | – |
| context menu (right button) | – | – |
| click (control) | GET of the listed URL in the host page's new tab | the same |

- **The same in `open`** (a top-level page with no policy) and `nometa`: the press connection is not a matter of the
  view's frames or policy.
- **The headless shell** (`chromium-shell`, the full plan): no connection before the click in any case of the link, in
  any layout. **An off-the-record context** of the full build: the same, nothing. **Through a proxy**: the same as direct.
- **Guest elements in the view** (3 trials each): `<link rel=preconnect>` TLS at load; `rel=prerender` TLS at load;
  `rel=dns-prefetch` DNS at load (DNS pass), no connection; `rel=prefetch` refused (`default-src 'none'`, console), no
  request; inline speculation rules refused (`script-src`, console); with their hash admitted, no rule's URL was
  requested and the press connection did not appear in those trials (the touch one did). `ping`: nothing (the view
  cancels the click); `ping-nohandler`: the click's navigation was refused by F's `frame-src 'none'` and the ping by
  `connect-src 'none'` (console), and the press connection still came. In `open`, the speculation rules' document rules
  connected on hover (`moderate`), the list rules at load, and Chromium refused the cross-site prerender (console); the
  prefetches did not complete a request against this fixture's certificate, so only their connections are counted.
- **The file host's headers**: `Link: rel=preconnect` TLS at load; `rel=prefetch` a `GET` with `Sec-Purpose: prefetch` at
  load (full build and shell); `rel=dns-prefetch` DNS at load (1 of 2 trials in the view, 1 of 1 in `open`); the
  `Speculation-Rules` header on the sandboxed F: its rules file was not requested (in `open` it was, and connected on
  hover).

### Firefox 159

The link in the view (`firefox-on`, 8 trials per form; `firefox`, `firefox-on-nopreview`, headed and real input 3 each):

| Phase | `plain`, `blank` (and `*-nodrag`, `*-undraggable`, `*-nohandler`) | `inert`, `nohref` |
| :--- | :--- | :--- |
| render | **DNS, while the view loads** (both configurations, DNS pass); none in `open` | – |
| scroll, hover, Tab, `focus()` | – | – |
| press | **TLS, 9–26 ms after `mousedown`** (`firefox-on`; not with Playwright's 0), and DNS (both) | – |
| press held 1 s | **GET of the listed URL, `Sec-Fetch-Dest: document`, 1011–1062 ms after the press began** (link preview), in every trial with a 1 s or 2.5 s hold, in both configurations, headed and with real input; none with `browser.ml.linkPreview.enabled` off; none with a 300 ms hold | – |
| drag and release | – (the long-press fetch lands at its start with a 1 s hold) | – |
| context menu | – | – |
| click (control) | GET in the new tab (on the press's connection, where there was one) | GET in the new tab |

- **`*-nopress`** (the view cancels `pointerdown` and `mousedown`, 5 trials): no press connection; the long-press `GET`
  in 5 of 5. **`*-undraggable`**, **`*-nodrag`**: both still.
- **Guest elements in the view**: `<link rel=preconnect>` TLS at load (`firefox-on` only); `rel=prefetch` refused by
  `default-src 'none'` (console); `prerender`, `dns-prefetch`, speculation rules (Firefox has none), `ping`: nothing more
  than the link itself. In `open`, `rel=prefetch` was fetched at load, marked as a prefetch in its request headers.
- **The file host's headers**: `Link: rel=preconnect` TLS at load (`firefox-on`), `rel=prefetch` TLS at load in 2 of 3
  view trials and a `GET` in `open`; `rel=dns-prefetch`, `Speculation-Rules`: nothing more.
- **Through a proxy**: the press connection and the preconnects did not appear (a bare connection at load in two
  trials); the long-press `GET` did.

### WebKit 27.2

The link in the view (`webkit`, 8 trials per form; headed and real input 3 each; DNS pass 2):

| Phase | every link form | `inert`, `nohref` |
| :--- | :--- | :--- |
| render, scroll, hover, Tab, `focus()`, press, drag, context menu | – (no DNS query either) | – |
| click (control) | GET in the new tab | the same |

- **Guest elements and headers**: `<link rel=preconnect>` and `Link: rel=preconnect` connected at load (a `CONNECT` to
  the listed host, in view, `nometa` and `open`, headless and headed; DNS in the DNS pass). Nothing else, not even in
  `open`: no prefetch, no prerender, no speculation rules, no DNS prefetch.
- Touch was not driven on WebKit (below).

### DNS

| Engine | real `href`, render | real `href`, press | inert, any phase | `<link rel=dns-prefetch>` / header | `<link rel=preconnect>` / header |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Chromium (`chromium-on`) | – | DNS (and touch start) | – | DNS at load | DNS at load |
| Firefox (`firefox-on`; `firefox`: the same) | **DNS at load in the view**, none in `open` | DNS | – | not told apart from the link's own | DNS at load |
| WebKit | – | – | – | – | DNS at load |

The click's lookup appeared in every trial on all three engines (the control). Every query went to the system resolver
over UDP (8.8.8.8 here); no engine used DNS over HTTPS or TLS in this environment.

## What this means for the design

- **May a marked link's `href` be the listed URL? No.** On Chromium a press or a touch start on it connects to the
  listed host, on Firefox its host is resolved when it renders, and a press connects and a one-second press fetches the
  page. None of these needs a click, and none is stopped by the view's policy, by cancelling the pointer events, or by
  `draggable`. The step 2.6 spec keeps the `href` inert (`INERT_HREF`, or no `href`), as today.
- **What each would carry.** The connections carry the listed host (DNS name, SNI), not the path; Firefox's long-press
  fetch carries the full listed URL. Each is a listed URL, never a guest string, so this is the `links` channel's own
  signal (which link, and when) arriving without the click that the design makes the request: a press, a touch, a
  render (Firefox's DNS). The app chooses which listed URL each link carries and can cover the view with one link, so a
  press anywhere in the view, a touch that starts a scroll, or merely showing the view (Firefox) would tell a listed
  host's resolver or server that the user is there. With the inert `href` nothing leaves before the click on any engine
  measured.
- **Conditions under which it could change, none of which holds today**: a view that receives no pointer press on a
  link at all (pointer events taken by an overlay the view owns, which would also take the link's hover and status-bar
  display, the reason to want a real `href`); and a browser where Firefox's link preview and anchor DNS prefetch do not
  apply to the view's document. Neither is measured here, and neither stops the status bar from showing an inert `href`.
- **The guest's elements matter more than the `href`.** `<link rel=preconnect>` and `rel=prerender` connect under the
  view's policy on Chromium, Firefox and WebKit, and `rel=dns-prefetch` resolves on Chromium: the view's renderer must
  keep never creating `<link>` elements, as it does, and keep `connect-src 'none'`, `default-src 'none'` and a hash-only
  `script-src` (which refused prefetch, ping and speculation rules here).
- **A note for the served file's host.** `Link` preconnect and prefetch headers on the file's response reach a listed
  site at every start, on every engine that preconnects; a `Speculation-Rules` header was not fetched for the sandboxed
  file. That is the embedder's own server configuration, not a guest's, and docs could say so.

## Not measured

- **Safari on macOS and iOS**: WebKit here is Playwright's WPE (headless) and GTK (headed) builds, with no
  `NSURLSession` preconnect, no Safari link previews (Force Touch, long press on iOS) and no Safari speculative loading.
- **Real Chrome** (Google Chrome, not Chromium) **with a signed-in profile, its "Preload pages" setting** (standard or
  extended), Finch field trials (Playwright's builds have no variations server), and Chrome's navigation predictor
  models; **real Firefox** with a user profile, other regions or locales for link preview (its `allowedLanguages` is
  `en`), and Firefox's own setting for it in the UI.
- **Android** (Chrome, WebView, Firefox) and every touch path but Chromium's CDP touch start: no touch on Firefox or
  WebKit, no long press by touch, no stylus.
- **Keyboard activation other than focus** (Enter or Space on a focused link before the click's handler), middle click
  and its `auxclick`, the status bar and "copy link address" (what the user sees is not a network question).
- **Extensions** (link checkers, password managers that look at links), enterprise policies, and DNS over HTTPS in
  automatic or secure mode (no engine used it here).
- **The library itself**: this is a fixture with the design's policy and frames; the renderer's own rules (which keep
  `<link>`, `<script>` and `ping` from existing) were not run.
- **HTTP/3 or QUIC** connections (the recorder speaks TLS over TCP only; an engine that raced QUIC would still have
  shown its TCP connection, and none was seen without one), and the `nometa` and `open` layouts at the full repetitions.

## Rerun

From the repository root, with Playwright's browsers installed (`PLAYWRIGHT_BROWSERS_PATH`), `openssl` on the path, and
for headed runs a display (`xvfb-run -a -s "-screen 0 1280x900x24"`); the DNS pass needs `strace` and sends real DNS
queries for `*.listed.example` to the system resolver. Each run takes its own free port.

```
node docs/research/33_link_href/probe.mjs chromium-on --plan=full > chromium-on-full.jsonl
node docs/research/33_link_href/probe.mjs chromium-shell --plan=full
node docs/research/33_link_href/probe.mjs firefox-on --plan=full
node docs/research/33_link_href/probe.mjs webkit --plan=full
node docs/research/33_link_href/probe.mjs chromium-full --plan=lite            # also: chromium-on --context, --via=proxy; firefox; firefox-on-nopreview
node docs/research/33_link_href/probe.mjs firefox-on --plan=guards             # also chromium-on, webkit
node docs/research/33_link_href/probe.mjs firefox --hold=2500 --cases=plain,blank,inert --layouts=view --reps=3 --only=press
xvfb-run -a -s "-screen 0 1280x900x24" node docs/research/33_link_href/probe.mjs firefox-on --headed --plan=lite
xvfb-run -a -s "-screen 0 1280x900x24" node docs/research/33_link_href/probe.mjs chromium-on --headed --real --plan=real --only=press
node docs/research/33_link_href/dns.mjs chromium-on chromium-on-dns --plan=dns  # also firefox-on, firefox, webkit
node docs/research/33_link_href/summarize.mjs --table docs/research/33_link_href/results/2026-11-19_pw-1.65.1/*.jsonl
```

The scripts are `.mjs`, not `*.spec.ts`, so the repository's Playwright configuration does not run them with the suite.
They read `Date.now()` to file connections by phase and bound nothing.
