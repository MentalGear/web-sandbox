# Research 21: forcing `crossorigin="anonymous"` on the strict view's loads

**Question.** The strict view's renderer keeps `img`, `picture`, `video`, `audio`, `source`, `track` and `link` elements
with `http(s)` URLs from the policy's lists (`origins.images`, `media`, `styles`), and guest CSS that names the same
origins. In Firefox and WebKit the engine attaches the listed cross-site origin's `SameSite=None` cookie to every one of
those loads (WebKit also the host site's Lax, Strict and host-only cookies to a same-site target); Chromium sends none
only because the wrapper frame is `credentialless` (`cookie-facts.ts`, `INHERITED_CONTEXT.cookies`). If the
renderer set `crossorigin="anonymous"` on every element that loads a URL, would each engine omit the cookies on those
loads, and what breaks? Defensive research: measurements only, `src/` is unchanged.

**Answer in brief.**

- **Elements: yes, on all three engines, with one exception.** With the attribute, `img src`, `img srcset`,
  `picture>source srcset`, `video src`, `audio src`, `source src`, `track src` and `link rel=stylesheet` carry **no
  cookie** on Chromium 145, Firefox 146 and WebKit 26: not the listed origin's `None` cookie, and (WebKit) not the
  same-site `Lax`, `Strict` or host-only ones either. They are CORS requests (`Sec-Fetch-Mode: cors`, `Origin: null`),
  with no preflight. **Firefox ignores the attribute on `<video poster>`**: the poster is still a `no-cors` request with
  the cookie.
- **CSS: no.** Nothing in CSS takes the attribute. `url()` in a `style` attribute or `<style>`, `@import`,
  `image-set()`, `list-style-image`, `content`, `border-image` stay `no-cors` with cookies on every engine; `@font-face`
  too on WebKit. A `<link crossorigin=anonymous>` stylesheet is itself fetched without a cookie, but its own `url()`,
  `@import` and `image-set()` are not. CSS's own `url("…" crossorigin(anonymous))` modifier is supported by none of the
  three. Strict mode has to drop network `url()` from guest CSS.
- **A server that does not send `Access-Control-Allow-Origin` breaks the load, silently.** The request is still sent
  (without the cookie), the response is discarded; the image or media fires `error` (no event for a poster). The view
  reports no violation for it.
- **Setting the attribute is safe only before the element enters the live document.** In a live document, `src` first
  and the attribute after starts a `no-cors` load with the cookie first. The renderer builds elements in an inert
  `<template>`, so the real view, measured with the attribute set in `clean()`, sends none on any engine.
- **Recommendation** is at the end: set it (overwriting) on `img`, `video`, `audio` and `link`; drop network `poster`
  and network CSS references; keep the attribute and element allowlists, which are the only thing keeping four other
  loads out.

**Current state.** The renderer does what the recommendation says, with no exception: every `img`, `video`, `audio` and
`link` it keeps gets the attribute, and no network URL stays in CSS or a poster (`RENDER_CROSSORIGIN_ELEMENTS`,
`RENDER_NETWORK_DROPPED`, `src/lib/in-sandbox-view.ts`; docs/API.md#the-views-loads). The per-origin opt-out
`origins.withoutCors` is removed (S74): its loads were the engine's `no-cors` ones, with the cookies these measurements
show, so strict mode now has no cookie carrier at all (`STRICT_COOKIE_CARRIERS`, `src/lib/cookie-facts.ts`; its worker
opens no WebSocket either). The measurements below are kept as they were taken.

## Setup

- **Engines.** Playwright 1.58.1: Chromium 145.0.7632.6, Firefox 146.0.1, WebKit 26.0 (the Linux build), headless, one
  engine at a time, load average under 6, 2026-10-24. Cookies are in the context's jar. Firefox runs with Playwright's
  default cookie behaviour. The numbers are this machine's; the claims rest on what a request carries.
- **Names.** One HTTPS listener (`server.ts`) answers for three names that all resolve to `127.0.0.1`, from one line in
  `/etc/hosts` (`127.0.0.1 app.wsprobe.test cdn.wsprobe.test cross.wsprobe2.test`; the specs skip without it):
  **H** `app.wsprobe.test` is the host page's origin, **S** `cdn.wsprobe.test` a sibling subdomain (the host page's own
  site), **X** `cross.wsprobe2.test` another site: what an embedder lists in `origins`.
- **Jar.** Domain cookies of the host's site (`.wsprobe.test`: `d_none`, `d_lax`, `d_strict`; they go to H and S),
  host-only cookies of H, S and X (`h_*`, `s_*`, `x_*`, SameSite None and Lax), domain cookies of X's site (`xd_*`),
  all `Secure`. A cell below counts the **distinct cookies** the listener saw on the request. "2" for X is its two
  `None` cookies (`x_none`, `xd_none`): a cross-site subresource cannot carry its Lax or Strict ones. "5" for a
  same-site target on WebKit is `None`, `Lax`, `Strict`, domain and host-only.
- **Documents.** Each case runs in a sandboxed `srcdoc` frame without `allow-same-origin` (an opaque origin, like the
  view) under a policy that lists the three origins for `img-src`, `media-src`, `font-src` and `style-src`. Two
  structures: `plain`, a child of the host page (the engine's own behaviour, Chromium without `credentialless`), and
  `strict`, as the library builds it: a `credentialless` wrapper frame, the view frame inside it. Chromium honours
  `credentialless`; Firefox and WebKit ignore it, so their `plain` and `strict` rows agree.
- **Answers.** `/cors/…` answers `Access-Control-Allow-Origin: *`, `/nocors/…` none, `/creds/…` `null` with
  `Allow-Credentials`. Media supports `Range` (206). Every case has a unique id that is the `k` of its URL, so the
  listener says which request belonged to which element: cookie names, `Origin`, `Sec-Fetch-Mode`, `Range`, status.
- **Probes.** `probe.spec.ts` is the matrix (478 cases per engine per structure: every element with and without the
  attribute, against H, S and X, with and without ACAO; CSS; the defeat cases; media), plus the blob: and the CSS
  modifier probes. `view.spec.ts` runs **the real strict view**, with the one change the research is about: the view's
  source is rewritten in flight (as research 16 does) so that `clean()` sets `crossorigin="anonymous"` on every `img`,
  `video`, `audio` and `link` it keeps, after its attribute loop. `baseline` is the renderer as it is. Results:
  `results/<engine>-<probe>.json`; `summarize.ts` prints the tables below from them.

## 1. With `crossorigin="anonymous"` set: cookies, mode, failure

**Cookies.** Target X (another site, ACAO `*`), `plain` frame: the distinct cookies on the request, without the
attribute → with it. "no request": the engine did not fetch (a `<track>`, below; a `<link rel=icon>`, which no engine
fetches in a subframe).

Target X, ACAO `*`, plain frame (cookies on the request: number of distinct cookies; the control without the attribute → with it)

| Element | chromium: no attribute → crossorigin=anonymous | firefox: no attribute → crossorigin=anonymous | webkit: no attribute → crossorigin=anonymous |
| :--- | :--- | :--- | :--- |
| `<img src>` | 2 → none | 2 → none | 2 → none |
| `<img srcset>` | 2 → none | 2 → none | 2 → none |
| `<picture><source srcset>` | 2 → none | 2 → none | 2 → none |
| `<video src>` | 2 → none | 2 → none | 2 → none |
| `<video poster>` | 2 → none | 2 → 2 | 2 → none |
| `<audio src>` | 2 → none | 2 → none | 2 → none |
| `<video><source src>` | 2 → none | 2 → none | 2 → none |
| `<audio><source src>` | 2 → none | 2 → none | 2 → none |
| `<track default src>` | no request → none | no request → none | no request → no request |
| `<track>` added by script, mode showing | no request → none | no request → none | 2 → none |
| `<link rel=stylesheet>` | 2 → none | 2 → none | 2 → none |
| `<link rel=icon>` | no request → no request | no request → no request | no request → no request |

The same, for each target and structure (every element but the poster and the `<link>`s; the poster is the Firefox row
above):

| Target | Frame | chromium: no attribute → anonymous | firefox: no attribute → anonymous | webkit: no attribute → anonymous |
| :--- | :--- | :--- | :--- | :--- |
| X, another site (a listed origin) | plain | 2 (x_none, xd_none) → none | 2 (x_none, xd_none) → none | 2 (x_none, xd_none) → none |
| X, another site (a listed origin) | strict | none → none | 2 (x_none, xd_none) → none | 2 (x_none, xd_none) → none |
| S, sibling subdomain (the host page's site) | plain | 2 (d_none, s_none) → none | 2 (d_none, s_none) → none | 5 (d_lax, d_none, d_strict, s_lax, s_none) → none |
| S, sibling subdomain (the host page's site) | strict | none → none | 2 (d_none, s_none) → none | 5 (d_lax, d_none, d_strict, s_lax, s_none) → none |
| H, the host page's own origin | plain | 2 (d_none, h_none) → none | 2 (d_none, h_none) → none | 5 (d_lax, d_none, d_strict, h_lax, h_none) → none |
| H, the host page's own origin | strict | none → none | 2 (d_none, h_none) → none | 5 (d_lax, d_none, d_strict, h_lax, h_none) → none |

On Chromium the `strict` rows are "none → none" because the wrapper is `credentialless`: the attribute adds nothing
there. On Firefox and WebKit the structure does not matter, and the attribute removes every cookie, including the
same-site `Lax`, `Strict` and host-only ones WebKit sends today (S and H rows).

**Is it a CORS request?** Yes. Mode and `Origin` header of the request with the attribute (X, ACAO `*`):

| Element | chromium: mode / Origin header (anonymous) | firefox: mode / Origin header (anonymous) | webkit: mode / Origin header (anonymous) |
| :--- | :--- | :--- | :--- |
| `<img src>` | cors / null | cors / null | cors / null |
| `<img srcset>` | cors / null | cors / null | cors / null |
| `<picture><source srcset>` | cors / null | cors / null | cors / null |
| `<video src>` | cors / null | cors / null | cors / null |
| `<video poster>` | cors / null | no-cors / - | cors / null |
| `<audio src>` | cors / null | cors / null | cors / null |
| `<video><source src>` | cors / null | cors / null | cors / null |
| `<audio><source src>` | cors / null | cors / null | cors / null |
| `<track default src>` | cors / null | cors / null | no request (as without) |
| `<track>` added by script, mode showing | cors / null | cors / null | cors / null |
| `<link rel=stylesheet>` | cors / null | cors / null | cors / null |
| `<link rel=icon>` | no request (as without) | no request (as without) | no request (as without) |

`Origin` is `null` because the view's origin is opaque, so a server that answers `Access-Control-Allow-Origin: *` is enough (so is `null`: an answer of `null` with
`Allow-Credentials` loaded on all three). No engine sent a preflight: the number of non-`GET` requests over every case of the run is 0 on all
three engines (end of §2).

**When the server answers without ACAO, and with `*`.** What the page sees:

With the attribute:

| Element | chromium: ACAO * / no ACAO (crossorigin=anonymous) | firefox: ACAO * / no ACAO (crossorigin=anonymous) | webkit: ACAO * / no ACAO (crossorigin=anonymous) |
| :--- | :--- | :--- | :--- |
| `<img src>` | shown / error event | shown / error event | shown / error event |
| `<img srcset>` | shown / error event | shown / error event | shown / error event |
| `<picture><source srcset>` | shown / error event | shown / error event | shown / error event |
| `<video src>` | plays / error event | plays / error event | plays / error event |
| `<video poster>` | shown / nothing | shown / shown | shown / nothing |
| `<audio src>` | plays / error event | plays / error event | plays / error event |
| `<video><source src>` | plays / error event | plays / error event | plays / error event |
| `<audio><source src>` | plays / error event | plays / error event | plays / error event |
| `<track default src>` | load event / error event | load event / error event | no event / no event |
| `<track>` added by script, mode showing | load event / error event | load event / error event | load event / error event |
| `<link rel=stylesheet>` | applied / error event | applied / error event | applied / error event |

Without it (the control; the answer's ACAO does not matter to a no-cors load):

| Element | chromium: ACAO * / no ACAO (no attribute) | firefox: ACAO * / no ACAO (no attribute) | webkit: ACAO * / no ACAO (no attribute) |
| :--- | :--- | :--- | :--- |
| `<img src>` | shown / shown | shown / shown | shown / shown |
| `<img srcset>` | shown / shown | shown / shown | shown / shown |
| `<picture><source srcset>` | shown / shown | shown / shown | shown / shown |
| `<video src>` | plays / plays | plays / plays | plays / plays |
| `<video poster>` | shown / shown | shown / shown | shown / shown |
| `<audio src>` | plays / plays | plays / plays | plays / plays |
| `<video><source src>` | plays / plays | plays / plays | plays / plays |
| `<audio><source src>` | plays / plays | plays / plays | plays / plays |
| `<track default src>` | error event / error event | error event / error event | no event / no event |
| `<track>` added by script, mode showing | error event / error event | error event / error event | load event / load event |
| `<link rel=stylesheet>` | applied / applied | applied / applied | applied / applied |

A load without ACAO is not "shown as nothing": the image has `naturalWidth` 0 and fires `error`, media fires `error`
(`MediaError` code 4 on the element), a stylesheet fires `error` and does not apply. A poster fails silently (no
event). The listener saw the request in every case: it left, without the cookie, and the response was thrown away. In the
real view (§4) the same loads raise **no violation** and no event reaches the host, so a guest or an embedder cannot
tell a missing ACAO from a missing file.

**The view's own files.** The view mints `blob:` URLs for registered files and raster writes, in its own document.
A `blob:` URL fetched in CORS mode is same-origin only, so this needed checking; it works on all three, in both
structures (`img`, `srcset`, `audio`, `poster`, `link` stylesheet; the real view's `pic.png`, `tone.wav` and `own.css`
in §4 agree):

| Load of a blob: URL minted in the view's own document | chromium | firefox | webkit |
| :--- | :--- | :--- | :--- |
| `<img src=blob:>`, no attribute | load nw=3 | load nw=3 | load nw=3 |
| `<img crossorigin=anonymous src=blob:>` | load nw=3 | load nw=3 | load nw=3 |
| `<img crossorigin=anonymous srcset=blob:>` | load nw=3 | load nw=3 | load nw=3 |
| `<audio src=blob:>`, no attribute | loadedmetadata | loadedmetadata | loadedmetadata |
| `<audio crossorigin=anonymous src=blob:>` | loadedmetadata | loadedmetadata | loadedmetadata |
| `<video crossorigin=anonymous poster=blob:>` | load | load | load |
| `<link rel=stylesheet href=blob:>`, no attribute | load applied=true | load applied=true | load applied=true |
| `<link rel=stylesheet crossorigin=anonymous href=blob:>` | load applied=true | load applied=true | load applied=true |

## 2. Poster, track and range

**Poster.** `<video poster crossorigin=anonymous>`, the answer with and without ACAO:

|  | chromium | firefox | webkit |
| :--- | :--- | :--- | :--- |
| request mode / Origin (ACAO *) | cors / null | no-cors / - | cors / null |
| cookies on it | none | 2 | none |
| no ACAO: poster shown? | nothing | shown | nothing |
| honours the video's crossorigin? | yes | **no** | yes |

**Track.** A `<track>` is fetched in CORS mode whatever the element says; does the video need `crossorigin`?

| Case | chromium | firefox | webkit |
| :--- | :--- | :--- | :--- |
| `default` track, no attribute, ACAO * | error event (no request) | error event (no request) | no event (no request) |
| `default` track, anonymous, ACAO * | load event (cors, cookies none) | load event (cors, cookies none) | no event (no request) |
| `default` track, anonymous, no ACAO | error event (cors, cookies none) | error event (cors, cookies none) | no event (no request) |
| script-added track (showing), no attribute, ACAO * | error event (no request) | error event (no request) | load event (no-cors, cookies 2) |
| script-added track (showing), anonymous, ACAO * | load event (cors, cookies none) | load event (cors, cookies none) | load event (cors, cookies none) |
| script-added track (showing), anonymous, no ACAO | error event (cors, cookies none) | error event (cors, cookies none) | error event (cors, cookies none) |

**Range and seeking.** A 12 s, ~7 MB WebM (`preload=metadata`), seek to 75 % of the duration, then play; the server answers `206` to `Range` unless it says `norange`. ACAO `*`, target X:

| Case | chromium | firefox | webkit |
| :--- | :--- | :--- | :--- |
| no attribute (control) | seeked=true, played=true; 4 requests (4 ranged, 4×206); no-cors; cookies 2 | seeked=true, played=true; 3 requests (3 ranged, 3×206); no-cors; cookies 2 | seeked=true, played=true; 3 requests (2 ranged, 2×206); no-cors; cookies 2 |
| anonymous | seeked=true, played=true; 4 requests (4 ranged, 4×206); cors; cookies 0 | seeked=true, played=true; 4 requests (4 ranged, 4×206); cors; cookies 0 | seeked=true, played=true; 3 requests (2 ranged, 2×206); cors; cookies 0 |
| no attribute, play from the start (no seek) | moved=true (readyState 4, paused false, at 0.58 s) | moved=true (readyState 4, paused false, at 0.57 s) | moved=true (readyState 4, paused false, at 0.54 s) |
| anonymous, play from the start (no seek) | moved=true (readyState 4, paused false, at 0.57 s) | moved=true (readyState 4, paused false, at 0.58 s) | moved=true (readyState 4, paused false, at 0.57 s) |
| anonymous, server ignores `Range` | seeked=true, played=true; 1 requests (1 ranged, 0×206); cors; cookies 0 | seeked=true, played=true; 1 requests (1 ranged, 0×206); cors; cookies 0 | seeked=false, played=false; 2 requests (1 ranged, 0×206); cors; cookies 0 |
| no attribute, server ignores `Range` | seeked=true, played=true; 1 requests (1 ranged, 0×206); no-cors; cookies 2 | seeked=true, played=true; 1 requests (1 ranged, 0×206); no-cors; cookies 2 | seeked=false, played=false; 2 requests (1 ranged, 0×206); no-cors; cookies 2 |
| anonymous, no ACAO | error code 4; 1 requests (1 ranged, 1×206); cors; cookies 0 | error code 4; 1 requests (1 ranged, 1×206); cors; cookies 0 | error code 4; 1 requests (0 ranged, 0×206); cors; cookies 0 |
| anonymous, same-site target S, ACAO `*` | seeked=true; 4 requests; cookies 0 | seeked=true; 4 requests; cookies 0 | seeked=true; 3 requests; cookies 0 |

Requests that were not GET (a CORS preflight, for example), over every case of the run: chromium 0, firefox 0, webkit 0.

- **`poster` honours the video's `crossorigin` on Chromium and WebKit, not on Firefox.** On Firefox the poster is a
  `no-cors` request with the cookie, shown even when the server sends no ACAO. The attribute cannot fix it; the poster
  must not be a network URL there.
- **`track` needs the attribute on the media element** (Chromium and Firefox): without it a cross-origin track is
  refused before any request, so today a `<track>` from a listed origin does not load in the real view on any engine (no request, baseline run in §4). With it the track is
  a CORS request without a cookie and loads. WebKit fetched a `default` track in no case here (the guest has no script
  to set the mode); a script-added, showing track is `no-cors` with the cookie without the attribute and CORS without
  it. The attribute goes on the `<video>` or `<audio>`: `<track>` has no `crossorigin` attribute.
- **Range works.** With `crossorigin=anonymous` and ACAO `*`, a seek to 75 % of a 7 MB WebM sends ranged requests
  (206) and plays on all three engines, with no preflight and no cookie, the same pattern as the control. WebKit needs
  more from the server: when the server ignores `Range` (answers 200), WebKit errors with the attribute (code 4) and
  cannot seek without it either, while Chromium and Firefox play and seek from the full response. (One WebKit run at
  load 8 did not advance after the seek within 3 s, and passed on the reruns below load 6; playback speed is not part
  of the claim.)

## 3. Loads that start in CSS

| CSS load (target X, ACAO `*`) | chromium | firefox | webkit |
| :--- | :--- | :--- | :--- |
| `style="background:url()"` | no-cors, cookies 2 | no-cors, cookies 2 | no-cors, cookies 2 |
| `<style>` `background:url()` | no-cors, cookies 2 | no-cors, cookies 2 | no-cors, cookies 2 |
| `<style>@import url()` | no-cors, cookies 2 | no-cors, cookies 2 | no-cors, cookies 2 |
| `@font-face src:url()` | cors, cookies none, font loaded | cors, cookies none, font loaded | no-cors, cookies 2, font loaded |
| `image-set(url() 1x)` | no-cors, cookies 2 | no-cors, cookies 2 | no-cors, cookies 2 |
| `image-set("…" 1x)` | no-cors, cookies 2 | no-cors, cookies 2 | no-cors, cookies 2 |
| `list-style-image` | no-cors, cookies 2 | no-cors, cookies 2 | no-cors, cookies 2 |
| `content:url()` | no-cors, cookies 2 | no-cors, cookies 2 | no-cors, cookies 2 |
| `mask-image:url()` | cors, cookies none | cors, cookies none | cors, cookies none |
| `border-image-source` | no-cors, cookies 2 | no-cors, cookies 2 | no-cors, cookies 2 |
| SVG `fill:url()` | cors, cookies none | no request | no request |
| `url("…" crossorigin(anonymous))` | no request | no request | no request |
| `@import url("…" crossorigin(anonymous))` | no request | no request | no request |
| `@font-face` `url("…" crossorigin(anonymous))` | no request | no request | no request |
| `image-set(url("…" crossorigin(anonymous)))` | no request | no request | no request |

`CSS.supports()` for the request modifier, per engine: chromium `supports=false bg=false`, firefox `supports=false bg=false`, webkit `supports=false bg=false`.

The stylesheet's own subresources (a `<link rel=stylesheet>` with and without the attribute, and an `@import`ed sheet), target X, ACAO `*`; the stylesheet itself, then what its text loads:

| Sheet | Part | chromium | firefox | webkit |
| :--- | :--- | :--- | :--- | :--- |
| `<link rel=stylesheet>` | the sheet | no-cors, cookies 2 | no-cors, cookies 2 | no-cors, cookies 2 |
|  | `@import` in it | no-cors, cookies 2 | no-cors, cookies 2 | no-cors, cookies 2 |
|  | `@font-face` in it | cors, cookies none | cors, cookies none | no-cors, cookies 2 |
|  | `background:url()` in it | no-cors, cookies 2 | no-cors, cookies 2 | no-cors, cookies 2 |
|  | `image-set()` in it | no-cors, cookies 2 | no-cors, cookies 2 | no-cors, cookies 2 |
| `<link rel=stylesheet crossorigin=anonymous>` | the sheet | cors, cookies none | cors, cookies none | cors, cookies none |
|  | `@import` in it | no-cors, cookies 2 | no-cors, cookies 2 | no-cors, cookies 2 |
|  | `@font-face` in it | cors, cookies none | cors, cookies none | no-cors, cookies 2 |
|  | `background:url()` in it | no-cors, cookies 2 | no-cors, cookies 2 | no-cors, cookies 2 |
|  | `image-set()` in it | no-cors, cookies 2 | no-cors, cookies 2 | no-cors, cookies 2 |
| `<style>@import` (no attribute possible) | the sheet | no-cors, cookies 2 | no-cors, cookies 2 | no-cors, cookies 2 |
|  | `@import` in it | no-cors, cookies 2 | no-cors, cookies 2 | no-cors, cookies 2 |
|  | `@font-face` in it | cors, cookies none | cors, cookies none | no-cors, cookies 2 |
|  | `background:url()` in it | no-cors, cookies 2 | no-cors, cookies 2 | no-cors, cookies 2 |
|  | `image-set()` in it | no-cors, cookies 2 | no-cors, cookies 2 | no-cors, cookies 2 |

Does an image behind `url("…" crossorigin(…))` paint (element screenshot against a blank box), ACAO `*`: chromium: plain url() painted, anonymous blank, use-credentials blank; firefox: plain url() painted, anonymous blank, use-credentials blank; webkit: plain url() painted, anonymous blank, use-credentials blank.

- **No attribute reaches CSS.** `url()` backgrounds, `@import`, `image-set()`, list, content and border images are
  `no-cors` with the cookie on all three engines. A stylesheet loaded with `<link crossorigin=anonymous>` (or an
  `@import`ed one) is itself a cookie-less CORS fetch, but everything its text names is loaded the old way. The
  exceptions are the engines' own, not something to rely on: `mask-image` is a CORS load on all three, and `@font-face`
  is CORS on Chromium and Firefox (cross-origin credentials are never sent) but `no-cors` with the cookie on WebKit.
- **The CSS `crossorigin()` request modifier does not exist yet** in these builds: `CSS.supports()` is false, the
  declaration is invalid, no request is made and the image does not paint (all three).
- **CSP cannot split elements from CSS.** `img-src` governs `<img>` and a CSS background alike, so a policy that admits
  X for `<img crossorigin>` admits X for `background:url(X)`. The split has to be made by the renderer.

## 4. Can guest markup defeat the attribute?

**Order and place of the attribute** (target X, ACAO `*`; each cell lists the requests of the element in order):

| Order | chromium | firefox | webkit |
| :--- | :--- | :--- | :--- |
| `img`: `src` then `crossOrigin`, same task | cors, none | cors, none | **no-cors, 2 cookies** then cors, none |
| `img`: `src`, microtask, `crossOrigin` | **no-cors, 2 cookies** then cors, none | cors, none | **no-cors, 2 cookies** then cors, none |
| `img`: `src`, task, `crossOrigin` | **no-cors, 2 cookies** then cors, none | **no-cors, 2 cookies** then cors, none | **no-cors, 2 cookies** then cors, none |
| `img`: `src`, 100 ms, `crossOrigin` | **no-cors, 2 cookies** then cors, none | **no-cors, 2 cookies** then cors, none | **no-cors, 2 cookies** then cors, none |
| `img`: `crossOrigin` then `src` | cors, none | cors, none | cors, none |
| `audio`: `src` then `crossOrigin`, same task | cors, none | cors, none | cors, none |
| `audio`: `src`, microtask, `crossOrigin` | cors, none | cors, none | cors, none |
| `audio`: `src`, task, `crossOrigin` | **no-cors, 2 cookies** | **no-cors, 2 cookies** | cors, none |
| `audio`: `src`, 100 ms, `crossOrigin` | **no-cors, 2 cookies** | **no-cors, 2 cookies** | **no-cors, 2 cookies** |
| `audio`: `crossOrigin` then `src` | cors, none | cors, none | cors, none |
| `video`: `poster` then `crossOrigin`, same task | **no-cors, 2 cookies** | **no-cors, 2 cookies** | **no-cors, 2 cookies** then cors, none |
| `link`: in the document, `href` then `crossOrigin` | **no-cors, 2 cookies** then **no-cors, 2 cookies** | **no-cors, 2 cookies** then **no-cors, 2 cookies** | **no-cors, 2 cookies** then **no-cors, 2 cookies** |

**The attribute on the wrong element, and other values** (`<img>`/`<audio>` rows use the attribute on the loading element):

| Case | chromium | firefox | webkit |
| :--- | :--- | :--- | :--- |
| `crossorigin` on `<source>` in `<video>` only | **no-cors, 2 cookies** | **no-cors, 2 cookies** | **no-cors, 2 cookies** |
| `crossorigin` on `<source>` in `<picture>` only | **no-cors, 2 cookies** | **no-cors, 2 cookies** | **no-cors, 2 cookies** |
| `crossorigin` on `<picture>` only | **no-cors, 2 cookies** | **no-cors, 2 cookies** | **no-cors, 2 cookies** |
| `<img crossorigin="use-credentials">` (ACAO null + credentials) | **cors, 2 cookies** | **cors, 2 cookies** | **cors, 2 cookies** |
| `<audio crossorigin="use-credentials">` | **cors, 2 cookies** | **cors, 2 cookies** | **cors, 2 cookies** |
| `<img crossorigin="foo">` | cors, none | cors, none | cors, none |
| `<img crossorigin>` (empty) | cors, none | cors, none | cors, none |
| `<img crossorigin="ANONYMOUS">` | cors, none | cors, none | cors, none |
| `<audio crossorigin="foo">` | cors, none | cors, none | cors, none |
| `<audio crossorigin>` (empty) | cors, none | cors, none | cors, none |

**A redirect** from the listed origin X to another origin (S), both answering ACAO `*`; the first request, then the hop:

| Case | chromium | firefox | webkit |
| :--- | :--- | :--- | :--- |
| `<img src>` redirected, no attribute | first 302 no-cors, **2 cookies**; hop 200 no-cors, **2 cookies** | first 302 no-cors, **2 cookies**; hop 200 no-cors, **2 cookies** | first 302 no-cors, **2 cookies**; hop 200 no-cors, **2 cookies** |
| `<img crossorigin=anonymous src>` redirected | first 302 cors, none; hop 200 cors, none | first 302 cors, none; hop 200 cors, none | first 302 cors, none; hop 200 cors*, none |

(`cors*`: WebKit sends no `Sec-Fetch-Mode` on a redirect hop; the hop carried no cookie and an `Origin`.)


**Loads no `crossorigin` attribute can reach** (target X; all of them are outside the renderer's element and attribute allowlists):

| Element | chromium | firefox | webkit |
| :--- | :--- | :--- | :--- |
| `<td background=…>` (legacy presentational attribute) | **no-cors, 2 cookies** | **no-cors, 2 cookies** | **no-cors, 2 cookies** |
| `<body background>` set by script | no request | no request | no request |
| `<input type=image src>` | **no-cors, 2 cookies** | **no-cors, 2 cookies** | **no-cors, 2 cookies** |
| `<svg><image href>` | **no-cors, 2 cookies** | **no-cors, 2 cookies** | **no-cors, 2 cookies** |
| `<svg><image href crossorigin=anonymous>` | cors, none | cors, none | cors, none |
| `<svg><feImage href>` | **no-cors, 2 cookies** | **no-cors, 2 cookies** | **no-cors, 2 cookies** |

**The real view.** The cells are `Sec-Fetch-Mode` and the number of cookies on the request in the unmodified renderer
(`baseline`) and with `crossorigin=anonymous` forced in `clean()` (`forced`). The guest lists X for images, media,
styles and fonts and renders one of each load (`guest-usecred` is an `<img crossorigin="use-credentials">` written by
the guest).

| Load | chromium baseline | chromium forced | firefox baseline | firefox forced | webkit baseline | webkit forced |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `img` | no-cors, 0 | cors, 0 | no-cors, **2** | cors, 0 | no-cors, **2** | cors, 0 |
| `srcset` | no-cors, 0 | cors, 0 | no-cors, **2** | cors, 0 | no-cors, **2** | cors, 0 |
| `picsource` | no-cors, 0 | cors, 0 | no-cors, **2** | cors, 0 | no-cors, **2** | cors, 0 |
| `guest-usecred` | no-cors, 0 | cors, 0 | no-cors, **2** | cors, 0 | no-cors, **2** | cors, 0 |
| `video` | no-cors, 0 | cors, 0 | no-cors, **2** | cors, 0 | no-cors, **2** | cors, 0 |
| `poster` | no-cors, 0 | cors, 0 | no-cors, **2** | no-cors, **2** | no-cors, **2** | cors, 0 |
| `track` | - | cors, 0 | - | cors, 0 | - | - |
| `sourcevideo` | no-cors, 0 | cors, 0 | no-cors, **2** | cors, 0 | - | - |
| `track2` | - | cors, 0 | - | cors, 0 | - | - |
| `audio` | no-cors, 0 | cors, 0 | no-cors, **2** | cors, 0 | no-cors, **2** | cors, 0 |
| `sourceaudio` | no-cors, 0 | cors, 0 | no-cors, **2** | cors, 0 | - | - |
| `styleattr` | no-cors, 0 | no-cors, 0 | no-cors, **2** | no-cors, **2** | no-cors, **2** | no-cors, **2** |
| `import` | no-cors, 0 | no-cors, 0 | no-cors, **2** | no-cors, **2** | no-cors, **2** | no-cors, **2** |
| `import.sub-import` | no-cors, 0 | no-cors, 0 | no-cors, **2** | no-cors, **2** | no-cors, **2** | no-cors, **2** |
| `stylebg` | no-cors, 0 | no-cors, 0 | no-cors, **2** | no-cors, **2** | no-cors, **2** | no-cors, **2** |
| `font` | cors, 0 | cors, 0 | cors, 0 | cors, 0 | no-cors, **2** | no-cors, **2** |

Cell: `Sec-Fetch-Mode`, cookies on the request (ACAO `*`; `-`: the request was never made). Without ACAO, the same cookies, and: chromium forced: violations 0, image widths [0,0,0,0,3] (cors run: [3,3,3,3,3]); firefox forced: violations 0, image widths [0,0,0,0,3] (cors run: [3,3,3,3,3]); webkit forced: violations 0, image widths [0,0,0,0,3] (cors run: [3,3,3,3,3]).

The view's own files (registered `pic.png`, `tone.wav`, `own.css`, minted as `blob:` URLs), ACAO `*` run: baseline: chromium image 3px, audio readyState 4, css 9px; firefox image 3px, audio readyState 4, css 9px; webkit image 3px, audio readyState 4, css 9px | forced: chromium image 3px, audio readyState 4, css 9px; firefox image 3px, audio readyState 4, css 9px; webkit image 3px, audio readyState 4, css 9px.

The renderer's crossorigin attributes after the rewrite (cors run): chromium img:anonymous img:anonymous img:anonymous img:anonymous video:anonymous video:anonymous audio:anonymous audio:anonymous img:anonymous audio:anonymous link:anonymous; firefox img:anonymous img:anonymous img:anonymous img:anonymous video:anonymous video:anonymous audio:anonymous audio:anonymous img:anonymous audio:anonymous link:anonymous; webkit img:anonymous img:anonymous img:anonymous img:anonymous video:anonymous video:anonymous audio:anonymous audio:anonymous img:anonymous audio:anonymous link:anonymous.

- **The renderer already drops the guest's attribute**: `crossorigin` is on no allowlist, so the baseline `guest-usecred`
  load is `no-cors` (the engine's default), not `use-credentials`. Forced, it is overwritten.
- **In a live document the order matters; in the renderer it cannot.** Setting the attribute after `src` sends a
  `no-cors` request with the cookie first: after a microtask on Chromium, after a task on Firefox, in the same task on
  WebKit; for `audio` after a task on Chromium and Firefox; `poster` and `link` always. `sanitizeRender` works on the
  inert `template.content` and `replaceChildren` moves the finished nodes in (A2), so the attribute is there when the
  element is first connected: the measured real view sends none. This is an invariant to test, not a property of the
  attribute.
- **Only the loading element counts.** On `<source>`, `<picture>` or `<track>` it has no effect (cookie, `no-cors`); on
  `<img>`, `<video>`, `<audio>` it does. `use-credentials` sends the cookie (with `Allow-Credentials`); an invalid,
  empty or upper-case value is `anonymous`, so the renderer must set the value, not pass the guest's through.
- **Redirects keep the mode:** with the attribute the first request and the hop to another origin are CORS without a
  cookie on all three; without it both carry the cookie.
- **Four loads have no attribute to set:** `<td background>`, `<input type=image>`, SVG `<image href>` without it
  (`crossorigin` is honoured there) and `<feImage>`, all `no-cors` with the cookie on every engine (`<body background>`
  set by script made no request in these documents). They are outside the
  renderer's element and attribute allowlists today; those lists are the only thing between the guest and them.

## Conclusions

1. **The attribute does what the question hopes for on elements**: no cookie of any SameSite kind, on any engine, on any
   target, for every element the renderer keeps except Firefox's poster. It is a CORS request, so the listed origin
   must answer ACAO, and failure is silent. It makes the media and track loads work that did not (tracks) and keeps
   streaming (Range) and the view's own `blob:` files working.
2. **It cannot cover CSS, and CSP cannot split the two.** Guest CSS that names a network URL stays a cookie-carrying
   `no-cors` load on Firefox and WebKit (and on Chromium, if the wrapper were not `credentialless`). The only
   credential-less CSS is CSS with no network reference.
3. **The wrapper's `credentialless` still matters** on Chromium for CSS; the attribute is the Firefox and WebKit answer
   for elements, and a second layer on Chromium.

## Recommendation for the renderer

| Surface | Do | Why |
| :--- | :--- | :--- |
| `img`, `video`, `audio` | Set `crossorigin="anonymous"` on every one the renderer keeps, unconditionally, **overwriting** any value, in `clean()` before the node is moved in (it is already built in an inert template). `picture>source`, `source` and `track` get nothing: the loading element is the `img` or the media element. | §1, §4: no cookie on three engines; only the loading element counts; `use-credentials` would send it. |
| `link` | Set it too (a kept `link` is a minted `blob:` only). | Harmless on `blob:` (§1), and fails closed if a network `link` is ever let back in. |
| `video poster` | **Drop `http(s)` posters** in strict mode (keep a minted `blob:`). | Firefox does not honour the attribute (§2). |
| Guest CSS (`style` attribute, `<style>`, SVG `<style>`) | **Drop every network reference**: `url()`, `@import`, `image-set()`, in `@font-face` too. Keep only references to minted files. Report each as a refused load. | §3: no platform way to make them credential-less; WebKit fonts are `no-cors`. |
| `background`, `<input type=image>`, SVG `<image>` and `<feImage>`, `<body background>` | **Keep them off the allowlists**, and add them to the enumerating test as "no attribute reaches this". | §4: `no-cors` with cookies, no attribute to set. |
| Listed origins (`images`, `media`) | **Document that they must answer ACAO `*` (or `null`)**, and `206` to `Range` for WebKit media. Consider a capturing `error` listener in the view that reports "refused (CORS)" as a violation. | §1: a missing ACAO is a silent failure today, with no violation. |

**Fails closed:** an element without ACAO (no cookie, no content), a `use-credentials` or invalid value (overwritten),
a `source`/`track` attribute (ignored; nothing loads without the media element's), a poster and network CSS (dropped).
**Does not fail closed without a test:** the order (attribute before insertion), and any new loading element or
attribute added to the allowlists. Add an e2e that reruns the §4 view table with a cookie listener on all three engines
(`view.spec.ts` is the start), an enumeration test over `RENDER_URL_ATTRIBUTES` and the element list that fails when an
element that can load has neither the attribute nor a drop rule, and a unit test that the sanitizer's output has the
attribute on every `img`, `video` and `audio`.

## Not measured

HTTP authentication and client certificates (`omit` credentials mode excludes them by the Fetch spec; an element in CORS
`anonymous` mode has the same credentials mode); WebSocket (no attribute exists); an `<img>` of `image/svg+xml` under
CORS; `loading=lazy`; Safari's own ITP and macOS or iOS media stacks (the WebKit here is the Linux build, whose
media rows reflect that stack); Firefox with `cookieBehavior` 5; HTTP/3.

## Rerun

```sh
# once: three names for the listener, and remove exactly this line afterwards
echo '127.0.0.1 app.wsprobe.test cdn.wsprobe.test cross.wsprobe2.test' >> /etc/hosts
# one engine at a time (check `cut -d' ' -f1 /proc/loadavg` is under 6 first)
bunx playwright test docs/research/21_crossorigin_loads --project=chromium
bunx playwright test docs/research/21_crossorigin_loads --project=firefox
bunx playwright test docs/research/21_crossorigin_loads --project=webkit
bun docs/research/21_crossorigin_loads/summarize.ts all       # the tables above
```

Without the hosts line the specs skip. A machine with `HTTPS_PROXY` set sends the `.test` names to the proxy; the specs
add `.test` to `NO_PROXY` for the browsers they launch.

Files: `server.ts` (listener, jar), `cases.ts` (the cases, the page that runs them), `probe.spec.ts` (matrix, blob:,
modifier probes), `view.spec.ts` (the real view, baseline and forced), `summarize.ts`, `results/*.json`.
