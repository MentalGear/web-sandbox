# Review 2 of the design: a second adversarial pass on paper

**Status: a review of [the design](README.md) as it stands at `80701b0`, which is not built.** One reviewer, who wrote
neither the design nor [review 1](REVIEW-1.md). Phase 1 read `README.md` and files 01 to 05 without opening review 1;
its findings were written down before phase 2, which read review 1 and its probes and attacked the design's answers to
it. Checked against the code at `80701b0`, the API reports, docs/API.md, the ADRs and research 27 to 30. Three probes
ran on Chromium 159, Firefox 159 and WebKit 27.2 (Playwright's builds, loopback only, under the machine's shared lock);
they and their output are in [review-2/](review-2/p1-output.txt). Each finding says whether it comes from reading or
from a run.

## Verdict in brief

- The core holds: guest content runs opaque in the static file however it is opened, and I found no way for another
  site to reach the element's frame. A page that frames the host page cannot see the frame in the closed shadow root on
  any engine; the same page reaches and replaces a light-DOM frame, and then receives the app, the ports and the user's
  data (run). That property carries I3 and I13 against framing pages and is stated nowhere.
- Three answers to review 1 do not do what they say: `download()`'s `File` name is ignored by Chromium and WebKit (run);
  the recommended framework pattern built on `started` silently restarts the old app for a reused element; and the
  worker cannot run its gates before the app is sent, because the app is what it is made from.
- One new data path from reading: a relative `documentUrl` resolves against the document's base URL, so an injected
  `<base>` hands every app on the page to another host.
- Fit to keep building on, after the items of [the three things to change first](#the-three-things-to-change-first).

## Findings

### 1. A relative `documentUrl` follows an injected `<base>`: markup injection hands every app to another host

- **Phase:** 1 (blind). **Breaks:** I3's limit as stated ("the host that answers `documentUrl`" is the one the
  embedder chose), and 03's "data that describes an app can never choose the document that renders it".
- **Attacker model:** another website, through a scriptless markup injection in the host page; a mistaken embedder
  writes the natural relative URL.
- **Scenario:**
  1. The embedder registers with `defineWebSandbox({ documentUrl: '/sealed-document.html' })`, the natural form.
     [03](03-served-document.md#the-public-surface) says it "is resolved against the document's base URL".
  2. The host page renders user content with an HTML-injection bug that admits no script (a sanitiser that keeps
     `<base>`, or a dangling tag in a server template), and its policy has no `base-uri` (a page that has a policy
     usually has `frame-src`, and `base-uri` is less common). The attacker injects `<base href="https://evil.example/">`.
  3. The library's module runs after parsing (a module script is deferred), so `document.baseURI` is the attacker's
     when `defineWebSandbox()` resolves the URL. Every element then frames `https://evil.example/sealed-document.html`.
  4. That document answers step 2 of the start-up order with the public bootstrap hash and "passed", receives the app's
     files, the worker's source and the logic port, every `call()` with its arguments (the user's state), and calls the
     host methods as the app.
- **Evidence:** reading. The resolution rule is 03's table; a `<base>` is the classic scriptless primitive. The handshake
  has no way to tell a document at the wrong host from the right one (03 says so for the file's host). The default
  `new URL('./sealed-document.html', import.meta.url)` is not affected: `import.meta.url` ignores `<base>`.
- **Effect:** data leaks and can be manipulated, in sealed mode at its default configuration, given a markup injection.
  Medium.
- **Rung:** the design states the trust in the file's host as a documented limit. Here the host is not the embedder's
  choice, so the limit does not describe the case.
- **Direction:** resolve a relative `documentUrl` against `document.URL` (which no `<base>` changes) or against the
  module's own URL, never against `baseURI`; or require an absolute URL. Resolve it once, at registration, as now.

### 2. The framework pattern built on `started` restarts the old app silently, and the embedder sends it the new app's data

- **Phase:** 1 (blind), on review 1's finding 12 and its answer. **Breaks:** 01's root ("there is no next app on an
  element") as the docs would teach it.
- **Attacker model:** a mistaken embedder (React), and the guest of the first app.
- **Scenario:**
  1. [01](01-one-element-one-app.md#the-lifecycle) recommends
     `useEffect(() => { if (el.started) el.reset(); else el.start(app, grants); return () => el.terminate(); }, [])`.
  2. React's lint rule (`react-hooks/exhaustive-deps`) flags `[]`, since `app` and `grants` are read; the usual fix is
     `[app, grants]`. Or the component is reused for another app without a `key`, the case 01 warns about.
  3. The user switches from author X's app to author Y's. The effect's clean-up calls `terminate()`; the effect runs
     again, reads `started === true` and calls `reset()`: X's app runs again, with X's grants. No error is thrown.
  4. The embedder then calls `el.call('load', stateForY)`, which reaches X's app.
- **Evidence:** reading. 01 says that catching and ignoring the second `start()`'s error "is wrong for an element that
  is reused: the first app keeps running". The recommended pattern has the same flaw. It only avoids the throw, so the
  failure is now silent.
- **Effect:** the docs would mislead embedders into handing one app's data to another, which is the class of finding
  01 exists to close. Medium.
- **Rung:** the construction (one element, one app) holds. The documented use of it reintroduces reuse.
- **Direction:** by construction, the effect owns the element:
  `useEffect(() => { const el = document.createElement('web-sandbox'); el.start(app, grants); box.append(el); return () => el.remove(); }, [app, grants])`.
  StrictMode then makes two elements, one removed, and a new app is a new element. `started` stays useful for
  diagnostics, but no pattern should branch to `reset()` on it.

### 3. `download()`'s name is ignored by Chromium and WebKit: the embedder still names the saved file

- **Phase:** 1 (blind), on review 1's finding 13 and its answer; run. **Breaks:** I9's companion claim in
  [02](02-what-an-app-hands-over.md#guestbytes) ("a `File` ... under a name the library chose") and the README's row 13.
- **Attacker model:** the guest, and a mistaken embedder.
- **Scenario:** the guest writes `report.html` (or `invoice.pdf.exe`). The embedder writes the natural download code:
  `a.href = URL.createObjectURL(w.content.download()); a.download = w.path; a.click()`, or leaves `download` empty.
- **Evidence (run, [p2](review-2/p2-output.txt)).** A `File` typed `application/octet-stream` and named
  `report.html.download`, handed to the browser five ways:

  | Handed over as | Chromium 159 | Firefox 159 | WebKit 27.2 |
  | :--- | :--- | :--- | :--- |
  | `a.download = ''` | a UUID | `report.html.download` | `""` |
  | `a.download = file.name` | `report.html.download` | the same | the same |
  | `a.download = 'report.html'` (the guest's path) | `report.html` | `report.html` | `report.html` |
  | a link without `download` | a UUID | `report.html.download` | `""` |
  | `window.open(blob URL)` | a UUID | `report.html.download` | `""` |

  No engine rendered the blob as a document: the type does its job. The name does its job only on Firefox, or when the
  embedder copies `file.name` into the attribute.
- **Effect:** a file the guest named, saved on the user's disk from the embedder's origin, which a double click opens
  (an `.html` runs as a local document, an `.exe` runs). Manipulation of the user, not a data leak; medium-low, as
  review 1 rated it.
- **Rung:** the design implies a construction. It is a convention, on two engines of three.
- **Direction:** a step the library takes itself: `GuestBytes.save(): void` makes the object URL, sets the anchor's
  `download` to the library's name, clicks it and revokes the URL, so the embedder names nothing. Or say plainly that
  the name holds only through `a.download = file.name`.

### 4. The worker cannot run its gates before the app is sent: the start-up order and I15/I18 contradict each other

- **Phase:** 2, on the answer to review 1's finding 3. **Breaks:** I15 ("before any guest content is sent, in the view
  and the worker") and I18 (the worker's half of the check), as specified.
- **Attacker model:** the browser not behaving as assumed (4).
- **Scenario:** [03](03-served-document.md#the-start-up-order) says the view and the worker run their gates and the
  policy check "before step 2 answers", and that the host sends "the files, the worker's source, the second port" only
  in step 3. The worker is started from a `blob:` URL that C mints from the worker's source, which in sealed mode holds
  the guest's entry and files, and the policy refuses code from strings, so a library-only worker cannot be given the
  guest's code later. An implementer has to choose one of:
  - run the worker's gates in the guest's worker, after step 3. Guest content then exists in C before the worker's
    verdict, against I15's wording. The worker's network-names gate ("after the allowlist step") can only run in that
    worker;
  - or run them in a second, library-only worker. That proves things about another worker, by inference.
  Neither file says which, or what the host waits for before `ready` and before the first `call()` (which carries the
  embedder's data) is posted.
- **Evidence:** reading. [03](03-served-document.md#the-policies-in-force) item 2, the start-up order's steps 2 and 3,
  and the gates' table; research 28's Q7 had the worker's gates run after F and C ran theirs, but before any guest
  content existed only because its worker held none.
- **Effect:** correctness of a claimed check, with an order that decides whether embedder data reaches a worker whose
  gates failed. No data path while the gates hold.
- **Rung:** a check, as claimed, but not specified so that it can be built as claimed.
- **Direction:** state the order as: C's gates and policy check, then the app; the worker's gates in the guest's worker
  before the entry runs, reported on the logic port; `ready` (and with it the flush of queued calls) only after the
  worker's verdict. Then restate I15 as "before any guest code runs, and before any embedder data is sent".

### 5. An enforced site-wide policy header stops C before it can report one: the build ends with "the document did not answer"

- **Phase:** 2, on the answer to review 1's finding 1. **Breaks:** 03's "The first two end the build with their
  reason" for a `Content-Security-Policy` header on the file.
- **Attacker model:** a mistaken embedder (server-wide headers).
- **Scenario:** the site sends `Content-Security-Policy: script-src 'self'` (or a `default-src` without the bootstrap's
  hash) on every response. It applies to F and is inherited by C. C's inline bootstrap is not admitted by it, so C never
  runs, never answers step 2, and the load timeout ends the build with "the document did not answer". The I18 check,
  which lives in C, can only see a header that lets C's bootstrap run: a report-only one, or an enforced one that
  admits the hash.
- **Evidence:** reading. A policy list is an intersection, and research 27 Q3 measured that the file's headers bind C.
- **Effect:** correctness of a diagnostic. The most common enforced site policy gets the reason that tells the embedder
  to look for a missing file. No data effect: nothing runs.
- **Direction:** say that an enforced header that refuses the bootstrap looks like "did not answer", and list it in
  that reason's text. Or check the file's response before framing it (finding 7's direction), which reads the headers
  of a same-origin or CORS-enabled `documentUrl` directly.

### 6. Step 4 and "one bootstrap" leave the build with the network modes underspecified

- **Phase:** 2, on the answers to review 1's findings 7 and 9. **Breaks:** unspecified; an implementer following
  [05](05-build-order.md) step 4 to the letter breaks the network build.
- **Scenario and evidence (reading):**
  - Step 4 deletes "the per-build policy generator, the `srcdoc` path and its Trusted Types handling, the host page's
    copies of the passes that moved". Strict and cooperative mode keep their `srcdoc` documents
    ([03](03-served-document.md#the-network-build)) and use all three: `setLibrarySrcdoc` and `buildWrapperDocument`
    (`src/lib/network-host.ts:166`), `cooperativePolicy` and `strictViewPolicy` (`:205-206`), and strict mode's host
    passes (`HOST_PASSES` rows whose modes include `strict`). Only sealed mode's uses can go.
  - With sealed mode's bootstrap in its form without the bridge in both builds, the network build carries two view
    bootstraps. `viewScriptHash()` and `viewBootstrapHash()` (`src/lib/in-sandbox-view.ts:4570-4616`) return the one
    `viewBootstrapSource` builds, which has the bridge branch in that build. 03 says the host compares the view's hash
    "with its own (`viewScriptHash()`)". Compared with that function as it is, every sealed build in the network build
    ends as "another library's".
  - The view cannot read its own hash from anywhere. The bootstrap cannot contain it, `crypto.subtle` is absent where
    the host page is not a secure context (the threat model's secure-context row: sealed mode supports such pages), and
    the library's SHA-256 is "host-side only, never stringified into a guest" (`src/lib/csp/script-hash.ts:1-20`). So C
    needs a digest of its own, or announces a version constant.
- **Effect:** correctness.
- **Direction:** step 4 deletes sealed mode's paths only (`_sealedPolicy`, `sealedViewPolicy`, sealed's call of the
  wrapper and of the host passes). Name the sealed bootstrap's hash function apart from strict mode's. Say what C
  announces: a constant version and build identifier is enough for what the check can do (finding 7).

### 7. The hash announcement is a version check, not a check of the file

- **Phase:** 1 (blind); it bears on the answers to review 1's findings 2 and 7. **Breaks:** the README's row 7 ("the
  file is checked by its hash") and 05's promise row "The served file is the same for every embedder of a version",
  read as a runtime property.
- **Attacker model:** whoever serves the file (5), a mistaken embedder (3).
- **Scenario:** the hash C announces covers C's bootstrap only, and C reports it about itself. F's policy text, its
  guard and C's `sandbox` attribute are not covered. Neither is any byte a server or an edge adds: an injected script
  before the `<meta>`, a rewritten attribute. A document that is not the file at all, such as an SPA's `index.html`
  served for every path, answers nothing. That ends with "did not answer", whose reason the host cannot narrow (03).
- **Evidence:** reading. 03's own sentence, "a hostile document at `documentUrl` can announce whatever it likes", is
  right. What I could make concrete beyond it added no trust: an edge that injects a script into F also injects it into
  the host page.
- **Effect:** the docs overstate a check. No data path beyond finding 1 and the stated trust in the file's host.
- **Rung:** I12 holds for the package's bytes (a build test). At run time the check catches an honest stale copy, as
  review 1 said it would, and nothing else.
- **Direction:** where `documentUrl` is same-origin or answers CORS, the host can `fetch()` it before framing and
  compare the whole file's digest with the library's constant. That is a check of the bytes, of the headers (finding 5)
  and of an SPA fallback, with a precise reason. It leaves a time-of-check to time-of-use gap only where the frame's
  load and the fetch get different answers. Otherwise reword row 7 as "a copy of another version is detected".

### 8. The closed shadow root is what keeps a framing page out of the handshake, and nothing states or tests it

- **Phase:** 1 (blind); it settles review 1's open question on framing pages. **Breaks:** nothing today; I3 and I13
  rest on it without saying so.
- **Attacker model:** another website that frames the host page; a mistaken embedder whose element's frame ends up in
  the light DOM (a shadow DOM polyfill such as ShadyDOM in force mode, or a later change to the element).
- **Scenario:** T frames the host page H. As soon as `H.frames.length` is 1, T sets `H.frames[0].location` to a page of
  its own, whose child frame answers the handshake. At that page's load H posts its port to `frames[0]` with `'*'`,
  accepts the public hash and "passed", and sends the app, the logic port and then `call('load', state)`.
- **Evidence (run, [p1](review-2/p1-output.txt)).** A model of 03's start-up order (F served after 800 ms, as a network
  would), H on one site and T on another:
  - with the frame in a closed shadow root, H's `window.length` read 0 and T never saw a frame, on all three engines.
    The genuine C answered. That holds with and without `frame-src 'self'` on H;
  - with the same frame in the light DOM, on all three engines T navigated F before its load. The attacker's frame
    answered the handshake and received the app and its files, called a host method, and received the user's state from
    the `call()`. A `frame-src 'self'` on H blocked T's page.
  - T could not reach C inside F in either case (a sandboxed opaque frame's frames are not accessible across origins),
    and F's `frame-src 'none'` would refuse T's URL there anyway.
  Today's `srcdoc` wrapper is in the same closed shadow root, so the same answer bounds today's code.
- **Effect:** none while the frame stays in a closed shadow root; with it reachable, data leaks and can be
  manipulated. The handshake itself authenticates nothing (03 says so for the file's host).
- **Rung:** I3 and I13 claim "impossible to build" for the element. Against framing pages they rest on the browser's
  rule that shadow-tree frames are not in `window.frames`, which is a property to state and test.
- **Direction:** state it in 03 and give it a test: an e2e spec in which a cross-site page that frames the host page
  enumerates `frames` and finds none. Keep the second-load rule of today's reducer (`frameLoad`, ADR-003) for F's
  frame, which 03 does not mention.

### 9. `links`: the guest does pick the link and the moment, and the click channel's capacity is not stated

- **Phase:** 1 (blind); independently found (review 1's finding 6 computed the same 5 bits). **Breaks:** 02's "With the
  click on the link as the request, it picks neither", which its own "What it leaves" contradicts.
- **Attacker model:** the guest, with an honest embedder that lists the author's own pages (02 accepts this case).
- **Scenario:** the guest wraps its whole UI in one marked `<a>`, and before each pointer press its worker changes that
  link's `href` to whichever listed URL encodes the next bits of what it knows. Every click the user makes in the view,
  including a click into a text field, is a click "inside" a marked link (02's own rule) and opens that tab.
- **Evidence:** reading.
- **Effect:** data leaks, about log₂(n) bits per user click with n listed links (5 at `MAX_LINKS`), plus the time, to a
  server the author reads. Low, and stated in 02 as "a signal" but not sized.
- **Rung:** I6 holds for the URL (impossible to build). The moment is the view's as the design says, but "picks neither"
  is wrong: it picks which link on every click.
- **Direction:** put the bits per click in the egress table's row for `links` (its budget is planned), and reword the
  sentence. A click inside a form control within a marked link could send nothing, which costs the guest nothing it
  needs.

### 10. `commitGuestWrites()` skips silently and returns nothing

- **Phase:** 2, on the answer to review 1's finding 10. **Breaks:** unspecified.
- **Attacker model:** a mistaken embedder (a handler that awaits).
- **Scenario:** an embedder lists `a.js` and `b.js`, checks them as a pair, and commits both. Meanwhile the guest wrote
  `b.js` again. `a.js` commits and `b.js` is skipped. The embedder cannot tell: the method returns `void` (01), and
  `fileschanged` fires either way. It then stores both inspected values on its server, as committed.
- **Evidence:** reading. Today `commit()` returns the changed paths internally (`src/lib/guest-writes.ts:291-313`) and is
  all or nothing for the type check.
- **Effect:** correctness. The element's files and the embedder's copy diverge, and a set is committed in part. No data
  path.
- **Direction:** return the values that committed (or the skipped ones), or commit all or none.

### 11. The passes that move into C put more guest-text parsing next to I16's value model than they need to

- **Phase:** 1 (blind). **Breaks:** nothing; a placement that raises what a compromised view gains.
- **Scenario:** [03](03-served-document.md#a-thinner-host) moves the entry scan, the module rewrite, the stylesheet
  scans and the worker-source assembly into C. C also holds the value model (I16), which in the served document is the
  only layer between Chromium's address and card autofill and the guest ([04](04-forms-and-autofill.md)); it also holds
  the `links` index and the view port. A parser bug in C driven by guest text breaks I16, and from then on one
  autofill choice gives the guest the whole address or card.
- **Evidence:** reading. Research 28 Q5 offers "C or the worker's prelude"; only the stylesheet cut must be where the
  sheets are applied.
- **Effect:** hardening. It is better than today, where those passes run in the host realm.
- **Direction:** the module lexer, the entry scan and the assembly go into the worker's prelude, before the entry runs.
  C keeps the CSS cut, which is its own enforcement.

### 12. I17's "impossible to build" is true of one argument only, and three options are not classified

- **Phase:** 1 (blind); on the answer to review 1's finding 6. **Breaks:** I17's rung as the docs would read it.
- **Scenario:** an embedder that runs third-party apps stores each with a manifest of what it asks for, as browser
  extensions and mobile apps do, and passes the manifest as `grants`. The two arguments make that a line of the
  embedder's, which is what review 1 asked for, but nothing in it is a construction against the author.
- **Evidence:** reading, and `CONFIG_SCHEMA` (`src/lib/config-schema.ts:379-468`): `hostContentSecurityPolicy`,
  `scriptUnsafe` and `unsafeCapabilities` are in neither of 01's lists, and neither are the removed keys
  (`connectionsAllowed`, `virtualFilesUrl`), which today warn.
- **Effect:** the docs could mislead an embedder into treating a stored manifest as safe; correctness for the
  classification.
- **Direction:** say in the docs that every grant is whatever the embedder passes, and classify all of
  `CONFIG_SCHEMA`, the removed keys included (`scriptUnsafe` and `hostContentSecurityPolicy` as the embedder's).

### 13. Legitimate uses the design removes without naming them

- **Phase:** 1 (blind). **Breaks:** "What it costs" (01) and "What it adds" (03), which do not list these.
- **Scenario and evidence (reading):** `documentUrl` must be `http:` or `https:` (03), and there is no `srcdoc`
  fallback (D8). A host page on `file:`, a browser extension's own page (`chrome-extension:`, `moz-extension:`) and an
  app shell on a custom scheme (Electron's `app:`, Tauri, Capacitor) can use sealed mode today and cannot under the
  design. Neither can a notebook or no-code page that imports the library from a CDN that serves `.html` as something
  other than HTML.
- **Effect:** a cost, not a hole.
- **Direction:** name them in "What it costs", or admit the extension and app schemes the embedder's own origin uses.

## Review 1's findings, one by one

| # | Review 1's finding | The design's answer | Verdict |
| :--- | :--- | :--- | :--- |
| 1 | a header on the file is an inherited policy | a row of `INHERITED_CONTEXT`, the I18 check, the mitigations kept | closed at the claimed rung (a check) for the view, pending WebKit; the worker's half opens finding 4; an enforced header is misnamed (finding 5) |
| 2 | whoever answers `documentUrl` receives the app | stated as a limit; the default from `import.meta.url`, once measured | closed as a documented limit; finding 1 widens who answers, and finding 8 shows what keeps framing pages from answering |
| 3 | the gates were measured in another file | gates in C and the worker; a port first, then the verdicts, then the app | opens finding 4 |
| 4 | the view inherits the file's flags | C's static attribute is the most the library grants; F's narrows | closed at the claimed rung (by construction: flags intersect) |
| 5 | I5 is false for capture listeners | I5 restated as a documented limit | closed |
| 6 | `links` beside the app's content | two arguments, I17 | closed as review 1 asked; I17's rung reads stronger than it is and three options are unclassified (finding 12); the channel itself remains (finding 9) |
| 7 | the bootstrap differs between the builds | sealed's bootstrap is one text in both builds | closed for the file; which hash the network build compares is unspecified (finding 6), and "checked by its hash" overstates (finding 7) |
| 8 | the quota needs the moved rewrite | bytes at `start()`, a stated bound in C | closed. Residual: a committed write can push the rewritten files past C's bound, and the embedder then learns of it only when the next build ends |
| 9 | step 4 deletes what the file's policy needs | step 4 deletes host-realm code only | closed for what review 1 named; the list now names code the network build needs (finding 6) |
| 10 | a stale value stays committable | commit only the current pending entry, by identity | closed; the silent skip is finding 10 |
| 11 | `start()` is re-entrant | the check and the store are one step; the first to finish validating binds | closed: no code of the embedder's runs between the check and the store, so nothing overwrites a binding. The re-entrant inner call is the one that binds, which is odd but safe |
| 12 | no member says whether an element is bound | `started` | the member closes it; the documented pattern opens finding 2 |
| 13 | `download()` leaves the name to the embedder | a `File` the library named | not closed on Chromium and WebKit (finding 3, run) |

Of the thirteen, eight are closed at the rung the design now claims (4, 5, 8, 10, 11, and 1, 2, 6 for what they
named). Three are closed but their answers open a new finding (3, 9, 12), one is closed with a residual that misleads
(7), and one is not closed (13).

Review 1's list "What the design does not specify": each item has an answer in the file it concerns, and I checked
each: cross-field errors throw (01); an element with no app is never terminated (01); pending writes and the values
listed before a build (01); the start-up order (03, but see finding 4); the indistinguishable failures, now a documented
limit (03); caching and the query (03); `defineWebSandbox()` twice (03); which elements are links, descendants and
`auxclick` (02); where the per-app flags go (03); what the realistic host and the directive matrix test (03, 05 step
3.5).

Review 1's open question on framing pages is settled by finding 8. Its claim that the host's Service Worker never sees
the sandboxed frame's navigation is confirmed ([p3](review-2/p3-output.txt)): a Service Worker that answers
`/sealed-document.html` served the frame framed with `allow-scripts allow-same-origin` or with no attribute, and never
the frame framed with `allow-scripts allow-forms`, on all three engines. So a cache-first or app-shell Service Worker
does not decide what F is.

## Invariant by invariant

| # | Result | What I tried |
| :--- | :--- | :--- |
| I1 | held | a getter or Proxy that calls `start()` during validation (the inner call binds, the outer throws, nothing is overwritten); `start()` from `ready` and `terminated` listeners (throws) |
| I2 | held | a refusal from each part; the quota, now bytes only |
| I3 | held for the element; its limit is widened by 1 and carried by an unstated property (8) | a `<base>` injection; a framing page that navigates F or C (run); the file's host |
| I4 | held | a write between list and commit, a commit of an older value after a newer one, values from before a `reset()`; see 10 for the return value |
| I5 | held as restated | nothing new beyond review 1's run |
| I6 | held for the URL; "picks neither" is wrong (9) | a covering link whose `href` changes before each press; Enter on a focused link; a compromised view |
| I7 | held | the measure is an allowlist of kinds (`src/lib/structured-size.ts`), so a `Blob` inside a `Map`, a `Set` or an error's `cause` is reached the same way |
| I8 | held | upper-case and missing extensions (`mimeTypeFor` lower-cases; no extension is `application/octet-stream`, not inert) |
| I9 | held inside `GuestBytes` for the type; the name does not hold (3, run) | polyglots behind an image signature (rendered as images); an `application/octet-stream` blob opened five ways (never rendered, run) |
| I10 | held as a check | termination reasons that C will now originate must be classified too (below) |
| I11 | held | hostile framing with more flags (C keeps its own); the host's Service Worker (run); a framing page (run) |
| I12 | held for the package's bytes; the runtime check is a version check (7) | the two builds; a modified copy |
| I13 | held, on the closed shadow root (8) | a framing page replacing F before the handshake (run) |
| I14 | held as a check | nothing beyond research 28's guarded cases |
| I15 | rung as claimed, not specifiable as written (4) | the worker's gates against the start-up order |
| I16 | held (built); more exposed by 11 | what a compromised C forwards under Chromium's autofill |
| I17 | true of the app argument; rung reads stronger (12) | `start(bundle, bundle)` and `start(app, bundle)` (each throws on a key in the wrong argument: fails closed); a stored manifest |
| I18 | a check, as claimed, for the view and for headers that let C run (4, 5) | an enforced site header (stops C first); a report-only one (seen); directives no canary provokes (`form-action`, `frame-src`: the view cancels submissions and the renderer drops frames, so guest content does not provoke them either) |

## What the design still does not specify

- When the build is `ready` and the queued calls are flushed: after C's verdict, or after the worker's (finding 4).
- Whether the second-load rule of today's reducer applies to F's frame, and what the element does on a load of F after
  `ready`.
- How C learns or states its bootstrap's identity (finding 6).
- The termination reasons C will originate for a parse it runs (an `import()` in the entry, the rewrite's bound): whether
  they are identifiers with the host's text or text from C, and whether a guest path in them is a guest value of
  `GUEST_VALUES`.
- The referrer policy of F's frame. Research 28 used `no-referrer`. Without it, a cross-origin `documentUrl` receives the
  host page's origin, and a same-origin one its full URL.
- The classification of `hostContentSecurityPolicy`, `scriptUnsafe`, `unsafeCapabilities` and the removed keys
  (finding 12).
- Whether a release may happen between steps 3.2 and 3.5. In that window the served file runs without the I18 check,
  with the mitigations still in place (review 1's `blobLoads` residual).
- In 03, "The first two end the build with their reason" can be read as covering `X-Frame-Options`, which the start-up
  order's step 4 says looks like a missing file.

## Claims checked against the research and the code

**Matched:**
- `setConfig` in 84 files of `test/`, 404 times (01).
- Today's `setConfig()` never throws (`src/host.ts:803`); the six members and `execute()` (01, against
  `etc/web-sandbox.api.md`).
- `STRICT_VIEW_FLAGS` and the safe capabilities are scripts, forms and the orientation lock (`src/lib/config-schema.ts:245`,
  `src/csp-directives.ts:4`).
- The view takes one `INIT_VIEW` from `parent.parent` (`src/lib/in-sandbox-view.ts:3635`), and the host posts it at the
  wrapper's load to `frames[0]` with `'*'` (`src/host.ts:1454`, `:2049`).
- Research 28's figures as 03 cites them: twelve ways, eleven on WebKit, 3 to 5 ms, the guarded file, the gates' cost.
- Research 30: the 5-second window, a click anywhere, one tab per click, `null` either way (02).
- The module lexer is es-module-lexer's asm.js build (`src/lib/module-specifiers.ts:1-17`), so moving it into a realm
  under the constant policy needs no `'wasm-unsafe-eval'`.
- The CSSOM path for guest styles exists and is the only one today (research 25; 03 and 05 step 4).
- The bootstrap in the package is a string literal (`scripts/build-lib.ts:40`), so an embedder's minifier does not
  change the hash.

**Did not match, or overstated:**
- "The lifecycle model loses three inputs" (01): `setConfig` and `configured` go and `build` loses `load`, but
  `filesChanged` (`src/lib/lifecycle.ts:202`) stays for `commitGuestWrites()`.
- 05's table: "Autofill does not reach a guest in the served document | step 3.7"; the step is 3.8 (3.7 is the docs).
- "The file is checked by its hash" (README, row 7): a version check (finding 7).
- "With the click on the link as the request, it picks neither" (02): finding 9.
- "`download()` ... under a name the library chose" (02): finding 3, run.
- 03 cites `viewScriptHash()` as the host's side of the comparison; in the network build it is the bridge form's hash
  (finding 6).

## Open questions

- **Password-manager extensions under hostile framing.** Another site frames the embedder's `documentUrl` sandboxed
  (the guard admits it) and drives the library with a login form. Does an extension that matches by the frame's URL
  offer the embedder's saved login there? 03's limit ("the address bar is the other site's") does not cover what such
  UIs key on. The value model would accept a credential the user picks. Settled by research 29's extension checklist,
  run with F framed by another site.
- **Non-CSP report-only headers on the file** (`Cross-Origin-Embedder-Policy-Report-Only`,
  `Permissions-Policy-Report-Only`, `Document-Policy`, `Reporting-Endpoints`, NEL). I18 checks CSP only. I could not
  make a report that carries guest text, because the view loads only its own `blob:` URLs. Settled by serving each on
  the file and recording what reaches the endpoint.
- **SPA fallbacks and dev servers.** A server that answers `documentUrl` with the app's `index.html` frames the
  embedder's own app sandboxed with scripts. Module scripts then fail CORS from the opaque origin, so I expect "did not
  answer". A classic-script app could boot inside itself, nest, and make requests before the timeout. Settled by
  framing a Vite and a webpack build's `index.html` that way, and by putting the dev servers (Vite's dependency
  pre-bundling moves `import.meta.url`) among the bundlers that gate the default `documentUrl`.
- **`securitypolicyviolation` in WebKit's worker**, for the worker's half of I18: the design names it as not measured;
  finding 4 decides where that check runs.

## The three things to change first

1. Resolve `documentUrl` against `document.URL` or require it absolute (finding 1). State and test the closed shadow
   root as what keeps framing pages out of the handshake, and keep the second-load rule for F (finding 8).
2. Specify the start-up order with the worker's gates in the guest's worker before the entry, and `ready` after its
   verdict (finding 4). Consider fetching and hashing a same-origin `documentUrl` before framing it, which settles
   findings 5 and 7 and the SPA fallback (finding 7's direction).
3. Replace the `started ? reset() : start()` pattern with an element owned by the effect (finding 2), and make the
   download name the library's own step (`save()`), since a `File`'s name is ignored by two engines (finding 3).
