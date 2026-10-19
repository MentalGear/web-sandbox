/**
 * The transitions the lifecycle reducer can make (S76): every (state, input kind, next state) that `reduce` gives from
 * the states it can reach, exploring only the pairs its declaration admits (lifecycle.ts, LC_INPUTS). The docs' state
 * diagram is drawn from it; test/unit/lifecycle-transitions.test.ts replays each one through `reduce`, and checks that
 * the generated model runs make no other.
 *
 * The exploration is breadth first from INITIAL_LIFECYCLE, over every admitted input with each field drawn from a small
 * set of values by its declared type (samplesOf). States are compared by what the reducer reads of them: the generation
 * only as the generation a pending termination belongs to is or is not the current one, the input count only as the
 * last usable config's is or is not the current one, and a guest frame's window by which of two it is. A dispatch stack
 * deeper than two adds no behaviour (only its top and whether it is empty are read), so it is explored to two.
 *
 * Data for tests and the docs: the library's own code does not import it.
 */
import type { SandboxState } from '../host';
import { admits, INITIAL_LIFECYCLE, LC_INPUTS, reduce, type BuildContext, type InputKind, type LcInput, type LcInputKind, type LcState } from './lifecycle';

export interface Transition {
    readonly from: SandboxState;
    readonly input: LcInputKind;
    readonly to: SandboxState;
}

export interface Exploration {
    /** Every distinct transition, sorted. */
    readonly transitions: readonly Transition[];
    /** For each transition (transitionKey), a state and an input that make it. */
    readonly witnesses: ReadonlyMap<string, { readonly state: LcState; readonly input: LcInput }>;
    /** How many distinct states the exploration reached. */
    readonly states: number;
}

export const transitionKey = (transition: Transition) => `${transition.from} -${transition.input}-> ${transition.to}`;

// The guest frame windows, as identities: a frame's load and an announcement compare them with the build's `announcer`.
const WINDOW_A = Object.freeze({ window: 'A' });
const WINDOW_B = Object.freeze({ window: 'B' });
const REASON = 'R';
const CONTEXTS: readonly BuildContext[] = [
    { buildsHere: false, blocked: null, strict: false, announces: false },
    { buildsHere: true, blocked: REASON, strict: false, announces: false },
    { buildsHere: true, blocked: null, strict: true, announces: false },
    { buildsHere: true, blocked: null, strict: false, announces: true },
    { buildsHere: true, blocked: null, strict: false, announces: false },
];

/** The values a field of the declared type takes in the exploration. One reason for every string: the no-repeat rule compares them. */
export function samplesOf(type: string): readonly unknown[] {
    switch (type) {
        case 'BuildContext': return CONTEXTS;
        case 'boolean': return [true, false];
        case 'string': return [REASON];
        case 'string | null': return [null, REASON];
        case "'reset' | 'load'": return ['reset', 'load'];
        case 'unknown': return [{}];
        case 'window': return [WINDOW_A, WINDOW_B];
        case 'window | null': return [null, WINDOW_A, WINDOW_B];
        case 'readonly Notice[]': return [[{ level: 'error', text: `[Sandbox] ${REASON}`, source: 'host' }]];
        default: throw new Error(`lifecycleTransitions: no values for a field of type ${type}`);
    }
}

/** Every input of `kind` the exploration tries in `state`: each combination of its fields' values, at the current generation. */
function inputsOf(kind: LcInputKind, state: LcState): LcInput[] {
    const declared: InputKind = LC_INPUTS[kind];
    let partial: Record<string, unknown>[] = [{ t: kind }];
    for (const [name, field] of Object.entries(declared.fields)) {
        const values = [...samplesOf(field.type), ...(field.optional ? [undefined] : [])];
        partial = partial.flatMap(input => values.map(value => (value === undefined ? input : { ...input, [name]: value })));
    }
    if (declared.stamped === 'always') partial = partial.map(input => ({ ...input, gen: state.gen }));
    if (declared.stamped === 'optional') partial = partial.flatMap(input => [input, { ...input, gen: state.gen }]);
    return partial as LcInput[];
}

const windowName = (value: unknown) => (value === WINDOW_A ? 'A' : value === WINDOW_B ? 'B' : value === null ? null : '?');

/** A state as the reducer reads it (see the module's comment). */
function stateKey(state: LcState): string {
    const build = state.build;
    return JSON.stringify([
        state.state,
        state.pending === null ? null : [state.pending.reason, state.pending.gen === state.gen],
        state.dispatching,
        state.within,
        build === null ? null : [build.strict, build.announces, build.frameLoaded, build.accepted, windowName(build.announcer)],
        state.lastInputs === null ? null : state.lastInputs === state.inputs,
        state.refused,
    ]);
}

/** Explores the reducer from INITIAL_LIFECYCLE over the declared (state, input) pairs. */
export function exploreLifecycle(): Exploration {
    const seen = new Map<string, LcState>([[stateKey(INITIAL_LIFECYCLE), INITIAL_LIFECYCLE]]);
    const queue: LcState[] = [INITIAL_LIFECYCLE];
    const witnesses = new Map<string, { state: LcState; input: LcInput }>();
    const transitions = new Map<string, Transition>();
    while (queue.length > 0) {
        const state = queue.shift()!;
        for (const kind of Object.keys(LC_INPUTS) as LcInputKind[]) {
            if (kind === 'dispatchStarted' && state.dispatching.length >= 2) continue;
            for (const input of inputsOf(kind, state)) {
                if (!admits(state, input)) break; // the same kind: none of its inputs is admitted here
                const next = reduce(state, input).state;
                const transition: Transition = { from: state.state, input: kind, to: next.state };
                const key = transitionKey(transition);
                if (!transitions.has(key)) {
                    transitions.set(key, transition);
                    witnesses.set(key, { state, input });
                }
                const nextKey = stateKey(next);
                if (!seen.has(nextKey)) {
                    seen.set(nextKey, next);
                    queue.push(next);
                }
            }
        }
    }
    const sorted = [...transitions.values()].sort((a, b) => transitionKey(a).localeCompare(transitionKey(b)));
    return { transitions: sorted, witnesses, states: seen.size };
}

/** The transitions the reducer can make, sorted: what the docs' state diagram is drawn from. */
export function lifecycleTransitions(): readonly Transition[] {
    return exploreLifecycle().transitions;
}
