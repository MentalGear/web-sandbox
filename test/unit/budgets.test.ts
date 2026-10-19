import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { budgetsTable, CHANNEL_BUDGETS, EGRESS } from '@src/lib/egress';
import { LIMITS, limitValues, type LimitName } from '@src/lib/limits';

/**
 * The budgets table (backlog S61.4): docs/API.md, "Budgets", is src/lib/egress.ts's CHANNEL_BUDGETS rendered with the
 * code's constants, as api-docs.test.ts keeps the configuration table and the code in step. A channel added, a bound
 * changed or a constant's value changed fails here until the docs say so; a surface of the egress table that relays,
 * budgets or caps with no channel fails too.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

// Every constant the table may name, with the value the code has: the limits registry (src/lib/limits.ts).
const VALUES: Record<string, number> = limitValues();

/** docs/API.md's text under `## <heading>`, up to the next heading of that level. */
function section(heading: string): string {
    const lines = read('docs/API.md').split('\n');
    const start = lines.indexOf(`## ${heading}`);
    if (start < 0) throw new Error(`docs/API.md has no "## ${heading}"`);
    const end = lines.findIndex((line, i) => i > start && /^## /.test(line));
    return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

describe('docs/API.md, Budgets: every channel of guest activity, from egress.ts', () => {
    it('the table is CHANNEL_BUDGETS rendered with the values the code has', () => {
        const table = section('Budgets').split('\n').filter(line => line.startsWith('|')).join('\n');
        expect(table).toBe(budgetsTable(VALUES));
    });

    it('every constant a channel names is one the code has, and every one listed here is named', () => {
        const named = new Set<string>();
        for (const row of CHANNEL_BUDGETS) {
            for (const cell of [row.count, row.bytes, row.time]) for (const match of cell.matchAll(/\{([A-Za-z_.]+)\}/g)) named.add(match[1]!);
        }
        // every name is a limit, and every limit the Limits table does not list is named here
        expect([...named].filter(name => !Object.hasOwn(LIMITS, name))).toEqual([]);
        expect((Object.keys(LIMITS) as LimitName[]).filter(name => LIMITS[name].label === null && !named.has(name))).toEqual([]);
        for (const [name, value] of Object.entries(VALUES)) expect(Number.isFinite(value) && value > 0, name).toBe(true);
    });

    it('every channel has its three bounds, its cost and its test, and every test it names exists', () => {
        for (const row of CHANNEL_BUDGETS) {
            for (const [dimension, text] of Object.entries({ count: row.count, bytes: row.bytes, time: row.time, cost: row.cost, test: row.test })) {
                expect(text.trim().length, `${row.channel}: ${dimension}`).toBeGreaterThan(3);
            }
            for (const file of row.test.matchAll(/((?:src|test)\/[\w./-]+\.ts)/g)) expect(existsSync(path.join(ROOT, file[1]!)), file[1]).toBe(true);
            expect(row.surfaces.length, row.channel).toBeGreaterThan(0);
        }
    });

    it('every surface of the egress table that relays, budgets or caps is a channel\'s, and every channel\'s surface is a row', () => {
        const surfaces = new Set(CHANNEL_BUDGETS.flatMap(row => row.surfaces.map(([realm, surface]) => `${realm} ${surface}`)));
        const rows = new Set(EGRESS.map(row => `${row.realm} ${row.surface}`));
        for (const row of EGRESS) {
            if (!row.handling.some(handling => handling === 'relayed' || handling === 'budgeted' || handling === 'capped')) continue;
            expect(surfaces.has(`${row.realm} ${row.surface}`), `${row.realm} ${row.surface} (${row.modes.join(', ')})`).toBe(true);
        }
        for (const surface of surfaces) expect(rows.has(surface), surface).toBe(true);
    });

    it('the limits and the view\'s cost link the table, and CONTRIBUTING\'s availability rule names it', () => {
        expect(section('Limits')).toContain('[Budgets](#budgets)');
        expect(section("The view's cost to the host page")).toContain('[Budgets](#budgets)');
        expect(read('CONTRIBUTING.md')).toContain('docs/API.md#budgets');
    });
});
