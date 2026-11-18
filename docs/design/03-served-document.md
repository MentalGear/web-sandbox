# 03 · The served document

**Status: a design, not built.** [The folder's index](README.md) has the invariants (I11 to I15 and I18 are this file's)
and what [review 1](REVIEW-1.md) and [review 2](REVIEW-2.md) changed here. The measurements are
[research 27](../research/27_served_document_headerless/README.md) and
[research 28](../research/28_served_topology/README.md), on Chromium 159, Firefox 159 and WebKit 27.2,
[research 32](../research/32_document_asset/README.md) on the bundlers, and the probes of the two reviews.

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
| `documentUrl` | Where the embedder serves it. Given once, at registration, and required. A relative one is resolved against the document's own URL (`document.URL`), never its base URL: a `<base>` element, which markup injection can add without any script, would otherwise point every element of the page at another host (review 2, finding 1). It must be `http:` or `https:`, and carries no user name, password or fragment; anything else throws. It may carry a query, and a path of the embedder's choosing |
| New termination reasons | Named when built. The cases: the file is not the library's (missing, another page, modified, another version's, each named where [the check of the file](#the-check-of-the-file) can read it); a policy that is not the file's own is in force; the document did not answer; a start-up gate failed |

- `documentUrl` is not part of the app or the grants ([01](01-one-element-one-app.md#startapp-grants)): data that
  describes an app can never choose the document that renders it.
- A second `defineWebSandbox()` for a tag that is already defined does nothing when its `documentUrl` is the same, and
  throws when it differs.
- **One text in both builds.** Today the view's bootstrap differs between the builds: the build with the network modes
  adds the fetch bridge's branch (`viewBootstrapSource`). Sealed mode has no bridge, so its view's bootstrap is the
  form without it in both builds, and the file is generated from that one text (I12).
- **A file of another version.** The view announces the library version its bootstrap was built for, a constant
  written into it, before the host page sends anything of the guest's ([below](#the-start-up-order)). So an old file in
  a cache ends with a named reason, not with a view that half works. This is a check of the version an honest copy
  states about itself, and of nothing else; [the check of the file](#the-check-of-the-file) is the one that reads its
  bytes. Serving the file at a URL that changes with the version (a hashed asset, or a query) avoids the stale copy.
- **Schemes.** A host page that is not on `http:` or `https:` (a `file:` page, a browser extension's own page, an app
  shell on a custom scheme such as Electron's) has no URL to serve the file from, and there is no `srcdoc` fallback
  (D8): such pages can use sealed mode today and cannot in this design. Whether the file can be admitted from the host
  page's own scheme there is not measured ([index](README.md#waits-for-the-owner), 3).

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
- **`documentUrl` stays required.** The owner's decision ([index](README.md#decided-after-review-1), 4) made it optional,
  defaulting to the bundle's own copy (`new URL('./sealed-document.html', import.meta.url)`), once the bundlers were
  measured to serve it. Research 32 measured them: Vite's production build and Next.js serve the file unchanged by
  default; webpack's production build minifies it, Rollup, esbuild and Bun do not copy it, and Vite's dev server,
  Parcel and Bun's dev server rewrite it, with no setting found for the last three. So the condition does not hold. The
  docs carry a recipe per bundler, and the one that works in all of them is the plainest: the file goes into the
  directory the site serves static files from, and is not imported.

## The check of the file

Tools treat a file named `.html` as a page to process: research 32 found a dev server that inserts its client's script
ahead of the file's policy tag, a bundler that minifies the file and one that rewrites it. A site-wide policy header
that refuses the view's bootstrap stops the view before it can say anything (review 2, finding 5), and a server that
answers every path with the app's own page answers this one too. From outside the frame all of these look alike: no
answer.

So, once per registration and before the first frame, the element requests `documentUrl` itself where it can read the
answer (the same origin, or a server that allows it), and compares the whole file's digest with the constant the library
was built with, and reads the response's headers.

| What it finds | The build ends with |
| :--- | :--- |
| no file, or a type that is not HTML | the file is missing |
| other bytes | the file is not the library's: modified, or another version's (the reason names the tools that rewrite HTML) |
| a `Content-Security-Policy` or `Content-Security-Policy-Report-Only` header, `X-Frame-Options`, a `frame-ancestors` | that header, by name |

- **A check, for honest deployments.** It reads what the server answers this request; a hostile server answers the
  frame differently. It adds no trust and removes none: the file's host is trusted either way (above).
- **Where the answer cannot be read** (another origin without permission to read, or a host page whose own policy
  refuses the request) there is no check, and the cases above end as "the document did not answer", whose text lists
  them.
- The request carries no credentials, and its result is kept for the registration.

**Not measured:** its cost; a host page's `connect-src` and Service Worker in its path (the host page's Service Worker
never answers the sandboxed frame's own navigation, on all three engines: review 2, probe 3).

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
- **The frame of F is in the element's closed shadow root, and that is load-bearing.** A frame in a shadow tree is not
  in the page's `window.frames`, so a site that frames the host page cannot reach F's frame and navigate it to a document
  of its own, which would then answer the handshake and receive the app. Measured on all three engines (review 2,
  finding 8): with the frame in a closed shadow root the framing page saw no frame; with the same frame in the light DOM
  it replaced F before its load, received the app and its files, called a host method and received the user's state.
  Today's view rests on the same property. The handshake authenticates nothing, so this is what keeps other sites out
  of it, and it gets a test of its own ([05](05-build-order.md), step 3).
- **One load.** The element accepts one load of F's frame per build; a second load ends the build, as today's rule for
  the view's frame does (ADR-003, `frameLoad`).
- **No referrer.** F's frame has `referrerpolicy="no-referrer"`, so the file's host does not receive the host page's
  URL.

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
2. **A check that ends the build (I18).** The view, before the host page sends anything of the guest's, and the worker,
   before the guest's entry runs ([the start-up order](#the-start-up-order)), each make one load of each kind they can
   ever make for a guest (`VIEW_LOAD_KINDS`: a `blob:` image, a stylesheet, a font,
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
page, a content type that is not HTML, and any tool that rewrites the file. Where [the check of the file](#the-check-of-the-file)
can read the answer, each ends the build with its own reason. Where it cannot: a report-only header, and an enforced one
that still lets the view's bootstrap run, end it through the view's check; an enforced header that refuses the
bootstrap, a refused framing and a wrong type stop the view before it exists, and end as "the document did not answer".

The check sees policies of the Content-Security-Policy kind. Other report-only headers on the file
(`Permissions-Policy-Report-Only`, `Cross-Origin-Embedder-Policy-Report-Only`, `Document-Policy`, network error logging)
are not seen by the view; the check of the file can name them. No report under them that carries guest text was
constructed (the view loads only `blob:` URLs it minted), and none is measured.

**Not measured:** whether every engine raises `securitypolicyviolation` for a report-only header in the view and in the
worker (review 1 saw WebKit send one report, from F only), and so whether the check sees on WebKit what it sees on the
other two.

## The start-up order

1. The element checks the file where it can ([above](#the-check-of-the-file)), frames `documentUrl` and, at the frame's
   load, posts one message to `frames[0]` with one port and nothing of the guest's.
2. The view checks the sender (its parent's parent), runs its gates and its policy check, and answers on the port: the
   library version it was built for, and each gate's verdict.
3. The host page reads the version and the verdicts. Only then does it send the app: the files, the worker's source, the
   second port.
4. The view starts the worker. The worker is made from the app (its source holds the guest's entry and files, and the
   policy admits no code from strings, so a worker of the library's alone could not be given the guest's code later). So
   the worker's gates and its half of the policy check run in the worker's prelude, **before the guest's entry runs**,
   and the worker reports its verdicts on the logic port.
5. The element becomes `'ready'`, and sends the calls that were waiting, only after the worker's verdicts. No data of
   the embedder's reaches a worker whose gates failed.
6. A view that does not answer within the load timeout ends the build with "the document did not answer". Where the
   check of the file could not run, the host page cannot tell why from outside: a missing file, a server that answers
   every path with another page, a header that refuses the framing or the bootstrap, and a host policy whose
   `frame-src` does not admit `documentUrl` all look alike. The reason's text lists them.

So the view holds nothing of the guest's before its own gates have answered, no guest code runs before the worker's
have, and no data of the embedder's is sent before both. A file of another version receives nothing. A hostile document
at `documentUrl` can announce whatever it likes; that is the trust of [the file's host](#who-is-trusted-with-the-app),
which no order of messages changes.

## The start-up gates

Canaries that confirm the browser enforces what the design assumes, run by the view before step 2 answers and by the
worker's prelude before the entry runs. F runs none: its only script is the guard. Research 28 (Q7) measured twelve: origin, framing, code from
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
| the entry scan, the module rewrite, the assembly of the worker's source | move out of the host page: into the worker's prelude, before the entry runs, where the code allows it; otherwise into C |
| the stylesheet scans and cut | move into C, which applies the sheets |
| the policy built from the kinds of file | goes: the policy is constant |
| writing the frame's `srcdoc` through Trusted Types | goes: the host page sets a URL |
| the options' copy and schema, the file store and its quota, the validation and measure of every typed message that comes back, guest writes, log lines, violations | stay: they are the element's own state, or the host page acts on them |

**The quota.** Today the quota counts what each module's rewrite and each stylesheet's references add, and finds it by
lexing in the host page (`rewriteCost`). With the lexers in C, the host page's quota counts the bytes given, which
`start()` can refuse synchronously, and C refuses a build whose rewritten files pass a bound the library states; that
refusal is a termination reason ([01](01-one-element-one-app.md#startapp-grants)).

**Why the worker and not the view, where there is a choice.** In the served document the view holds the value model
for forms, which is the only layer between Chromium's autofill and the guest ([04](04-forms-and-autofill.md)), the
index of `links` and the view's port. A parser of guest text that runs in the view puts a parser bug next to all of
them; the same parser in the guest's own worker puts it where the guest's code already runs (review 2, finding 11).

**Reasons that come from a parse.** A build that ends because of what a parse found (an `import()` in the entry, the
bound on rewritten files) ends with an identifier the view or the worker sends and text the host page holds. A path in
it is the guest's, and is classified as such in `GUEST_VALUES` ([02](02-what-an-app-hands-over.md)).

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
mode keep the documents they have today, with everything those need: the `srcdoc` path and its Trusted Types handling,
the policy generator, and the host passes strict mode uses. So the build with the network modes has two view
bootstraps, sealed mode's and strict mode's (which has the fetch bridge's branch), and each has its own hash under its
own name; `viewScriptHash()` there is strict mode's.

## Not measured

- Safari, Android, and a shipping browser's third-party storage settings.
- The file as it will ship: research 28's spike ran the library's per-build wrapper as a served file, framed with the
  library's own flags, and its gates ran in a scripted file.
- The policy check of I18 on each engine, in the view and in the worker.
- The check of the file: its cost, and a host page's `connect-src` and Service Worker in its path.
- A host page on a scheme that is not `http(s)`.
- A password manager's extension when another site frames the file: whether it offers the embedder's saved login in a
  form that site drives there (review 2, open question).
- Report-only headers that are not Content-Security-Policy.
- The host page's Trusted Types and a host policy without `frame-src` for the file, with the library.
- Whether a page that frames the host page can reach F's frame and navigate it before its first load (today's view has
  the same question).
- The window before F's `<meta>` applies.
- Memory, and any cost of the extra document beyond start-up time.
