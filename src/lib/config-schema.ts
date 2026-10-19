/**
 * The config schema (class C, docs/research/18_finding_classes/README.md, design 4; review round 5, L-2 = N-5): where a
 * field's validity is decided together with the fields it depends on, once, before anything is stored or built. Its
 * first part is `callLimits`; the rest of the configuration moves here later (backlog S67).
 *
 * Why. A field checked on its own can hold a value every other check accepts and the configuration as a whole cannot
 * use. Round 4 (C-6) refused a `callLimits` budget below 1, which admitted no call and answered every one BUSY forever;
 * round 5 found the same symptom one step up: a byte budget smaller than one call (the smallest call frame measures about
 * 136 bytes) was accepted, and every guest call, sandboxFetch() and guest writes included, was answered BUSY forever,
 * a code that says "retry". The invariant that was violated is about two values at once, the budget and the weight of a
 * call, so it is declared here as one (CALL_INVARIANTS) with the repair the owner chose: a call heavier than the
 * byte budget can never fit an empty window, so it is refused with ARGS_NOT_TRANSFERABLE, which is not retryable, at both
 * ends (admitGuestCall here for the element; the bootstrap's broker applies the same rule to the same literal), and a
 * byte budget below the largest call (RPC_MAX_BYTES) says once which calls it refuses.
 *
 * test/unit/config-schema.test.ts checks every invariant over a seeded random set of `callLimits` values and the edges
 * between them, that normalising is idempotent and its warnings deterministic.
 *
 * Host-side only, never stringified into the guest, so it may use module scope freely.
 */
import type { CallLimits } from '../host';
import { shown } from './csp/origins';
import { RPC_MAX_BYTES, type BudgetRefusal } from './rpc';

/** The per-second budget of the calls the guest makes, per environment: what both ends count. */
export interface CallBudget {
    calls: number;
    bytes: number;
}

// The defaults of `callLimits` (review round 3, M-2).
// 1000 calls (review round 4, M-6, the owner's decision): the reviewers measured Firefox's host page 32–37% busy at 4900
// calls per second, with gaps of 1.8 s in bursts. At 1000, a strict guest calling paced at the budget and one sending
// a second's worth at once each second left Firefox's host page its idle ticks, longest gap 15–27 ms
// (test/e2e/review-round-4.spec.ts, "M-6").
const GUEST_CALLS_PER_SECOND = 1000;
const GUEST_CALL_BYTES_PER_SECOND = 67108864;

export const DEFAULT_CALL_BUDGET: Readonly<CallBudget> = Object.freeze({ calls: GUEST_CALLS_PER_SECOND, bytes: GUEST_CALL_BYTES_PER_SECOND });

/**
 * The heaviest call a budget carries: what a call may weigh (its whole frame, measured as RPC_MAX_BYTES is) to fit an
 * empty window. A heavier one is refused ARGS_NOT_TRANSFERABLE, never BUSY: no wait would ever let it through.
 */
export function heaviestCall(budget: Readonly<CallBudget>): number {
    return Math.min(RPC_MAX_BYTES, budget.bytes);
}

/**
 * The cross-field invariants of `callLimits`, each stated once, over the normalised budget. The schema's test checks
 * every one of them over random and edge configurations.
 */
export const CALL_INVARIANTS: readonly { name: string; holds: (budget: Readonly<CallBudget>) => boolean }[] = [
    { name: 'each field is a finite number of at least 1', holds: (budget) => Number.isFinite(budget.calls) && budget.calls >= 1 && Number.isFinite(budget.bytes) && budget.bytes >= 1 },
    // "every call that can be carried fits an empty window": a call no heavier than the heaviest call is one call and
    // that many bytes, both within the window
    { name: 'every call that can be carried fits an empty window', holds: (budget) => budget.calls >= 1 && heaviestCall(budget) <= budget.bytes },
    { name: 'a call is carried up to RPC_MAX_BYTES or the byte budget, whichever is smaller', holds: (budget) => heaviestCall(budget) === Math.min(RPC_MAX_BYTES, budget.bytes) },
];

/**
 * The call budget `callLimits` asks for (from the copy setConfig() took). Each field is a finite number >= 1, else its
 * default: left out, silently; anything else (Infinity, a number below 1, NaN, a string), with a warning. There is no
 * "off": a budget that can be lifted is one a config typo lifts. Nor a budget that admits nothing (review round 4, C-6):
 * below 1, every call was BUSY forever, without a word, since no call weighs less than 1. A byte budget below
 * RPC_MAX_BYTES is kept, with one warning: calls heavier than it are refused ARGS_NOT_TRANSFERABLE (heaviestCall). Never
 * throws: a callLimits that is not an object is warned about and gives the defaults.
 */
export function callBudgetOf(callLimits: unknown, warn: (message: string) => void): Readonly<CallBudget> {
    if (callLimits === undefined) return DEFAULT_CALL_BUDGET;
    if (!callLimits || typeof callLimits !== 'object' || Array.isArray(callLimits)) {
        warn(`[Sandbox] callLimits must be an object; ${shown(callLimits)} was ignored: the defaults apply (${DEFAULT_CALL_BUDGET.calls} calls and ${DEFAULT_CALL_BUDGET.bytes} bytes per second).`);
        return DEFAULT_CALL_BUDGET;
    }
    const limits = callLimits as Record<string, unknown>;
    const field = (name: keyof CallLimits, fallback: number): number => {
        const value = limits[name];
        if (value === undefined) return fallback;
        if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return value;
        warn(`[Sandbox] callLimits.${name} must be a finite number >= 1; ${typeof value === 'number' ? String(value) : shown(value)} was ignored: the default ${fallback} applies.`);
        return fallback;
    };
    const budget = Object.freeze({ calls: field('maxPerSecond', DEFAULT_CALL_BUDGET.calls), bytes: field('maxBytesPerSecond', DEFAULT_CALL_BUDGET.bytes) });
    if (budget.bytes < RPC_MAX_BYTES) warn(`[Sandbox] callLimits.maxBytesPerSecond is ${budget.bytes}, below the largest call (${RPC_MAX_BYTES} bytes): a call heavier than ${budget.bytes} bytes is refused with ARGS_NOT_TRANSFERABLE.`);
    return budget;
}

/** Why a guest call past the budget is refused (BUSY): the same words in the guest's broker (in-sandbox-script.ts). */
export const callBudgetText = (budget: Readonly<CallBudget>) => `more than ${budget.calls} calls or ${budget.bytes} bytes of calls in one second`;

/** Why a guest call heavier than the byte budget is refused (ARGS_NOT_TRANSFERABLE): the same words in the guest's broker. */
export const heavyCallText = (budget: Readonly<CallBudget>) => `the call is heavier than callLimits.maxBytesPerSecond (${budget.bytes} bytes), so it can never be carried`;

/** The windows one environment counts guest calls in (rate-limit.ts): calls, and bytes of them. */
export interface CallWindows {
    fits(time: number, weight?: number): boolean;
    admit(time: number, weight?: number): boolean;
}

/**
 * One guest call of `bytes` against the budget, at `time` (the element's end; the bootstrap's broker applies the same rule
 * before sending): null when it is admitted, and then counted against both windows; else the refusal, and nothing is
 * counted. A call heavier than the heaviest call is refused for good before the windows are asked.
 */
export function admitGuestCall(budget: Readonly<CallBudget>, calls: CallWindows, bytesWindow: CallWindows, bytes: number, time: number): BudgetRefusal | null {
    if (bytes > heaviestCall(budget)) return { code: 'ARGS_NOT_TRANSFERABLE', reason: heavyCallText(budget) };
    if (!calls.fits(time) || !bytesWindow.fits(time, bytes)) return { code: 'BUSY', reason: callBudgetText(budget) };
    calls.admit(time);
    bytesWindow.admit(time, bytes);
    return null;
}
