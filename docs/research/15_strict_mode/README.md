# Research 15: Strict-mode probes, measured before building

*Dated 2026-10-13. Probes P1–P8 from the strict-mode design ("Probes before building"; the design is the
source for ADR-005). Measured in Chromium 141.0.7390.37, Firefox 146.0.1 and WebKit 26.0 under Playwright
1.58.1, on branch `local/strict-probes` from `bb5c5fb`. Every value below is asserted per engine by
[`probe.spec.ts`](probe.spec.ts), which passed with `--repeat-each 2` in each engine.*

## Summary

Most of the design holds. The hash-only `script-src` reaches every frame that guest markup can create, at
any depth, in all three engines. The worker starts under it and inherits it exactly. Scripts in moved
template content never run. With `form-action 'none'`, the wrapper's `frame-src 'none'` and a
`preventDefault` on links and submits, no navigation reaches the network.

Five assumptions do not hold as written:

1. **WebKit sends the host page's full URL as Referer when rendered markup asks for it** (P8). This
   covers path and query, goes to any `img-src` origin that is same-site with the host page, and works
   from the view and from a nested frame with `sandbox=""` forced on it. The design's "host origin
   only" (S15) is true only for cross-site targets.
2. **One render can block the host thread for more than a second in WebKit** (P7). Firefox and WebKit
   run the view on the host's thread. In WebKit a single 1 MiB render blocks the host for 1.2–1.6 s,
   even with only one render in flight. "Host round trips < 500 ms" and "watchdog bound holds
   everywhere" do not survive a render loop.
3. **A `<meta http-equiv="refresh">` in rendered markup navigates the view** (P4). Nothing can cancel
   it. In Chromium, any navigation of the view that the wrapper refuses replaces the view with
   `chrome-error://` and ends the worker with it.
4. **`document.importNode` of the template content runs scripts** (P6). In Chromium and WebKit the
   cloned SVG `<script>` elements run, including an SVG copy of the hash-admitted bootstrap.
   "Safe by construction" holds only because the renderer *moves* the fragment.
5. **The hash must cover the text as parsed, not as authored** (P2). CR, CR LF and NUL change during
   parsing.

There are also smaller per-engine differences. WebKit compiles WebAssembly in the worker without
`'unsafe-eval'` (P3). Worker violations are reported to the worker in Chromium, partly to the *view* in
Firefox, and not at all in WebKit (P3). Refusals inside frames created by guest markup never reach the
view (P1).

## Method

The design is not built, so the probes use no library code. [`harness.ts`](harness.ts) builds the
design's topology directly on a host page served by its own server ([`server.mjs`](server.mjs),
port 4466, [`playwright.config.ts`](playwright.config.ts)):

```
host.html (no CSP)
└─ wrapper  srcdoc, sandbox="allow-scripts allow-forms", CSP frame-src 'none', <base about:blank>,
            referrer no-referrer: a copy of buildWrapperDocument (src/lib/frame-documents.ts)
   └─ view  srcdoc: CSP <meta> (the design's view policy, script-src 'sha256-<bootstrap>') + bootstrap
      └─ worker  new Worker(blob:) from the posted source; logic port to the host, render port to the view
```

The bootstrap follows the design. It accepts one `INIT_VIEW` from `parent.parent`, spawns the worker
and forwards the ports. It applies `VIEW_RENDER` as follows: template → strip `<script>` → force
`sandbox=""` → `replaceChildren`, at most once per animation frame per target. It cancels link and
submit defaults. The research toggles arrive in `INIT_VIEW.opts`, so the bootstrap's text and hash never
change.

Evidence is collected as follows:

- **Script runs.** A marker array is read from every frame from outside: through Playwright's
  `page.frames()` in Firefox and WebKit, and through CDP in Chromium (see the note below). The view's
  `securitypolicyviolation` events are also read.
- **Inherited policy.** Each frame's effective policy is tested by inserting an inline `<script>`
  through its DOM. DevTools evaluation bypasses CSP, but the inserted element does not.
- **Network.** A loopback HTTPS listener records path and Referer. It is reachable as
  `https://127.0.0.1:<port>` (cross-site to the host) and as `https://localhost:<port>` (same host
  name). A loopback UDP listener serves as the STUN/TURN target. Every "nothing arrived" has a positive
  control that observes the same action when it is allowed.

**Note on Chromium and Playwright.** The sandboxed wrapper is an out-of-process iframe. Playwright 1.58
with Chromium 141 lists it with no children: `page.frames()` returns only the host and the wrapper.
CDP `Page.getFrameTree` on the out-of-process iframe's target lists the full tree, so for Chromium
`inFrames()` evaluates through a CDP session in each frame's default context. Trusted clicks use
`page.mouse` at fixed coordinates in all engines.

Run from the repository root (the root config lists these tests but skips them, since it has no server
on 4466):

```
PLAYWRIGHT_BROWSERS_PATH=<dir with firefox/webkit> bunx playwright test -c docs/research/15_strict_mode --repeat-each 2
```

## Findings

✓ = as the design assumes · ✗ = differs · values are what the spec asserts.

| Probe | Question | Chromium | Firefox | WebKit |
| :-- | :-- | :-- | :-- | :-- |
| **P1** | Hash-only `script-src` inherited by created frames (srcdoc, about:blank, `javascript:` src, nested ×3) | ✓ all 11 frames refuse an inline script | ✓ | ✓ |
| P1 | Inline `<script>`, `onerror`/`onload`/`ontoggle`, `javascript:` src / clicked link / meta refresh, in view and frames | ✓ none run | ✓ | ✓ |
| P1 | Hashed bootstrap copy in an unsandboxed created frame (child, grandchild, great-grandchild) | runs; gets no INIT; nothing reaches the host | same | same |
| P1 | … with forced `sandbox=""` | ✓ does not run | ✓ | ✓ |
| P1 | ICE probe in a created frame: UDP packets (host-page control) | 0 (control: 8) | 0 (control: 0, Firefox sends no loopback STUN even from the host) | 0 (control: 8) |
| P1 | Refusals inside created frames reported to the view | ✗ none; only the `javascript:` frame src (initiator) | ✗ none at all | ✗ as Chromium |
| **P2** | Hash over authored text: ASCII / non-ASCII / `<` `&amp;` `"` through srcdoc attribute decoding | ✓ match | ✓ | ✓ |
| P2 | Hash over authored text with CR LF, lone CR, NUL | ✗ refused (parser: CR→LF, NUL→U+FFFD) | ✗ | ✗ |
| P2 | Hash over the parsed text | ✓ all six run | ✓ | ✓ |
| **P3** | `new Worker(blob:)` under hash-only `script-src` + `worker-src blob:` | ✓ starts; `location` = `blob:null/…` | ✓ | ✓ |
| P3 | `importScripts(blob:)`, `importScripts(https:)`, `fetch` (default-src 'none') | ✓ NetworkError, NetworkError, TypeError; listener silent (control: all 3 arrive) | ✓ | ✓ |
| P3 | `eval`, `Function`, string `setTimeout` | ✓ EvalError, EvalError, not run | ✓ | ✓ |
| P3 | `WebAssembly.compile` / `new WebAssembly.Module` | ✓ CompileError | ✓ CompileError | ✗ **compiles** without `'unsafe-eval'` |
| P3 | `'unsafe-eval'` re-enables eval/Function/timers/wasm | ✓ | ✓ | ✓ |
| P3 | Nested `new Worker(blob:)` | admitted; inherits the policy → delete needed | same | same |
| P3 | `delete self.Worker` | ✓ gone, not on the prototype | ✓ | ✓ |
| P3 | `RTCPeerConnection` in the worker | ✓ absent | ✓ | ✓ |
| P3 | Where worker refusals are reported | worker: all 8 | worker: 6; **view**: the 2 `importScripts` | ✗ **nowhere** |
| **P4** | `submit` event without `allow-forms` | not dispatched | not dispatched | dispatched |
| P4 | `preventDefault` stops a link / a submit (unwrapped; controls reach the listener) | ✓ | ✓ | ✓ |
| P4 | `form-action 'none'` alone stops a submit | ✓ | ✓ | ✓ |
| P4 | `<meta http-equiv=refresh>` inserted from a template navigates | ✗ **yes** (control reached the listener) | ✗ yes | ✗ yes |
| P4 | Navigation of the view refused by the wrapper's `frame-src` (refresh, uncancelled link) | nothing leaves; ✗ **view → chrome-error, worker gone** | nothing leaves; view and worker intact | same as Firefox |
| **P5** | Worker-minted `blob:` image in the view, `img-src blob:` | loads (3×5), like a view-minted one | loads | loads |
| P5 | … without `blob:` in `img-src` | refused, reported to the view (`blockedURI` = `blob`) | refused, reported | refused, reported |
| **P6** | Template content moved in (`replaceChildren`), scripts not stripped: inline, hashed copy, SVG ×2; then re-inserted | ✓ none run, none even checked | ✓ | ✓ |
| P6 | `document.importNode(template.content, true)` | ✗ cloned **SVG** `<script>` is fresh: inline one refused, **hashed copy runs**; HTML ones stay inert | ✓ none run or are checked | ✗ as Chromium |
| **P7** | Burst of 200 × 1 MiB renders, no flow control: applied / max host lag / max worker round trip | 3–5 applies / ≤ 30 ms / 115–130 ms | 7–11 / 145–255 ms / **0.85–1.1 s** | 1–2 / **1.2–1.4 s** / **1.2–1.5 s** |
| P7 | One render in flight, 3 s: 1 MiB one word / 1 MiB markup / 64 KiB one word (max host lag) | ≤ 30 ms each | 180–255 / 210–265 / 15–55 ms | **1.2–1.6 s** / 0.3–0.43 s / 120–200 ms |
| P7 | Endless flood stopped by removing the frame: removal (host blocked) / host lag after | ≤ 21 ms / quiet | ≤ 15 ms / quiet | **0.17–2.7 s** / quiet |
| **P8** | Referer, markup asks nothing (inherited no-referrer) | ✓ none | ✓ none | ✓ none |
| P8 | Referer, `referrerpolicy=unsafe-url` or `<meta name=referrer>` in the view, or in a nested frame with/without forced `sandbox=""`: cross-site / same-site target | none / none | host origin / host origin | host origin / ✗ **full host URL incl. path and query** |
| P8 | Host-page control with `unsafe-url`: cross-site / same-site | full URL / full URL | origin / full URL | origin / full URL |

## Design assumptions

Ordered by importance. **Holds**, **holds with changes**, or **fails**, with the change needed.

1. **"Not guaranteed: image Referer host origin when markup asks unsafe-url (Firefox/WebKit, S15
   limit)"; G5 — fails in WebKit.** Rendered markup that asks for `unsafe-url` sends the host page's
   full URL (path and query) to any allowed origin that is same-site with the host page. It can ask
   with an attribute, a `<meta name=referrer>` in the view body, or a `<meta>` inside a nested srcdoc.
   Forcing `sandbox=""` on the frame changes nothing. Chromium sends nothing; Firefox sends the origin.
   Change: the renderer must neutralise referrer choices before insertion. It must remove
   `<meta name="referrer">` and remove or force `referrerpolicy="no-referrer"` on `a`, `area`, `img`,
   `iframe` and `link`. Because a nested srcdoc's own `<meta>` also works, it must also either
   apply the same rewrite to every `srcdoc` attribute recursively or drop `srcdoc`. Separately, the S15
   statement "never its path" was measured cross-site only. Re-check iframe and worker modes in WebKit
   against a same-site target, where guest script can set `referrerPolicy` itself.
2. **G3 "host can always stop the guest (watchdog bound holds everywhere)" and test (4) "host round
   trips < 500 ms" — fail under render load in WebKit (and in Firefox without flow control).** The
   1 MiB cap and once-per-frame coalescing do not bound host-thread cost:
   - Every queued 1 MiB message is still deserialised on the view's thread, which is the host's thread
     in Firefox and WebKit.
   - In WebKit, one apply of a 1 MiB single word stalls the host for 1.2–1.6 s, and removing a
     flooded frame stalled it for up to 2.7 s.
   - In Chromium the view is out of process: no measurable host cost.

   Stopping still works everywhere: removing the frame ends an endless flood. In WebKit, though, the
   removal itself blocked the host for 0.17–2.7 s.
   Changes:
   - Add flow control in the worker. `sandboxView.render` keeps the latest html per target and posts
     only after `VIEW_ACK` (one in flight). The render port must stay in a closure that guest code cannot
     reach.
   - Lower the cap well below 1 MiB. At 64 KiB the host lag was 15–55 ms in Firefox and 120–200 ms
     in WebKit for a worst-case single word.
   - Make the watchdog tolerate host stalls it did not cause. Judge the worker by the round trip only
     when the host's own timer was not late, or move "rendering cost on the host thread" into the
     watchdog's stated limits for WebKit.
   - Restate test (4) per engine.
3. **G4 "no navigation: wrapper frame-src, form-action 'none', view cancels link/submit defaults" —
   holds for egress, holds with changes for availability.** Nothing reached the listener in any wrapped
   case. However, a `<meta http-equiv="refresh">` inserted from the template does start a navigation in
   all engines, and it cannot be cancelled. In Chromium, any navigation of the view that the wrapper
   refuses (a refresh, or a link the view did not cancel) commits `chrome-error://` in place of the
   view, which ends the view and the worker. The wrapper does not reload, so the host gets no second
   `load` event. Changes:
   - The renderer removes `meta[http-equiv]` (at least `refresh`), and `meta` generally, from fragments.
   - Cancel `area[href]` and SVG `a` as well as `a[href]`. These were not probed, but they navigate the
     same way, and in Chromium an uncancelled navigation ends the view.
   - The host detects a dead view or worker through the watchdog or a view-port heartbeat and
     terminates with a reason.
4. **"Safe by construction: fragment scripts never run" — holds with changes.** Moving template content
   in never runs or even checks a script in any engine. That covers inline, SVG and the hash-admitted
   copy, including after re-insertion (P6). With `document.importNode(template.content, true)`, Chromium
   and WebKit make the cloned **SVG** `<script>` elements fresh. An inline one is then checked and
   refused, and an SVG copy of the hashed bootstrap **runs in the view**. Cloned HTML scripts stay inert,
   and Firefox runs none. Change: the renderer must move the fragment (never clone or import it) and keep
   stripping `script`, which matches SVG `script` too (measured: the design path leaves only the
   bootstrap's own element). A unit test should pin "no clone".
5. **Hash "over the UTF-8 of the exact script text" — holds with changes.** UTF-8 is right: non-ASCII,
   `<`, `&amp;` and quotes match through the srcdoc attribute decoding in all engines and on both
   delivery paths. But the browser hashes the *parsed* text: CR LF and lone CR become LF, and NUL becomes
   U+FFFD. Change: `script-hash.ts` hashes the normalised text, or the build asserts that the bootstrap
   contains no CR or NUL. Add a unit test with a CR LF bootstrap.
6. **G6 "view violation reports complete and unforgeable" and `detail.source: 'view' | 'logic'` —
   holds with changes.** The view's own refusals are reported. Refusals inside frames that guest markup
   creates are never reported to the view in any engine. The one exception is a `javascript:` frame
   `src`, which Chromium and WebKit report to the view as the initiator. Worker refusals are reported
   unevenly:
   - Chromium: all in the worker.
   - Firefox: the worker, except `importScripts` refusals, which fire in the view and would be
     labelled `source: 'view'`.
   - WebKit: nowhere.

   Change: scope G6 to the view document. State that created frames are silent, as the wrapper is. Make
   `source: 'logic'` best-effort and absent in WebKit, and branch test (8) per engine.
7. **P3 worker restrictions — holds with one change.** Under the hash-only policy:
   - The blob worker starts. It is checked against `worker-src`, not the script hashes.
   - It inherits the policy exactly: `fetch` is blocked by `default-src 'none'`, and a control with
     `connect-src` arrives.
   - `importScripts` (blob: and https:), `eval`, `Function` and string timers are refused.
   - `'unsafe-eval'` re-enables all of them.
   - A nested `new Worker(blob:)` is admitted and inherits the policy, so the planned `delete
     self.Worker` is needed. It works, and nothing on the prototype brings it back.
   - `RTCPeerConnection` is absent.

   **WebKit compiles WebAssembly without `'unsafe-eval'`.** Change: don't list
   "WebAssembly.compile refused" as an engine guarantee. If WebAssembly should be gated by
   `scriptUnsafe`, delete `WebAssembly` in the worker before guest code.
8. **"View creates its own blob URLs; no JS blobs in the view" — holds with a note.** A `blob:` URL the
   worker mints (same opaque origin) loads in the view whenever the matching directive allows `blob:`,
   in all engines. CSP cannot tell whose blob it is. Nothing executable can reach the view, because
   `blob:` is never in `script-src` and `frame-src` is `'none'`. But the view's media is not limited to
   registered files. If that matters, the renderer must only keep `blob:` URLs it minted itself.
9. **G2 / G4 "no WebRTC reachable" — holds.** The ICE probe inside a created frame never runs and sends
   0 UDP packets, while the host-page control reaches the loopback listener in Chromium and WebKit
   (8 packets). Firefox sends no loopback STUN even from the host page. The worker has no
   `RTCPeerConnection`.
10. **G1 "no guest script in any document … any depth", with forced `sandbox=""` — holds.** The
    inherited policy refuses every inline, handler and `javascript:` vector in every created frame,
    including about:blank, the `javascript:` frame and three levels of nesting. The only script that
    passes the hash is the bootstrap copy, and forced `sandbox=""` stops it. Without the forced sandbox
    the copy runs, gets no INIT, and nothing reaches the host (this is the research half of test (3)).
11. **`allow-forms` forced so `submit` reaches the view — holds.** Chromium and Firefox dispatch no
    `submit` without it; WebKit does anyway. `form-action 'none'` alone already stops the submission
    in all engines, and `preventDefault` alone stops links and submits.
12. **`frame-src 'none'` in the view — note.** It does not stop frames that are not fetched (srcdoc,
    about:blank, `javascript:`): all 11 were created. Only the forced `sandbox=""` and the inherited
    policy govern them, as the design already assumes.

## Files

- [`probe.spec.ts`](probe.spec.ts): P1–P8, one test each, with per-engine assertions and `MEASURED`
  log lines.
- [`harness.ts`](harness.ts): documents, bootstrap, worker prelude, frame readers (Playwright and
  CDP), HTTPS and UDP listeners.
- [`host.html`](host.html), [`server.mjs`](server.mjs), [`playwright.config.ts`](playwright.config.ts):
  host page, static server on 4466, config.
