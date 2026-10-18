// S59: the view's time budget arithmetic (in-sandbox-view.ts refill/charge/run-when-time>=0), copied as a model.
// Question: what is the most busy time in any 1000 ms window, against "at most 200 ms per second"?
import { test } from 'bun:test';
import fc from 'fast-check';

const RATE = 200, DEBT = 1000;

/** Each op costs `c` ms of real time (flush + rendering, charged in full up to the debt cap); returns busy intervals. */
function simulate(costs: number[]): [number, number][] {
    let t = 0, time = RATE, refilled = 0;
    const busy: [number, number][] = [];
    const refill = () => { time = Math.min(RATE, time + ((t - refilled) / 1000) * RATE); refilled = t; };
    for (const c of costs) {
        refill();
        if (time < 0) { t += Math.ceil((-time / RATE) * 1000); refill(); } // schedule(): wait for the budget
        busy.push([t, t + c]);
        t += c;
        refill();
        time = Math.max(-DEBT, time - c);
    }
    return busy;
}

function busiestWindow(busy: [number, number][], W = 1000): number {
    let max = 0;
    for (const [s] of busy) {
        let sum = 0;
        for (const [a, b] of busy) sum += Math.max(0, Math.min(b, s + W) - Math.max(a, s));
        max = Math.max(max, sum);
    }
    return max;
}

test('view time budget: busiest 1 s window, ops each at most 1000 ms (the debt cap, so every op is charged in full)', () => {
    let worst = 0, worstCosts: number[] = [];
    fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: Number(process.env.MAXOP ?? 1000) }), { minLength: 1, maxLength: 12 }), costs => {
        const b = busiestWindow(simulate(costs));
        if (b > worst) { worst = b; worstCosts = costs; }
        return true;
    }), { numRuns: 20000 });
    const fixed = [199, 199, 199, 199, 199, 199].map(() => 199);
    console.log('random search worst:', worst.toFixed(0), 'ms with', JSON.stringify(worstCosts.slice(0, 6)));
    console.log('199 ms ops:', busiestWindow(simulate(fixed)).toFixed(0), 'ms;', '1000 ms ops:', busiestWindow(simulate([1000, 1000, 1000])).toFixed(0), 'ms');
    console.log('long run, 20 s ops: busy share', (() => { const b = simulate(Array(10).fill(20000)); const end = b[b.length - 1]![1]; return (b.reduce((s, [a, z]) => s + z - a, 0) / end).toFixed(2); })());
});
