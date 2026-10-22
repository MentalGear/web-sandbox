import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
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
