# Research 24: sealed mode, and WebAssembly in it

**Question.** Every data finding of the board's passes that reached strict mode needed one of its two network options,
`origins` or `fetchBridge` (research 22). If the default mode had no network at all, what would leave its code, what
would its policies be, and could it still run an app the host drives from outside, with WebAssembly?

**Answer.** Decided by the owner on 2026-10-24, **not built**. `src/` has no `sealed` mode yet; strict is still the
default. The decision:

- **A new mode, `mode: 'sealed'`, becomes the default**, and the review board's scope. It is strict with no network: the
  same view, worker, renderer and bootstrap, with a view policy whose every fetch directive is `blob:` or `'none'` and
  `connect-src 'none'`. The network (`origins`, the fetch bridge, the bridge frame, the host-site and host-policy
  decisions) is not on its path (§1, §2).
- **A config with no `mode` that names `origins` or `fetchBridge` is refused** with a reason that names the fix
  (`mode: 'strict'`). It is not inferred as strict and not silently stripped.
- **No WebAssembly in sealed v1.** The library keeps deleting `WebAssembly` from the worker, as strict does. All three
  engines run WebAssembly the same way under `'wasm-unsafe-eval'` (M1, M2), and nothing measured changes timers (M3), but
  **WebKit does not stop a pure WebAssembly loop** when the frame is removed or the worker terminated (M4, §4). An
  `allowWebAssembly: true` opt-in may follow, once that residual is accepted as a documented row or WebKit fixes it.
- **Strict keeps its network**, with two fixes that were in progress when the design was written: no cookie carrier
  (`wss:` and `origins.withoutCors` removed) and no read of the host page's policy. Sealed assumes both.
- **The engine ledger row `webassembly-unsafe-eval` was wrong** and is corrected with this note: WebKit compiles without
  the keyword but refuses every instantiation, so no WebAssembly code runs there either (M1).

The measurements are in `measure.spec.ts` (below); §1 and §2 follow from the code and the specs and were not run.

## Status and build steps

| Step | Content | State |
| :---: | :--- | :--- |
| 0 | This note, `measure.spec.ts`, the ledger row corrected | done |
| 1 | The type and the schema: `SealedSandboxConfig`, `NetworkSandboxOptions`, `CONFIG_SCHEMA` modes, the refusal and its reason, `sealedViewPolicy`. Sealed is opt-in (`mode: 'sealed'`); the default is still strict | not built |
| 2 | The sealed build path: `_prepareStrictFrame` with no network, no host-site call in `setConfig()`, no bridge, an empty gate list, `sandboxFetch` refusing in the guest's realm | not built |
| 3 | The no-network e2e on all three engines (a listener that must see nothing) and the property suite in sealed | not built |
| 4 | Sealed becomes the default: the codemod over tests and presets, README, API.md, THREAT-MODEL, ARCHITECTURE, an ADR, the playground, the brief for the next board pass | not built |
| 5 | Driven from outside, docs: the app recipe, the stream pattern, the guest-write route for images, and the `openExternal` example fixed and run by a spec | not built |
| later | `allowWebAssembly` as an opt-in (needs a ledger row `webassembly-termination` and the shared-buffer tests) | not decided to build |

**Decisions of the owner (2026-10-24).**

| # | Decision |
| :---: | :--- |
| D1 | A config with no `mode` that names `origins` or `fetchBridge` is refused, with the reason of the API. |
| D2 | No WebAssembly in sealed v1; an `allowWebAssembly` opt-in later (§3.3). |
| D3 | New public names: `SealedSandboxConfig` and `NetworkSandboxOptions` (the interface that carries `fetchBridge` for strict, cooperative and worker). |
| D4 | `sandboxFetch` exists in sealed and rejects with `FETCH_NOT_ALLOWED` in the guest's realm; no host handler exists. |
| D5 | Data findings that reach only strict's network opt-ins do not count against a clean pass; they are fixed or documented as limits of those opt-ins. |
| D6 | The served-document mode ([research 20](../20_served_document_mode/README.md)) is shelved: sealed answers research 22's trigger for the default. |
| D7 | The 8 MiB file quota stays for v1. |

## 1. What sealed removes (from the code; not run)

The sealed build is the strict build with no network. These never run in it:

| Part | Where |
| :--- | :--- |
| The host-site decision (`hostPageOrigin`, `onHostSite`) and the host-policy narrowing (`hostReach`, `narrowToHostPolicy`) | `src/lib/host-site.ts`, `src/lib/csp/host-connect.ts` |
| The cookie and `connect-src` fact tables and every warning written from them | `src/lib/cookie-facts.ts`, `src/lib/connect-facts.ts` |
| `origins` parsing, the https twin rule | `src/lib/csp/origins.ts` |
| The fetch bridge, the bridge frame, its realm, channels and eight frames | `src/lib/fetch-bridge.ts`, `src/lib/bridge-frame.ts`, `src/lib/in-bridge-frame.ts`, `src/lib/frame-documents.ts` |
| The request gate's **allow** path (its list is empty: every request is refused and reported) | `src/lib/in-sandbox-script.ts` |
| Network URLs in `src`, `srcset`, media and CSS (all dropped and reported before insertion) | `src/lib/in-sandbox-view.ts` |

About 2 500 lines of `src/` leave sealed's path; they stay for strict. What still runs, and must: the request gate's
refusal path and its reports, the renderer's URL checks, the environment check, Trusted Types, files, guest writes, the
view's budgets and input.

- **Promises.** "The guest reaches the network only through `origins` or the fetch bridge" becomes "no network at all".
  The two cookie promises are N/A (nothing leaves). Every other promise of the threat model holds unchanged.
- **Inherited context** (`INHERITED_CONTEXT`, 18 rows): 5 rows are N/A in sealed (`referrer`, `ancestorOrigins`, `cookies`,
  `serviceWorker`, `uiSurfaces`), 1 is reduced (`cspFetch`: no origin to narrow, only `blob:` for registered files), 12
  remain. Every remaining row either fails closed with a reason or is availability. None moves data.
- **Engine ledger.** `cookies`, `connect-src`, `redirect-refusal-outcome`, `referrer-on-requests`, `secure-cookie-over-http`,
  `service-worker-control` and every cooperative-only row leave sealed's scope.
- **Findings.** Of the 20 data findings of BD1 to BD4, 14 need `origins` or `fetchBridge`, 3 reach only cooperative or
  worker mode, 2 reach sealed and are fixed by constructions that hold in every mode (BD2:CHL-1, BD2:ISO-1), and 1 is a
  docs example (BD4:NEW-2, passes guest text to `window.open`). BD2:NEW-1 reaches sealed only as a build refusal.

## 2. The policies (from the code and the spec; not run)

### 2.1 The view's policy (the worker inherits it)

One template, `sealedViewPolicy`, whose input has no `origins` key, so no network source can be written into it. With no
files:

```
default-src 'none'; script-src 'sha256-<bootstrap>'; script-src-attr 'none'; style-src 'unsafe-inline';
img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; worker-src blob:; frame-src 'none';
object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'
```

Registered files add `blob:` to `style-src`, `img-src`, `font-src` and `media-src` by kind, as in strict. `connect-src`
is `'none'` always: strict adds `blob:` there, sealed does not, because the worker reads its files with
`sandboxFiles.read()`, which makes no request. `script-src` gets `'wasm-unsafe-eval'` only with the later opt-in and
`'unsafe-eval'` only with `scriptUnsafe`.

### 2.2 What the host page's policy must admit

A policy list only narrows, so the host page's policy can make sealed refuse something and never widen it.

| Host page directive | Sealed needs |
| :--- | :--- |
| `script-src` | `viewScriptHash()`, or `'unsafe-inline'` (with the later WebAssembly opt-in also `'wasm-unsafe-eval'`, M2) |
| `worker-src` (or its fallbacks) | `blob:` |
| `style-src` | the wrapper style's hash, the still stylesheet's with `allowAnimations: false`, and `'unsafe-inline'` for the guest's styles |
| `img-src`, `media-src`, `font-src` | `blob:` for registered files of that kind; **no origin**, there is none to list |
| `connect-src` | nothing: sealed makes no request, on any engine |
| `base-uri` | `about:`, or no directive |
| Trusted Types | `trusted-types web-sandbox` |
| COEP / COOP | as strict: COEP `require-corp` alone fails on WebKit; a cross-origin isolated page is refused |

### 2.3 What sealed reads from the host page

Only `crossOriginIsolated`, a boolean the browser guarantees, used only to refuse (without it an isolated page builds on
Chromium and is refused on Firefox: an engine difference, and an isolated guest would get 5 µs timers). It does not read
the page's origin or its policy. That deletes the same-site rule, the private-network rule, the connect narrowing, the
twin rule and the build's wait on a policy read from sealed's path. Research 22's lesson, to replace a prediction by a
rule that reads only what the browser guarantees, holds with no predictor left.

## 3. WebAssembly

### 3.1 Setup

`measure.spec.ts` builds the strict view's shape and no more: a host page served with its own response headers, a
`sandbox="allow-scripts"` `srcdoc` frame (opaque origin) whose `<meta>` policy admits one inline script by its hash plus
`worker-src blob:`, and that script makes a `blob:` worker. No library code runs. Playwright 1.58.1, headless, Linux
(4 cores): Chromium 145.0.7632.6, Firefox 146.0.1, WebKit 26.0. One engine at a time. "Runs" means a module was compiled,
instantiated and its export called (`add(2, 3)` returned 5).

### 3.2 Measurements

**M1. The view's own `script-src`** (host page: no policy).

| View `script-src` | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| hash only (strict today) | compile refused; nothing runs | compile refused; nothing runs | **compiles** (`Module`, `compile`, `compileStreaming`); every instantiation refused ("Refused to create a WebAssembly object…"); nothing runs |
| hash and `'wasm-unsafe-eval'` | runs | runs | runs |

- With the keyword every path runs on all three: `new Module` with `new Instance`, `instantiate(bytes)`,
  `instantiate(module)`, `compileStreaming` and `instantiateStreaming` from a `Response` of the bytes. No `fetch` is
  needed: an app would read its `.wasm` with `sandboxFiles.read()`.
- `eval` and `new Function` stay refused on all three with the keyword.
- `WebAssembly.validate` returns `true` on all three under every policy.
- A refused compile raises a `securitypolicyviolation` in the worker on Chromium and Firefox (`script-src`, blocked URI
  `wasm-eval`; `eval` for `eval` and `new Function`). WebKit raises none, for WebAssembly or for `eval`, as for every
  worker report on it.
- **Correction to the ledger** (row `webassembly-unsafe-eval`): WebKit does not run WebAssembly without the keyword
  either. The library's deletion of `WebAssembly` stays, as defence in depth: it keeps WebKit's compiler away from guest
  bytes and hides the compile-only difference.

**M2. The host page's inherited `script-src`** (view: hash and `'wasm-unsafe-eval'`).

| Host page policy | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| none | runs | runs | runs |
| `script-src 'self' <hash>; worker-src blob:` (no keyword) | refused | refused | compiles, every instantiation refused; **nothing runs** |
| the same with `'wasm-unsafe-eval'` | runs | runs | runs |
| `img-src 'self'` only (no script directive) | runs | runs | runs |

The outcome is uniform: on all three engines WebAssembly runs exactly when every policy in the list admits it. A host
page with a `script-src` would add `'wasm-unsafe-eval'`: one more row of the host setup table that fails the same way
everywhere. Expected, not run: a one-module probe before guest code would detect it on every engine, because WebKit
refuses at instantiation, which the probe exercises, and could end the build with a reason.

**M3. Timers, shared memory, memory** (in the worker; the page is not cross-origin isolated).

| | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| `crossOriginIsolated` | `false` | `false` | `false` |
| `typeof SharedArrayBuffer` | `undefined` | `undefined` | `undefined` |
| `new WebAssembly.Memory({ shared: true, … }).buffer` | a `SharedArrayBuffer` | a `SharedArrayBuffer` | a `SharedArrayBuffer` |
| a module that defines and exports a shared memory | a `SharedArrayBuffer` | a `SharedArrayBuffer` | a `SharedArrayBuffer` |
| that buffer posted on a `MessageChannel` or to the view | `DataCloneError` | `DataCloneError` | `DataCloneError` |
| `structuredClone` of it | `DataCloneError` | `DataCloneError` | a plain `ArrayBuffer` copy |
| `performance.now()` smallest step | 0.1 ms | 1 ms | 1 ms |
| `WebAssembly.Memory` of 1 GiB / 4 GiB | allowed / allowed | allowed / allowed | allowed / allowed |
| `new ArrayBuffer(2 ** 30)` (JS, for comparison) | allowed | allowed | allowed |

- **No high-resolution timer.** A shared-memory clock needs a second thread to write the buffer. The sealed worker has no
  nested `Worker` and no `postMessage` of its own, the buffer cannot leave its thread on any engine, and an isolated host
  page is refused. Timer resolution is the same with or without WebAssembly.
- **A new kind of value enters the guest's realm.** With WebAssembly the guest can hold a `SharedArrayBuffer`. The
  library's value boundary refuses one by kind today, and the platform refuses to clone it. A typed array over a shared
  buffer is a case no test holds yet: add it (unit and e2e) before the opt-in ships.
- **Memory.** A guest can reserve 4 GiB with WebAssembly; JS already allocates 1 GiB. The threat model already says
  memory is not bounded. On Firefox and WebKit the worker lives in the host page's process, so a guest that commits that
  much can crash the tab with or without WebAssembly.

**M4. CPU: does ending the sandbox stop a looping worker?** The worker loops forever; the host page removes the frame
(what `terminate()`, `reset()` and the watchdog do). CPU of the browser's whole process tree from `/proc`, in
one-second windows over the 12 s after removal; "1.00" is one core. "Stops" is the first window after which every window
is under 0.2.

| Loop in the worker | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| JS `for (;;) {}` | stops after about 2 s | stops at once | stops at once |
| WebAssembly `loop br 0` (pure) | stops after about 2 s | stops at once | **never stops**: 0.91–1.05 cores in every one of 12 windows |
| WebAssembly loop that calls a JS import each turn | stops after about 2 s | stops at once | stops at once |
| the pure WebAssembly loop, `Worker.terminate()` from the view first, then the frame removed | stops after about 2 s | stops at once | **never stops**: 0.98–1.11 cores in every one of 12 windows |

All four keep a core busy (0.97–1.09 cores) before the removal on every engine. After the page was closed the tree was
idle again (under 0.04 cores) in every case. Chromium's 2 s is its forcible-termination delay; it is the same for JS, so it is
not new.

### 3.3 The three options, and the decision

| | (a) JS and WebAssembly, `'wasm-unsafe-eval'` | (b) WebAssembly only, a fixed import interface | (c) no WebAssembly |
| :--- | :--- | :--- | :--- |
| What runs | the app's JS, which compiles its `.wasm` with any toolchain's glue | only the app's `.wasm`, compiled by the library, with the library's imports | the app's JS |
| Uniform across engines | yes (M1, M2) | yes (same policy as (a)) | yes |
| Host page setup | `'wasm-unsafe-eval'` if it has a `script-src` | the same | none new |
| `terminate()` and the watchdog | **not on WebKit for a pure loop** (M4) | the same, unless every loop is rewritten to call an import | as today |
| New values in the guest's realm | `SharedArrayBuffer` through shared memory (M3) | refusable: the library can reject a module that declares shared memory | none |
| Engine attack surface | the engines' WebAssembly compilers on guest bytes, in the host page's process on Firefox, WebKit and Android | the same | none new |
| Authoring | every toolchain works | a custom ABI; the usual JS glue does not fit; a large API to keep stable | compile to JS (`wasm2js`, Emscripten `-sWASM=0`), slower |
| Size | S to M | L | none |

**Decision (owner, 2026-10-24): (c) for sealed v1.** `WebAssembly` stays deleted.

- The WebKit result (M4) breaks "the host can always stop the guest", and no library code repairs it short of
  instrumenting every module.
- Nothing else measured blocks (a): the policy behaviour is uniform, timers do not change, and the new
  `SharedArrayBuffer` cannot leave its thread.
- **(a) later, as an explicit opt-in** (`allowWebAssembly: true`, a literal `true` like `allowAnimations`) once the owner
  accepts the WebKit residual as a ledger row, or WebKit fixes it. That change carries the shared-buffer tests, the
  bootstrap probe and its reason, the host-policy row, the ledger rows (`webassembly-unsafe-eval` corrected here,
  `webassembly-termination` new) and M1 to M4 as e2e. Loop instrumentation (wrapping `WebAssembly.Module` and
  `instantiate*` in the prelude and rewriting the bytes) would work on (a) too and is the only real gain of (b); it stays
  a research item.
- **Not (b):** a large ABI and toolchain friction, and it fixes nothing (a) does not except shared memory.

## 4. The WebKit termination residual

- **What.** A worker stuck in a pure WebAssembly loop survives `Worker.terminate()` and the removal of the frame that
  made it, on WebKit 26 (the Linux build Playwright ships), until the page closes. It keeps one core busy. Each `reset()`
  after such a loop would leave another one (expected, not run). A JS loop and a WebAssembly loop that calls a JS import each turn both stop at once,
  so the engine can interrupt a worker at a call into JS and cannot interrupt WebAssembly code.
- **What it cannot do.** Nothing in the library or the measurements lets the orphan act: any call out to
  JS ends it (row 3 of M4), and the library's ports are closed with the frame (expected, not run).
- **What it costs.** Availability only, but not bounded by anything the library states: only by the page's life. Under
  the owner's availability rule that is a cost the embedder cannot end, so a board would rate it high.
- **Where it is not.** Chromium and Firefox stop the loop (M4). Safari on macOS may differ from the Linux build; not
  measured.
- **Today.** Strict mode deletes `WebAssembly`, so a guest cannot write the loop. With `scriptUnsafe` (`'unsafe-eval'`)
  WebAssembly stays in strict mode and the same loop is expected on WebKit; not measured with that keyword. Worth one
  line in the ledger even if (c) holds.
- **To report.** The M4 case of `measure.spec.ts` (the pure loop, with and without `terminate()`) is the reproduction to
  hand to WebKit.

## Rerun

On demand only: the spec skips without `WEB_SANDBOX_MEASURE`, because the M4 cases take about 20 s each and read the CPU of
the browser's process tree.

```sh
# one engine at a time; check `cut -d' ' -f1 /proc/loadavg` is under 6 first
WEB_SANDBOX_MEASURE=1 bunx playwright test docs/research/24_sealed_mode/measure.spec.ts --project=chromium --workers=1
WEB_SANDBOX_MEASURE=1 bunx playwright test docs/research/24_sealed_mode/measure.spec.ts --project=firefox --workers=1
WEB_SANDBOX_MEASURE=1 bunx playwright test docs/research/24_sealed_mode/measure.spec.ts --project=webkit --workers=1
```

A machine with `HTTPS_PROXY` or `NO_PROXY` set can fail WebKit's page loads; unset them for the run. Each case prints a
`MEASURED {json}` line and attaches it as an annotation. The spec asserts only what is the same on every engine (§3.2:
what runs, that `eval` stays refused, that no `SharedArrayBuffer` reaches the view, that a JS loop and a loop that
calls an import stop); what differs per engine, the pure WebAssembly loop included, is recorded. It branches on no engine.

Run on 2026-10-24: 9 of 9 passed on each of Chromium, Firefox and WebKit.

**Caveats.** Headless browsers on a shared 4-core VM; the load average at the start of each run was 5.0 (Chromium), 5.6
(Firefox) and 5.4 (WebKit), and 3.7 to 6.8 at the start of the individual M4 cases, which the runs themselves raise. The
same results came from an earlier run of the probes at a load of 8 to 10. The CPU figures are the machine's; the claims rest on whether a loop goes on. WebKit is Playwright's
Linux build. The policies are `<meta>` policies in the view and a response header on the host page, as the library
delivers them; nothing here ran the library.

## Not measured

Safari on macOS and iOS; WebAssembly with `'unsafe-eval'` (the loop on WebKit under `scriptUnsafe`); a WebAssembly
`SharedArrayBuffer` in a cross-origin isolated page (sealed refuses such a page); a canvas the worker draws into
(`transferControlToOffscreen()`, [research 23 §4](../23_view_input/README.md#4-later-each-with-a-probe-of-its-own)).

Files: `measure.spec.ts`.
