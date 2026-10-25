import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '@src/lib/limits';
import { VIEW_OPTIONS } from '@src/lib/in-sandbox-view';
import { VIOLATION_DIRECTIVES, violationBucket } from '@src/lib/violation';

/**
 * Every bound the code enforces is a row of the limits registry (BD3:LIM-3, class C: a registry that must list every
 * bound), or is declared internal here with why. Pass 3 found six enforced bounds with no row (the library's own log
 * lines, the view's violation buckets, the kind name's length, the error walk, the bridge's header caps, the config
 * comparison), and a comment that said the view and the host keep the same violation buckets, which they did not.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sources = (directory: string): string[] => readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap(entry => {
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sources(file) : /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [file] : [];
});

/** The numeric constants of `src/` (UPPER_SNAKE names with a number for a value), top level or in a stringified function. */
function numericConstants(): Array<{ file: string; name: string; typed: boolean }> {
    const found: Array<{ file: string; name: string; typed: boolean }> = [];
    for (const file of sources('src')) {
        const text = readFileSync(path.join(ROOT, file), 'utf8');
        for (const match of text.matchAll(/^\s*(?:export )?const ([A-Z][A-Z0-9_]+)(: [^=]+)? = (-?[0-9][0-9_.* +<()A-Za-z-]*);/gm)) {
            found.push({ file, name: match[1]!, typed: (match[2] ?? '').includes('LimitValue<') });
        }
    }
    return found;
}

/** Numeric constants that are not limits of the library, with why. A constant not here and not a row fails the test below. */
const INTERNAL: Readonly<Record<string, string>> = {
    'src/lib/config-schema.ts:FETCH_REQUEST_OVERHEAD': 'a term of the config invariant that the call budget holds the largest message of the bridge path (config-schema.ts)',
    'src/lib/config-schema.ts:FETCH_RESULT_OVERHEAD': 'a term of the same invariant: what a fetch result adds to its body (the head is capped by MAX_RESPONSE_HEAD)',
    'src/lib/config-schema.ts:WRITE_OVERHEAD': 'a term of the same invariant for a guest write',
    'src/lib/css-references.ts:BACKSLASH': 'the character code of a backslash, a constant of the CSS scanner',
    'src/lib/host-site.ts:MAX_ANCESTORS': "how far up the parent chain the host page's site is read: past it the rest counts as unreadable, so the site is undecided (refused), never wider; a browser nests frames far less deep",
    'src/lib/files.ts:EDIT_OVERHEAD': "a term of the quota's cost model for a rewritten file, not a bound",
    'src/lib/files.ts:SLOT_URL_BYTES': "a term of the quota's cost model for a rewritten stylesheet, not a bound",
    'src/lib/files.ts:CHUNK': 'the size of the slices a byte array is turned into text in, an implementation detail',
    'src/lib/long-timer.ts:MAX_TIMER_DELAY': "the platform's longest timer delay",
    'src/lib/rpc.ts:MAX_IN_FLIGHT': "a mirror of MAX_INBOUND_IN_FLIGHT in the stringified broker (api-docs.test.ts keeps it equal)",
    'src/lib/rpc.ts:MAX_BYTES': 'a mirror of RPC_MAX_BYTES in the stringified broker',
    'src/lib/rpc.ts:MAX_INBOUND_BYTES': 'a mirror of RPC_MAX_INBOUND_BYTES in the stringified broker',
    'src/lib/rpc.ts:MAX_TIMER_DELAY': "a mirror of the platform's longest timer delay in the stringified broker (a test keeps it equal to long-timer.ts)",
    'src/lib/watchdog.ts:TICKS_PER_BUDGET': "the watchdog's check granularity, not a bound on the guest",
};

describe('the limits registry lists every bound the code enforces (BD3:LIM-3)', () => {
    const rows = new Set(Object.keys(LIMITS));
    const mirrors = new Set<string>(Object.values(LIMITS).flatMap(row => ('mirror' in row ? [row.mirror[1]] : [])));

    it('every numeric constant of src/ is a row, the mirror of a row, typed by one, or internal with a reason', () => {
        const constants = numericConstants();
        expect(constants.length, 'the scan sees the constants').toBeGreaterThan(60);
        const unlisted = constants.filter(({ file, name, typed }) => !rows.has(name) && !mirrors.has(name) && !typed && !(`${file}:${name}` in INTERNAL));
        expect(unlisted.map(({ file, name }) => `${file}:${name}`), 'a bound with no row: add it to LIMITS (src/lib/limits.ts), or to INTERNAL here with why').toEqual([]);
        for (const [key, why] of Object.entries(INTERNAL)) expect(why.length, key).toBeGreaterThan(20);
    });

    it('the bounds pass 3 found without a row are rows, and their constants are the registry\'s', () => {
        for (const name of ['LOG_OWN_LINES', 'KIND_MAX_LENGTH', 'ERROR_WALK_NODES', 'ERROR_WALK_DEPTH', 'MAX_HEADERS', 'MAX_HEADER_VALUE', 'SAME_DATA_MAX_PAIRS'] as const) {
            expect(LIMITS[name].label, name).not.toBeNull();
            expect(LIMITS[name].value, name).toBeGreaterThan(0);
        }
    });
});

describe('the view and the host keep the same violation buckets (BD3:LIM-3, class D)', () => {
    it('the view counts by the host\'s list: the options carry VIOLATION_DIRECTIVES', () => {
        expect(VIEW_OPTIONS.violationDirectives).toBe(VIOLATION_DIRECTIVES);
    });

    it('a name the list has is its own bucket and every other name shares one, on the host\'s side', () => {
        expect(VIOLATION_DIRECTIVES.map(violationBucket)).toEqual([...VIOLATION_DIRECTIVES]);
        expect(new Set(['x-made-up', 'another', 'script-src-attribute', ''].map(violationBucket))).toEqual(new Set(['*']));
    });
});
