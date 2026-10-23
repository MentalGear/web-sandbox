import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitGuestCall, CALL_INVARIANTS, CALL_LIMIT_FIELDS, callBudgetOf, CONFIG_INVARIANTS, CONFIG_OPTIONS, CONFIG_SCHEMA, DEFAULT_CALL_BUDGET, defaultConfig, heaviestCall, ignoredIn, normaliseConfig, PARSED_APART, SANDBOX_MODES, type CallBudget, type NormalisedConfig, type NormaliseContext, type OptionName, type OptionRule, type SandboxMode } from '@src/lib/config-schema';
import { ORIGIN_KINDS } from '@src/lib/csp/origins';
import { FETCH_BRIDGE_FIELDS } from '@src/lib/fetch-bridge';
import { createRateLimiter } from '@src/lib/rate-limit';
import { RPC_MAX_BYTES } from '@src/lib/rpc';

/**
 * The config schema (class C; R5:L-2 = R5:N-5): `callLimits`, normalised once, with its cross-field invariants.
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
    capabilities: [undefined, null, [], ['allow-scripts'], ['allow-forms'], ['allow-scripts', 'allow-pointer-lock', 'allow-popups'], ['allow-orientation-lock'], ['nope', 5], 'allow-scripts', {}],
    unsafeCapabilities: [undefined, null, [], ['allow-popups'], ['allow-pointer-lock'], ['allow-forms', 'fullscreen'], ['allow-scripts'], 'allow-popups', [{}]],
    html: [undefined, '', '<p>x</p>', '<script>1</script>', 5, null, {}],
    fetchBridge: [undefined, null, true, { allow: [] }, { allow: ['https://api.example', HOST, 'http://127.0.0.1:8080', 'nope'], methods: ['get', 'CONNECT'], headers: ['Authorization', 'cookie'] },
        { allow: [], maxBytes: 0 }, { allow: [], maxBytes: 1e15, timeoutMs: 1e15, maxConcurrent: 1e15 }, { allow: [], maxBytes: 0.5, timeoutMs: -1, maxConcurrent: NaN }, { allow: 'x', methods: 'GET' }],
    callLimits: [undefined, null, 5, {}, { maxPerSecond: 0 }, { maxBytesPerSecond: 100 }, { maxBytesPerSecond: RPC_MAX_BYTES - 1 }, { maxBytesPerSecond: RPC_MAX_BYTES }, { maxPerSecond: 1.5, maxBytesPerSecond: Infinity }],
    origins: [undefined, {}, { images: ['https://img.example', 'https:'] }, { scripts: ['https://s.example'] }, { connect: ['wss://ws.example'], nope: [] }, null, 'x', { images: 'x' }],
    hostContentSecurityPolicy: [undefined, false, true, '', "connect-src 'self'", "connect-src 'none', connect-src https://api.example", 5, null, {}, ['connect-src *']],
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

// docs/API.md's Configuration table is generated from the schema (tools/docgen/extractors/config.ts, checked by
// `bun run docs:check`); what the schema says of itself, and the prose that names options, is checked here.
const API = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../docs/API.md'), 'utf8');
const rendered = (value: unknown): string | null => {
    if (typeof value === 'string') return `\`'${value}'\``;
    if (typeof value === 'boolean' || typeof value === 'number') return `\`${value}\``;
    if (Array.isArray(value) && value.length === 0) return '`[]`';
    return null;
};

describe("the config schema, which docs/API.md's Configuration table is generated from", () => {
    it('each option documents the default it has, and the defaults are the ones stored', () => {
        for (const name of CONFIG_OPTIONS) {
            const rule = (CONFIG_SCHEMA as Record<string, OptionRule>)[name]!;
            const literal = rendered(rule.default);
            if (literal !== null) expect(rule.documented!.startsWith(literal), `${name}: ${rule.documented} is not ${literal}`).toBe(true);
        }
        const defaults = defaultConfig();
        for (const name of CONFIG_OPTIONS) {
            if ((PARSED_APART as readonly string[]).includes(name)) continue;
            expect((defaults as unknown as Record<string, unknown>)[name], name).toEqual((CONFIG_SCHEMA as Record<string, OptionRule>)[name]!.default);
        }
        expect(CONFIG_SCHEMA.callLimits.documented).toBe(`${DEFAULT_CALL_BUDGET.calls} calls and ${DEFAULT_CALL_BUDGET.bytes / 1048576} MiB per second`);
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
        ['capabilities', ['allow-pointer-lock'], 'cooperative', [], '"allow-pointer-lock" is not allowed in "capabilities" and was dropped. It reaches outside the sandbox'],
        ['capabilities', ['allow-pointer-lock'], 'strict', [], '"allow-pointer-lock" is not allowed in "capabilities" and was dropped. It reaches outside the sandbox'],
        ['unsafeCapabilities', ['allow-pointer-lock'], 'worker', ['allow-pointer-lock'], 'unsafe capability "allow-pointer-lock" is enabled'],
        ['unsafeCapabilities', ['allow-pointer-lock'], 'strict', [], 'unsafeCapabilities are not available in strict mode and were dropped: allow-pointer-lock.'],
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

// `origins`: what a listed origin reaches beyond the internet at large is said in every mode, once per kind
// (limitHostReach, the one pass over the parsed policy). The kinds are the schema's own (ORIGIN_KINDS). Strict mode drops
// an origin on the host page's site; cooperative and worker mode keep it and warn; a loopback host is kept and warns.
describe('origins: the host page\'s site and loopback hosts, in every mode, once per kind', () => {
    const PAGE = 'https://app.example:8443';
    const SAID = /^\[Sandbox\] origins\.\w+ (lists|dropped) /;
    const said = (mode: SandboxMode, origins: Record<string, string[]>, context: NormaliseContext = { hostOrigin: PAGE }) => normaliseConfig({ mode, origins }, context).warnings.filter(message => SAID.test(message));
    const kept = (mode: SandboxMode, origins: Record<string, string[]>, context: NormaliseContext = { hostOrigin: PAGE }) => normaliseConfig({ mode, origins }, context).value!.origins;
    // strict mode drops `scripts`, so no origin of that kind is left to warn about there
    const kindsIn = (mode: SandboxMode) => ORIGIN_KINDS.filter(kind => !(kind === 'scripts' && mode === 'strict'));
    const WARN_MODES = SANDBOX_MODES.filter(mode => mode !== 'strict');

    it.each(WARN_MODES)('%s: every kind warns for the host origin, for a host of its site and for loopback, one warning naming kind, origin and why, and keeps them', (mode) => {
        for (const kind of kindsIn(mode)) {
            const hostOrigin = said(mode, { [kind]: [PAGE] });
            expect(hostOrigin, `${kind} host origin`).toHaveLength(1);
            expect(hostOrigin[0]).toContain(`origins.${kind} lists ${PAGE} (the host page's own origin)`);
            expect(hostOrigin[0]).toContain("carry the host site's cookies");
            expect(hostOrigin[0]).toContain('fetch bridge');
            expect(kept(mode, { [kind]: [PAGE] })[kind]).toEqual([PAGE]);
            const loopback = said(mode, { [kind]: ['http://localhost:5173', 'http://127.0.0.1:9000'] });
            expect(loopback, `${kind} loopback`).toHaveLength(1);
            expect(loopback[0]).toContain(`origins.${kind} lists http://localhost:5173 (a loopback, private or link-local host), http://127.0.0.1:9000 (a loopback, private or link-local host)`);
            const site = said(mode, { [kind]: ['https://api.app.example', 'https://example', 'https://other.example'] });
            expect(site, `${kind} site`).toHaveLength(1);
            // a single label is private by name too (isPrivateHost): one entry, both reasons
            expect(site[0]).toContain(`origins.${kind} lists https://api.app.example (on the host page's site), https://example (on the host page's site, a loopback, private or link-local host):`);
            expect(site[0]).not.toContain('other.example');
            expect(kept(mode, { [kind]: ['https://api.app.example', 'https://example', 'https://other.example'] })[kind]).toEqual(['https://api.app.example', 'https://example', 'https://other.example']);
        }
    });

    it('strict: every kind drops the host origin and a host of its site with one warning, keeps a loopback host with its own warning, and leaves the rest', () => {
        for (const kind of kindsIn('strict')) {
            const dropped = said('strict', { [kind]: [PAGE, 'https://api.app.example', 'https://other.example'] });
            expect(dropped, `${kind} site`).toHaveLength(1);
            expect(dropped[0]).toContain(`origins.${kind} dropped ${PAGE} (the host page's own origin), https://api.app.example (on the host page's site):`);
            expect(dropped[0]).toContain("carry the host site's cookies");
            expect(dropped[0]).toContain('strict mode admits no origin on the host page\'s site');
            expect(dropped[0]).toContain('fetch bridge');
            expect(dropped[0]).not.toContain('other.example');
            expect(kept('strict', { [kind]: [PAGE, 'https://api.app.example', 'https://other.example'] })[kind]).toEqual(['https://other.example']);
            // a loopback host is not on the host page's site: kept, and it warns as it does in every mode
            const loopback = said('strict', { [kind]: ['http://localhost:5173'] });
            expect(loopback, `${kind} loopback`).toEqual([expect.stringContaining(`origins.${kind} lists http://localhost:5173 (a loopback, private or link-local host)`)]);
            expect(kept('strict', { [kind]: ['http://localhost:5173'] })[kind]).toEqual(['http://localhost:5173']);
            // both reasons: dropped for the site, and the entry says it is also a private host
            expect(said('strict', { [kind]: ['https://example'] })).toEqual([expect.stringContaining(`origins.${kind} dropped https://example (on the host page's site, a loopback, private or link-local host):`)]);
            expect(kept('strict', { [kind]: ['https://example'] })[kind]).toEqual([]);
        }
    });

    it('strict is the default mode: a config that names none drops the host origin; the dropped policy is frozen, and an untouched one is the parsed one', () => {
        const result = normaliseConfig({ origins: { connect: [PAGE], images: ['https://img.other.example'] } }, { hostOrigin: PAGE });
        expect(result.value!.origins.connect).toEqual([]);
        expect(result.value!.origins.images).toEqual(['https://img.other.example']);
        expect(Object.isFrozen(result.value!.origins)).toBe(true);
        expect(Object.isFrozen(result.value!.origins.connect)).toBe(true);
        expect(Object.isFrozen(result.value!.origins.images)).toBe(true);
        expect(result.warnings.filter(message => SAID.test(message))).toEqual([expect.stringContaining('origins.connect dropped')]);
        const untouched = normaliseConfig({ origins: { images: ['https://img.other.example'] } }, { hostOrigin: PAGE }).value!.origins;
        expect(Object.isFrozen(untouched) && Object.isFrozen(untouched.images)).toBe(true);
    });

    it('a kind that lists nothing of the kind is silent; a kind is named once however many entries it lists; other kinds are not named', () => {
        expect(said('cooperative', { connect: ['https://api.other.example'], images: ['https://img.other.example'] })).toEqual([]);
        const both = said('cooperative', { images: [PAGE, 'https://api.app.example', 'http://localhost:1'], fonts: [PAGE] });
        expect(both).toHaveLength(2);
        expect(both[0]).toContain('origins.images lists');
        expect(both[0]).not.toContain('origins.fonts');
        expect(said('cooperative', { connect: [PAGE] }, { hostOrigin: '' })).toEqual([]);
        expect(kept('strict', { connect: [PAGE] }, { hostOrigin: '' }).connect).toEqual([PAGE]);
    });

    it('by name alone: same host with another scheme or port, a subdomain and a parent are on the site; a sibling, an IP address and a lookalike are not', () => {
        for (const mode of SANDBOX_MODES) {
            const onSite = (origin: string) => said(mode, { connect: [origin] }).length === 1 && kept(mode, { connect: [origin] }).connect.length === (mode === 'strict' ? 0 : 1);
            for (const origin of ['https://app.example', 'https://app.example:1', 'https://x.app.example', 'https://example']) expect(onSite(origin), `${mode} ${origin}`).toBe(true);
            // a wss:// origin is listed beside its https:// twin (origins.ts), and the pair is on the site as one origin is
            const pair = { connect: ['https://app.example', 'wss://app.example'] };
            expect(said(mode, pair), `${mode} the pair`).toHaveLength(1);
            expect(kept(mode, pair).connect, `${mode} the pair`).toHaveLength(mode === 'strict' ? 0 : 2);
            for (const origin of ['https://sibling.example', 'https://notapp.example', 'https://app.example.evil', 'https://203.0.113.7']) expect(said(mode, { connect: [origin] }), `${mode} ${origin}`).toEqual([]);
        }
    });

    describe('with the registrable domain the browser decided (host-site.ts): a sibling is on the site, a public suffix is not', () => {
        const SITE_PAGE = 'https://app.example.co.uk';
        const context = (site: string | null): NormaliseContext => ({ hostOrigin: SITE_PAGE, hostSite: () => site });

        it.each(SANDBOX_MODES)('%s: a sibling, its subdomain and the registrable domain are on the site; a public suffix and a name of another site are not', (mode) => {
            const dropsIt = mode === 'strict';
            for (const origin of ['https://api.example.co.uk', 'https://deep.api.example.co.uk', 'https://example.co.uk', 'https://app.example.co.uk:8080']) {
                const result = said(mode, { connect: [origin] }, context('example.co.uk'));
                expect(result, `${mode} ${origin}`).toEqual([expect.stringContaining(dropsIt ? `origins.connect dropped ${origin} (on the host page's site)` : `origins.connect lists ${origin} (on the host page's site)`)]);
                expect(kept(mode, { connect: [origin] }, context('example.co.uk')).connect, `${mode} ${origin}`).toEqual(dropsIt ? [] : [origin]);
            }
            for (const origin of ['https://co.uk', 'https://other.co.uk', 'https://example.com', 'https://evilexample.co.uk']) {
                expect(said(mode, { connect: [origin] }, context('example.co.uk')), `${mode} ${origin}`).toEqual([]);
                expect(kept(mode, { connect: [origin] }, context('example.co.uk')).connect, `${mode} ${origin}`).toEqual([origin]);
            }
        });

        it('where the browser cannot be asked (null), or the context has no probe, the name check decides: a sibling is not recognised', () => {
            for (const given of [context(null), { hostOrigin: SITE_PAGE }]) {
                expect(said('cooperative', { connect: ['https://api.example.co.uk'] }, given)).toEqual([]);
                expect(said('cooperative', { connect: ['https://sub.app.example.co.uk'] }, given)).toHaveLength(1);
                expect(kept('strict', { connect: ['https://api.example.co.uk'] }, given).connect).toEqual(['https://api.example.co.uk']);
            }
        });

        it('the browser is asked only for an origin that could be on the site (the same last label)', () => {
            let asked = 0;
            const counting: NormaliseContext = { hostOrigin: SITE_PAGE, hostSite: () => { asked++; return 'example.co.uk'; } };
            normaliseConfig({ mode: 'cooperative', origins: { connect: ['https://cdn.other.net', SITE_PAGE, 'https://127.0.0.1:9'], images: ['https://img.other.net'] } }, counting);
            expect(asked).toBe(0);
            normaliseConfig({ mode: 'cooperative', origins: { connect: ['https://api.example.co.uk'] } }, counting);
            expect(asked).toBe(1);
        });
    });
});

describe("hostContentSecurityPolicy: the host page's policy as text, `false` to skip, or read from the page", () => {
    const read = (config: Record<string, unknown>, mode = 'strict') => normaliseWhole({ mode, ...config });

    it.each(['strict', 'cooperative', 'worker'])('%s: a string and false are kept as given; left out, it is absent (the page is read)', (mode) => {
        for (const value of ["connect-src 'self'", '', "connect-src 'none', connect-src https://api.example", false]) {
            const result = read({ hostContentSecurityPolicy: value }, mode);
            expect(result.value!.config.hostContentSecurityPolicy, `${mode} ${String(value)}`).toBe(value);
            expect(result.warnings, `${mode} ${String(value)}`).toEqual([]);
        }
        for (const config of [{}, { hostContentSecurityPolicy: undefined }]) {
            const result = read(config, mode);
            expect(Object.hasOwn(result.value!.config, 'hostContentSecurityPolicy'), mode).toBe(false);
            expect(result.warnings, mode).toEqual([]);
        }
    });

    it('any other value is ignored with one warning, and the page is read as if it were left out', () => {
        for (const value of [true, 0, 5, null, {}, [], ['connect-src *'], 1n]) {
            const result = read({ hostContentSecurityPolicy: value });
            expect(Object.hasOwn(result.value!.config, 'hostContentSecurityPolicy'), String(value)).toBe(false);
            expect(result.warnings, String(value)).toEqual([expect.stringMatching(/^\[Sandbox\] hostContentSecurityPolicy must be a string or false; .* was ignored: the host page's policy is read from the page\.$/)]);
        }
    });

    it('is documented as read from the page, in every mode, and the schema lists it among the stored options', () => {
        expect(CONFIG_SCHEMA.hostContentSecurityPolicy.documented).toBe('read from the page');
        expect([...CONFIG_SCHEMA.hostContentSecurityPolicy.modes]).toEqual([...SANDBOX_MODES]);
        expect(CONFIG_OPTIONS).toContain('hostContentSecurityPolicy');
        expect(PARSED_APART).not.toContain('hostContentSecurityPolicy');
    });
});

// Class C (the chokepoint is ownField, utils.ts): every field of a config the embedder gave is read as the object's own,
// never through the prototype chain, so a polluted Object.prototype of the host page gives no option a value.
describe('config reads: own fields only', () => {
    const NAMES = [...new Set<string>([...Object.keys(CONFIG_SCHEMA), ...FETCH_BRIDGE_FIELDS, ...CALL_LIMIT_FIELDS, ...ORIGIN_KINDS])];
    // values a pollution gadget would plant: a widening list, a number that lifts a budget, a string, a flag, an object
    const PLANTED: unknown[] = [['DELETE', 'authorization', 'https://evil.example', 'allow-popups'], 1e308, 'cooperative', true, { images: ['https://evil.example'] }];
    const CONFIGS: unknown[] = [
        {},
        { fetchBridge: { allow: ['https://api.example'] }, callLimits: {}, origins: {} },
        { fetchBridge: {}, callLimits: { maxPerSecond: 5 }, origins: { images: ['https://img.example'] } },
        { mode: 'worker', fetchBridge: { allow: [], methods: ['GET'], headers: ['x-a'], maxBytes: 5, timeoutMs: 5, maxConcurrent: 1 }, callLimits: { maxBytesPerSecond: 99999999 } },
        { mode: 'cooperative', capabilities: [], unsafeCapabilities: [], html: '<p>', origins: { scripts: [], connect: [] }, fetchBridge: { maxBytes: 5 } },
    ];
    // JSON.stringify keeps no Infinity, NaN, undefined or BigInt apart from null: name them
    const replacer = (_key: string, value: unknown): unknown => {
        if (typeof value === 'number' && !Number.isFinite(value)) return `#${value}`;
        if (typeof value === 'bigint') return `#${value}n`;
        return value === undefined ? '#undefined' : value;
    };
    const parse = (config: unknown) => {
        const result = normaliseWhole(structuredClone(config));
        return JSON.stringify({ value: result.value, warnings: result.warnings, refused: result.refusal !== null }, replacer);
    };

    it('the names are every option, every fetchBridge and callLimits field and every origins kind', () => {
        for (const name of ['mode', 'fetchBridge', 'callLimits', 'origins', 'allow', 'methods', 'headers', 'maxBytes', 'timeoutMs', 'maxConcurrent', 'maxPerSecond', 'maxBytesPerSecond', 'images', 'scripts', 'connect']) expect(NAMES).toContain(name);
    });

    it('a name set on Object.prototype changes no parsed config, warning or refusal', () => {
        const baselines = CONFIGS.map(parse);
        const changed: string[] = [];
        for (const name of NAMES) {
            for (const planted of PLANTED) {
                Object.defineProperty(Object.prototype, name, { value: planted, configurable: true, writable: true, enumerable: false });
                let results: string[];
                try { results = CONFIGS.map(parse); } finally { Reflect.deleteProperty(Object.prototype, name); }
                results.forEach((result, index) => { if (result !== baselines[index]) changed.push(`${name} = ${JSON.stringify(planted)} changes config #${index}`); });
            }
        }
        expect(NAMES.filter(name => Object.hasOwn(Object.prototype, name))).toEqual([]);
        expect(changed).toEqual([]);
    });

    it('the comparison sees a difference when there is one', () => {
        expect(parse({ fetchBridge: { allow: ['https://api.example'] } })).not.toBe(parse({ fetchBridge: { allow: ['https://api.example'], maxBytes: 5 } }));
        expect(parse({ callLimits: {} })).not.toBe(parse({ callLimits: { maxPerSecond: 7 } }));
    });

    it('the parsers read a field of the config only through ownField', () => {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const functionText = (file: string, name: string): string => {
            const text = readFileSync(path.join(here, '../../src/lib', file), 'utf8');
            const start = text.indexOf(`function ${name}(`);
            expect(start, `${name} in ${file}`).toBeGreaterThan(-1);
            return text.slice(start, text.indexOf('\n}\n', start));
        };
        for (const [file, name] of [['fetch-bridge.ts', 'toFetchPolicy'], ['config-schema.ts', 'callBudgetOf'], ['config-schema.ts', 'normaliseConfig'], ['csp/origins.ts', 'parseOrigins']] as const) {
            const body = functionText(file, name);
            expect(body, `${name} reads a field of its argument through the prototype chain`).not.toMatch(/\b(source|limits)(\[|\.[A-Za-z_])/);
            expect(body, `${name} checks ownership by hand`).not.toMatch(/Object\.hasOwn\((source|limits)/);
        }
    });
});
