# Research 25: the guest's styles under the host page's `style-src`

**Question.** The view of strict and sealed mode is a `srcdoc` document, so it inherits the host page's policy list
(`INHERITED_CONTEXT.cspPolicyText`, `cspReporting`; BD6:ISO-2). A guest's `style` attribute or `<style>` element is an
inline style: a host page whose `style-src` lists a hash or a nonce (the docs offer the wrapper style's hash) ignores
`'unsafe-inline'`, refuses every one of them, and the browser POSTs a report per refusal to the page's endpoint, with the
first 40 characters of the guest's CSS where the policy has `'report-sample'`. Which ways of styling a document does an
inherited `style-src` not check, on every engine, and can the view apply every guest style through them?

**Answer.** The CSSOM: an element's declaration (`cssText`, `setProperty`) and a constructed stylesheet (`new
CSSStyleSheet()`, `replaceSync`, adopted) raise no violation and no report under a `style-src` of hashes alone, with
`'report-sample'`, on Chromium, Firefox and WebKit, and apply (P1). But the old path's refusals do not happen at the same
step everywhere (P2): **Chromium checks a `style` attribute as it parses it**, into an inert template, a `DOMParser`
document, a document of `document.implementation` or `Document.parseHTMLUnsafe()` alike, so removing the attribute before
insertion is too late there; and a `<style>` element is checked once connected, empty or with a `type` that is not CSS
too (Chromium). So the construction (adopted, [ADR-005](../../ADR-005-strict-mode.md), "The renderer"):

- the view encodes the guest's markup before its parser sees it (`styleMarkup`, `src/lib/style-markup.ts`): every run of
  `style` the HTML tokenizer could read as an attribute name gets a marker in front (the attribute is then named
  `<nonce>astyle`), every `<style>` becomes a `noframes` with a marker attribute (parsed as raw text the same way, and
  ended by its renamed end tag), and every guest `noframes` an element of another name; the renderer reads every text and
  value back without the insertions. The parse of the encoded markup holds no attribute and no element named `style` in
  any namespace, whatever the markup (a property over the tokenizer's contexts, `test/unit/inline-styles.test.ts`), and is
  the parse of the markup otherwise, but in a table (a `noframes` is moved out before it) and where a guest `noframes` or a
  stray `<` inside a tag is involved;
- the renderer applies a style attribute's text as the element's CSSOM declaration, and keeps a `<style>` as that inert
  `noframes`, holding its text; the view applies the text as a constructed stylesheet it adopts, in the tree order of the
  `<style>`s, and keeps the sheets in step with `text()`, renders into a `<style>`, and renders that replace or remove one.

What follows from constructed stylesheets, and is documented ([API.md](../../API.md#sandboxview-strict-mode)): the guest's `<style>`s
cascade after every stylesheet `<link>` (a document's own sheets come before the ones it adopts), an `@import` in a
`<style>` loads nothing, and no `title` makes an alternative style sheet set. The library's own two styles stay inline
and keep their documented hashes: the wrapper's (its document runs no script) and the animation stylesheet, which must be
the first layer of the view, before every document stylesheet, a stylesheet `<link>` included, which no adopted sheet
can be; moving it would not make the host page's `style-src` requirement simpler (a `blob:` link would need `blob:` there
instead of a hash).

## P1, P2: the probe

`probe.spec.ts`, platform behaviour only. A host page served with a real `Content-Security-Policy` header holds a `srcdoc`
wrapper and, in it, a `sandbox="allow-scripts"` `srcdoc` view (an opaque origin) with the view's own `style-src
'unsafe-inline'`. The host's policy: `style-src 'self' 'unsafe-inline' 'sha256-…' 'report-sample'` and a `report-uri`
with a key in its URL; the second variant adds `style-src-elem` (hash) and `style-src-attr` (nothing). Each way of styling
runs as a step of its own, its CSS starting with a marker so a report's sample names it. Results:
`results/<engine>-<variant>.json` (both variants alike on every engine). Chromium 145, Firefox 146, WebKit 26 (Playwright
1.58), 2026-11-07.

| Step | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| `style` attribute parsed into an inert template | **refused at the parse**, reported | not checked | not checked |
| that template's content inserted | does not apply (refused before) | refused, reported | **applies, unchecked** |
| `setAttribute('style')` on a connected element | refused, reported | refused, reported | refused, no report |
| `<style>` parsed into a template | not checked | not checked | not checked |
| that `<style>` inserted (HTML or SVG), or its text replaced | refused, reported | refused, reported | refused, no report |
| an empty `<style>` inserted | refused, reported (no sample) | refused, reported | refused, no report |
| a `<style type="text/x-probe">` inserted (recorded only) | refused, reported | not checked | not checked |
| `DOMParser`, `document.implementation`, `Document.parseHTMLUnsafe()` with a `style` attribute (recorded only) | refused at the parse, reported | not checked | not checked |
| `cssText`, `setProperty` (HTML and SVG; on a connected element, and on one still in the template) | applies, no violation, no report | the same | the same |
| a constructed stylesheet: `replaceSync`, adopted; `media`; `replaceSync` again; `insertRule` | applies, no violation, no report | the same | the same |
| the encoded markup (a renamed attribute, a `noframes` with its markers) inserted, its text replaced | no violation, no report | the same | the same |

Reports: Chromium and Firefox POST every refusal of the view to the host page's endpoint, with the first 40 characters
of the style (`script-sample`); WebKit sends none from the sandboxed view, though it raises the violation there and
reports the host page's own (the control). The host page's own listener hears none of the view's violations on any
engine.

What the suite holds of it: `test/e2e/sealed-host-policy.spec.ts` renders every way the guest styles the view
(`STYLE_MAKERS`, `test/e2e/sealed-makers.ts`) on the realistic host with a `style-src` of the documented hashes,
`'report-sample'` and a keyed `report-uri`: no report, no violation, every style applies, on all three engines. Against
the inline renderer it replaced, it fails on all three: Chromium and Firefox apply none of the guest's styles, and WebKit
applies its `style` attributes (parsed into the template, unchecked) and none of its `<style>`s.

## The cost

`measure.spec.ts` times a render in the real view of a sealed sandbox at its default configuration, from the template the
view makes to the end of the style and layout work after the insertion (forced in a microtask after the flush, so the
sheets the view adopts are in it), 9 renders a markup, the median in ms. The inline renderer is `src/lib/in-sandbox-view.ts`
as it was before this research (in git, at the parent of the commit that added `src/lib/style-markup.ts`), measured by
the same file with that one file swapped in:

```bash
WEB_SANDBOX_MEASURE=1 bunx playwright test docs/research/25_cssom_styles/measure.spec.ts --project=chromium --workers=1
git show "$(git log --diff-filter=A --format=%h -- src/lib/style-markup.ts)~1:src/lib/in-sandbox-view.ts" > src/lib/in-sandbox-view.ts
WEB_SANDBOX_MEASURE=1 bunx playwright test docs/research/25_cssom_styles/measure.spec.ts --project=chromium --workers=1
git checkout -- src/lib/in-sandbox-view.ts
```

Chromium 145, Firefox 146, WebKit 26 (Playwright 1.58, headless), a shared 4-core VM, 2026-11-07; each figure the
medians of two runs (three for the CSSOM path on Firefox), inline → CSSOM:

| Markup (characters) | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| 1 500 `<p style="…">`, three declarations each (99 840) | 24.4–24.7 → 24.1–24.5 | 29 → 39–41 | 32–35 → 37 |
| 500 `<style>`s of two rules, each before a `<p>` (49 450) | 22.4–30.6 → 26.0–26.2 | 17–18 → 20–25 | 24–27 → 27–40 |
| 2 500 `<p class>` and no style (57 500) | 20.3–21.5 → 20.7–20.8 | 21 → 22–31 | 30–31 → 32–33 |
| the word `style` 4 500 times, in text and a `title` (60 000) | 13.0–13.4 → 16.5–17.0 | 16 → 19–22 | 20–21 → 24–27 |

So the CSSOM path costs about what the inline one did: the same on Chromium; on Firefox about 7 µs more a `style`
attribute (its `cssText` setter against its attribute parser) and about 10 µs more a `<style>`; on WebKit a few ms a
render. A run of `style` that is not markup but could be read as an attribute name (in text, in a value) gets a marker
and is read back without it, a few ms per 100 000 characters on every engine. All of it is the operation's own time,
charged to the view's budget like the rest of its flush ([API.md](../../API.md#a-the-long-run-bound)); none of it is
outside that statement.

An inline `all` is the exception, and is why the renderer removes it whole: through an element's declaration it is
every longhand set and serialized per element on Firefox and WebKit (R4:C-2's flood of `all: unset` elements took WebKit
past its bound), where a stylesheet's `all` is one declaration.
