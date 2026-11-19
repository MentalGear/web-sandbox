# 03 · The served document

**Status: a design, not built.** [The folder's index](README.md) has the invariants (I11 to I15 and I18 are this file's)
and what [review 1](REVIEW-1.md) and [review 2](REVIEW-2.md) changed here. The measurements are
[research 27](../research/27_served_document_headerless/README.md) and
[research 28](../research/28_served_topology/README.md), on Chromium 159, Firefox 159 and WebKit 27.2,
[research 31](../research/31_served_startup/README.md), which built this file's shape and start-up as a fixture on the
same three engines, [research 32](../research/32_document_asset/README.md) on the bundlers, and the probes of the two
reviews.

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
  It is a constant because the view cannot compute a digest everywhere: under a host page that is not a secure context
  (`http:` on a name that is not loopback), `crypto.subtle` was undefined in the view on all three engines (research 31,
  Q1b).
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
- **It is the only check that sees the file's bytes.** A copy that lost its guard, or whose view lost its `sandbox`
  attribute, differs from the library's file in nothing the view or the worker can observe from inside
  ([the guard](#inside-the-file)); and the headers [the policy check](#the-policies-in-force) cannot provoke are named
  only here.

**Measured** (research 31, Q1): a host page's `fetch()` of the file read the status, the content type,
`X-Frame-Options`, `Content-Security-Policy` with its `frame-ancestors`, `Content-Security-Policy-Report-Only` and the
body, on all three engines, so each case of the table can be told from the others before the file is framed, and under
a report-only header no canary's report is ever sent.

**Not measured:** its cost; the digest's comparison; a server that answers this request and the frame's navigation
differently (the two differ in `Sec-Fetch-Dest`); a host page's `connect-src` and Service Worker in its path (the host
page's Service Worker never answers the sandboxed frame's own navigation, on all three engines: review 2, probe 3).

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
  `submit` on Chromium and Firefox (review 1, finding 4, run), and with `allow-forms` on F it received it on all three
  (research 31, Q4). A hostile page that frames F with more flags gives C nothing: C never has more than its own
  attribute (research 31, Q4: popups, top navigation, modals, downloads, each with its positive control). WebKit does
  not know the `allow-orientation-lock` token, logs it as invalid and applies the others.
- **The host page posts to C directly**: C is `frames[0]` of F, and the host page posts only to a document that has
  exactly one frame ([the start-up order](#the-start-up-order), step 1). C accepts messages only from its parent's
  parent, as today's view does. The ports go from the host page to C, and C hands one to the worker. F handles no
  message.
- **The frame of F is in the element's closed shadow root, and that is load-bearing.** A frame in a shadow tree is not
  in the page's `window.frames`, so a site that frames the host page cannot reach F's frame and navigate it to a document
  of its own, which would then answer the handshake and receive the app. Measured on all three engines (review 2,
  finding 8; research 31, Q5, in this design's start-up order): with the frame in a closed shadow root the framing page
  saw no frame, before F's first load and after it; with the same frame in the light DOM
  it replaced F before its load, received the app and its files, called a host method and received the user's state.
  Today's view rests on the same property. The handshake authenticates nothing, so this is what keeps other sites out
  of it, and it gets a test of its own ([05](05-build-order.md), step 3).
- **One load.** The element accepts one load of F's frame per build; a second load ends the build, as today's rule for
  the view's frame does (ADR-003, `frameLoad`). A check, and only of what happens after the first load: a replacement
  before it shows the host page one load (research 31, Q5), and the shadow root is what covers that.
- **No referrer.** F's frame has `referrerpolicy="no-referrer"`, so the file's host does not receive the host page's
  URL, and neither does a report endpoint: without it, the reports of F on all three engines, and of C on Firefox,
  carried the host page's full URL with its query in their `referrer` field; with it, none did (research 31, Q3).

**Measured** (research 28, Q1): with F static, C and its worker were opaque and reached nothing of the embedder's
origin in all twelve ways of opening F that research 27 lists (Q2: framed, navigated to and opened as a popup, by the
embedder and by another site, sandboxed and not), on all three engines; eleven on WebKit, whose browser closed in the
twelfth (the sandboxed popup). In the form where F itself ran a script, or started the worker, that code took the
embedder's origin in seven of the twelve. With F framed as the element frames it (`allow-forms` among its flags) the
twelve ways gave the same cells, one for one, on all three engines (research 31, Q4).

## Inside the file

| Piece | What it is | Rung | Measured |
| :--- | :--- | :--- | :--- |
| No script of F's own | C in F's static markup; C starts the worker | impossible to build, for the package's file: F runs nothing, an attacker cannot add a script to a static file, and C's `sandbox` attribute is a byte of that file | above |
| The guard | F's one script, before C's markup: if the document is not opaque (`self.origin !== 'null'`) or is the top-level document, `window.stop()`. It is synchronous and has no listener | a check, which reports nothing | C was built only when F was framed sandboxed, on all three engines |
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

**What nothing inside sees.** The guard stops a wrongly framed F and says nothing: the host page sees no answer. And a
copy of the file without its guard, framed without `sandbox` or with `allow-same-origin`, passed every gate and the
policy check and received content, on all three engines (research 31, Q2): C is opaque by its own attribute, so nothing
in C or the worker can tell that F holds the embedder's origin. F runs nothing of the guest's there, so no data moves;
but a file that lost its guard is found only by [the check of the file](#the-check-of-the-file), where it can read.

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
   before the guest's entry runs ([the start-up order](#the-start-up-order)), each make the loads of
   [the table below](#what-the-policy-check-provokes), with fixed library strings, and listen for
   `securitypolicyviolation`. A violation whose policy is not the file's own `<meta>` text, or whose disposition is not
   the `<meta>`'s, means another policy is in force, enforced or report-only, and the view announces it; the build ends
   with a reason that names the header. What leaves the browser before that are the reports of those canaries, which
   carry library strings only (research 31, Q3: every report sent before the check ended the build carried library
   strings, scheme-only blocked URLs and the file's URL). Policies are fixed when the document is created, so no policy
   can appear after the check; a policy the check provokes nothing under is in force unseen, and the next part is what
   stands behind the check there.
3. **The mitigations stay.** Everything the view and the element do today so that no report carries guest text (the
   entry scan's refusal of `import()`, the refusal of code from strings, the cut of CSS URLs, the CSSOM styles, the
   rule that the view loads only `blob:` URLs it minted, the removal of nested frames and objects, the dropped form
   targets and the cancelled `submit`) stays behind the check. Their tests move from the host page's policy, which no
   longer reaches the view, to the file's headers: the realistic host and the directive matrix
   (`test/e2e/directive-matrix.ts`) set each directive on the file's response, enforced and report-only, and expect a
   working sandbox or a named termination, and no report that carries guest text.

### What the policy check provokes

Research 31 (Q3) ran the check in the view and in the worker under 80 policies on the file's response, on all three
engines.

| | |
| :--- | :--- |
| Sees | every policy that refuses one of its canaries, in the view and in the worker: enforced and report-only, with `report-uri` and with `report-to`, each single-directive `'self'` policy, Trusted Types enforced and report-only, and a header that repeats the `<meta>`'s own text (report-only by its disposition; enforced by a canary run alone, since counting duplicate events gives false positives on Firefox) |
| Needs | **a canary worker of the view's own, before it answers.** The app's worker starts after the verdict, so a report-only `worker-src` is otherwise seen only once the app is in the view |
| Does not see | a report-only `worker-src`, `font-src` or `media-src` that admits `blob:`; `frame-src`, `object-src`, `form-action` or `manifest-src` at any value; a `frame-ancestors` that admits the host page; `upgrade-insecure-requests`; a header `sandbox`; an enforced policy that admits everything the file does |
| WebKit | raises the events in the view and in the worker, so the check sees there what it sees on the other two; it sends no report from an opaque document but the refusals of code from strings, filed under the file's URL |
| Cost | 70 to 85 ms in the fixture, 60 ms of it two fixed waits; the least wait that still sees every event is not measured |

**Under five of the unseen directives a guest's load would be reported, if the view ever made it**, on Chromium and
Firefox: with the full URL of the guest's choosing under report-only `font-src`, `media-src` and `form-action`, and with
its origin under `frame-src` and `object-src`. So the check does not close the report channel alone. What closes each
today is a rule of the renderer, a check each:

| Directive | The rule that keeps the load from existing |
| :--- | :--- |
| `font-src`, `media-src` | the view loads a font or media only from a `blob:` URL it minted (`keepsUrl`, the cut of CSS URLs); a minted URL carries nothing of the guest's |
| `frame-src`, `object-src` | the renderer removes nested browsing contexts (`RENDER_REMOVED_ELEMENTS`) |
| `form-action` | the renderer drops `action`, `formaction`, `method` and `target`, and the view cancels every `submit` in the capture phase |

**To be measured, to lift the five from those rules to the check itself:** the fixture's canaries for these kinds were
loads the `<meta>` admits (a `blob:` font) or none at all (a frame, an object, a form). A second canary per directive
that the `<meta>` *refuses* (a fixed URL of the library's on a reserved name, for a font, media, a frame, an object and
a form's action) raises the `<meta>`'s own violation and, under any header that would report a guest's URL for that
directive, a second one. If that holds on three engines, the directives of the file's policy become one list
(`POLICY_DIRECTIVES`), each with its admitted canary, its refused canary, or the reason no load of that kind can be
built in a framed document, and a test enumerates the `<meta>` against it. Until measured, the rules above are what
closes the five, and step 3.6 brings a test that renders a guest font, media, frame, object and form under each of the
five headers and expects no report that carries guest text.

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

## The start-up order

1. The element checks the file where it can ([above](#the-check-of-the-file)), frames `documentUrl` and, at the frame's
   load, posts one message to `frames[0]` with one port and nothing of the guest's. It posts only when the document
   has exactly one frame, and closes the port when the answer is refused ([below](#who-receives-the-first-port)).
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
have, and no data of the embedder's is sent before both. A file of another version receives nothing of the guest's. A
hostile document at `documentUrl` can announce whatever it likes; that is the trust of
[the file's host](#who-is-trusted-with-the-app), which no order of messages changes.

**Measured** (research 31, Q1, a fixture of this order with a library worker): it works on all three engines. The right
file answered and received content; a file of another version answered and received nothing; a hello posted first by
another frame of the host page was ignored by the view. From the frame's insertion to the verdict took 95, 109 and 119
ms at the median (Chromium, Firefox, WebKit) against 22, 32 and 34 ms with no gates and no check; the gates are 2 to 4
ms of the difference and the fixture's two fixed waits 60 ms. **Not measured:** the worker's gates in a worker made from
the app's source; the policies a worker inherits are fixed when it is created, so the same events are expected.

### Who receives the first port

The first message goes to `frames[0]` of whatever document answered `documentUrl`. Where a server answers every path
with the application's own page and that page has a frame of its own (a widget), **that frame received the hello and
its port**, on all three engines (research 31, Q1). It could not answer with a version and verdicts, the host page
refused it, and nothing was sent on the port; but a port of the element's reached a third party's document.

- Where the check of the file can read the answer, the body is not the library's file and no frame is made.
- Where it cannot, two checks narrow it: the host page posts only when the document has exactly one frame
  (`contentWindow.length`, readable across origins), and closes the port when the answer is refused. A page with
  exactly one frame of its own still receives one port that is then closed.
- **To be measured, to make it impossible to reach for a document that is not the library's view:** the view speaks
  first. It posts its version and verdicts to its parent's parent, and the host page accepts that message only when
  its source is the first frame of the element's own frame (`event.source === frame.contentWindow[0]`), and only then
  sends a port. A document that does not announce itself as the view then receives no port at all, and the element
  posts nothing at the frame's load. What the view posts is the library's version and verdicts, which are no secret,
  so a wrong recipient (another site that frames the file) learns nothing. If it holds on three engines, this replaces
  step 1's post and step 2's check of the sender, and the two checks above go.

## The start-up gates

Canaries that confirm the browser enforces what the design assumes, run by the view before step 2 answers and by the
worker's prelude before the entry runs. F runs none: its only script is the guard. Research 28 (Q7) measured twelve: origin, framing, code from
strings, connect, image, style, base, frame, cookie, storage, parent, and the worker's network names. A canary that the
browser does not refuse ends the build with a termination reason.

| | |
| :--- | :--- |
| Measured | with the file static and the gates in the view and the worker, each tripped under the mutant that provokes it, the same on all three engines (research 31, Q2): no `<meta>`, a weakened `script-src`, `connect-src`, `img-src`, `style-src` or `base-uri`, the worker's allowlist step skipped, a view that is not opaque |
| Cost | 2 to 4 ms of start-up at the median, without the frame canary |
| Left out | the frame canary: it is blind to its own directive while `script-src` holds, and it cost 1.6 s where research 28 measured it |
| Not covered by a gate | a mutant of `frame-src`, `worker-src`, `default-src`, `font-src`, `media-src`, `object-src`, `form-action` or `manifest-src` alone; the [policy check](#what-the-policy-check-provokes) sees each of them, because the mutant's text is not the file's. The file's own realm has no gate ([above](#inside-the-file)). Nothing that changes after start-up is seen |

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
- The file as it will ship: research 28's spike ran the library's per-build wrapper as a served file, and research 31
  a fixture of this design with no bundle of the library's: its guest loads reached the browser directly, not through
  the renderer, the cut of CSS URLs or the view's `submit` handling.
- The policy check's refused canaries, and the view speaking first (both above).
- The worker's gates and its half of the check in a worker made from the app's source.
- The Reporting API (`report-to`) on Chromium, whose positive control failed; downloads on Firefox and WebKit, the
  same.
- The check of the file: its cost, the digest's comparison, a server that answers it and the frame's navigation
  differently, and a host page's `connect-src` and Service Worker in its path.
- A host page on a scheme that is not `http(s)`.
- A password manager's extension when another site frames the file: whether it offers the embedder's saved login in a
  form that site drives there (review 2, open question).
- Report-only headers that are not Content-Security-Policy.
- The host page's Trusted Types and a host policy without `frame-src` for the file, with the library.
- The window before F's `<meta>` applies.
- Memory, and any cost of the extra document beyond start-up time.
