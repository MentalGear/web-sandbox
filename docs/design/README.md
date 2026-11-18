# Design: one app per element, the hand-offs, and the served document

**Status: a design, not built.** Nothing in this folder describes the code as it is. The code as it is: [API.md](../API.md),
[THREAT-MODEL.md](../THREAT-MODEL.md), [ARCHITECTURE.md](../../ARCHITECTURE.md). The one part that is built is named as
such where it appears (the view's value model for form controls, [04](04-forms-and-autofill.md)).

**Decided by the owner.** Sealed mode alone is the default build (D9, [ADR-009](../ADR-009-network-modes-build-flag.md)).
Sealed mode's document becomes a static file the embedder serves, with its policy in a `<meta>` tag and no `srcdoc`
fallback (D8, 2026-11-07). The binding method is named `start` (2026-11-18). The owner accepted the rest of this design
in outline on 2026-11-18, before the adversarial review of it; what the review changes comes back to the owner where it
touches a public name or a documented promise.

## What the design is for

Seven review passes found the same three kinds of finding in sealed mode, and each kind has one root:

| Kind of finding | Root | This design's answer |
| :--- | :--- | :--- |
| One app's methods, files, pending writes or late calls reach the next app on the same element | An app is assembled on the element in several calls, and nothing ends what the last app left | [01](01-one-element-one-app.md): one element runs one app, given once, in one value |
| The embedder turns guest data into something with the host page's authority (a navigation, a `blob:` document, a typed file), and the documented recipe for it is wrong | Guest data arrives as ordinary data, and every step that carries authority is hand-written by the embedder | [02](02-what-an-app-hands-over.md): the steps that carry authority are the library's; guest data stays data |
| The sandbox's documents inherit the host page's context (its policy, its origin's records, its realm's parsers) | The view is a `srcdoc` document, which is the host page's in every way the browser inherits | [03](03-served-document.md): the view lives in a served file with a policy of its own, and guest content never runs with an origin's authority |

A fourth, found while measuring the third: the browser's autofill writes the user's data into a guest's form fields.
That one is built ([04](04-forms-and-autofill.md)) and is here because the served document depends on it.

## The files

| File | Holds |
| :--- | :--- |
| [01-one-element-one-app.md](01-one-element-one-app.md) | `start(app)`, `SandboxApp`, what leaves the element, the lifecycle, commits, events |
| [02-what-an-app-hands-over.md](02-what-an-app-hands-over.md) | `links`, no `Blob` from the guest, a write's type, `GuestBytes`, `unknown`, the registry of guest values |
| [03-served-document.md](03-served-document.md) | `sealed-document.html`, `documentUrl`, what is inside the file, the start-up gates, the thinner host |
| [04-forms-and-autofill.md](04-forms-and-autofill.md) | The value model (built), and what the served document still has to show for it |
| [05-build-order.md](05-build-order.md) | The order of the work, the tests each step brings, what is measured before what is promised |

## The invariants

Each is one sentence that must hold, the rung it stands on (CLAUDE.md: impossible to build, impossible to reach, a
check, a documented limit), and the test that will enumerate it. A review of this design is a search for a case where
one of them does not hold, or where its rung is lower than stated.

| # | Invariant | Rung | Where | Structural test (planned unless marked built) |
| :--- | :--- | :--- | :--- | :--- |
| I1 | An element holds at most one app for its whole life | impossible to build: no member binds a second | [01](01-one-element-one-app.md) | `APP_SURFACE` (`src/lib/app-surface.ts`): every member of the element in the API report is classified as binding, acting on the bound app, or neither; exactly one binds |
| I2 | Nothing of an app is stored unless all of it was valid | impossible to build: validation returns the value that is stored, and nothing is stored before it returns | [01](01-one-element-one-app.md) | a unit test over every way `start()` throws: the element's state, files and methods equal those of a new element |
| I3 | A host method is reachable only by the app it was given with | impossible to build: the methods are a frozen copy made at `start()`, and the element never runs another app | [01](01-one-element-one-app.md) | `APP_SURFACE`; the lifecycle model with no input that changes methods |
| I4 | The bytes a commit stores are bytes the embedder was handed | impossible to build: a commit takes the write values the library minted, by identity | [01](01-one-element-one-app.md) | a unit test: a guest write between `listGuestWrites()` and the commit leaves the path pending |
| I5 | An event that carries guest data reaches only listeners on its own element | impossible to build: the three events do not bubble | [01](01-one-element-one-app.md) | `ELEMENT_EVENTS`: each event that carries guest data has "Does not bubble." |
| I6 | No text of the guest's reaches a URL the library opens, and the library opens a tab only for the user's click on a listed link | impossible to build: an index crosses, never a URL; the view sends it only in a trusted click on that link | [02](02-what-an-app-hands-over.md) | the frame builders: the message has one integer; an e2e spec with the popup blocker on |
| I7 | No `Blob` or `File` whose type the guest chose exists in the host page | impossible to build: the measure of a guest value refuses both | [02](02-what-an-app-hands-over.md) | the snapshot measure's enumeration of value kinds |
| I8 | A guest write's type and its name agree | impossible to build: the type is a function of the path | [02](02-what-an-app-hands-over.md) | a unit test over the type table |
| I9 | A `Blob` the library makes from guest bytes has a type the library chose: an image type its bytes carry the signature of, or `application/octet-stream` | impossible to build inside `GuestBytes`; **a check** for the embedder, who can still call `bytes()` and type the result | [02](02-what-an-app-hands-over.md) | a unit test over `GUEST_IMAGE_TYPES` and bytes of other kinds (SVG, HTML, a polyglot) |
| I10 | Every value the public API hands the embedder is classified: the library's, the embedder's, or the guest's | a check, run over the whole API report | [02](02-what-an-app-hands-over.md) | `GUEST_VALUES` (`src/lib/guest-values.ts`) against the API report |
| I11 | Guest content never runs with an origin's authority, however the served file is opened | impossible to build: the only document that could hold that authority runs nothing of the guest's, and the view's `sandbox` attribute is a byte of a static file | [03](03-served-document.md) | research 28's twelve ways of opening the file, as an e2e spec against the shipped file |
| I12 | The served file's policy has no input | impossible to build: one text per library version, in a file of the package | [03](03-served-document.md) | a unit test: the file's bytes are a function of the library version alone |
| I13 | Nothing can relay between the host page and the view | impossible to build: the file has no script that handles a message; the ports go from the host to the view | [03](03-served-document.md) | a source scan of the file: one script, the guard, with no listener |
| I14 | The served file builds the view only where it is framed and opaque | a check, in the file's one script | [03](03-served-document.md) | research 28's guarded cases as an e2e spec |
| I15 | A browser that does not enforce what the design assumes ends the sandbox at start-up, with a reason | a check of the browser, at start-up only | [03](03-served-document.md) | each gate under the mutant that provokes it, on three engines |
| I16 | The guest receives from a form control only what the user entered into that control | a model in the view, independent of the browser's rules; **built** | [04](04-forms-and-autofill.md) | `test/unit/view-autofill.test.ts`, `test/e2e/view-values.spec.ts` (built) |

## What the design does not do

- It does not stop the embedder's own code. A host method is the embedder's code with the page's rights, and
  `window.open(String(argument))` in one still works.
- It does not give the host page its thread back. On Firefox, WebKit, Safari, Android WebView and Chromium's headless
  shell the view shares the host page's thread wherever the served file lives
  ([research 28](../research/28_served_topology/README.md), Q4).
- It does not reach a browser extension. An extension with access to the page reads and writes every frame of it, the
  view included.
- It does not remove the permission state keyed to the top-level page (geolocation, on Chromium's view and WebKit's
  worker), and an opaque origin alone does not stop credentialed requests: the policy's `connect-src 'none'` does.
- It does not cover the network modes. Strict, cooperative and worker mode keep the documents they have; they lose the
  same six members of the element ([01](01-one-element-one-app.md)), so that there is one element API.

## Not measured

Stated once here; each file repeats what concerns it.

- Safari on macOS and iOS, and Android, for everything: the served file, the popup blocker, autofill.
- The served file as it will ship (one static file per library version, with the library's real bootstrap hash):
  research 28's spike served the library's per-build wrapper.
- Autofill inside the served file, with the value model.
- A password manager's extension.
