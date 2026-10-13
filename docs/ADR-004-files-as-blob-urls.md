# ADR-004: Files are guest-realm blob URLs

**Status**: Accepted · **Date**: 2026-10-13

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

The [blob delivery probe](research/blob-delivery-probe.md) measured the replacement before it was
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
   `media-src`, and any file → `connect-src`. An empty directive falls back to `default-src`, so
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
[`src/lib/csp/file-sources.ts`](../src/lib/csp/file-sources.ts) (the policy). The proof is their unit
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
next environment runs.

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

- **Guest markup names files only through the attributes listed in the amendments below**
  (2026-10-13): `srcset`, CSS `url()` and `<template>` contents do not resolve yet; guest code uses
  `sandboxFiles.url()` for those. Relative imports between modules resolve since the module graph
  amendment, with the limits listed there.
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
3. **CSS**: `url()` and `@import` inside registered stylesheets, and `srcset`.

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

`srcset` and CSS `url()` in `<style>` or `style=""` (next step 3); relative imports inside a module
(next step 2, done in the module graph amendment below); `<template>`
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
- **CSS** `url()` and `@import` inside registered stylesheets: next step 3.

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
