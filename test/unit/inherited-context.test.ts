import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENVIRONMENT_CHECKS, type EnvironmentCheckId } from '@src/lib/environment-check';
import { CONTEXT_ENGINES, INHERITED_CONTEXT, inheritedContextRows, NEUTRALISATIONS } from '@src/lib/inherited-context';

/**
 * The inherited-context table (S74, class A) is the one list of what a sandbox document inherits from the host page.
 * It is complete when each row says how it is neutralised and names a test that exists; the environment check's rows
 * are each covered by a row (a row of the check without one is a channel nobody listed).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rows = inheritedContextRows();

describe('INHERITED_CONTEXT', () => {
    it('has the channels the class review inventoried', () => {
        expect(Object.keys(INHERITED_CONTEXT)).toEqual([
            'cspScript', 'cspWorker', 'cspStyle', 'cspBaseUri', 'cspFetch', 'trustedTypesRequirement', 'trustedTypesDefault', 'coep',
            'referrer', 'ancestorOrigins', 'documentOrigin', 'cookies', 'serviceWorker', 'hostRealmGlobals', 'permissionsPolicy',
            'uiSurfaces', 'eventDispatch', 'thread',
        ]);
    });

    it.each(rows.map(row => [row.id, row] as const))('%s: says what is inherited, by whom, and how it is neutralised, on engines of the suite', (_, row) => {
        for (const text of [row.channel, row.inheritedBy, row.how]) expect(text.trim()).not.toBe('');
        expect(row.by.length).toBeGreaterThan(0);
        for (const how of row.by) expect(NEUTRALISATIONS).toContain(how);
        expect(row.engines.length).toBeGreaterThan(0);
        for (const engine of row.engines) expect(CONTEXT_ENGINES).toContain(engine);
        expect(new Set(row.engines).size).toBe(row.engines.length);
    });

    it.each(rows.map(row => [row.id, row] as const))('%s: names at least one test file, and each exists', (_, row) => {
        expect(row.tests.length).toBeGreaterThan(0);
        for (const file of row.tests) {
            expect(file, file).toMatch(/^(test\/(unit|e2e)\/|src\/lib\/)[\w./-]+\.(test|spec)\.ts$/);
            expect(existsSync(path.join(root, file)), file).toBe(true);
        }
        expect(new Set(row.tests).size).toBe(row.tests.length);
    });

    // BD3:TST-10: a row's `tests` can be any file that exists, and only the generated THREAT-MODEL region (which regenerates)
    // would notice. A file the row names must be about the row: it carries the row's id (a `covering('id', …)` marker is one) or a
    // token the row itself writes in code (a directive, an option, a constant: `base-uri`, `fetchBridge`, `INERT_HREF`).
    it.each(rows.map(row => [row.id, row] as const))('%s: a test file it names is about it: it names the row or a token of the row\'s own text', (_, row) => {
        const tokens = new Set<string>([row.id]);
        for (const span of `${row.channel} ${row.inheritedBy} ${row.how}`.matchAll(/`([^`]+)`/g)) {
            const token = span[1]!.replace(/\(\)$/, '').split(/[\s=(]/)[0]!.replace(/^'|'$/g, '');
            if (token.length >= 4 && !/^(true|false|null|none|about)/.test(token)) tokens.add(token);
        }
        const mentions = row.tests.filter(file => [...tokens].some(token => readFileSync(path.join(root, file), 'utf8').includes(token)));
        expect(mentions, `none of ${row.tests.join(', ')} mentions the row or one of ${[...tokens].slice(0, 12).join(', ')}`).not.toEqual([]);
    });

    it("a row is covered by the environment check exactly when it says `check`; every row of the check is covered", () => {
        const known = Object.keys(ENVIRONMENT_CHECKS) as EnvironmentCheckId[];
        const covered = new Set<EnvironmentCheckId>();
        for (const row of rows) {
            const checks = (row as { environmentChecks?: readonly EnvironmentCheckId[] }).environmentChecks ?? [];
            expect(row.by.includes('check'), row.id).toBe(checks.length > 0);
            for (const id of checks) {
                expect(known, `${row.id}: ${id}`).toContain(id);
                covered.add(id);
            }
        }
        expect([...covered].sort()).toEqual([...known].sort());
    });
});
