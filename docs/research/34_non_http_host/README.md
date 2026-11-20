# Research 34: the served document on a host page that is not on `http(s)`

**Question (decision 3 of [the design's index](../../design/README.md#decided-after-review-2-and-the-first-two-steps)).** The served document of
[03](../../design/03-served-document.md) frames a static file F from `documentUrl`; F's `<meta>` holds the policy, its
one script is the guard, its static markup holds the view C, and C starts the guest's worker from a `blob:`. 03
("Schemes") says a host page that is not on `http:` or `https:` "has no URL to serve the file from", and that whether
the file can be admitted from the host page's own scheme is not measured. This note measures it, for three kinds of host
page, with F beside the page on the page's own scheme and, separately, with `documentUrl` on an `http` copy on another
site:

1. Does the frame load F, is F opaque, does the guard let C be built, is C opaque, does the worker start from its
   `blob:` URL, and do the ports connect, the view speaking first?
2. Does F's `<meta>` hold there as on `http(s)` (research 31's gates and policy check), and does anything of the host
   scheme's own rules add a policy to F?
3. Can the host page read F's bytes for [the check of the file](../../design/03-served-document.md#the-check-of-the-file),
   and is `crypto.subtle` there?
4. What does the guest reach there that it does not reach on `http(s)`: from C and from the worker, `fetch`, XHR,
   `<img>`, `<script>` and `importScripts()` of the host page's sibling files or of an extension's resources, each with
   a positive control?

And the baseline of what the limit would cost: does today's default build (`dist/`, sealed mode in a `srcdoc` view) run
an app on each of these host pages?

**Measured** on a shared 4-core VM, 2026-11-19, from `adb22b4`, with Playwright 1.65.1: Chromium 159.0.8154.6 (the
headless shell, and the full build in new headless mode where named), Firefox 159.0, WebKit 27.2, and Electron 45.4.1
(Chromium 156.0.8078.100) under Xvfb. The fixture is research 31's (its `<meta>`, guard, gates and policy check, in the
order where the view speaks first), with no library code; the baseline runs the real default build. Raw output is in
[`results/`](results/README.md).

## Answer in brief

- **`file:` (Chromium, Firefox, WebKit): the design works with F beside the page, and the guard does not.** On all three
  engines a `file:` host page framed `file:` F sandboxed; F and C were opaque, the worker started from `blob:`, the
  ports connected with the view speaking first, every gate held and the policy check was clean, and no policy of the
  scheme's own was added to F (no foreign event). **But a `file:` document's `self.origin` is `"null"` whether or not it
  is sandboxed**, on all three engines, so the guard (`self.origin !== 'null'` → `window.stop()`) let C be built with F
  framed without `sandbox` and with `allow-same-origin`, and C received the port. On Firefox the host page could then
  read F's document (`contentDocument`): F was in the host page's origin. On Chromium and WebKit it could not. With
  `--allow-file-access-from-files`, Chromium serialises a `file:` origin as `file://` and the guard stopped F. I14 does
  not hold on `file:`.
- **The check of the file on `file:`**: Firefox's host page read F (`fetch` and XHR, digest equal); Chromium's and
  WebKit's could not read it at all (`fetch` and XHR fail), so there is no check of the file there. With `documentUrl`
  on an `http` copy that sends `Access-Control-Allow-Origin: *`, all three read it and the digest matched (a `file:`
  page's requests carry `Origin: null`); without the header, none could. `crypto.subtle` was present in the `file:` host
  page and in C (a `file:` page is a secure context) on all three.
- **An extension's page (Chromium 159, MV3): F does not run as an ordinary or web-accessible resource.** The extension's
  policy (MV3's default `script-src 'self'`) applies to F and refuses its inline guard, diagnostic and C's bootstrap: no
  script of F's or C's ran, and the host page heard nothing. An `extension_pages` policy that admits the three scripts by
  hash made Chromium refuse the extension (its page answered `ERR_BLOCKED_BY_CLIENT`). As a **`sandbox` page** under the
  default sandbox policy, F and C ran, but that policy's `child-src 'self'` refused the `blob:` worker: the check saw a
  foreign policy (4 events) and the host page refused it. With the manifest's sandbox policy narrowed to
  `sandbox allow-scripts allow-forms`, everything worked as on `http`, with a clean check. **There C and its worker read
  every resource of their own extension** (`fetch`, XHR, `<img>`, `<script>`, `importScripts()`; not web-accessible
  ones included), **under F's `<meta>`** (`connect-src 'none'`, `img-src blob:`, `script-src` by hash), which still
  refused the `http` targets in the same run: on Chromium, the extension's scheme passes the page's CSP.
- **Any page in a profile with an extension (Chromium):** a view under F's `<meta>`, in every host kind tried
  (`http`, extension pages, F on `http` inside an extension page), read another extension's **web-accessible**
  resources with `fetch` and XHR, from C and from the worker. Not-web-accessible ones were refused. The library's sealed
  worker has none of `fetch`, `XMLHttpRequest` and `importScripts` (read as `undefined` in the baseline below), so this
  measures the browser, not the library.
- **Electron 45.4.1 (Chromium 156): the design works on `file:` and on a standard, secure custom scheme, guard
  included.** Electron serialises a `file:` origin as `file://` and its `app:` origin as `app://bundle`, so the guard
  stopped an F framed without `sandbox` or with `allow-same-origin`, on both. Framed as designed, everything worked and
  the check was clean; the host page read F on both schemes (on `file:` also the `http` copy without a CORS header).
- **What the opaque view reaches that it does not on `http`.** On `file:` (three engines, and Electron) and on Electron's
  `app:`, nothing: under the `<meta>` every probe was refused, as on `http`; without the `<meta>` the view reached no
  `file:` sibling at all (not even an `<img>`), where on `http` and on `app:` it loaded a same-site `<img>` and ran a
  `<script>`. The positive controls read every target the probe aimed at from the host page (Firefox's `file:` page also
  a file one directory up; Chromium's and WebKit's `file:` page only through `<img>` and `<script>`, and with
  `--allow-file-access-from-files` through `fetch` and XHR). In an extension, the reach above: its own resources, as a
  sandbox page; web-accessible resources of any extension, everywhere.
- **Today's baseline** (the default build, sealed mode, `srcdoc` view): it runs an app on a `file:` page on all three
  engines as one classic script; as the published module (`dist/index.js`) it runs on Firefox and is refused on Chromium
  and WebKit (a module script from `file:` fails CORS with origin `null`). On Electron it runs on `file:`, `app:` and
  `http`, module and classic. In an extension page it does not run as an ordinary page (the extension's policy refuses
  the view's script: "the sandbox's startup script did not run"), nor as a sandbox page under the default sandbox policy
  (`ready`, then the worker is refused by `child-src 'self'` and the call ends `TERMINATED`); it runs as a sandbox page
  under the narrowed policy.

## Method

- **The file** ([`fixture.mjs`](fixture.mjs)). F is research 31's file ([its fixture](../31_served_startup/fixture.mjs):
  `metaPolicy`, `GUARD`, `GATES`, `CHECK`, `VERDICT`), with C's bootstrap in the order "the view speaks first": C runs
  its gates and its policy check, starts the worker, which runs its own, and posts `{ version, verdicts }` to
  `parent.parent`; the host page takes it only when `event.source === frame.contentWindow[0]` (read inside `try`) and
  posts the port to `event.source`. Two additions, both outside what the design ships:
  - a **diagnostic script** in F, before the guard (so that it runs even where the guard stops F), which posts F's
    `self.origin`, URL, secure-context bit, whether `chrome.runtime` exists, and what the guard decides. Its hash joins
    the `<meta>`'s `script-src`;
  - a **reach probe** in C and in its worker, run on a command over the port: for each target URL, `fetch()` (reads the
    body), XHR (reads the body), `<img>` (an image target) and `<script>` or `importScripts()` (a script target, which
    sets a global when it runs). The worker runs research 31's gates and check but not the library's allowlist step,
    so its probe measures what the browser lets the realm do; the library's prelude deletes `fetch`, `XMLHttpRequest`
    and `importScripts` (the baseline below reads them as `undefined` in the real library's worker).
- **The variants of F.** `F.html` as the design draws it; `F-nometa.html`, the same without its `<meta>`, to see what the
  scheme's own rules give an opaque view with no policy of the file's. F framed as designed
  (`sandbox="allow-scripts allow-forms"`, `referrerpolicy="no-referrer"`, in a closed shadow root), and, to test the
  guard, framed without `sandbox` and with `allow-same-origin` added.
- **The host page** (`host.html` with one external script, `host.js`, since an extension page refuses inline script)
  runs, in order: the **positive controls** (the same reach probe in the host page and in a `blob:` worker of its own),
  **the check of the file** (`fetch()` and XHR of F on the host's scheme, of the `http` copy without a CORS header, and
  of one with `Access-Control-Allow-Origin: *`, each compared by SHA-256 digest with `crypto.subtle`), then each case of
  F. The targets: `secret.txt`, `secret.png`, `secret.js` and `sub/secret.txt` beside the host page; on `file:`, a file
  one directory up; in an extension, `war/secret.txt` (web-accessible in one variant) and another extension's resources;
  in Electron's scheme, a `file:` URL; and two `http` files on the static server, with and without a CORS header.
- **The library baseline**: `lib-module.html` loads `dist/index.js` (today's default build, `bun run build:lib` at
  `adb22b4`) as a module; `lib-classic.html` loads the same bundled by Bun into one classic script, what an embedder's
  bundler emits. Each defines `<web-sandbox>`, starts one sealed app whose worker answers `ping` after writing to the
  view, and calls it.
- **Host kinds.** `http` (the baseline: host page and F on `http://localhost`, the copy on `http://127.0.0.1`, another
  site), `file:` (Playwright's `goto` of a `file://` URL), a Chromium MV3 extension's own page, and Electron. Two
  positive controls for `file:` reach: Chromium with `--allow-file-access-from-files`, and Firefox with
  `security.fileuri.strict_origin_policy` off.
- **The extension** ([`build-site.mjs`](build-site.mjs), [`probe-ext.mjs`](probe-ext.mjs)): five unpacked MV3
  extensions, each a copy of the site with a manifest (a `key` fixes its id), loaded into one persistent context of the
  full Chromium build in new headless mode (`channel: 'chromium'`, `--load-extension`; the headless shell loads no
  extension). `normal`: F an ordinary resource under MV3's default extension policy. `war`: F and `war/` in
  `web_accessible_resources` for `<all_urls>`. `sandbox`: F (and the library pages) in the manifest's `sandbox.pages`,
  under the default sandbox policy. `sandbox-csp`: the same with `content_security_policy.sandbox` set to
  `sandbox allow-scripts allow-forms`, the narrowest a manifest can name. `hash`: an `extension_pages` policy that
  admits F's and C's scripts by hash. Last, an `http` host page in the same profile frames each extension's F.
- **Electron** ([`electron/main.cjs`](electron/main.cjs), [`probe-electron.mjs`](probe-electron.mjs)): one window with
  Electron's default `webPreferences` (context isolation, sandbox, no Node integration, web security), driven by
  Playwright's `_electron`. The app registers `app:` with `registerSchemesAsPrivileged` as `standard` and `secure` (and
  `supportFetchAPI`), answered by `protocol.handle` from the site's directory. The window navigates to the host page on
  `file:`, on `app://bundle/`, and on `http`.

## Results

Every cell is measured, on the engine and version of its column, in the run named in [`results/`](results/README.md).
"Works" means: F loaded in the frame, F's `self.origin` was `"null"`, the guard let C be built, C was opaque, the
worker started from `blob:null/…`, C announced itself to `frame.contentWindow[0]`'s test and received the port, every
gate held in C and in the worker, and both policy checks were clean (no event with another policy's text). "Added
policy" is whether any event carried a policy that is not the `<meta>`'s.

### The start-up, F beside the host page on its own scheme

| Host page | Engine | F framed as designed | Added policy | F framed without `sandbox` / with `allow-same-origin` | The host page reads F's document then |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `http` (baseline) | Chromium 159 headless shell | works | none | guard stops F (`self.origin` the host's) | – |
| `http` (baseline) | Firefox 159 | works | none | guard stops F | – |
| `http` (baseline) | WebKit 27.2 | works | none | guard stops F | – |
| `file:` | Chromium 159 headless shell | works | none | **C built and given the port** (`self.origin` `"null"`) | no (`null`) |
| `file:` | Chromium 159 full, new headless | works | none | **C built and given the port** | no |
| `file:` | Chromium 159, `--allow-file-access-from-files` | works | none | guard stops F (`self.origin` `file://`) | – |
| `file:` | Firefox 159 (and with `strict_origin_policy` off) | works | none | **C built and given the port** (`self.origin` `"null"`) | **yes** |
| `file:` | WebKit 27.2 | works | none | **C built and given the port** (`self.origin` `"null"`) | no |
| extension page, F an ordinary resource (`normal`) | Chromium 159 full | **no script of F's ran** (extension policy refuses inline script); no announcement | – | the same | yes (an extension page and its own frame) |
| extension page, F web-accessible (`war`) | Chromium 159 full | **no script of F's ran**; no announcement | – | the same | yes |
| extension page, `extension_pages` policy with the three hashes (`hash`) | Chromium 159 full | **the extension was not loaded**: its page answered `ERR_BLOCKED_BY_CLIENT` | – | – | – |
| extension page, F a `sandbox` page, default sandbox policy | Chromium 159 full | F, C, gates ran; **the worker was refused** (`child-src 'self'`); check not clean; refused | **yes**: `sandbox allow-scripts allow-forms allow-popups allow-modals; …` (worker-src, script-src-elem) | the same: a sandbox page is opaque however it is framed | – |
| extension page, F a `sandbox` page, policy `sandbox allow-scripts allow-forms` | Chromium 159 full | works | none | C built (a sandbox page is opaque however framed) | – |
| `file:` | Electron 45.4.1 (Chromium 156) | works | none | guard stops F (`self.origin` `file://`) | – |
| `app://bundle/` (standard, secure) | Electron 45.4.1 | works | none | guard stops F (`self.origin` `app://bundle`) | – |
| `http` | Electron 45.4.1 | works | none | guard stops F | – |

With `documentUrl` on the `http` copy on another site (`http://127.0.0.1`), F framed as designed **worked on every host
page above**, the extension pages of every variant that loads included, with no added policy. An `http` host page that
framed an extension's F (web-accessible) loaded it, but no script of F's ran: the extension's policy applies to its
resource wherever it is framed; a not-web-accessible F did not load (the frame's document had no frame, no script ran).

### The check of the file, and `crypto.subtle`

`fetch()` and XHR from the host page, compared by SHA-256 with `crypto.subtle`. `crypto.subtle` was an object in every
host page and every C, on every engine; in the worker it was `undefined` everywhere, `http` included (a `blob:null`
worker is not a secure context).

| Host page | Engine | F on the host's scheme | `http` copy, no CORS header | `http` copy, `Access-Control-Allow-Origin: *` |
| :--- | :--- | :--- | :--- | :--- |
| `http` | Chromium, Firefox, WebKit | read, digest equal | refused (CORS) | read, digest equal |
| `file:` | Chromium (shell and full) | **refused** (`fetch` and XHR fail) | refused | read, digest equal |
| `file:` | Chromium `--allow-file-access-from-files` | read, digest equal | refused | read, digest equal |
| `file:` | Firefox | read, digest equal (XHR types it `text/xml`) | refused | read, digest equal |
| `file:` | WebKit | **refused** | refused | read, digest equal |
| extension page (all four that load) | Chromium full | read, digest equal | refused | read, digest equal |
| `file:` | Electron | read, digest equal | **read** (no CORS check from Electron's `file:`) | read, digest equal |
| `app:` | Electron | read, digest equal | refused | read, digest equal |

### What the view and its worker reach

C and its worker under F's `<meta>` ("design"), and in F without the `<meta>` ("browser rules"), against the host
page's own reach (the positive control). Each target is read by `fetch` and XHR, and an image or a script target also
through `<img>` or `<script>` in C and `importScripts()` in the worker. "nothing" means every probe of every target was
refused or failed.

| Host page | Engine | Positive control (host page) | C and worker, design | C and worker, browser rules |
| :--- | :--- | :--- | :--- | :--- |
| `http` | Chromium, Firefox, WebKit | same-origin files read; other site only with CORS | nothing | same-site `<img>` loads, `<script>` and `importScripts()` run; the CORS file read |
| `file:` | Chromium headless shell and full | `<img>` loads, `<script>` runs; `fetch` and XHR refused | nothing | **nothing of `file:`**; the `http` CORS file read |
| `file:` | Chromium `--allow-file-access-from-files` | every `file:` target read (one directory up included) | nothing | nothing of `file:` |
| `file:` | Firefox (both prefs) | every `file:` target read, one directory up included | nothing | nothing of `file:` |
| `file:` | WebKit | `<img>`, `<script>` and the worker's `importScripts()`; `fetch` and XHR refused | nothing | nothing of `file:` |
| `file:` | Electron | every target read, the `http` file without CORS included | nothing | nothing of `file:` |
| `app:` | Electron | every `app:` target read; a `file:` URL refused | nothing | same-site `<img>` and `<script>`, as on `http`; nothing of `file:` |
| extension page, F a sandbox page (narrowed policy) | Chromium full | every own resource read; another extension's web-accessible one read, its other one refused | **every own resource read**, by every probe; another extension's web-accessible resource read | the same |
| every page of the extension profile, F on `http` or an `http` host page | Chromium full | – | **another extension's web-accessible resource read** (`fetch`, XHR); its other resources refused; the page's own and `http` targets refused | the same, plus what `http` gives |

In the same runs, the `<meta>` refused the `http` targets (with and without CORS) from C and the worker in every row:
the policy was in force while the extension's URLs passed it.

### Today's default build (the baseline)

One sealed app started and called (`ready`, then `call('ping')` answered by the worker after writing to the view).

| Host page | Engine | `dist/index.js` as a module | One classic bundle |
| :--- | :--- | :--- | :--- |
| `http` | Chromium, Firefox, WebKit | runs | runs |
| `file:` | Chromium headless shell and full | **does not load** (the module fails CORS: origin `null`) | runs |
| `file:` | Chromium `--allow-file-access-from-files` | runs | runs |
| `file:` | Firefox (both prefs) | runs | runs |
| `file:` | WebKit | **does not load** (the same) | runs |
| extension page (`normal`, `war`) | Chromium full | **terminated**: "the sandbox's startup script did not run" (the extension's policy refuses the view's inline script) | the same |
| extension sandbox page, default sandbox policy | Chromium full | **`ready`, then the worker is refused** (`child-src 'self'`) and the call ends `TERMINATED` | the same |
| extension sandbox page, narrowed policy | Chromium full | runs | runs |
| `file:`, `app:`, `http` | Electron 45.4.1 | runs | runs |

In every run that reached the worker, the library's worker read `fetch`, `XMLHttpRequest` and `importScripts` as
`undefined`.

## What it means for decision 3

Facts for the owner's choice between accepting the limit and keeping a `srcdoc` path; no recommendation.

- **03's premise does not hold as written for `file:` and for an app shell's own scheme.** A `file:` page can frame F
  from beside itself, and on Electron so can a page on a standard, secure custom scheme: the view, the worker, the ports,
  the gates and the policy check all work there as on `http`, on every engine measured. `documentUrl`'s rule ("must be
  `http:` or `https:`", 03, the public surface) is what refuses them, not the browser. A `documentUrl` on an `http(s)`
  copy works from every host page measured, `file:` and extension pages included.
- **What the design loses on `file:`.**
  - **The guard (I14)**: it cannot tell a sandboxed F from an unsandboxed one on Chromium, Firefox and WebKit, since
    both read `self.origin` as `"null"`. On Firefox an unsandboxed F was in the host page's origin and built C. F runs
    nothing of the guest's and C is opaque by its own attribute (its reach was nothing in those cases too), so this is
    research 31 Q2's "no guard" case, reached here by framing alone: no data moved in the probe, and nothing reports it.
    Electron's and Chromium-with-`--allow-file-access-from-files`'s `file://` serialisation keeps the guard working.
  - **The check of the file** on Chromium and WebKit: the host page cannot read a `file:` F at all, so a modified or
    unguarded copy is not found there (on Firefox and Electron it is). With F on an `http` copy that sends a CORS header,
    the check reads it on every engine.
- **What the design costs in an extension (Chromium).** As an ordinary or web-accessible resource F cannot run: the
  extension's policy applies to it, and an extension policy with F's hashes is not loaded. As a sandbox page it runs only
  when the manifest narrows the sandbox policy (the default one refuses the `blob:` worker, and the check sees it and
  refuses: fail closed). In that one working form, the guest's realms read every file of the extension under F's
  `<meta>`. Today's library, for comparison, does not run in an extension's ordinary page either, nor in a sandbox page
  under the default policy; it runs in a sandbox page under the narrowed one, with the same extension scheme in reach of
  whatever in its view or worker can make a request (from the code: the worker has no request names, and the view loads
  only `blob:` URLs it minted; not measured here).
- **The extension scheme passes F's policy on Chromium**, in the served file and so in any page: a guest realm that can
  make a request reads web-accessible resources of every installed extension (and, from an extension's own sandbox
  page, all of that extension's files), whatever the host page's scheme. That is a fact about the `<meta>`'s
  `connect-src 'none'` and `img-src`/`script-src` on Chromium, not about `file:`: the `http` host page shows it too.
- **The baseline the limit removes.** Today's default build runs sealed mode on a `file:` page on all three engines when
  it is loaded as a classic script (and as the published module on Firefox only), on Electron's `file:` and `app:`, and
  in an extension only as a sandbox page with a narrowed policy. Those are the users 03's "such pages can use sealed mode
  today and cannot in this design" counts.
- **What the guest reaches on `file:`** is less than on `http`, not more: under the `<meta>` nothing, as on `http`, and
  under no policy at all an opaque view still reached no `file:` sibling on any engine (on `http` it loads a same-site
  image and script). On Electron's `app:` the browser's rules give the same as `http`.

## Not measured

- **Firefox and WebKit extensions**, and Safari's: Playwright 1.65.1 loads no extension into Firefox or WebKit. Nothing
  here says what their extension pages, sandbox pages or `moz-extension:` / `safari-web-extension:` schemes do.
- **Why Chromium refused the `hash` extension**: its page answered `ERR_BLOCKED_BY_CLIENT`, and the manifest differs from
  `normal` only in its `content_security_policy`; `probe-ext-load.mjs` asked for Chromium's log on stderr, but
  Playwright did not pass it on, so the load error's text was not read.
- **Tauri and Capacitor** (not installable here). A later measurement on those shells would cover `tauri://localhost`
  and `https://tauri.localhost` (Tauri), `capacitor://localhost` and `https://localhost` (Capacitor), on their system
  webviews (WebKitGTK, WKWebView, WebView2, Android WebView). No result is claimed for them, and Electron's says nothing
  about them.
- **Electron with other settings**: `webSecurity: false`, `nodeIntegration`, `sandbox: false`, a custom scheme
  registered without `standard` or `secure`, or an `app:` handler that answers a CSP header. Only the defaults and one standard, secure scheme were run.
- **A shipping Chrome, Edge, Firefox or Safari opening a `file:` page** (their settings for `file:` differ from
  Playwright's builds), Android WebView's `file:///android_asset/`, and iOS.
- **The library's real view and worker on these schemes** beyond the baseline's one app: whether the renderer's URL rule
  keeps every `chrome-extension:` or `file:` URL out of the view, and whether anything in today's sealed worker can make
  a request there, are read from the code, not measured.
- **The guard's alternatives** on `file:` (a test other than `self.origin`, such as `frameElement`, the sandbox flags
  seen from inside, or `ancestorOrigins`): not tried.
- Timing: the runs record each start's milliseconds, but no cost was measured on these schemes.

## Not measured

<!-- list -->

## The library on Electron (design 05, step 3.10)

**Measured** 2026-11-20 on the same 4-core VM, Electron 45.4.1 (Chromium 156.0.8078.100) under Xvfb, with the default
build at step 3.10 ([`probe-electron-library.mjs`](probe-electron-library.mjs); raw output
[`results/2026-11-20_pw-1.65.1/electron-library.txt`](results/2026-11-20_pw-1.65.1/electron-library.txt)): the real
`defineWebSandbox()` and sealed mode, in the window of [`electron/main.cjs`](electron/main.cjs), with the package's
`sealed-document.html` beside the host page on its own scheme.

| Host page | `self.origin` | Refused (another origin off `http(s)`: the other scheme's file, a `data:` URL, a `blob:` URL of its own) | `documentUrl: 'sealed-document.html'` | The check of the file (a copy with one byte more) | The guard (I14): the file's frames once loaded, framed without `sandbox` / with `allow-same-origin` / as the element frames it |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `file:` | `file://` | all three, by the rule of the origin | defined; the app `ready` and its call answered (161 ms) | read: ended with the reason for other bytes, nothing framed | 0 / 0 / 1 (no `load` event where the guard stopped the file) |
| `app://bundle` (standard, secure, `supportFetchAPI`) | `app://bundle` | all three | defined; `ready`, call answered (131 ms) | read: the reason for other bytes | 0 / 0 / 1 |
| `http` (baseline) | `http://localhost:…` | all three | defined; `ready`, call answered | read: the reason for other bytes | 0 / 0 / 1 |

So on Electron's `file:` and on an app's standard, secure scheme the rule admits the file beside the page, the library
runs an app there, the check of the file reads it, and the guard stops a file framed without the sandbox or with
`allow-same-origin` before its view exists, as on `http`. The start-up gates' canaries logged their refusals to the
console as on `http`. Not run: Electron with other settings, and any other app shell (above).

## How to run

From the repository root, with `PLAYWRIGHT_BROWSERS_PATH` set to the browsers Playwright 1.65.1 installed:

```bash
bun run build:lib                                        # dist/, today's default build (the baseline)
bun docs/research/34_non_http_host/build-site.mjs        # site/ (not checked in): the host page, F, the extensions
(cd docs/research/34_non_http_host/electron && bun install && node node_modules/electron/install.js)  # Electron, for its probe
WEB_SANDBOX_LOCK=/path/to/lock bun docs/research/34_non_http_host/run.mjs      # every run, each under flock(1)
xvfb-run -a bun docs/research/34_non_http_host/probe-electron-library.mjs      # the library on Electron (step 3.10; run.mjs's electron-library)
bun docs/research/34_non_http_host/run.mjs file-webkit extension-chromium      # some runs
bun docs/research/34_non_http_host/summarize.mjs docs/research/34_non_http_host/results/<set>/<run>.txt
```

None of it uses the repository's Playwright config or e2e server: each probe launches its browser, its extension
profile or Electron itself, and serves `site/` on loopback with [`server.mjs`](server.mjs).
