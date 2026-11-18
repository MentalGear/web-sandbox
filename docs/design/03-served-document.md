# 03 · The served document

**Status: a design, not built.** [The folder's index](README.md) has the invariants (I11 to I15 and I18 are this file's)
and what [review 1](REVIEW-1.md) changed here. The measurements are
[research 27](../research/27_served_document_headerless/README.md) and
[research 28](../research/28_served_topology/README.md), on Chromium 159, Firefox 159 and WebKit 27.2, and the probes of
review 1.

## The root

Sealed mode's view is a `srcdoc` document today. A `srcdoc` document is the host page's in every way the browser
inherits: its Content-Security-Policy applies to it, its Trusted Types policy governs how the library writes it, and the
library's code that prepares guest content runs in the host page's realm. `INHERITED_CONTEXT`
(`src/lib/inherited-context.ts`) lists what the sandbox inherits, row by row, and much of sealed mode's code exists to
step around one row or another.

The owner's decision (D8): the view's document is a static file the embedder serves, with its own policy in a `<meta>`
tag. No response headers are needed, and there is no `srcdoc` fallback in the default build.

## The public surface

```ts
defineWebSandbox(options: { tagName?: string; documentUrl: string | URL }): typeof WebSandbox
```

| Piece | What it is |
| :--- | :--- |
| `sealed-document.html` | One static file per library version, the same in both builds, shipped in the package and exported as `./sealed-document.html`. The embedder serves it unchanged |
| `documentUrl` | Where the embedder serves it. Given once, at registration. It is resolved against the document's base URL, must be `http:` or `https:`, and carries no user name, password or fragment; anything else throws. It may carry a query, and a path of the embedder's choosing |
| New termination reasons | Named when built. Four cases: the document did not answer; it answered as another library's; a start-up gate failed; a policy that is not the file's own is in force |

- `documentUrl` is not part of the app or the grants ([01](01-one-element-one-app.md#startapp-grants)): data that
  describes an app can never choose the document that renders it.
- A second `defineWebSandbox()` for a tag that is already defined does nothing when its `documentUrl` is the same, and
  throws when it differs.
- **One text in both builds.** Today the view's bootstrap differs between the builds: the build with the network modes
  adds the fetch bridge's branch (`viewBootstrapSource`). Sealed mode has no bridge, so its view's bootstrap is the
  form without it in both builds, and the file is generated from that one text (I12).
- **A file of another version.** The view announces its bootstrap's hash before the host page sends anything of the
  guest's ([below](#the-start-up-order)), and the host page compares it with its own (`viewScriptHash()`). So an old
  file in a cache ends with a named reason, not with a view that half works. Serving the file at a URL that changes with
  the version (a bundler's hashed asset, or a query) avoids the stale copy.

"No backend, no server config" becomes "one static file, no response headers that set a policy on it"
([below](#the-policies-in-force)).

## Who is trusted with the app

The element frames whatever answers `documentUrl`, and sends the document there the app's files, its ports and, through
the ports, the reach of its host methods. A frame's content cannot be checked from outside: there is no integrity
attribute for a frame, and a cross-origin document cannot be read. So the host that answers `documentUrl` is trusted
with the app, exactly as the host that serves the library's own script is. A documented limit.

- **On the origin that serves the library's script, the file adds no one to trust.**
- **A second hostname adds a host that is trusted with the app.** A name that later points somewhere else (a deleted
  bucket behind a CNAME, a CDN's copy) hands the app to whoever answers. [Below](#optional-the-file-on-a-second-hostname).
- **Decided** ([index](README.md#decided-after-review-1), 4): `documentUrl` becomes optional, defaulting to
  the bundle's own copy, `new URL('./sealed-document.html', import.meta.url)`, which the common bundlers copy and serve
  beside the code. The file's host is then the code's host with nothing for the embedder to deploy. It becomes the
  default only after the bundlers that matter are measured to serve it; until then `documentUrl` is required.

## The shape

```
host page
└─ <web-sandbox>, closed shadow root
   └─ <iframe src=documentUrl sandbox="allow-scripts allow-forms …">                     F, the served file
      └─ <iframe sandbox="allow-scripts allow-forms allow-orientation-lock" srcdoc="…">  C, the view, in F's static markup
         └─ Worker(blob:)                                                                the guest's logic, started by C
```

- **F runs nothing of the guest's, and no script but a guard.** The view, C, is an element of F's static markup, with a
  `sandbox` attribute that has no `allow-same-origin`. C's bootstrap is the library's, pinned by hash in F's policy. C
  starts the worker.
- **The sandbox flags.** A nested frame has the restrictions of its own attribute and of every frame above it. So C's
  static attribute carries the most the library ever grants a view (`STRICT_VIEW_FLAGS` and the safe capabilities:
  scripts, forms, the orientation lock), and the element narrows it per app with F's attribute: scripts and forms
  always, a capability only when the app's grants have it. With F framed `allow-scripts` alone, the view received no
  `submit` on Chromium and Firefox (review 1, finding 4, run). A hostile page that frames F with more flags gives C
  nothing: C never has more than its own attribute.
- **The host page posts to C directly**: C is `frames[0]` of F. C accepts messages only from its parent's parent, as
  today's view does. The ports go from the host page to C, and C hands one to the worker. F handles no message.

**Measured** (research 28, Q1): with F static, C and its worker were opaque and reached nothing of the embedder's
origin in all twelve ways of opening F that research 27 lists (Q2: framed, navigated to and opened as a popup, by the
embedder and by another site, sandboxed and not), on all three engines; eleven on WebKit, whose browser closed in the
twelfth (the sandboxed popup). In the form where F itself ran a script, or started the worker, that code took the
embedder's origin in seven of the twelve. **To be measured again** with F framed as the element frames it
(`allow-forms` among its flags).

## Inside the file

| Piece | What it is | Rung | Measured |
| :--- | :--- | :--- | :--- |
| No script of F's own | C in F's static markup; C starts the worker | impossible to build, for the package's file: F runs nothing, an attacker cannot add a script to a static file, and C's `sandbox` attribute is a byte of that file | above |
| The guard | F's one script, before C's markup: if the document is not opaque (`self.origin !== 'null'`) or is the top-level document, `window.stop()`. It is synchronous and has no listener | a check | C was built only when F was framed sandboxed, on all three engines |
| A constant policy | One `<meta>` text per library version: scripts by hash, the still stylesheet by hash, `blob:` for the four kinds of file, `worker-src blob:`, `connect-src 'none'`, everything else `'none'`. No `'unsafe-inline'`, and no generator in the default build | impossible to build, for the policy's text | works with F opaque or not, on all three |
| The channel | ports from the host page to C | impossible to build a relay | the round trip is today's; start-up is 3 to 5 ms more on loopback |
| The start-up order and gates | below | a check, of the browser | below |

**What the constant policy gives up.** Today's per-build policy admits `blob:` only for the kinds of file the app
registered. A constant policy admits it for all four kinds, and the renderer's URL rule (`keepsUrl`) is then the only
thing that keeps a `blob:` URL of the wrong kind out: that narrowing moves from the policy to a check.

**What the constant policy keeps necessary.** It has no `'unsafe-inline'` for styles, so the view applies guest styles
through the CSSOM, as it does today under a host page's `style-src`. That code stays ([05](05-build-order.md), step 4).

**What the guard does not cover.** Another site can frame F sandboxed and drive the library with its own content. That
content runs opaque, with no authority of the embedder's, but it is at the embedder's URL. A documented limit: in that
case the address bar is the other site's.

## The policies in force

The file's `<meta>` is not the only policy that can reach the view. **A policy in the response headers of the file
applies to F, and C and the worker inherit it** (research 27, Q3; review 1, finding 1, run). An embedder who sets
`Content-Security-Policy-Report-Only` for the whole site, the usual way to roll a policy out, sets it on this file too.
Under such a header, with no mitigation, the view and the worker sent reports to the site's endpoint on Chromium and
Firefox, and a report carried a URL and a sample of the guest's choosing. That is the `cspReporting` row of
`INHERITED_CONTEXT` again, arriving through the file's own server in place of the host page.

The design's answer has three parts, in the order of the ladder.

1. **The row exists.** `INHERITED_CONTEXT` gains a row for the policy the file's response carries, with its column in
   `SEALED_REACH`. The served document does not close the policy rows by construction: it replaces "the host page's
   policy" by "the file's response headers" as what is inherited.
2. **A check that ends the build (I18).** Before the host page sends anything of the guest's, the view and the worker
   make one load of each kind they can ever make for a guest (`VIEW_LOAD_KINDS`: a `blob:` image, a stylesheet, a font,
   media; a `blob:` worker; a refused request; code from a string), with fixed library strings, and listen for
   `securitypolicyviolation`. A violation whose policy is not the file's own `<meta>` text means another policy is in
   force, enforced or report-only, and the view announces it; the build ends with a reason that names the header. What
   leaves the browser before that are the reports of those canaries, which carry library strings only. Policies are
   fixed when the document is created, so a policy that passes this cannot appear later.
3. **The mitigations stay.** Everything the view and the element do today so that no report carries guest text (the
   entry scan's refusal of `import()`, the refusal of code from strings, the cut of CSS URLs, the CSSOM styles) stays
   behind the check. Their tests move from the host page's policy, which no longer reaches the view, to the file's
   headers: the realistic host and the directive matrix (`test/e2e/directive-matrix.ts`) set each directive on the
   file's response, enforced and report-only, and expect a working sandbox or a named termination, and no report that
   carries guest text.

What "serve it unchanged" excludes, for the docs: a `Content-Security-Policy` or
`Content-Security-Policy-Report-Only` header on the file, `X-Frame-Options` or a `frame-ancestors` that refuses the host
page, and a content type that is not HTML. The first two end the build with their reason; the others with "the document
did not answer".

**Not measured:** whether every engine raises `securitypolicyviolation` for a report-only header in the view and in the
worker (review 1 saw WebKit send one report, from F only), and so whether the check sees on WebKit what it sees on the
other two.

## The start-up order

1. The element frames `documentUrl` and, at the frame's load, posts one message to `frames[0]` with one port and
   nothing of the guest's.
2. The view checks the sender (its parent's parent), runs the gates and the policy check above, and answers on the
   port: its bootstrap's hash, and each gate's verdict.
3. The host page compares the hash with its own and reads the verdicts. Only then does it send the app: the files, the
   worker's source, the second port.
4. A view that does not answer within the load timeout ends the build with "the document did not answer". The host
   page cannot tell why from outside: a missing file, a server that answers every path with another page, a header
   that refuses the framing, and a host policy whose `frame-src` does not admit `documentUrl` all look alike. The
   reason's text lists them.

So no guest content exists anywhere in the file's documents before every gate has answered, and a file of another
version receives nothing. A hostile document at `documentUrl` can announce whatever it likes; that is the trust of
[the file's host](#who-is-trusted-with-the-app), which no order of messages changes.

## The start-up gates

Canaries that confirm the browser enforces what the design assumes, run by the view and by the worker before step 2
answers. F runs none: its only script is the guard. Research 28 (Q7) measured twelve: origin, framing, code from
strings, connect, image, style, base, frame, cookie, storage, parent, and the worker's network names. A canary that the
browser does not refuse ends the build with a termination reason.

| | |
| :--- | :--- |
| Measured | each of the twelve tripped under the mutant that provokes it, on all three engines, **in a file whose own script ran the gates before creating the view** (the form this design does not build) |
| To be measured | the same in the static file, with the gates in the view and the worker and the order above |
| Cost | 4 to 6 ms of start-up at the median without the frame canary; about 1.6 s with it (in the measured form) |
| Left out | the frame canary: it is blind to its own directive while `script-src` holds, and it is the 1.6 s |
| Not covered | a mutant of `frame-src`, `worker-src` or `default-src` alone passes the gates; nothing that changes after start-up is seen |

The gates are defence in depth after the construction, never in place of it: they answer "the browser has a bug or a
setting that dissolves the policy", for the cases a canary can provoke.

## A thinner host

With the view in a document of its own, the passes over guest content that run in the host page's realm today
(`HOST_PASSES`, `src/lib/host-passes.ts`) can leave it.

| Pass | In this design |
| :--- | :--- |
| the entry scan, the module rewrite, the stylesheet scans and cut, the assembly of the worker's source | move into C |
| the policy built from the kinds of file | goes: the policy is constant |
| writing the frame's `srcdoc` through Trusted Types | goes: the host page sets a URL |
| the options' copy and schema, the file store and its quota, the validation and measure of every typed message that comes back, guest writes, log lines, violations | stay: they are the element's own state, or the host page acts on them |

**The quota.** Today the quota counts what each module's rewrite and each stylesheet's references add, and finds it by
lexing in the host page (`rewriteCost`). With the lexers in C, the host page's quota counts the bytes given, which
`start()` can refuse synchronously, and C refuses a build whose rewritten files pass a bound the library states; that
refusal is a termination reason ([01](01-one-element-one-app.md#startapp-grants)).

From reading the code; not measured.

## Optional: the file on a second hostname

`documentUrl` may be on another site than the host page.

- **What it gives:** a wrongly opened file then holds that host's authority, never the embedder's app's origin
  (impossible to reach).
- **What it costs:** a second host that is [trusted with the app](#who-is-trusted-with-the-app).
- **What it does not give:** the host page's thread. A loop in F or C stalled the host page for its whole length on the
  headless shell, Firefox and WebKit, whatever the file's site.

Allowed, and not recommended over the code's own origin.

## What the served document does not change, and what it adds

- **Does not change:** the permission state keyed to the top-level page (Chromium's view and WebKit's worker read the
  host page's geolocation grant), the secure-context bit, the host page's thread on the engines named above.
- **Adds:** a URL any site can frame; a requirement on the host page's policy (`frame-src` must admit `documentUrl`); a
  deployment step; a policy the file's server can add; a host trusted with the app; the WebKit browser closing in one
  wrong-way case.
- **Makes worse, unless [04](04-forms-and-autofill.md) holds:** a served file has an `http(s)` URL, so Chromium's
  autofill treats the view's fields as a page's.

## The network build

Sealed mode is the same code in both builds, so it is served in both, from the same file. Strict, cooperative and worker
mode keep the documents they have today.

## Not measured

- Safari, Android, and a shipping browser's third-party storage settings.
- The file as it will ship: research 28's spike ran the library's per-build wrapper as a served file, framed with the
  library's own flags, and its gates ran in a scripted file.
- The policy check of I18 on each engine, in the view and in the worker.
- The bundlers' handling of the file as an asset of the package.
- The host page's Trusted Types and a host policy without `frame-src` for the file, with the library.
- Whether a page that frames the host page can reach F's frame and navigate it before its first load (today's view has
  the same question).
- The window before F's `<meta>` applies.
- Memory, and any cost of the extra document beyond start-up time.
