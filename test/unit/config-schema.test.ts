import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitGuestCall, CALL_INVARIANTS, callBudgetOf, CONFIG_INVARIANTS, CONFIG_OPTIONS, CONFIG_SCHEMA, DEFAULT_CALL_BUDGET, defaultConfig, heaviestCall, ignoredIn, normaliseConfig, PARSED_APART, SANDBOX_MODES, type CallBudget, type NormalisedConfig, type OptionName, type OptionRule, type SandboxMode } from '@src/lib/config-schema';
import { createRateLimiter } from '@src/lib/rate-limit';
import { RPC_MAX_BYTES } from '@src/lib/rpc';

/**
 * The config schema (class C; review round 5, L-2 = N-5): `callLimits`, normalised once, with its cross-field invariants.
 * fast-check is not a dependency: the property runs over a seeded random set of values (the same cases every run) and a
 * table of the edges between them.
 */

// A seeded generator (mulberry32).
function random(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// The edges: below 1, 1, the smallest call frame (about 136 bytes), around RPC_MAX_BYTES, the defaults, and what is not a
// finite number at all.
const EDGES: unknown[] = [undefined, null, 0, 0.5, 1, 2, 64, 100, 135, 136, 137, 1000, 1048576, RPC_MAX_BYTES - 1, RPC_MAX_BYTES, RPC_MAX_BYTES + 1,
    67108864, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, Infinity, -Infinity, NaN, -1, '100', true, {}, [], Number.MIN_VALUE];

function randomField(next: () => number): unknown {
    const roll = next();
    if (roll < 0.4) return EDGES[Math.floor(next() * EDGES.length)];
    if (roll < 0.7) return Math.floor(next() * 2 ** Math.floor(next() * 40));
    if (roll < 0.9) return next() * 10;
    return undefined;
}

function randomLimits(next: () => number): unknown {
    const roll = next();
    if (roll < 0.05) return EDGES[Math.floor(next() * EDGES.length)]; // not an object at all, or left out
    const limits: Record<string, unknown> = {};
    if (next() < 0.8) limits.maxPerSecond = randomField(next);
    if (next() < 0.8) limits.maxBytesPerSecond = randomField(next);
    return limits;
}

function normalise(limits: unknown): { budget: Readonly<CallBudget>; warnings: string[] } {
    const warnings: string[] = [];
    const budget = callBudgetOf(limits, (message) => warnings.push(message));
    return { budget, warnings };
}

describe('callLimits: one normalisation, its cross-field invariants', () => {
    const cases: unknown[] = [...EDGES.map(value => ({ maxBytesPerSecond: value })), ...EDGES.map(value => ({ maxPerSecond: value })), ...EDGES];
    const next = random(20261018);
    for (let i = 0; i < 2000; i++) cases.push(randomLimits(next));

    it(`every invariant holds for every normalised budget (${cases.length} configurations: the edges, then seeded random ones)`, () => {
        for (const limits of cases) {
            const { budget } = normalise(limits);
            for (const invariant of CALL_INVARIANTS) expect(invariant.holds(budget), `${invariant.name}: ${JSON.stringify(limits)}`).toBe(true);
        }
    });

    it('normalising is idempotent, and its warnings are deterministic', () => {
        for (const limits of cases) {
            const first = normalise(limits);
            const again = normalise(limits);
            expect(again, JSON.stringify(limits)).toEqual(first);
            const twice = normalise({ maxPerSecond: first.budget.calls, maxBytesPerSecond: first.budget.bytes });
            expect(twice.budget, JSON.stringify(limits)).toEqual(first.budget);
            // the one warning a kept budget can still give is the heaviest-call one, and it is the same again
            expect(twice.warnings).toEqual(first.budget.bytes < RPC_MAX_BYTES ? [expect.stringContaining('below the largest call')] : []);
        }
    });

    it('a byte budget below RPC_MAX_BYTES warns once that heavier calls are refused; one at or above it does not', () => {
        for (const limits of cases) {
            const { budget, warnings } = normalise(limits);
            const said = warnings.filter(message => message.includes('below the largest call'));
            expect(said.length, JSON.stringify(limits)).toBe(budget.bytes < RPC_MAX_BYTES ? 1 : 0);
        }
    });

    it('every call that can be carried fits an empty window, and every heavier one is refused for good, never BUSY (both windows fresh, every weight from 1 to past the heaviest)', () => {
        const next = random(7);
        for (const limits of cases.slice(0, 400)) {
            const { budget } = normalise(limits);
            const heaviest = heaviestCall(budget);
            const weights = [1, 136, heaviest - 1, heaviest, heaviest + 1, Math.floor(next() * heaviest) + 1, RPC_MAX_BYTES + 1].filter(weight => weight >= 1);
            for (const weight of weights) {
                const verdict = admitGuestCall(budget, createRateLimiter(budget.calls), createRateLimiter(budget.bytes), weight, 0);
                expect(verdict, `${weight} bytes under ${JSON.stringify(budget)}`).toEqual(weight <= heaviest ? null : expect.objectContaining({ code: 'ARGS_NOT_TRANSFERABLE' }));
            }
        }
    });

    it('a call that fits refuses BUSY only past the window, and counts nothing then', () => {
        const budget = { calls: 2, bytes: 1000 };
        const calls = createRateLimiter(budget.calls);
        const bytes = createRateLimiter(budget.bytes);
        expect(admitGuestCall(budget, calls, bytes, 600, 0)).toBeNull();
        expect(admitGuestCall(budget, calls, bytes, 600, 1)).toEqual({ code: 'BUSY', reason: 'more than 2 calls or 1000 bytes of calls in one second' });
        expect(admitGuestCall(budget, calls, bytes, 400, 2)).toBeNull();
        expect(admitGuestCall(budget, calls, bytes, 1, 3)).toEqual(expect.objectContaining({ code: 'BUSY' }));
        expect(admitGuestCall(budget, calls, bytes, 1, 1001)).toBeNull();
    });

    it('the defaults: no warning, the heaviest call is RPC_MAX_BYTES', () => {
        expect(normalise(undefined)).toEqual({ budget: DEFAULT_CALL_BUDGET, warnings: [] });
        expect(normalise({})).toEqual({ budget: DEFAULT_CALL_BUDGET, warnings: [] });
        expect(heaviestCall(DEFAULT_CALL_BUDGET)).toBe(RPC_MAX_BYTES);
    });
});

// ---- The whole configuration (backlog S67): one schema, its invariants, and docs/API.md's Configuration table.

const HOST = 'https://host.example';
const normaliseWhole = (config: unknown) => normaliseConfig(config, { hostOrigin: HOST });

// Values for each option: its edges and what is not its type at all.
const ANY: unknown[] = [undefined, null, 0, 1, -1, NaN, Infinity, '', 'x', true, false, {}, [], [1], 1n];
const POOLS: Record<string, unknown[]> = {
    mode: [undefined, 'strict', 'cooperative', 'worker', 'iframe', 'Strict', '', null, 5, {}],
    capabilities: [undefined, null, [], ['allow-scripts'], ['allow-forms'], ['allow-scripts', 'allow-pointer-lock', 'allow-popups'], ['nope', 5], 'allow-scripts', {}],
    unsafeCapabilities: [undefined, null, [], ['allow-popups'], ['allow-forms', 'fullscreen'], ['allow-scripts'], 'allow-popups', [{}]],
    html: [undefined, '', '<p>x</p>', '<script>1</script>', 5, null, {}],
    fetchBridge: [undefined, null, true, { allow: [] }, { allow: ['https://api.example', HOST, 'http://127.0.0.1:8080', 'nope'], methods: ['get', 'CONNECT'], headers: ['Authorization', 'cookie'] },
        { allow: [], maxBytes: 0 }, { allow: [], maxBytes: 1e15, timeoutMs: 1e15, maxConcurrent: 1e15 }, { allow: [], maxBytes: 0.5, timeoutMs: -1, maxConcurrent: NaN }, { allow: 'x', methods: 'GET' }],
    callLimits: [undefined, null, 5, {}, { maxPerSecond: 0 }, { maxBytesPerSecond: 100 }, { maxBytesPerSecond: RPC_MAX_BYTES - 1 }, { maxBytesPerSecond: RPC_MAX_BYTES }, { maxPerSecond: 1.5, maxBytesPerSecond: Infinity }],
    origins: [undefined, {}, { images: ['https://img.example', 'https:'] }, { scripts: ['https://s.example'] }, { connect: ['wss://ws.example'], nope: [] }, null, 'x', { images: 'x' }],
    autoResize: [undefined, true, false, 1, 'true'],
    entry: [undefined, '', 'main.js', 5, null],
    allowAnimations: [undefined, true, false, 0, 'no', null],
    allowAutoplay: [undefined, true, false, 1, 'yes', null],
    scriptUnsafe: [undefined, true, false, 1, 'true'],
    workerExecutionTimeout: [undefined, 0, 1, 1500, -1, NaN, Infinity, Number.MAX_VALUE, '100', null],
    watchdogTimeout: [undefined, 0, 1, 2000, -5, NaN, Infinity, 2 ** 31, '5', {}],
    guestWrites: [undefined, true, false, 1, 'true'],
    virtualFilesUrl: ['/files/'],
    connectionsAllowed: [{}, null],
    unknownOption: [1, { deep: true }],
};
const POISON = ['__proto__', 'constructor', 'prototype'];

function pick<T>(next: () => number, values: readonly T[]): T {
    return values[Math.floor(next() * values.length)]!;
}

// One random configuration: some options, each from its pool or any value, sometimes a JSON "__proto__" key at any depth.
function randomConfig(next: () => number): unknown {
    if (next() < 0.02) return pick(next, [null, 5, 'x', [], undefined]);
    const config: Record<string, unknown> = {};
    for (const [name, pool] of Object.entries(POOLS)) {
        const roll = next();
        if (roll < 0.45) continue;
        config[name] = roll < 0.9 ? pick(next, pool) : pick(next, ANY);
    }
    if (next() < 0.15) {
        const poisoned = JSON.parse(`{"${pick(next, POISON)}": {"scriptUnsafe": true, "mode": "worker", "entry": "x.js", "html": "p"}}`);
        if (next() < 0.5) Object.assign(config, poisoned);
        else config[pick(next, ['origins', 'fetchBridge', 'callLimits'])] = JSON.parse(`{"${pick(next, POISON)}": {"images": ["https://p.example"]}, "allow": []}`);
    }
    return structuredClone(config);
}

// The argument that names exactly what a normalised config holds: normalising it again must give the same config.
function argumentOf(value: NormalisedConfig): Record<string, unknown> {
    // what the mode ignores is left out: it holds its default, and naming it would only say again that it is ignored
    const argument: Record<string, unknown> = Object.fromEntries(Object.entries(value.config).filter(([name]) => !ignoredIn(name as OptionName, value.config.mode)));
    argument.callLimits = { maxPerSecond: value.callBudget.calls, maxBytesPerSecond: value.callBudget.bytes };
    argument.origins = Object.fromEntries(Object.entries(value.origins).map(([kind, list]) => [kind, [...list]]));
    if (value.fetchPolicy) {
        const { allow, maxBytes, timeoutMs, methods, headers, maxConcurrent } = value.fetchPolicy;
        argument.fetchBridge = { allow: [...allow], maxBytes, timeoutMs, methods: [...methods], headers: [...headers], maxConcurrent };
    }
    return argument;
}

describe('the config schema: every option, normalised once, with the cross-field invariants (S67)', () => {
    const next = random(20261019);
    const cases: unknown[] = [{}, undefined, null, [], ...Object.entries(POOLS).flatMap(([name, pool]) => [...pool, ...ANY].flatMap(value => SANDBOX_MODES.map(mode => ({ mode, [name]: value }))))];
    for (let i = 0; i < 3000; i++) cases.push(randomConfig(next));
    const shownCase = (config: unknown) => { try { return JSON.stringify(config, (_, v) => (typeof v === 'bigint' ? `${v}n` : v)); } catch { return String(config); } };

    it(`every declared invariant holds after normalisation (${cases.length} configurations: each option's edges in each mode, then seeded random ones)`, () => {
        let used = 0;
        const failed: string[] = [];
        for (const config of cases) {
            const { value, warnings, refusal } = normaliseWhole(config);
            if (value === null) {
                if (!(refusal instanceof Error)) failed.push(`a refusal that is not an Error: ${shownCase(config)}`);
                continue;
            }
            used++;
            for (const invariant of CONFIG_INVARIANTS) if (!invariant.holds(value, warnings)) failed.push(`${invariant.name}: ${shownCase(config)}`);
        }
        expect(failed).toEqual([]);
        expect(used).toBeGreaterThan(cases.length / 2);
    }, 30000);

    it('normalising is idempotent: the argument that names a normalised config normalises to it again, and warns nothing new', () => {
        for (const config of cases) {
            const first = normaliseWhole(config);
            if (first.value === null) continue;
            const again = normaliseWhole(argumentOf(first.value));
            expect(again.refusal, shownCase(config)).toBeNull();
            expect(again.value, shownCase(config)).toEqual(first.value);
            const unsaid = again.warnings.filter(message => !first.warnings.includes(message));
            expect(unsaid, shownCase(config)).toEqual([]);
        }
    }, 30000);

    it('warnings are deterministic: the same argument gives the same warnings, in the same order, and the same result', () => {
        for (const config of cases) {
            const first = normaliseWhole(config);
            const again = normaliseWhole(structuredClone(config));
            expect(again.warnings, shownCase(config)).toEqual(first.warnings);
            expect(again.value, shownCase(config)).toEqual(first.value);
            expect(again.refusal === null, shownCase(config)).toBe(first.refusal === null);
        }
    }, 30000);

    it('no assigned key leaks: nothing but the options reaches the stored config, no prototype changes, nothing is inherited', () => {
        const options = new Set<string>(CONFIG_OPTIONS);
        for (const config of cases) {
            const { value } = normaliseWhole(config);
            if (value === null) continue;
            expect(Object.keys(value.config).filter(key => !options.has(key)), shownCase(config)).toEqual([]);
            expect(Object.getPrototypeOf(value.config)).toBe(Object.prototype);
            expect(Object.getPrototypeOf(value.origins)).toBe(Object.prototype);
            for (const key of POISON) expect(Object.hasOwn(value.config, key)).toBe(false);
            // a poisoned "__proto__" gave nothing: the values are those of the config without it
            const own = config as Record<string, unknown>;
            if (own && typeof own === 'object' && Object.hasOwn(own, '__proto__')) {
                const without = structuredClone(own);
                delete without.__proto__;
                Object.setPrototypeOf(without, Object.prototype);
                expect(value, shownCase(config)).toEqual(normaliseWhole(without).value);
            }
        }
        expect(({} as Record<string, unknown>).scriptUnsafe).toBeUndefined();
    }, 30000);

    it('a refused config gives no config, only the warnings said before what refused it', () => {
        for (const config of [null, 5, [], 'x', { origins: null }, { origins: 'x' }, { origins: { images: 'x' } }, { capabilities: 5, origins: [] }]) {
            const { value, warnings, refusal } = normaliseWhole(config);
            expect(value, shownCase(config)).toBeNull();
            expect(refusal).toBeInstanceOf(TypeError);
            if (shownCase(config).includes('capabilities')) expect(warnings).toEqual(['[Sandbox] "capabilities" must be a list; a value of type number was dropped.']);
            else expect(warnings).toEqual([]);
        }
    });

    it("each option's modes agree with the mode rule that ignores it elsewhere", () => {
        for (const name of CONFIG_OPTIONS) {
            const modes = (CONFIG_SCHEMA as Record<string, OptionRule>)[name]!.modes!;
            for (const mode of SANDBOX_MODES) expect(ignoredIn(name, mode), `${name} in ${mode}`).toBe(!modes.includes(mode));
        }
    });
});

// docs/API.md's Configuration table, row by row: Option | Type | Default | Modes | What it does.
const API = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../docs/API.md'), 'utf8');
function configurationRows(): Map<string, { type: string; documented: string; modes: string; text: string }> {
    const start = API.indexOf('\n## Configuration\n');
    const end = API.indexOf('\n### ', start);
    const rows = new Map<string, { type: string; documented: string; modes: string; text: string }>();
    for (const line of API.slice(start, end).split('\n')) {
        const match = line.match(/^\| `(\w+)` \|/);
        if (!match) continue;
        const cells = line.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim());
        rows.set(match[1]!, { type: cells[1]!, documented: cells[2]!, modes: cells[3]!, text: cells[4]! });
    }
    return rows;
}
const modesOf = (cell: string): string[] => (cell === '—' || cell.startsWith('all') ? [...SANDBOX_MODES] : cell.split(',').map(mode => mode.trim())).sort();
const rendered = (value: unknown): string | null => {
    if (typeof value === 'string') return `\`'${value}'\``;
    if (typeof value === 'boolean' || typeof value === 'number') return `\`${value}\``;
    if (Array.isArray(value) && value.length === 0) return '`[]`';
    return null;
};

describe("docs/API.md's Configuration table and the config schema", () => {
    const rows = configurationRows();

    it('every option row has a schema entry, and every option of the schema a row', () => {
        expect([...rows.keys()].sort()).toEqual([...CONFIG_OPTIONS].sort());
    });

    it('each option has the default and the modes the schema declares', () => {
        for (const name of CONFIG_OPTIONS) {
            const rule = (CONFIG_SCHEMA as Record<string, OptionRule>)[name]!;
            const row = rows.get(name)!;
            expect(row.documented, name).toBe(rule.documented);
            const literal = rendered(rule.default);
            if (literal !== null) expect(row.documented.startsWith(literal), `${name}: ${row.documented} is not ${literal}`).toBe(true);
            expect(modesOf(row.modes), name).toEqual([...rule.modes!].sort());
        }
        // what the stored defaults are
        const defaults = defaultConfig();
        for (const name of CONFIG_OPTIONS) {
            if ((PARSED_APART as readonly string[]).includes(name)) continue;
            expect((defaults as unknown as Record<string, unknown>)[name], name).toEqual((CONFIG_SCHEMA as Record<string, OptionRule>)[name]!.default);
        }
        expect(rows.get('callLimits')!.documented).toBe(`${DEFAULT_CALL_BUDGET.calls} calls and ${DEFAULT_CALL_BUDGET.bytes / 1048576} MiB per second`);
    });

    it('the options ignored outside their modes, with a warning or silently, as the Configuration section lists them', () => {
        const said = API.replace(/\s+/g, ' ').match(/with one warning for ((?:`\w+`(?:, | and )?)+), silently for ((?:`\w+`(?: and )?)+)\./);
        expect(said).not.toBeNull();
        const names = (text: string) => [...text.matchAll(/`(\w+)`/g)].map(match => match[1]!).sort();
        const rules = CONFIG_SCHEMA as Record<string, OptionRule>;
        const ignored = CONFIG_OPTIONS.filter(name => rules[name]!.ignoredIn !== undefined);
        expect(names(said![1]!)).toEqual(ignored.filter(name => rules[name]!.ignoredWarning !== undefined).sort());
        expect(names(said![2]!)).toEqual(ignored.filter(name => rules[name]!.ignoredWarning === undefined).sort());
    });

    // Each option's edges, as its row describes them: [option, given, mode, stored, a warning that contains this or null].
    const EDGE_TABLE: [string, unknown, SandboxMode, unknown, string | null][] = [
        ['mode', undefined, 'strict', 'strict', null],
        ['html', 5, 'strict', '', '"html" must be a string; a value of type number was dropped.'],
        ['html', '<p>', 'worker', '', null],
        ['capabilities', ['allow-forms'], 'cooperative', [], '"allow-forms" is not allowed in "capabilities" and was dropped. It reaches outside the sandbox'],
        ['capabilities', ['allow-forms', 'allow-scripts'], 'strict', ['allow-forms', 'allow-scripts'], null],
        ['capabilities', 5, 'strict', [], '"capabilities" must be a list'],
        ['unsafeCapabilities', ['allow-popups'], 'cooperative', ['allow-popups'], 'unsafe capability "allow-popups" is enabled'],
        ['unsafeCapabilities', ['allow-popups'], 'strict', [], 'unsafeCapabilities are not available in strict mode and were dropped: allow-popups.'],
        ['scriptUnsafe', 'true', 'cooperative', false, null],
        ['scriptUnsafe', true, 'cooperative', true, 'scriptUnsafe is enabled'],
        ['entry', 'main.js', 'cooperative', undefined, '"entry" is used only in strict mode and was ignored.'],
        ['entry', 5, 'strict', undefined, null],
        ['watchdogTimeout', -1, 'worker', 0, null],
        ['watchdogTimeout', Infinity, 'worker', 0, null],
        ['watchdogTimeout', 2000, 'cooperative', 2000, null],
        ['workerExecutionTimeout', 1500, 'strict', 1500, null],
        ['workerExecutionTimeout', 1500, 'cooperative', 0, null],
        ['workerExecutionTimeout', NaN, 'worker', 0, null],
        ['autoResize', 1, 'cooperative', false, null],
        ['autoResize', true, 'worker', false, 'autoResize has no effect in worker mode'],
        ['allowAnimations', 'no', 'strict', false, 'allowAnimations must be a boolean; "no" was taken as false'],
        ['allowAnimations', false, 'cooperative', true, '"allowAnimations" is used only in strict mode and was ignored.'],
        ['allowAutoplay', 1, 'strict', false, 'allowAutoplay must be a boolean; a value of type number was taken as false'],
        ['allowAutoplay', true, 'strict', true, null],
        ['allowAutoplay', true, 'worker', false, '"allowAutoplay" is used only in strict mode and was ignored.'],
        ['guestWrites', 'true', 'strict', false, null],
        ['guestWrites', true, 'worker', true, null],
    ];
    it.each(EDGE_TABLE)('%s: %o in %s mode is stored as %o', (name, given, mode, stored, warning) => {
        const { value, warnings } = normaliseWhole({ mode, [name]: given });
        expect((value!.config as unknown as Record<string, unknown>)[name]).toEqual(stored);
        if (warning === null) expect(warnings.filter(message => !message.includes('is enabled'))).toEqual([]);
        else expect(warnings.some(message => message.includes(warning)), warnings.join('\n')).toBe(true);
    });

    it('the parsed options: fetchBridge off or its policy, callLimits its budget, origins its lists', () => {
        expect(normaliseWhole({}).value!.fetchPolicy).toBeNull();
        expect(normaliseWhole({ fetchBridge: true }).value!.fetchPolicy).toBeNull();
        expect(normaliseWhole({ fetchBridge: { allow: [] } }).value!.fetchPolicy).toMatchObject({ allow: [], maxBytes: 1048576, timeoutMs: 10000, maxConcurrent: 4 });
        expect(normaliseWhole({ callLimits: { maxPerSecond: 0 } }).value!.callBudget).toEqual(DEFAULT_CALL_BUDGET);
        expect(normaliseWhole({ origins: { scripts: ['https://s.example'] } }).value!.origins.scripts).toEqual([]);
        expect(normaliseWhole({ mode: 'cooperative', origins: { scripts: ['https://s.example'] } }).value!.origins.scripts).toEqual(['https://s.example']);
    });
});
