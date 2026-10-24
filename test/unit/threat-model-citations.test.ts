import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THREAT-MODEL's tables cite the tests that keep a guarantee and a class closed (S74 board, pass 3; BD3:DOC-7 and
 * BD3:DOC-8, class C: docs of a registry). A cited file exists; a row cites a file that exercises what the row says (the
 * bridge's `BRIDGE_INIT` rule was cited to a test that has none); and the classes the document lists are the ones
 * CONTRIBUTING and research 18 define, class A included.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const MODEL = read('docs/THREAT-MODEL.md');

/** The lines of a `## ` section of the threat model that start a table row. */
function tableRows(heading: string, from = 0): string[] {
    const start = MODEL.indexOf(heading, from);
    expect(start, heading).toBeGreaterThan(-1);
    const end = MODEL.indexOf('\n## ', start + heading.length);
    return MODEL.slice(start, end === -1 ? undefined : end).split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| :') && !line.startsWith('| Property') && !line.startsWith('| Class'));
}

const cells = (row: string) => row.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim());
const repositoryFiles = (text: string) => [...text.matchAll(/`((?:test|src|docs)\/[^`\s:]+\.(?:ts|md))/g)].map(match => match[1]!);

describe('the security properties table', () => {
    const rows = tableRows('\n## Security properties').map(cells).filter(row => row.length >= 5 && repositoryFiles(row[3]!).length > 0);

    it('cites only files that exist, in its chokepoint and its test columns', () => {
        expect(rows.length).toBeGreaterThan(30);
        const missing = rows.flatMap(row => [...repositoryFiles(row[2]!), ...repositoryFiles(row[3]!)].filter(file => !existsSync(path.join(ROOT, file))).map(file => `${row[0]!.slice(0, 50)}: ${file}`));
        expect(missing).toEqual([]);
    });

    it("the bridge port's row cites the test that exercises its BRIDGE_INIT rule (BD3:DOC-7)", () => {
        const row = rows.find(candidate => candidate[0]!.startsWith("The fetch bridge's port reaches only the library's code"))!;
        expect(row, 'the row').toBeDefined();
        expect(row[1]).toContain('BRIDGE_INIT');
        const tested = repositoryFiles(row[3]!).filter(file => read(file).includes('BRIDGE_INIT'));
        expect(tested, 'a cited test names BRIDGE_INIT').toContain('test/unit/in-bridge-frame.test.ts');
    });
});

describe('the classes (BD3:DOC-8)', () => {
    const classes = tableRows('**Classifying.**').map(cells).filter(row => row.length === 3);

    it('the table has a row for each class the sentence above it names, class A with its inventory and its tests', () => {
        const names = classes.map(row => row[0]!);
        expect(names).toEqual(['E-net', 'E-cpu', 'P', 'G', 'L', 'C', 'B', 'A', 'D']);
        const sentence = MODEL.slice(MODEL.indexOf('**Classifying.**'), MODEL.indexOf('| Class | Chokepoint')).replace(/\s+/g, ' ');
        for (const name of names) expect(sentence, name).toMatch(name === 'A' ? /\bA \(the host page's context/ : new RegExp(`\\b${name} \\(`));
        const a = classes.find(row => row[0] === 'A')!;
        expect(a[1]).toContain('INHERITED_CONTEXT');
        expect(repositoryFiles(a[2]!)).toEqual(expect.arrayContaining(['test/unit/inherited-context.test.ts', 'test/unit/realistic-host-coverage.test.ts']));
    });

    it('every file a class row cites exists', () => {
        const missing = classes.flatMap(row => [...repositoryFiles(row[1]!), ...repositoryFiles(row[2]!)].filter(file => !existsSync(path.join(ROOT, file))).map(file => `${row[0]}: ${file}`));
        expect(missing).toEqual([]);
    });

    it('CONTRIBUTING and research 18 name class A, with the inventory', () => {
        expect(read('CONTRIBUTING.md')).toContain('class A, the host page\'s context a sandbox document inherits (`INHERITED_CONTEXT`');
        expect(read('docs/research/18_finding_classes/README.md')).toMatch(/\| \*\*A\*\*: the host page's context a sandbox document inherits \|.*INHERITED_CONTEXT/);
    });
});
