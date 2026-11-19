/**
 * Which build each module of src/ belongs to (research 24, D9; ADR-009): the allowlist of the default build, with its
 * domain enumerated. Every module is classified, by hand, as one of:
 *
 * - `sealed`: sealed mode's, which every build has. The default build's entry (src/index.ts) may import these and no
 *   other, at run time or for a type.
 * - `network`: the network modes' (strict, cooperative and worker mode, `origins`, `fetchBridge`). Only the network
 *   build's entry (src/network.ts) reaches them; they may import `sealed` modules, never the reverse.
 * - `data`: a registry that only the tests, the docs and the playground read. No build imports it.
 *
 * test/unit/default-build.test.ts holds the code to it: every file of src/ has a row and every row a file, the module
 * graph of each entry stays inside its classes, and the built default bundle is made of `sealed` modules alone
 * (scripts/build-lib.ts refuses to write one that is not). A module that moves between classes changes its row here,
 * which the review of that change sees.
 *
 * Not imported by the library: a registry, read by the build script, the tests and the docs.
 */
import type { Build } from './build-flag';

/** What a module is part of: sealed mode (every build), the network modes (the network build), or no build (`data`). */
export type ModuleClass = 'sealed' | 'network' | 'data';

export const BUILD_MODULES = {
    'src/csp-directives.ts': 'sealed',
    'src/devtools.ts': 'sealed',
    'src/host.ts': 'sealed',
    'src/index.ts': 'sealed',
    'src/network.ts': 'network',
    'src/sealed.ts': 'sealed',
    'src/lib/app-start.ts': 'sealed',
    'src/lib/app-surface.ts': 'data',
    'src/lib/auto-resize.ts': 'sealed',
    'src/lib/bridge-frame.ts': 'network',
    'src/lib/build-flag.ts': 'sealed',
    'src/lib/build-modules.ts': 'data',
    'src/lib/capabilities.ts': 'sealed',
    'src/lib/code-from-strings.ts': 'sealed',
    'src/lib/config-schema.ts': 'sealed',
    'src/lib/connect-facts.ts': 'data',
    'src/lib/cookie-facts.ts': 'network',
    'src/lib/css-references.ts': 'sealed',
    'src/lib/egress.ts': 'sealed',
    'src/lib/element-events.ts': 'sealed',
    'src/lib/engine-ledger.ts': 'data',
    'src/lib/entry-imports.ts': 'sealed',
    'src/lib/environment-check.ts': 'sealed',
    'src/lib/environment.ts': 'sealed',
    'src/lib/fetch-bridge.ts': 'network',
    'src/lib/fetch-method.ts': 'sealed',
    'src/lib/files.ts': 'sealed',
    'src/lib/frame-documents.ts': 'sealed',
    'src/lib/frames.ts': 'data',
    'src/lib/guest-values.ts': 'data',
    'src/lib/guest-writes.ts': 'sealed',
    'src/lib/host-passes.ts': 'data',
    'src/lib/host-site.ts': 'network',
    'src/lib/import-map.ts': 'network',
    'src/lib/in-bridge-frame.ts': 'network',
    'src/lib/in-sandbox-files.ts': 'sealed',
    'src/lib/in-sandbox-script.ts': 'sealed',
    'src/lib/in-sandbox-view.ts': 'sealed',
    'src/lib/inherited-context.ts': 'data',
    'src/lib/lifecycle-transitions.ts': 'data',
    'src/lib/lifecycle.ts': 'sealed',
    'src/lib/limits.ts': 'data',
    'src/lib/load-kinds.ts': 'sealed',
    'src/lib/long-timer.ts': 'sealed',
    'src/lib/markup-references.ts': 'network',
    'src/lib/markup-scripts.ts': 'network',
    'src/lib/minted-errors.ts': 'sealed',
    'src/lib/module-specifiers.ts': 'sealed',
    'src/lib/network-config.ts': 'network',
    'src/lib/network-host.ts': 'network',
    'src/lib/network-install.ts': 'network',
    'src/lib/network-modes.ts': 'sealed',
    'src/lib/network-types.ts': 'network',
    'src/lib/origin.ts': 'sealed',
    'src/lib/presets.ts': 'data',
    'src/lib/rate-limit.ts': 'sealed',
    'src/lib/realms.ts': 'data',
    'src/lib/reasons.ts': 'sealed',
    'src/lib/request-gate.ts': 'network',
    'src/lib/references.ts': 'sealed',
    'src/lib/rpc.ts': 'sealed',
    'src/lib/sandbox-log.ts': 'sealed',
    'src/lib/sealed-reach.ts': 'data',
    'src/lib/srcset.ts': 'network',
    'src/lib/structured-size.ts': 'sealed',
    'src/lib/style-markup.ts': 'sealed',
    'src/lib/trusted-types.ts': 'sealed',
    'src/lib/utils.ts': 'sealed',
    'src/lib/violation.ts': 'sealed',
    'src/lib/watchdog.ts': 'sealed',
    'src/lib/worker-bootstrap.ts': 'network',
    'src/lib/worker-globals.ts': 'sealed',
    'src/lib/csp/csp-generator.ts': 'sealed',
    'src/lib/csp/host-connect.ts': 'network',
    'src/lib/csp/host-trusted-types.ts': 'sealed',
    'src/lib/csp/origin-kinds.ts': 'sealed',
    'src/lib/csp/origins.ts': 'network',
    'src/lib/csp/policy-text.ts': 'sealed',
    'src/lib/csp/script-hash.ts': 'sealed',
} as const satisfies Record<string, ModuleClass>;

export type SourceModule = keyof typeof BUILD_MODULES;

/** The classes of module a build's entry may reach: the default build sealed mode's alone, the network build both. */
export const BUILD_CLASSES = {
    default: ['sealed'],
    network: ['sealed', 'network'],
} as const satisfies Record<Build, readonly ModuleClass[]>;

/** The modules of `build`: the ones its entry may reach. */
export const modulesOf = (build: Build): SourceModule[] =>
    (Object.keys(BUILD_MODULES) as SourceModule[]).filter(file => (BUILD_CLASSES[build] as readonly ModuleClass[]).includes(BUILD_MODULES[file]));
