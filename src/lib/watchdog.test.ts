import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startWatchdog, watchdogBudget } from "./watchdog";

/**
 * The liveness watchdog's timing (backlog S6, ADR-003): a peer that answers is never stopped, a peer
 * that falls silent is stopped exactly once within the budget plus one tick, answers that prove
 * nothing are ignored, and a stopped watchdog never acts again.
 */

const BUDGET = 1000;
const TICK = BUDGET / 4;

// A peer that answers every ping on the next macrotask, the way a responsive guest would.
function responsivePeer() {
    const sent: number[] = [];
    let watchdog: ReturnType<typeof startWatchdog> | null = null;
    let answering = true;
    const onExpire = vi.fn();
    watchdog = startWatchdog({
        timeoutMs: BUDGET,
        ping: n => {
            sent.push(n);
            if (answering) setTimeout(() => watchdog?.handlePong(n), 1);
        },
        onExpire,
    });
    return { watchdog, sent, onExpire, silence: () => { answering = false; } };
}

describe("watchdog", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("never stops a peer that answers, over many budgets", () => {
        const { sent, onExpire } = responsivePeer();
        vi.advanceTimersByTime(BUDGET * 20);
        expect(onExpire).not.toHaveBeenCalled();
        expect(sent.length).toBeGreaterThanOrEqual(80); // it kept pinging the whole time
    });

    it("never stops a slow peer that answers at least once per budget", () => {
        const onExpire = vi.fn();
        const sent: number[] = [];
        const watchdog = startWatchdog({ timeoutMs: BUDGET, ping: n => sent.push(n), onExpire });
        for (let i = 0; i < 20; i++) {
            vi.advanceTimersByTime(BUDGET - 10);
            watchdog.handlePong(sent[sent.length - 1]); // answers only the newest ping, just inside the budget
        }
        expect(onExpire).not.toHaveBeenCalled();
    });

    it("stops a peer that never answers once, after exactly one budget", () => {
        const onExpire = vi.fn();
        startWatchdog({ timeoutMs: BUDGET, ping: () => {}, onExpire });
        vi.advanceTimersByTime(BUDGET - 1);
        expect(onExpire).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onExpire).toHaveBeenCalledTimes(1);
    });

    it("stops a peer that falls silent between one budget and one budget plus a tick after its last answer, exactly once", () => {
        const { sent, onExpire, silence } = responsivePeer();
        vi.advanceTimersByTime(BUDGET * 3);
        silence();
        const lastAnsweredAt = Date.now(); // the last answer went out within a tick before this
        vi.advanceTimersByTime(BUDGET - TICK);
        expect(onExpire).not.toHaveBeenCalled();
        vi.advanceTimersByTime(TICK * 2);
        expect(onExpire).toHaveBeenCalledTimes(1);
        expect(Date.now() - lastAnsweredAt).toBeLessThanOrEqual(BUDGET + TICK);

        // Once expired it is stopped: no more pings and no second expiry, however long it runs.
        const pingsAtExpiry = sent.length;
        vi.advanceTimersByTime(BUDGET * 10);
        expect(onExpire).toHaveBeenCalledTimes(1);
        expect(sent.length).toBe(pingsAtExpiry);
    });

    it("ignores stale, repeated, future and malformed answers", () => {
        const onExpire = vi.fn();
        const sent: number[] = [];
        const watchdog = startWatchdog({ timeoutMs: BUDGET, ping: n => sent.push(n), onExpire });
        vi.advanceTimersByTime(TICK);
        watchdog.handlePong(1); // a genuine answer: counts
        const junk: unknown[] = [1, 0, -1, 9999, 1.5, NaN, Infinity, '2', null, undefined, {}, [2]];
        for (let i = 0; i < 12; i++) {
            vi.advanceTimersByTime(TICK);
            for (const n of junk) watchdog.handlePong(n); // repeats of 1, never-sent n, non-integers, non-numbers
        }
        expect(sent.length).toBeGreaterThan(2);
        expect(onExpire).toHaveBeenCalledTimes(1);
    });

    it("counts an answer to an older ping that is still newer than the last answer", () => {
        const onExpire = vi.fn();
        const sent: number[] = [];
        const watchdog = startWatchdog({ timeoutMs: BUDGET, ping: n => sent.push(n), onExpire });
        for (let i = 0; i < 20; i++) {
            vi.advanceTimersByTime(TICK * 2);
            watchdog.handlePong(sent[sent.length - 2]); // always one ping behind, but making progress
        }
        expect(onExpire).not.toHaveBeenCalled();
    });

    it("never pings or expires again after stop()", () => {
        const onExpire = vi.fn();
        const ping = vi.fn();
        const watchdog = startWatchdog({ timeoutMs: BUDGET, ping, onExpire });
        expect(ping).toHaveBeenCalledTimes(1); // the first ping goes out at start
        watchdog.stop();
        watchdog.stop(); // idempotent
        vi.advanceTimersByTime(BUDGET * 10);
        expect(ping).toHaveBeenCalledTimes(1);
        expect(onExpire).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("an answer delivered just after a tick, as after a host stall, costs one silent tick, never a termination", () => {
        // The answer to the last ping is already on its way when the host stalls: on the host, the one late
        // tick may run before that answer is delivered. Simulated by delivering it right after the tick.
        const onExpire = vi.fn();
        const sent: number[] = [];
        const watchdog = startWatchdog({ timeoutMs: BUDGET, ping: n => sent.push(n), onExpire });
        for (let round = 0; round < 10; round++) {
            vi.advanceTimersByTime(TICK); // one (late) tick, no answer delivered yet
            watchdog.handlePong(sent[sent.length - 1]);
        }
        expect(onExpire).not.toHaveBeenCalled();
    });

    it("keeps pinging when a ping cannot be posted, so the budget still runs out", () => {
        const onExpire = vi.fn();
        let calls = 0;
        startWatchdog({ timeoutMs: BUDGET, ping: () => { calls++; if (calls > 1) throw new Error('port gone'); }, onExpire });
        for (let i = 0; i < 4; i++) {
            try { vi.advanceTimersByTime(TICK); } catch { /* the throwing ping surfaces from the timer */ }
        }
        expect(onExpire).toHaveBeenCalledTimes(1);
    });
});

describe("watchdogBudget", () => {
    it("is off (0) unless the value is a finite number above zero", () => {
        expect(watchdogBudget(1500)).toBe(1500);
        expect(watchdogBudget(0.5)).toBe(0.5);
        const off: unknown[] = [undefined, null, 0, -1, NaN, Infinity, -Infinity, '1000', {}, true];
        for (const value of off) expect(watchdogBudget(value)).toBe(0);
    });
});
