/**
 * The one measure of "linear in the input" for a unit test (backlog T9's class: a wall-clock measure that measures the
 * machine). A test hands it a small and a large input; it returns the ratio of the fastest time of the large to the
 * fastest time of the small, and the test bounds that ratio (8 times the input, a bound of 24: linear takes about 8, a
 * quadratic cost about 64). test/unit/host-share.test.ts fails a unit test that keeps a best-of-N or a ratio of clock
 * reads of its own.
 *
 * Why this cannot fail a linear cost on a loaded machine, and cannot pass a quadratic one:
 * - The sizes are sampled alternately (small, large, small, large, ...), so a stretch of load lands on both sizes and
 *   not on one size's whole batch, which a batch of small runs followed by a batch of large runs let it do.
 * - Each size keeps its fastest time. A sample is the true cost plus a non-negative disturbance, so more samples can only
 *   lower a minimum toward the true cost; the ratio of the minimums moves toward the true ratio.
 * - It keeps sampling while the ratio is over the bound, up to `maxRounds`. A linear cost (true ratio about 8) gets under
 *   24 once one quiet small and one quiet large sample land; a quadratic cost (true ratio about 64) stays over it however
 *   many samples are taken, since no minimum goes below the true cost.
 * - Setup stays out of the timed section: `prepare` runs before each sample's clock starts, `verify` after it stops.
 */

/** One input size: `prepare` builds the input (untimed) and returns the work to time, and what to check about its result. */
export type ScalingSize<R = unknown> = () => { run: () => R; verify?: (result: R) => void };

export interface ScalingOptions {
    /** The ratio the large size's fastest time must get under. */
    bound: number;
    /** Rounds (one small and one large sample each) taken before the ratio is judged. Default 3. */
    minRounds?: number;
    /** Rounds after which sampling stops with the ratio as it stands. Default 25. */
    maxRounds?: number;
}

export interface ScalingResult {
    /** The large size's fastest time over the small size's fastest time. */
    ratio: number;
    smallMs: number;
    largeMs: number;
    rounds: number;
    /** For the assertion message: `expect(result.ratio, result.message).toBeLessThan(bound)`. */
    message: string;
}

function sample<R>(size: ScalingSize<R>): number {
    const { run, verify } = size();
    const started = performance.now();
    const result = run();
    const elapsed = performance.now() - started;
    verify?.(result);
    return elapsed;
}

/** Times `small` and `large` alternately until the ratio of their fastest times is under `bound` (see the file comment). */
export function scalingRatio<S, L>(small: ScalingSize<S>, large: ScalingSize<L>, { bound, minRounds = 3, maxRounds = 25 }: ScalingOptions): ScalingResult {
    let smallMs = Infinity, largeMs = Infinity, rounds = 0;
    while (rounds < maxRounds) {
        smallMs = Math.min(smallMs, sample(small));
        largeMs = Math.min(largeMs, sample(large));
        rounds++;
        if (rounds >= minRounds && largeMs / smallMs < bound) break;
    }
    const ratio = largeMs / smallMs;
    return { ratio, smallMs, largeMs, rounds, message: `best of ${rounds} interleaved rounds: ${smallMs.toFixed(1)} ms small, ${largeMs.toFixed(1)} ms large, ratio ${ratio.toFixed(1)} (bound ${bound})` };
}
