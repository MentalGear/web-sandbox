// @vitest-environment node
import '@src/network'; // the reducer runner reads strict apps, which the network build takes (ADR-009)
import { describe, expect, it } from 'vitest';
import { INITIAL_LIFECYCLE, reduce, type BuildContext, type LcState } from '../../src/lib/lifecycle';
import { reasonText } from '../../src/lib/reasons';
import { generate } from '../model/generator';
import { DOCUMENT_SILENT_REASON } from '../model/lifecycle-model';
import { FILE_FINDING, forTheReducer, runReducerSequence, type ServedFileAnswer } from '../model/reducer-runner';

/**
 * The check of sealed mode's served file in the lifecycle (design 03, "The check of the file", and the start-up order,
 * step 1; src/lib/lifecycle.ts, `fileChecked`): a build that waits for it prepares and frames nothing until it answers;
 * its deadline is armed once, at its start; a finding ends it; a stale answer does nothing. And against the lifecycle
 * model, on generated sequences whose strict view is the served file (test/model/reducer-runner.ts, `servedFile`), for
 * each way the fake server answers: terminate(), reset() and removal during the wait, the answer kept for the
 * registration, and the refusal of every later build by a kept finding.
 */

const RUNS = Number(process.env.WEB_SANDBOX_REDUCER_RUNS ?? 5000) / 5;
const CHECKED: BuildContext = { buildsHere: true, blocked: null, strict: true, served: true, checksFile: true, announces: false };
const BOUND: LcState = reduce(INITIAL_LIFECYCLE, { t: 'start' }).state;
const kinds = (state: LcState, input: Parameters<typeof reduce>[1]) => reduce(state, input).effects.map(effect => effect.k);

describe('the reducer: a build that waits for the check of its file', () => {
    const waiting = reduce(BOUND, { t: 'build', ctx: CHECKED }).state;

    it('starts loading, arms its deadline and asks; nothing is prepared or framed', () => {
        expect(kinds(BOUND, { t: 'build', ctx: CHECKED })).toEqual(['teardown', 'discardWrites', 'startLoadDeadline', 'checkFile']);
        expect(waiting.state).toBe('loading');
        expect(waiting.build?.fileCheck).toBe('pending');
        // without the check (a kept pass, or no request possible), the build is prepared at once
        expect(kinds(BOUND, { t: 'build', ctx: { ...CHECKED, checksFile: false } })).toEqual(['teardown', 'discardWrites', 'build']);
    });

    it('no finding: the build is prepared, and attached with no second deadline', () => {
        const answered = reduce(waiting, { t: 'fileChecked', gen: waiting.gen, finding: null });
        expect(answered.effects.map(effect => effect.k)).toEqual(['build']);
        expect(answered.state.build?.fileCheck).toBe('answered');
        expect(kinds(answered.state, { t: 'built', gen: waiting.gen, prepared: {} })).toEqual(['attach']);
    });

    it('a finding ends the build with it; a stale answer, and an answer to a build that does not wait, do nothing', () => {
        const ended = reduce(waiting, { t: 'fileChecked', gen: waiting.gen, finding: FILE_FINDING });
        expect(ended.state.state).toBe('terminated');
        expect(ended.effects).toContainEqual({ k: 'dispatch', event: 'terminated', reason: FILE_FINDING });
        expect(ended.effects).toContainEqual({ k: 'teardown' });
        const stale = reduce(waiting, { t: 'fileChecked', gen: (waiting.gen + 1) as never, finding: FILE_FINDING });
        expect(stale.effects).toEqual([]);
        expect(stale.state).toBe(waiting);
        const answered = reduce(waiting, { t: 'fileChecked', gen: waiting.gen, finding: null }).state;
        expect(reduce(answered, { t: 'fileChecked', gen: answered.gen, finding: FILE_FINDING }).effects).toEqual([]);
    });

    it('the deadline during the wait: "the document did not answer"', () => {
        const ended = reduce(waiting, { t: 'loadDeadline', gen: waiting.gen });
        expect(ended.state.state).toBe('terminated');
        expect(ended.effects).toContainEqual({ k: 'dispatch', event: 'terminated', reason: reasonText('documentSilent') });
        expect(reasonText('documentSilent')).toBe(DOCUMENT_SILENT_REASON);
    });

    it('terminate(), reset() and removal during the wait end it as any loading build; the answer that comes after is stale', () => {
        for (const input of [{ t: 'terminate', reason: 'bye' }, { t: 'build', ctx: CHECKED }, { t: 'disconnect' }] as const) {
            const after = reduce(waiting, input).state;
            expect(after.gen, input.t).not.toBe(waiting.gen);
            expect(reduce(after, { t: 'fileChecked', gen: waiting.gen, finding: FILE_FINDING }).effects, input.t).toEqual([]);
        }
    });
});

describe('the reducer against the lifecycle model, the strict view being the served file', () => {
    const answers: readonly ServedFileAnswer[] = ['library', 'finding', 'unanswered'];
    for (const answer of answers) {
        it(`${RUNS} generated strict sequences, the check answering "${answer}", agree with the model`, () => {
            const totals: Record<string, number> = {};
            const coverage = new Set<string>();
            let runs = 0;
            for (let seed = 1; runs < RUNS; seed++) {
                const sequence = forTheReducer(generate(seed));
                if (sequence.mode !== 'strict') continue;
                runs++;
                const result = runReducerSequence(sequence, { servedFile: answer });
                for (const [key, value] of Object.entries(result.stats)) totals[key] = (totals[key] ?? 0) + value;
                for (const key of result.coverage) coverage.add(key);
                if (!result.ok) expect.fail(`seed ${seed}: ${result.divergence}\n${result.trace.join('\n')}`);
            }
            console.log(`MEASURED served-file check (${answer}): ${runs} sequences; ${JSON.stringify(totals)}`);
            // what the runs must have reached for the agreement to mean something
            expect(totals['input:fileChecked'] ?? 0).toBeGreaterThan(0);
            expect(totals['stale:fileChecked'] ?? 0, 'an answer that reached a build torn down meanwhile').toBeGreaterThan(0);
            expect(totals['file:hung'] ?? 0, 'a check that did not answer by the deadline').toBeGreaterThan(0);
            if (answer === 'unanswered') {
                expect(coverage.has('file-answered|unanswered')).toBe(true);
                expect(coverage.has('event:ready|strict')).toBe(true);
                return;
            }
            expect(coverage.has('file-answered|kept')).toBe(true);
            if (answer === 'finding') {
                expect(coverage.has('event:terminated-finding'), 'a finding that ended the build that waited').toBe(true);
                expect(coverage.has('event:terminated-refusal|strict'), 'a later build refused by the kept finding').toBe(true);
                expect(coverage.has('event:ready|strict')).toBe(false);
                return;
            }
            expect(coverage.has('event:ready|strict')).toBe(true);
        }, 120_000);
    }
});
