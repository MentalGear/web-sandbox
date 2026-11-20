import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { E2E_GROUP_VARIABLE, E2E_GROUPS, groupSelection, importsMeter, measuringSpecs, selectedGroup, specFiles, SPEC_GLOBS } from '../e2e/groups';

/**
 * Backlog T10: the e2e suite's two groups divide it, and the measuring group is derived from the specs' import of the one
 * meter (test/e2e/host-share.ts), so a spec that starts to measure the host page moves there with its import.
 */
const ROOT = path.resolve(__dirname, '../..');
const SPECS = specFiles(ROOT);
const MEASURING = measuringSpecs(ROOT);

const matchedBy = (patterns: readonly (string | RegExp)[], file: string) => {
    for (const pattern of patterns) {
        if (pattern instanceof RegExp && pattern.test(file)) return true;
    }
    return false;
};

describe('the measuring group is the specs that import the meter', () => {
    it('an import of host-share by any relative path is one; another module, or a mention in a comment, is not', () => {
        expect(importsMeter(`import { ticks } from './host-share';`)).toBe(true);
        expect(importsMeter(`import { busyOf } from "../../../test/e2e/host-share";`)).toBe(true);
        expect(importsMeter(`import {\n    lag,\n    startLag,\n} from './host-share';`)).toBe(true);
        expect(importsMeter(`import { meterHits } from './host-share-scan';`)).toBe(false);
        expect(importsMeter(`import { x } from './not-host-share';`)).toBe(false);
        expect(importsMeter(`// measured with host-share's ticks`)).toBe(false);
    });

    it('no spec outside the group names the meter\'s module in its code, in any form of import', () => {
        const missed: string[] = [];
        for (const file of SPECS) {
            if (MEASURING.includes(file)) continue;
            const code = readFileSync(file, 'utf8').split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
            if (/host-share(?!-)\b/.test(code)) missed.push(path.relative(ROOT, file));
        }
        expect(missed).toEqual([]);
    });

    it('the group is not empty, and each of its specs is one of the suite\'s', () => {
        expect(MEASURING.length).toBeGreaterThan(0);
        for (const file of MEASURING) expect(SPECS).toContain(file);
    });
});

describe('the two groups divide the suite', () => {
    const measuring = groupSelection('measuring', MEASURING);
    const rest = groupSelection('rest', MEASURING);

    it('what the measuring group matches is exactly what the rest leaves out', () => {
        for (const file of SPECS) {
            const inMeasuring = matchedBy(measuring.match, file);
            expect([path.relative(ROOT, file), inMeasuring]).toEqual([path.relative(ROOT, file), MEASURING.includes(file)]);
            expect(matchedBy(rest.ignore, file)).toBe(inMeasuring);
        }
        expect(measuring.ignore).toEqual([]);
        expect(rest.match).toEqual(SPEC_GLOBS);
    });

    it('a path that only contains a measuring spec\'s path is not matched', () => {
        const file = MEASURING[0];
        expect(matchedBy(measuring.match, `${file}.copy`)).toBe(false);
        expect(matchedBy(measuring.match, `/elsewhere${file}`)).toBe(false);
    });

    it('the whole suite leaves nothing out, and no selection sets the workers: every run is on Playwright\'s default, half of the cores', () => {
        expect(groupSelection(null, MEASURING)).toEqual({ match: SPEC_GLOBS, ignore: [] });
        for (const selection of [measuring, rest]) expect(Object.keys(selection).sort()).toEqual(['ignore', 'match']);
        expect(readFileSync(path.join(ROOT, 'playwright.config.ts'), 'utf8')).not.toMatch(/^\s*workers:/m);
    });
});

describe(`the selection, ${E2E_GROUP_VARIABLE}`, () => {
    it('names a group, or is left out for the whole suite; any other name is an error, never the whole suite', () => {
        for (const group of E2E_GROUPS) expect(selectedGroup(group)).toBe(group);
        expect(selectedGroup(undefined)).toBeNull();
        expect(selectedGroup('')).toBeNull();
        expect(() => selectedGroup('measure')).toThrow(E2E_GROUP_VARIABLE);
        expect(() => selectedGroup('Rest')).toThrow(E2E_GROUP_VARIABLE);
    });

    it('playwright.config.ts takes its match and its ignore from the selection', () => {
        const config = readFileSync(path.join(ROOT, 'playwright.config.ts'), 'utf8');
        expect(config).toContain('groupSelection(selectedGroup(process.env[E2E_GROUP_VARIABLE]), measuringSpecs(E2E_ROOT))');
        expect(config).toContain('testMatch: [...selection.match]');
        expect(config).toContain('...selection.ignore]');
    });
});
