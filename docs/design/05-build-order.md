# 05 · The order of the work

**Status: a plan, not started.** Each step ends with the repository's gates passing on both builds and three engines
(CONTRIBUTING.md), and each brings the structural test of its invariant ([the folder's index](README.md)).

## Why this order

`start()` first: it removes the six members and three inputs of the lifecycle model that every later step would
otherwise have to carry. The hand-offs second: they are small, and they change what `GuestWrite` is before the served
document changes where the view's files are prepared. The served document third: it builds on one app per element (a
file's view is built once, for one app) and on the value model, which is in. The code that steps around the inherited
policy is deleted only after the served document passes, so that each deletion is of code nothing reaches.

## Step 1 · `start(app)`

| # | Work | Test it brings |
| :--- | :--- | :--- |
| 1.1 | `start()` added, delegating to today's internals; `SandboxApp`, `HostMethod` | every way it throws leaves the element as new (I2) |
| 1.2 | the example app (`examples/sealed-app/`) moves to `start()` | `test/e2e/sealed-app.spec.ts` |
| 1.3 | the e2e driver (`SandboxDriver`, `test/e2e/fixture.ts`) and the specs move | the suite, unchanged in what it asserts |
| 1.4 | the playground and the devtools move | |
| 1.5 | the six members and their reducer inputs are removed from both builds; `execute()` from the default build | `APP_SURFACE` (I1, I3); the lifecycle model's suite at its nightly size |
| 1.6 | an element with no app stays `'idle'` | a unit test and the lifecycle model's rule |
| 1.7 | `commitGuestWrites(writes)` by identity | a guest write between the list and the commit leaves the path pending (I4) |
| 1.8 | the three events stop bubbling | `ELEMENT_EVENTS` (I5) |

A spec is never changed to fit: a spec that tested re-configuring one element either tests two elements, or is deleted
with the behaviour it tested, and the commit says which.

## Step 2 · The hand-offs

| # | Work | Measured or tested first |
| :--- | :--- | :--- |
| 2.1 | `Blob` and `File` refused in guest values | the snapshot measure's enumeration (I7) |
| 2.2 | a write's type from its path | the type table's test (I8) |
| 2.3 | `GuestBytes` and `GUEST_IMAGE_TYPES` | a unit test with an SVG, an HTML file and a polyglot behind an image signature (I9) |
| 2.4 | `unknown` for guest values | the API report |
| 2.5 | `GUEST_VALUES` | the registry's test against the API report (I10) |
| 2.6 | `links` | an e2e spec with the popup blocker on (Chromium, Firefox); the egress table's row and its budget (I6) |

Before 2.6 promises a marked link's `href` can be the listed URL: measure, on three engines, that a real `href` in the
view fetches nothing on hover, focus or pointer press (preconnect, prefetch, speculation). Until that is measured the
`href` stays the inert one.

## Step 3 · The served document

| # | Work | Measured or tested first |
| :--- | :--- | :--- |
| 3.1 | `sealed-document.html` generated at build time, one text per version; exported by the package | its bytes are a function of the version (I12); a source scan: one script, no listener (I13) |
| 3.2 | `defineWebSandbox({ documentUrl })`; the element frames the file | the twelve ways of opening it, against the shipped file (I11, I14) |
| 3.3 | the start-up gates, without the frame canary | each under its mutant, three engines (I15) |
| 3.4 | the five passes move into the view's document | the cost of each on every engine, as the code it replaces is measured |
| 3.5 | the new termination reasons: the file missing, another version's, a gate failed, the host page's `frame-src` refusing it | one spec each |
| 3.6 | README, `package.json` and the ADRs say "one static file, no server config"; an ADR for D8 | `docs:check` |
| 3.7 | research 29's harness against the library in the served document | [04](04-forms-and-autofill.md) |

## Step 4 · Delete what the served document made unreachable

The code that steps around the inherited policy in sealed mode (the per-build policy generator, the `srcdoc` path and
its Trusted Types handling, the styles applied through the CSSOM to pass a host `style-src`), row by row of
`INHERITED_CONTEXT`: a row whose channel the served document closes loses its mitigation and keeps its test.

## Step 5 · Review

Review pass 8 of sealed mode in the default build, as the backlog's S74 plans it, and beside it: Safari on a Mac for
the served file, the popup blocker and autofill; a real browser profile; a reviewer outside this model family.

## Before anything is promised

| Promise | Needs first |
| :--- | :--- |
| `links` works in Safari | the popup blocker measured on a Mac (research 30's pages) |
| The served document on Safari and Android | the twelve ways of opening it, there |
| Autofill does not reach a guest in the served document | step 3.7 |
| The served file is the same for every embedder of a version | step 3.1's test |
