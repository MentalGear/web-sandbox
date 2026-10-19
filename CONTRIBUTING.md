# Contributing

This project uses [Bun](https://bun.sh) for everything: installing, running scripts, building and packing.

```bash
bun install
bun run dev          # playground at http://localhost:4444/playground/index.html
bun run typecheck    # tsc over src, tests, playground and research specs
bun run test         # unit (vitest) then e2e (playwright; builds the package first)
WEB_SANDBOX_MODEL_RUNS=2000 bun run test:e2e test/e2e/lifecycle-model.spec.ts  # nightly: the lifecycle model suite at 2000 sequences per engine (CI runs 40)
bun run test:probes  # the strict-mode design probes (research 15) ADR-005 rests on, on their own server
bun run build:lib    # dist/: bundled ESM + type declarations
./scripts/smoke-package.sh   # bun pm pack, install into a scratch project, type-check and bundle
```

CI runs all of the above, with the e2e suite and the probes on Chromium, Firefox and WebKit.

## End-to-end tests

A run always tests its own checkout (backlog T8), so several checkouts and worktrees can run the suite on one machine:

```bash
bun run test:e2e                                   # every spec, all three engines
bunx playwright test test/e2e/basic.spec.ts --project=firefox
WEB_SANDBOX_E2E_PORT=24000 bun run test:e2e        # pick the port yourself
```

- **The port.** CI serves on 4444. Locally the port is derived from the checkout's absolute path, in 20000–29999
  (`test/e2e/server.ts`; `bun -e 'import("./test/e2e/server.ts").then(m => console.log(m.E2E_ORIGIN))'` prints it), and
  `WEB_SANDBOX_E2E_PORT` overrides it. Specs never name a port: they use `ORIGIN` and `HARNESS` from
  `test/e2e/fixture.ts`, or a path relative to `baseURL`. `bun run dev` stays on 4444.
- **Reuse.** Locally Playwright reuses a server that is already running, but only one that answers
  `/__e2e-root?root=<this checkout>` with 200: the e2e server of this very checkout (`vite.config.ts`). Any other server
  answers 409 (or 404, a `bun run dev` or a checkout from before this), so Playwright starts this checkout's own; if the
  port is taken, the run stops with "Port … is already in use" rather than testing another checkout's code. Free the port
  or set `WEB_SANDBOX_E2E_PORT`. A reused server serves `dist/` as it was built when it started: rebuild
  (`bun run build:lib`) before running `package.spec.ts` against it.
- **Discovery.** Specs are found under the checkout's own `test/e2e/` and `docs/research/`; anything under the
  checkout's own `.claude/` (nested worktrees, scratch copies) is ignored, by a pattern anchored at the checkout's root,
  so a checkout that itself lives under another one's `.claude/worktrees/` still finds its specs.

## Security changes

Every mitigation has a reproduction under `docs/research/NN_*/reproduce.spec.ts` that **fails against
the vulnerable code** and passes with the fix. Add one with any security change, and check that it
fails before your fix (revert the fix locally and run it).

The attack itself is a preset in `src/lib/presets.ts` (`category: 'security'`, `research: 'NN_*'`, and a
`target` URL if it reaches for the network), so the playground can replay it; the reproduction runs it
with `fromPreset('<id>')` from `test/e2e/presets.ts`, aiming the target at a recorder listener with
`aimedAt()`. `test/unit/presets.test.ts` fails if a security preset has no spec or a reproduction no preset.

All specs run on the shared harness in `test/e2e/fixture.ts`; drive the sandbox through
`SandboxDriver`, not through the playground.

## Fixing a finding

Every fix names the class of its finding ([research 18](docs/research/18_finding_classes/README.md)), and extends
that class's single list or chokepoint and its structural test. A fix for one instance only is not done. The classes
that stopped producing findings were each closed by replacing a list of bad cases with a list of allowed ones, plus a
test that enumerates the domain:
- typed origins;
- the worker-globals allowlist;
- captured intrinsics with their source scan;
- the snapshot measure and the frame builders.

A new mitigation (a stylesheet, a rewrite, a listener) is a new cost: measure it on every engine, as the code it guards
is measured.

### Availability findings (owner's rule, 2026-10-19)

A finding whose only effect is that the guest slows the host page (CPU share, stalls, memory) is **documented, not
mitigated further**, when both hold:
- the cost is bounded: by a documented limit, or by the caps on what the view and the guest can hold;
- the embedder can end it: `terminate()`, or removing the element, gives the host page back.

Such a finding is at most medium. Its fix is a measured bound in docs/API.md, "The view's cost to the host page" (or
the section of the surface it concerns), with what the embedder can do about it, and the figure in the cost column of
its channel in the [budgets table](docs/API.md#budgets) (`CHANNEL_BUDGETS` in `src/lib/egress.ts`, which the table is
generated from and a unit test keeps in step). The view shares the host page's thread
on Firefox, WebKit and Android, so no budget of the library's removes that cost: past a stated bound, chasing it gives
diminishing returns.

These are **not** availability findings, and are fixed as any other:
1. a host page frozen beyond the embedder's reach: it cannot regain control, or the stall has no bound but the
   browser's (high);
2. the library's own limits ending a healthy sandbox (a correctness bug);
3. a flood that breaks a security property: a budget that fails open, a check skipped under pressure, state left
   inconsistent, anything that moves data or crosses the policy.

## Style

See [`agents.md`](agents.md) for the code style. `bun run format` applies Prettier; `bun run format:check`
reports drift (not yet enforced in CI, since most existing files predate the config).
