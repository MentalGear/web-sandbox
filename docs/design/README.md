# Design: one app per element, the hand-offs, and the served document

**Status: a design, partly built.** The code as it is: [API.md](../API.md), [THREAT-MODEL.md](../THREAT-MODEL.md),
[ARCHITECTURE.md](../../ARCHITECTURE.md). What is built is named as such where it appears: the view's value model for
form controls ([04](04-forms-and-autofill.md)), and of step 1 the rows [05](05-build-order.md) marks built
(`start(app, grants)`, one app per element) and of step 2 the rows it marks built.

**Decided by the owner.** Sealed mode alone is the default build (D9, [ADR-009](../ADR-009-network-modes-build-flag.md)).
Sealed mode's document becomes a static file the embedder serves, with its policy in a `<meta>` tag and no `srcdoc`
fallback (D8, 2026-11-07). The binding method is named `start` (2026-11-18). The owner accepted the rest of the design
in outline on 2026-11-18, before its review, and the five answers of the review that change a public name or an accepted
promise on 2026-11-18, after it ([below](#decided-after-review-1)).

**Reviewed twice.** [REVIEW-1.md](REVIEW-1.md) is an independent adversarial pass on the design as it stood at
`6b2f22f`, and [REVIEW-2.md](REVIEW-2.md) a second one, by another reviewer, on the design as it stood at `80701b0`,
first without reading the first review and then against the design's answers to it. Their probes and output are in
[review-1/](review-1/p1-output.txt) and [review-2/](review-2/p1-output.txt). The files of this folder are the design
after both: [what review 1 changed](#what-review-1-changed) and [what review 2 changed](#what-review-2-changed) list
each finding and where its answer is. Three answers of review 2 change a public name or a decision the owner made: the owner approved all three on
2026-11-19 ([decided after review 2](#decided-after-review-2-and-the-first-two-steps)).

**Measured as drawn.** [Research 31](../research/31_served_startup/README.md) built the served document's shape and
start-up order as a fixture on the three engines; [what it changed](#what-research-31-changed) is below.

## What the design is for

Seven review passes found the same three kinds of finding in sealed mode, and each kind has one root:

| Kind of finding | Root | This design's answer |
| :--- | :--- | :--- |
| One app's methods, files, pending writes or late calls reach the next app on the same element | An app is assembled on the element in several calls, and nothing ends what the last app left | [01](01-one-element-one-app.md): one element runs one app, given once |
| The embedder turns guest data into something with the host page's authority (a navigation, a `blob:` document, a typed file), and the documented recipe for it is wrong | Guest data arrives as ordinary data, and every step that carries authority is hand-written by the embedder | [02](02-what-an-app-hands-over.md): the steps that carry authority are the library's; guest data stays data |
| The sandbox's documents inherit the host page's context (its policy, its origin's records, its realm's parsers) | The view is a `srcdoc` document, which is the host page's in every way the browser inherits | [03](03-served-document.md): the view lives in a served file whose only policy is its own, and guest content never runs with an origin's authority |

A fourth, found while measuring the third: the browser's autofill writes the user's data into a guest's form fields.
That one is built ([04](04-forms-and-autofill.md)) and is here because the served document depends on it.

## The files

| File | Holds |
| :--- | :--- |
| [01-one-element-one-app.md](01-one-element-one-app.md) | `start()`, the app and the embedder's grants, what leaves the element, the lifecycle, commits, events |
| [02-what-an-app-hands-over.md](02-what-an-app-hands-over.md) | `links`, no `Blob` from the guest, a write's type, `GuestBytes`, `unknown`, the registry of guest values |
| [03-served-document.md](03-served-document.md) | `sealed-document.html`, `documentUrl`, who is trusted with it, what is inside the file, the start-up order and gates, the thinner host |
| [04-forms-and-autofill.md](04-forms-and-autofill.md) | The value model (built), and what the served document still has to show for it |
| [05-build-order.md](05-build-order.md) | The order of the work, the tests each step brings, what is measured before what is promised |
| [REVIEW-1.md](REVIEW-1.md) | The first adversarial review, of the design before it was revised; [review-1/](review-1/p1-output.txt) has its probes |
| [REVIEW-2.md](REVIEW-2.md) | The second adversarial review, of the design after the first; [review-2/](review-2/p1-output.txt) has its probes |
| [REVIEW-3.md](REVIEW-3.md) | The third adversarial review, of steps 1 and 2 as built (at `7dfec16`); [review-3/](review-3/p4-output.txt) has its probes and their output |

## The invariants

Each is one sentence that must hold, the rung it stands on (CLAUDE.md: impossible to build, impossible to reach, a
check, a documented limit), and the test that will enumerate it. A review of this design is a search for a case where
one of them does not hold, or where its rung is lower than stated. The numbers are stable: review 1 cites I1 to I16,
I17 and I18 came from it, and review 2 cites all eighteen.

| # | Invariant | Rung | Where | Structural test (planned unless marked built) |
| :--- | :--- | :--- | :--- | :--- |
| I1 | An element holds at most one app for its whole life | impossible to build through the element's members (a host-page script that writes the element's internal fields is the page's own code, [01](01-one-element-one-app.md#what-leaves-the-element)): no member binds a second, and the check that the element has no app and the storing of the validated values are one step, with no code of the embedder's between them | [01](01-one-element-one-app.md) | `APP_SURFACE` (`src/lib/app-surface.ts`): every member of the element in the API report is classified as binding, acting on the bound app, or neither; exactly one binds. A unit test: a getter of the app that calls `start()` (built: `test/unit/app-surface.test.ts`, `test/unit/start.test.ts`) |
| I2 | Nothing of an app is stored unless all of it was valid by the rules the host page can decide without parsing guest text | impossible to build: validation returns the values that are stored | [01](01-one-element-one-app.md) | a unit test over every way `start()` throws: the element equals a new one |
| I3 | A host method is reachable only by the app it was given with, in the document the embedder's `documentUrl` serves | impossible to build on the element; **a documented limit** for the host that answers `documentUrl`, which is trusted with the app ([03](03-served-document.md#who-is-trusted-with-the-app)); against a page that frames the host page it rests on the browser keeping a frame in a shadow root out of `window.frames` ([03](03-served-document.md#the-shape)) | [01](01-one-element-one-app.md) | `APP_SURFACE`; the lifecycle model with no input that changes methods; an e2e spec: a cross-site page that frames the host page finds no frame; a `<base>` in the host page does not move `documentUrl` |
| I4 | A commit stores only bytes the embedder was handed, and only while they are still what is pending | impossible to build: a commit takes the write values the library minted, and a value commits only if its entry is its path's current pending entry, by identity | [01](01-one-element-one-app.md) | a unit test: a guest write, a commit, a `reset()` or a re-insertion after the list each leave the listed value uncommittable |
| I5 | An event that carries guest data does not bubble: a listener on an ancestor receives it only if it was added for the capture phase | **a documented limit** for capture listeners; by construction for bubbling ones | [01](01-one-element-one-app.md#events) | `ELEMENT_EVENTS`: each event that carries guest data has "Does not bubble." (built: its `guestData` field, `test/unit/element-events.test.ts`) |
| I6 | No text of the guest's reaches a URL the library opens, and an intact view asks for a tab only in the user's click on a listed link | impossible to build for the URL (an index crosses); for the moment, as strong as the view: a view that runs guest script could ask for any listed URL within the browser's 5 seconds of any click | [02](02-what-an-app-hands-over.md) | the frame builders: the message has one integer; an e2e spec with the popup blocker on |
| I7 | No `Blob` or `File` from the guest reaches the embedder's code | impossible to build: the measure of a guest value refuses both before anything is handed on | [02](02-what-an-app-hands-over.md) | the snapshot measure's enumeration of value kinds (built: `SNAPSHOT_REFUSED_KINDS`, `test/unit/snapshot-kinds.test.ts`, `test/e2e/guest-blob-refused.spec.ts`) |
| I8 | A guest write's type and its name agree | impossible to build: the type is a function of the path | [02](02-what-an-app-hands-over.md) | a unit test over the type table (built: `FILE_TYPES`, `test/unit/file-types.test.ts`) |
| I9 | A `Blob` the library makes from guest bytes has a type the library chose, and a file the library saves has a name the library chose | impossible to build inside `GuestBytes`, whose `save()` names the file in its own step; **a check** for the embedder, who can still call `bytes()` and type or name the result | [02](02-what-an-app-hands-over.md) | a unit test over `GUEST_IMAGE_TYPES` and bytes of other kinds (SVG, HTML, a polyglot); an e2e spec on three engines for the saved names (`invoice.pdf.exe`, `report.html`) |
| I10 | Every value the public API hands the embedder is classified: the library's, the embedder's, or the guest's | a check, run over the whole API report | [02](02-what-an-app-hands-over.md) | `GUEST_VALUES` (`src/lib/guest-values.ts`) against the API report (built: `test/unit/guest-values.test.ts`) |
| I11 | Guest content never runs with an origin's authority, however the served file is opened | impossible to build, for the file of the package: the only document that could hold that authority runs nothing of the guest's, and the view's `sandbox` attribute is a byte of a static file | [03](03-served-document.md) | research 28's twelve ways of opening the file, as an e2e spec against the shipped file, framed with the flags the element uses |
| I12 | The served file's text has no input: one text per library version, the same in both builds | impossible to build, for the package's bytes: sealed mode's view bootstrap is the same in both builds, and the file is generated from it. What a server answers is checked where the answer can be read ([03](03-served-document.md#the-check-of-the-file)): a check, for honest deployments | [03](03-served-document.md) | a unit test: both builds emit the same bytes; each way a deployment changes the file ends with its reason |
| I13 | Nothing can relay between the host page and the view | impossible to build, for the file of the package: it has no script that handles a message; the ports go from the host to the view. Against a page that frames the host page, as I3 | [03](03-served-document.md) | a source scan of the file: one script, the guard, with no listener; I3's framing spec |
| I14 | The served file builds the view only where it is framed and opaque | a check, in the file's one script | [03](03-served-document.md) | research 28's guarded cases as an e2e spec |
| I15 | A browser that does not enforce what the design assumes ends the sandbox with a reason: the view's gates answer before anything of the guest's is sent, the worker's before any guest code runs, and both before any data of the embedder's is sent | a check of the browser, at start-up only; measured in that form, with a library worker (research 31) | [03](03-served-document.md#the-start-up-order) | each gate under the mutant that provokes it, on three engines, in the static file; no call reaches a worker whose gate failed |
| I16 | The guest receives from a form control only what the user entered into that control | a model in the view, independent of the browser's rules; **built** | [04](04-forms-and-autofill.md) | `test/unit/view-autofill.test.ts`, `test/e2e/view-values.spec.ts` (built) |
| I17 | The app argument cannot carry a grant | impossible to build, for that argument: the app and the embedder's grants are two arguments, each read by its own schema, and the app's schema refuses a key that is a grant. A grant is whatever the embedder passes as the second | [01](01-one-element-one-app.md#startapp-grants) | `CONFIG_SCHEMA`: every option, the ones no longer accepted included, is classified as the app's or the embedder's, and the two types are derived from it |
| I18 | No policy but the file's own sends a report that carries guest text: a policy that refuses one of the check's canaries ends the build, and under one that does not, the view makes no load of the guest's choosing | two checks. At start-up, in the view before anything of the guest's is sent and in the worker before the guest's entry runs: per directive of the file's policy (`POLICY_DIRECTIVES`) a load the policy admits and one it refuses, so it sees a policy that lets the view's bootstrap run and treats either differently; it does not see a `form-action` header or one that names the canaries' own host (research 31). Behind it, the renderer's rules that keep a guest-chosen font, media, frame, object or form target from existing. The check of the file names the headers where it can read the answer | [03](03-served-document.md#the-policies-in-force) | `POLICY_DIRECTIVES` against the `<meta>`'s text: every directive has its admitted canary, its refused canary, or the reason it has none; each kind of load the view makes (`VIEW_LOAD_KINDS`) under a header on the file, enforced and report-only: a named termination and no report that carries guest text; a guest font, media, frame, object and form under each of the five directives the renderer's rules close: no report that carries guest text; on three engines |

## What review 1 changed

| Finding | What the design says now | Where |
| :--- | :--- | :--- |
| 1 · a header on the served file is an inherited policy | A row of `INHERITED_CONTEXT` for the file's response headers; a start-up gate that ends the build under any policy that is not the file's own (I18); every mitigation the view has for a host page's policy stays; the docs say what "no server config" excludes | [03](03-served-document.md#the-policies-in-force), [05](05-build-order.md) step 4 |
| 2 · whoever answers `documentUrl` receives the app | Stated as a limit: that host is trusted with the app, as the host of the library's own code is. A second hostname adds a trusted host. A default `documentUrl` from the bundle's own asset is proposed | [03](03-served-document.md#who-is-trusted-with-the-app) |
| 3 · the gates were measured in a file the design does not build | The gates run in the view and the worker only; the host page sends nothing of the guest's until the view has announced its bootstrap's hash and the gates' verdict; to be measured in that form | [03](03-served-document.md#the-start-up-order) |
| 4 · the view inherits the file's sandbox flags | The view's static attribute is the most the library ever grants; the element narrows it per app with the file's own attribute | [03](03-served-document.md#the-shape) |
| 5 · a non-bubbling event reaches capture listeners | I5 restated as what holds | [01](01-one-element-one-app.md#events) |
| 6 · `links` sat beside the app's own content | The app and the embedder's grants are two arguments (I17) | [01](01-one-element-one-app.md#startapp-grants) |
| 7 · the bootstrap differs between the builds | Sealed mode's view bootstrap is the same in both builds; a copy of another version is detected by the version the view states | [03](03-served-document.md#the-public-surface) |
| 8 · the quota needs the module rewrite the design moves | `start()` decides what the host page can decide without parsing guest text; what needs a parse is decided where the parse runs and ends the build with a reason | [01](01-one-element-one-app.md#startapp-grants), [03](03-served-document.md#a-thinner-host) |
| 9 · step 4 would delete code the file's own policy needs | Step 4 deletes host-realm code only | [05](05-build-order.md) |
| 10 · a stale write value stays committable | A value commits only while its entry is its path's current pending entry | [01](01-one-element-one-app.md#files-and-commits) |
| 11 · `start()` is re-entrant through getters | The check and the store are one step | [01](01-one-element-one-app.md#startapp-grants) |
| 12 · no member says whether an element is bound | A read-only `started`; the documented set-up makes and removes its own element | [01](01-one-element-one-app.md#the-lifecycle) |
| 13 · `download()` leaves the file's name to the embedder | `save()`: the library saves the file under its own name | [02](02-what-an-app-hands-over.md#guestbytes) |
| Claims that did not match | `BD5:CHL-1` is no longer listed as closed; the test migration's size is corrected; research 30 is cited for what it measured; I7 says "reaches the embedder" | [01](01-one-element-one-app.md), [02](02-what-an-app-hands-over.md) |
| What the design did not specify | Each item has its answer in the file it concerns | 01, 02, 03 |

## Decided after review 1

Each changes a public name or a promise the owner had accepted. The owner approved all five as recommended, on
2026-11-18.

| # | Decision | Decided | The alternative, not chosen |
| :--- | :--- | :--- | :--- |
| 1 | The app and the grants as two arguments: `start(app, grants)`, with the types `SandboxApp` and `SandboxGrants` in place of one value with a `config` (finding 6) | yes | `links`, `guestWrites` and `capabilities` stay in the value an app bundle is naturally stored as, and "the embedder lists the links" is a convention |
| 2 | A read-only `started` on the element (finding 12) | yes | an embedder cannot tell a new element from a bound one outside its document, and a framework's double set-up has no guard to write |
| 3 | `GuestBytes.download()` answers a `File` named by the library, in place of a `Blob` (finding 13). **Does not do what it was for** (review 2, finding 3, run): two engines of three ignore the name. Its replacement, `save()`, is approved ([02](02-what-an-app-hands-over.md#guestbytes)) | yes | the name stays the embedder's to choose, and the natural choice is the guest's path |
| 4 | `documentUrl` optional, defaulting to the bundle's own copy of the file (finding 2) | yes, once the bundlers that matter are measured to serve it; until then it stays required. **Measured** ([research 32](../research/32_document_asset/README.md)): most do not, so it stays required | every embedder names a URL, and may name one on a host that adds a trust root |
| 5 | Guest data as DOM events that do not bubble, with I5 as restated (finding 5) | keep the events | handlers given with the grants, called by the element, so that no event object travels the tree |

## What review 2 changed

| Finding | What the design says now | Where |
| :--- | :--- | :--- |
| 1 · a relative `documentUrl` follows an injected `<base>` | It is resolved against the document's own URL | [03](03-served-document.md#the-public-surface) |
| 2 · the pattern built on `started` restarts the old app silently | The documented set-up makes and removes its own element; no pattern branches on `started` | [01](01-one-element-one-app.md#the-lifecycle) |
| 3 · two engines ignore the name of the `File` from `download()` | `save()`: the library saves the file itself | [02](02-what-an-app-hands-over.md#guestbytes); approved by the owner |
| 4 · the worker cannot run its gates before the app is sent | The worker's gates run in its prelude before the entry runs; `'ready'` and the waiting calls follow its verdicts; I15 says so | [03](03-served-document.md#the-start-up-order) |
| 5 · an enforced site-wide header stops the view before it can report | The check of the file names it where the answer can be read; elsewhere it is listed under "did not answer" | [03](03-served-document.md#the-check-of-the-file) |
| 6 · step 4 and "one bootstrap" in the network build | Step 4 deletes sealed mode's paths only; the two bootstraps have their own names | [03](03-served-document.md#the-network-build), [05](05-build-order.md) |
| 7 · the announced hash checks a version, not the file | Said as that; the check of the file reads the bytes where it can | [03](03-served-document.md#the-check-of-the-file) |
| 8 · the closed shadow root keeps framing pages out, unstated | Stated, with its test; one load of the file's frame per build; no referrer | [03](03-served-document.md#the-shape) |
| 9 · `links`: the app picks the link on every click | Said, with the bits per click in the egress row; a click on a form control inside a link sends nothing | [02](02-what-an-app-hands-over.md) |
| 10 · a commit skips silently | All or none, answering `true` or `false` | [01](01-one-element-one-app.md#files-and-commits); approved by the owner |
| 11 · the moved parsers sit beside the value model | They go into the worker's prelude where the code allows; the view keeps the stylesheet cut | [03](03-served-document.md#a-thinner-host) |
| 12 · I17's rung, and unclassified options | I17 restated; every option classified | [01](01-one-element-one-app.md#startapp-grants) |
| 13 · host pages the design leaves out | Named as a cost | [03](03-served-document.md#the-public-surface); the rule the owner approved |
| Not specified | The order to `'ready'`, the second load, the referrer, the reasons from a parse, no release inside step 3 | [03](03-served-document.md), [05](05-build-order.md) |

## What review 3 found

[REVIEW-3.md](REVIEW-3.md) attacked steps 1 and 2 as built. Eight of nine reverted mitigations failed their named
test, and the ninth behaves as the code does; no test had been changed to fit the code.

| Finding | Class | Answer |
| :--- | :--- | :--- |
| 1 · on Firefox one held key opens a tab per key repeat, and the guest picks each URL | a channel's bound fails open (data) | one request a user action, decided in the view: no click is a request while a key is held (`in-sandbox-view.ts`, the held-key flag; `test/unit/view-links.test.ts`); at the host, at most `LINK_TABS_PER_SECOND` tabs in any one-second window per element (`links.ts`, `createLinkTabLimiter`; `test/unit/links.test.ts`); the held key on Firefox and Chromium in `test/e2e/links-popup-blocker.spec.ts`, on three engines in `test/e2e/links.spec.ts` ([02](02-what-an-app-hands-over.md)) |
| 2 · the docs do not say the guest chooses the focus an Enter acts on | docs | said where the click is described: the `links` grant's TSDoc and docs/API.md's [`links`](../API.md#links), the README, [THREAT-MODEL](../THREAT-MODEL.md) and [02](02-what-an-app-hands-over.md): the app chooses which listed link is under the pointer or has the focus, one choice per user action; list only URLs the app may send the user to at any moment |
| 3 · a write whose rewrites pass the quota is recorded, and no commit can take it | correctness, docs | the module comment of `guest-writes.ts` and docs/API.md's [Guest writes](../API.md#guest-writes) say what holds: such a write is recorded and listed, every commit of it is refused `FILES_QUOTA_EXCEEDED` and changes nothing; `test/unit/guest-writes.test.ts` has the case; the quota counts the bytes given from step 3.7 on |
| 4 · `GUEST_VALUES` files sizes and a guest's choices within a closed set as the library's | docs (classification) | the rows take the guest as owner, each with its `bound` (`src/lib/guest-values.ts`), and so do a fetch record's `bytes`, `durationMs`, `outcome` and `code` and an `RpcError`'s `code`; a value of the library's beside one of the guest's names its source (`from`), which `test/unit/guest-values.test.ts` checks |
| 5 · a resizable `ArrayBuffer` is measured by its length and keeps its maximum | availability | the measure refuses a resizable buffer and a view over one, with its kind named (`SNAPSHOT_REFUSED_KINDS`, `src/lib/structured-size.ts`; `test/unit/snapshot-kinds.test.ts`, `test/e2e/guest-blob-refused.spec.ts` on three engines); what the browser does before any receiver measures it is [S89](../BACKLOG.md#s89) |

## What research 31 changed

It supports the shape, the flags, the shadow root, the referrer rule, the version constant, the start-up order
and the gates as written, on Chromium 159, Firefox 159 and WebKit 27.2.

| What it found | What changed | Where |
| :--- | :--- | :--- |
| The policy check sees a report-only `worker-src` only through a worker | The view starts a canary worker of its own before it answers | [03](03-served-document.md#what-the-policy-check-provokes) |
| The check passes under report-only `font-src`, `media-src`, `form-action`, `frame-src` and `object-src`, and a guest's load would then be reported | I18 restated: the check does not close the report channel alone; the renderer's five rules are named as what does, with a test. A refused canary per directive, in both schemes, sees all of them but `form-action` (on Chromium the refused form ends the view) and a header that names the canaries' host: the directives become one list, `POLICY_DIRECTIVES` | [03](03-served-document.md#what-the-policy-check-provokes) |
| A header that repeats the `<meta>`'s text, enforced, is told from the `<meta>` only by a count of events | Not looked for: with the `<meta>`'s text it names no report endpoint, so nothing is sent under it | [03](03-served-document.md#what-the-policy-check-provokes) |
| A server that answers every path with a page that has a frame: that frame received the first port | The view speaks first, and the host page sends a port only to the window that announced itself from the first frame of the element's own frame: a document that does not claim to be the view receives none | [03](03-served-document.md#who-receives-the-first-port) |
| The fixture's check counted events in windows of time and refused a clean file in 3 of 400 starts on Firefox, which files a worker's refused script loads in the view's document | The check has no clock: an event is attributed by what it carries, and the only time limit is the host page's load timeout. Measured: none of 400 refused on Chromium and Firefox; on a loaded WebKit a 600 ms limit of the probe's own refused 5 of 200 | [03](03-served-document.md#what-the-policy-check-provokes) |
| A file without its guard, wrongly framed, passes every gate and the check | Said: only the check of the file's bytes finds it | [03](03-served-document.md#inside-the-file) |
| Reports sent at start-up carried the host page's URL as their referrer | The frame's `no-referrer` is stated as needed for this too | [03](03-served-document.md#the-shape) |
| `crypto.subtle` is absent from the view under a host page that is not a secure context | The reason the version is a constant | [03](03-served-document.md#the-public-surface) |
| WebKit raises the events and sends almost no report | Replaces "not measured on WebKit" | [03](03-served-document.md#what-the-policy-check-provokes) |

## Decided after review 2 and the first two steps

The owner approved each as recommended, on 2026-11-19.

| # | Decision | Decided | The alternative, not chosen |
| :--- | :--- | :--- | :--- |
| 1 | `GuestBytes.save(): void` in place of `download()` (review 2, finding 3) | yes | `download()` stays, and the name holds only when the embedder copies it into a link's `download` attribute |
| 2 | `commitGuestWrites()` commits all of its list or none, and answers `boolean` (review 2, finding 10) | yes | stale values are skipped one by one, and the embedder cannot tell which were committed |
| 3 | A host page that is not on `http(s)` (review 2, finding 13; [research 34](../research/34_non_http_host/README.md)) | no `srcdoc` path. `documentUrl` is `http(s)`, or a URL of the host page's own origin where that origin is not opaque (Electron's `file:` and an app's own standard scheme, where the guard was measured to hold); a browser's `file:` page and an extension's page name an `http(s)` copy ([03](03-served-document.md#the-public-surface); [05](05-build-order.md), 3.10) | a `srcdoc` path for those pages, which keeps the code step 4 deletes |
| 4 | A `Blob` or a `File` crosses in neither direction, where the design asked for the guest's direction only | yes: the measure is one list for both directions | a direction in the measure, and a host's `Blob` reaches the guest |
| 5 | `links` in strict mode as in sealed mode | yes: the mechanism is the view's, which both modes share | sealed mode alone, and a second egress table |
| 6 | Steps 1 and 2 are merged before step 3.2, and step 3 has a pull request of its own | yes: between 3.2 and 3.6 the branch is in an intermediate state ([05](05-build-order.md)) | one pull request until step 3 is whole |

## What the design does not do

- It does not stop the embedder's own code. A host method is the embedder's code with the page's rights, and
  `window.open(String(argument))` in one still works.
- It does not protect the app from the host that serves the file. Whoever answers `documentUrl` receives the app's
  files and its ports ([03](03-served-document.md#who-is-trusted-with-the-app)).
- It does not give the host page its thread back. On Firefox, WebKit, Safari, Android WebView and Chromium's headless
  shell the view shares the host page's thread wherever the served file lives
  ([research 28](../research/28_served_topology/README.md), Q4).
- It does not reach a browser extension. An extension with access to the page reads and writes every frame of it, the
  view included.
- It does not remove the permission state keyed to the top-level page (geolocation, on Chromium's view and WebKit's
  worker), and an opaque origin alone does not stop credentialed requests: the policy's `connect-src 'none'` does.
- It does not cover the network modes. Strict, cooperative and worker mode keep the documents they have; they lose the
  same members of the element ([01](01-one-element-one-app.md)), so that there is one element API.

## Not measured

Stated once here; each file repeats what concerns it.

- Safari on macOS and iOS, and Android, for everything: the served file, the popup blocker, autofill.
- The served file as it will ship: one static file per library version, with the library's real bootstrap. Research
  28's spike served the library's per-build wrapper; research 31 built this design's shape and start-up as a fixture,
  with no bundle of the library's.
- The policy check in the library's bundle, and with no time limit of its own on a loaded WebKit
  ([03](03-served-document.md#what-the-policy-check-provokes)).
- `links` as designed: the click as the request, in the served file. Research 30 measured a call from the worker, in
  today's view.
- Autofill inside the served file, with the value model.
- A password manager's extension, and one when another site frames the served file.
- The check of the file: its cost, and what stands in its path on a host page.
- Report-only headers on the file that are not Content-Security-Policy.
- Extensions on Firefox, WebKit and Safari, and Tauri and Capacitor, as host pages (research 34 measured a browser's
  `file:` page, a Chromium extension and Electron).
