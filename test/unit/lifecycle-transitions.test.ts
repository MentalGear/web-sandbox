// @vitest-environment node
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
    const state: { state: string; build: unknown; pending: unknown; refused: unknown } = value; // as data: the type already says it
    const standing = state.state === 'loading' || state.state === 'ready';
    if (standing !== (state.build !== null)) return `${state.state} with build ${JSON.stringify(state.build)}`;
    if (state.pending !== null && state.state !== 'terminated') return `${state.state} with a pending termination`;
    if (standing && state.refused !== null) return `${state.state} with a refusal`;
    return null;
}
const exploration = exploreLifecycle();

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
        expect(new Set(into('ready').map(transition => transition.input))).toEqual(new Set(['frameLoad', 'announced', 'viewReady']));
        const fromIdle = exploration.transitions.filter(transition => transition.from === 'idle' && transition.to !== 'idle');
        expect(new Set(fromIdle.map(transition => transition.input))).toEqual(new Set(['connect', 'build', 'configured', 'terminate']));
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
        expect([...new Set(unlisted)]).toEqual([]);
        // and the runs reach most of what the list says: the exploration over-approximates the element, not by much
        expect(made.size / listed.size).toBeGreaterThan(0.6);
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
