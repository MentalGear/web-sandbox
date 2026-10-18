// S59 PoC: fast-check against the real src/lib/rate-limit.ts and the guest's copy in src/lib/in-sandbox-script.ts.
import { test, expect } from 'bun:test';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { createRateLimiter } from '../../../src/lib/rate-limit.ts';

const W = 1000;

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

// Non-decreasing times built from gaps; fractional like performance.now().
const gaps = fc.array(fc.double({ min: 0, max: 600, noNaN: true }), { minLength: 1, maxLength: 200 });
const sortedTimes = gaps.map(gs => { let t = 0; return gs.map(g => (t += g)); });

test('P1 safety: at most L in any [s, s+W), with fits() calls mixed in (real createRateLimiter)', () => {
    fc.assert(fc.property(
        fc.integer({ min: 1, max: 50 }),
        sortedTimes.chain(ts => fc.tuple(fc.constant(ts), fc.array(fc.tuple(fc.nat(60), fc.boolean()), { minLength: ts.length, maxLength: ts.length }))),
        (L, [ts, ops]) => {
            const r = createRateLimiter(L, W);
            const admitted: [number, number][] = [];
            ts.forEach((t, i) => {
                const [w, probe] = ops[i]!;
                if (probe) r.fits(t, w);
                else if (r.admit(t, w)) admitted.push([t, w]);
            });
            return busiest(admitted) <= L;
        }), { numRuns: 2000 });
});

test('P2 agreement: guest admits at send times, delay never shrinks => host admits all', () => {
    fc.assert(fc.property(
        fc.integer({ min: 1, max: 30 }), sortedTimes,
        fc.array(fc.double({ min: 0, max: 300, noNaN: true }), { minLength: 200, maxLength: 200 }),
        fc.array(fc.nat(10), { minLength: 200, maxLength: 200 }),
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
        }), { numRuns: 2000 });
});

test('P2b agreement without the delay condition (FIFO, a busy host): expected to FAIL; shrunk counterexample', () => {
    let report = '';
    try {
        fc.assert(fc.property(
            fc.integer({ min: 1, max: 30 }), sortedTimes,
            fc.array(fc.double({ min: 0, max: 300, noNaN: true }), { minLength: 200, maxLength: 200 }),
            (L, sends, delays) => {
                const guest = createRateLimiter(L, W), host = createRateLimiter(L, W);
                let lastArrival = 0;
                for (let i = 0; i < sends.length; i++) {
                    if (!guest.admit(sends[i]!, 1)) continue;
                    lastArrival = Math.max(lastArrival, sends[i]! + delays[i]!); // FIFO port
                    if (!host.admit(lastArrival, 1)) return false;
                }
                return true;
            }), {
            numRuns: 2000,
            // The known counterexample, checked first: a search that may miss it would make this test depend on luck.
            examples: [[1, [0, 1000], [500, ...new Array(199).fill(0)]]],
        });
    } catch (e) { report = String(e).split('\n').slice(0, 4).join('\n'); }
    console.log('P2b:', report);
    expect(report).toContain('Property failed');
});

test('P3 input domain: a weight that is not a finite number >= 0 is never admitted (expected to FAIL)', () => {
    let report = '';
    try {
        fc.assert(fc.property(fc.double(), (w) => {
            const r = createRateLimiter(100, W);
            return !r.admit(0, w) || (Number.isFinite(w) && w >= 0);
        }), { examples: [[Number.NaN]] });
    } catch (e) { report = String(e).split('\n').slice(0, 4).join('\n'); }
    console.log('P3:', report);
    expect(report).toContain('Property failed');
});

test('P4 precondition: with time going back, P1 fails (expected to FAIL; rate-limit.ts requires non-decreasing time)', () => {
    let report = '';
    try {
        fc.assert(fc.property(
            fc.array(fc.tuple(fc.nat(3000), fc.boolean()), { minLength: 1, maxLength: 20 }),
            (ops) => {
                const r = createRateLimiter(1, W);
                const admitted: [number, number][] = [];
                for (const [t, probe] of ops) {
                    if (probe) r.fits(t, 1); else if (r.admit(t, 1)) admitted.push([t, 1]);
                }
                return busiest(admitted) <= 1;
            }), { examples: [[[[0, false], [1000, true], [0, false]]]] });
    } catch (e) { report = String(e).split('\n').slice(0, 4).join('\n'); }
    console.log('P4:', report);
    expect(report).toContain('Property failed');
});

// ---- The guest's own copy of the rule (in-sandbox-script.ts), lifted out of the bootstrap's text and run as is.
function guestWindow(): (limit: number) => { at: (t: number) => void; call: (w: number, mode?: 'spent' | 'fits') => boolean } {
    const text = readFileSync(new URL('../../../src/lib/in-sandbox-script.ts', import.meta.url), 'utf8');
    const start = text.indexOf('    const slidingWindow = (limit: number) => {');
    const end = text.indexOf('\n    };\n', start) + 7;
    if (start < 0 || end < start) throw new Error('slidingWindow not found');
    const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(
        `let __t = 0; const now = () => __t; const list = () => [];\n${text.slice(start, end)}\n` +
        `export const make = (limit) => { const f = slidingWindow(limit); return { at: (t) => { __t = t; }, call: f }; };`);
    const mod = new Function('exports', js.replace(/export const make/, 'exports.make'));
    const exports: any = {};
    mod(exports);
    return (limit: number) => exports.make(limit);
}

test('P5 differential: the guest copy and createRateLimiter decide alike on every admit and fits', () => {
    const makeGuest = guestWindow();
    fc.assert(fc.property(
        fc.integer({ min: 1, max: 50 }),
        sortedTimes.chain(ts => fc.tuple(fc.constant(ts), fc.array(fc.tuple(fc.nat(60), fc.boolean()), { minLength: ts.length, maxLength: ts.length }))),
        (L, [ts, ops]) => {
            const host = createRateLimiter(L, W);
            const g = makeGuest(L);
            for (let i = 0; i < ts.length; i++) {
                const [w, probe] = ops[i]!;
                g.at(ts[i]!);
                const a = probe ? host.fits(ts[i]!, w) : host.admit(ts[i]!, w);
                const b = probe ? g.call(w, 'fits') : g.call(w);
                if (a !== b) return false;
            }
            return true;
        }), { numRuns: 2000 });
});

test('P5b differential on the input domain: NaN weight (guest refuses, host admits)', () => {
    const g = guestWindow()(100);
    g.at(0);
    const host = createRateLimiter(100, W);
    console.log('P5b: host.admit(0, NaN) =', host.admit(0, NaN), '; guest(NaN) =', g.call(NaN));
});
