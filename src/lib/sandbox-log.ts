/**
 * The detail of the element's 'sandbox-log' event (backlog B3; adversarial review 2026-10, B3).
 *
 * Guest log lines arrive on the port as LOG frames whose every field the guest chose: the bootstrap relays
 * console.log/warn/error, and guest code decides what it logs. The host also logs a few lines of its own
 * (an execution timeout, an entry that failed to start). Before the review both were dispatched as they came,
 * so a listener could not tell them apart, a level of 1 or args that were not an array broke
 * SandboxDevTools, and a guest could make the host run embedder listeners as often as it could post.
 *
 * Now every line is normalised here before it is dispatched: a level from a closed set, args an array of at
 * most LOG_MAX_ARGS with every string clamped to LOG_MAX_STRING, and a `source` the host sets from where the
 * line came from, never read from the frame. Guest lines are rate-limited per environment (LOG_EVENTS_PER_SECOND,
 * enforced in host.ts); host lines never are.
 *
 * Host-side only, never stringified into the guest, so it may use module scope freely.
 */

import { createRateLimiter } from './rate-limit';
import { createSizeOf } from './structured-size';

export type SandboxLogLevel = 'log' | 'info' | 'warn' | 'error';

/** The detail of a 'sandbox-log' event. Frozen. */
export interface SandboxLog {
    type: 'LOG';
    level: SandboxLogLevel;
    /** What was logged, structured-cloned: guest data when source is 'guest'. At most LOG_MAX_ARGS. */
    args: readonly unknown[];
    /** 'host': a line the element wrote itself. 'guest': a line from the guest's port, whatever it claims. */
    source: 'guest' | 'host';
}

/**
 * The byte budget of one line, all its arguments together, measured with structured-size.ts (review round 1, R3-3):
 * LOG_MAX_ARGS and LOG_MAX_STRING bound the strings, this bounds the rest (a typed array, an object of 100 000 keys).
 * The guest's console relay applies it before a line is posted (an argument past it crosses as a string saying so),
 * and the host again on receipt. Mirrored in in-sandbox-script.ts (a test keeps them equal).
 */
export const LOG_MAX_BYTES = 1048576;

/**
 * The guest's console relay sends at most this many bytes of lines per second, and at most LOG_EVENTS_PER_SECOND lines
 * (review round 1, R3-3): a line dropped in the guest is never cloned onto the host's thread. Mirrored in
 * in-sandbox-script.ts (a test keeps them equal).
 */
export const LOG_BYTES_PER_SECOND = 4194304;

/** What an argument past LOG_MAX_BYTES becomes on receipt. */
export const LOG_DROPPED_ARGUMENT = "[Sandbox] dropped: past the log line's byte budget";

/** Most arguments one line keeps; later ones are dropped. */
export const LOG_MAX_ARGS = 64;

/** Longest string argument, in UTF-16 code units; longer ones are cut. */
export const LOG_MAX_STRING = 65536;

/**
 * Most guest lines dispatched per environment in any one-second window; later lines in that window are dropped,
 * with one warning per environment. Host lines are not counted.
 */
export const LOG_EVENTS_PER_SECOND = 1000;

const LEVELS: readonly SandboxLogLevel[] = ['log', 'info', 'warn', 'error'];

const clampArgument = (value: unknown): unknown => (typeof value === 'string' && value.length > LOG_MAX_STRING ? value.slice(0, LOG_MAX_STRING) : value);

const sizeOf = createSizeOf();

/**
 * Normalises one LOG frame (or a line of the host's own) into the event detail. Never throws. An argument past what is
 * left of LOG_MAX_BYTES becomes LOG_DROPPED_ARGUMENT, and `onDropped` is called once for the line.
 */
export function toLogDetail(frame: unknown, source: 'guest' | 'host', onDropped?: () => void): SandboxLog {
    const data = frame && typeof frame === 'object' ? frame as Record<string, unknown> : {};
    const level = LEVELS.find(candidate => candidate === data.level) ?? 'log';
    const args: unknown[] = [];
    let dropped = false;
    if (Array.isArray(data.args)) {
        const count = Math.min(data.args.length, LOG_MAX_ARGS);
        let left = LOG_MAX_BYTES;
        for (let i = 0; i < count; i++) {
            const value = clampArgument(data.args[i]);
            const bytes = sizeOf(value, left);
            if (bytes > left) {
                dropped = true;
                args.push(LOG_DROPPED_ARGUMENT);
                continue;
            }
            left -= bytes;
            args.push(value);
        }
    }
    if (dropped) onDropped?.();
    return Object.freeze({ type: 'LOG', level, args: Object.freeze(args), source });
}

/**
 * `admit()` says whether one more guest line may be dispatched now: at most LOG_EVENTS_PER_SECOND in any one-second
 * window, a sliding window (rate-limit.ts; focused review 2026-10-14, W2: the fixed window this replaced let twice
 * the limit through around its boundary). One per environment (host.ts creates a fresh one on every teardown).
 */
export function createLogLimiter(now: () => number = () => performance.now()) {
    const limiter = createRateLimiter(LOG_EVENTS_PER_SECOND);
    return {
        admit: (): boolean => limiter.admit(now()),
    };
}
