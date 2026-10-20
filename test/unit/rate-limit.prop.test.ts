import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRateLimiter, isWeight } from '@src/lib/rate-limit';
import { inSandboxScript } from '@src/lib/in-sandbox-script';
import { SyntaxKind, tokenize } from '../../scripts/js-tokens';

/**
 * The sliding-window rate limiter, as properties (backlog S61.1; research 17's proof of concept, now in CI): against
 * the real src/lib/rate-limit.ts, and against the guest's own copy of the rule, lifted out of the bootstrap
 * (in-sandbox-script.ts, slidingWindow) as the guest runs it, and checked to decide alike (the differential test).
 *
 * Two of research 17's properties are preconditions, not guarantees: time never goes back (P4), and the guest and the
 * host agree only while the delay between them never shrinks (P2b; R3:L-4, documented). Each is kept as its
 * known counterexample, given to fast-check as an `examples` entry, so the test does not depend on the random search
 * finding it: should one stop failing, the precondition it documents has changed, and the docs with it.
 *
 * The input domain (P3, P5b; class C): a weight that is not a finite number ≥ 0 is refused on both sides, by one rule
 * (rate-limit.ts, isWeight). Before, the host admitted NaN, which the guest refused, and both admitted negative weights.
 */

const W = 1000; // the guest's window is one second, written out in its copy
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

/** The heaviest [s, s + W) over admitted (time, weight); the heaviest window starts at an admitted time. */
function busiest(admitted: [number, number][]): number {
    let max = 0;
    for (const [s] of admitted) {
        let sum = 0;
        for (const [t, w] of admitted) if (t >= s && t < s + W) sum += w;
        if (sum > max) max = sum;
    }
    return max;
}

// Non-decreasing times built from gaps, fractional like performance.now().
const gaps = fc.array(fc.double({ min: 0, max: 600, noNaN: true }), { minLength: 1, maxLength: 120 });
const sortedTimes = gaps.map(gs => { let t = 0; return gs.map(g => (t += g)); });
// Each time with an operation: a weight, and whether it is a probe (fits) or an admit.
const timedOps = sortedTimes.chain(ts => fc.tuple(fc.constant(ts), fc.array(fc.tuple(fc.nat(60), fc.boolean()), { minLength: ts.length, maxLength: ts.length })));
// Any number at all, the domain's edges first: what a caller could pass by mistake.
const anyWeight = fc.oneof(fc.constantFrom(NaN, Infinity, -Infinity, -0, -1, -Number.MIN_VALUE, Number.MAX_VALUE), fc.double(), fc.nat(60));

type GuestWindow = (weight: number, mode?: 'spent' | 'fits') => boolean;

/**
 * The guest's copy of the rule, as the bootstrap's text has it once built (inSandboxScript.toString(): the stringified
 * function the host hands the guest), lifted out by its tokens and run with a clock this test sets. It closes over
 * `now` and `list` only (the bootstrap's clock and its prototype-free list), which the lifted text is given.
 */
function guestWindowFactory(): (limit: number) => { at: (t: number) => void; call: GuestWindow } {
    const text = inSandboxScript.toString();
    const tokens = tokenize(text);
    const at = tokens.findIndex((token, i) => token.text === 'slidingWindow' && tokens[i - 1]?.kind === SyntaxKind.ConstKeyword && tokens[i + 1]?.kind === SyntaxKind.EqualsToken);
    if (at < 0) throw new Error('slidingWindow not found in the bootstrap');
    let open = at;
    while (tokens[open]!.kind !== SyntaxKind.OpenBraceToken) open++;
    let depth = 0;
    let close = open;
    for (; close < tokens.length; close++) {
        if (tokens[close]!.kind === SyntaxKind.OpenBraceToken) depth++;
        if (tokens[close]!.kind === SyntaxKind.CloseBraceToken && --depth === 0) break;
    }
    const source = text.slice(tokens[at + 2]!.start, tokens[close]!.end);
    const make = new Function('now', 'list', `return (${source});`) as (now: () => number, list: () => unknown[]) => (limit: number) => GuestWindow;
    return (limit: number) => {
        let clock = 0;
        const slidingWindow = make(() => clock, () => []);
        return { at: (t: number) => { clock = t; }, call: slidingWindow(limit) };
    };
}
const makeGuest = guestWindowFactory();

describe('the sliding-window limiter (rate-limit.ts), as properties', () => {
    it('P1 safety: at most `limit` admitted in any [s, s + W), with fits() probes mixed in', () => {
        fc.assert(fc.property(fc.integer({ min: 1, max: 50 }), timedOps, (L, [ts, ops]) => {
            const r = createRateLimiter(L, W);
            const admitted: [number, number][] = [];
            ts.forEach((t, i) => {
                const [w, probe] = ops[i]!;
                if (probe) r.fits(t, w);
                else if (r.admit(t, w)) admitted.push([t, w]);
            });
            return busiest(admitted) <= L;
        }), { numRuns: 500 });
    });

    it('P2 agreement: what the guest admits at its send times, the host admits too, while the delay never shrinks', () => {
        fc.assert(fc.property(
            fc.integer({ min: 1, max: 30 }), sortedTimes,
            fc.array(fc.double({ min: 0, max: 300, noNaN: true }), { minLength: 120, maxLength: 120 }),
            fc.array(fc.nat(10), { minLength: 120, maxLength: 120 }),
            (L, sends, delayGrowth, weights) => {
                const guest = createRateLimiter(L, W), host = createRateLimiter(L, W);
                let delay = 0;
                for (let i = 0; i < sends.length; i++) {
                    const w = weights[i]!;
                    if (!guest.admit(sends[i]!, w)) continue; // the guest never sends it
                    delay += delayGrowth[i]!; // non-decreasing
                    if (!host.admit(sends[i]! + delay, w)) return false;
                }
                return true;
            }), { numRuns: 500 });
    });

    it('P2b precondition: with a delay that shrinks (a busy host, FIFO), the host can refuse what the guest sent', () => {
        const result = fc.check(fc.property(
            fc.integer({ min: 1, max: 30 }), sortedTimes,
            fc.array(fc.double({ min: 0, max: 300, noNaN: true }), { minLength: 120, maxLength: 120 }),
            (L, sends, delays) => {
                const guest = createRateLimiter(L, W), host = createRateLimiter(L, W);
                let lastArrival = 0;
                for (let i = 0; i < sends.length; i++) {
                    if (!guest.admit(sends[i]!, 1)) continue;
                    lastArrival = Math.max(lastArrival, sends[i]! + delays[i]!); // FIFO port
                    if (!host.admit(lastArrival, 1)) return false;
                }
                return true;
            }), { numRuns: 1, examples: [[1, [0, 1000], [500, ...new Array(119).fill(0)]]] });
        expect(result.failed).toBe(true);
    });

    it('P3 input domain: a weight that is not a finite number >= 0 is never admitted, never fits, and takes nothing', () => {
        fc.assert(fc.property(fc.integer({ min: 1, max: 100 }), anyWeight, (L, w) => {
            const r = createRateLimiter(L, W);
            const ok = isWeight(w);
            const fits = r.fits(0, w);
            const admitted = r.admit(0, w);
            if (!ok && (fits || admitted)) return false;
            if (ok && (fits !== w <= L || admitted !== w <= L)) return false;
            // a refused weight recorded nothing: the whole limit still fits
            return ok || r.admit(0, L);
        }), { numRuns: 1000, examples: [[100, NaN], [100, -1], [100, Infinity]] });
        expect(createRateLimiter(100).admit(0, NaN)).toBe(false);
        expect(createRateLimiter(100).fits(0, -5)).toBe(false);
        expect(createRateLimiter(100).admit(0)).toBe(true); // the default weight, 1
    });

    it('P4 precondition: with time going back, the window bound fails (rate-limit.ts requires non-decreasing time)', () => {
        const result = fc.check(fc.property(
            fc.array(fc.tuple(fc.nat(3000), fc.boolean()), { minLength: 1, maxLength: 20 }),
            (ops) => {
                const r = createRateLimiter(1, W);
                const admitted: [number, number][] = [];
                for (const [t, probe] of ops) {
                    if (probe) r.fits(t, 1); else if (r.admit(t, 1)) admitted.push([t, 1]);
                }
                return busiest(admitted) <= 1;
            }), { numRuns: 1, examples: [[[[0, false], [1000, true], [0, false]]]] });
        expect(result.failed).toBe(true);
    });
});

describe("the guest's copy of the rule (in-sandbox-script.ts) against the host's: a differential test", () => {
    it('P5 the two decide alike on every admit, fits, and fits-then-record, over any weight', () => {
        // 'record': the call budget's idiom, a fits() on both windows and then the spending (the guest's 'spent', the
        // host's admit after fits; config-schema.ts, admitGuestCall).
        const op = fc.tuple(fc.oneof(fc.nat(60), anyWeight), fc.constantFrom('admit', 'fits', 'record'));
        fc.assert(fc.property(
            fc.integer({ min: 1, max: 50 }),
            sortedTimes.chain(ts => fc.tuple(fc.constant(ts), fc.array(op, { minLength: ts.length, maxLength: ts.length }))),
            (L, [ts, ops]) => {
                const host = createRateLimiter(L, W);
                const guest = makeGuest(L);
                for (let i = 0; i < ts.length; i++) {
                    const [w, kind] = ops[i]!;
                    const t = ts[i]!;
                    guest.at(t);
                    const a = kind === 'admit' ? host.admit(t, w) : kind === 'fits' ? host.fits(t, w) : host.fits(t, w) && host.admit(t, w);
                    const b = kind === 'admit' ? guest.call(w) : kind === 'fits' ? guest.call(w, 'fits') : guest.call(w, 'fits') && guest.call(w, 'spent');
                    if (a !== b) return false;
                }
                return true;
            }), { numRuns: 500 });
    });

    it('P5b the input domain: NaN, negative and infinite weights are refused by both', () => {
        for (const w of [NaN, -1, -Infinity, Infinity]) {
            const guest = makeGuest(100);
            guest.at(0);
            expect([createRateLimiter(100).admit(0, w), guest.call(w), guest.call(w, 'fits'), guest.call(w, 'spent')], String(w)).toEqual([false, false, false, false]);
        }
    });

    it('one rule: the guest spells out isWeight, the same expression', () => {
        const rule = read('src/lib/rate-limit.ts').match(/export const isWeight = \(weight: unknown\): boolean => ([^;]+);/)![1]!;
        expect(rule).toBe("typeof weight === 'number' && weight >= 0 && weight - weight === 0");
        const guest = read('src/lib/in-sandbox-script.ts');
        const window = guest.slice(guest.indexOf('const slidingWindow = '), guest.indexOf('const callBudget = features?.callBudget;'));
        expect(window).toContain(`if (!(${rule})) return false;`);
    });
});
