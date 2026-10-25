# ADR-008: Sealed mode — the default has no network

**Status**: Accepted · **Date**: 2026-10-24

## Context

Strict mode ([ADR-005](ADR-005-strict-mode.md)) took guest script out of every document, and the review rounds that
followed found no data finding in it through R2 to R5. The S74 board's passes then reviewed it on a realistic host page,
and the data findings came back, one more each pass: 2, 3, 4 and 5 in BD1 to BD4
([research 22](research/22_review_trajectory/README.md)). Every one of them that reached strict mode needed one of its
two network options, `origins` or `fetchBridge`, except two that were fixed for every mode by a construction (BD2:ISO-1,
BD2:CHL-1) and one docs example (BD4:NEW-2). They came from the code that adapts the network to the host page: the
host-site decision, the narrowing by the host page's `connect-src`, the cookie and connect fact tables. That code
predicts what the browser will do on the host page, and each prediction was a new place for a finding.

Research 22's trigger asked for a default whose review does not depend on that code.
[Research 24](research/24_sealed_mode/README.md) measured what would remain if the default had no network at all: the
same view, worker, renderer and bootstrap, with no network code on the build's path, and a policy that admits no network
source. About 2 500 lines of `src/` leave the default's path, and the host page is asked one value, `crossOriginIsolated`,
only to refuse.

## Decision

**`mode: 'sealed'` is the default. It is strict mode with no network.** A config that names no `mode` is sealed. Strict
mode keeps its network and is named with `mode: 'strict'`.

```js
sandbox.setConfig({ entry: 'main.js' });                                              // sealed: no network
sandbox.setConfig({ mode: 'strict', entry: 'main.js', fetchBridge: { allow: ['https://api.example'] } }); // the network
```

1. **No network, by construction.** The view's policy comes from its own template, `sealedViewPolicy`, whose input has no
   `origins` key: every fetch directive is `'none'`, or `blob:` for a kind of registered file, and `connect-src` is
   `'none'` always (the worker reads its files with `sandboxFiles.read()`, which makes no request). The build takes a
   path of its own (`_prepareSealedFrame`) that reaches no host-site, host-policy, origin-parsing or bridge code; the
   request gate's list is empty, so every `fetch`, `XMLHttpRequest` and `WebSocket` is refused and reported, on every
   engine; there is no bridge frame; `sandboxFetch()` stays defined and rejects with `FETCH_NOT_ALLOWED` in the guest's
   realm. The config schema runs no rule of a network option for a sealed config, so it reads nothing of the host page.
2. **A sealed config that names a network option is refused.** `origins` or `fetchBridge`, with any value but
   `undefined`, with `mode: 'sealed'` written or with no `mode`, refuses the whole config: nothing of it is applied, and
   the sandbox terminates with the reason ``origins and fetchBridge open the network, which sealed mode (the default)
   does not have: set `mode: 'strict'` ``. It is never read as strict mode (one key would change the mode, and open the
   network, where a reader of the config cannot see it) and never stripped (an app that relied on its network would
   lose it quietly). An option outside its modes is otherwise ignored with a warning; that rule fits options that only
   narrow, and these two would widen the mode.
3. **The types say the same.** `SandboxConfig` is a union keyed by `mode`. `SealedSandboxConfig` is the member with an
   optional `mode` and `origins?: never`, `fetchBridge?: never`; `StrictSandboxConfig`, `CooperativeSandboxConfig` and
   `WorkerSandboxConfig` require their `mode` and extend `NetworkSandboxOptions`, which carries `fetchBridge`. So `{}`
   is a sealed config, and `{ origins }` or `{ fetchBridge }` without `mode: 'strict'` is a type error.
4. **No WebAssembly** in sealed mode, as in strict mode: the worker's `WebAssembly` stays deleted. WebKit does not stop a
   pure WebAssembly loop when the worker is terminated or its frame removed (research 24, M4), so `terminate()` would
   lose its promise there. An `allowWebAssembly` opt-in may follow once that residual is accepted or fixed.
5. **The review board's scope is sealed mode** at its default configuration, with its own opt-ins (`allowAnimations`,
   `allowAutoplay`, `guestWrites`, `autoResize`, `watchdogTimeout`, `workerExecutionTimeout`, `capabilities`,
   `callLimits`). A data finding that reaches only strict mode's network options does not count against a clean pass:
   it is fixed, or documented as a limit of those options, as cooperative mode's findings are
   ([S74](BACKLOG.md#s74)).

## Alternatives considered

- **Keep strict mode the default, sealed opt-in.** The board would keep reviewing the network code at the default, and an
  embedder who needs no network would still have to know to ask for less.
- **Infer strict mode from `origins` or `fetchBridge`.** A config's mode would depend on which keys it names, and
  `{}` would match two members of the union; one added key would open the network silently.
- **Drop the network options from a no-mode config, with a warning.** An app written for strict mode would build and
  lose its network at run time, with one console line to say so.
- **A served-document mode** ([research 20](research/20_served_document_mode/README.md)), with a document of its own
  origin instead of `srcdoc`. Shelved: sealed mode answers research 22's trigger with the code that exists.

## Consequences

- **What leaves the default's path**: the host-site and host-policy decisions, the cookie and connect fact tables,
  `origins` parsing, the fetch bridge and its frame, the request gate's allow path, network URLs in the renderer
  (research 24, §1). Of the 18 rows of the host page's inherited context, 5 do not apply in sealed mode, 1 is reduced and
  12 remain, each failing closed with a reason or costing availability only
  ([THREAT-MODEL](THREAT-MODEL.md#the-host-pages-context)).
- **What an embedder sees**: an embed with no `mode` and no network option builds sealed mode, the same view, worker and
  API, and a script in its `html` still never runs. One with `origins` or `fetchBridge` and no `mode` is refused with
  the reason above, and a type error in TypeScript; the fix is `mode: 'strict'`
  ([migration](API.md#migrating-to-sealed-as-the-default)). A guest `fetch()` of its own file's URL is refused in sealed
  mode (`connect-src` has no `blob:`); `sandboxFiles.read()` reads the file.
- **What the app gives up**: every request. The host is its only way out, through the methods it `expose()`s, so those
  methods are the whole surface an attacker reaches: copy arguments with spread and validate each one.
- **Two modes share one view**, so drift between them is the risk. The tests that hold sealed mode to "no network" each
  fail if a network path reaches it, whatever the path (research 24's test plan): the type and the schema
  (`test/unit/sealed-mode.test.ts`), the policy template over every subset of file kinds (the same file), the build's
  wiring and a call-graph scan of its path (`test/unit/sealed-build.test.ts`), the default
  (`test/unit/default-mode.test.ts`, `test/e2e/default-mode.spec.ts`), and on Chromium, Firefox and WebKit a listener
  that must see nothing from every request maker the guest can reach (`test/e2e/sealed-no-network.spec.ts`) and the
  directive matrix on the realistic host. The strict specs that use no network run in both modes
  (`test/e2e/view-modes.ts`).

### Revisit if

- WebKit stops a pure WebAssembly loop on termination, or the owner accepts that residual: then `allowWebAssembly`;
- an app needs a host-pushed file other than a raster image without a rebuild, or more than the 8 MiB file quota;
- a finding reaches sealed mode through the host page's context: then the row of `INHERITED_CONTEXT` it belongs to, and
  the construction that closes it in every mode.
