# Contributing

This project uses [Bun](https://bun.sh) for everything: installing, running scripts, building and packing.

```bash
bun install
bun run dev          # playground at http://localhost:4444/playground/index.html
bun run typecheck    # tsc for the app and the service worker
bun run test         # unit (vitest) then e2e (playwright; builds the package first)
bun run build:lib    # dist/: bundled ESM + type declarations
./scripts/smoke-package.sh   # bun pm pack, install into a scratch project, type-check and bundle
```

CI runs all of the above, with the e2e suite on Chromium, Firefox and WebKit.

## Security changes

Every mitigation has a reproduction under `docs/research/NN_*/reproduce.spec.ts` that **fails against
the vulnerable code** and passes with the fix. Add one with any security change, and check that it
fails before your fix (revert the fix locally and run it).

All specs run on the shared harness in `test/e2e/fixture.ts`; drive the sandbox through
`SandboxDriver`, not through the playground.

## Style

See [`agents.md`](agents.md) for the code style. `bun run format` applies Prettier; `bun run format:check`
reports drift (not yet enforced in CI, since most existing files predate the config).
