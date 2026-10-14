# Broad review, 2026-10-14 — strict mode (reviewer C)

*Section of the [broad review report](BROAD-REVIEW-2026-10-14.md), to be merged into it.* **Code reviewed**: `main` at
`12d7924` · **Result**: 5 findings (ST1–ST4, I1), all fixed; the renderer converted to an allowlist; one residual
found while measuring, filed (S44) · **Backlog**: [S40–S44](../BACKLOG.md#s40--the-strict-renderer-was-a-list-of-what-to-remove---done)
· **Decision record**: [ADR-005 amendment](../ADR-005-strict-mode.md#amendment-2026-10-14-broad-review-an-allowlist-renderer-and-a-bounded-view)

## Method and engines

As in the earlier reports: every finding first a **failing test** — a unit test where library logic decides, an
end-to-end test on Chromium, Firefox and WebKit where browser behaviour decides — run against `12d7924`, then fixed
at the chokepoint that closes the class, then green. End-to-end evidence is read from outside the sandbox: the view's
DOM through `test/e2e/strict-view.ts` (DevTools in Chromium), new pages opened by the browser (a user's "open in new
tab", emulated as a browser-initiated navigation), host-page lag from a 10 ms interval on the host page, host-side
records of bridge calls, and the recorder's listeners; a positive control beside each negative. Engines: the
Playwright 1.58.1 builds of the earlier reports (Linux; Playwright's WebKit is not Safari). The new spec is
`test/e2e/broad-strict.spec.ts` (10 tests per engine).

## Summary

| Id | Area | Severity | Status | Test (file: name) |
| :--- | :--- | :--- | :--- | :--- |
| — | renderer | (design) | **allowlist** | `broad-strict.spec.ts`: "the renderer is an allowlist" (2 tests); `src/lib/in-sandbox-view.test.ts`: "broad review 2026-10-14: the renderer is an allowlist" (5, one a 300-corpus property) |
| ST1 | strict view, files | medium | **fixed** | `broad-strict.spec.ts`: "ST1" (2 tests); `src/lib/load-kinds.test.ts`; `test/unit/strict.test.ts`: "broad review ST1" (2) |
| ST2 | strict view, liveness | medium | **fixed**; residual S44 filed | `broad-strict.spec.ts`: "ST2" (4 tests); `src/lib/in-sandbox-view.test.ts`: "broad review ST2", "budgets" |
| ST3 | strict events | low | **fixed** | `broad-strict.spec.ts`: "ST3"; `src/lib/in-sandbox-view.test.ts`: "an event detail shares one character budget" |
| ST4 | strict entry | info | **fixed** | `broad-strict.spec.ts`: "ST4"; `test/unit/strict.test.ts`: "broad review ST4" |
| I1 | renderer, files | info | **fixed** | `src/lib/load-kinds.test.ts`: "a <link>'s kinds in the renderer are load-kinds.ts's linkKinds()" |

Against `12d7924`, `broad-strict.spec.ts` failed 9 of its 10 tests on every engine (27 failures); the one that passed
is the allowlist's positive control (an everyday UI renders), which must keep passing. Each row's engines are below.

## The renderer is now an allowlist

- **Guarantee**: what reaches the view's document is what the renderer listed, whatever mechanism a document has.
- **Found**: the renderer removed 19 named elements and let every other element and almost every attribute through;
  handler attributes were stopped only by the policy. F1 (SMIL re-animating checked attributes) and ST2 (SVG `<use>`)
  both came from what the list left open.
- **Root cause**: a denylist has to know every mechanism of three markup languages and their future versions.
- **Fix**, by construction: `RENDER_ELEMENTS` per namespace and `RENDER_ATTRIBUTES` (global, per HTML element, SVG,
  MathML, plus `data-*`/`aria-*`); one walk decides each element once. Unknown HTML elements are **unwrapped** (their
  children are checked in turn; obsolete wrappers keep their text; nothing is serialised or reparsed, so unwrapping
  cannot change what a child is); elements holding raw text, templates or browsing contexts, and **every SVG or MathML
  element off the list, are removed with their content**. Hyphenated custom element names stay as inert elements.
  URL attributes (`src`, `srcset`, `poster`, the minted `link` `href`) keep only `https:`, `http:`, a view-minted URL or
  a relative one; links keep `INERT_HREF`; SVG paint and clip references only `url(#id)`. Move-not-clone and the
  captured primitives (DOM clobbering) hold: the walk uses only prototype getters and methods captured at its start.
- **Beyond the review's proposal, by measurement** (10^5 references from 1–1.5 KB, host lag per engine):
  `marker` instances its content per vertex and nests like `use` — 16.6 / 5.7 / 2.9 s (Chromium / Firefox /
  WebKit) — so it is out; SVG filter primitives cost what their parameters say (one 150-character `feMorphology`:
  6.4 s in WebKit; 1 000 rectangles × 100 blurs, 50 KB: 36 s in WebKit), so `filter` and every `fe*` are out; SVG
  `image` is out (HTML `img` covers it). Masks, clip paths and patterns nested the same way measured ≤ 0.35 s and stay,
  without `href` templates.
- **What guests lose** (listed in API.md): `use`, markers, SVG filters, SVG `image`, `foreignObject`, SVG animation;
  `canvas`, `slot`, `selectedcontent` (customizable select); `popover`/`popovertarget` and `commandfor`/`command`;
  `autofocus`, `contenteditable`; form `action`, `formaction`, `method`, `target`; `target`/`download` on links;
  gradient and pattern `href` templates; `data:` images; SVG, HTML, XML and JSON files in the view.
- **Cost, measured**: the existing strict corpus specs (`strict`, `review-strict`, `focused-review`, `strict-events`,
  `strict-render-flood`, `violations`, `host-url`, `review-policy`, `webrtc`, `watchdog`, `package`): 270 of 288 passed
  unchanged; the 18 failures (6 tests × 3 engines) were each a test relying on what is now gone, and each now probes
  the same guarantee another way: G1's corpus no longer gets a `script-src-attr` report (no handler reaches the
  view; asserted absent instead), A1 sets the handler from outside to test the policy alone, C4's second directive
  is a refused audio load, F1's positive control is an HTML image, the files specs use PNG (a JSON file is no longer
  given to the view). An everyday UI (forms, tables, lists, details, dialog, media, inline SVG icon with gradient,
  MathML, a custom element, a `<style>`) renders identically: the positive control passed before and after on all
  three engines. There are no strict presets in the playground at `12d7924` to measure.
- **Evidence**: before, the corpus test failed on all three engines (`use`, `marker`, `filter`, `image`,
  `foreignObject` present; handlers, `formaction`, `popovertarget`, `commandfor`, `data:` and `javascript:` sources
  kept); after, exactly the listed elements and attributes are left. Unit: a property over 300 random corpora of
  every element and attribute in three namespaces.

## ST1 · A file the view showed opened as a script-running document

- **Guarantee**: no guest script runs outside the worker (G1); the user's own browser actions carry nothing of the
  guest's that runs (C5's principle).
- **Found** (reviewer): a registered SVG rendered as `<img>` got a view-minted `blob:` URL; "open image in new tab"
  ran its script top-level outside the policy; a `data:image/svg+xml` image with `img-src data:` likewise.
- **Root cause**: the view minted a URL for every non-JavaScript file, and the image kind admitted every `image/*`
  type (and the media and font kinds every `audio/`, `video/`, `font/` type, which include `+xml` types an engine
  renders as XML).
- **Fix**: the view mints URLs only for `VIEW_FILE_TYPES` (CSS, raster images, fonts, audio, video, WebVTT), through
  its own kind table derived from load-kinds.ts without prefixes (`VIEW_LOAD_KINDS`); other files are the worker's
  only, and the policy gives them `blob:` only in `connect-src`. `data:` is dropped from the directive that governs
  images with one warning (no documented use needed it); the renderer keeps no `data:` source. Residual: an image
  from an origin the embedder allowed opens as that origin's document.
- **Evidence**: every `blob:` URL the view held (attributes and stylesheet text, read from outside) opened in a new
  page. Before: Chromium and Firefox ran the SVG's script (the page marked itself); WebKit refused the navigation but
  the SVG had a URL; the `data:` test failed on all three (the policy kept `data:`). After: no minted URL runs
  anything on any engine (the SVG, `video/…+xml` and `image/…+xml` files get none), the blocked listener stays
  silent, and the PNG renders and an allowed remote image loads (positive controls).

## ST2 · One render stalled the host by fan-out; the view's document was unbounded

- **Guarantee**: one apply costs the host what its markup weighs, not more; the document is bounded.
- **Found**: ~1 KB of nested `<use>` (10^5 instances) froze the host page; host stalls are not counted, so the
  sandbox was never terminated. Measured before: **6.1 / 11.9 / 7.0 s** (Chromium / Firefox / WebKit) for `use`,
  **16.6 / 5.7 / 2.9 s** for markers. And nothing bounded the elements renders accumulate across targets, nor depth.
- **Root cause**: instancing elements make rendered work exponential in markup size; budgets were per render.
- **Fix**: no instancing element (allowlist); `VIEW_MAX_ELEMENTS` (50 000) and `VIEW_MAX_DEPTH` (256) counted over
  the document a render would leave (the target's elements are replaced, its depth counts); a render past either is
  refused before insertion, still acknowledged, and the worker logs why. Chromium, too, ran the view in the host
  page's process in these runs (no iframe target; both frames local) and stalled the host: ADR-005's residual is
  corrected ("Chromium out of process" was not what we measured).
- **Corrected bound** (ADR-005): the DOM an apply builds is linear in its markup and the document is bounded.
  **Not bounded: paint cost set by CSS**, which the renderer does not read — 10 `blur()` on 1 000 elements (88 KB)
  stalled WebKit's host 3.7 s after the fix (Chromium 53 ms, Firefox 36 ms); 100 on 1 000, over 180 s. Filed as S44
  with options (a CSS allowlist through the browser's own parser is the by-construction one).
- **Evidence**: after, the fan-outs stall the host **4 / 41 / 9 ms** (`use`) and **12 / 28 / 3 ms** (markers), under a
  500 ms bound (the render weighs 1.5 KB; 500 ms is far above its cost and far below the stalls before); no `use` or
  `marker` is left. A 45 000-element render applies (positive control; host lag 205 / 205 / 280 ms); 10 001 more into
  another target are refused, that target stays empty and the next render applies; replacing the first target frees
  room. Depth: 256 applies, 257 and 300 are refused. Before: all three budget tests failed on every engine.

## ST3 · An event detail was bounded per string, not in total

- **Found / root cause**: each string ≤ 64 Ki, `ids` ≤ 32, fields ≤ 1000, nothing in total.
- **Fix**: one budget per detail, `VIEW_EVENT_LIMITS.maxTotal` = `VIEW_RENDER_MAX_LENGTH` (256 Ki characters) across
  every string (the tag is now clamped too); `truncated: true` when any limit cut something (schema change, API.md).
- **Evidence**: 30 fields of 60 000 characters, submitted by a trusted click: before, **1 800 090** characters on
  all three engines; after, ≤ 262 144 and `truncated: true`; a small form's detail is whole, without the flag.

## ST4 · An escaped entry could shadow the entry marker

- **Found / root cause**: C2's check catches escaped functions only; `}).call(this); let __sandboxEntryRan = …`
  declared a lexical binding the trailer's call resolved to (before: the guest's function ran instead of the marker,
  all three engines).
- **Fix**: the marker's name is drawn per build (`__sandboxEntryRan_` + 128 random bits); the entry's text is fixed
  before it. C2's wording corrected in ADR-005 and the [main report](ADVERSARIAL-REVIEW-2026-10.md#c2--declarations-in-the-strict-entry-pre-empted-the-prelude).
- **Evidence**: after, only the real marker runs; a later error is logged and the sandbox stays ready.

## I1 · The renderer had its own copy of the link kinds

Now `linkRelKinds` is load-kinds.ts's `LINK_REL_KINDS` restricted to the two relations a kept link may have, and a
unit test holds the renderer equal to `linkKinds(rel, as)` for every `rel`/`as` combination.

## Areas reviewed and found sound (reviewer C)

Each is asserted by an existing test, run green before and after:

- **G5**: no request from the worker or rendered markup carries a `Referer` or the host origin, across the whole
  corpus, cross-site and same-site, even when markup asks for `unsafe-url` (`host-url.spec.ts`, section 4).
- **Content the renderer never walks**: template contents and declarative shadow roots never become live
  (`template` is removed; `innerHTML` attaches no shadow root: `strict.spec.ts`, G1, `shadowRoots: 0`).
- **G1/G4 corpus with trusted clicks and Enter**: nothing runs and nothing navigates (`strict.spec.ts`, G1 and G4;
  `strict-events.spec.ts`; `review-strict.spec.ts`, C5).
- **`selectedcontent`**: its cloning was harmless (nothing scripted survives to be cloned); it is now unwrapped by
  the allowlist anyway.
- **Guest writes mint no URL**, in any mode; the view never sees the overlay (`test/unit/strict.test.ts`).
- **DOM clobbering**: named elements and form controls change nothing the view does (`strict.spec.ts`).
- **`into` lookup**: a target outside the body or missing is ignored (`strict.spec.ts`).
- **Flow-control acknowledgements**: one ack per flush, refused renders acknowledged (`strict-render-flood.spec.ts`;
  now also the budget tests).
- **Move, never clone** (A2): `src/lib/in-sandbox-view.test.ts` (now also for unwrapping).
- **Render port reach**: patched prototypes yield no port that reaches the view (`strict.spec.ts`, G2).
- **The view policy is an allowlist** of passed-through directives (`test/unit/strict.test.ts`).
- **Violation buckets are bounded**: known directive names plus one (`review-strict.spec.ts`, C4;
  `test/unit/followup-guarantees.test.ts`).

## Results

Commands: `bun run typecheck`; `bunx vitest run`; `bun run build`; the full Playwright suite on Chromium, Firefox
and WebKit (a local config on port 4545, two workers); the strict specs with `--repeat-each 3`.

| | Result |
| :--- | :--- |
| Unit (`bunx vitest run`) | 1483 passed in 34 files (1470 at `12d7924`) |
| `typecheck`, `build` | pass |
| Full e2e, three engines | 1284 passed, 27 skipped, 0 failed (1311 tests: 437 per engine, 10 of them new) |
| `broad-strict.spec.ts` before the fix | 9 of 10 failed per engine (27); the positive control passed |
| Strict specs × 3 (`broad-strict`, `strict`, `review-strict`, `focused-review`, `strict-events`, `strict-render-flood`, `review-policy`; 675 runs) | 673 passed, 2 failed, root-caused below; after the fix the affected specs × 3 on Chromium: 36 passed |

The skipped tests are per-engine measurements that do not apply to that engine, as before.

One failure on the way, root-caused: `strict-render-flood.spec.ts` (markup flood) failed twice of three on Chromium
under `--repeat-each` with host lag 296 and 364 ms against a 250 ms bound. The bound assumed Chromium runs the view
out of process; here it does not (no iframe target; the wrapper and the view are local frames), so an apply is
host-thread work as in Firefox, and a second worker loading the machine pushes it past 250 ms. Not a regression:
alone, side by side, four runs each, the markup flood lagged 76–115 ms at `12d7924` and 73–131 ms after the allowlist
renderer. The Chromium bound in that spec and in `watchdog.spec.ts`'s render-then-loop test is now Firefox's
(600 ms), with the measurement in the comment.
