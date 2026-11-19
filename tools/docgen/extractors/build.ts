/**
 * The package's builds (ADR-009), from the build flag (src/lib/build-flag.ts) and the classification of the modules
 * (src/lib/build-modules.ts): docs/API.md's Builds table, the command that turns the flag on, and the module counts of
 * each build.
 */
import { signatureOf, type Item } from '../engine';
import { BUILD_ENTRIES, BUILDS, NETWORK_MODES_FLAG, type Build } from '../../../src/lib/build-flag';
import { BUILD_CLASSES, BUILD_MODULES, modulesOf } from '../../../src/lib/build-modules';
import { code, codeList, row, table, type Extractor } from './markdown';

const COMMANDS = { default: 'bun run build:lib', network: NETWORK_MODES_FLAG.command } as const satisfies Record<Build, string>;
const MODES = { default: ['sealed'], network: ['sealed', ...NETWORK_MODES_FLAG.modes] } as const satisfies Record<Build, readonly string[]>;
const HAS = {
    default: `sealed mode alone; \`${NETWORK_MODES_FLAG.options.join('` and `')}\` are refused`,
    network: `every mode, with \`${NETWORK_MODES_FLAG.options.join('` and `')}\``,
} as const satisfies Record<Build, string>;

const items = (): Item[] => [
    { id: 'build-flag', signature: signatureOf({ flag: NETWORK_MODES_FLAG, entries: BUILD_ENTRIES, classes: BUILD_CLASSES }), render: () => '' },
    { id: 'build-modules', signature: signatureOf(BUILD_MODULES), render: () => '' },
];

export const build: Extractor = {
    items,
    regions: {
        builds: () => table(['Build', 'How it is built', 'Entry', 'Modes', 'What it has'], BUILDS.map(name => row([
            name === 'default' ? 'default (the package as published)' : 'network',
            code(COMMANDS[name]),
            code(BUILD_ENTRIES[name]),
            codeList(MODES[name]),
            `${HAS[name]}; ${modulesOf(name).length} modules of \`src/\``,
        ]))),
        'build-flag-command': () => ['```sh', COMMANDS.network, '```'].join('\n'),
    },
};
