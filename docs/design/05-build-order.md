# 05 · The order of the work

**Status: steps 1 and 2 are built, and of step 3 the row 3.1 (each row says so); the rest is a plan.** Each step ends with the repository's gates passing on both builds and three engines
(CONTRIBUTING.md), and each brings the structural test of its invariant ([the folder's index](README.md)). The plan is
the one after [review 1](REVIEW-1.md), the owner's [decisions on it](README.md#decided-after-review-1) and
[review 2](REVIEW-2.md).

## Why this order

`start()` first: it removes the six members and three inputs of the lifecycle model that every later step would
otherwise have to carry. The hand-offs second: they are small, and they change what `GuestWrite` is before the served
document changes where the view's files are prepared. The served document third: it builds on one app per element (a
file's view is built once, for one app) and on the value model, which is in. The code that steps around the inherited
policy is deleted only after the served document passes, so that each deletion is of code nothing reaches.

## Step 1 · `start(app, grants)`

| # | Work | Test it brings |
| :--- | :--- | :--- |
| 1.0 | **built**: every option of `CONFIG_SCHEMA` classified as the app's or the embedder's; `SandboxApp` and `SandboxGrants` derived | a key in the wrong argument throws (I17) |
| 1.1 | **built**: `start()` added, delegating to today's internals; `HostMethod`; `started` | every way it throws leaves the element as new (I2); a getter of the app that calls `start()` (I1) |
| 1.2 | **built**: the example app (`examples/sealed-app/`) moves to `start()` | `test/e2e/sealed-app.spec.ts` |
| 1.3 | **built**: the e2e driver (`SandboxDriver`, `test/e2e/fixture.ts`) and the specs move | the suite, unchanged in what it asserts |
| 1.4 | **built**: the playground and the devtools move | |
| 1.5 | **built**: the six members and their reducer inputs are removed from both builds; `execute()` from the default build (a method of the network modes, declared by `NetworkModeMethods`) | `APP_SURFACE` (I1, I3); the lifecycle model's suite at its nightly size |
| 1.6 | **built**: an element with no app stays `'idle'` | a unit test and the lifecycle model's rule |
| 1.7 | **built**: `commitGuestWrites(writes)` by identity of the current pending entry, all or none | a guest write, a commit, a `reset()` or a re-insertion after the list each leave the listed value uncommittable, and a list with one stale value commits nothing and answers `false` (I4) |
| 1.8 | **built**: the three events stop bubbling | `ELEMENT_EVENTS` (I5) |

A spec is never changed to fit: a spec that tested re-configuring one element either tests two elements, or is deleted
with the behaviour it tested, and the commit says which.

## Step 2 · The hand-offs

| # | Work | Measured or tested first |
| :--- | :--- | :--- |
| 2.1 | **built**: `Blob` and `File` refused in guest values, in both directions, by the one measure (`SNAPSHOT_REFUSED_KINDS`) | the snapshot measure's enumeration (I7; built: `test/unit/snapshot-kinds.test.ts`, `test/e2e/guest-blob-refused.spec.ts`) |
| 2.2 | **built**: a write's type from its path: `FILE_TYPES` is the one table of types and of what commits without `{ code: true }`; a guest write carries a path and bytes, and one that carries a type is refused `INVALID_FILE` | the type table's test (I8; built: `test/unit/file-types.test.ts`) |
| 2.3 | **built**: a write's `content` is a `GuestBytes` (`src/lib/guest-bytes.ts`): `image()` types a `Blob` by the bytes' signature (`GUEST_IMAGE_SIGNATURES`, one row per type of `GUEST_IMAGE_TYPES`), `save()` saves an `application/octet-stream` blob under the library's name, `bytes()` a copy, `text()` | a unit test with an SVG, an HTML file and a polyglot behind an image signature; an e2e spec on three engines: `save()` of `invoice.pdf.exe` and `report.html` saves files under the library's names (I9; built: `test/unit/guest-bytes.test.ts`, `test/e2e/guest-bytes.spec.ts`) |
| 2.4 | **built**: `unknown` for guest values: `call()` and `callWithTimeout()` answer `Promise<unknown>` with no type parameter | the API report (built: `test/unit/guest-values.test.ts`) |
| 2.5 | **built**: `GUEST_VALUES`, every value of both builds' API reports classified; docs/API.md's list of guest-chosen text generated from it | the registry's test against the API report (I10; built: `test/unit/guest-values.test.ts`) |
| 2.6 | **built**: `links`, with the click as the request: a grant of strict and sealed mode, read by start() (`LINK_RULES`, `MAX_LINKS`); the renderer marks an HTML `a` whose href is a listed URL, character for character, and keeps every href inert; the view sends the index on the user's trusted click (`VIEW_LINK`), and the host page opens its own copy (`src/lib/links.ts`) | an e2e spec with the popup blocker on (Chromium, Firefox): the tab opens for a click on a marked link, and for nothing else the guest can do; the egress table's row and its budget (I6; built: `test/e2e/links-popup-blocker.spec.ts`, `test/e2e/links.spec.ts`, `test/unit/links.test.ts`, `test/unit/view-links.test.ts`) |

A marked link's `href` stays the inert one in 2.6. **Measured** ([research 33](../research/33_link_href/README.md)): with
the listed URL as the `href`, Chromium connected to the listed host on a pointer press and Firefox resolved it on
render and fetched the page on a long press, before any click; with the inert `href` no engine reached anything.

## Step 3 · The served document

| # | Work | Measured or tested first |
| :--- | :--- | :--- |
| 3.1 | **built**: sealed mode's view bootstrap is one text in both builds, under its own name beside strict mode's (`sealedViewBootstrap()`); `sealed-document.html` generated from it at build time (`src/lib/sealed-document.ts`, its policy from `POLICY_DIRECTIVES`) and exported by the package | both builds emit the same bytes (I12); a source scan: one script, the guard, no listener (I13) (built: `test/unit/sealed-document.test.ts`, `scripts/smoke-package.sh`) |
| 3.2 | `defineWebSandbox({ documentUrl })`, resolved against the document's own URL; the element frames the file in its closed shadow root, with no referrer and the flags of the app's grants; the view's static attribute is the most the library grants; one load of the frame per build | the twelve ways of opening the shipped file, framed as the element frames it (I11, I14); a guest form's `submit` on three engines; a `<base>` in the host page changes nothing; a cross-site page that frames the host page finds no frame to navigate (I3, I13) |
| 3.3 | the check of the file, where its answer can be read | a missing file, another page, a modified file (a dev server's injected script, a minified copy), another version's, and each header: each its own reason |
| 3.4 | the start-up order: the view announces its version and verdicts; the host page sends a port and the app only to the window that announced itself from the first frame of the element's frame; the worker's verdicts before the entry runs; `'ready'` and the waiting calls after them | a file of another version receives no port; each window that is not the view (a frame of the host page, the file's own document, a second frame in the file, a framing page) announces itself and receives nothing, and the view is still accepted; a page that is not the file and says nothing receives no port; no call reaches a worker whose gate failed; a document that never announces itself ends with its reason |
| 3.5 | the start-up gates in the view and in the worker's prelude, without the frame canary | each under its mutant, three engines, in the static file (I15) |
| 3.6 | the policy check from `POLICY_DIRECTIVES` (per directive an admitted canary, a refused one in both schemes, or the reason for none), with the view's own canary worker and no clock of its own, and the `INHERITED_CONTEXT` row for the file's response headers with its column in `SEALED_REACH` | `POLICY_DIRECTIVES` against the `<meta>`'s text; each kind of load under a header on the file, enforced and report-only: a named termination, and no report that carries guest text (I18); a guest font, media, frame, object and form under each of the five directives the renderer's rules close: no report that carries guest text; a clean file is never refused, over many starts per engine on a loaded machine; no canary reaches the network; the realistic host and the directive matrix set their directives on the file's response |
| 3.7 | the passes leave the host page (into the worker's prelude where the code allows, the stylesheet cut into the view); the quota counts the bytes given | the cost of each pass on every engine, as the code it replaces is measured |
| 3.8 | README, `package.json` and the ADRs say "one static file, no response headers that set a policy on it", who is trusted with the file, the recipe per bundler (research 32), and which host pages cannot use it; an ADR for D8 | `docs:check` |
| 3.9 | research 29's harness against the library in the served document, framed with `allow-forms` | [04](04-forms-and-autofill.md) |

**Step 3 is released whole.** Between 3.2 and 3.6 the served document runs without the policy check: with the
mitigations in place, but with the report channel review 1's probe showed under a site-wide header. Nothing of step 3 is
published before 3.6 and 3.9 pass, and nothing is deleted before then.

## Step 4 · Delete what the served document made unreachable

**Sealed mode's host-realm code only**: sealed mode's policy from the kinds of file, its use of the `srcdoc` wrapper and
of the Trusted Types path, its calls of the host passes that moved. Strict, cooperative and worker mode keep the
`srcdoc` path, the policy generator and the passes they use ([03](03-served-document.md#the-network-build)). Everything
the view does about the policy in force stays, with its test: the refusal of `import()` and of code from strings, the
cut of CSS URLs, the styles applied through the CSSOM (which the file's own policy needs, having no `'unsafe-inline'`),
the view's Trusted Types probe. A row of `INHERITED_CONTEXT` whose channel now arrives through the file's headers keeps
its mitigation and moves its test there.

## Step 5 · Review

Review pass 8 of sealed mode in the default build, as the backlog's S74 plans it, and beside it: Safari on a Mac for
the served file, the popup blocker and autofill; a real browser profile; a reviewer outside this model family.

## Before anything is promised

| Promise | Needs first |
| :--- | :--- |
| `links` works at all | step 2.6's spec: research 30 measured a call from the worker in today's view, not the click as the request |
| `links` works in Safari | the popup blocker measured on a Mac (research 30's pages) |
| `documentUrl` can default to the bundle's own copy | not promised: research 32 found that most bundlers do not serve the file unchanged |
| A host page on `file:`, an extension's page or an app's own scheme can use sealed mode | with an `http(s)` copy of the file: measured ([research 34](../research/34_non_http_host/README.md)), and step 3.2's spec with the library. With the file beside the page: the owner's decision 3, and the rule's own test |
| A site-wide policy header ends the build on WebKit as on the others | step 3.6 on WebKit, in the view and in the worker |
| The served document on Safari and Android | the twelve ways of opening it, there |
| Autofill does not reach a guest in the served document | step 3.9 |
| The served file is the same for every embedder of a version | step 3.1's test |
| The policy check alone closes the report channel under a header on the file | not promised: no canary sees a `form-action` header on Chromium, or a header that names the canaries' host; the renderer's rules stay behind it ([03](03-served-document.md#what-the-policy-check-provokes)) |
| The policy check never ends a healthy sandbox | the library's check, with no time limit of its own, over many starts per engine on a loaded machine: research 31's probe refused none on Chromium and Firefox, and on WebKit only through a 600 ms limit of its own |
