/**
 * The one rate limiter of the library's per-second limits that refuse (focused review 2026-10-14, W2): guest log
 * lines (sandbox-log.ts), guest writes, by count and by bytes (guest-writes.ts), and the calls the guest makes, by
 * count and by bytes (host.ts; review round 3, M-2).
 *
 * The documented property is "at most `limit` in any one-second window", and a sliding window is what makes it
 * hold. The earlier limiters counted in fixed windows that a first event opened: a guest that filled the end of
 * one window and the start of the next got twice the limit through in a few milliseconds (199 of 100 writes,
 * 1999 of 1000 log lines), which no reading of "per second" allows. A token bucket would not hold it either: a
 * full bucket plus its refill admits up to twice the capacity in one window.
 *
 * So each admitted event is remembered with its time and weight until it leaves the window, and an event is
 * admitted only if the weights still in the window plus its own stay within the limit. The window is half-open,
 * (now - windowMs, now]: an event admitted at t counts against every event in [t, t + windowMs). Proof of the
 * property: if limit + 1 units fell in some [s, s + windowMs), the last of them was admitted at a time u < s +
 * windowMs while every other one had a time ≥ s > u - windowMs, so it was counted against them and refused.
 *
 * Memory is bounded by the events admitted in one window: at most `limit` entries for a count, and for bytes at
 * most the requests admitted in that window (each guest write is counted by both limiters). Weights of 0 are
 * admitted without an entry. The caller passes the time, so one clock reading serves several limiters.
 *
 * Auto-sizing (auto-resize.ts) does not use it: it never refuses a report, it delays the newest one, and spacing
 * its writes at least 1000 / AUTO_RESIZE_MAX_UPDATES_PER_SECOND ms apart already gives the same window property
 * (asserted in test/unit/focused-review.test.ts, W2).
 *
 * A weight is a finite number ≥ 0 (isWeight), and anything else is refused, by admit() and fits() alike, recording
 * nothing (backlog S61; research 17, P3 and P5b; class C, a caller value checked against the domain of the rule). The
 * arithmetic above holds only over that domain: a weight of NaN made `total + weight > limit` false, so the host admitted
 * it, while the guest's copy of the rule, which asks `total + weight <= limit`, refused it; a negative weight was
 * admitted and recorded nothing, so it took nothing from the window either way, which no reading of "weight" allows.
 * Both are latent: every caller passes a count or a measure. The guest's copy (in-sandbox-script.ts, slidingWindow)
 * spells out the same expression, since it is stringified and may call nothing of this module; a unit test keeps the
 * two texts equal, and a differential property test (test/unit/rate-limit.prop.test.ts) runs both on the same inputs.
 *
 * Host-side only, never stringified into the guest, so it may use module scope freely.
 */
export interface RateLimiter {
    /** Admits `weight` (default 1) at `time` (ms, non-decreasing) if the window stays within the limit; records it then. */
    admit(time: number, weight?: number): boolean;
    /** Whether admit() would admit `weight` at `time`, recording nothing: for one event counted by two limiters or neither. */
    fits(time: number, weight?: number): boolean;
}

/**
 * Whether `weight` is one a limiter can count: a finite number ≥ 0. Arithmetic only, no global (Number.isFinite is the
 * guest's to replace where the guest's copy runs): `weight - weight` is 0 for every finite number and NaN for NaN and
 * ±Infinity. The guest's copy of the rule has this very expression (a unit test compares the texts).
 */
export const isWeight = (weight: unknown): boolean => typeof weight === 'number' && weight >= 0 && weight - weight === 0;

export function createRateLimiter(limit: number, windowMs = 1000): RateLimiter {
    const times: number[] = [];
    const weights: number[] = [];
    let head = 0; // entries before head have left the window
    let total = 0; // the weights of entries[head..]

    // Lets go of what left the window by `time`.
    const advance = (time: number) => {
        while (head < times.length && times[head]! <= time - windowMs) {
            total -= weights[head]!;
            head++;
        }
        if (head > 64 && head * 2 > times.length) { // drop what left the window, now and then
            times.splice(0, head);
            weights.splice(0, head);
            head = 0;
        }
    };

    return {
        fits(time: number, weight = 1): boolean {
            advance(time);
            return isWeight(weight) && total + weight <= limit;
        },
        admit(time: number, weight = 1): boolean {
            advance(time);
            if (!isWeight(weight) || total + weight > limit) return false;
            if (weight > 0) {
                times.push(time);
                weights.push(weight);
                total += weight;
            }
            return true;
        },
    };
}
