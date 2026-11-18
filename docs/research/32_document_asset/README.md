# Research 32: the package's own `sealed-document.html`, written as `new URL('./sealed-document.html', import.meta.url)`

**Question.** The next version ships a static file, `sealed-document.html`, that the embedder's site must serve, and the
library must know its URL. The design wants that URL to default to the package's own copy, written inside the library's
ESM bundle as `const documentUrl = new URL('./sealed-document.html', import.meta.url);`
([design 03, "Who is trusted with the app"](../../design/03-served-document.md#who-is-trusted-with-the-app)). **For each
common bundler and dev server, when an application depends on such a package from `node_modules`, is the file copied to
the output and served, byte for byte, at the URL that expression has in the browser, on the same origin as the
application's scripts?**

**Measured** 2026-11-18 in Chromium 159.0.8154.6 (Playwright, one engine: this is about build tools), with a stand-in
package, not the real library. Every row is one run of `run.mjs`; raw output is in [`results/`](results/summary.md).
Versions: Vite 8.3.8, webpack 5.112.2 (webpack-cli 7.3.1, webpack-dev-server 6.1.0), Rollup 4.68.7
(`@web/rollup-plugin-import-meta-assets` 3.0.1, `@rollup/plugin-url` 8.0.2, `rollup-plugin-copy` 3.5.0), esbuild 0.28.2,
Bun 1.4.4, Parcel 2.16.4, Next.js 16.4.6 (React 19.3.1), Node 22.23.4.

## Answer in brief

**No: the default expression is served byte for byte by some tools and not by others.** It works by default with no
bundler, with Vite's production build, and with Next.js (Turbopack and webpack, dev and production). It works with
one line of configuration in webpack and with one plugin in Rollup. It does not work in Vite's dev server (it serves
the file, modified), in esbuild, Bun and plain Rollup (the file is not copied; the URL points at a file that is not
there), in Bun's dev server (a `file:` URL), or in Parcel (it rewrites the HTML, and no configuration tried stopped it).

| Bundler × mode | Result | What it takes |
| :--- | :--- | :--- |
| No bundler: the package directory served as static files, imported by URL | **works by default** | Nothing. `/node_modules/fake-sealed/sealed-document.html`, the package's own name; unhashed, so the version is only in the path the host chose. |
| Vite 8, production build and `vite preview` | **works by default** | Nothing. `/assets/sealed-document-<hash>.html`, hashed, not inlined (Vite never inlines a `.html` asset). |
| Vite 8, dev server, pre-bundled or not (`optimizeDeps.exclude`) | **does not work**: served modified | Vite's dev server adds `<script type="module" src="/@vite/client"></script>` to every `.html` it serves, 55 bytes, right after `<head>` and before the file's own `<meta>` policy. The same bytes under `.htm` are served unmodified, but a production build inlines a `.htm` of under 4 KiB as a `data:` URL (an opaque origin). |
| webpack 5.112, production build | **does not work**: rewritten | webpack's own HTML support (`experiments.html`, on by default when no rule matches `.html`) minifies the file and rewrites its inline script: 1911 B became 752 B. **Works with** `module.rules: [{ test: /\.html$/i, type: 'asset/resource' }]` or `experiments: { html: false }`: `/<hash>.html`, hashed. |
| webpack-dev-server 6.1 (development mode) | works by default, with a caveat | Bytes equal in this run: development mode does not minify. The same HTML pipeline is active, so the rule above is the safe setting in both modes. |
| Rollup 4, plain | **does not work** | The expression is left as is, the file is not copied, and the URL resolves beside the app's bundle: 404. **Works with** `@web/rollup-plugin-import-meta-assets` (`/assets/sealed-document-<hash>.html`, hashed), or with a copy of the file into the bundle's directory (`rollup-plugin-copy`; unhashed, and only while the bundle and the file stay side by side). `@rollup/plugin-url` does nothing for `new URL`. |
| esbuild 0.28, `--bundle --format=esm` (also `--splitting`) | **does not work** | As Rollup: left as is, 404. esbuild has no `new URL(..., import.meta.url)` support. **Works with** a copy of the file into the output directory. |
| Bun 1.4, `bun build` (script entry or HTML entry) | **does not work** | As Rollup: left as is, 404. **Works with** a copy into the output directory. |
| Bun 1.4, `bun index.html` dev server | **does not work** | `documentUrl` is `file:///<absolute path in node_modules>/sealed-document.html`: the browser refuses to fetch it, and the build machine's path is in the page. No configuration tried. |
| Parcel 2.16, build and `parcel serve` | **does not work**: rewritten | Parcel treats the file as an HTML bundle: it rewrites it (minified: 760 B; with `--no-optimize` the bytes still differ) and names it `sealed-document.<hash>.html`. A `.parcelrc` that sends it to `@parcel/transformer-raw`, with the raw packager and no optimizer, did not stop the rewrite (888 B). `.htm` is the same. No extension: the bytes are copied, as `sealed-document.<hash>.` with no type (see "Other names"). |
| Next.js 16.4, Turbopack (the default), `next dev` and `next build` + `next start` | **works by default** | Nothing. `/_next/static/media/sealed-document.<hash>.html`, hashed, `text/html`. `documentUrl` is a `URL` whose `href` is the relative path and whose `origin` is `""`: resolve it with `new URL(String(documentUrl), document.baseURI)`. |
| Next.js 16.4 with `--webpack`, dev and production | **works by default** | Nothing. `/_next/static/media/sealed-document.<hash>.html`; the same relative `URL` value. |

"Works" means all of: 200, `text/html`, SHA-256 equal to the package's file for both the application's `fetch()` and a
navigation of an `iframe` (the request the element makes), and the origin of the application's scripts.

## Method

- **The stand-in** ([`fake-sealed/`](fake-sealed/package.json)): `"type": "module"`, an `exports` map for `.` and
  `./sealed-document.html`, an `index.js` that exports `new URL('./sealed-document.html', import.meta.url)`, and a
  1,911-byte `sealed-document.html` with a `<meta http-equiv="Content-Security-Policy">`, an inline `<script>`, an
  `<iframe srcdoc>`, double spaces, a tab and a comment, so that any HTML processing is a byte difference. Its policy's
  script hash is a placeholder; the console messages about it in `results/` are not a finding.
- **The install.** `bun pm pack` makes a tarball and each application installs it with `npm install`, as a registry
  install would (a copy in `node_modules`, not a link). Every case unpacks a fresh copy first.
- **The application** ([`apps/_shared/`](apps/_shared/main.js)): imports the package, computes the absolute URL, fetches
  it (status, `content-type`, SHA-256 in the page with `crypto.subtle`), and the measuring script then navigates an
  `iframe` to the same URL and hashes the response body. Per bundler: `apps/<bundler>/` holds its `package.json` and
  configs; the defaults are no config at all, or the config named in the table.
- **Serving.** A production build is served by a neutral Node static server on `127.0.0.1` ([`serve.mjs`](serve.mjs):
  `.html` and `.htm` as `text/html`, everything else by its extension); a dev server or `next start` serves itself.
  The page and the file are always on the same loopback origin.
- **The check** ([`measure.mjs`](measure.mjs)): Chromium through Playwright, one fresh browser per case, under the
  machine's browser lock.
- **Rerun**: `WORK=<dir outside the repository> node run.mjs [case-id ...]` (needs `PLAYWRIGHT_BROWSERS_PATH`, Bun and
  npm), then `node summarize.mjs`. `results/<id>.json` is each case's raw output, `results/<id>.log` its build and server
  log, and [`results/summary.md`](results/summary.md) the table of all of them.

## Per bundler

### Without a bundler

The package directory served statically and imported by URL (an import map names the package): the expression resolves
beside `index.js`, the file is the package's own, byte for byte (SHA-256 `8ac4bf7e…`). By definition, and confirmed. A
CDN that serves the package's files (and does not rewrite HTML) gives the same result; the URL then holds the package's
version in its path, which a bundler's hash does too.

### Vite 8

- **Build** (`vite build`, `vite preview`): the expression is recognised, the file is emitted as an asset, hashed
  (`sealed-document-CdaghI9E.html`), and the URL is rewritten to it. Bytes equal. Vite's `shouldInline` returns false for
  a `.html` before it looks at the size, so the 4 KiB `assetsInlineLimit` never turns it into a `data:` URL (an app
  build in library mode, `build.lib`, would: that check is earlier). Nothing printed.
- **Dev server**: the URL is `/node_modules/fake-sealed/sealed-document.html`, the same origin, and the same with
  dependency pre-bundling (the pre-bundled copy holds a path relative to `node_modules/.vite/deps/`, which resolves to
  the same file) and without (`optimizeDeps.exclude: ['fake-sealed']`). The dev server's HTML middleware answers any
  request for a `.html` file under the root with the file transformed: the client script is inserted at the head of the
  document, ahead of the file's own policy `<meta>`. The response is 1,966 bytes, for the fetch and for the iframe's
  navigation. Whether Chromium ran that script in the frame was not measured. The same package with the file named
  `.htm` is served byte for byte in dev. **No configuration was tried that keeps `.html`**: `appType: 'custom'`, documented to leave the HTML
  middlewares out, would also stop Vite serving the application's own `index.html`, and was not run.

### webpack 5.112

- A `new URL('./x.html', import.meta.url)` becomes an asset only if `.html` is not handled by webpack's HTML support,
  which 5.112 turns on by itself (`experiments.html: "auto"`) unless a `module.rules` entry matches an `.html` file. In
  production it then emits a minified page (`486bcb52…html`, 752 B, the inline script rewritten); the hash pin of an
  inline script would not match.
- Either of these gives the asset module: the rule
  `{ test: /\.html$/i, type: 'asset/resource' }` ([`webpack.rule.config.js`](apps/webpack/webpack.rule.config.js)), or
  `experiments: { html: false }` ([`webpack.htmloff.config.js`](apps/webpack/webpack.htmloff.config.js)). The output is
  `<hash>.html` (`6f38c2be02272e38de98.html`) beside the bundle, equal bytes, and the URL is built from the script's
  location (`output.publicPath: 'auto'`). Nothing printed in any case.
- webpack-dev-server (development mode) served the file with equal bytes at the same hashed name: development mode
  does not minify. Whether its HTML handling rewrites a file with other content than the stand-in was not measured;
  the rule above does not depend on the mode. The `.htm` name was a plain asset (equal bytes, hashed `.htm`) in the
  production build, with no configuration.
- Older webpack 5 versions, before the HTML support, were not measured.

### Rollup 4

- **Plain**: the output keeps `new URL('./sealed-document.html', import.meta.url)`; `import.meta.url` is the bundle's
  URL, so the file is looked for beside the bundle and is not there (404). No warning.
- **`@web/rollup-plugin-import-meta-assets`** (`importMetaAssets()`): copies the file to `assets/` with a hash and
  rewrites the expression. Equal bytes.
- **`rollup-plugin-copy`**: a copy of the file to `dist/` makes the unchanged expression resolve, with equal bytes and
  an unhashed name; it holds only as long as the bundle's output directory is where the file is.
- **`@rollup/plugin-url`**: acts on `import`, not on `new URL`; no effect.

### esbuild 0.28

`--bundle --format=esm` leaves the expression (and `--splitting` too): the URL points beside the output, 404, no
warning. Copying the file into the output directory (`cp`) makes it work (unhashed). Output formats other than ESM
(`iife`, `cjs`) leave no `import.meta.url` and were not measured.

### Bun 1.4

- `bun build main.js` and `bun build index.html` leave the expression; the file is not copied (404).
- `bun index.html` (the dev server) replaces `import.meta.url` with a `file:` URL of the source file, here
  `file:///<scratch directory>/node_modules/fake-sealed/sealed-document.html`; `fetch` of it fails ("URL scheme file is not supported"). No
  configuration tried.

### Parcel 2.16

The file is a dependency of type HTML: Parcel packages it as a page, minifies it (`--no-optimize` leaves a differently
rewritten page), and names it `sealed-document.<hash>.html`, in build and in `parcel serve`. A `.parcelrc` sending the
file to `@parcel/transformer-raw` with the raw packager and no optimizer
([`.parcelrc.raw`](apps/parcel/.parcelrc.raw)) produced the same rewrite (patterns tried: a path glob, the basename,
`*.html`). Not found: a setting that copies an `.html` as is.

### Next.js 16.4

A client component importing the package: Turbopack (the default for `next dev` and `next build`) and webpack
(`--webpack`) both emit the file as `/_next/static/media/sealed-document.<hash>.html`, equal bytes, `text/html`, in dev
and in the production server. The value is a `URL` object whose `href` is that path, relative, and whose `origin` is
the empty string: code that reads `documentUrl.href` or `documentUrl.origin` as absolute gets a path. `String(url)`
resolved against `document.baseURI` is the absolute URL. A `basePath` or `assetPrefix` was not tried.

## Other names for the same bytes

`.html` is not what fails everywhere; it is what some tools process.

| Name | Effect |
| :--- | :--- |
| `.htm` | Vite dev: served unmodified (bytes equal). Vite build: inlined as a `data:` URL when under 4 KiB (an opaque origin; not framed here). webpack production build: a plain asset (hashed `.htm`), equal bytes, without configuration (the dev server was not run with it). Parcel: still processed as HTML (and renamed `.html`). Servers type `.htm` as `text/html` in the usual tables; a CDN's table was not checked. |
| No extension | Parcel copies the bytes (`sealed-document.<hash>.`, a trailing dot, SHA equal) but the file has no media type: the neutral server sent `application/octet-stream`, and the iframe navigation produced no document (Chromium reported no response body: a download). An extension-less name cannot carry `text/html` from the library's side; it depends on how the host serves it. |

So `.htm` fixes Vite's dev server and webpack's production build, and costs Vite's build the file (inlined, unless the embedder raises or
lowers `assetsInlineLimit`) and leaves Parcel as it was. No single name works everywhere.

## What this means for making `documentUrl` optional

- **The default can be promised to some embedders, not to every one.** It holds with no bundler, with Vite's build,
  with Next.js, and with webpack or Rollup plus the setting above. It cannot be promised for Vite's dev server, esbuild,
  Bun, Parcel or plain Rollup and webpack production builds.
- **Dev servers are where it fails first.** Vite's dev server is the common one, and there the file is served but not
  as it is. A hash pin on the document (`viewScriptHash()` against the file's script) turns a modified or missing file
  into a named termination reason rather than a half-working view; a 404 or an altered file must end in one, and the
  documentation of the default has to name the bundlers that need the setting and what it is (the table above).
- **The URL value is not always absolute.** Next.js gives a `URL` with a relative `href`; the library must resolve
  `String(documentUrl)` against `document.baseURI` before it compares origins or frames it, never read `.origin`.
- **Unhashed names (no bundler, copied files) do not change with the version.** Only the hashed outputs (Vite and
  webpack builds, Rollup with the plugin, Next.js) avoid a stale cached copy, as the design wants.
- **`documentUrl` stays a documented, optional override** for every row that is not "works by default": the embedder
  copies the file to a place of the site's choosing (the same origin as the app's scripts, or a second host with the
  design's trust caveat) and passes the URL.

## Not measured

- Firefox and WebKit: one engine, as this is about build tools. A framed document in a sandboxed iframe was not loaded
  (only the navigation request was compared); `Sec-Fetch-Dest: iframe` is what the iframe load sends.
- Whether Vite's injected client script runs in the framed file, and whether webpack's development mode would rewrite
  a file with other content (links, other scripts) than the stand-in.
- The real library: a bundle of the real size (the file may be far larger than 2 KB; Vite's `.htm` inlining depends on
  it, `.html` does not), its real policy, `package.json` `exports` of the real package.
- Older versions of each tool (in particular webpack 5 before its HTML support), `output.module` webpack builds,
  esbuild's `iife` and `cjs` formats, Turbopack and webpack with `basePath` or `assetPrefix`, a deployment behind a CDN
  that rewrites paths, Vite's `base` option and library mode, a monorepo with a linked (not installed) package, pnpm's
  and Yarn PnP's layouts, Deno, Webpack Module Federation and server-side rendering.
- The other tools people use over these (create-react-app's webpack config, Angular CLI's esbuild, SvelteKit, Astro,
  Remix, Nuxt over Vite or Rspack, Rsbuild, Turbopack outside Next.js).
