# Design: one app per element, the hand-offs, and the served document

**Status: a design, not built.** Nothing in this folder describes the code as it is. The code as it is: [API.md](../API.md),
[THREAT-MODEL.md](../THREAT-MODEL.md), [ARCHITECTURE.md](../../ARCHITECTURE.md). The one part that is built is named as
such where it appears (the view's value model for form controls, [04](04-forms-and-autofill.md)).

**Decided by the owner.** Sealed mode alone is the default build (D9, [ADR-009](../ADR-009-network-modes-build-flag.md)).
Sealed mode's document becomes a static file the embedder serves, with its policy in a `<meta>` tag and no `srcdoc`
fallback (D8, 2026-11-07). The binding method is named `start` (2026-11-18). The owner accepted the rest of the design
in outline on 2026-11-18, before its review, and the five answers of the review that change a public name or an accepted
promise on 2026-11-18, after it ([below](#decided-after-review-1)).

**Reviewed once.** [REVIEW-1.md](REVIEW-1.md) is an independent adversarial pass on the design as it stood at `6b2f22f`,
with its probes and their output in [review-1/](review-1/p1-output.txt). The files of this folder are the design after
that review: [what the review changed](#what-review-1-changed) lists each finding and where its answer is.

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
| [REVIEW-1.md](REVIEW-1.md) | The adversarial review of the design before it was revised; [review-1/](review-1/p1-output.txt) has its probes |

## The invariants

Each is one sentence that must hold, the rung it stands on (CLAUDE.md: impossible to build, impossible to reach, a
check, a documented limit), and the test that will enumerate it. A review of this design is a search for a case where
one of them does not hold, or where its rung is lower than stated. The numbers are stable: review 1 cites I1 to I16, and
I17 and I18 came from it.

| # | Invariant | Rung | Where | Structural test (planned unless marked built) |
| :--- | :--- | :--- | :--- | :--- |
| I1 | An element holds at most one app for its whole life | impossible to build: no member binds a second, and the check that the element has no app and the storing of the validated values are one step, with no code of the embedder's between them | [01](01-one-element-one-app.md) | `APP_SURFACE` (`src/lib/app-surface.ts`): every member of the element in the API report is classified as binding, acting on the bound app, or neither; exactly one binds. A unit test: a getter of the app that calls `start()` |
| I2 | Nothing of an app is stored unless all of it was valid by the rules the host page can decide without parsing guest text | impossible to build: validation returns the values that are stored | [01](01-one-element-one-app.md) | a unit test over every way `start()` throws: the element equals a new one |
| I3 | A host method is reachable only by the app it was given with, in the document the embedder's `documentUrl` serves | impossible to build on the element; **a documented limit** for the host that answers `documentUrl`, which is trusted with the app ([03](03-served-document.md#who-is-trusted-with-the-app)) | [01](01-one-element-one-app.md) | `APP_SURFACE`; the lifecycle model with no input that changes methods |
| I4 | A commit stores only bytes the embedder was handed, and only while they are still what is pending | impossible to build: a commit takes the write values the library minted, and a value commits only if its entry is its path's current pending entry, by identity | [01](01-one-element-one-app.md) | a unit test: a guest write, a commit, a `reset()` or a re-insertion after the list each leave the listed value uncommittable |
| I5 | An event that carries guest data does not bubble: a listener on an ancestor receives it only if it was added for the capture phase | **a documented limit** for capture listeners; by construction for bubbling ones | [01](01-one-element-one-app.md#events) | `ELEMENT_EVENTS`: each event that carries guest data has "Does not bubble." |
| I6 | No text of the guest's reaches a URL the library opens, and an intact view asks for a tab only in the user's click on a listed link | impossible to build for the URL (an index crosses); for the moment, as strong as the view: a view that runs guest script could ask for any listed URL within the browser's 5 seconds of any click | [02](02-what-an-app-hands-over.md) | the frame builders: the message has one integer; an e2e spec with the popup blocker on |
| I7 | No `Blob` or `File` from the guest reaches the embedder's code | impossible to build: the measure of a guest value refuses both before anything is handed on | [02](02-what-an-app-hands-over.md) | the snapshot measure's enumeration of value kinds |
| I8 | A guest write's type and its name agree | impossible to build: the type is a function of the path | [02](02-what-an-app-hands-over.md) | a unit test over the type table |
| I9 | A `Blob` or `File` the library makes from guest bytes has a type and a name the library chose | impossible to build inside `GuestBytes`; **a check** for the embedder, who can still call `bytes()` and type or name the result | [02](02-what-an-app-hands-over.md) | a unit test over `GUEST_IMAGE_TYPES`, bytes of other kinds (SVG, HTML, a polyglot) and names (`invoice.pdf.exe`, `report.html`) |
| I10 | Every value the public API hands the embedder is classified: the library's, the embedder's, or the guest's | a check, run over the whole API report | [02](02-what-an-app-hands-over.md) | `GUEST_VALUES` (`src/lib/guest-values.ts`) against the API report |
| I11 | Guest content never runs with an origin's authority, however the served file is opened | impossible to build, for the file of the package: the only document that could hold that authority runs nothing of the guest's, and the view's `sandbox` attribute is a byte of a static file | [03](03-served-document.md) | research 28's twelve ways of opening the file, as an e2e spec against the shipped file, framed with the flags the element uses |
| I12 | The served file's text has no input: one text per library version, the same in both builds | impossible to build: sealed mode's view bootstrap is the same in both builds, and the file is generated from it | [03](03-served-document.md) | a unit test: both builds emit the same bytes |
| I13 | Nothing can relay between the host page and the view | impossible to build, for the file of the package: it has no script that handles a message; the ports go from the host to the view | [03](03-served-document.md) | a source scan of the file: one script, the guard, with no listener |
| I14 | The served file builds the view only where it is framed and opaque | a check, in the file's one script | [03](03-served-document.md) | research 28's guarded cases as an e2e spec |
| I15 | A browser that does not enforce what the design assumes ends the sandbox before any guest content is sent, with a reason | a check of the browser, at start-up only, in the view and the worker; **to be measured in that form** | [03](03-served-document.md#the-start-up-order) | each gate under the mutant that provokes it, on three engines, in the static file |
| I16 | The guest receives from a form control only what the user entered into that control | a model in the view, independent of the browser's rules; **built** | [04](04-forms-and-autofill.md) | `test/unit/view-autofill.test.ts`, `test/e2e/view-values.spec.ts` (built) |
| I17 | An app's own content cannot grant itself anything | impossible to build: the app and the embedder's grants are two arguments, each read by its own schema, and the app's schema refuses a key that is a grant | [01](01-one-element-one-app.md#startapp-grants) | `CONFIG_SCHEMA`: every option is classified as the app's or the embedder's, and the two types are derived from it |
| I18 | The view runs under the file's own policy and no other, or the build ends | a check, at start-up, before any guest content is sent; the mitigations for a host page's policy stay in place behind it | [03](03-served-document.md#the-policies-in-force) | each kind of load the view makes (`VIEW_LOAD_KINDS`) under a header on the file, enforced and report-only: a named termination and no report that carries guest text, on three engines |

## What review 1 changed

| Finding | What the design says now | Where |
| :--- | :--- | :--- |
| 1 · a header on the served file is an inherited policy | A row of `INHERITED_CONTEXT` for the file's response headers; a start-up gate that ends the build under any policy that is not the file's own (I18); every mitigation the view has for a host page's policy stays; the docs say what "no server config" excludes | [03](03-served-document.md#the-policies-in-force), [05](05-build-order.md) step 4 |
| 2 · whoever answers `documentUrl` receives the app | Stated as a limit: that host is trusted with the app, as the host of the library's own code is. A second hostname adds a trusted host. A default `documentUrl` from the bundle's own asset is proposed | [03](03-served-document.md#who-is-trusted-with-the-app) |
| 3 · the gates were measured in a file the design does not build | The gates run in the view and the worker only; the host page sends nothing of the guest's until the view has announced its bootstrap's hash and the gates' verdict; to be measured in that form | [03](03-served-document.md#the-start-up-order) |
| 4 · the view inherits the file's sandbox flags | The view's static attribute is the most the library ever grants; the element narrows it per app with the file's own attribute | [03](03-served-document.md#the-shape) |
| 5 · a non-bubbling event reaches capture listeners | I5 restated as what holds | [01](01-one-element-one-app.md#events) |
| 6 · `links` sat beside the app's own content | The app and the embedder's grants are two arguments (I17) | [01](01-one-element-one-app.md#startapp-grants) |
| 7 · the bootstrap differs between the builds | Sealed mode's view bootstrap is the same in both builds, and the file is checked by its hash | [03](03-served-document.md#the-public-surface) |
| 8 · the quota needs the module rewrite the design moves | `start()` decides what the host page can decide without parsing guest text; what needs a parse is decided where the parse runs and ends the build with a reason | [01](01-one-element-one-app.md#startapp-grants), [03](03-served-document.md#a-thinner-host) |
| 9 · step 4 would delete code the file's own policy needs | Step 4 deletes host-realm code only | [05](05-build-order.md) |
| 10 · a stale write value stays committable | A value commits only while its entry is its path's current pending entry | [01](01-one-element-one-app.md#files-and-commits) |
| 11 · `start()` is re-entrant through getters | The check and the store are one step | [01](01-one-element-one-app.md#startapp-grants) |
| 12 · no member says whether an element is bound | A read-only `started` | [01](01-one-element-one-app.md#the-lifecycle) |
| 13 · `download()` leaves the file's name to the embedder | `download()` answers a `File` the library named | [02](02-what-an-app-hands-over.md#guestbytes) |
| Claims that did not match | `BD5:CHL-1` is no longer listed as closed; the test migration's size is corrected; research 30 is cited for what it measured; I7 says "reaches the embedder" | [01](01-one-element-one-app.md), [02](02-what-an-app-hands-over.md) |
| What the design did not specify | Each item has its answer in the file it concerns | 01, 02, 03 |

## Decided after review 1

Each changes a public name or a promise the owner had accepted. The owner approved all five as recommended, on
2026-11-18.

| # | Decision | Decided | The alternative, not chosen |
| :--- | :--- | :--- | :--- |
| 1 | The app and the grants as two arguments: `start(app, grants)`, with the types `SandboxApp` and `SandboxGrants` in place of one value with a `config` (finding 6) | yes | `links`, `guestWrites` and `capabilities` stay in the value an app bundle is naturally stored as, and "the embedder lists the links" is a convention |
| 2 | A read-only `started` on the element (finding 12) | yes | an embedder cannot tell a new element from a bound one outside its document, and a framework's double set-up has no guard to write |
| 3 | `GuestBytes.download()` answers a `File` named by the library, in place of a `Blob` (finding 13) | yes | the name stays the embedder's to choose, and the natural choice is the guest's path |
| 4 | `documentUrl` optional, defaulting to the bundle's own copy of the file (finding 2) | yes, once the bundlers that matter are measured to serve it; until then it stays required | every embedder names a URL, and may name one on a host that adds a trust root |
| 5 | Guest data as DOM events that do not bubble, with I5 as restated (finding 5) | keep the events | handlers given with the grants, called by the element, so that no event object travels the tree |

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
- The served file as it will ship: one static file per library version, with the library's real bootstrap, framed with
  the flags the element uses (`allow-forms` among them), with the gates in the view. Research 28's spike served the
  library's per-build wrapper, and its gates ran in a file with a script of its own.
- `links` as designed: the click as the request, in the served file. Research 30 measured a call from the worker, in
  today's view.
- Autofill inside the served file, with the value model.
- Whether a page that frames the host page can reach the file's frame and navigate it before its first load. Today's
  view has the same question.
- A password manager's extension.
