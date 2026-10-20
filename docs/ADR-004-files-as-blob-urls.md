# ADR-004: Files are guest-realm blob URLs

**Status**: Accepted · **Date**: 2026-10-13 · **Amended**: 2026-10-13 (markup references, module graph, CSS references, strict mode), 2026-10-14 ([`blob:` by governing directive](#amendment-2026-10-14-blob-goes-to-the-directive-that-governs-the-load), [guest writes](#amendment-guest-writes-2026-10-14), [load kinds](#amendment-2026-10-14-a-reference-names-a-file-only-for-the-kind-of-load-its-type-is-for)), 2026-10-14 ([broad review: answers from the build; file sources widen only their kinds](#amendment-2026-10-14-broad-review-answers-from-the-build-file-sources-widen-only-their-kinds)), 2026-10-14 ([typed origins: file sources are the generator's](#amendment-2026-10-14-typed-origins-file-sources-are-the-generators)), 2026-10-15 ([the strict view shows raster-image guest writes](#amendment-2026-10-15-the-strict-view-shows-raster-image-guest-writes))

## Why this ADR exists

The package advertised virtual files: the host registers files, and guest code loads them. The
mechanism was a Service Worker on a separate "hub" origin, and it never served a file to a guest.
Its only end-to-end spec, `virtual-files-real.spec.ts`, was marked `fixme`. Four independent faults
each broke it on its own:

1. **The guest is never a controlled client.** A Service Worker handles navigations in its scope and
   subresource requests from clients it controls. The guest is a sandboxed `srcdoc` document with an
   opaque origin, nested in an opaque wrapper, under a host page outside the worker's scope. None of
   them is a client of the worker, so the guest's requests to `virtualFilesUrl/<session>/x` went to
   the network, where the dev server's middleware found no such file.
2. **The worker was never valid JavaScript.** `hub.html` registered `./sw.ts`, served untranspiled,
   and its `declare const self` is a syntax error.
3. **The hub was a third-party iframe.** Its worker was storage-partitioned under the embedding page,
   and only Chromium was given the host-resolver flag for `virtual-files.localhost`.
4. **Files could be lost.** `registerFiles()` posted to the hub without a handshake, so files sent
   before the hub had loaded were dropped with a warning.

The session id that addressed a sandbox's files was also readable by the guest (backlog S3), and the
worker served everything as `text/javascript` with string-only storage (C2). Deleting the Service
Worker path removed nothing that worked.

The [blob delivery probe](archive/research/blob-delivery-probe.md) measured the replacement before it was
built: what each engine loads from a `blob:` URL, under which directive, with which MIME type, and
which realms a `blob:` URL resolves in.

| Item | What was missing |
| :--- | :--- |
| C1 · in-sandbox file API | the guest could not list, read or address files |
| C2 · MIME and binary | everything was `text/javascript`; binary content was broken at the type boundary |
| C3 · lifecycle and cap | nothing bounded the store or released it |
| C4 · Service Worker integrity | a mechanism to protect that does not survive this decision |
| S3 · session id readable by the guest | the id was the capability to every file |

## Decision

1. **Files are part of the environment.** The element keeps a store: `registerFiles(files)` merges,
   `unregisterFiles(paths?)` removes (all without an argument), `listFiles()` returns
   `{ path, type, size }`. The store survives `reset()`, `load()`, `setConfig()` and `terminate()`.
   Every environment build takes one snapshot of it; a frame that is already running never changes.
   `fileschanged` fires synchronously with `{ paths }`, once per call that changed something.
2. **One literal, guest-realm blobs, before any markup.** The snapshot is embedded in the bootstrap as
   one inline literal, `[[path, type, base64], ...]`. The bootstrap decodes each entry, creates a
   `Blob` with its type and a `blob:` URL in the guest's own realm, synchronously, before the parser
   reaches guest markup. The guest gets `sandboxFiles.list()`, `url(path)`, `read(path)` and
   `text(path)`. In worker mode the same literal goes into the worker's source, and the worker builds
   its own blobs and its own `sandboxFiles`, so `importScripts`, `fetch` and `read()` work there.
3. **Paths are validated, never normalised.** A path is accepted only if it is 1–256 characters of
   non-empty segments made of `[A-Za-z0-9._~!$&'()*+,;=@-]`, with no `.` or `..` segment, and
   `new URL(p, 'https://vfs.invalid/')` keeps it unchanged. So `%`, `\`, `:`, `?`, `#`, whitespace,
   controls and non-ASCII are refused, as are leading, trailing and doubled slashes. The guest's
   lookup is an exact `Map` lookup of the string it passes: anything else — missing, traversal,
   encoded, absolute, another instance's path, a non-string — is `NOT_FOUND`.
4. **A MIME table that is never empty.** About 30 extensions map case-insensitively to a type;
   anything else is `application/octet-stream`. Never the empty type: every engine applies a
   typeless blob as a stylesheet. `{ content, type }` overrides the type with a `type/subtype` token.
5. **`blob:` only where a registered type loads.** The guest policy gains `blob:` only when files are
   registered, and only in the directives their types need: JavaScript → `script-src`, `text/css` →
   `style-src`, `image/*` → `img-src`, `font/*` → `font-src`, `audio/*`, `video/*` and `text/vtt` →
   `media-src`, and any file → `connect-src` (amended 2026-10-14: the directive that *governs* each kind of
   load, so `script-src-elem` / `style-src-elem` when configured; see the amendment below; since ADR-007 the template's
   directive of each kind, see the last amendment). An empty directive falls back to `default-src`, so
   adding only `blob:` would narrow it; the `default-src` sources (minus `'none'` and `'self'`) are
   copied in first. An embedder's explicit `'none'` is kept, with one warning that those files will
   not load. This runs before `'unsafe-eval'` and before the `'self'` drop, which stays the last step
   (S14). `base-uri` no longer gets a files base, so it is always `'none'` by default (S9).
6. **Refusals carry a code.** `registerFiles()` throws `INVALID_PATH`, `INVALID_FILE` or
   `FILES_QUOTA_EXCEEDED`, `unregisterFiles()` throws `INVALID_PATH`; the guest's lookups throw or
   reject with `NOT_FOUND`, minted in the guest, with a message that names nothing but the code. All
   are plain `Error`s with an own `code` (the B7 shape). They are not `RpcErrorCode`: no broker is
   involved. Each batch is validated whole against the store it would produce before anything changes.
7. **A cap, measured.** 8 MiB in total, at most 1000 files, paths of at most 256 characters: module
   constants, not configuration. The cap was measured to load byte-exact in Chromium 141, Firefox 146
   and WebKit 26 in both modes; all three also loaded 16, 32 and 64 MiB, but time to `ready` grows
   with size (at 8 MiB about 0.5–1.6 s; at 64 MiB 4.6–17 s, Chromium the slowest). Raise it only after
   `files.spec.ts` passes at the new value in all three engines. Memory is about 3–3.5× the file bytes
   across host and guest (the host's base64, the srcdoc string, the guest's blobs).
8. **The API always exists; the policy changes only with files.** `sandboxFiles` is installed in
   every environment, in both modes. With nothing registered, `list()` is empty and every lookup is
   `NOT_FOUND`, so guest code never meets a `ReferenceError` that depends on host state. The policy
   with no files is byte for byte what it was before this decision (no `blob:` beyond `worker-src`),
   and the guest document differs only by the empty files bootstrap, still inside the security block
   after the CSP meta (S2).

`virtualFilesUrl` is gone from `SandboxConfig`; a config that still passes it gets one warning per
element and the field is dropped. The hub, the worker and their build steps, the dev-server middleware
and the Chromium host-resolver flag are deleted.

The mechanism lives in [`src/lib/files.ts`](../src/lib/files.ts) (store, paths, MIME),
[`src/lib/in-sandbox-files.ts`](../src/lib/in-sandbox-files.ts) (the guest side) and
[`src/lib/csp/csp-generator.ts`](../src/lib/csp/csp-generator.ts) (the policy; `file-sources.ts` until ADR-007). The proof is their unit
tests, [`test/unit/files.test.ts`](../test/unit/files.test.ts) (the host's output, including the
no-files policy and document) and [`test/e2e/files.spec.ts`](../test/e2e/files.spec.ts) (every
load type, containment, isolation between sandboxes, no egress, lifecycle, worker mode and the cap,
on Chromium, Firefox and WebKit).

## Alternatives considered

### Keep the Service Worker and fix it

Rejected for reason 1 above, which no fix reaches: an opaque-origin `srcdoc` guest cannot be a client
of any Service Worker, and it cannot register one of its own (research 02). The other three faults
were fixable; this one is the architecture.

### `data:` URLs

Rejected: every reference would carry the whole file. A 4 MiB file is a 5.6 MB URL each time guest
code uses it, copied into every attribute, stylesheet rule and (later) import map entry. A `blob:`
URL is short, is created once per build, resolves only in the realm that minted it, and is freed
with that realm.

### Blobs created by the host page

Rejected by measurement: a `blob:` URL minted by the host page is refused by the guest's blob store
for every load type, in every engine, with `blob:` allowed (probe, section 4). The URLs have to be
created in the guest's own realm.

### Inlining file contents into the guest markup

Rejected: it works only for files that guest markup names, and only by rewriting that markup into a
different document (inline `<style>` and `<script>` behave differently from fetched ones, and a
module has no URL to resolve imports against). It also gives guest code no way to list or read files.

### Delivering files over the broker after the port exists

Rejected for the initial set: the port arrives only after the frame has loaded, by which time guest
markup and its module scripts have already run, and Firefox honours only the first import map of a
document (probe, section 3). The broker remains the route for writes (C5).

### A `<script type="application/json">` data element

Rejected: the bootstrap would find it with a DOM lookup, and guest markup could shadow or precede an
element the bootstrap looks up. An argument to the bootstrap call cannot be reached by markup.

### `config.files`, Blob values, live pushes

- **Files in the config**: `setConfig()` rebuilds the config from the defaults, so files would vanish
  with an unrelated config change, and the config's deep merge mangles a `Uint8Array`.
- **`Blob` values**: reading one is asynchronous, which races `reset()` and breaks the one-snapshot
  rule.
- **Pushing changes into a running guest**: Firefox's single import map cannot be extended, the
  guest would see some files from one snapshot and some from another, and it needs the broker after
  load. A rebuild gives one consistent view.

### Guest writes in this step

Deferred to backlog C5: an opt-in `FS_WRITE` frame handled before the broker (like the watchdog's
`PING`), with the host validating path and quota. The guest's overlay is discarded at `reset()`
unless the host commits it, and it is opt-in because otherwise a guest could plant code that the
next environment runs. *Decided in the [guest writes amendment](#amendment-guest-writes-2026-10-14): a reserved
broker method rather than a raw frame.*

## Consequences

- A guest reaches its files by `sandboxFiles.url()`, `read()`, `text()` and `list()`, in both modes,
  from its first script on.
- Containment is by construction: an exact lookup in a map built from validated paths has nothing
  to traverse, and every miss looks the same.
- Isolation between sandboxes is by construction too: a guest's `blob:` URL resolves neither in
  another sandbox nor on the host page, and the guest document carries no session id, no host origin
  and no `<base>` (S3).
- `blob:` adds no egress: blob-loaded code and stylesheets run under the guest policy, and every
  attempt to reach a non-allowlisted origin is refused with a CSP violation (probe, section 5, and
  `files.spec.ts` section 4).
- Releasing the frame releases its blobs: they belong to the guest document or worker, and teardown
  destroys that realm.

Costs and limits:

- **Guest markup and stylesheets name files only through the references listed in the amendments
  below** (2026-10-13): markup attributes, relative imports between modules, CSS `url()` and
  `@import`, and `srcset`, each with the limits listed there. `<template>` contents and URLs built at
  run time do not resolve; guest code uses `sandboxFiles.url()` for those.
- **Every guest carries the files bootstrap**, about 1.3 KB of source, files or not. That is the
  price of an API that exists regardless of host state.
- **Changes need a rebuild.** A file registered while the guest runs reaches it at the next
  `reset()`, `load()` or `setConfig()`.
- **Chromium cannot start a module worker from a guest `blob:` URL**, under any policy (probe,
  section 1). Classic workers and `importScripts` work everywhere.

## Next steps

Planned in this order, each on top of this decision:

1. **Markup references** — *done 2026-10-13, see the amendment below*: the host rewrites
   `script[src]`, stylesheet and icon links, media sources and `poster` that resolve to registered
   files, and the bootstrap writes the document with the guest's own `blob:` URLs in their place,
   keeping parser order and the CSP-first rule (S2).
2. **Module graph** — *done 2026-10-13, see the amendment below*: relative specifiers rewritten
   host-side with es-module-lexer (approved as a bundled dev dependency) and one import map from
   virtual URLs to `blob:` URLs.
3. **CSS** — *done 2026-10-13, see the amendment below*: `url()` and `@import` in registered
   stylesheets, inline `<style>` and `style=""`, and `srcset`, with a host-side CSS tokenizer and slots
   the guest fills in dependency order; a reference cycle fails closed.

### Revisit if

- browsers let a sandboxed opaque-origin document be controlled by a Service Worker; or
- Firefox ships multiple import maps, which would let files reach a running guest without a rebuild.

## Amendment: markup references (2026-10-13)

**Status**: Accepted · **Date**: 2026-10-13 · implements next step 1

Guest markup can name a registered file the way a page names a file next to it on a server:
`<script src="app.js">`, `<link rel="stylesheet" href="./style.css">`, `<img src="/img/logo.svg">`.

### Decision

1. **The host resolves, the guest parses.** Before the frame exists, the host parses the guest markup
   with `DOMParser` (in the host window) and resolves these attributes against the virtual document
   URL `https://vfs.invalid/index.html`: `script[src]`; `link[href]` when a `rel` token is
   `stylesheet`, `icon`, `preload` or `modulepreload`; `src` of `img`, `source`, `video`, `audio` and
   `track`; `video[poster]`. Only elements in the HTML namespace count. An attribute whose resolved
   URL is `https://vfs.invalid/` plus a registered path, exactly, becomes a sentinel
   `vfs-slot-<nonce>-<index>`, with a 128-bit nonce drawn per build. The document is serialised and cut
   at the sentinels into parts, `[markup, path, markup, …, markup]`
   ([`src/lib/markup-references.ts`](../src/lib/markup-references.ts)).
2. **The bootstrap writes the markup.** The parts are one more inline literal. After the blobs exist,
   the bootstrap's last statement joins the parts with the guest's own `blob:` URLs (escaped for the
   double-quoted attribute they land in) and calls `document.write()` once
   (`inSandboxMarkup` in [`src/lib/in-sandbox-files.ts`](../src/lib/in-sandbox-files.ts)). It uses the
   object `inSandboxFiles` returned, not the `sandboxFiles` global. The guest document then ends with
   the bootstrap script: nothing of ours follows it, so what it writes is the rest of the document.
3. **No match, no change.** If no attribute names a registered file, the guest document is built
   exactly as before: the original markup, verbatim, after the security block. A test pins the
   document byte for byte. The rewrite also stays off when the bootstrap could not run — no
   `allow-scripts`, or a policy whose `script-src` (or `default-src`) does not admit inline scripts,
   or carries a nonce, hash or `'strict-dynamic'` — since then nothing would write the markup.
4. **Worker mode has no markup**, so nothing is rewritten there.

### Why this works

- **Parser order is the parser's.** `document.write()` from a parser-inserted script puts the markup
  into the parser's input right after that script. The guest's own parser parses it, so its scripts
  are parser-inserted: sync scripts block in order, `defer` and module scripts run after parsing in
  document order, `async` runs when loaded, `document.currentScript` is set, and a stylesheet blocks
  the next script. `files.spec.ts` section 8 asserts each of these in all three engines.
- **The policy stays first (S2).** The CSP `<meta>` is the first element of `<head>`, the bootstrap
  follows it, and the written markup comes after both. The guest markup travels inside a JSON string
  literal with `<` escaped, so it cannot end the bootstrap script, open a comment, or come before the
  policy.
- **Nothing the guest writes reaches the bootstrap.** The markup is data in a literal; no guest code
  has run when the write happens; and the URLs come from the bootstrap's own lookup. The nonce exists
  only on the host, for one build, and never reaches the guest. A forged sentinel would need it, and
  even then a slot index names only a path in this build's snapshot: the guest's own file, whose URL
  it can already get from `sandboxFiles.url()`.
- **Parsing untrusted markup on the host is inert.** A `DOMParser` document has no browsing context
  and scripting is disabled in it: no script runs, no event handler fires, and nothing is fetched. A
  unit test asserts that inline scripts and `onerror` handlers in the parsed markup never run.

### Resolution rules

- Resolution is the URL parser's, as a browser would do it against a page served at the root of the
  files: `logo.svg`, `./logo.svg`, `/logo.svg`, `img/../logo.svg`, `%2e%2e/logo.svg` (a dot segment by
  the URL standard), `img\logo.svg` and `https://vfs.invalid/logo.svg` all name `logo.svg`. Nothing
  resolves above the root.
- The resolved path must equal a registered path exactly. Since registered paths are the ones the URL
  parser keeps unchanged, another case or any other percent-encoding names nothing.
- **A query or a fragment, even an empty one, names nothing** (`logo.svg?v=2`, `logo.svg#x`): fail
  closed rather than strip. A `blob:` URL cannot carry a query (it would name no blob), so stripping it
  would silently change what the markup asked for.
- An empty or blank value never names a file, though it would resolve to `index.html`: a browser does
  not load `src=""` as the document either.
- **Everything not matched stays as written and fails closed.** The guest's base URL is the
  wrapper's `about:blank` (S15), so a relative URL cannot be resolved there: the load fails with no
  request and no violation. An absolute URL that names no registered file is refused by the policy as
  before. `files.spec.ts` asserts both, with a refused absolute URL as the positive control for the
  violation channel and a matched reference as the positive control for the outcome channel (T5).

### Where the markup lands

Embedded markup is parsed after our `</head>`; written markup is parsed while the parser is still in
our `<head>`. The difference does not show, because the host serialises a whole document: the
written markup starts with `<html>` (its attributes merge onto ours, as before), then its own
`<head>` (ignored, as before) with the head content, then `</head>` and `<body>`, so the parser leaves
the head before any body content, exactly where embedded markup would have put it. `files.spec.ts`
loads the same fragment once with a matched reference and once without, and the parsed `<head>`
(after the security block) and `<body>` are identical in all three engines.

Full documents work: `<!DOCTYPE html><html lang="en"><head>…</head><body class="…">…` keeps its `lang`,
title, head elements and body attributes.

### Re-serialisation fidelity

When at least one reference matched, the markup the guest parses is the host's serialisation of the
parsed tree, not the original text. The guest's parser would build the same tree from either, so the
differences are in form: quoting and case of tags and attributes, implied and closing tags made
explicit (`<tbody>`, `</p>`), character references normalised, the doctype dropped (ours comes first,
and a later one is ignored anyway). Known differences in content:

- matched attributes hold the `blob:` URL, so `getAttribute('src')` and `document.currentScript.src`
  read `blob:null/…`, not `app.js`;
- `<noscript>` content is parsed as elements (scripting is off in a `DOMParser` document) and
  serialised back; the guest still reads it as raw text, as before;
- markup that does not survive an HTML round trip unchanged (some misnested or foster-parented
  constructs, the cases mutation-XSS research collects) can parse to a slightly different tree. That
  changes only the guest's own document: the markup stays inside a string literal until the write,
  and the guest gains nothing it could not write itself.

Markup with no matched reference is never re-serialised.

### Not supported (fail closed), each left as written

`srcset` and CSS `url()` in `<style>` or `style=""` (next step 3, done in the CSS amendment below);
relative imports inside a module (next step 2, done in the module graph amendment below); `<template>`
contents; `<iframe>`, `<embed>`, `<object>`, `<a href>`, `<form action>`, `<input type="image">` and
SVG elements; `rel` values outside the list. `load()` takes markup, as before: a registered
`index.html` is a file like any other, not the guest's markup (the playground's "Run (Virtual-Files)"
registers the code as `index.html` and also passes it to `load()`).

### Alternatives considered

- **A guest `<base href="https://vfs.invalid/">`**: import maps do not apply to a module script's
  `src`, so modules would still need rewriting; it needs `base-uri` loosened, undoing S9; and a base
  turns every unmatched relative URL into a real request that only the policy stops, where today it
  is no request at all.
- **A `MutationObserver` that swaps URLs as elements appear**: the parser may start a fetch, or run a
  script, before the observer's callback runs; it races by design.
- **Inlining file contents into the markup**: rejected in the main decision (inline scripts and
  styles behave differently, and a module has no URL).
- **A guest-side `DOMParser`**: the markup would still have to arrive as data in a literal, so it
  gains nothing over the host parse, and it would put a parser step into every guest bootstrap. The
  host parses once, in a realm no guest code ever reaches.
- **A second, separate script after `</head>` that writes the markup**: it would parse in the same
  insertion mode as embedded markup, but it would have to find the URLs through a global the first
  script left behind. One script, ending in the write, keeps the lookup private.

### Tests

[`src/lib/markup-references.test.ts`](../src/lib/markup-references.test.ts) (resolution corpus, each
element and attribute, what is left alone, sentinels and nonces, re-serialisation, the inline-script
check), [`test/unit/files.test.ts`](../test/unit/files.test.ts) (the no-match document byte for byte,
the matched document exactly, the conditions that keep markup verbatim, a nonce per build, the S2
hostile corpus with matched references, before and after the write) and
[`test/e2e/files.spec.ts`](../test/e2e/files.spec.ts) section 8 (parser order and `currentScript` for
sync, inline, `defer`, module and `async` scripts, a stylesheet applied before the next script and by
`DOMContentLoaded`, images by relative, `./` and `/` paths, the policy still first; fragment placement
equal to the verbatim path; fail closed with no request), on Chromium, Firefox and WebKit.

## Amendment: module graph (2026-10-13)

**Status**: Accepted · **Date**: 2026-10-13 · implements next step 2

Registered modules import each other the way they would on a server: `import { a } from './lib/a.js'`,
`export * from '../shared/b.js'`, `import('/lazy.js')`, from a file named by
`<script type="module" src="main.js">` or from an inline module in the guest markup.

### Why it needs a rewrite

A relative specifier never resolves inside a `blob:` module. Its base URL is the blob URL, whose path
is opaque, so `./x.js`, `../x.js` and `/x.js` throw a `TypeError` in every engine, and they do so
**before** any import map is consulted: an import map maps the resolved URL (or a bare specifier),
and here there is no resolved URL (probe, section 3). Since S15 the guest's base is `about:blank`, and
Firefox and WebKit then match a literal `./x.js` key; Chromium does not. Only a specifier rewritten to
a full URL resolves in all three engines.

### Decision

1. **Rewrite at registration, on the host, JavaScript only.** When `registerFiles()` stores a file
   whose type is JavaScript (`text/javascript`, `application/javascript`, `text/ecmascript`,
   `application/ecmascript`, from the extension or an override), es-module-lexer finds its import
   specifiers. Each relative one (`./`, `../`, `/`) in a static `import`, `export … from`,
   `export * from`, a side-effect `import '…'`, a source or defer phase import, and in `import()` whose
   argument is a string literal (or a template literal without substitutions) is replaced, quotes
   included, by `JSON.stringify(new URL(specifier, 'https://vfs.invalid/' + path).href)`
   ([`src/lib/module-specifiers.ts`](../src/lib/module-specifiers.ts)). Resolution is the URL
   parser's: `..` above the root stays at the root. A specifier that would resolve outside
   `https://vfs.invalid/` (`//host/x.js`, `/\host/x.js`) is left as written, as are bare specifiers
   and full URLs: the import map and the policy decide those.
2. **`read()` is faithful; the module graph uses the rewrite.** The store keeps the bytes as
   registered and the rewrite as byte-range edits. The snapshot entry of a rewritten file gains a
   fourth element, `[start, end, text, …]` over the registered bytes, and the guest builds the module
   blob from slices of the registered blob and those texts, so the literal carries the file once.
   `url(path)` names the module form (what markup references and the import map use); `read()` and
   `text()` return the bytes as registered; `listFiles()` reports the registered size.
3. **The quota counts what the literal carries.** A rewritten file costs its registered bytes plus,
   per rewritten specifier, the replacement's length plus 24 (two offsets and the separators). So the
   snapshot literal never grows past what the 8 MiB cap was measured at, even for a file that is
   nothing but imports (a `import'./a';` costs 12 bytes registered and 59 rewritten). The check stays
   atomic: the registered bytes are checked first, so an oversized batch is refused before any lexing,
   then the batch is lexed and checked again, all before the store changes.
4. **Exactly one import map, registered by the bootstrap.** After the blobs exist and before the
   markup is written, a new bootstrap step (`inSandboxImportMap` in
   [`src/lib/in-sandbox-files.ts`](../src/lib/in-sandbox-files.ts)) builds
   `{ imports: { 'https://vfs.invalid/<path>': <blob URL> } }` for every registered JavaScript file,
   inserts it as a `<script type="importmap">` through the DOM, and removes the element again: an inline
   import map is registered when it is inserted, so the guest's document is left as it was. Its text
   never passes through the HTML parser, and every `<` in the JSON is escaped as `<` anyway. The
   value is the very URL `url(path)` returns and markup references use, and the module map is keyed
   by URL, so a module reached both from markup (by `blob:` URL) and through the map (by virtual URL)
   is one module, evaluated once.
5. **Inline module scripts in the markup are rewritten too**, against the virtual document URL
   `https://vfs.invalid/index.html`, as markup references are resolved. An inline module whose
   specifier to replace contains `<` or `>` is left as written: those characters decide where the HTML
   tokenizer ends a script (`<!--`, `-->`, `<script`), so replacing them could move the script's end
   when the markup is parsed again.
6. **The guest's own import maps are merged into ours**
   ([`src/lib/import-map.ts`](../src/lib/import-map.ts)). Firefox honours only the first import map
   of a document, Chromium and WebKit merge later ones, so a guest map left in the markup after ours
   would apply in two engines and not in the third. Its inline `<script type="importmap">` elements
   are taken out of the markup by the host's parse; each must be valid JSON in the import-map shape
   (else it is left out, with a warning); several merge in document order, the earlier entry winning;
   and every guest key that could match a URL in `https://vfs.invalid/` (inside it, or a prefix such
   as `https://`) is dropped with a warning, in `imports` and in every scope: that origin names
   registered files, and only the host maps it. The merged map travels as one more JSON string in
   the bootstrap literal. With no JavaScript file registered, nothing changes: a guest import map
   stays in the markup as written, as before.
7. **Same gate as markup references.** The map is an inline script, and the bootstrap is what
   registers it: with no `allow-scripts`, or a policy whose `script-src` (or `default-src`) does not
   admit inline scripts or carries a nonce, hash or `'strict-dynamic'`, there is no map, no markup
   change, and relative imports fail closed as before. `script-src` already gains `blob:` for
   JavaScript files (main decision, point 5).
8. **Failures pass the file through.** A JavaScript file that is not UTF-8 or that the lexer cannot
   parse is stored unchanged, with one warning per registration of that file; its relative imports
   then fail closed. An inline module the lexer cannot parse is left as written, with one warning per
   element.

### Why es-module-lexer, and why its `/js` build

- **There is no native module lexer.** Browsers expose no API that lists a module's imports without
  loading it, and `import.meta.resolve()` resolves against the module's own `blob:` URL, so it throws
  for the same reason the import does (probe, section 3).
- **An import map cannot rescue a relative specifier in a `blob:` module**: resolution against the
  `blob:` base fails before the map is consulted (above). The rewrite has to change the source.
- **Bun's scanner (`Bun.Transpiler.scanImports`) exists only in the Bun runtime.** The rewrite runs in
  the embedder's browser, at `registerFiles()`.
- **A regular expression cannot tell an import from import-like text** in strings, comments, regular
  expression literals and template literals; a JavaScript tokenizer, with the division/regex
  ambiguity and nested templates, is what es-module-lexer is. It is the lexer Vite and Vitest use.
- **The `/js` build** (`es-module-lexer/js`, the asm.js build) is plain JavaScript: `parse()` is
  synchronous, there is no `init()` and no WebAssembly, so `registerFiles()` stays synchronous and the
  host page never needs `'wasm-unsafe-eval'` in its own policy. The default build compiles WebAssembly
  and must be awaited first.
- **Bundled, pinned, with its notice.** It is a dev dependency pinned at 1.7.0 and compiled into
  `dist/index.js` by the library build, so consumers install nothing (the packed `package.json` has no
  `dependencies`). Its MIT licence ships as [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md),
  which is in the package's `files`, and a `/*! … */` notice comment that the bundle keeps.

### Not supported (fail closed)

- **Computed `import(expr)`**: not rewritten; a relative value throws a `TypeError` against the
  `blob:` base, with no request.
- **`new URL('./x', import.meta.url)`** (the pattern bundlers use for assets and workers):
  `import.meta.url` is `blob:null/<uuid>`, and resolving against it throws. Use `sandboxFiles.url()`.
- **A relative import of an unregistered file, or with a query or fragment**: rewritten to a virtual
  URL that is not in the map, so the browser asks for `https://vfs.invalid/…`, which the policy refuses
  with a violation. Nothing leaves (`.invalid` never resolves either).
- **Module workers**: Chromium cannot start one from a guest `blob:` URL (main decision), and the
  document's import map does not apply in workers in any engine, so rewritten imports fail there.
- **Worker mode is classic only.** The worker gets the same snapshot, so `url()` names the module
  form and `read()` the registered bytes, but there is no import map: `importScripts()` and
  `import()` of a module without relative imports work, and a rewritten graph fails closed.
- **A guest map entry for the virtual origin**, and a bare specifier mapped to a virtual URL (import
  maps do not chain: the virtual URL would be fetched, and refused). A guest map can map bare
  specifiers to allowlisted URLs.
- **CSS** `url()` and `@import` inside registered stylesheets: next step 3, done in the CSS amendment
  below.

### Costs

- **Bundle size**: the lexer is about 20 KB of minified JavaScript. The minified host build grows
  from 23.5 KB to 49.7 KB (8.6 KB to 17.1 KB gzipped); the published, unminified `dist/index.js` from
  42.6 KB to 114.7 KB (11.9 KB to 23.9 KB gzipped).
- **Registration time**: lexing 5–8 MiB of JavaScript took 0.1–0.2 s in Bun (`registerFiles()` for
  the same bytes as `text/plain` takes under 10 ms).
- **Host memory**: the lexer keeps its working buffer, sized for the largest source it has lexed
  (2 bytes per character plus 512 KiB, rounded up to a power of two: 32 MiB after an 8 MiB file), for
  the life of the page.

### Tests

[`src/lib/module-specifiers.test.ts`](../src/lib/module-specifiers.test.ts) (every import form,
import-like text in strings, comments, regular expressions and templates left alone, computed
`import()` and `import.meta` untouched, `..` clamped, scheme-relative specifiers left, the byte order
mark), [`src/lib/files.test.ts`](../src/lib/files.test.ts) (byte offsets with multi-byte text, the
fourth snapshot element only when something was rewritten, lexer and UTF-8 failures delivered unchanged
with one warning, the quota with rewrite costs and its atomicity),
[`src/lib/import-map.test.ts`](../src/lib/import-map.test.ts) (validation, merge order, ours win),
[`src/lib/in-sandbox-files.test.ts`](../src/lib/in-sandbox-files.test.ts) (the module blob from
slices, `read()` faithful, the map's JSON and its escaping),
[`src/lib/markup-references.test.ts`](../src/lib/markup-references.test.ts) (inline modules, import
maps taken out) and [`test/unit/files.test.ts`](../test/unit/files.test.ts) (no map without JavaScript
files, the gate, worker mode, the S2 hostile corpus with import maps and inline modules), and
[`test/e2e/files.spec.ts`](../test/e2e/files.spec.ts) section 9 on Chromium, Firefox and WebKit: a
graph across directories entered from markup and from an inline module, a shared module evaluated
once, a literal `import()`, `export * from`, the unsupported forms failing closed with no request, the
guest's map merged identically in every engine, no egress from a module graph (T5), and worker mode.

## Amendment: CSS references and srcset (2026-10-13)

**Status**: Accepted · **Date**: 2026-10-13 · implements next step 3

Registered stylesheets and the guest's inline styles name files the way they would on a server:
`background: url(../img/bg.svg)`, `@import "base.css"`, `src: url(fonts/f.woff2) format("woff2")`,
`image-set("a.png" 1x)`; and `<img srcset="logo.svg 1x">` picks a registered candidate.

### Why it needs a rewrite

A relative URL inside a `blob:` stylesheet resolves against the blob URL, whose path is opaque, so
`url(img.png)` and `@import "b.css"` name nothing (the probe's open risk, now measured: no request, no
violation). An inline `<style>` or `style=""` resolves against the guest's `about:blank` base (S15), with
the same result. And the targets are `blob:` URLs that exist only in the guest realm, minted while the
bootstrap runs, so the host cannot write them into the CSS: the host can only mark where they go, and
the guest fills them in. There is no CSS counterpart of the import map that could do it by name.

### Decision

1. **A CSS tokenizer on the host** ([`src/lib/css-references.ts`](../src/lib/css-references.ts)). It
   follows the tokenizer of CSS Syntax Level 3 — comments, strings with escapes and line continuations,
   ident sequences with escapes (`\75 rl(` is `url(`), numbers and dimensions (`10url(` is not),
   hash and at-keyword tokens, CDO/CDC, url tokens and bad-url remnants — in one linear pass that never
   throws. A reference is a url token, the string argument of `url(`, the first token of an `@import`
   prelude, or a string directly inside `image-set()` / `-webkit-image-set()`. Nothing in another
   at-rule's prelude counts (`@namespace url(…)` is a name, `@supports (…url(…)…)` a test), and no
   other string does (`content`, `format()`, `local()`, `type()`, selectors). Only complete tokens
   count: an unclosed string or url, a bad string and a bad url are left alone. The replacement is
   always a CSS string `"<blob: URL>"`: a url token's whole inside (`url( a.png )` → `url("…")`), or the
   string token, quotes included. A unit test re-tokenizes every rewrite, and 2000 random inputs, and
   finds the same references, each now that string.
2. **Stylesheets: references at registration, slots per build.** When `registerFiles()` stores a
   `text/css` file (by extension or override), it keeps every reference that, resolved against the
   file's own virtual URL `https://vfs.invalid/<path>` (the URL parser's rules, as in markup), names a
   valid path with no query or fragment, as a byte range and that path. Whether a file is registered
   there is decided per build, in `snapshot()`, since the store can change in between: each such
   reference becomes a slot, `[start, end, [path]]`, in the same fourth snapshot element as the module
   rewrite. The guest replaces the range with a CSS string holding that file's `blob:` URL, every
   character that could end the string escaped (`inSandboxFiles`). As for modules, `read()` and `text()`
   return the bytes as registered, `url()` the rewritten sheet, and `listFiles()` the registered size.
3. **Dependency order on the host, one pass in the guest.** A stylesheet's `blob:` can only be made
   once the URLs it names exist. The snapshot is in delivery order: files without slots first, in path
   order (so with no references between files it is the path order it was before), then each
   stylesheet after every file it names (a depth-first walk). The guest makes the blobs in literal
   order in one pass and looks each slot up among the files made so far; a slot naming a file not made
   yet keeps its registered bytes. It follows no reference, so it cannot loop, whatever the literal
   holds. `list()` now sorts, since the literal is no longer in path order.
4. **A reference cycle fails closed.** `a.css` imports `b.css` which imports `a.css`, or a stylesheet
   names itself: no order puts every file after the files it names. Every reference that lies on a
   cycle — every reference between two files of one strongly connected component (Tarjan), a
   self-reference included — is left as registered, and fails closed in the guest like any unresolvable
   relative URL; the cycle's other references, and references into it from outside, still resolve. One
   warning per distinct cycle per element. Breaking only one edge was rejected: which edge would depend
   on which file the guest links first, and the host does not know that; dropping every edge on a cycle
   gives the same result whatever the entry point.
5. **The quota counts what the slots add**, as for modules. Each reference that could name a file
   costs its path length plus 24 (two offsets and separators in the literal) plus 48 (the quoted
   `"blob:null/<UUID>"` that replaces it in the guest's sheet), counted at registration whether or not
   its target is registered, so a file's cost never depends on what else is in the store. The check
   stays atomic and two-step: registered bytes first, then tokenized and checked again, before any
   change. A sheet of nothing but `a{b:url(a)}` counts 84 bytes per 11-byte rule, so it is refused
   well before the literal or the guest's sheet could pass what the cap was measured at.
6. **Inline `<style>`, `style=""` and `srcset` are markup references** (the PR2 parse,
   [`src/lib/markup-references.ts`](../src/lib/markup-references.ts)), resolved against
   `https://vfs.invalid/index.html`, HTML-namespace elements only. The text of a `<style>` and the value
   of a `style` attribute go through the same tokenizer; a reference that names a registered file
   becomes a CSS string holding the sentinel, and its part says where it lands, `[path, 'css']` or
   `[path, 'css-attribute']`, so the bootstrap escapes the URL for a CSS string (and then for the
   attribute). `srcset` of `img` and `source` is split as the HTML standard does it
   ([`src/lib/srcset.ts`](../src/lib/srcset.ts): URLs are runs of non-whitespace, so a comma inside
   one belongs to it, trailing commas end it, descriptors run to a comma outside parentheses); each
   candidate URL that names a file gets an attribute slot, every other candidate and descriptor stays
   as written. Same gate as the other markup references, and no match still means the markup is
   embedded verbatim.
7. **No change to the policy.** A stylesheet already brings `blob:` into `style-src`; the images and
   fonts it names bring `blob:` into `img-src` and `font-src` by their own types, as for any file. A
   reference to a file whose type does not load there (a `.txt` used as an image) is refused by the
   policy, as before. Unit tests pin that a stylesheet with references gives the same policy as one
   without.

### Measured (`files.spec.ts` section 10)

Engines differ in how they report a reference left as written, never in the outcome: nothing loads
and nothing is requested.

| Left as written | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| `<link>` whose sheet has an unresolvable `@import` | `error` event | `load` event | `error` event |
| … its own rules | applied | applied | applied |
| … the `@import` rule's `styleSheet` | present, `cssRules` throws `SecurityError` | present, empty | `null` |
| `<img srcset>` whose only candidate cannot resolve | `error` event | no event | `error` event |

### Not supported (fail closed), each left as written

- A query or fragment (`url(bg.svg?v=2)`), another case or percent-encoding, an unregistered path:
  in a `blob:` sheet or an inline style they cannot resolve, so no request and no violation. A
  fragment-only `url(#f)` is left too (for `fill`, `filter` or `mask` it names an element of the
  document, not a file).
- URLs that only exist at run time: `url(var(--x))` (a bad url), `src()`, `attr()`, styles set from
  script (`element.style`, `CSSStyleSheet.replace()`, `insertRule()`). Use `sandboxFiles.url()`.
- Anything in an at-rule prelude other than `@import`'s; `imagesrcset` on `<link rel=preload>`;
  `<style>` and `style=""` on SVG elements; `<template>` contents.
- A stylesheet that is not UTF-8 is delivered unchanged, with one warning per registration.
- Worker mode gets the same snapshot, so a rewritten sheet holds worker-realm URLs: harmless, and of
  no use there.

### Alternatives considered

- **Regular expressions**: cannot tell `url(` in a comment or a string from a reference, decode
  escapes, or find where a url token ends; the tokenizer is what a browser runs.
- **A dependency** (`@csstools/css-tokenizer`, `css-tree`, PostCSS): the subset needed — references
  and the ranges to replace — is about 250 lines pinned by tests, and the context rules (what counts in
  which prelude, image-set) would still be ours. `@csstools/css-tokenizer` is the small, spec-conformant
  candidate if conformance ever matters more than size; not added.
- **Rewriting to virtual URLs plus a lookup, as for modules**: CSS has no import map; something would
  have to turn the virtual URL into a `blob:` URL, and only the guest's own bootstrap can.
- **Inlining imported sheets into one**: changes cascade layers, `@import` conditions and the
  CSSOM's shape, and grows with every import; slots keep each file a file.
- **Guest-side tokenizing**: would put the tokenizer into every guest bootstrap; the host tokenizes
  once, in a realm no guest code reaches.

### Costs

- **Bundle size**: the minified host build grows from 53.8 KB to 62.7 KB (18.6 KB to 21.5 KB
  gzipped); the published, unminified `dist/index.js` from 119.6 KB to 138.8 KB (25.0 KB to 28.8 KB
  gzipped).
- **Registration time**: tokenizing 8 MiB of CSS took about 0.13 s in Bun (`text/plain`: about 10 ms).
- **Per build**: the reference graph and its cycles are computed in `snapshot()`, linear in the
  references (about 20 ms for 65,000).

### Tests

[`src/lib/css-references.test.ts`](../src/lib/css-references.test.ts) (url tokens, escapes, bad urls,
unclosed tokens, comments, strings, dimensions and other look-alikes, `@import` forms, other at-rule
preludes, `@font-face` `src` lists, `image-set()`, malformed nesting, the re-tokenizing property on a
corpus and on random input, linear time), [`src/lib/srcset.test.ts`](../src/lib/srcset.test.ts)
(descriptors, commas inside URLs, trailing commas, empty candidates, offsets),
[`src/lib/files.test.ts`](../src/lib/files.test.ts) (slots resolved against the sheet's path, byte
offsets with multi-byte text and a byte order mark, what names no file, per-snapshot targets,
delivery order, cycles of one, two and three files with one warning each, a 999-file chain, the
quota), [`src/lib/in-sandbox-files.test.ts`](../src/lib/in-sandbox-files.test.ts) (slots filled from
earlier files only, CSS-string escaping, `list()` sorted),
[`src/lib/markup-references.test.ts`](../src/lib/markup-references.test.ts) (srcset, `<style>`,
`style=""`, what is left alone, the `<style>` extent),
[`test/unit/files.test.ts`](../test/unit/files.test.ts) (the literal's order and slots, the policy
unchanged, the cycle warning across rebuilds, the S2 hostile corpus with CSS and srcset slots) and
[`test/e2e/files.spec.ts`](../test/e2e/files.spec.ts) section 10 on Chromium, Firefox and WebKit: a
linked stylesheet's image and font, a two-level `@import` chain, an `@import` cycle and a
self-import failing closed while every other rule applies, inline `<style>` and `style=""`, `srcset`
on `img` and `picture`, misses failing closed with no request (T5: violations with positive
controls, load outcomes, the recorder silent), and no egress from a rewritten stylesheet.

## Amendment: strict mode (2026-10-13)

**When**: strict mode ([ADR-005](ADR-005-strict-mode.md)). Its view runs no guest script and its worker is a
classic script admitted by `worker-src blob:` alone, so files reach the two realms differently.

### Decision

- **The worker gets every file**, through `sandboxFiles` (`list`, `url`, `read`, `text`), from the same snapshot
  literal as worker mode. `url()` serves the worker's own `fetch()` (with `blob:` in `connect-src`).
- **The view gets the files that are not JavaScript.** Its bootstrap mints its own `blob:` URLs from them (the
  same `inSandboxFiles`, so stylesheet `url()` and `@import` slots are filled with the view's URLs). No
  JavaScript file is ever given to the view, and `blob:` is never added to `script-src` in strict mode
  (`addFileSources` takes an `exclude` option): nothing executable can come from a file.
- **Rendered markup names files by path.** The renderer resolves the reference attributes of default mode
  (`markup-references.ts`, the table itself, minus `<script src>`: `link[href]`, `img`, `source`, `video`,
  `audio`, `track` `src`, `video[poster]`) against `https://vfs.invalid/index.html`, by the same rules, and
  writes the view's URL in. A `<link>` survives only as a stylesheet or icon naming such a URL.
- **Only the view's own `blob:` URLs are kept** (A8). The renderer removes every attribute that holds any other
  `blob:` URL, however it is spelled (after removing the tabs and newlines the URL parser ignores). The worker
  cannot mint new ones: its prelude removes `URL.createObjectURL` after the file URLs exist, so the only
  `blob:` URLs in the origin are the library's, for registered files — which also bounds what CSS could name.
- **Classic only.** No module graph, no import map, no `importScripts` (refused by the hash-only
  `script-src`); the entry is a registered JavaScript file appended to the worker's source on the host.

### Not supported (fail closed)

`srcset`, `style=""` and `<style>` references (use a registered stylesheet, whose references are resolved),
references in `<template>` (removed), `<script src>` and modules (no script in the view), a `blob:` URL from
the worker's `sandboxFiles.url()` rendered into the view (removed).

### Tests

`test/e2e/strict.spec.ts` ("files"), on all three engines: an image and a stylesheet named by path load with
view-minted URLs and the stylesheet's own `url()` resolves; the view lists no JavaScript file; the worker
lists and reads every file; a worker-minted `blob:` URL, also obfuscated, is removed; the policy has `blob:`
for images and styles and never in `script-src`. Unit: `src/lib/in-sandbox-view.test.ts` (resolution, link
rules, `blob:` filtering), `src/lib/csp/file-sources.test.ts` (`exclude`), `test/unit/strict.test.ts`.

## Amendment (2026-10-14): `blob:` goes to the directive that governs the load

**When**: the follow-up audit of the adversarial review ([report](archive/reviews/ADVERSARIAL-REVIEW-2026-10.md#follow-up-2026-10-14-by-construction-audit)).
**Why**: decision 5 named `script-src` and `style-src`, but a browser checks `<script src>`, `import()` and
stylesheets against `script-src-elem` and `style-src-elem` first (CSP Level 3 fallback lists). An embedder who
configured either got every registered script or stylesheet refused, while the bootstrap check already read
`script-src-elem` (review A3): two answers to one question.
**Decision**: one fallback table (`src/lib/csp/effective-directive.ts`) answers which directive governs each kind
of check, and every consumer reads it: the bootstrap check, file sources (`blob:` goes to the governing directive;
where only `default-src` governs, the kind's own directive is created from its sources as before) and strict
mode, which asks only the directives its view will hold. A policy without `-elem` directives comes out
byte-identical (a 500-config property test against the previous implementation). Proof:
`src/lib/csp/file-sources.test.ts`, `test/e2e/review-policy.spec.ts` ("A3 class").

## Amendment: guest writes (2026-10-14)

**When**: backlog C5. **Why**: a guest could read its files but not produce any, and the section "Guest writes
in this step" above deferred it with a sketch (an `FS_WRITE` frame handled before the broker). The guarantee:
a guest changes files only when the embedder opted in, never past the host's path rules and cap, and nothing it
writes is kept, loaded or run until the host says so.

### Decision

- **One reserved broker method, `sandbox:write`, for writes and removals; not a raw frame.** The sketch put the
  write before the broker so that guest code could not replace it. That property now holds for every
  `sandbox:` name by construction ([ADR-002, reserved methods](ADR-002-host-guest-broker.md#amendment-2026-10-13-reserved-methods-and-library-codes)):
  `expose()` never registers one, on either side. And since the review's channel fixes (S21) guest code cannot
  post a frame of its own at all, so a raw frame would not be harder to forge than a call. What a raw frame would
  lack is everything the broker already does once: request/answer correlation (the guest's view changes only
  on the host's answer), a timeout, `TERMINATED` on teardown, the 256-calls-in-flight cap, the current-port
  check (review B4) and the clamp that lets only a reserved method report a library code. A second frame type
  would need a second copy of each. The guest calls the method through the broker's `callWithTimeout`
  captured by the bootstrap before guest code runs (like `sandboxFetch`), so replacing `bridge` or the port's
  prototypes changes nothing on that path. `PING` stays a raw frame for the opposite reason: it is answered in
  the guest, and answering at all is the signal.
- **The method is bound to the environment the request arrived in.** The host registers it again with each
  build, closed over that build's overlay; the broker looks a method up when a request arrives, and only the
  current port's frames arrive. So a request that runs after a listener rebuilt the sandbox goes to its own,
  closed, overlay, never to the next one.
- **`guestWrites: true` (only a literal `true`).** Off, `sandboxFiles.write()` and `remove()` still exist and
  reject `FILES_NOT_ALLOWED` without sending; the host's method refuses with the same code. The host's refusal
  is the guarantee, the guest's only saves the round trip.
- **One store chokepoint.** `FileStore.apply({ put, remove })` is the store's only mutation; `registerFiles()`,
  `unregisterFiles()` and the commit are wrappers. A write is checked by `CheckedFile.from()`, the same path and
  entry check, so its type is the one the store will load it as. At write time the quota is `FileStore.check()`
  of the store with every pending change and this write applied: the count and the registered bytes, which is
  `apply()`'s first step, without lexing. The commit is `apply()` itself, lexing included, against the store as
  it is then, so it can still be refused (`FILES_QUOTA_EXCEEDED`) if the host registered more meanwhile.
- **An overlay per environment, the host the single source of truth.** `Map<path, CheckedFile | removal>`,
  created by the build (null when off). A refused request changes nothing on either side; the guest's map
  changes only after the answer, in call order (a `Blob` is read first; every entry's bytes are copied when
  `write()` is called). A removal of a path in neither the store nor the overlay is answered `none` (the guest
  mints `NOT_FOUND`) and records nothing, so removal marks only ever name stored paths.
- **No URL for anything written.** `list()`, `read()` and `text()` show the guest's acknowledged writes;
  `url()` of a written path is `NOT_FOUND` in every mode, and no `blob:` URL is minted for one. The strict view
  never sees the overlay. So C1's guarantee, "the view renders no `blob:` content but registered files", holds
  with written files present, by construction: a written file reaches a URL only as a committed, registered
  file of a later build, which the view mints itself. *Amended 2026-10-15 (below): the view shows raster-image
  writes from URLs it mints itself, decoded only.*
- **Commit needs an explicit list, and code needs a second opt-in.** `commitGuestWrites(paths, options?)`;
  there is no commit-all and no discard (`reset()` discards). A write whose type is not on a fixed inert list —
  the image, font, audio and video types of the extension table without SVG, `text/plain`, `application/json`,
  `text/css`, exact strings — is refused unless `options.code === true`. JavaScript, HTML, SVG, XML,
  WebAssembly, unknown types and any type the guest set are code until the embedder says otherwise. The type
  checked is the `CheckedFile`'s, which is what decides how the file is loaded, never the file name.
- **Refusal code for a non-inert commit: `FILES_NOT_ALLOWED`, reused.** The code says "an opt-in is missing",
  the same meaning as for a write while `guestWrites` is off; the message names the path, its type and the flag.
  A separate code would only add a branch to the host's own call, and the host already knows every pending
  type from `listGuestWrites()`.
- **Codes.** `RpcLibraryCode` gains the file codes `INVALID_PATH`, `INVALID_FILE`, `FILES_QUOTA_EXCEEDED`,
  `FILES_NOT_ALLOWED`, `FILES_BUSY` (disjoint from both call-code groups; only the guest's broker accepts them,
  only from a reserved method). `FetchErrorCode` is now the `FETCH_*` subset. `NOT_FOUND` stays a guest code.
- **Rate.** Besides the broker's 256 calls in flight, at most `GUEST_WRITES_PER_SECOND` (100) requests are
  handled and `GUEST_WRITE_BYTES_PER_SECOND` (8 MiB) recorded per environment and second, refused with
  `FILES_BUSY`; the request count is taken first, refused requests included, and the byte rate after the quota.
  That also bounds `fileswritten`, one event per request that changed what `listGuestWrites()` shows at its path,
  dispatched last through `_notifyThenAct`: the guest's write is acknowledged only if no listener reset or terminated
  the sandbox meanwhile. The announcement and the strict view's copy are both derived from one diff of the overlay per
  request (`record()`): the list changed, or what the guest sees changed.
- **Lifecycle: one rule, builds discard and terminations keep.** The next build (`reset()`, `load()`,
  `setConfig()`) and the element's removal discard the overlay; `terminate()`, the watchdog and
  `workerExecutionTimeout` (a termination, ADR-003) keep it, closed: listable and committable, accepting
  nothing more. Not in v1: rename or move.

### Alternatives considered

- **The `FS_WRITE` frame of the original sketch**: see the first decision.
- **A URL for written files** (minting one in the guest): it would give the guest `blob:` content no build
  registered, in the view too (strict mode removes `URL.createObjectURL` for exactly that reason, A8).
- **An inert list by prefix (`image/*`) or by extension**: `image/svg+xml` is a document, a guest's type
  override can be any `type/subtype`, and a file name decides nothing about how a blob loads.
- **Commit everything, or a discard method**: an implicit "everything" commits what the embedder did not look
  at; discarding is what a rebuild already does.

### Tests

`src/lib/guest-writes.test.ts` (path corpus, entries, quota against store and overlay, removal marks, commit
subset and lexing, the inert list against the extension table, the rate with a fake clock),
`src/lib/files.test.ts` (`apply()` atomic, `check()`), `src/lib/in-sandbox-files.test.ts` and
`src/lib/in-sandbox-script.test.ts` (the guest side: view after the answer, `url()`, copies, call order, the
captured call), `src/lib/rpc.test.ts` (pinned codes), `test/unit/guest-writes.test.ts` (config, lifecycle,
B4, B5), `test/unit/strict.test.ts`, and `test/e2e/guest-writes.spec.ts` in iframe, worker and strict mode on
Chromium, Firefox and WebKit, with evidence read from the host page and the recorder.

## Amendment (2026-10-14): a reference names a file only for the kind of load its type is for

**When**: the focused review of 2026-10-14 ([report](archive/reviews/FOCUSED-REVIEW-2026-10-14.md), W1, W2, W3). **Why**: resolution ignored the load
kind. A guest-written `app.js` committed as `text/plain`, which is inert and needs no `{ code: true }`, became the
script of the next build's `<script src="app.js">`, and every engine runs a classic `blob:` script whatever its type
(measured: Chromium and Firefox every inert type, WebKit `text/plain`, JSON, CSS and fonts). The type the store gives
a file, which the inert list judges, did not decide how it was loaded.

**Decision**: one table, `src/lib/load-kinds.ts`, says which types each kind of load admits, and every place a
reference is resolved reads it, as does the policy:

| Kind | Admits | Loads | Directive |
| :--- | :--- | :--- | :--- |
| script | JavaScript types | `<script src>`, `modulepreload`, `preload as=script`, module imports | `script-src-elem` |
| style | `text/css` | stylesheet `<link>`, `preload as=style`, `@import` | `style-src-elem` |
| image | `image/*` | `img`, `srcset`, `poster`, icon links, CSS `url()` outside `@font-face`, `preload as=image` | `img-src` |
| font | `font/*` | `url()` in `@font-face`, `preload as=font` | `font-src` |
| media | `audio/*`, `video/*` | `audio`, `video`, `source src`, `preload as=audio\|video` | `media-src` |
| track | `text/vtt` | `track` | `media-src` |
| fetch | any | `preload as=fetch` (and `sandboxFiles.read()`) | `connect-src` |

- A reference to a registered file of a type its load does not admit is not a reference: it stays as written and
  fails closed, with one warning. A link with several loading relations must be admitted for each; a preload
  without a usable `as` names nothing.
- The chokepoints: `resolveReference(value, files, kinds)` for markup and inline CSS, `FileStore.snapshot()` for
  registered stylesheets (each CSS reference carries its kind from the tokenizer), the strict renderer (it gets the
  table as data), the import map and the strict entry (`isJavaScriptType`, the table's script row), and
  `kindsForTypes`, which gives a type `blob:` in exactly the directives of the loads that may name it. Admission
  and resolution cannot drift apart.
- **Host-registered files are bound by it too**: a host that registers `x.js` as `text/plain` gets a text file,
  never a script. That is a change for an embedder who relied on a mistyped script loading.
- **Limits**, stated: committed `text/css` is inert and still CSS, so it restyles markup of the next build that
  links it (it runs nothing; CSS cannot set attributes or run script). And code that passes `sandboxFiles.url()` to
  a script element or `importScripts()` itself chooses what it loads (measured: Chromium runs a `text/plain` file
  both ways; Firefox and WebKit refuse it in `importScripts()`): that is the running code's decision, not a
  reference the library resolves.

**And the guest-write rules (W2, W3)**: the rates hold in any one-second window (a sliding window shared with the
log limiter, `src/lib/rate-limit.ts`; the fixed windows let twice the limit through around a boundary), and a
removal mark whose path the host unregistered after the mark is forgotten before marks are listed or committed.

Tests: `src/lib/load-kinds.test.ts` (every kind × every type, for the table, markup, stylesheets and the renderer),
`test/unit/focused-review.test.ts` ("W1"–"W4"), `test/e2e/focused-review.spec.ts` ("W1", three engines).

## Amendment (2026-10-14): broad review: answers from the build; file sources widen only their kinds

**When**: the broad review of 2026-10-14 ([report](archive/reviews/BROAD-REVIEW-2026-10-14.md), CB4, PA1).

- **Guest writes are answered from the build (CB4).** `sandbox:write` answered removals and the write-time quota from
  the live store, so a guest learned of files the host registered after its build (which it never otherwise sees).
  Decision: each build takes one copy of the store (`FileStore.copy()`); its snapshot is what the guest gets, and the
  overlay decides every answer against that copy plus the overlay. The commit still applies to the live store with
  its full check, so the host's side is unchanged.
- **File sources widen only the kinds they are for (PA1).** `blob:` added to `script-src` for registered scripts
  (or a `script-src` created from `default-src`) also reached `worker-src` through its fallback when the policy set
  neither `worker-src` nor `child-src`. Decision, the class: every policy step ends with one postcondition
  (`assertWidensOnly`, `effective-directive.ts`): for every kind of check outside those the step names, the sources
  that decide it after the step are a subset of those before; a step that would widen another kind throws and the
  build fails closed. File sources pin such a kind to what it admitted before, in a directive of its own, before the
  check. A property test over random policies and file types holds it with an oracle written out independently.
- **No worker loads from `data:` (PD1)**: a policy step of its own (`drop-data-workers.ts`), under the same
  postcondition; the default `worker-src` is `blob:` alone.

Proof: `test/unit/broad-review.test.ts` ("CB4", "PA1", "PD1"), `src/lib/csp/drop-data-workers.test.ts`,
`src/lib/csp/file-sources.test.ts`, `test/e2e/broad-review.spec.ts` ("PD1").

## Amendment (2026-10-14): typed origins: file sources are the generator's

**When**: [ADR-007](ADR-007-typed-origins.md). **What changed**: the guest policy is a fixed template per mode, and
`file-sources.ts`, the fallback table it read (`effective-directive.ts`) and the postcondition after it
(`assertWidensOnly`) are deleted. The generator (`src/lib/csp/csp-generator.ts`, `fileKinds()`) adds `blob:` to the
directive of each kind of load the build's registered types are for, read from the same load-kind table
(`load-kinds.ts`, whose rows now carry their `origins` key; `track` is `media`): JavaScript `script-src`, `text/css`
`style-src`, `image/*` `img-src`, `font/*` `font-src`, `audio/*`, `video/*` and `text/vtt` `media-src`, every file
`connect-src`. Every directive is explicit, so nothing falls back and `blob:` for one kind can reach no other (PA1 holds
by construction, and a property test over random origins and file types says so). Strict mode never adds it to
`script-src`. An embedder can no longer set a directive to `'none'` to keep a registered type from loading: an empty
kind admits no origin, and the files registered are what the embedder chose to give the guest.

## Amendment (2026-10-15): the strict view shows raster-image guest writes

**When**: the owner's decision on [review round 1](archive/reviews/REVIEW-ROUND-1-2026-10-15.md)'s R4-4; backlog S54.
**Why**: "No URL for anything written" (the guest-writes amendment above) left a strict plugin no way to show an image it
made, such as a chart drawn on an `OffscreenCanvas`: it could write the PNG but not name it in a render until the host
committed it and rebuilt.

**Decision**: the strict view shows the guest's pending or committed writes whose store type is a raster image, by path,
in the same environment. It replaces the guest-writes amendment's "the strict view never sees the overlay" for those types.

- **One chokepoint, one constant.** `VIEW_WRITE_TYPES` (`src/lib/in-sandbox-view.ts`) is `VIEW_FILE_TYPES` ∩
  `RASTER_IMAGE_TYPES`: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`. Never `image/svg+xml` or any
  other type: a raster image opened on its own is an image, never a document. The view checks it before it mints
  (`showWrite`); the host reads the same constant only to decide whether to send the bytes at all.
- **The URL is the view's, made from the bytes the host holds.** When the element records a write or a removal in strict
  mode, it posts `VIEW_WRITE { id, path, mime, bytes }` on the view port: the store type and, for those types only, a copy
  of the recorded bytes, transferred. The guest never supplies a URL or a type the store did not give, and its worker
  still cannot mint one (`sandboxFiles.url()` of a written path stays `NOT_FOUND`).
- **Decoded only.** The view's load kinds admit these types for image loads alone (`img`, `poster`, icon links; the
  renderer's table), so a written PNG named by `<video>`, a stylesheet `<link>` or `<track>` stays as written. With
  `guestWrites`, the view's `img-src` gains `blob:`.
- **The path resolves as the guest's own `sandboxFiles` lists it.** A later write replaces the URL and revokes the old
  one; a removal, or a write of another type, revokes it and leaves the path naming nothing (a registered file the guest
  replaced or removed included). A revoked URL is no longer the view's, so markup naming it keeps no `src` (A8). A
  rebuild starts from the registered files.
- **Ordered by construction.** The view answers `VIEW_WRITTEN { id }` once it holds the change, and only then is the
  guest's `write()` answered: a render after `await sandboxFiles.write()` finds the URL, whatever the order of two
  ports would be. A teardown before the answer ends the wait. The overlay's caps (bytes, rate, quota) bound what the
  view holds.

**C1's guarantee, as widened**: the view renders no `blob:` content but registered files and raster-image guest
writes, decoded only.

Tests: `test/unit/owner-decisions.test.ts` ("R4-4": the type set, the host-to-view transfer and its wait, minting,
replacement and revocation, the policy), `test/e2e/owner-decisions.spec.ts` ("R4-4", three engines: an
`OffscreenCanvas` PNG by its natural size read from outside, replace and remove, SVG, HTML and JavaScript writes that
do not resolve beside a PNG that does, the recorder silent but for its control), `test/e2e/guest-writes.spec.ts` ("8").
