import { describe, expect, it } from 'vitest';
import { scalingRatio, type ScalingSize } from './scaling';

/** test/unit/scaling.ts: a linear cost passes, a quadratic one fails, a disturbance on some samples does not decide it. */

// a cost of `steps` iterations; the result depends on all of them, so the loop is not dropped
const spin = (steps: number) => {
    let x = 0;
    for (let i = 0; i < steps; i++) x = (x + i * 31) % 1000003;
    return x;
};
const linear = (n: number): ScalingSize<number> => () => ({ run: () => spin(n * 5000) });
const quadratic = (n: number): ScalingSize<number> => () => ({ run: () => spin(n * n * 50) });

describe('scalingRatio', () => {
    it('a linear cost over 8 times the input gets under the bound of a true ratio of about 8', () => {
        const result = scalingRatio(linear(10), linear(80), { bound: 24 });
        expect(result.ratio, result.message).toBeLessThan(24);
        expect(result.rounds).toBeGreaterThanOrEqual(3);
    });

    it('a quadratic cost stays over the bound however many rounds are taken, and the rounds run out', () => {
        const result = scalingRatio(quadratic(30), quadratic(240), { bound: 24, maxRounds: 6 });
        expect(result.ratio, result.message).toBeGreaterThan(24);
        expect(result.rounds).toBe(6);
    });

    it('a disturbance on the first samples of the large size is outlasted: more rounds lower the minimum', () => {
        let large = 0;
        const disturbed: ScalingSize<number> = () => {
            const disturbance = large++ < 4 ? 40 : 0; // ms of load on the first four large samples
            return { run: () => { const until = performance.now() + disturbance; while (performance.now() < until); return spin(80 * 5000); } };
        };
        const result = scalingRatio(linear(10), disturbed, { bound: 24 });
        expect(result.ratio, result.message).toBeLessThan(24);
        expect(result.rounds).toBeGreaterThan(4);
    });

    it('prepare stays out of the timed section, verify runs on every sample after it, and the sizes alternate', () => {
        const order: string[] = [];
        const size = (name: string, ms: number): ScalingSize<number> => () => {
            const until = performance.now() + ms; // untimed setup
            while (performance.now() < until);
            order.push(`prepare ${name}`);
            return { run: () => spin(100), verify: () => { order.push(`verify ${name}`); } };
        };
        const result = scalingRatio(size('small', 100), size('large', 100), { bound: Infinity, minRounds: 2 });
        // a time far under the setup's 100 ms (the fastest of two samples of a hundred steps), which was not counted
        expect(Math.max(result.smallMs, result.largeMs)).toBeLessThan(100);
        expect(order).toEqual(['prepare small', 'verify small', 'prepare large', 'verify large', 'prepare small', 'verify small', 'prepare large', 'verify large']);
    });
});
