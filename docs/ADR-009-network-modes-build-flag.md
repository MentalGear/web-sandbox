# ADR-009: The network modes behind a build flag — the package is sealed mode alone

**Status**: Accepted · **Date**: 2026-11-14

## Context

Sealed mode is the default and the review board's whole scope ([ADR-008](ADR-008-sealed-mode.md)). The other three modes
stayed in the package beside it: cooperative mode, worker mode, and strict mode with its network options, `origins` and
`fetchBridge`. Seven passes of the board found their data findings mostly at the edges of that code, which sealed mode
does not need, and `src/` grew 38% across the passes ([research 22](research/22_review_trajectory/README.md)). The
subtraction pass before pass 8 found little left to remove inside sealed mode; the large removals would be those modes.
The owner's decision ([research 24](research/24_sealed_mode/README.md), D9): they stay as they are, behind a build flag
that is off by default.

The point is that what ships by default is what is reviewed. A run-time check that refuses the other modes would leave
their code in the bundle, so it does not achieve that.

## Decision

**The package has two builds, chosen by one flag, `WEB_SANDBOX_NETWORK_MODES`, which is off by default.**

```sh
bun run build:lib                               # the default build: sealed mode alone
WEB_SANDBOX_NETWORK_MODES=1 bun run build:lib   # the network build: every mode
```

1. **One flag, declared once.** `NETWORK_MODES_FLAG` (`src/lib/build-flag.ts`) names the environment variable, its one
   `on` value, the modes behind it (`strict`, `cooperative`, `worker`) and the options behind it (`origins`,
   `fetchBridge`). The build script, the declarations' emit, the config schema, the tests' pairing and the docs read
   that value; none names the variable itself. The modes behind it are called the **network modes**: they are the modes
   that take the options that open the network.
2. **Two entries, and a module graph for each.** The default build's entry is `src/index.ts`; the network build's is
   `src/network.ts`, which exports everything the default one does (`src/sealed.ts`) and installs the network modes as
   it is imported. Every module of `src/` is classified once (`BUILD_MODULES`, `src/lib/build-modules.ts`): `sealed`
   (every build), `network` (the network build only) or `data` (a registry no build imports). The default entry may
   reach `sealed` modules only. Nothing decides at run time which code a build holds: the default entry has no import
   that leads to a network module, so its bundle cannot hold one. `scripts/build-lib.ts` checks the bundler's own report
   of the modules it kept code of against the build's list, and writes no bundle that holds another's.
3. **The seam.** The element (`src/host.ts`) is one class. What the network modes add to it are methods
   (`NetworkMethods`, `src/lib/network-host.ts`: the builds of cooperative and worker mode's document and of strict
   mode's view with its network, the fetch bridge's start, the announcement, `execute()`'s frame and deadline), which
   the network build installs on the element's prototype, and four values in one slot (`src/lib/network-modes.ts`: the
   two config rules, the reader of the host page, the detail of an `origins` refusal, and the fetch bridge frame's part
   of the hashed bootstrap). The class calls seven of those methods by name, each only where the build has it: through
   one accessor that is null while the slot is empty, and for the lifecycle's one effect through the class's prototype,
   as every effect is reached (BR:CB7). The default build never fills the slot and installs nothing, so each such call
   is skipped and the element has none of the methods. The moved methods kept their text.
4. **Strict mode is behind the flag whole, not only its network options.** D9 names "strict mode's network options".
   Strict mode without them differs from sealed mode by `scriptUnsafe`, `execute()` and its deadline, and
   `connect-src blob:`: the testing switches that sealed mode refuses because a string run as code is checked against
   the host page's policy (BD6:ISO-1). Keeping that mode in the default build would ship exactly the code the board does
   not review, so the default build has one mode. This reading of D9 is the owner's to confirm.
5. **Fail closed, in the config schema.** In the default build a config that names a network mode, or `origins` or
   `fetchBridge` with any value but `undefined`, is refused whole before any option is read
   (`networkModesOffRefusal`, the mechanism of ADR-008's refusal): nothing of it is applied, and the sandbox terminates
   with the reason `networkModesOff`, which names the flag and the command. It is never read as sealed mode and never
   stripped of the option. The schema still declares both options (their defaults and modes, which the docs render);
   their two rules are the network modes', and the default build has no rule to run for them in any mode.
6. **The types say the same.** `SandboxConfig` is the config of one of the modes the build has:
   `SandboxConfigByMode[keyof SandboxConfigByMode]`, an interface that holds `sealed` in the default build's
   declarations and that the network build's declarations extend with the three other modes (declaration merging, as
   `HTMLElementTagNameMap` is extended). `StrictSandboxConfig`, `CooperativeSandboxConfig`, `WorkerSandboxConfig`,
   `NetworkSandboxOptions`, `SandboxOrigins`, `StrictSandboxOrigins`, `FetchBridgeConfig`, `FetchRecord`,
   `FetchErrorCode`, `FETCH_ERROR_CODES`, the `fetch` event and the unsafe capabilities are exports of the network
   build only, so in the default build `{ mode: 'strict' }` is a type error, as it is a refusal at run time.
7. **The hashed bootstrap is each build's own.** The library has one hashed script. In the network build it runs the
   view, or the fetch bridge's frame where its script element has that role, as before, and its hash is the one it was.
   The default build has no bridge frame, so its bootstrap is the view alone and `viewScriptHash()` returns another
   value. A host page's policy lists the hash of the build it ships.
8. **Each test runs against its build, and the wrong pairing fails.** A unit test's build is its imports: a file that
   tests a network mode imports `@src/network`, and any other file's element is the default build's, where a network
   config is refused. An e2e test names its build (`test.use({ build })`, default `'default'`); the fixture tells every
   page of the test, the harness pages load that build's entry, and `setConfig()` of every element on the page throws on
   a config that is the other build's to test (`pairWithBuild`, `test/e2e/fixture.ts`). Each test still runs once.

## Alternatives considered

- **A run-time refusal alone.** The code stays in the bundle and in the reviewed surface's way.
- **A constant the bundler folds** (`if (__NETWORK_MODES__) …`, as the view bootstrap's literal is baked in), with
  dead-code elimination. The default build would hold whatever the bundler failed to remove, which only a scan of the
  bundle could find; a class's methods are never removed; and the unbundled sources (the dev server, the unit tests)
  would need the constant defined in each tool. Two entries need none of that: the wrong state cannot be built.
- **A second export path** (`web-sandbox/network`) with both bundles in the package. Then the network modes ship by
  default, which is what D9 ends. An embedder who needs them builds the package with the flag.
- **A subclass of the element for the network build.** The lifecycle reaches the element's methods through the class's
  own prototype, because Firefox gives an adopted element another one (BR:CB7), and the declarations would show a second
  class with protected members.
- **Module functions that take the element**, in place of installed methods. The tests and probes that reach the
  element's methods by name would each need another way in, and the moved code would be rewritten instead of moved.

## Consequences

- **What the default build is** (measured on 2026-11-14, Bun 1.4.4, unminified as shipped): `dist/index.js` went from
  598 445 to 511 171 bytes (146 569 to 122 548 gzipped; 15 374 to 13 303 lines), and the `src/` modules its entry reaches
  at run time from 52 modules of 20 430 lines to 47 of 17 302. The network build's bundle is 606 789 bytes (148 407
  gzipped) and its entry reaches 62 modules of 20 804 lines; `src/` as a whole grew from 23 847 to 24 489 lines (the
  seam, the two registries, the entries and the headers of the new modules). Of the default bundle, 61 306 bytes are the
  module lexer with which the file store rewrites the import specifiers of registered JavaScript files, in every mode's
  snapshot; a sealed worker loads no module (its entry is a classic script, and `import()` is refused), so that may be
  a further subtraction. It is not made here: it would change what the file store hands every mode.
- **What it is not yet.** Three things of the network modes are still in the default bundle, each unreachable there and
  held by a test: the branches for cooperative and worker mode inside the functions the library stringifies for every
  mode (`inSandboxScript`, the broker), which the default build calls with the literal `'strict'` and `sealed` only; the
  lifecycle reducer's inputs for an announced port; and the parameter by which strict mode hands the view its network
  (`_prepareViewFrame`, `_getStrictWorkerSource`), which the default build gives `null`. Cutting them means two
  versions of the guest's bootstrap, which is sealed mode's reviewed code. The default build's declarations also hold
  the fetch bridge's (`lib/fetch-bridge.d.ts`), reached for a type through the limits registry; no entry exports them.
- **What an embedder sees.** The package as published has sealed mode alone; a config of another mode ends with a reason
  that says how to build with the flag ([Builds](API.md#builds)). The network build's API is what it was.
- **Two public surfaces to review.** `bun run api:check` holds each build's against its own report:
  `etc/web-sandbox.api.md` (the default build) and `etc/web-sandbox.network.api.md`.

### Revisit if

- the network modes are removed, or folded into sealed mode with opt-ins of their own (S49): then the flag goes with them;
- sealed mode moves to served documents (D8): its build path changes, and the seam stays where it is;
- a consumer needs both builds from one install: then the second export path, and what it ships by default.
