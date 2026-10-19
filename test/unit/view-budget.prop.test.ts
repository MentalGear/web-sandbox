import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { VIEW_APPLY_MS_PER_SECOND, VIEW_MAX_OPERATION_MS, VIEW_MAX_URLS, VIEW_OPTIONS, VIEW_URLS_PER_SECOND, viewBudget, type ViewVerdict } from '@src/lib/in-sandbox-view';

/**
 * docs/API.md, "The view's cost to the host page", (a) the long-run bound, as a fast-check property of the real budget
 * arithmetic (viewBudget; backlog S61.1, research 17's view-budget simulation made a test). test/unit/view-round-5.test.ts
 * and test/unit/view-css-loads.test.ts check each piece of it on fixed and seeded cases (the full charge, the refill, the
 * repeated-overrun rule, the load credit); this states the bound itself over any sequence the view can be given, and is
 * the arithmetic (a) rests on. What the meter measures, and what the browser does on top of it, are the e2e suite's
 * (test/e2e/view-bound.spec.ts).
 *
 * The view's loop, as arithmetic: an operation is applied once the budget owes nothing (time and loads), its URL
 * attributes are charged and its CSS's loads prepaid as it is applied, the time it took is measured and charged in full
 * (`measured`), and the second overrun within the window ends the view; between operations the platform reports loads
 * (`observed`), which take the credit first. Operations cost anything from 1 ms to 20 s: (a) holds "whatever each
 * costs", overruns included.
 */

const RATE = VIEW_APPLY_MS_PER_SECOND;
const R = VIEW_URLS_PER_SECOND;

interface Op { gap: number; cost: number; attrs: number; css: number; reported: number }
interface Applied { start: number; cost: number; loads: number; verdict: ViewVerdict }

const op = fc.record({
    gap: fc.integer({ min: 0, max: 3000 }), // the guest's pause before it asks for the next operation
    cost: fc.oneof(fc.integer({ min: 1, max: 250 }), fc.integer({ min: 1, max: VIEW_MAX_OPERATION_MS }), fc.integer({ min: 1, max: 20000 })),
    attrs: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: VIEW_MAX_URLS })),
    css: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 3 * R })),
    reported: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 2 * R })), // loads the platform reports after it
});

function run(ops: Op[]) {
    const budget = viewBudget(VIEW_OPTIONS.rates, 0, VIEW_OPTIONS);
    let now = 0;
    const applied: Applied[] = [];
    let reportedLoads = 0;
    let charged = 0; // what the operations and the reports took from the load budget, refill aside
    for (const { gap, cost, attrs, css, reported } of ops) {
        now += gap;
        while (budget.owes(now)) now += Math.max(1, budget.wait(0, now));
        const start = now;
        let before = budget.held('urls', start);
        budget.charge('urls', attrs, start);
        budget.prepay(css, start);
        charged += before - budget.held('urls', start);
        now += cost;
        const verdict = budget.measured(cost, cost, now, true);
        applied.push({ start, cost, loads: attrs + css, verdict });
        if (verdict === 'second-overrun') break; // the view applies nothing more
        expect(budget.credit()).toBeLessThanOrEqual(R);
        before = budget.held('urls', now);
        budget.observed(reported, now);
        charged += before - budget.held('urls', now);
        reportedLoads += reported;
        expect(budget.credit()).toBeLessThanOrEqual(R);
    }
    // the run ends when the last operation's debt is repaid: its time is the run's too
    const end = now + budget.wait(0, now);
    return { applied, end, reportedLoads, charged, prepaid: applied.reduce((sum, entry) => sum + entry.loads, 0) };
}

describe("the view's long-run bound, (a), over any sequence of operations", () => {
    it("time: the view's own time over a run is at most VIEW_APPLY_MS_PER_SECOND per second of it, plus the second's worth the budget holds", () => {
        fc.assert(fc.property(fc.array(op, { minLength: 1, maxLength: 30 }), (ops) => {
            const { applied, end } = run(ops);
            const busy = applied.reduce((sum, entry) => sum + entry.cost, 0);
            return busy <= RATE + (end * RATE) / 1000 + 1e-6;
        }), { numRuns: 300 });
    });

    it('time, over any stretch: the operations started in it took at most the rate times its length, the second held, and the last one', () => {
        fc.assert(fc.property(fc.array(op, { minLength: 2, maxLength: 30 }), (ops) => {
            const { applied } = run(ops);
            for (let j = 0; j < applied.length; j++) {
                let busy = 0;
                for (let k = j; k < applied.length; k++) {
                    busy += applied[k]!.cost;
                    const span = applied[k]!.start - applied[j]!.start;
                    if (busy - applied[k]!.cost > RATE + (span * RATE) / 1000 + 1e-6) return false;
                }
            }
            return true;
        }), { numRuns: 300 });
    });

    it('loads, over any stretch: what the operations started in it charged is at most R per second of it, R held, and the last one\'s own charge', () => {
        fc.assert(fc.property(fc.array(op, { minLength: 2, maxLength: 30 }), (ops) => {
            const { applied } = run(ops);
            for (let j = 0; j < applied.length; j++) {
                let loads = 0;
                for (let k = j; k < applied.length; k++) {
                    loads += applied[k]!.loads;
                    const span = applied[k]!.start - applied[j]!.start;
                    if (loads - applied[k]!.loads > R + (span * R) / 1000 + 1e-6) return false;
                }
            }
            return true;
        }), { numRuns: 300 });
    });

    it('loads: every load is charged at least once, applied or reported, and the credit never holds more than R', () => {
        fc.assert(fc.property(fc.array(op, { minLength: 1, maxLength: 30 }), (ops) => {
            const { charged, reportedLoads, prepaid } = run(ops); // run() checks the credit after every step
            return charged >= Math.max(prepaid, reportedLoads) - 1e-6;
        }), { numRuns: 300 });
    });

    it('the long-run share is the rate: back-to-back operations of any one cost, overruns included, come to at most 20% of a long run', () => {
        fc.assert(fc.property(fc.integer({ min: 1, max: 20000 }), (cost) => {
            const { applied, end } = run(Array.from({ length: 40 }, () => ({ gap: 0, cost, attrs: 0, css: 0, reported: 0 })));
            const busy = applied.reduce((sum, entry) => sum + entry.cost, 0);
            // a run long against a second: the second's worth the budget held at the start is a vanishing part of it
            return end < 20000 || (busy - RATE) / end <= RATE / 1000 + 1e-9;
        }), { numRuns: 200, examples: [[199], [1500], [VIEW_MAX_OPERATION_MS], [VIEW_MAX_OPERATION_MS + 1], [7500]] });
    });
});
