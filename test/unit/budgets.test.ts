import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { budgetsTable, CHANNEL_BUDGETS, EGRESS, UNCAUGHT_CHARACTERS_PER_SECOND, UNCAUGHT_PER_SECOND } from '@src/lib/egress';
import { LOG_BYTES_PER_SECOND, LOG_EVENTS_PER_SECOND, LOG_MAX_ARGS, LOG_MAX_BYTES, LOG_MAX_STRING } from '@src/lib/sandbox-log';
import { MAX_INBOUND_IN_FLIGHT, RPC_MAX_BYTES, RPC_MAX_INBOUND_BYTES } from '@src/lib/rpc';
import { DEFAULT_CALL_BUDGET } from '@src/lib/config-schema';
import { GUEST_WRITE_BYTES_PER_SECOND, GUEST_WRITES_PER_SECOND } from '@src/lib/guest-writes';
import { MAX_FILES, MAX_TOTAL_BYTES } from '@src/lib/files';
import { toFetchPolicy } from '@src/lib/fetch-bridge';
import { VIOLATION_EVENT_LIMIT, VIOLATION_MAX_STRING } from '@src/lib/violation';
import { AUTO_RESIZE_MAX_HEIGHT, AUTO_RESIZE_MAX_UPDATES_PER_SECOND } from '@src/lib/auto-resize';
import { EXECUTION_TIMEOUT_GRACE_MS, VIEW_LIVENESS_TIMEOUT_MS } from '@src/host';
import * as view from '@src/lib/in-sandbox-view';

/**
 * The budgets table (backlog S61.4): docs/API.md, "Budgets", is src/lib/egress.ts's CHANNEL_BUDGETS rendered with the
 * code's constants, as api-docs.test.ts keeps the configuration table and the code in step. A channel added, a bound
 * changed or a constant's value changed fails here until the docs say so; a surface of the egress table that relays,
 * budgets or caps with no channel fails too.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
// An internal constant, read where it is declared (no new exports for a test).
const declared = (file: string, name: string) => Number(read(file).match(new RegExp(`const ${name} = (\\d+);`))![1]);
const fetchBounds = toFetchPolicy({ allow: [], maxBytes: 1e15, timeoutMs: 1e15, maxConcurrent: 1e15 }, () => {})!;

// Every constant the table may name, with the value the code has.
const VALUES: Record<string, number> = {
    LOG_EVENTS_PER_SECOND, LOG_MAX_ARGS, LOG_MAX_BYTES, LOG_BYTES_PER_SECOND, LOG_MAX_STRING,
    UNCAUGHT_PER_SECOND, UNCAUGHT_CHARACTERS_PER_SECOND,
    GUEST_CALLS_PER_SECOND: DEFAULT_CALL_BUDGET.calls,
    GUEST_CALL_BYTES_PER_SECOND: DEFAULT_CALL_BUDGET.bytes,
    MAX_INBOUND_IN_FLIGHT, RPC_MAX_BYTES, RPC_MAX_INBOUND_BYTES,
    MAX_NAME_LENGTH: declared('src/lib/rpc.ts', 'MAX_NAME_LENGTH'),
    MAX_TEXT_LENGTH: declared('src/lib/rpc.ts', 'MAX_TEXT_LENGTH'),
    DEFAULT_TIMEOUT_MS: declared('src/lib/rpc.ts', 'DEFAULT_TIMEOUT_MS'),
    GUEST_WRITES_PER_SECOND, GUEST_WRITE_BYTES_PER_SECOND, MAX_FILES, MAX_TOTAL_BYTES,
    MAX_MAX_CONCURRENT: fetchBounds.maxConcurrent,
    MAX_MAX_BYTES: fetchBounds.maxBytes,
    MAX_TIMEOUT_MS: fetchBounds.timeoutMs,
    VIOLATION_EVENT_LIMIT, VIOLATION_MAX_STRING,
    AUTO_RESIZE_MAX_UPDATES_PER_SECOND, AUTO_RESIZE_MAX_HEIGHT,
    VIEW_LIVENESS_TIMEOUT_MS, EXECUTION_TIMEOUT_GRACE_MS,
    'VIEW_OPTIONS.guestText.maxLength': view.VIEW_OPTIONS.guestText.maxLength,
    VIEW_MAX_ELEMENTS: view.VIEW_MAX_ELEMENTS,
    VIEW_MAX_DEPTH: view.VIEW_MAX_DEPTH,
    VIEW_RENDER_MAX_LENGTH: view.VIEW_RENDER_MAX_LENGTH,
    VIEW_RENDER_CHARACTERS_PER_SECOND: view.VIEW_RENDER_CHARACTERS_PER_SECOND,
    VIEW_MAX_CHARACTERS: view.VIEW_MAX_CHARACTERS,
    VIEW_APPLY_MS_PER_SECOND: view.VIEW_APPLY_MS_PER_SECOND,
    VIEW_MAX_OPERATION_MS: view.VIEW_MAX_OPERATION_MS,
    VIEW_OVERRUN_WINDOW_MS: view.VIEW_OVERRUN_WINDOW_MS,
    VIEW_URLS_PER_SECOND: view.VIEW_URLS_PER_SECOND,
    VIEW_MAX_URLS: view.VIEW_MAX_URLS,
    VIEW_MAX_DISTINCT_URLS: view.VIEW_MAX_DISTINCT_URLS,
    'VIEW_EVENT_LIMITS.maxIds': view.VIEW_EVENT_LIMITS.maxIds,
    'VIEW_EVENT_LIMITS.maxFields': view.VIEW_EVENT_LIMITS.maxFields,
    'VIEW_EVENT_LIMITS.maxString': view.VIEW_EVENT_LIMITS.maxString,
    'VIEW_EVENT_LIMITS.maxTotal': view.VIEW_EVENT_LIMITS.maxTotal,
};

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
        expect([...named].sort()).toEqual(Object.keys(VALUES).sort());
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
