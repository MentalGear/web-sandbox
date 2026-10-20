/**
 * Keeps etc/web-sandbox.api.json, the checked-in copy of api-extractor's doc model, equal to what the build writes.
 * The docs generator and the TSDoc coverage test read the copy, so they need no build; this is the guard that the copy
 * is not stale. Run by `bun run api:check` (check) and `bun run api:update` (update), after api-extractor.
 *
 *   check   fails, naming the fix, when the copy differs from temp/web-sandbox.api.json
 *   update  writes the copy
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const BUILT = join(ROOT, 'temp', 'web-sandbox.api.json');
const KEPT = join(ROOT, 'etc', 'web-sandbox.api.json');

/** Whether the kept copy equals the built model: both must exist. */
export function modelIsCurrent(built: string = BUILT, kept: string = KEPT): boolean {
    return existsSync(built) && existsSync(kept) && readFileSync(built, 'utf8') === readFileSync(kept, 'utf8');
}

if (import.meta.main) {
    const mode = process.argv[2];
    if (mode === 'update') {
        copyFileSync(BUILT, KEPT);
        console.log('api model: etc/web-sandbox.api.json written');
    } else if (mode === 'check') {
        if (!modelIsCurrent()) {
            console.error('api model: etc/web-sandbox.api.json is not what the build wrote (a declaration or its TSDoc changed). Run `bun run api:update`, and commit the file with the docs it changes (`bun run docs:gen`).');
            process.exit(1);
        }
        console.log('api model: etc/web-sandbox.api.json is current');
    } else {
        console.error('usage: bun scripts/api-model.ts check|update');
        process.exit(2);
    }
}
