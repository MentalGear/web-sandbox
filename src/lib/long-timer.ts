/**
 * The one timer for a delay that a config or a caller chooses: watchdogTimeout,
 * workerExecutionTimeout, a call's timeout, the fetch bridge's timeoutMs (R2:L-2). setTimeout takes its delay as a 32-bit signed
 * integer, so 2^31 ms or more (2**33, Infinity) overflows and fires at once: a watchdog of 2**33 ms would terminate a
 * healthy guest within 50–200 ms, and callWithTimeout(Infinity, …) would reject TIMEOUT after its request had been sent.
 * Here a delay past MAX_TIMER_DELAY is waited out in chained timeouts of at most that, and a delay that is not finite
 * (Infinity) never fires: it means off. A delay that is not a number > 0 (0, a negative number, NaN) fires as soon as a
 * timeout of 0 would. A unit test keeps every other setTimeout in the library to a delay of its own choosing.
 *
 * Host-side only. rpc.ts, which is stringified into the guest and so imports nothing, chains the same way inside
 * createBroker (a test keeps its MAX_TIMER_DELAY equal to this one).
 */
export const MAX_TIMER_DELAY = 2147483647;

/** A pending long timeout; cancel() is idempotent, and after it the callback never runs. */
export interface LongTimeout {
    cancel(): void;
}

export function setLongTimeout(callback: () => void, delay: number): LongTimeout {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    // `left` ms still to wait; each step waits at most MAX_TIMER_DELAY of it
    const wait = (left: number) => {
        const step = left > MAX_TIMER_DELAY ? MAX_TIMER_DELAY : left;
        timer = setTimeout(() => {
            timer = null;
            if (cancelled) return;
            if (left > step) wait(left - step);
            else callback();
        }, step);
    };
    if (delay !== Infinity) wait(delay > 0 ? delay : 0);
    return {
        cancel() {
            cancelled = true;
            if (timer !== null) clearTimeout(timer);
            timer = null;
        },
    };
}
