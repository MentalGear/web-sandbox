import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Build } from '@src/lib/build-flag';
import { pageDocumentUrl } from './library';

/**
 * Sealed mode's served file as the e2e server serves it (vite.config.ts): the bytes the build wrote into its output
 * directory, read in the test's process. The specs compare what the browser holds with this, never with a text the test
 * process generates from the sources: its transpiler prints the view's functions its own way, so the bootstrap, and the
 * hash the policy holds of it, would be another text than the build's.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');

/** The file of `build`, as bytes. */
export const servedFileBytes = (build: Build = 'default'): Buffer => readFileSync(path.join(ROOT, pageDocumentUrl(build).slice(1)));

/** The file's one `<meta>` policy, as the parser reads its attribute. */
export function servedFilePolicy(build: Build = 'default'): string {
    const text = servedFileBytes(build).toString('utf8');
    const content = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(text)![1]!;
    return content.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}
