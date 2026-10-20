# ADR-004: Files are guest-realm blob URLs

**Status**: Accepted · **Date**: 2026-10-13

## Context

The host registers files, and guest code loads them. The guest is a sandboxed `srcdoc` document with an opaque origin,
nested in an opaque wrapper, under a host page. It is never a client of a Service Worker: a Service Worker handles
navigations in its scope and subresource requests from clients it controls, and the guest can neither be controlled by
one nor register one of its own ([research 02](research/02_sw_tampering/README.md)). So files cannot be served to it by
a worker; they have to be made in the guest's own realm.

The [blob delivery probe](archive/research/blob-delivery-probe.md) measured this before it was built: what each engine
loads from a `blob:` URL, under which directive, with which MIME type, and which realms a `blob:` URL resolves in.

| Need | What provides it |
| :--- | :--- |
| The guest can list, read and address files | `sandboxFiles` in every environment |
| Binary content keeps its type | a MIME table that is never empty, and a type override |
| The store is bounded and released | a cap, and a lifecycle that follows the environment |
| Nothing the guest can read addresses another sandbox's files (S3) | no session id, no host origin, no `<base>` in the guest document |

## Decision

1. **Files are part of the environment.** The element keeps a store: `registerFiles(files)` merges,
   `unregisterFiles(paths?)` removes (all without an argument), `listFiles()` returns `{ path, type, size }`. The store
   survives `reset()`, `load()`, `setConfig()` and `terminate()`. Every environment build takes one snapshot of it; a
   frame that is already running never changes. `fileschanged` fires synchronously with `{ paths }`, once per call that
   changed something.
2. **One literal, guest-realm blobs, before any markup.** The snapshot is embedded in the bootstrap as one inline
   literal, `[[path, type, base64, edits?], ...]` (`edits` only for a file whose references are rewritten, below). The
   bootstrap decodes each entry, creates a `Blob` with its type and a `blob:` URL in the guest's own realm,
   synchronously, before the parser reaches guest markup. The guest gets `sandboxFiles.list()`, `url(path)`,
   `read(path)` and `text(path)`. In worker mode the same literal goes into the worker's source, and the worker builds
   its own blobs and its own `sandboxFiles`, so `importScripts`, `fetch` and `read()` work there.
3. **Paths are validated, never normalised.** A path is accepted only if it is 1–256 characters of non-empty segments
   made of `[A-Za-z0-9._~!$&'()*+,;=@-]`, with no `.` or `..` segment, and `new URL(p, 'https://vfs.invalid/')` keeps it
   unchanged. So `%`, `\`, `:`, `?`, `#`, whitespace, controls and non-ASCII are refused, as are leading, trailing and
   doubled slashes. The guest's lookup is an exact `Map` lookup of the string it passes: anything else — missing,
   traversal, encoded, absolute, another instance's path, a non-string — is `NOT_FOUND`.
4. **A MIME table that is never empty.** 35 extensions map case-insensitively to a type; anything else is
   `application/octet-stream`. Never the empty type: every engine applies a typeless blob as a stylesheet.
   `{ content, type }` overrides the type with a `type/subtype` token.
5. **`blob:` only where a registered type loads.** The guest policy gains `blob:` only for the files registered in a
   build, and only in the directive of each kind of load their types are for: JavaScript → `script-src`, `text/css` →
   `style-src`, `image/*` → `img-src`, `font/*` → `font-src`, `audio/*`, `video/*` and `text/vtt` → `media-src`, and any
   file → `connect-src`. The policy generator reads the one load-kind table below; every directive is explicit, so
   nothing falls back and `blob:` for one kind reaches no other ([ADR-007](ADR-007-typed-origins.md)). An embedder cannot
   set a directive to `'none'` to keep a registered type from loading: the files registered are what the embedder chose
   to give the guest, and to keep a file out, it is not registered. `base-uri` is always `'none'` (S9).
6. **Refusals carry a code.** `registerFiles()` throws `INVALID_PATH`, `INVALID_FILE` or `FILES_QUOTA_EXCEEDED`,
   `unregisterFiles()` throws `INVALID_PATH`; the guest's lookups throw or reject with `NOT_FOUND`, minted in the guest,
   with a message that names nothing but the code. All are plain `Error`s with an own `code` (the shape of
   [ADR-002](ADR-002-host-guest-broker.md)'s refusals). They are not `RpcErrorCode`: no broker is involved. Each batch is
   validated whole against the store it would produce before anything changes.
7. **A cap.** 8 MiB in total, at most 1000 files, paths of at most 256 characters: module constants
   (`MAX_TOTAL_BYTES`, `MAX_FILES`, `MAX_PATH_LENGTH`), not configuration. Raise one only after `files.spec.ts` passes at
   the new value in all three engines. Time to `ready` and memory grow with size: memory is about 3–3.5× the file bytes
   across host and guest (the host's base64, the srcdoc string, the guest's blobs). Example, measured when the cap was set
   (2026-10-13; Chromium 141, Firefox 146, WebKit 26): 8 MiB loaded byte-exact in both modes, time to `ready` about
   0.5–1.6 s.
8. **The API always exists; the policy changes only with files.** `sandboxFiles` is installed in every environment, in
   every mode. With nothing registered, `list()` is empty and every lookup is `NOT_FOUND`, so guest code never meets a
   `ReferenceError` that depends on host state. The policy with no files has no `blob:` beyond `worker-src`, and the
   guest document differs only by the empty files bootstrap, still inside the security block after the CSP meta (S2).

`virtualFilesUrl` is not an option: a config that passes it gets one warning per element and the field is dropped.

The mechanism lives in [`src/lib/files.ts`](../src/lib/files.ts) (store, paths, MIME),
[`src/lib/in-sandbox-files.ts`](../src/lib/in-sandbox-files.ts) (the guest side) and
[`src/lib/csp/csp-generator.ts`](../src/lib/csp/csp-generator.ts) (the policy). The proof is their unit tests,
[`test/unit/files.test.ts`](../test/unit/files.test.ts) (the host's output, including the no-files policy and document) and
[`test/e2e/files.spec.ts`](../test/e2e/files.spec.ts) (every load type, containment, isolation between sandboxes, no
egress, lifecycle, worker mode and the cap, on Chromium, Firefox and WebKit).

### What a reference may name: one table of load kinds

A registered file reaches the guest as a `blob:` URL typed by the store, and the browser decides what a load of it
does. For one kind it decides nothing: Chromium, Firefox and WebKit run a parser-inserted `<script src="blob:…">`
whatever the blob's type. So the library decides, at the one place every reference is resolved: a reference names a
file only when the file's type is admitted for the kind of load the referencing element or rule makes
(`src/lib/load-kinds.ts`).

| Kind | Admits | Loads | Directive |
| :--- | :--- | :--- | :--- |
| script | JavaScript types | `<script src>`, `modulepreload`, `preload as=script`, module imports | `script-src` |
| style | `text/css` | stylesheet `<link>`, `preload as=style`, `@import` | `style-src` |
| image | `image/*` | `img`, `srcset`, `poster`, icon links, CSS `url()` outside `@font-face`, `preload as=image` | `img-src` |
| font | `font/*` | `url()` in `@font-face`, `preload as=font` | `font-src` |
| media | `audio/*`, `video/*` | `audio`, `video`, `source src`, `preload as=audio\|video` | `media-src` |
| track | `text/vtt` | `track` | `media-src` |
| fetch | any | `preload as=fetch` (and `sandboxFiles.read()`) | `connect-src` |

- A reference to a registered file of a type its load does not admit is not a reference: it stays as written and fails
  closed, with one warning. A link with several loading relations must be admitted for each; a preload without a usable
  `as` names nothing.
- The chokepoints: `resolveReference(value, files, kinds)` for markup and inline CSS, `FileStore.snapshot()` for
  registered stylesheets (each CSS reference carries its kind from the tokenizer), the strict renderer (it gets the table
  as data), the import map and the strict entry (`isJavaScriptType`, the table's script row), and `fileKinds()`, which
  gives a type `blob:` in exactly the directives of the loads that may name it. Admission and resolution cannot drift
  apart.
- **Host-registered files are bound by it too**: a host that registers `x.js` as `text/plain` gets a text file, never a
  script.
- **Limits**: committed `text/css` is inert and still CSS, so it restyles markup of the next build that links it (it
  runs nothing; CSS cannot set attributes or run script). And code that passes `sandboxFiles.url()` to a script element
  or `importScripts()` itself chooses what it loads (Chromium runs a `text/plain` file both ways; Firefox and WebKit
  refuse it in `importScripts()`): that is the running code's decision, not a reference the library resolves.

Tests: `src/lib/load-kinds.test.ts` (every kind × every type, for the table, markup, stylesheets and the renderer),
`test/unit/focused-review.test.ts`, `test/e2e/focused-review.spec.ts`.

## Markup references

Guest markup can name a registered file the way a page names a file next to it on a server: `<script src="app.js">`,
`<link rel="stylesheet" href="./style.css">`, `<img src="/img/logo.svg">`.

1. **The host resolves, the guest parses.** Before the frame exists, the host parses the guest markup with `DOMParser`
   (in the host window) and resolves these attributes against the virtual document URL `https://vfs.invalid/index.html`:
   `script[src]`; `link[href]` when a `rel` token is `stylesheet`, `icon`, `preload` or `modulepreload`; `src` of `img`,
   `source`, `video`, `audio` and `track`; `video[poster]`. Only elements in the HTML namespace count. An attribute whose
   resolved URL is `https://vfs.invalid/` plus a registered path, exactly, and whose file the reference's load admits,
   becomes a sentinel `vfs-slot-<nonce>-<index>`, with a 128-bit nonce drawn per build. The document is serialised and cut
   at the sentinels into parts, `[markup, path, markup, …, markup]`
   ([`src/lib/markup-references.ts`](../src/lib/markup-references.ts)).
2. **The bootstrap writes the markup.** The parts are one more inline literal. After the blobs exist, the bootstrap's
   last statement joins the parts with the guest's own `blob:` URLs (escaped for the double-quoted attribute they land in)
   and calls `document.write()` once (`inSandboxMarkup` in
   [`src/lib/in-sandbox-files.ts`](../src/lib/in-sandbox-files.ts)). It uses the object `inSandboxFiles` returned, not the
   `sandboxFiles` global. The guest document then ends with the bootstrap script: nothing of ours follows it, so what it
   writes is the rest of the document.
3. **No match, no change.** If no attribute names a registered file, the guest document is built exactly as before: the
   original markup, verbatim, after the security block. A test pins the document byte for byte. The rewrite also stays
   off when the bootstrap cannot run — no `allow-scripts` — since then nothing would write the markup.
4. **Worker mode has no markup**, so nothing is rewritten there.

**Why this works.**

- **Parser order is the parser's.** `document.write()` from a parser-inserted script puts the markup into the parser's
  input right after that script. The guest's own parser parses it, so its scripts are parser-inserted: sync scripts
  block in order, `defer` and module scripts run after parsing in document order, `async` runs when loaded,
  `document.currentScript` is set, and a stylesheet blocks the next script. `files.spec.ts` section 8 asserts each of
  these in all three engines.
- **The policy stays first (S2).** The CSP `<meta>` is the first element of `<head>`, the bootstrap follows it, and the
  written markup comes after both. The guest markup travels inside a JSON string literal with `<` escaped, so it cannot
  end the bootstrap script, open a comment, or come before the policy.
- **Nothing the guest writes reaches the bootstrap.** The markup is data in a literal; no guest code has run when the
  write happens; and the URLs come from the bootstrap's own lookup. The nonce exists only on the host, for one build,
  and never reaches the guest. A forged sentinel would need it, and even then a slot index names only a path in this
  build's snapshot: the guest's own file, whose URL it can already get from `sandboxFiles.url()`.
- **Parsing untrusted markup on the host is inert.** A `DOMParser` document has no browsing context and scripting is
  disabled in it: no script runs, no event handler fires, and nothing is fetched. A unit test asserts that inline
  scripts and `onerror` handlers in the parsed markup never run.

**Resolution rules.**

- Resolution is the URL parser's, as a browser would do it against a page served at the root of the files: `logo.svg`,
  `./logo.svg`, `/logo.svg`, `img/../logo.svg`, `%2e%2e/logo.svg` (a dot segment by the URL standard), `img\logo.svg` and
  `https://vfs.invalid/logo.svg` all name `logo.svg`. Nothing resolves above the root.
- The resolved path must equal a registered path exactly. Since registered paths are the ones the URL parser keeps
  unchanged, another case or any other percent-encoding names nothing.
- **A query or a fragment, even an empty one, names nothing** (`logo.svg?v=2`, `logo.svg#x`): fail closed rather than
  strip. A `blob:` URL cannot carry a query (it would name no blob), so stripping it would silently change what the
  markup asked for.
- An empty or blank value never names a file, though it would resolve to `index.html`: a browser does not load `src=""`
  as the document either.
- **Everything not matched stays as written and fails closed.** The guest's base URL is the wrapper's `about:blank`
  (S15), so a relative URL cannot be resolved there: the load fails with no request and no violation. An absolute URL
  that names no registered file is refused by the policy. `files.spec.ts` asserts both, with a refused absolute URL as
  the positive control for the violation channel and a matched reference as the positive control for the outcome
  channel (T5).

**Where the markup lands.** Embedded markup is parsed after our `</head>`; written markup is parsed while the parser is
still in our `<head>`. The difference does not show, because the host serialises a whole document: the written markup
starts with `<html>` (its attributes merge onto ours), then its own `<head>` (ignored) with the head content, then
`</head>` and `<body>`, so the parser leaves the head before any body content, exactly where embedded markup would have
put it. Full documents work: `<!DOCTYPE html><html lang="en"><head>…</head><body class="…">…` keeps its `lang`, title,
head elements and body attributes.

**Re-serialisation fidelity.** When at least one reference matched, the markup the guest parses is the host's
serialisation of the parsed tree, not the original text. The guest's parser would build the same tree from either, so the
differences are in form: quoting and case of tags and attributes, implied and closing tags made explicit (`<tbody>`,
`</p>`), character references normalised, the doctype dropped (ours comes first, and a later one is ignored anyway).
Known differences in content:

- matched attributes hold the `blob:` URL, so `getAttribute('src')` and `document.currentScript.src` read `blob:null/…`,
  not `app.js`;
- `<noscript>` content is parsed as elements (scripting is off in a `DOMParser` document) and serialised back; the guest
  still reads it as raw text;
- markup that does not survive an HTML round trip unchanged (some misnested or foster-parented constructs, the cases
  mutation-XSS research collects) can parse to a slightly different tree. That changes only the guest's own document: the
  markup stays inside a string literal until the write, and the guest gains nothing it could not write itself.

Markup with no matched reference is never re-serialised.

**Not supported (fail closed), each left as written**: `<template>` contents; `<iframe>`, `<embed>`, `<object>`,
`<a href>`, `<form action>`, `<input type="image">` and SVG elements; `rel` values outside the list. `load()` takes
markup: a registered `index.html` is a file like any other, not the guest's markup.

**Alternatives considered.**

- **A guest `<base href="https://vfs.invalid/">`**: import maps do not apply to a module script's `src`, so modules would
  still need rewriting; it needs `base-uri` loosened, undoing S9; and a base turns every unmatched relative URL into a
  real request that only the policy stops, where today it is no request at all.
- **A `MutationObserver` that swaps URLs as elements appear**: the parser may start a fetch, or run a script, before the
  observer's callback runs; it races by design.
- **Inlining file contents into the markup**: inline scripts and styles behave differently, and a module has no URL.
- **A guest-side `DOMParser`**: the markup would still have to arrive as data in a literal, so it gains nothing over the
  host parse, and it would put a parser step into every guest bootstrap. The host parses once, in a realm no guest code
  ever reaches.
- **A second, separate script after `</head>` that writes the markup**: it would have to find the URLs through a global
  the first script left behind. One script, ending in the write, keeps the lookup private.

Tests: [`src/lib/markup-references.test.ts`](../src/lib/markup-references.test.ts) (resolution corpus, each element and
attribute, what is left alone, sentinels and nonces, re-serialisation, the inline-script check),
[`test/unit/files.test.ts`](../test/unit/files.test.ts) (the no-match document byte for byte, the matched document exactly,
the conditions that keep markup verbatim, a nonce per build, the S2 hostile corpus with matched references, before and
after the write) and [`test/e2e/files.spec.ts`](../test/e2e/files.spec.ts) section 8 (parser order and `currentScript` for
sync, inline, `defer`, module and `async` scripts, a stylesheet applied before the next script and by
`DOMContentLoaded`, images by relative, `./` and `/` paths, the policy still first; fragment placement equal to the
verbatim path; fail closed with no request), on Chromium, Firefox and WebKit.

## The module graph

Registered modules import each other the way they would on a server: `import { a } from './lib/a.js'`,
`export * from '../shared/b.js'`, `import('/lazy.js')`, from a file named by `<script type="module" src="main.js">` or
from an inline module in the guest markup.

**Why it needs a rewrite.** A relative specifier never resolves inside a `blob:` module. Its base URL is the blob URL,
whose path is opaque, so `./x.js`, `../x.js` and `/x.js` throw a `TypeError` in every engine, and they do so **before**
any import map is consulted: an import map maps the resolved URL (or a bare specifier), and here there is no resolved
URL (probe, section 3). The guest's base is `about:blank` (S15), and Firefox and WebKit then match a literal `./x.js`
key; Chromium does not. Only a specifier rewritten to a full URL resolves in all three engines.

1. **Rewrite at registration, on the host, JavaScript only.** When `registerFiles()` stores a file whose type is
   JavaScript (`text/javascript`, `application/javascript`, `text/ecmascript`, `application/ecmascript`, from the
   extension or an override), es-module-lexer finds its import specifiers. Each relative one (`./`, `../`, `/`) in a
   static `import`, `export … from`, `export * from`, a side-effect `import '…'`, a source or defer phase import, and in
   `import()` whose argument is a string literal (or a template literal without substitutions) is replaced, quotes
   included, by `JSON.stringify(new URL(specifier, 'https://vfs.invalid/' + path).href)`
   ([`src/lib/module-specifiers.ts`](../src/lib/module-specifiers.ts)). Resolution is the URL parser's: `..` above the
   root stays at the root. A specifier that would resolve outside `https://vfs.invalid/` (`//host/x.js`, `/\host/x.js`) is
   left as written, as are bare specifiers and full URLs: the import map and the policy decide those.
2. **`read()` is faithful; the module graph uses the rewrite.** The store keeps the bytes as registered and the rewrite as
   byte-range edits. The snapshot entry of a rewritten file gains a fourth element, `[start, end, text, …]` over the
   registered bytes, and the guest builds the module blob from slices of the registered blob and those texts, so the
   literal carries the file once. `url(path)` names the module form (what markup references and the import map use);
   `read()` and `text()` return the bytes as registered; `listFiles()` reports the registered size.
3. **The quota counts what the literal carries.** A rewritten file costs its registered bytes plus, per rewritten
   specifier, the replacement's length plus 24 (two offsets and the separators). So the snapshot literal never grows past
   what the 8 MiB cap was measured at, even for a file that is nothing but imports. The check stays atomic: the
   registered bytes are checked first, so an oversized batch is refused before any lexing, then the batch is lexed and
   checked again, all before the store changes.
4. **Exactly one import map, registered by the bootstrap.** After the blobs exist and before the markup is written, a
   bootstrap step (`inSandboxImportMap` in [`src/lib/in-sandbox-files.ts`](../src/lib/in-sandbox-files.ts)) builds
   `{ imports: { 'https://vfs.invalid/<path>': <blob URL> } }` for every registered JavaScript file, inserts it as a
   `<script type="importmap">` through the DOM, and removes the element again: an inline import map is registered when it
   is inserted, so the guest's document is left as it was. Its text never passes through the HTML parser, and every `<` in
   the JSON is escaped anyway. The value is the very URL `url(path)` returns and markup references use, and the module map
   is keyed by URL, so a module reached both from markup (by `blob:` URL) and through the map (by virtual URL) is one
   module, evaluated once.
5. **Inline module scripts in the markup are rewritten too**, against the virtual document URL
   `https://vfs.invalid/index.html`, as markup references are resolved. An inline module whose specifier to replace
   contains `<` or `>` is left as written: those characters decide where the HTML tokenizer ends a script (`<!--`, `-->`,
   `<script`), so replacing them could move the script's end when the markup is parsed again.
6. **The guest's own import maps are merged into ours** ([`src/lib/import-map.ts`](../src/lib/import-map.ts)). Firefox
   honours only the first import map of a document, Chromium and WebKit merge later ones, so a guest map left in the
   markup after ours would apply in two engines and not in the third. Its inline `<script type="importmap">` elements are
   taken out of the markup by the host's parse; each must be valid JSON in the import-map shape (else it is left out, with
   a warning); several merge in document order, the earlier entry winning; and every guest key that could match a URL in
   `https://vfs.invalid/` (inside it, or a prefix such as `https://`) is dropped with a warning, in `imports` and in every
   scope: that origin names registered files, and only the host maps it. The merged map travels as one more JSON string in
   the bootstrap literal. With no JavaScript file registered, nothing changes: a guest import map stays in the markup as
   written.
7. **Same gate as markup references.** The map is an inline script, and the bootstrap is what registers it: with no
   `allow-scripts` there is no map, no markup change, and relative imports fail closed. `script-src` already gains
   `blob:` for JavaScript files (decision 5).
8. **Failures pass the file through.** A JavaScript file that is not UTF-8 or that the lexer cannot parse is stored
   unchanged, with one warning per registration of that file; its relative imports then fail closed. An inline module the
   lexer cannot parse is left as written, with one warning per element.

**Why es-module-lexer, and why its `/js` build.**

- **There is no native module lexer.** Browsers expose no API that lists a module's imports without loading it, and
  `import.meta.resolve()` resolves against the module's own `blob:` URL, so it throws for the same reason the import does.
- **An import map cannot rescue a relative specifier in a `blob:` module**: resolution against the `blob:` base fails
  before the map is consulted. The rewrite has to change the source.
- **Bun's scanner (`Bun.Transpiler.scanImports`) exists only in the Bun runtime.** The rewrite runs in the embedder's
  browser, at `registerFiles()`.
- **A regular expression cannot tell an import from import-like text** in strings, comments, regular expression literals
  and template literals; a JavaScript tokenizer, with the division/regex ambiguity and nested templates, is what
  es-module-lexer is. It is the lexer Vite and Vitest use.
- **The `/js` build** (`es-module-lexer/js`, the asm.js build) is plain JavaScript: `parse()` is synchronous, there is no
  `init()` and no WebAssembly, so `registerFiles()` stays synchronous and the host page never needs `'wasm-unsafe-eval'`
  in its own policy. The default build compiles WebAssembly and must be awaited first.
- **Bundled, pinned, with its notice.** It is a dev dependency pinned at 1.7.0 and compiled into `dist/index.js` by the
  library build, so consumers install nothing (the packed `package.json` has no `dependencies`). Its MIT licence ships as
  [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md), which is in the package's `files`, and a `/*! … */` notice comment
  that the bundle keeps.

**Not supported (fail closed).**

- **Computed `import(expr)`**: not rewritten; a relative value throws a `TypeError` against the `blob:` base, with no
  request.
- **`new URL('./x', import.meta.url)`** (the pattern bundlers use for assets and workers): `import.meta.url` is
  `blob:null/<uuid>`, and resolving against it throws. Use `sandboxFiles.url()`.
- **A relative import of an unregistered file, or with a query or fragment**: rewritten to a virtual URL that is not in
  the map, so the browser asks for `https://vfs.invalid/…`, which the policy refuses with a violation. Nothing leaves
  (`.invalid` never resolves either).
- **Module workers**: Chromium cannot start one from a guest `blob:` URL, and the document's import map does not apply in
  workers in any engine, so rewritten imports fail there.
- **Worker mode is classic only.** The worker gets the same snapshot, so `url()` names the module form and `read()` the
  registered bytes, but there is no import map: `importScripts()` and `import()` of a module without relative imports
  work, and a rewritten graph fails closed.
- **A guest map entry for the virtual origin**, and a bare specifier mapped to a virtual URL (import maps do not chain:
  the virtual URL would be fetched, and refused). A guest map can map bare specifiers to allowlisted URLs.

**Costs.** The lexer adds about 20 KB of minified JavaScript to the host build. Registration lexes the JavaScript it
stores, which takes a fraction of a second for the cap's worth of source (measured in Bun, 2026-10-13: 5–8 MiB in 0.1–0.2
s; the same bytes as `text/plain` take under 10 ms). The lexer keeps its working buffer, sized for the largest source it
has lexed, for the life of the page.

Tests: [`src/lib/module-specifiers.test.ts`](../src/lib/module-specifiers.test.ts) (every import form, import-like text
in strings, comments, regular expressions and templates left alone, computed `import()` and `import.meta` untouched, `..`
clamped, scheme-relative specifiers left, the byte order mark), [`src/lib/files.test.ts`](../src/lib/files.test.ts) (byte
offsets with multi-byte text, the fourth snapshot element only when something was rewritten, lexer and UTF-8 failures
delivered unchanged with one warning, the quota with rewrite costs and its atomicity),
[`src/lib/import-map.test.ts`](../src/lib/import-map.test.ts) (validation, merge order, ours win),
[`src/lib/in-sandbox-files.test.ts`](../src/lib/in-sandbox-files.test.ts) (the module blob from slices, `read()`
faithful, the map's JSON and its escaping), [`src/lib/markup-references.test.ts`](../src/lib/markup-references.test.ts)
(inline modules, import maps taken out) and [`test/unit/files.test.ts`](../test/unit/files.test.ts) (no map without
JavaScript files, the gate, worker mode, the S2 hostile corpus with import maps and inline modules), and
[`test/e2e/files.spec.ts`](../test/e2e/files.spec.ts) section 9 on Chromium, Firefox and WebKit: a graph across
directories entered from markup and from an inline module, a shared module evaluated once, a literal `import()`,
`export * from`, the unsupported forms failing closed with no request, the guest's map merged identically in every
engine, no egress from a module graph (T5), and worker mode.

## CSS references and `srcset`

Registered stylesheets and the guest's inline styles name files the way they would on a server:
`background: url(../img/bg.svg)`, `@import "base.css"`, `src: url(fonts/f.woff2) format("woff2")`,
`image-set("a.png" 1x)`; and `<img srcset="logo.svg 1x">` picks a registered candidate.

**Why it needs a rewrite.** A relative URL inside a `blob:` stylesheet resolves against the blob URL, whose path is
opaque, so `url(img.png)` and `@import "b.css"` name nothing (no request, no violation). An inline `<style>` or `style=""`
resolves against the guest's `about:blank` base (S15), with the same result. And the targets are `blob:` URLs that exist
only in the guest realm, minted while the bootstrap runs, so the host cannot write them into the CSS: the host can only
mark where they go, and the guest fills them in. There is no CSS counterpart of the import map that could do it by name.

1. **A CSS tokenizer on the host** ([`src/lib/css-references.ts`](../src/lib/css-references.ts)). It follows the
   tokenizer of CSS Syntax Level 3 — comments, strings with escapes and line continuations, ident sequences with escapes
   (`\75 rl(` is `url(`), numbers and dimensions (`10url(` is not), hash and at-keyword tokens, CDO/CDC, url tokens and
   bad-url remnants — in one linear pass that never throws. A reference is a url token, the string argument of `url(`, the
   first token of an `@import` prelude, or a string directly inside `image-set()` / `-webkit-image-set()`. Nothing in
   another at-rule's prelude counts (`@namespace url(…)` is a name, `@supports (…url(…)…)` a test), and no other string
   does (`content`, `format()`, `local()`, `type()`, selectors). Only complete tokens count: an unclosed string or url, a
   bad string and a bad url are left alone. The replacement is always a CSS string `"<blob: URL>"`: a url token's whole
   inside (`url( a.png )` → `url("…")`), or the string token, quotes included. A unit test re-tokenizes every rewrite, and
   2000 random inputs, and finds the same references, each now that string.
2. **Stylesheets: references at registration, slots per build.** When `registerFiles()` stores a `text/css` file (by
   extension or override), it keeps every reference that, resolved against the file's own virtual URL
   `https://vfs.invalid/<path>` (the URL parser's rules, as in markup), names a valid path with no query or fragment, as a
   byte range and that path. Whether a file is registered there is decided per build, in `snapshot()`, since the store can
   change in between: each such reference becomes a slot, `[start, end, [path]]`, in the same fourth snapshot element as
   the module rewrite. The guest replaces the range with a CSS string holding that file's `blob:` URL, every character
   that could end the string escaped (`inSandboxFiles`). As for modules, `read()` and `text()` return the bytes as
   registered, `url()` the rewritten sheet, and `listFiles()` the registered size.
3. **Dependency order on the host, one pass in the guest.** A stylesheet's `blob:` can only be made once the URLs it names
   exist. The snapshot is in delivery order: files without slots first, in path order, then each stylesheet after every
   file it names (a depth-first walk). The guest makes the blobs in literal order in one pass and looks each slot up among
   the files made so far; a slot naming a file not made yet keeps its registered bytes. It follows no reference, so it
   cannot loop, whatever the literal holds. `list()` sorts, since the literal is not in path order.
4. **A reference cycle fails closed.** `a.css` imports `b.css` which imports `a.css`, or a stylesheet names itself: no
   order puts every file after the files it names. Every reference that lies on a cycle — every reference between two
   files of one strongly connected component (Tarjan), a self-reference included — is left as registered, and fails
   closed in the guest like any unresolvable relative URL; the cycle's other references, and references into it from
   outside, still resolve. One warning per distinct cycle per element. Breaking only one edge was rejected: which edge
   would depend on which file the guest links first, and the host does not know that; dropping every edge on a cycle gives
   the same result whatever the entry point.
5. **The quota counts what the slots add**, as for modules. Each reference that could name a file costs its path length
   plus 24 (two offsets and separators in the literal) plus 48 (the quoted `"blob:null/<UUID>"` that replaces it in the
   guest's sheet), counted at registration whether or not its target is registered, so a file's cost never depends on
   what else is in the store. The check stays atomic and two-step: registered bytes first, then tokenized and checked
   again, before any change. A sheet of nothing but `a{b:url(a)}` counts 84 bytes per 11-byte rule, so it is refused well
   before the literal or the guest's sheet could pass what the cap was measured at.
6. **Inline `<style>`, `style=""` and `srcset` are markup references** (the same parse,
   [`src/lib/markup-references.ts`](../src/lib/markup-references.ts)), resolved against `https://vfs.invalid/index.html`,
   HTML-namespace elements only. The text of a `<style>` and the value of a `style` attribute go through the same
   tokenizer; a reference that names a registered file becomes a CSS string holding the sentinel, and its part says where
   it lands, `[path, 'css']` or `[path, 'css-attribute']`, so the bootstrap escapes the URL for a CSS string (and then for
   the attribute). `srcset` of `img` and `source` is split as the HTML standard does it
   ([`src/lib/srcset.ts`](../src/lib/srcset.ts): URLs are runs of non-whitespace, so a comma inside one belongs to it,
   trailing commas end it, descriptors run to a comma outside parentheses); each candidate URL that names a file gets an
   attribute slot, every other candidate and descriptor stays as written. Same gate as the other markup references, and no
   match still means the markup is embedded verbatim.
7. **No change to the policy.** A stylesheet already brings `blob:` into `style-src`; the images and fonts it names bring
   `blob:` into `img-src` and `font-src` by their own types, as for any file. A reference to a file whose type does not
   load there (a `.txt` used as an image) is refused by the policy. Unit tests pin that a stylesheet with references gives
   the same policy as one without.

**How engines report a reference left as written** (`files.spec.ts` section 10): they differ in the event, never in the
outcome: nothing loads and nothing is requested.

| Left as written | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| `<link>` whose sheet has an unresolvable `@import` | `error` event | `load` event | `error` event |
| … its own rules | applied | applied | applied |
| … the `@import` rule's `styleSheet` | present, `cssRules` throws `SecurityError` | present, empty | `null` |
| `<img srcset>` whose only candidate cannot resolve | `error` event | no event | `error` event |

**Not supported (fail closed), each left as written.**

- A query or fragment (`url(bg.svg?v=2)`), another case or percent-encoding, an unregistered path: in a `blob:` sheet or
  an inline style they cannot resolve, so no request and no violation. A fragment-only `url(#f)` is left too (for `fill`,
  `filter` or `mask` it names an element of the document, not a file).
- URLs that only exist at run time: `url(var(--x))` (a bad url), `src()`, `attr()`, styles set from script
  (`element.style`, `CSSStyleSheet.replace()`, `insertRule()`). Use `sandboxFiles.url()`.
- Anything in an at-rule prelude other than `@import`'s; `imagesrcset` on `<link rel=preload>`; `<style>` and `style=""`
  on SVG elements; `<template>` contents.
- A stylesheet that is not UTF-8 is delivered unchanged, with one warning per registration.
- Worker mode gets the same snapshot, so a rewritten sheet holds worker-realm URLs: harmless, and of no use there.

**Alternatives considered.**

- **Regular expressions**: cannot tell `url(` in a comment or a string from a reference, decode escapes, or find where a
  url token ends; the tokenizer is what a browser runs.
- **A dependency** (`@csstools/css-tokenizer`, `css-tree`, PostCSS): the subset needed — references and the ranges to
  replace — is about 250 lines pinned by tests, and the context rules (what counts in which prelude, image-set) would
  still be ours. `@csstools/css-tokenizer` is the small, spec-conformant candidate if conformance ever matters more than
  size; not added.
- **Rewriting to virtual URLs plus a lookup, as for modules**: CSS has no import map; something would have to turn the
  virtual URL into a `blob:` URL, and only the guest's own bootstrap can.
- **Inlining imported sheets into one**: changes cascade layers, `@import` conditions and the CSSOM's shape, and grows
  with every import; slots keep each file a file.
- **Guest-side tokenizing**: would put the tokenizer into every guest bootstrap; the host tokenizes once, in a realm no
  guest code reaches.

**Costs.** The tokenizer adds to the host build; registration tokenizes the CSS it stores (about 0.13 s for 8 MiB of CSS
in Bun, 2026-10-13; `text/plain` about 10 ms); the reference graph and its cycles are computed per build in `snapshot()`,
linear in the references.

Tests: [`src/lib/css-references.test.ts`](../src/lib/css-references.test.ts) (url tokens, escapes, bad urls, unclosed
tokens, comments, strings, dimensions and other look-alikes, `@import` forms, other at-rule preludes, `@font-face` `src`
lists, `image-set()`, malformed nesting, the re-tokenizing property on a corpus and on random input, linear time),
[`src/lib/srcset.test.ts`](../src/lib/srcset.test.ts) (descriptors, commas inside URLs, trailing commas, empty candidates,
offsets), [`src/lib/files.test.ts`](../src/lib/files.test.ts) (slots resolved against the sheet's path, byte offsets with
multi-byte text and a byte order mark, what names no file, per-snapshot targets, delivery order, cycles of one, two and
three files with one warning each, a 999-file chain, the quota),
[`src/lib/in-sandbox-files.test.ts`](../src/lib/in-sandbox-files.test.ts) (slots filled from earlier files only,
CSS-string escaping, `list()` sorted), [`src/lib/markup-references.test.ts`](../src/lib/markup-references.test.ts)
(srcset, `<style>`, `style=""`, what is left alone, the `<style>` extent), [`test/unit/files.test.ts`](../test/unit/files.test.ts)
(the literal's order and slots, the policy unchanged, the cycle warning across rebuilds, the S2 hostile corpus with CSS
and srcset slots) and [`test/e2e/files.spec.ts`](../test/e2e/files.spec.ts) section 10 on Chromium, Firefox and WebKit: a
linked stylesheet's image and font, a two-level `@import` chain, an `@import` cycle and a self-import failing closed while
every other rule applies, inline `<style>` and `style=""`, `srcset` on `img` and `picture`, misses failing closed with no
request (T5: violations with positive controls, load outcomes, the recorder silent), and no egress from a rewritten
stylesheet.

## Guest writes

A guest can read its files, and can produce some when the embedder opts in. The guarantee: a guest changes files only
when the embedder opted in, never past the host's path rules and cap, and nothing it writes is kept, loaded or run until
the host says so.

- **One reserved broker method, `sandbox:write`, for writes and removals; not a raw frame.** That guest code cannot
  replace it holds for every `sandbox:` name by construction ([ADR-002, reserved methods](ADR-002-host-guest-broker.md#reserved-methods-and-library-codes)):
  `expose()` never registers one, on either side. And guest code cannot post a frame of its own at all, so a raw frame
  would not be harder to forge than a call. What a raw frame would lack is everything the broker already does once:
  request/answer correlation (the guest's view changes only on the host's answer), a timeout, `TERMINATED` on teardown,
  the 256-calls-in-flight cap, the current-port check and the clamp that lets only a reserved method report a library
  code. A second frame type would need a second copy of each. The guest calls the method through the broker's
  `callWithTimeout` captured by the bootstrap before guest code runs (like `sandboxFetch`), so replacing `bridge` or the
  port's prototypes changes nothing on that path. `PING` stays a raw frame for the opposite reason: it is answered in the
  guest, and answering at all is the signal.
- **The method is bound to the environment the request arrived in.** The host registers it again with each build, closed
  over that build's overlay; the broker looks a method up when a request arrives, and only the current port's frames
  arrive. So a request that runs after a listener rebuilt the sandbox goes to its own, closed, overlay, never to the next
  one.
- **`guestWrites: true` (only a literal `true`).** Off, `sandboxFiles.write()` and `remove()` still exist and reject
  `FILES_NOT_ALLOWED` without sending; the host's method refuses with the same code. The host's refusal is the guarantee,
  the guest's only saves the round trip.
- **One store chokepoint.** `FileStore.apply({ put, remove })` is the store's only mutation; `registerFiles()`,
  `unregisterFiles()` and the commit are wrappers. A write is checked by `CheckedFile.from()`, the same path and entry
  check, so its type is the one the store will load it as. At write time the quota is `FileStore.check()` of the store with
  every pending change and this write applied: the count and the registered bytes, which is `apply()`'s first step,
  without lexing. The commit is `apply()` itself, lexing included, against the store as it is then, so it can still be
  refused (`FILES_QUOTA_EXCEEDED`) if the host registered more meanwhile.
- **An overlay per environment, the host the single source of truth.** `Map<path, CheckedFile | removal>`, created by the
  build (null when off). A refused request changes nothing on either side; the guest's map changes only after the answer,
  in call order (a `Blob` is read first; every entry's bytes are copied when `write()` is called). A removal of a path in
  neither the store nor the overlay is answered `none` (the guest mints `NOT_FOUND`) and records nothing, so removal marks
  only ever name stored paths.
- **Answered from the build.** Each build takes one copy of the store (`FileStore.copy()`); its snapshot is what the guest
  gets, and the overlay decides every answer — removals and the write-time quota — against that copy plus the overlay, so a
  guest never learns of files the host registered after its build. The commit still applies to the live store with its
  full check.
- **No URL for anything written, but raster images in the strict view.** `list()`, `read()` and `text()` show the guest's
  acknowledged writes; `url()` of a written path is `NOT_FOUND` in every mode, and no `blob:` URL is minted for one in the
  guest. The one exception is the strict view (below): it shows raster-image writes from URLs it mints itself.
- **Commit needs an explicit list, and code needs a second opt-in.** `commitGuestWrites(paths, options?)`; there is no
  commit-all and no discard (`reset()` discards). A write whose type is not on a fixed inert list — the image, font, audio
  and video types of the extension table without SVG, `text/plain`, `application/json`, `text/css`, exact strings — is
  refused unless `options.code === true`. JavaScript, HTML, SVG, XML, WebAssembly, unknown types and any type the guest
  set are code until the embedder says otherwise. The type checked is the `CheckedFile`'s, which is what decides how the
  file is loaded, never the file name. A written `app.js` committed as `text/plain` is then a text file: the load-kind
  table keeps it from being the script of `<script src="app.js">`.
- **Refusal code for a non-inert commit: `FILES_NOT_ALLOWED`, reused.** The code says "an opt-in is missing", the same
  meaning as for a write while `guestWrites` is off; the message names the path, its type and the flag. A separate code
  would only add a branch to the host's own call, and the host already knows every pending type from `listGuestWrites()`.
- **Codes.** `RpcLibraryCode` holds the file codes `INVALID_PATH`, `INVALID_FILE`, `FILES_QUOTA_EXCEEDED`,
  `FILES_NOT_ALLOWED`, `FILES_BUSY` (disjoint from both call-code groups; only the guest's broker accepts them, only from a
  reserved method). `NOT_FOUND` stays a guest code.
- **Rate.** Besides the broker's 256 calls in flight, at most `GUEST_WRITES_PER_SECOND` (100) requests are handled and
  `GUEST_WRITE_BYTES_PER_SECOND` (8 MiB) recorded per environment and second, in any one-second window (a sliding window
  shared with the log limiter, `src/lib/rate-limit.ts`), refused with `FILES_BUSY`; the request count is taken first,
  refused requests included, and the byte rate after the quota. That also bounds `fileswritten`, one event per request that
  changed what `listGuestWrites()` shows at its path, dispatched last: the guest's write is acknowledged only if no
  listener reset or terminated the sandbox meanwhile. The announcement and the strict view's copy are both derived from one
  diff of the overlay per request (`record()`): the list changed, or what the guest sees changed. A removal mark whose path
  the host unregistered after the mark is forgotten before marks are listed or committed.
- **Lifecycle: one rule, builds discard and terminations keep.** The next build (`reset()`, `load()`, `setConfig()`) and
  the element's removal discard the overlay; `terminate()`, the watchdog and `workerExecutionTimeout` (a termination,
  [ADR-003](ADR-003-lifecycle-and-liveness.md)) keep it, closed: listable and committable, accepting nothing more. There
  is no rename or move.

**Alternatives considered.**

- **An `FS_WRITE` frame** handled before the broker: see the first decision.
- **A URL for written files** (minting one in the guest): it would give the guest `blob:` content no build registered, in
  the view too (strict mode removes `URL.createObjectURL` for exactly that reason, A8).
- **An inert list by prefix (`image/*`) or by extension**: `image/svg+xml` is a document, a guest's type override can be
  any `type/subtype`, and a file name decides nothing about how a blob loads.
- **Commit everything, or a discard method**: an implicit "everything" commits what the embedder did not look at;
  discarding is what a rebuild already does.

Tests: `src/lib/guest-writes.test.ts` (path corpus, entries, quota against store and overlay, removal marks, commit subset
and lexing, the inert list against the extension table, the rate with a fake clock), `src/lib/files.test.ts` (`apply()`
atomic, `check()`), `src/lib/in-sandbox-files.test.ts` and `src/lib/in-sandbox-script.test.ts` (the guest side: view after
the answer, `url()`, copies, call order, the captured call), `src/lib/rpc.test.ts` (pinned codes),
`test/unit/guest-writes.test.ts` (config, lifecycle, the current-port rule, the dispatch-then-act rule),
`test/unit/strict.test.ts`, and `test/e2e/guest-writes.spec.ts` in cooperative, worker and strict mode on Chromium,
Firefox and WebKit, with evidence read from the host page and the recorder.

## Strict mode

The strict view runs no guest script and its worker is a classic script admitted by `worker-src blob:` alone
([ADR-005](ADR-005-strict-mode.md)), so files reach the two realms differently.

- **The worker gets every file**, through `sandboxFiles` (`list`, `url`, `read`, `text`), from the same snapshot literal as
  worker mode. `url()` serves the worker's own `fetch()` (with `blob:` in `connect-src`).
- **The view gets the files that are not JavaScript, and only of the types that are never a document.** Its bootstrap
  mints its own `blob:` URLs from them (the same `inSandboxFiles`, so stylesheet `url()` and `@import` slots are filled
  with the view's URLs). `VIEW_FILE_TYPES` (`src/lib/in-sandbox-view.ts`) lists them per kind of load: CSS, raster images,
  fonts, audio, video and WebVTT, with no prefixes (`+xml` types are never listed). A user can open a shown image or video
  in a new tab, a navigation the view cannot cancel; a registered SVG opened that way ran its script top-level, outside the
  policy. Every other file stays the worker's (`sandboxFiles`), and the policy adds `blob:` for it only to `connect-src`.
  No JavaScript file is ever given to the view, and `blob:` is never added to `script-src` in strict mode: nothing
  executable can come from a file.
- **Rendered markup names files by path.** The renderer resolves the reference attributes of cooperative mode
  (`markup-references.ts`, the table itself, minus `<script src>`: `link[href]`, `img`, `source`, `video`, `audio`,
  `track` `src`, `video[poster]`) against `https://vfs.invalid/index.html`, by the same rules, and writes the view's URL in.
  A `<link>` survives only as a stylesheet or icon naming such a URL.
- **Only the view's own `blob:` URLs are kept** (A8). The renderer removes every attribute that holds any other `blob:`
  URL, however it is spelled (after removing the tabs and newlines the URL parser ignores). The worker cannot mint new
  ones: its prelude removes `URL.createObjectURL` after the file URLs exist, and the worker's own source URL is revoked
  once its script ran (ADR-005), so the only `blob:` URLs in the origin are the library's, for registered files — which
  also bounds what CSS could name.
- **Classic only.** No module graph, no import map, no `importScripts` (refused by the hash-only `script-src`); the entry
  is a registered JavaScript file appended to the worker's source on the host.
- **Not supported (fail closed):** `srcset`, `style=""` and `<style>` references (use a registered stylesheet, whose
  references are resolved), references in `<template>` (removed), `<script src>` and modules (no script in the view), a
  `blob:` URL from the worker's `sandboxFiles.url()` rendered into the view (removed).

**The view shows raster-image guest writes.** Without this, a strict plugin could not show an image it made, such as a
chart drawn on an `OffscreenCanvas`: it could write the PNG but not name it in a render until the host committed it and
rebuilt. The view shows the guest's pending or committed writes whose store type is a raster image, by path, in the same
environment.

- **One chokepoint, one constant.** `VIEW_WRITE_TYPES` (`src/lib/in-sandbox-view.ts`) is `VIEW_FILE_TYPES` ∩
  `RASTER_IMAGE_TYPES`: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`. Never `image/svg+xml` or any
  other type: a raster image opened on its own is an image, never a document. The view checks it before it mints
  (`showWrite`); the host reads the same constant only to decide whether to send the bytes at all.
- **The URL is the view's, made from the bytes the host holds.** When the element records a write or a removal in strict
  mode, it posts `VIEW_WRITE { id, path, mime, bytes }` on the view port: the store type and, for those types only, a copy
  of the recorded bytes, transferred. The guest never supplies a URL or a type the store did not give, and its worker still
  cannot mint one (`sandboxFiles.url()` of a written path stays `NOT_FOUND`).
- **Decoded only.** The view's load kinds admit these types for image loads alone (`img`, `poster`, icon links; the
  renderer's table), so a written PNG named by `<video>`, a stylesheet `<link>` or `<track>` stays as written. With
  `guestWrites`, the view's `img-src` gains `blob:`.
- **The path resolves as the guest's own `sandboxFiles` lists it.** A later write replaces the URL and revokes the old one;
  a removal, or a write of another type, revokes it and leaves the path naming nothing (a registered file the guest
  replaced or removed included). A revoked URL is no longer the view's, so markup naming it keeps no `src` (A8). A rebuild
  starts from the registered files.
- **Ordered by construction.** The view answers `VIEW_WRITTEN { id }` once it holds the change, and only then is the
  guest's `write()` answered: a render after `await sandboxFiles.write()` finds the URL, whatever the order of two ports
  would be. A teardown before the answer ends the wait. The overlay's caps (bytes, rate, quota) bound what the view holds.

The guarantee, as it stands: **the view renders no `blob:` content but registered files and raster-image guest writes,
decoded only.**

Tests: `test/e2e/strict.spec.ts` ("files"), on all three engines: an image and a stylesheet named by path load with
view-minted URLs and the stylesheet's own `url()` resolves; the view lists no JavaScript file; the worker lists and reads
every file; a worker-minted `blob:` URL, also obfuscated, is removed; the policy has `blob:` for images and styles and
never in `script-src`. Unit: `src/lib/in-sandbox-view.test.ts` (resolution, link rules, `blob:` filtering),
`src/lib/csp/csp-generator.test.ts`, `test/unit/strict.test.ts`, `test/unit/owner-decisions.test.ts` (the type set, the
host-to-view transfer and its wait, minting, replacement and revocation, the policy), `test/e2e/owner-decisions.spec.ts`
(three engines: an `OffscreenCanvas` PNG by its natural size read from outside, replace and remove, SVG, HTML and
JavaScript writes that do not resolve beside a PNG that does, the recorder silent but for its control) and
`test/e2e/guest-writes.spec.ts`.

## Alternatives considered

### Keep the Service Worker and fix it

Rejected: an opaque-origin `srcdoc` guest cannot be a client of any Service Worker, and it cannot register one of its
own (research 02). A fix could reach a worker's own faults, never this one: it is the architecture.

### `data:` URLs

Rejected: every reference would carry the whole file. A 4 MiB file is a 5.6 MB URL each time guest code uses it, copied
into every attribute, stylesheet rule and import map entry. A `blob:` URL is short, is created once per build, resolves
only in the realm that minted it, and is freed with that realm.

### Blobs created by the host page

Rejected by measurement: a `blob:` URL minted by the host page is refused by the guest's blob store for every load type,
in every engine, with `blob:` allowed (probe, section 4). The URLs have to be created in the guest's own realm.

### Inlining file contents into the guest markup

Rejected: it works only for files that guest markup names, and only by rewriting that markup into a different document
(inline `<style>` and `<script>` behave differently from fetched ones, and a module has no URL to resolve imports
against). It also gives guest code no way to list or read files.

### Delivering files over the broker after the port exists

Rejected for the initial set: the port arrives only after the frame has loaded, by which time guest markup and its module
scripts have already run, and Firefox honours only the first import map of a document (probe, section 3). The broker is
the route for writes.

### A `<script type="application/json">` data element

Rejected: the bootstrap would find it with a DOM lookup, and guest markup could shadow or precede an element the
bootstrap looks up. An argument to the bootstrap call cannot be reached by markup.

### `config.files`, Blob values, live pushes

- **Files in the config**: `setConfig()` rebuilds the config from the defaults, so files would vanish with an unrelated
  config change, and the config's deep merge mangles a `Uint8Array`.
- **`Blob` values**: reading one is asynchronous, which races `reset()` and breaks the one-snapshot rule.
- **Pushing changes into a running guest**: Firefox's single import map cannot be extended, the guest would see some
  files from one snapshot and some from another, and it needs the broker after load. A rebuild gives one consistent view.

## Consequences

- A guest reaches its files by `sandboxFiles.url()`, `read()`, `text()` and `list()`, in every mode, from its first script
  on.
- Containment is by construction: an exact lookup in a map built from validated paths has nothing to traverse, and every
  miss looks the same.
- Isolation between sandboxes is by construction too: a guest's `blob:` URL resolves neither in another sandbox nor on the
  host page, and the guest document carries no session id, no host origin and no `<base>` (S3).
- `blob:` adds no egress: blob-loaded code and stylesheets run under the guest policy, and every attempt to reach a
  non-allowlisted origin is refused with a CSP violation (probe, section 5, and `files.spec.ts` section 4).
- Releasing the frame releases its blobs: they belong to the guest document or worker, and teardown destroys that realm.

Costs and limits:

- **Guest markup and stylesheets name files only through the references above**: markup attributes, relative imports
  between modules, CSS `url()` and `@import`, and `srcset`, each with the limits listed there. `<template>` contents and
  URLs built at run time do not resolve; guest code uses `sandboxFiles.url()` for those.
- **Every guest carries the files bootstrap** (`inSandboxFiles`), files or not. That is the price of an API that exists
  regardless of host state.
- **Changes need a rebuild.** A file registered while the guest runs reaches it at the next `reset()`, `load()` or
  `setConfig()`.
- **Chromium cannot start a module worker from a guest `blob:` URL**, under any policy (probe, section 1). Classic workers
  and `importScripts` work everywhere.

### Revisit if

- browsers let a sandboxed opaque-origin document be controlled by a Service Worker; or
- Firefox ships multiple import maps, which would let files reach a running guest without a rebuild.

History: [the first text of this decision and its amendments](archive/adr/ADR-004-history.md).
