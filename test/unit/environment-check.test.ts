import { describe, expect, it } from 'vitest';
import { checkSandboxEnvironment, ENVIRONMENT_CHECKS, ENVIRONMENT_EXPECTED, ENVIRONMENT_REFUSED_TYPE, type EnvironmentCheckId } from '@src/lib/environment-check';
import { TERMINATION_REASONS } from '@src/lib/reasons';
import { inSandboxDocument } from './sandbox-environment';

const IDS = Object.keys(ENVIRONMENT_CHECKS) as EnvironmentCheckId[];
const hostWindow = () => (globalThis as any).parent.parent;

describe('the environment check (S74, class B): one table, one function', () => {
    it('the table names, for each row, what it checks, why, the value a built document reads and a termination reason of its own', () => {
        expect(IDS).toEqual(['origin', 'url', 'base']);
        for (const id of IDS) {
            const row = ENVIRONMENT_CHECKS[id];
            expect(row.checks, id).not.toBe('');
            expect(row.why, id).not.toBe('');
            expect(Object.hasOwn(TERMINATION_REASONS, row.reason), `${id}: ${row.reason}`).toBe(true);
        }
        expect(new Set(IDS.map(id => ENVIRONMENT_CHECKS[id].reason)).size).toBe(IDS.length);
        expect(ENVIRONMENT_EXPECTED).toEqual({ origin: 'null', url: 'about:srcdoc', base: 'about:blank' });
        expect(Object.keys(ENVIRONMENT_EXPECTED)).toEqual(IDS);
    });

    it('the reasons the rows give are the ones named for them, decided by the element', () => {
        expect(IDS.map(id => ENVIRONMENT_CHECKS[id].reason)).toEqual(['environmentOrigin', 'environmentUrl', 'environmentBase']);
        for (const id of IDS) expect(TERMINATION_REASONS[ENVIRONMENT_CHECKS[id].reason].decidedBy).toBe('host');
    });

    it('the stringified function spells the refusal frame type as the constant does', () => {
        expect(checkSandboxEnvironment.toString()).toMatch(new RegExp(`type: ["']${ENVIRONMENT_REFUSED_TYPE}["']`));
    });

    it('a document that reads every expected value passes, and posts nothing and stops nothing', () => {
        inSandboxDocument(record => {
            expect(checkSandboxEnvironment(ENVIRONMENT_EXPECTED, hostWindow(), true)).toBeNull();
            expect(record.posted).toEqual([]);
            expect(record.stops).toBe(0);
        });
    });

    it.each(IDS)('%s: a document that reads another value is refused by that row, with a portless refusal to the host page', (id) => {
        inSandboxDocument(record => {
            expect(checkSandboxEnvironment(ENVIRONMENT_EXPECTED, hostWindow(), false)).toBe(id);
            expect(record.posted).toEqual([{ data: { type: ENVIRONMENT_REFUSED_TYPE, refused: id }, targetOrigin: '*', transferred: 0, via: 'parent.parent' }]);
            expect(record.stops).toBe(0);
        }, { overrides: { [id]: 'https://elsewhere.example/' }, captureRefusals: true });
    });

    it('the first row in table order that differs is the refusal', () => {
        inSandboxDocument(() => {
            expect(checkSandboxEnvironment(ENVIRONMENT_EXPECTED, null, false)).toBe('origin');
        }, { overrides: { origin: 'https://host.example', url: 'https://host.example/page', base: 'https://host.example/page' } });
        inSandboxDocument(() => {
            expect(checkSandboxEnvironment(ENVIRONMENT_EXPECTED, null, false)).toBe('url');
        }, { overrides: { url: 'https://host.example/page', base: 'https://host.example/page' } });
    });

    it("it stops no parser of a document that does not read like a frame of the library's (a copy elsewhere), whatever it is asked", () => {
        for (const overrides of [{ origin: 'https://host.example' }, { url: 'https://host.example/page' }]) {
            inSandboxDocument(record => {
                expect(checkSandboxEnvironment(ENVIRONMENT_EXPECTED, hostWindow(), true)).toBe(Object.keys(overrides)[0]);
                expect(record.posted).toHaveLength(1);
                expect(record.stops).toBe(0);
            }, { overrides, captureRefusals: true });
        }
    });

    it("it stops the document's parser only when asked to, and posts nothing to the window it runs in or to none", () => {
        inSandboxDocument(record => {
            expect(checkSandboxEnvironment(ENVIRONMENT_EXPECTED, hostWindow(), true)).toBe('base');
            expect(record.stops).toBe(1);
            expect(checkSandboxEnvironment(ENVIRONMENT_EXPECTED, null, false)).toBe('base');
            expect(checkSandboxEnvironment(ENVIRONMENT_EXPECTED, window, false)).toBe('base');
            expect(record.posted).toHaveLength(1);
            expect(record.stops).toBe(1);
        }, { overrides: { base: 'https://host.example/page' }, captureRefusals: true });
    });
});
