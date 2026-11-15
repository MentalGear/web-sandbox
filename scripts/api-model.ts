/**
 * Keeps the checked-in copies of api-extractor's doc models equal to what the builds write: etc/web-sandbox.api.json
 * (the default build) and etc/web-sandbox.network.api.json (the build with the network modes; ADR-009). The docs
 * generator and the TSDoc coverage test read the copies, so they need no build; this is the guard that no copy is stale.
 * Run by `bun run api:check` (check) and `bun run api:update` (update), after api-extractor has run for both builds.
 *
 *   check   fails, naming the fix, when a copy differs from the model in temp/
 *   update  writes the copies
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILDS, type Build } from '../src/lib/build-flag';

const ROOT = join(import.meta.dir, '..');

/** The doc model's file name of each build: in temp/ as api-extractor writes it, in etc/ as it is kept. */
export const MODEL_FILES = { default: 'web-sandbox.api.json', network: 'web-sandbox.network.api.json' } as const satisfies Record<Build, string>;

const builtOf = (build: Build) => join(ROOT, 'temp', MODEL_FILES[build]);
const keptOf = (build: Build) => join(ROOT, 'etc', MODEL_FILES[build]);

/** Whether the kept copy equals the built model: both must exist. */
export function modelIsCurrent(built: string = builtOf('default'), kept: string = keptOf('default')): boolean {
    return existsSync(built) && existsSync(kept) && readFileSync(built, 'utf8') === readFileSync(kept, 'utf8');
}

if (import.meta.main) {
    const mode = process.argv[2];
    if (mode === 'update') {
        for (const build of BUILDS) {
            copyFileSync(builtOf(build), keptOf(build));
            console.log(`api model: etc/${MODEL_FILES[build]} written`);
        }
    } else if (mode === 'check') {
        const stale = BUILDS.filter(build => !modelIsCurrent(builtOf(build), keptOf(build)));
        if (stale.length > 0) {
            console.error(`api model: ${stale.map(build => `etc/${MODEL_FILES[build]}`).join(' and ')} ${stale.length === 1 ? 'is' : 'are'} not what the build wrote (a declaration or its TSDoc changed). Run \`bun run api:update\`, and commit the files with the docs they change (\`bun run docs:gen\`).`);
            process.exit(1);
        }
        console.log(`api model: ${BUILDS.map(build => `etc/${MODEL_FILES[build]}`).join(' and ')} are current`);
    } else {
        console.error('usage: bun scripts/api-model.ts check|update');
        process.exit(2);
    }
}
