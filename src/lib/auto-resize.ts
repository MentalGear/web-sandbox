/**
 * Content auto-sizing, host side (backlog B6). Opt-in with `autoResize: true`, cooperative mode only.
 *
 * The guest bootstrap (in-sandbox-script.ts) observes the guest's root element with a ResizeObserver and
 * reports the content height over the port as a first-class RESIZE frame, outside the broker, so no
 * exposed method name can collide with it. The host turns reports into the element's height here.
 *
 * Every report is guest-supplied: guest code can reach the port (it can patch
 * MessagePort.prototype.postMessage) and post any value, as often as it likes. So nothing here trusts a
 * report beyond its shape, and this module is the one place a report can become a height:
 *   - validation: a finite, non-negative number, rounded up to whole pixels and clamped to
 *     AUTO_RESIZE_MAX_HEIGHT; anything else is not a report and is dropped;
 *   - coalescing: reports only record the newest height; it is written at the next animation frame, so
 *     the host writes at most once per frame however many reports arrive;
 *   - rate cap: two writes are at least AUTO_RESIZE_MIN_INTERVAL_MS apart, so a guest whose height
 *     oscillates (or that floods the port) costs the host page at most AUTO_RESIZE_MAX_UPDATES_PER_SECOND
 *     relayouts per second. A report is never lost to the cap: the newest one is written once the
 *     interval has passed, so the element always ends at the guest's last reported height.
 * What the cap does not bound is the cost of receiving the messages themselves (backlog S6's open note).
 *
 * Host-side only, never stringified into the guest, so it may use module scope freely.
 */

/** The tallest height, in CSS pixels, a guest can give the element; larger reports are clamped to it. */
export const AUTO_RESIZE_MAX_HEIGHT = 100000;

/** At most this many height changes per second (and never more than one per animation frame). */
export const AUTO_RESIZE_MAX_UPDATES_PER_SECOND = 30;

const AUTO_RESIZE_MIN_INTERVAL_MS = 1000 / AUTO_RESIZE_MAX_UPDATES_PER_SECOND;

/**
 * The height one RESIZE frame reports, or null when the frame is not a report: `height` must be a
 * finite number >= 0. Fractions are rounded up (a frame one pixel short shows a scrollbar), and values
 * above AUTO_RESIZE_MAX_HEIGHT are clamped to it. Nothing else on the frame is read.
 */
export function toResizeHeight(frame: unknown): number | null {
    if (!frame || typeof frame !== 'object') return null;
    const height = (frame as Record<string, unknown>).height;
    if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) return null;
    if (height === 0) return 0; // -0 too
    return Math.min(Math.ceil(height), AUTO_RESIZE_MAX_HEIGHT);
}

/** The clock and frame scheduling the resizer runs on; the browser's by default, a fake one in unit tests. */
export interface ResizeScheduler {
    now(): number;
    requestFrame(callback: () => void): number;
    cancelFrame(handle: number): void;
    setTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
    clearTimer(handle: ReturnType<typeof setTimeout>): void;
}

const BROWSER_SCHEDULER: ResizeScheduler = {
    now: () => performance.now(),
    requestFrame: (callback) => requestAnimationFrame(() => callback()),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle),
};

export interface AutoResizer {
    /** Feed every inbound RESIZE frame here; it is validated (toResizeHeight) and coalesced. */
    report(frame: unknown): void;
    /** Stops for good: nothing scheduled runs, and later reports are ignored. Idempotent. */
    stop(): void;
}

/**
 * Starts a resizer for one frame generation. `apply` receives each height to write, already validated
 * and clamped, never the same height twice in a row, at most once per animation frame and at most
 * AUTO_RESIZE_MAX_UPDATES_PER_SECOND times per second.
 */
export function startAutoResize(apply: (height: number) => void, scheduler: ResizeScheduler = BROWSER_SCHEDULER): AutoResizer {
    let pending: number | null = null;     // newest valid report not yet written
    let lastApplied: number | null = null; // the height last written
    let lastAppliedAt = -Infinity;
    let frame: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    // Waits for the rate cap first (a timer), then for a frame: a write always happens inside a frame.
    const schedule = () => {
        if (stopped || frame !== null || timer !== null) return;
        const wait = lastAppliedAt + AUTO_RESIZE_MIN_INTERVAL_MS - scheduler.now();
        if (wait > 0) {
            timer = scheduler.setTimer(() => {
                timer = null;
                schedule();
            }, wait);
            return;
        }
        frame = scheduler.requestFrame(onFrame);
    };

    const onFrame = () => {
        frame = null;
        if (stopped || pending === null) return;
        const height = pending;
        pending = null;
        if (height === lastApplied) return;
        lastApplied = height;
        lastAppliedAt = scheduler.now();
        apply(height);
    };

    const report = (data: unknown) => {
        if (stopped) return;
        const height = toResizeHeight(data);
        if (height === null) return;
        pending = height;
        schedule();
    };

    const stop = () => {
        stopped = true;
        pending = null;
        if (frame !== null) scheduler.cancelFrame(frame);
        if (timer !== null) scheduler.clearTimer(timer);
        frame = null;
        timer = null;
    };

    return { report, stop };
}
