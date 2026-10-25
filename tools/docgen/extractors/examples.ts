/**
 * The runnable examples the docs quote: docs/API.md's "Building an app in sealed mode" shows the files of
 * examples/sealed-app/ as they are, so the page cannot drift from the code test/e2e/sealed-app.spec.ts runs.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Extractor } from './markdown';

const ROOT = path.resolve(import.meta.dirname, '../../..');

/** The region names and the file each one quotes, with the language of its code block. */
export const EXAMPLE_REGIONS = {
    'example:sealed-app-html': { file: 'examples/sealed-app/app.html', language: 'html' },
    'example:sealed-app-css': { file: 'examples/sealed-app/app.css', language: 'css' },
    'example:sealed-app-guest': { file: 'examples/sealed-app/app.js', language: 'js' },
    'example:sealed-app-host': { file: 'examples/sealed-app/host.js', language: 'js' },
} as const satisfies Record<string, { file: string; language: string }>;

const quote = ({ file, language }: { file: string; language: string }): string =>
    `\`\`\`${language}\n${readFileSync(path.join(ROOT, file), 'utf8').replace(/\n+$/, '')}\n\`\`\``;

export const examples: Extractor = {
    regions: Object.fromEntries(Object.entries(EXAMPLE_REGIONS).map(([name, source]) => [name, () => quote(source)])),
    items: () => [],
};
