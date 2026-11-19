# Research 30: the popup blocker and a host page that opens a link after the view's click

**Question.** A proposed option, not built: `config.links: Record<string, string>`, names mapped to exact `https:` URLs the
embedder lists. The guest's worker calls `sandboxView.open(name)` after the user clicks something in the view; the
request travels view → worker → host page, and the host page calls `window.open(url, '_blank', 'noopener,noreferrer')`.
Nothing in the view navigates. **Does the browser's popup blocker, switched on, let the host page open that tab?** The
click happened in a nested sandboxed frame; the host's `window.open` runs later, after hops over ports and a worker.

**Measured** on Playwright 1.65.1's builds, 2026-11-15: Chromium 159.0.8154.6 (the full build, `channel: 'chromium'`: new
headless, and headed under Xvfb; also the headless shell of the same revision), Firefox 159.0 and WebKit 27.2 (headless
is the WPE build, headed the GTK build). Variant 7 runs the default build bundled from `cd12c26`
(`bun scripts/build-lib.ts`, `dist/index.js`). Pages and the target are served from two loopback servers: the host page on
`localhost:18930`, the target on `127.0.0.1:18931` (two sites; its hits are the recorder). Raw output is in
[`results/`](results/README.md). Every cell is a count of runs, each run a fresh browser context and page.

## Answer in brief

- **Chromium 159 and Firefox 159: yes, within 5 s of the click, once per click.** With the blocker verifiably on, the
  host's `window.open` opened the tab in every run of every variant whose call came within 4.5 s of the click: from the
  host page's own click, from a click in a sandboxed `srcdoc` frame in a closed shadow root, from the library's
  host → wrapper → view shape, with a worker round trip, and in the real library in sealed mode (variants 1 to 7). It
  was blocked in every run whose call came 5 s or more after the click. A second `window.open` from the same click was
  blocked (the first consumes the activation); a second click opens one more.
- **WebKit: not measured, the blocker is off.** Playwright's WebKit builds (WPE headless and GTK headed) opened the
  negative control, a `window.open` from a timer with no gesture, in 5 of 5 runs, so each of its results is void. The
  same for Chromium's headless shell (negative control opened 5 of 5), which is why the Chromium figures are the full
  build's. Safari was not reachable here.
- **The window is the engine's transient user activation, host-wide.** Activation is set on the host page by a click
  anywhere in it, in the view included, and a request by the guest with no click is blocked: variant 8, the guest asks
  1 s after it starts and nobody clicked, 0 of 5 on Chromium and Firefox. But a click on the host page's background, or
  in the view off the button, followed 1.5 s later by the guest's request, opened the tab 5 of 5 on both (variants 9, 10).
  The blocker authorises a click, not "the click on this link": the guest picks the moment within the 5 s.
- **`navigator.userActivation.isActive` is not a reliable gate on Chromium.** In 10 of 495 click-driven requests the
  host read `isActive: false, hasBeenActive: false` when the request arrived, and `window.open` still opened the tab in
  all 10 (in 9 of them also when it called `window.open` in that same task, so the reading was false at the call). Firefox: 0 of 495.
- **The host cannot see a block.** With `noopener`, `window.open` returned `null` in every run, opened or blocked, on every
  engine. Only the tab (or its absence) tells.

## Method

One probe page per variant, [`probe.mjs`](probe.mjs), served by [`lib.mjs`](lib.mjs)'s two servers. The page is the host:
a box at (20, 20), 300 × 200, and the click is `page.mouse.click` at its middle: real input through each engine's
protocol, never `element.click()`. The tab is observed three ways, which agreed in every run (`tabs event agrees` in
[`results/summary.txt`](results/summary.txt)): the target's recorder server (a hit on `/target?id=…&n=…`), the context's
`page` event, and the host page's own report of each `window.open` call with `navigator.userActivation` read just before
and after it (where the engine has it).

- **Nothing is evaluated in the page between its load and the end of a run.** An evaluate can carry a user gesture
  (Playwright's does on Chromium), which would refresh the activation the probe measures. The page reports to the server
  by `fetch` from its own script, and the probe waits on the server's log.
- **The blocker on.** Chromium: Playwright starts it with `--disable-popup-blocking`; the launch passes
  `ignoreDefaultArgs: ['--disable-popup-blocking']` (the other default arguments stay). Firefox: Playwright's preference
  set has `dom.disable_open_during_load: false`; the launch sets it `true` through `firefoxUserPrefs`, with the release
  values of `dom.disable_open_click_delay` (1000), `dom.popup_maximum` (20), `dom.user_activation.transient.timeout`
  (5000) and `dom.popup_allowed_events` (written out in [`lib.mjs`](lib.mjs)). WebKit: neither the launch options nor the
  protocol has a popup setting, so its blocker is whatever the build does.
- **A negative control decides whether an engine is measurable** (variant 1neg): a timer 500 ms after load calls
  `window.open` with no click. An engine where it opens is void. **A positive control** (variant 1pos): a click on the
  host page's own box calls `window.open` synchronously.
- **Each run is a fresh context and page**, so no activation or popup count carries over.
- **Shapes** (the click is always in the innermost frame, which fills the same 300 × 200 box): `direct` (variant 2): one
  `sandbox="allow-scripts"` `srcdoc` frame in a closed shadow root, a `MessagePort` the host hands it, the frame posts
  `click` on it. `nested` (3): host → wrapper frame → view frame, both sandboxed `srcdoc`; the wrapper hands the
  host's port to the view. `worker` (4): as 3, with the view's port ending in a dedicated worker (a `blob:` worker the host
  starts) that relays on a second port to the host: view → worker → host, each over a `MessagePort`. 5: variant 4 with a
  `setTimeout` of the delay before the host calls `window.open` (0 is the request's own task). 6: variant 4 with two
  `window.open` calls from one click (back to back, and 100 ms apart), then a second real click (two calls again).
  7: the library, [`run-library.mjs`](run-library.mjs): sealed mode at its default configuration, a guest that renders a
  button, `sandboxView.on('click', 'go', …)`, and `bridge.call('openLink')` to a host method that calls `window.open`;
  the same delays and the twice-from-one-click case. 8 to 10: the guest's worker asks by itself on a timer, with no click
  (8), after a click on the host page's background (9), after a click inside the view off the button (10), and after a click
  that is 5.5 s old when the request arrives (`9late`).
- **Headless and headed.** All of it headless; headed under `xvfb-run -a` for the controls, 4, 5 at 3 s and 6 s and 6 on all three, and
  the library's 7, 7@6000, 7twice and 8 to 10 on Chromium and Firefox. The figures agree
  with the headless ones.

## Results

Cells are runs that opened a tab of the runs made. Chromium is the full build; WebKit and the headless shell are void
(their negative control opened), shown only for that. Variant 6's cells are tabs that opened per click, of two
`window.open` calls per click.

| Variant | Chromium 159 | Firefox 159 | WebKit 27.2 (blocker off) | Chromium headless shell (blocker off) |
| :--- | :--- | :--- | :--- | :--- |
| 1neg, `window.open` from a timer, no gesture (negative control) | **0 of 5** (blocked; 0 of 5 headed) | **0 of 5** (blocked; 0 of 5 headed) | **5 of 5: VOID** (5 of 5 headed) | **5 of 5: VOID** |
| 1pos, `window.open` in the click handler of the host page (positive control) | 5 of 5 (5 of 5 headed) | 5 of 5 (5 of 5 headed) | 5 of 5, void | 5 of 5, void |
| 1async, click in the host page, open 100 ms later | 5 of 5 | 5 of 5 | void | void |
| 2, frame in a closed shadow root → port → host | 5 of 5; 50 of 50 on a second run | 5 of 5; 50 of 50 | void | void |
| 3, host → wrapper → view → port → host | 5 of 5; 50 of 50 | 5 of 5; 50 of 50 | void | void |
| 4, view → worker → host | 5 of 5; 100 of 100 (5 of 5 headed) | 5 of 5; 100 of 100 (5 of 5 headed) | void | void |
| 5, as 4, the host opens after 0 ms | 5 of 5 | 5 of 5 | void | void |
| 5, after 10 ms; 50 ms | 50 of 50; 50 of 50 | 50 of 50; 50 of 50 | not run | not run |
| 5, after 100 ms | 5 of 5 | 5 of 5 | void | void |
| 5, after 500 ms | 5 of 5 | 5 of 5 | void | void |
| 5, after 1 s | 5 of 5 | 5 of 5 | void | void |
| 5, after 3 s | 5 of 5 (5 of 5 headed) | 5 of 5 (5 of 5 headed) | void (5 of 5 headed) | void |
| 5, after 4 s | 10 of 10 | 10 of 10 | not run | not run |
| 5, after 4.5 s | 10 of 10 | 10 of 10 | not run | not run |
| 5, after 5 s | **0 of 10** | **0 of 10** | not run | not run |
| 5, after 5.5 s | **0 of 10** | **0 of 10** | not run | not run |
| 5, after 6 s | **0 of 5** (0 of 5 headed) | **0 of 5** (0 of 5 headed) | 5 of 5, void | 5 of 5, void |
| 6, two calls from one click, back to back; then a second click | 1 then 1 tab, 5 of 5 runs (headed 1 then 1, 5 of 5) | 1 then 1, 5 of 5 (headed 1 then 1) | 2 then 2, void | 2 then 2, void |
| 6, two calls 100 ms apart; then a second click | 1 then 1, 5 of 5 | 1 then 1, 5 of 5 | 2 then 2, void | 2 then 2, void |
| 7, the library, sealed, default build | 5 of 5 (5 of 5 headed) | 5 of 5 (5 of 5 headed) | 5 of 5, void | 5 of 5, void |
| 7, host opens after 0.5 s; 1 s; 3 s | 5 of 5 each | 5 of 5 each | void | void |
| 7, host opens after 6 s | **0 of 5** (0 of 5 headed) | **0 of 5** (0 of 5 headed) | 5 of 5, void | 5 of 5, void |
| 7, two calls from one click; then a second click | 1 then 1, 5 of 5 (headed 1 then 1) | 1 then 1, 5 of 5 (headed 1 then 1) | 2 then 2, void | 2 then 2, void |
| 8, the guest asks 1 s after it starts, no click | **0 of 5** (0 of 5 headed) | **0 of 5** (0 of 5 headed) | 5 of 5, void | not run |
| 9, a click on the host page's background, the guest asks about 1.5 s later | 5 of 5 (5 of 5 headed) | 5 of 5 (5 of 5 headed) | 5 of 5, void | not run |
| 10, a click in the view off the button, the guest asks about 1.5 s later | 5 of 5 (5 of 5 headed) | 5 of 5 (5 of 5 headed) | 5 of 5, void | not run |
| `9late`, the click is 5.5 s old when the guest asks | **0 of 5** (0 of 5 headed) | **0 of 5** (0 of 5 headed) | 5 of 5, void | not run |

Both measurable engines expire the activation at 5 s: 4.5 s opened, 5.0 s did not, counted from the click event in the
view (Firefox's `dom.user_activation.transient.timeout` was set to its release value, 5000). The hops cost, from the
view's `click` event to the host's call in the request's own task (variants 1pos, 2, 3, 4, 5@0, 5@10 and the library, 295
runs per engine): on Chromium 10 to 29 ms (median 14), on Firefox 23 to 209 ms (median 33, 95th percentile 44); the 5 s
window leaves them no weight.

### What the host reads

- **`navigator.userActivation` at the request.** Chromium: `isActive: true` at the request in 485 of 495 click-driven
  requests, `false, false` in 10 (variant 2 four times, 3 once, 4 twice, 5@50, 5@1000 and 5@4000 once each), all of which opened the tab, so the host's own
  view of the activation lags the one `window.open` is checked against (the cause was not examined). A host that refused when `isActive` is false
  would have refused 2% of clicks that would have opened. Firefox: true in all 495.
- **`window.open` consumes the activation** on Chromium and Firefox: `isActive` was false right after the call in every
  opened run. This is why the second call is blocked (variant 6): the tab is one per click, whichever way the two calls
  are spaced. A second click gave one tab again. (WebKit's build left `isActive` true after the call; its blocker is off,
  so this says nothing about Safari.)
- **`window.open(url, '_blank', 'noopener,noreferrer')` returned `null`** in every run on every engine, opened or blocked.

## What this means for `config.links`

- **It works on Chromium and Firefox with no help from the view**: the open can be the host's `window.open` in the handler
  of the guest's request, with nothing navigating in the view. The hops are tens of milliseconds, so no special path is
  needed to carry the gesture.
- **The host must call `window.open` within 5 s of the click, and should call it in the request's own task.** A handler
  that awaits something of its own first (a lookup, a confirmation of the embedder's) spends the window; one that
  waits for 5 s opens nothing, silently. A guest cannot make the host wait longer than the click allows, and a guest that
  delays its own request only loses the tab.
- **One request, one tab.** A second `window.open` from the same click is blocked on both, however it is spaced; a
  guest that asks twice gets one tab, and the library need not count requests to keep the blocker's guarantee. A second
  tab needs a second click.
- **Without a click the guest cannot open a tab** (variant 8), and a click 5.5 s old does not authorise one
  (`9late`). But the click that authorises it is any click on the host page or in the view (9, 10), not a click on the
  thing the user meant: within 5 s of a click anywhere, a guest can send the user to any URL of `config.links`. The URLs
  are the embedder's own list, so this is a choice among them, at a time the guest picks. If that matters, the host can
  narrow it by construction, not by the blocker: accept `open(name)` only for a request that arrives within a bound of a
  `click` the view forwarded for that name (the library sees the click and the request, and the 5 s above is the ceiling,
  not the aim).
- **A block is silent.** The host sees no failure with `noopener`, and `isActive` is not a reliable check (Chromium reads
  `false` in about 2% of clicks that open). A design that must tell the user "the browser blocked the tab" has to observe
  the tab by another means; this study did not look for one that works with `noopener`.
- **The blocker's setting is the user's.** This measures a blocker at its defaults. A user who has set a browser to block
  all popups, or an extension that does, can still stop it.

## Not measured

- **Safari on macOS and iOS, and any WebKit with the blocker on.** Playwright's WebKit (WPE headless, GTK headed) does not
  block popups, so nothing about WebKit's activation window, its consumption by `window.open` or its propagation through
  `postMessage` and ports is known. `node docs/research/30_links_popup/probe.mjs --serve-only` serves every variant's page
  on `localhost:18930` and prints each report and hit as it arrives, for a person on a Mac: click the blue box of each page
  with a real mouse; the controls are `1neg` (must not open) and `1pos` (must), and a page whose `1neg` opens is void.
- **Chromium's headless shell, and any engine where the negative control opened**: void, as the table says.
- **Touch input, keyboard activation (Enter or Space on a button in the view), and pointer types other than the mouse.**
- **A browser setting that blocks all popups, extensions, enterprise policy**, and Firefox or Chromium with a profile of
  real use (a site's popup permission, which opens popups without a gesture, is a user choice not simulated).
- **`window.open` without `noopener`** (it returns a window or `null`, which would tell a block, but gives the opened tab
  an `opener` the library would then have to clear), a confirmation dialog (`confirm()`) or an `await` of the host's own
  between the request and the call, and clicks on a host page whose frame tree is deeper or process-separated than the
  shapes here.
- **Cross-site isolation variants of the host** (COOP, COEP), a realistic host page's CSP or Trusted Types (this host is
  plain HTML).
- **The activation of a page in the background**, other tabs of the window and the popup-count limits of a long session:
  each run is a fresh context and one tab.
- **Why Chromium reads `isActive` false early, and why `window.open` opens anyway.** Only the readings are stated.

## Rerun

From the repository root, with Playwright's browsers installed (`PLAYWRIGHT_BROWSERS_PATH`); headed runs need a display
(`xvfb-run -a`). The ports 18930 and 18931 must be free, so run one at a time:

```
node docs/research/30_links_popup/probe.mjs --engine=chromium,firefox,webkit --reps=5   # variants 1 to 6, the engines' own settings as above
node docs/research/30_links_popup/probe.mjs --engine=chromium --reps=10 --variants=5@4000,5@4500,5@5000,5@5500
node docs/research/30_links_popup/probe.mjs --engine=chromium --reps=100 --tail=500 --variants=4
xvfb-run -a node docs/research/30_links_popup/probe.mjs --headed --engine=chromium,firefox
bun scripts/build-lib.ts                                   # dist/index.js, the default build
node docs/research/30_links_popup/run-library.mjs --dist=dist --engine=chromium,firefox
node docs/research/30_links_popup/summarize.mjs docs/research/30_links_popup/results/*.jsonl
```

`--engine=shell` is Chromium's headless shell. The scripts are `.mjs`, not `*.spec.ts`, so the repository's Playwright
configuration does not run them with the suite. They read `Date.now()` to report the time from a click to a call, and
bound nothing, and `test/unit/host-share.test.ts` does not flag them.
