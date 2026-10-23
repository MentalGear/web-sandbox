import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { indexItems } from '../../tools/docgen/engine';
import { plugin } from '../../tools/docgen/docs';
import { ID_CITATION } from '../../docs/ids';
import { headerSentence, moduleFiles } from '../../tools/docgen/extractors/modules';
import { run } from '../../tools/docgen/run';

/**
 * This repository's generated docs (tools/docgen/docs.ts): every region equals what the code renders and no marker is
 * stale (the same check as `bun run docs:check`, so the unit run sees it too), the regions the docs rely on are there,
 * and every module has the header comment the module map is drawn from.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

/** The regions each document carries: deleting one would otherwise go unseen, since an absent region is never stale. */
const REGIONS: Record<string, string[]> = {
    'docs/API.md': [
        'configuration', 'csp-cooperative', 'csp-strict', 'host-lines', 'termination-reasons', 'limits', 'budgets', 'cookie-facts', 'connect-facts', 'host-source-rules', 'trusted-types-rules',
        // rendered from the TSDoc of the public API (tools/docgen/extractors/api.ts)
        'api-define', 'api-element', 'api-methods', 'api-reactions', 'api-events', 'api-sandbox-log', 'api-violation', 'api-fetch-record',
        'api-fetch-bridge', 'api-call-limits', 'api-exports-values', 'api-exports-types',
    ],
    'docs/ADR-005-strict-mode.md': ['adr005-ports', 'adr005-init-view'],
    'docs/THREAT-MODEL.md': ['cookie-facts', 'connect-facts', 'inherited-context'],
    'README.md': ['cookie-sentence', 'connect-sentence'],
    'ARCHITECTURE.md': ['realms', 'stringified', 'channels', 'frames', 'lifecycle-states', 'lifecycle-diagram', 'lifecycle-inputs', 'lifecycle-effects', 'module-map'],
};

describe('the generated docs', () => {
    it('are what the code renders, and no handwritten section is stale', () => {
        const lines: string[] = [];
        const result = run(ROOT, plugin, ['--check'], line => lines.push(line));
        expect(lines, 'bun run docs:gen rewrites the regions; a stale marker is accepted with bun run docs:gen --accept').toEqual([]);
        expect(result.exitCode).toBe(0);
    });

    it.each(Object.entries(REGIONS))('%s carries its regions', (file, names) => {
        const text = read(file);
        for (const name of names) {
            expect(text, name).toContain(`<!-- generated:begin ${name} -->`);
            expect(plugin.regions?.[name], `${name} has an extractor`).toBeDefined();
        }
        const used = [...text.matchAll(/^<!-- generated:begin ([\w:.-]+) -->$/gm)].map(match => match[1]!);
        expect(used.sort()).toEqual([...names].sort());
    });

    it('every item a marker names exists, and the sections that describe code carry markers', () => {
        const items = indexItems(plugin);
        for (const file of ['docs/API.md', 'docs/ADR-005-strict-mode.md', 'ARCHITECTURE.md']) {
            const markers = [...read(file).matchAll(/^<!-- describes: (.*?) sig:[0-9a-f]+ -->$/gm)];
            expect(markers.length, file).toBeGreaterThan(0);
            for (const marker of markers) for (const id of marker[1]!.split(',').map(id => id.trim())) expect(items.has(id), `${file}: ${id}`).toBe(true);
        }
        // ARCHITECTURE.md: each section of prose that describes generated facts says which
        const architecture = read('ARCHITECTURE.md');
        for (const heading of ['Modes and realms', 'Strict mode: the worker and the view', 'Channels and frames', 'The lifecycle: one reducer, one executor', 'Budgets']) {
            const section = architecture.slice(architecture.indexOf(`\n## ${heading}\n`) + 1).split(/\n## /)[0]!;
            expect(section, heading).toMatch(/<!-- describes: [^>]+ sig:[0-9a-f]+ -->/);
        }
    });

    it('the module map has a role for every module, from its header comment', () => {
        const missing = moduleFiles().filter(file => headerSentence(read(file)) === undefined);
        expect(missing, 'open the file with a comment that says what the module is, in a sentence').toEqual([]);
        expect(headerSentence('/**\n * The widget table (S76): what it is\n * for. More.\n */\nexport const x = 1;')).toBe('The widget table: what it is for');
        expect(headerSentence('import { a } from "./a";\nimport {\n    b,\n} from "./b";\n\n/** Builds b. Second. */\nexport const y = 1;')).toBe('Builds b');
        expect(headerSentence('// Small helpers: one.\n// More.\nexport const z = 1;')).toBe('Small helpers: one');
        expect(headerSentence('export const w = 1;')).toBeUndefined();
    });

    it('a registry ID in a header sentence, in any of its forms, never reaches the module map (one source of the ID syntax: docs/ids.ts)', () => {
        const role = (text: string) => headerSentence(`/**\n * ${text}\n */\nexport const x = 1;`);
        expect(role('The broker (BL:B1) for calls, as R5:M-2 and AR:C3 found. More.')).toBe('The broker for calls, as and found');
        const section = `ADR-005${'#ports'}`; // an anchored ADR form; built, so that doc-links does not resolve it as a citation
        expect(role(`The cap (${section}, LM-2): what it holds. More.`)).toBe('The cap: what it holds');
        expect(role('Caps the table (backlog B1) and the view (S76, review round 4). More.')).toBe('Caps the table and the view');
        for (const file of moduleFiles()) expect(headerSentence(read(file))?.match(ID_CITATION) ?? [], file).toEqual([]);
    });
});
