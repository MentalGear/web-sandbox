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
bun run docs:check   # the generated regions and the sections' markers against the code; docs:gen rewrites the regions
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
- **What the host page has left.** A spec that measures the host page's ticks, a busy share or its longest stall uses
  `test/e2e/host-share.ts` (the best of N windows against the page's own idle baseline, the documented bounds, the
  stall meter), never a meter of its own: `test/unit/host-share.test.ts` fails on one (backlog T9). One window on each
  side measures the machine's load as the code's (T7).
- **Scaling in a unit test.** A unit test that asserts a cost is linear uses `scalingRatio` from `test/unit/scaling.ts`
  (the sizes sampled alternately, each one's fastest time kept, sampling continued while the ratio is over its bound),
  never a best-of-N or a ratio of clock reads of its own: `test/unit/host-share.test.ts` fails on one (backlog T9).
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

### Availability findings (owner, 2026-10-20)

A finding whose only effect is that the guest slows the host page (CPU share, stalls, memory) is **documented, not
mitigated further**, when both hold:
- the cost is bounded: by a documented limit, or by the caps on what the view and the guest can hold;
- the embedder can end it: `terminate()`, or removing the element, gives the host page back.

Such a finding is at most medium. Its fix is a bound in docs/API.md (with measured examples, as "Measured figures" below
says), "The view's cost to the host page" (or
the section of the surface it concerns), with what the embedder can do about it, and the bound in the cost column of
its channel in the [budgets table](docs/API.md#budgets) (a share, a cap or a constant; a measured figure goes in the note
under the table, dated, with its engines); `CHANNEL_BUDGETS` in `src/lib/egress.ts` is what the table is
generated from. The view shares the host page's thread
on Firefox, WebKit and Android, so no budget of the library's removes that cost: past a stated bound, chasing it gives
diminishing returns.

These are **not** availability findings, and are fixed as any other:
1. a host page that can never regain control, or a stall bounded by nothing the library states (no cap, no limit,
   only the browser's) (high). A single-operation stall whose cost is bounded by the documented caps, and which the
   repeated-overrun rule ends at its second occurrence (`VIEW_OVERRUN_WINDOW_MS`), is a documented availability cost
   (at most medium), not this;
2. the library's own limits ending a healthy sandbox (a correctness bug);
3. a flood that breaks a security property: a budget that fails open, a check skipped under pressure, state left
   inconsistent, anything that moves data or crosses the policy.

## Code and docs: the current state

The code and the docs say what holds now, and why. How it came to be is history: it lives in the review reports, the
ADRs' amendments and the done backlog items (in [docs/archive/](docs/archive/README.md), where a stable ID leads), and
in git, which is the final archive. Reports and finished items are moved there, never deleted, and the archive is not
kept in step with the code. The backlog lists open items only: finishing one moves it to the archive and takes its ID
out of `OPEN_BACKLOG_ITEMS` in the registry.

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
gets an entry in the registry and an anchor on each finding; once it is closed, it moves to `docs/archive/reviews/`, its
registry entry changes with it, and no citation does.

**TSDoc on the public API.** Every export of `src/index.ts`, every member of its classes and interfaces, every parameter
(`@param name - …`) and every returned value (`@returns`) has its TSDoc, and the docs state what holds now: behaviour,
units, defaults (`@defaultValue`), bounds, what refuses or throws (`@throws`) and which event fires. The summary is one
or two sentences; the rest goes under `@remarks`. Related exports are linked with `{@link Name}` (the members of
`WebSandbox` are written as code, since the class and its interface share a name); a registry ID may be cited where the
reader needs the background. `test/unit/tsdoc-coverage.test.ts` fails on a gap, and docs/API.md's reference parts are
rendered from this text ([below](#generated-docs-and-their-markers)).

**Values first, types derived.** What a doc renders or a test compares exists once, as a runtime value
(`CONFIG_SCHEMA`, `CHANNEL_BUDGETS`, the egress table), and its types are derived from it (`as const`, `typeof`,
`satisfies`). No doc, comment or test keeps its own hand-written copy of such a list.

**Measured figures.** A doc states each bound, from the code that sets it, and a test asserts it. A measured figure may
stand beside the bound as an example, with its date and engine; it is never generated, and no test pins it.

**The guards**, in the unit run and CI:
- `bun run api:check`: the public API against its reviewed report, [etc/web-sandbox.api.md](etc/web-sandbox.api.md),
  and the checked-in doc model [etc/web-sandbox.api.json](etc/web-sandbox.api.json) (the declarations with their TSDoc,
  which the generated reference reads) against what the build writes; `bun run api:update` accepts a change, which the PR
  then shows.
- `bun run docs:check`: every generated region equals what the code renders, and no handwritten section is stale
  ([below](#generated-docs-and-their-markers)).
- `test/unit/doc-links.test.ts`: every relative link and anchor in the Markdown files, and every ID in the registry's
  forms cited in `src/`, `test/` and the docs, resolves.
- `test/unit/history-ratchet.test.ts`: per file of `src/` and `test/`, the comment lines that tell history and the bare
  finding IDs, counted against `test/unit/history-ratchet.baseline.json`. A count may only fall; when one does, the
  test prints how to lower the baseline.

## Generated docs and their markers

The facts the docs state are rendered from the values the code declares, by the generator in `tools/docgen/`: its
engine knows nothing of this repository, and the extractors in `tools/docgen/extractors/` read the registries
(`LIMITS`, `CONFIG_SCHEMA`, `FRAMES`, `LC_INPUTS` and the rest). [ARCHITECTURE.md](ARCHITECTURE.md), the tables of
docs/API.md and the port table of ADR-005 are built this way.

- **Regions.** The lines between `<!-- generated:begin NAME -->` and `<!-- generated:end -->` (each marker on a line of
  its own, in any Markdown file) are rewritten from the extractor called NAME by `bun run docs:gen`. Text outside a
  region is never touched. Do not edit a region: change the value in the code (or the extractor's own words, for the
  Configuration table's prose, `tools/docgen/extractors/config-docs.ts`), and run `bun run docs:gen`.
- **The public API's reference** (docs/API.md's registration, the element's property and methods, the events and their
  details, the `fetchBridge` and `callLimits` tables and the lists of exports) is rendered from the TSDoc of the exports,
  by `tools/docgen/extractors/api.ts`, from api-extractor's doc model: [etc/web-sandbox.api.json](etc/web-sandbox.api.json),
  checked in so that `docs:check` needs no build. After you change a declaration or its TSDoc, run `bun run api:update`
  (it also accepts the API report's change, which the PR shows), then `bun run docs:gen`. Write the TSDoc as the page
  should say it: a citation of a finding or an item goes in parentheses by itself (the page leaves it out), an ADR
  becomes a link, and `docs/API.md#slug` a link within the page. A new method is placed in the page's order in
  `METHOD_ORDER`, and a new event needs its row in `ELEMENT_EVENTS`, with "Bubbles." or "Does not bubble." in its doc.
- **Markers.** A handwritten section that describes code starts with `<!-- describes: ID, ID sig:HASH -->`. The hash is
  taken from the described items' semantic signatures: names, types, values and transitions, never formatting or
  wording. An export of the public API is the item `api:Name` (`api:WebSandbox.setConfig` for a member); a container's
  signature has its members', so a section about the element goes stale when a method is added.
- **When a marker fails.** `bun run docs:check` (CI runs it) names the section and the items that changed. Read the
  section against the change; fix any sentence that is now wrong; then run `bun run docs:gen --accept`, which writes the
  new hashes, and commit them with the section. Accepting without reading defeats the marker, whose only job is to
  put the prose a change made stale in front of the reviewer. A new thing to describe is a new item in an extractor, with
  a signature that changes when its meaning does.

## Style

See [`agents.md`](agents.md) for the code style. `bun run format` applies Prettier; `bun run format:check`
reports drift (not yet enforced in CI, since most existing files predate the config).
