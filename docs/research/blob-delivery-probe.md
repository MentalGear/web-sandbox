# Probe: blob-URL file delivery (δ)

**Date**: 2026-10-13 · **Spec**: [`test/e2e/blob-delivery.spec.ts`](../../test/e2e/blob-delivery.spec.ts)
· **Engines**: Chromium 141.0.7390.37, Firefox 146.0.1, WebKit 26.0 (Playwright 1.58.1 builds on Linux)

δ replaces the virtual-files Service Worker (backlog C1–C4, S3) with blob: URLs: the host pushes file
contents to the guest, the guest bootstrap turns each one into a blob: URL created **in the guest's own
realm**, and an import map points module specifiers at them. This note records what that needs from
our CSP and from each engine. Every row below is an assertion in the spec; where engines differ, the
spec asserts each engine's measured behaviour.

## 1. Which loads the policy admits

"Default" is today's `DEFAULT_SANDBOX_CONFIG` (plus the fixture's `'unsafe-eval'`); "δ policy" is the
change recommended below. C / F / W = Chromium / Firefox / WebKit.

| Guest-created blob: load | Governed by | Default CSP | δ policy |
| :--- | :--- | :--- | :--- |
| `<script src=blob:>` (classic) | `script-src-elem` | refused (violation) | loads |
| `<script type=module src=blob:>` | `script-src-elem` | refused | loads |
| `import(blobUrl)` | `script-src-elem` | refused | loads |
| `<link rel=stylesheet href=blob:>` | `style-src-elem` | refused | loads, rule applied |
| `<img src=blob:>` (SVG) | `img-src` | refused | loads |
| `@font-face { src: url(blob:) }` (WOFF2) | `font-src` | refused | loads, glyph applied |
| `fetch(blobUrl)` | `connect-src` | refused | loads |
| `new Worker(blobUrl)` (classic) | `worker-src` | loads (already `blob:`) | loads |
| `new Worker(blobUrl, {type:'module'})` | `worker-src` | **C: fails**, F/W load | **C: fails**, F/W load |
| *worker mode* `importScripts(blob)` | `script-src` (inherited) | refused | loads |
| *worker mode* `import(blob)` | `script-src` (inherited) | refused | loads |
| *worker mode* `fetch(blob)` | `connect-src` (inherited) | refused | loads |
| *worker mode* nested `new Worker(blob)` | `worker-src` | classic loads; module: C fails, F/W load | same |

Each directive admits only its own load type: `blob:` in `script-src` alone leaves styles, images,
fonts and fetch refused. Our worker mode is a **classic** worker (`workerBootstrap` calls
`new Worker(url)` without a type), so `importScripts` and `import()` are its loaders. Engines differ in
which violations reach the worker's own `securitypolicyviolation` listener: Chromium delivers all,
Firefox only fetch's, WebKit none. Every engine still refuses the load.

**Chromium module workers**: a module worker whose blob: URL was created in an opaque-origin document
fails with a bare `error` event and no violation, under any policy. A `data:` module worker and the same
blob module worker on a normal origin both start. Nothing in δ's own path needs a module worker, but
guest code that spawns one from a virtual file will not run in Chromium.

## 2. MIME (replaces C2's defect)

Measured under the δ policy. δ must set every blob's `type` from the file extension.

| Blob type | C | F | W |
| :--- | :--- | :--- | :--- |
| module, `text/javascript` / `application/javascript` | runs | runs | runs |
| module, `text/css` / `text/plain` / empty | rejected | rejected | rejected |
| `import()`, `text/plain` | rejected | rejected | rejected |
| stylesheet, `text/css` | applied | applied | applied |
| stylesheet, `text/plain` | load fires, sheet ignored | error | error |
| stylesheet, **empty type** | applied | applied | applied |
| classic script, `text/plain` | runs | runs | runs |
| classic script, `image/png` | runs | runs | rejected |
| SVG image, `text/plain` | rejected | rejected | rejected |
| font, any type (sniffed) | loads | loads | loads |
| worker `importScripts`, `text/plain` / `image/png` | runs | rejected | rejected |

## 3. Module resolution

- **Relative specifiers never resolve inside a blob: module**, in any engine. Its base URL is the blob
  URL, whose path is opaque, so `./x.js` and `/x.js` throw `TypeError`. `import.meta.url` is
  `blob:null/<uuid>`, and `import.meta.resolve('./x.js')` throws. Mapping the importer under a full-URL
  key does not help: the module's base is still its blob URL.
  *Changed by S15 (2026-10-13)*: the guest document's base URL is now `about:blank`, so an import-map
  key such as `./x.js` or `/x.js` cannot be resolved either and stays as written. Firefox and WebKit
  then match the unresolved specifier to that literal key and the import succeeds through the guest's
  own map; Chromium still throws. Rewriting specifiers to full URLs (below) works in all three.
- **One inline import map works everywhere.** Bare keys (`app/utils.js`) and full-URL keys
  (`https://vfs.invalid/app/w.js`) both map to guest-created blob URLs. Static `import` chains across
  several blob modules link, and a shared module is evaluated once. Inline modules, blob module scripts
  and `import()` all resolve through it. The map is an inline script, so `script-src 'unsafe-inline'`
  admits it (a hash or nonce would too).
- **Firefox 146 honours only the first import map**, and none once a module script has been prepared or
  `import()` called. Later maps are ignored silently and the specifier fails as unmapped. Chromium and
  WebKit merge later maps.
- **Module workers do not see the document's import map.** In Firefox and WebKit they can statically
  import a blob URL that the document created.
- An **unmapped full-URL specifier** falls through to a real fetch of that URL, which the policy
  refuses. Resolution fails closed.

**Scheme that works in all three engines:**
1. Rewrite every relative specifier to an absolute virtual URL: resolve `./x`, `../x` and `/x` in static
   `import` / `export … from` and in literal `import()` against the file's own virtual URL,
   `new URL(spec, 'https://vfs.invalid/' + path)`. Do this before making the blob. The spec illustrates
   it with a regex; production needs a real lexer such as es-module-lexer.
2. Create all blobs, then insert exactly **one** `<script type="importmap">` mapping each virtual URL
   (plus any bare package names) to its blob URL.
3. Insert the map **before the parser reaches the first module script**, guest markup included. The
   bootstrap already precedes guest markup (`buildGuestDocument`), so it works if the bootstrap has the
   files synchronously. That means embedding the initial file set in the srcdoc as an inline literal
   (`toInlineScriptLiteral`), rather than waiting for the broker: the port arrives only after the frame
   has loaded, by which time markup modules have run. Files pushed later cannot extend the map in
   Firefox, so either rebuild the frame or have late files referenced directly by blob URL.
4. For workers, rewrite specifiers to the blob URLs themselves. That needs topological order, and
   cycles are impossible.

## 4. Realms and egress

- **Host → guest**: blob: URLs created by the host page (`blob:http://localhost:4444/…`) never load in
  the guest. This holds for classic and module script, `import()`, stylesheet, image, fetch, XHR,
  Worker, and in worker mode `importScripts`, `import()` and fetch. With `blob:` allowed there is no
  violation, so the refusal is the blob store's origin check (a network error; Chromium's `Worker`
  constructor and Firefox's `importScripts` throw `SecurityError`), not CSP.
- **Guest → host / guest → guest**: the guest's `blob:null/…` URL fails for the host page's `fetch` and
  `<img>`, and for a second sandbox's `fetch`. That gives S3's cross-instance guarantee by construction.
- **No new egress from `blob:`**: blob-loaded classic scripts, modules, worker `importScripts` and
  stylesheets run under the guest's CSP. Fetch, `import()`, images, `importScripts`, WebSocket and CSS
  `url()` / `@import` to a non-allowlisted origin are refused, and nothing reaches the network. A blob:
  document cannot replace the guest frame through `location`, `window.open(_self)`, a link click or a
  form; cannot load in a nested frame; and cannot open a new browsing context. In Chromium a navigation
  refused by the wrapper's `frame-src` commits `chrome-error://` in place of the guest, exactly as for an
  https: target ([research 14](14_self_navigation/README.md)). Firefox and WebKit keep the original
  document.
- With `blob:` added, the existing security suites pass in all three engines: Chromium 34, Firefox +
  WebKit 65 (3 pre-existing skips). The suites are `security`, `hard-security`, `worker-security` and
  every `docs/research` spec. This was run through a temporary, reverted fixture override.
- Method caveat: in Chromium, Playwright's `context.route` does not reliably see the guest frame's
  subresource requests. So the egress assertions rest on refusals and CSP violations as well as
  routes, and the WebKit result below was confirmed against a raw TCP listener.

### Finding: `script-src 'self'` in the opaque-origin guest — fixed by [S14](../BACKLOG.md)

Measured with the then-shipping config (`script-src 'self' 'unsafe-inline'`, `scriptUnsafe: false`,
guest markup only):

| `'self'` admits | C | F | W |
| :--- | :--- | :--- | :--- |
| the host page's origin | **yes**: host-origin script loads | no | n/a (upgraded to https) |
| an arbitrary https origin | no | no | **yes**: classic, module and `import()` load and **run**, no violation |

In WebKit the request really left the machine: a raw TCP listener received the TLS ClientHello, and
only when `script-src` contained `'self'`. That was a default-config egress route, independent of
`blob:`. Since S14 the guest policy never contains `'self'`. It is gone from the default, and a
configured one is dropped with a warning. Section 5a of the spec asserts the result identically on all
three engines.

## Minimal CSP change for δ

```
script-src  'unsafe-inline' blob:
style-src   'unsafe-inline' blob:
img-src     blob:
font-src    blob:
connect-src blob:                      (only if guest code fetches its own files: JSON, wasm, …)
worker-src  blob: data:                (unchanged)
```

`media-src blob:` would be needed for audio and video files; it was not probed. `blob:` is a scheme
source, but the blob store only ever resolves URLs from the guest's own origin (section 4), so it
grants no reach beyond the guest's own files.

## Open risks

- **Bootstrap timing.** Firefox's single-map rule forces the initial file set to be known when the
  frame is built. "Push over the broker" works for later reads (C1's `fs` API), not for the first
  module graph.
- **Specifier rewriting** needs a JS lexer. Computed `import(expr)` and
  `new URL('./x', import.meta.url)` (Vite-style assets and workers) cannot be rewritten statically and
  will fail.
- **Relative URLs inside blob CSS** (`url(./img.png)`, `@import`) resolve against the blob URL by the
  same rule, so they need rewriting as well. Not asserted.
  *Resolved (2026-10-13)*: rewritten with slots the guest fills in dependency order
  ([ADR-004, CSS amendment](../ADR-004-files-as-blob-urls.md#amendment-css-references-and-srcset-2026-10-13));
  a reference left as written loads nothing and requests nothing (`files.spec.ts` section 10).
- **Chromium blob module workers** (section 1).
- **Engine drift.** Firefox is implementing multiple import maps, and the local Chromium (141) is older
  than CI's bundled build. The spec asserts per-engine behaviour, so drift will surface as a failure.
  Playwright's WebKit on Linux is not Safari, so re-measure the WebKit rows in Safari.
- **Blob lifetime.** URLs live until revoked or until the frame goes. C3 becomes "revoke on unregister";
  tearing the frame down frees everything.

## Verdict

**Viable, with changes.** Every load type δ needs works in all three engines once `blob:` is in five
directives. Blob URLs stay in their realm, and `blob:` adds no egress. The changes:
- rewrite relative specifiers to absolute virtual URLs and register one import map before any module;
- ship the initial file set synchronously in the srcdoc;
- accept that Chromium cannot run guest module workers from virtual files.
