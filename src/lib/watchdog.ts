/**
 * Liveness watchdog for one frame generation (backlog S6, default mode; ADR-003).
 *
 * The host pings the guest over the private port and the guest's bootstrap answers each ping from its
 * port handler (see in-sandbox-script.ts). A guest whose event loop is blocked — an endless loop, or
 * synchronous work longer than the budget — cannot answer, and once nothing has been heard for the
 * whole budget the watchdog calls `onExpire`, exactly once. The host then terminates the sandbox.
 *
 * What it can bound: a blocked guest event loop, wherever the guest runs on a different thread or
 * process from the host — worker mode on every browser, and iframe mode where the browser puts the
 * sandboxed frame in its own process (browser policy: Chromium often does, not in every environment). What it cannot: where the frame shares
 * the host's thread, a guest loop blocks these timers too, so nothing here runs until the guest yields.
 * That is a platform limit; strict mode (ADR-005) avoids it by running guest code only in a worker, which
 * this watchdog watches there on every browser. It is a liveness check, not a
 * security boundary: a guest that answers pings is merely alive, and the host keeps explicit control
 * through terminate().
 *
 * Host-side only, never stringified into the guest, so it may use module scope freely.
 *
 * Timing. The budget is split into TICKS_PER_BUDGET ticks. Each tick checks whether an answer arrived
 * since the previous tick, then sends the next ping. Expiry needs TICKS_PER_BUDGET silent ticks in a
 * row, so a peer that answers at least once per budget is never stopped, and a peer that falls silent
 * is stopped between one and 1.25 budgets after its last answer.
 * Counting ticks rather than comparing timestamps is deliberate: time in which the HOST itself was
 * stalled (a long task on the host page, a throttled background tab) produces no ticks, so it is never
 * counted against the guest. After a host stall exactly one tick runs, possibly before the answer that
 * is already queued gets delivered; that costs one silent tick, never a termination. Ticks are chained
 * timeouts rather than an interval, so two ticks can never run back to back.
 */

export interface WatchdogOptions {
    /** How long the peer may stay silent, in ms. Must be a finite number > 0 (see watchdogBudget). */
    timeoutMs: number;
    /** Posts `{ type: 'PING', n }` to the peer. */
    ping: (n: number) => void;
    /** Called once, when the peer stayed silent for the whole budget. The watchdog is stopped by then. */
    onExpire: () => void;
}

export interface Watchdog {
    /** Feed the `n` of every inbound PONG here. Anything but an answer to a ping still unanswered is ignored. */
    handlePong(n: unknown): void;
    /** Stops pinging for good. Idempotent; after it neither `ping` nor `onExpire` is ever called again. */
    stop(): void;
}

const TICKS_PER_BUDGET = 4;

/** The budget a config value asks for, or 0 (watchdog off) for anything that is not a finite number > 0. */
export function watchdogBudget(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
    return value;
}

/** Sends the first ping now and keeps pinging until stop() or expiry. */
export function startWatchdog({ timeoutMs, ping, onExpire }: WatchdogOptions): Watchdog {
    const interval = timeoutMs / TICKS_PER_BUDGET;
    let lastSent = 0;       // n of the newest ping sent
    let lastAnswered = 0;   // n of the newest ping answered
    let heard = false;      // an answer arrived since the previous tick
    let silentTicks = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const stop = () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };

    // The next tick is armed before posting, so a transport that throws cannot stop the watchdog: the
    // peer simply goes unheard and the budget runs out.
    const sendPing = () => {
        timer = setTimeout(tick, interval);
        lastSent++;
        ping(lastSent);
    };

    const tick = () => {
        timer = null;
        if (stopped) return;
        silentTicks = heard ? 0 : silentTicks + 1;
        heard = false;
        if (silentTicks >= TICKS_PER_BUDGET) {
            stop();
            onExpire();
            return;
        }
        sendPing();
    };

    // An answer counts only if it answers a ping we sent and is newer than the last one counted: a
    // repeated, stale or made-up n proves nothing about the guest's loop running now.
    const handlePong = (n: unknown) => {
        if (stopped) return;
        if (typeof n !== 'number' || !Number.isInteger(n)) return;
        if (n <= lastAnswered || n > lastSent) return;
        lastAnswered = n;
        heard = true;
    };

    sendPing();
    return { handlePong, stop };
}
