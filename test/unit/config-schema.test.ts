import { describe, it, expect } from 'vitest';
import { admitGuestCall, CALL_INVARIANTS, callBudgetOf, DEFAULT_CALL_BUDGET, heaviestCall, type CallBudget } from '@src/lib/config-schema';
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
