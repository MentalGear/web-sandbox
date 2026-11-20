// @vitest-environment node
import '@src/network'; // the network build: this file tests modes and options the default build does not have (ADR-009)
import { describe, expect, it } from 'vitest';
import { admits, INITIAL_LIFECYCLE, isStale, LC_EFFECTS, LC_INPUTS, LC_STATES, reduce, type Effect, type Generation, type LcInput, type LcInputKind, type LcOutput, type LcState } from '../../src/lib/lifecycle';
import { exploreLifecycle, lifecycleTransitions, transitionKey, type Transition } from '../../src/lib/lifecycle-transitions';
import { generate } from '../model/generator';
import { forTheReducer, runReducerSequence } from '../model/reducer-runner';

/**
 * The reducer's declaration (src/lib/lifecycle.ts: LC_INPUTS, LC_EFFECTS) and the transitions listed from it
 * (src/lib/lifecycle-transitions.ts), against `reduce` itself: every listed transition is one `reduce` makes, and the
 * generated model runs, through the real executor and a fake element, make no other.
 */

const RUNS = Number(process.env.WEB_SANDBOX_TRANSITION_RUNS ?? 1000);

/** What LcState's union says by its type, checked on the values: null where the shape is right, else what is wrong. */
function wrongShape(value: LcState): string | null {
    const state: { state: string; build: unknown; pending: unknown } = value; // as data: the type already says it
    const standing = state.state === 'loading' || state.state === 'ready';
    if (standing !== (state.build !== null)) return `${state.state} with build ${JSON.stringify(state.build)}`;
    if (state.pending !== null && state.state !== 'terminated') return `${state.state} with a pending termination`;
    return null;
}
const exploration = exploreLifecycle();

// The reasons several never-made transitions share.
const DISPATCH_STARTS_TERMINATED = "unreachable by the executor: dispatchStarted is stepped only before a 'terminated' dispatch, by an output in `terminated` (terminateNow, buildTerminationDue), runEffects runs no effect of an output once its environment was torn down, and nothing leaves `terminated` without a teardown";
const STANDING_IS_CONNECTED = "unreachable by the element: a standing build is connected, connectedCallback runs only for an element that is not, and leaving the document or being adopted stepped `disconnect`, into `idle`, first";
const BUILD_WHERE_IT_BUILDS = "unreachable by the element: a standing build is connected in the element's own document, and leaving it steps `disconnect`, into `idle`, before any embedder code can call reset()";
const TERMINATION_WITH_NOTICES = 'not reached by the model: a termination with notices (a host-page refusal, an entry that failed) keeps the state until its nested step; the fake guest causes none, and the e2e model runs reach the entry failure';
const VERDICTS_AFTER_CHECK_IN = "not reached by the model: the view hands on its worker's verdicts on its port after its check-in, so the check-in comes first; lifecycle-reducer.test.ts makes the other order by hand (\"the worker's verdicts: …\")";
const NOT_THE_MODELS_GUEST = "not reached by the model: its guests announce once, from their bootstrap, and never navigate the wrapper; lifecycle-reducer.test.ts makes it by hand (\"the wrapper's load: …\", \"a guest that checked in: …\")";

/**
 * The listed transitions the model runs never make, each with why. Compared exactly with what the runs leave unmade, so
 * a transition the runs stop making, or start making, changes this list and its reason, and no bound absorbs it.
 */
const NEVER_MADE: Readonly<Record<string, string>> = {
    'idle -dispatchStarted-> idle': DISPATCH_STARTS_TERMINATED,
    'loading -dispatchStarted-> loading': DISPATCH_STARTS_TERMINATED,
    'ready -dispatchStarted-> ready': DISPATCH_STARTS_TERMINATED,
    'ready -dispatchEnded-> ready': "unreachable by the element: a 'terminated' dispatch starts in `terminated`, and a build a listener starts completes only after the listeners returned (the wrapper's load in a microtask, the announcement and the view's check-in in a task)",
    'loading -connect-> idle': STANDING_IS_CONNECTED,
    'loading -connect-> loading': STANDING_IS_CONNECTED,
    'loading -connect-> terminated': STANDING_IS_CONNECTED,
    'ready -connect-> idle': STANDING_IS_CONNECTED,
    'ready -connect-> loading': STANDING_IS_CONNECTED,
    'ready -connect-> terminated': STANDING_IS_CONNECTED,
    'loading -build-> idle': BUILD_WHERE_IT_BUILDS,
    'ready -build-> idle': BUILD_WHERE_IT_BUILDS,
    'ready -viewReady-> ready': "unreachable by the element: the view checks in once, at the INIT_VIEW the element sends at its one announcement (a second announcement ends the build); lifecycle-reducer.test.ts makes it by hand (\"the view's check-in counts only while loading\")",
    'ready -loadDeadline-> ready': "unreachable by the element: enterReady stops the load deadline (stopLoadDeadline), and the fake element's too; lifecycle-reducer.test.ts makes it by hand (\"the load deadline: …\"), the reducer's own bound were a stop missed",
    'loading -build-> terminated': "not reached by the model: a rebuild of a bound app is refused only for what a commit changed in the files, and a loading build's overlay is new and empty; the model's guests write only when called, a call made while loading waits for `ready`, and the strict view starts the worker that runs the entry only after its check-in",
    'loading -buildFailed-> terminated': "not reached by the model: the build or attach effect throwing (a host page's Trusted Types default policy that throws); its host pages have none, and the fake element's build does not throw; policy-guarantees.test.ts and lifecycle-edge-cases.test.ts make it",
    'loading -terminate-> loading': TERMINATION_WITH_NOTICES,
    'ready -terminate-> ready': TERMINATION_WITH_NOTICES,
    'loading -announced-> loading': "not reached by the model: worker mode's refusal (R2:C-5), a worker the host page's policy refused, keeps `loading` until its termination; the model's host pages have no policy",
    'loading -announced-> terminated': NOT_THE_MODELS_GUEST,
    'ready -announced-> terminated': NOT_THE_MODELS_GUEST,
    'loading -viewReady-> ready': VERDICTS_AFTER_CHECK_IN,
    'loading -workerVerdicts-> loading': VERDICTS_AFTER_CHECK_IN,
    'ready -workerVerdicts-> ready': "unreachable by the element: the view hands on its worker's first message once, and hears none after it; lifecycle-reducer.test.ts makes a repeat by hand (\"the worker's verdicts: …\")",
    'ready -viewAnnounced-> terminated': "not reached by the model: its views announce themselves once, before their check-in; lifecycle-reducer.test.ts makes a second announcement by hand",
    'loading -frameLoad-> terminated': NOT_THE_MODELS_GUEST,
    'ready -frameLoad-> terminated': NOT_THE_MODELS_GUEST,
};

describe('the transitions listed from the declaration (lifecycleTransitions)', () => {
    it('each is what `reduce` gives for its witness, a declared pair; and the exploration is finite and small', () => {
        expect(exploration.transitions.length).toBeGreaterThan(10);
        expect(exploration.states).toBeLessThan(10_000);
        for (const transition of exploration.transitions) {
            const witness = exploration.witnesses.get(transitionKey(transition))!;
            expect(witness.state.state, transitionKey(transition)).toBe(transition.from);
            expect(witness.input.t).toBe(transition.input);
            expect(isStale(witness.state, witness.input) || !admits(witness.state, witness.input), transitionKey(transition)).toBe(false);
            const next = reduce(witness.state, witness.input).state;
            expect(next.state, transitionKey(transition)).toBe(transition.to);
            expect([wrongShape(witness.state), wrongShape(next)], transitionKey(transition)).toEqual([null, null]);
        }
        expect(lifecycleTransitions()).toEqual(exploration.transitions);
    });

    it('every declared input kind makes some transition, from the states it is declared in only', () => {
        for (const kind of Object.keys(LC_INPUTS) as LcInputKind[]) {
            const from = new Set(exploration.transitions.filter(transition => transition.input === kind).map(transition => transition.from));
            expect(from.size, kind).toBeGreaterThan(0);
            for (const state of from) expect(LC_INPUTS[kind].states as readonly string[], `${kind} from ${state}`).toContain(state);
        }
    });

    it('the shape class L asks for: `ready` only from `loading`, and only on a completion; nothing out of `idle` but a build or terminate()', () => {
        const into = (state: string) => exploration.transitions.filter(transition => transition.to === state && transition.from !== state);
        expect(new Set(into('ready').map(transition => transition.from))).toEqual(new Set(['loading']));
        // strict and sealed mode complete on the later of the view's check-in and its worker's verdicts (design 03, step 5)
        expect(new Set(into('ready').map(transition => transition.input))).toEqual(new Set(['frameLoad', 'announced', 'viewReady', 'workerVerdicts']));
        const fromIdle = exploration.transitions.filter(transition => transition.from === 'idle' && transition.to !== 'idle');
        expect(new Set(fromIdle.map(transition => transition.input))).toEqual(new Set(['connect', 'build', 'terminate']));
        // the edges step 0's exploration drew that the element never makes: none of them is declared
        expect(exploration.transitions.some(transition => transition.from === 'idle' && (transition.input === 'buildFailed' || transition.input === 'announced'))).toBe(false);
    });

    it(`the model runs (${RUNS} generated sequences, through the executor and a fake element) make only listed transitions, and arrive only in declared states`, () => {
        const listed = new Set(exploration.transitions.map(transitionKey));
        const made = new Set<string>();
        const unlisted: string[] = [];
        const onStep = (before: LcState, input: LcInput, output: LcOutput) => {
            expect(wrongShape(output.state), input.t).toBeNull();
            if (isStale(before, input)) return;
            expect(admits(before, input), `${input.t} in ${before.state}`).toBe(true);
            const key = transitionKey({ from: before.state, input: input.t, to: output.state.state });
            made.add(key);
            if (!listed.has(key)) unlisted.push(key);
        };
        for (let seed = 1; seed <= RUNS; seed++) {
            const result = runReducerSequence(forTheReducer(generate(seed)), { onStep });
            expect(result.ok, `seed ${seed}: ${result.divergence}`).toBe(true);
        }
        // and the strict view as sealed mode's served file, whose check answers each way (reducer-runner.ts, servedFile)
        for (const servedFile of ['library', 'finding', 'unanswered'] as const) {
            for (let seed = 1; seed <= RUNS / 4; seed++) {
                const sequence = forTheReducer(generate(seed));
                if (sequence.mode !== 'strict') continue;
                const result = runReducerSequence(sequence, { onStep, servedFile });
                expect(result.ok, `seed ${seed} (${servedFile}): ${result.divergence}`).toBe(true);
            }
        }
        // and every strict build's start-up giving a finding, at the view's announcement or at its worker's verdicts
        // (reducer-runner.ts, startup)
        for (const startup of ['view', 'worker'] as const) {
            for (let seed = 1; seed <= RUNS / 4; seed++) {
                const sequence = forTheReducer(generate(seed));
                if (sequence.mode !== 'strict') continue;
                const result = runReducerSequence(sequence, { onStep, startup, servedFile: seed % 2 === 0 ? 'library' : undefined });
                expect(result.ok, `seed ${seed} (startup ${startup}): ${result.divergence}`).toBe(true);
            }
        }
        expect([...new Set(unlisted)]).toEqual([]);
        // and what the list says and the runs never make is exactly NEVER_MADE, each with its reason
        const unmade = [...listed].filter(key => !made.has(key)).sort();
        expect(unmade).toEqual(Object.keys(NEVER_MADE).sort());
        // among what the runs make: a rebuild of a bound app refused for a committed change of its entry (API.md, `entry`),
        // and the insertion's refused build of an element terminate() ended while detached
        expect([made.has('ready -build-> terminated'), made.has('terminated -connect-> terminated')]).toEqual([true, true]);
    }, 120_000);

    it('every never-made transition is one the declaration lists, with a reason', () => {
        const listed = new Set(exploration.transitions.map(transitionKey));
        for (const [key, reason] of Object.entries(NEVER_MADE)) {
            expect(listed.has(key), key).toBe(true);
            expect(reason, key).toMatch(/^(unreachable by the (element|executor)|not reached by the model): /);
        }
    });
});

describe('the declaration (LC_INPUTS, LC_EFFECTS) and the types derived from it', () => {
    it('declares states and modes the reducer knows, and an effect kind for every effect `reduce` gives', () => {
        for (const [kind, declared] of Object.entries(LC_INPUTS)) {
            for (const state of declared.states) expect(LC_STATES, kind).toContain(state);
            expect(['always', 'optional', 'never'], kind).toContain(declared.stamped);
        }
        const given = new Set<string>();
        for (const { state, input } of exploration.witnesses.values()) for (const effect of reduce(state, input).effects) given.add(effect.k);
        expect([...given].filter(kind => !Object.hasOwn(LC_EFFECTS, kind))).toEqual([]);
        expect(INITIAL_LIFECYCLE.state).toBe('idle');
    });

    it('isStale drops a stamped kind of another generation, and nothing else', () => {
        for (const { state, input } of exploration.witnesses.values()) {
            const stamped = LC_INPUTS[input.t].stamped !== 'never';
            expect(isStale(state, input), input.t).toBe(false);
            if (stamped) expect(isStale(state, { ...input, gen: (state.gen + 1) as Generation } as LcInput), input.t).toBe(true);
            else expect('gen' in input, input.t).toBe(false);
        }
    });

    it('LcInput and Effect are the declared kinds with their fields: the type checker refuses anything else', () => {
        const gen = INITIAL_LIFECYCLE.gen;
        const inputs: LcInput[] = [{ t: 'terminate', reason: 'x' }, { t: 'terminate', reason: 'x', gen }, { t: 'built', gen, prepared: null }, { t: 'disconnect' }];
        // @ts-expect-error a number that is no generation: only a teardown makes one
        inputs.push({ t: 'loadDeadline', gen: 1 });
        // @ts-expect-error a stamped input without its generation (`bun run typecheck` fails if this line type-checks)
        inputs.push({ t: 'built', prepared: null });
        // @ts-expect-error an input with a generation its kind does not carry
        inputs.push({ t: 'disconnect', gen });
        // @ts-expect-error a kind the declaration does not have
        inputs.push({ t: 'restart' });
        const effects: Effect[] = [{ k: 'dispatch', event: 'ready' }, { k: 'dispatch', event: 'terminated', reason: 'x' }, { k: 'teardown' }];
        // @ts-expect-error a 'terminated' dispatch without its reason
        effects.push({ k: 'dispatch', event: 'terminated' });
        // @ts-expect-error a field of another kind
        effects.push({ k: 'flush', port: null });
        expect(inputs.length + effects.length).toBe(13); // the types are checked at compile time; nothing changes at run time
    });

    it('a transition is a value the docs can render: from, input and to, each a declared name', () => {
        const names = new Set<string>(LC_STATES);
        for (const transition of exploration.transitions as readonly Transition[]) {
            expect(names.has(transition.from) && names.has(transition.to), transitionKey(transition)).toBe(true);
            expect(Object.hasOwn(LC_INPUTS, transition.input)).toBe(true);
        }
    });
});
