/**
 * The detail of the element's 'sandbox-log' event.
 * Backlog item BL:B3, finding AR:B3.
 *
 * Guest log lines arrive on the port as LOG frames whose every field the guest chose: the bootstrap relays
 * console.log/warn/error, and guest code decides what it logs. The host also logs a few lines of its own
 * (an execution timeout, an entry that failed to start). A line dispatched as it came would not tell a listener
 * which it was, a level of 1 or args that are not an array would break SandboxDevTools, and a guest could make the host
 * run embedder listeners as often as it could post.
 *
 * So every line is normalised here before it is dispatched: a level from a closed set, args an array of at
 * most LOG_MAX_ARGS with every string clamped to LOG_MAX_STRING, and a `source` the host sets from where the
 * line came from, never read from the frame. Guest lines are rate-limited per environment (LOG_EVENTS_PER_SECOND,
 * enforced in host.ts); host lines never are.
 *
 * Host-side only, never stringified into the guest, so it may use module scope freely.
 */

import { createRateLimiter } from './rate-limit';
import { createSizeOf } from './structured-size';

/** The level of a {@link SandboxLog} line. Anything the guest sends that is not one of these reads as `'log'`. */
export type SandboxLogLevel = 'log' | 'info' | 'warn' | 'error';

/**
 * The `detail` of a `sandbox-log` event: one log line, frozen.
 *
 * @remarks
 * Every field of a guest's line is normalised before it is dispatched, so a listener never sees a malformed one. Guest
 * code decides what it logs, so `args` is guest data when `source` is `'guest'`: read it, do not merge it into your
 * objects. The guest's console relay (`log`, `info`, `warn`, `error`, and the other `console` methods as `log` or
 * `error`), its uncaught errors and unhandled rejections, a throw from `execute()` and one `<mode> Ready` line per
 * environment arrive here, and so do the element's own lines (`source: 'host'`, never rate-limited). The `<mode> Ready`
 * line is posted by the guest's bootstrap, so its `source` is `'guest'` though the text is the library's. Reference with
 * the host's lines: docs/API.md#sandbox-log--sandboxlog.
 */
export interface SandboxLog {
    /** Always `'LOG'`. */
    type: 'LOG';
    /** How serious the line is. A level the guest sends that is not one of {@link SandboxLogLevel} reads as `'log'`. */
    level: SandboxLogLevel;
    /**
     * What was logged, structured-cloned: at most {@link LOG_MAX_ARGS} values, strings cut at {@link LOG_MAX_STRING}
     * characters, all of them together at most `LOG_MAX_BYTES` (1 MiB). An argument past what is left of that is replaced
     * by a string that says so. Guest-controlled text when `source` is `'guest'`: show it with `textContent`, never in an
     * HTML, URL (such as a link `href`), `eval`, template or `console` format-string sink.
     */
    args: readonly unknown[];
    /**
     * `'host'` for a line the element wrote itself, `'guest'` for a line that came from the guest's port, whatever it
     * claims. Set by the element, never read from the line.
     */
    source: 'guest' | 'host';
}

/**
 * The byte budget of one line, all its arguments together, measured with structured-size.ts (R1:R3-3):
 * LOG_MAX_ARGS and LOG_MAX_STRING bound the strings, this bounds the rest (a typed array, an object of 100 000 keys).
 * The guest's console relay applies it before a line is posted (an argument past it crosses as a string saying so),
 * and the host again on receipt. Mirrored in in-sandbox-script.ts (a test keeps them equal).
 */
export const LOG_MAX_BYTES = 1048576;

/**
 * The guest's console relay sends at most this many bytes of lines per second, and at most LOG_EVENTS_PER_SECOND lines
 * (R1:R3-3): a line dropped in the guest is never cloned onto the host's thread. Mirrored in
 * in-sandbox-script.ts (a test keeps them equal).
 */
export const LOG_BYTES_PER_SECOND = 4194304;

/**
 * What an argument past LOG_MAX_BYTES becomes on receipt. An argument holding a kind the measure does not know (an Error,
 * an ImageData) says that instead, `[Sandbox] dropped: unsupported value: <kind>` (R3:C-3).
 */
export const LOG_DROPPED_ARGUMENT = "[Sandbox] dropped: past the log line's byte budget";

/** Most arguments one {@link SandboxLog} line keeps; later ones are dropped. */
export const LOG_MAX_ARGS = 64;

/** Longest string argument of a {@link SandboxLog} line, in UTF-16 code units; a longer one is cut. */
export const LOG_MAX_STRING = 65536;

/**
 * Most guest lines dispatched as `sandbox-log` per environment in any one-second window (a sliding window). Later lines in
 * that window are dropped, with one warning per environment. The element's own lines are not counted.
 */
export const LOG_EVENTS_PER_SECOND = 1000;

/**
 * The guest relay's own lines the host dispatches per environment besides the guest's lines, outside their window
 * (R2:M-1, R2:M-2): '<mode> Ready' and the relay's warnings (lines dropped past the per-second budgets, lines
 * dropped before the guest was connected, queued frames that could not be posted), each sent at most once per
 * environment and marked `own` by the bootstrap. The guest relay counts its lines in a window of LOG_EVENTS_PER_SECOND,
 * the host's own (in-sandbox-script.ts), so those warnings would arrive just past a full window and be dropped:
 * the one line that says lines are missing must not go missing. Only the bootstrap posts on the port, so a guest cannot mark a
 * line; past this many marked lines in one environment, a marked line counts as the guest's like any other.
 */
export const LOG_OWN_LINES = 4;

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
            const unsupported = { kind: '' };
            const bytes = sizeOf(value, left, undefined, unsupported);
            if (bytes > left) {
                dropped = true;
                args.push(unsupported.kind ? `[Sandbox] dropped: unsupported value: ${unsupported.kind}` : LOG_DROPPED_ARGUMENT);
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
 * window, a sliding window (rate-limit.ts; FR:W2: a fixed window lets twice
 * the limit through around its boundary). One per environment (host.ts creates a fresh one on every teardown).
 */
export function createLogLimiter(now: () => number = () => performance.now()) {
    const limiter = createRateLimiter(LOG_EVENTS_PER_SECOND);
    return {
        admit: (): boolean => limiter.admit(now()),
    };
}
