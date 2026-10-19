import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { count, type Counts } from './history-scan';

/**
 * The history ratchet (CONTRIBUTING.md, "Code and docs: the current state"): comments say what holds now, so the
 * comment lines that tell the code's story, and the finding IDs cited with no prefix, are counted per file of src/ and
 * test/, and no count may rise above its baseline. The patterns are the strict ones only: each matches history in
 * nearly every use. Plain "before" and "was" are left out, as they are mostly current-state prose.
 *
 * When counts fall, the test passes and prints how to lower the baseline:
 *   WEB_SANDBOX_RATCHET=update bunx vitest run test/unit/history-ratchet.test.ts
 * which rewrites the baseline file with the current counts, and only when none rose.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASELINE_FILE = 'test/unit/history-ratchet.baseline.json';

describe('the history ratchet', () => {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'test'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n').filter(file => /\.(ts|mjs|js)$/.test(file) && existsSync(path.join(ROOT, file))).sort();
    const current = count(files, file => readFileSync(path.join(ROOT, file), 'utf8'));
    const baseline = JSON.parse(readFileSync(path.join(ROOT, BASELINE_FILE), 'utf8')) as Counts;

    it('no file has more history lines or bare finding IDs in its comments than its baseline', () => {
        const rose: string[] = [];
        const fell: string[] = [];
        for (const kind of ['history', 'bareIds'] as const) {
            for (const file of new Set([...Object.keys(current[kind]), ...Object.keys(baseline[kind])])) {
                const now = current[kind][file] ?? 0, was = baseline[kind][file] ?? 0;
                if (now > was) rose.push(`${file}: ${kind} ${was} -> ${now}`);
                if (now < was) fell.push(`${file}: ${kind} ${was} -> ${now}`);
            }
        }
        if (!rose.length && fell.length) {
            if (process.env.WEB_SANDBOX_RATCHET === 'update') {
                writeFileSync(path.join(ROOT, BASELINE_FILE), `${JSON.stringify(current, null, 2)}\n`);
                console.log(`history ratchet: ${BASELINE_FILE} lowered:\n  ${fell.join('\n  ')}`);
            } else {
                console.log(`history ratchet: counts fell below the baseline:\n  ${fell.join('\n  ')}\nLower it (and commit the file):\n`
                    + `  WEB_SANDBOX_RATCHET=update bunx vitest run test/unit/history-ratchet.test.ts`);
            }
        }
        expect(rose, 'say what holds now, and cite the finding by its ID (CONTRIBUTING.md, "Code and docs: the current state")').toEqual([]);
    });

    it('counts what it should, and the scanner reads only comments', () => {
        const sample = [
            '// the cap holds at 256 calls (R5:M-2)',
            '// fixed in abc1234',
            '/* since PR C the budget is shared',
            ' * and it used to drop the frame (M-2, R3-6) */',
            'const text = "round 4, 2026-10-19, M-2"; // in a string: not counted',
        ].join('\n');
        expect(count(['x.ts'], () => sample)).toEqual({ history: { 'x.ts': 3 }, bareIds: { 'x.ts': 2 } });
        expect(files.length).toBeGreaterThan(150);
    });
});
