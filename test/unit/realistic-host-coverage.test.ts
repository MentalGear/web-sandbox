import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INHERITED_CONTEXT, inheritedContextRows, type InheritedContextId } from '@src/lib/inherited-context';
import { TERMINATION_REASONS } from '@src/lib/reasons';
import {
    CSP_DIRECTIVES, DIRECTIVE_CASES, ENGINES, EXCLUDED, HEADER_CASES, MATRIX_WARNINGS, matrixRows, type MatrixCase, type Outcome,
} from '../e2e/directive-matrix';

/**
 * The host page's context is covered by the e2e suite on a host that looks like a production app (S74, class A;
 * test/e2e/realistic-host.ts): every row of INHERITED_CONTEXT is named by at least one assertion of the realistic-host spec
 * (`covering('row', …)` in its message) or covered by a case of the directive matrix (directive-matrix.ts, a values table), and the
 * matrix classifies every CSP directive the docs and the inventory name, so a new directive must be classified.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const SPEC = read('test/e2e/realistic-host.spec.ts');
const MATRIX_SPEC = read('test/e2e/directive-matrix.spec.ts');
const API = read('docs/API.md');

const rowIds = Object.keys(INHERITED_CONTEXT) as InheritedContextId[];

/** The rows an assertion of the realistic-host spec names: `covering('row', …)`. */
const namedBySpec = (): Set<string> => new Set([...SPEC.matchAll(/covering\('(\w+)', [`'"]/g)].map(match => match[1]!));

describe('INHERITED_CONTEXT coverage by the realistic host and the directive matrix', () => {
    it.each(rowIds.map(id => [id] as const))('%s: at least one assertion of the realistic-host spec, or one case of the directive matrix, names it', (id) => {
        expect(namedBySpec().has(id) || matrixRows().has(id), `${id} is covered by neither test/e2e/realistic-host.spec.ts nor test/e2e/directive-matrix.ts`).toBe(true);
    });

    it('every row named by an assertion or a case is a row of the inventory', () => {
        for (const id of [...namedBySpec(), ...matrixRows()]) expect(rowIds as string[], id).toContain(id);
    });

    it('the realistic-host spec runs every mode, and the matrix spec runs every case of the table', () => {
        for (const mode of ['strict', 'cooperative', 'worker']) expect(SPEC, mode).toContain(`mode: '${mode}'`);
        expect(MATRIX_SPEC).toContain('Object.entries(DIRECTIVE_CASES)');
        expect(MATRIX_SPEC).toContain('of HEADER_CASES');
        expect(MATRIX_SPEC).toContain('outcomeOn(matrixCase, browserName)');
    });
});

describe('the directive matrix classifies every directive', () => {
    const excluded = Object.keys(EXCLUDED);
    const cased = Object.keys(DIRECTIVE_CASES);

    it('each directive of the closed list is excluded with a reason or has cases, never both', () => {
        for (const directive of CSP_DIRECTIVES) {
            const isExcluded = excluded.includes(directive);
            const hasCases = cased.includes(directive);
            expect(isExcluded !== hasCases, `${directive} must be in EXCLUDED or in DIRECTIVE_CASES, exactly one`).toBe(true);
        }
        expect([...excluded, ...cased].sort()).toEqual([...CSP_DIRECTIVES].sort());
        for (const [directive, why] of Object.entries(EXCLUDED)) expect(why.length, directive).toBeGreaterThan(20);
    });

    // A directive the docs or the inventory name must be in the closed list. (The list itself is the CSP specifications'; a
    // directive outside it that a doc starts to name fails here until it is classified.)
    const DIRECTIVE_SHAPE = /^[a-z]+(?:-[a-z]+)*(?:-src|-src-elem|-src-attr|-uri|-action|-ancestors|-types|-for)$/;
    const directivesIn = (text: string): string[] => [...text.matchAll(/`([a-z][a-z-]+)(?: [^`]*)?`/g)].map(match => match[1]!).filter(name => DIRECTIVE_SHAPE.test(name));

    it('the directives of the host page policy table in docs/API.md are all in the list', () => {
        const start = API.indexOf('\n## Host page policy');
        const section = API.slice(start, API.indexOf('\n## ', start + 1));
        const firstCells = section.split('\n').filter(line => line.startsWith('| ')).map(line => line.split('|')[1]!);
        const named = firstCells.flatMap(directivesIn);
        expect(named.length).toBeGreaterThan(8);
        for (const directive of named) expect(CSP_DIRECTIVES as readonly string[], directive).toContain(directive);
    });

    it('the directives the inventory names are all in the list', () => {
        const named = inheritedContextRows().flatMap(row => directivesIn(`${row.channel} ${row.how}`));
        expect(named).toEqual(expect.arrayContaining(['script-src', 'worker-src', 'style-src', 'base-uri', 'connect-src', 'require-trusted-types-for', 'trusted-types']));
        for (const directive of named) expect(CSP_DIRECTIVES as readonly string[], directive).toContain(directive);
    });

    it('every case names a row, an outcome with a named reason or a named warning, and engines of the suite', () => {
        const cases: [string, MatrixCase][] = [
            ...Object.entries(DIRECTIVE_CASES).flatMap(([directive, list]) => (list as readonly MatrixCase[]).map(entry => [`${directive} ${entry.value}`, entry] as [string, MatrixCase])),
            ...HEADER_CASES.map(entry => [`${entry.header} ${entry.value}`, entry] as [string, MatrixCase]),
        ];
        expect(cases.length).toBeGreaterThan(CSP_DIRECTIVES.length - excluded.length - 1);
        const outcomeIsNamed = (label: string, outcome: Outcome) => {
            if (outcome.kind === 'terminates') {
                expect(Object.keys(TERMINATION_REASONS), `${label}: a reason of the registry`).toContain(outcome.reason);
                expect(TERMINATION_REASONS[outcome.reason].text, `${label}: a reason with a fixed text`).not.toContain('…');
            } else {
                if (outcome.warns) expect(MATRIX_WARNINGS, label).toContain(outcome.warns);
                expect(['ok', 'refused'], label).toContain(outcome.bridge);
            }
        };
        for (const [label, entry] of cases) {
            expect(rowIds as string[], `${label}: a row`).toContain(entry.row);
            outcomeIsNamed(label, entry.outcome);
            for (const [engine, outcome] of Object.entries(entry.engines ?? {})) {
                expect(ENGINES as readonly string[], `${label}: ${engine}`).toContain(engine);
                outcomeIsNamed(`${label} on ${engine}`, outcome);
            }
        }
        // no two cases of one directive have the same value
        for (const [directive, list] of Object.entries(DIRECTIVE_CASES)) {
            const values = (list as readonly MatrixCase[]).map(entry => entry.value);
            expect(new Set(values).size, directive).toBe(values.length);
        }
    });
});
