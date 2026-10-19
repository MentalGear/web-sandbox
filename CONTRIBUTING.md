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
bun run api:check    # the public API against its reviewed report, etc/web-sandbox.api.md; api:update accepts a change
./scripts/smoke-package.sh   # bun pm pack, install into a scratch project, type-check and bundle
```

CI runs all of the above, with the e2e suite and the probes on Chromium, Firefox and WebKit.

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

Such a finding is at most medium. Its fix is a bound in docs/API.md (with measured examples, as "Measured figures" below
says), "The view's cost to the host page" (or
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

## Code and docs: the current state

The code and the docs say what holds now, and why. How it came to be is history: it lives in the review reports, the
ADRs' amendments and the done backlog items (moving to `docs/archive/`), and in git, which is the final archive.

**A comment** says what the code guarantees and why, briefly, and cites the decision or finding behind it by a stable
ID. It does not tell the code's story: no commit, date, review round, PR or phase, nothing the code "used to" do or
"no longer" does, and no measurement of code that is gone. A measured number stays only where it justifies a constant
today. The story of a change goes in its commit message and in the matching report.

**Stable IDs.** Every ID resolves to a file and an anchor (`<a id="…">` on the row or header that defines it), through
the registry [docs/ids.ts](docs/ids.ts):

| Form | Names | Example |
| :--- | :--- | :--- |
| `R1:`, `R2:`, `R3:`, `R4:`, `R5:` and the finding's own ID | a finding of that review round | `R5:M-2`, `R1:R3-6` |
| `AR:`, `BR:`, `FR:`, `VR:` and the finding's own ID | a finding of the adversarial, broad and focused reviews and the verification | `BR:CB1` |
| `S<n>`, `T<n>`; `BL:` for the B, C, D and H series | a backlog item | `S76`, `BL:D1` |
| `ADR-<nnn>`, `ADR-<nnn>#<heading anchor>` | an ADR, or one of its sections | `ADR-005` |
| `LM-<n>` | a finding of the lifecycle model (research 17) | `LM-2` |

A finding ID alone (`M-2`) names rows in several reports, so it resolves to none: write the prefixed form. A new report
gets an entry in the registry and an anchor on each finding.

**Values first, types derived.** What a doc renders or a test compares exists once, as a runtime value
(`CONFIG_SCHEMA`, `CHANNEL_BUDGETS`, the egress table), and its types are derived from it (`as const`, `typeof`,
`satisfies`). No doc, comment or test keeps its own hand-written copy of such a list.

**Measured figures.** A doc states each bound, from the code that sets it, and a test asserts it. A measured figure may
stand beside the bound as an example, with its date and engine; it is never generated, and no test pins it.

**The guards**, in the unit run and CI:
- `bun run api:check`: the public API against its reviewed report, [etc/web-sandbox.api.md](etc/web-sandbox.api.md);
  `bun run api:update` accepts a change, which the PR then shows.
- `test/unit/doc-links.test.ts`: every relative link and anchor in the Markdown files, and every ID in the registry's
  forms cited in `src/`, `test/` and the docs, resolves.

## Style

See [`agents.md`](agents.md) for the code style. `bun run format` applies Prettier; `bun run format:check`
reports drift (not yet enforced in CI, since most existing files predate the config).
