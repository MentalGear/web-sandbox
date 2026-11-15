/**
 * The build flag of the network modes (research 24, D9; ADR-009): the one switch that decides which of the package's two
 * builds `bun run build:lib` writes. Declared once, here: the build reads it (scripts/build-lib.ts), the config schema
 * refuses with it, the tests pair every spec with its build from it, and the docs are rendered from it.
 *
 * - Off, the default: the package is sealed mode alone. Its entry is src/index.ts, whose module graph holds no module
 *   of the network modes (BUILD_MODULES, src/lib/build-modules.ts; test/unit/default-build.test.ts), so their code is
 *   not in dist/index.js and their types are not in its declarations. A config that names one of `modes`, or one of
 *   `options`, is refused whole, with a reason that names the flag (config-schema.ts).
 * - On: the entry is src/network.ts, which installs the network modes into the element (network-modes.ts) and exports
 *   their types. Strict, cooperative and worker mode, `origins` and `fetchBridge` are then what they were before the
 *   flag existed.
 */
export const NETWORK_MODES_FLAG = {
    /** The environment variable `bun run build:lib` reads: `1` builds the network modes in; anything else, or unset, does not. */
    env: 'WEB_SANDBOX_NETWORK_MODES',
    /** The one value that turns the flag on. */
    on: '1',
    /** Off unless the variable holds `on`. */
    default: false,
    /** The modes behind the flag: every mode but sealed. */
    modes: ['strict', 'cooperative', 'worker'],
    /** The options behind the flag, which open the network: sealed mode has neither. */
    options: ['origins', 'fetchBridge'],
    /** The command that builds the package with the flag on, as a refusal's reason and the docs say it. */
    command: 'WEB_SANDBOX_NETWORK_MODES=1 bun run build:lib',
} as const;

/** A build of the package: `default` (the flag off: sealed mode alone) or `network` (the flag on: every mode). */
export const BUILDS = ['default', 'network'] as const;
export type Build = (typeof BUILDS)[number];

/** The entry module of each build: what `bun run build:lib` bundles into dist/index.js, and emits the declarations of. */
export const BUILD_ENTRIES = { default: 'src/index.ts', network: 'src/network.ts' } as const satisfies Record<Build, string>;

/** The build a value of the flag's environment variable asks for: `network` for the flag's one `on` value, else `default`. */
export const buildFor = (value: string | undefined): Build => (value === NETWORK_MODES_FLAG.on ? 'network' : 'default');

/** The build that has `mode`: the default build has sealed mode (a config with no mode is sealed), the network build the others. */
export const buildOfMode = (mode: unknown): Build => ((NETWORK_MODES_FLAG.modes as readonly unknown[]).includes(mode) ? 'network' : 'default');
