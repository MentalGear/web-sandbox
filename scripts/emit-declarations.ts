/**
 * Emits the declarations of the build the flag names (src/lib/build-flag.ts; ADR-009) into dist/, with tsc: the
 * default build's from src/index.ts (tsconfig.build.json), the network build's from src/network.ts
 * (tsconfig.build.network.json). Each program holds only what its entry reaches, so the default build's dist/ has no
 * declaration of a network mode's module.
 *
 * The package's `types` is dist/index.d.ts in both builds. tsc emits the network build's entry as dist/network.d.ts,
 * and nothing as dist/index.d.ts (src/index.ts is not in that program), so this writes the one line that makes
 * dist/index.d.ts the network build's entry. Run by `bun run build:lib` after scripts/build-lib.ts, before
 * scripts/declaration-specifiers.ts gives the specifiers their extensions.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { BUILD_ENTRIES, buildFor, NETWORK_MODES_FLAG, type Build } from '../src/lib/build-flag';

const ROOT = join(import.meta.dir, '..');

/** The tsc project that emits each build's declarations. */
export const DECLARATION_PROJECTS = { default: 'tsconfig.build.json', network: 'tsconfig.build.network.json' } as const satisfies Record<Build, string>;

/** dist/index.d.ts of a build whose entry is not src/index.ts: the entry's declarations, re-exported. */
export const entryReexport = (entry: string): string => `export * from './${basename(entry, '.ts')}';\n`;

if (import.meta.main) {
    const build = buildFor(process.env[NETWORK_MODES_FLAG.env]);
    const emitted = spawnSync('bunx', ['tsc', '-p', DECLARATION_PROJECTS[build]], { cwd: ROOT, stdio: 'inherit' });
    if (emitted.status !== 0) process.exit(emitted.status ?? 1);
    const index = join(ROOT, 'dist', 'index.d.ts');
    if (BUILD_ENTRIES[build] !== BUILD_ENTRIES.default) {
        if (existsSync(index)) {
            console.error(`emit-declarations: the ${build} build's program emitted dist/index.d.ts: its entry must not reach src/index.ts`);
            process.exit(1);
        }
        writeFileSync(index, entryReexport(BUILD_ENTRIES[build]));
    }
    console.log(`emit-declarations: dist/index.d.ts, the ${build} build's (${BUILD_ENTRIES[build]})`);
}
