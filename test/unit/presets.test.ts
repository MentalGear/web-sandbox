import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESETS, type Preset } from '@src/lib/presets';

/**
 * Presets drive the regression specs (backlog T4). Specs reach a preset only through fromPreset('<id>')
 * (test/e2e/presets.ts); this test scans every spec file for those calls, so:
 *   - a preset in the 'security' category that no spec runs fails here;
 *   - a research reproduction (docs/research/NN_* /reproduce.spec.ts) that runs no preset fails here;
 *   - a preset naming a research folder whose reproduction does not run it fails here.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SPEC_DIRS = ['test/e2e', 'docs/research'];

function specFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const relative = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...specFiles(relative));
        else if (entry.name.endsWith('.spec.ts')) files.push(relative);
    }
    return files;
}

/** The preset ids a spec's source passes to fromPreset() as a string literal. */
export function presetReferences(source: string): string[] {
    const ids: string[] = [];
    for (const match of source.matchAll(/\bfromPreset\(\s*(['"`])([^'"`]+)\1\s*\)/g)) ids.push(match[2]!);
    return ids;
}

const specs = SPEC_DIRS.flatMap(specFiles).map(file => ({ file, source: readFileSync(path.join(ROOT, file), 'utf8') }));
const referencesBy = new Map(specs.map(spec => [spec.file, presetReferences(spec.source)]));
const allReferences = new Set([...referencesBy.values()].flat());
const presets: Preset[] = Object.values(PRESETS);

describe('the scan itself', () => {
    it('finds fromPreset() ids in either quote style and nothing else', () => {
        expect(presetReferences(`fromPreset('a'); fromPreset("b-c"); fromPreset( \`d\` ); fromPresets('x'); fromPreset(id); PRESETS['y']`)).toEqual(['a', 'b-c', 'd']);
    });

    it('sees the spec files', () => {
        expect(specs.length).toBeGreaterThan(20);
        expect(specs.some(spec => spec.file.startsWith('docs/research/'))).toBe(true);
    });
});

describe('presets drive the regression specs (backlog T4)', () => {
    it('every preset is filed under its own id, and every id a spec names exists', () => {
        for (const [key, preset] of Object.entries(PRESETS)) expect(preset.id, key).toBe(key);
        for (const id of allReferences) expect(Object.keys(PRESETS), id).toContain(id);
    });

    it('every security preset is run by at least one spec', () => {
        const unreferenced = presets.filter(preset => preset.category === 'security' && !allReferences.has(preset.id)).map(preset => preset.id);
        expect(unreferenced).toEqual([]);
    });

    it('every research reproduction runs a preset, and every preset that names a research folder is run by its reproduction', () => {
        const reproductions = specs.filter(spec => /^docs\/research\/[^/]+\/reproduce\.spec\.ts$/.test(spec.file.split(path.sep).join('/')));
        expect(reproductions.length).toBeGreaterThanOrEqual(14);
        for (const spec of reproductions) expect(referencesBy.get(spec.file), spec.file).not.toEqual([]);

        for (const preset of presets) {
            if (!preset.research) continue;
            const file = path.join('docs/research', preset.research, 'reproduce.spec.ts');
            expect(existsSync(path.join(ROOT, file)), `${preset.id}: ${file}`).toBe(true);
            expect(referencesBy.get(file), `${preset.id} is not run by ${file}`).toContain(preset.id);
        }
    });

    it('no spec reaches PRESETS around fromPreset()', () => {
        const direct = specs.filter(spec => /\bPRESETS\b/.test(spec.source)).map(spec => spec.file);
        expect(direct).toEqual([]);
    });

    it("a preset's target appears in its code and in every variant, so a spec can aim it", () => {
        for (const preset of presets) {
            if (!preset.target) continue;
            for (const payload of [preset.code, ...Object.values(preset.variants ?? {})]) {
                expect(payload, preset.id).toContain(preset.target);
            }
        }
    });
});

describe('scriptUnsafe only where a preset needs it (broad review I2)', () => {
    // scriptUnsafe grants 'unsafe-eval' to the guest; a preset is copied into playgrounds and specs, so it asks only for
    // what it uses: 'script' presets run through execute(), which needs it; markup presets need it only to evaluate strings.
    const EVALUATES = /\beval\s*\(|new\s+Function\b|\bFunction\s*\(|set(Timeout|Interval)\s*\(\s*['"`]/;
    it.each(Object.values(PRESETS as Record<string, Preset>).map(preset => [preset.id, preset] as const))('%s', (_, preset) => {
        const code = [preset.code, ...Object.values(preset.variants ?? {})].join('\n');
        const needed = preset.run === 'script' || EVALUATES.test(code);
        expect(preset.rules.scriptUnsafe === true, `${preset.id}: scriptUnsafe`).toBe(needed);
    });
});
