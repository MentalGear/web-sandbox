/**
 * The lifecycle of `<web-sandbox>` as one pure reducer (backlog S65; research 18, class L, design 3), and the
 * executor that applies its effects. Internal: src/index.ts does not export it.
 *
 * It is checked against the lifecycle reference model (test/model/lifecycle-model.ts) by test/model/reducer-runner.ts,
 * which runs `reduce` and `runEffects` against a fake host on thousands of generated sequences
 * (test/unit/lifecycle-reducer.test.ts), and on each class-L finding's trace.
 *
 * host.ts keeps the lifecycle state in this module's `LcState` (the element's `_lc`) and steps every input through this
 * executor (host.ts, the module-level `step`): every termination, terminate() and the element's own, each with the
 * generation it was armed in (`terminate{gen}`); every build (connect, reset(), load(), setConfig(): `connect`, `build`,
 * `setConfig`, `configured`, and the build effect's `built` and `buildFailed`), the element's removal and adoption
 * (`disconnect`), the files (`filesChanged`) and the load deadline (`loadDeadline`); and the completion of a build and
 * the `ready` gate (the wrapper's load, `frameLoad`; the guest's announcement, `announced`; the view's check-in,
 * `viewReady`). The executor is the one writer of `_lc`, and makes the lifecycle's two events;
 * test/unit/lifecycle-reducer.test.ts holds host.ts to it by its source ("class L in host.ts").
 *
 * Class L's invariant (research 18): each transition is reachable by one path, guarded by one predicate; events are
 * dispatched only after the state has settled, never from inside the embedder's own call; queued work is released only
 * at the gate it waits for; an actor of an old environment cannot act. What carries each part here:
 * - one path, one predicate: every transition is a case of `reduce`, and nothing else computes a next state;
 * - the state settles first: `step` stores the reducer's state before the executor runs a single effect, and in every
 *   output the resource effects come before the dispatches (a listener finds the environment it is told about in place);
 * - one gate: `flush` is emitted by one function (`enterReady`), always together with `dispatch ready`, and `ready` is
 *   reached only from `loading` (R5:L-1: in strict mode the wrapper's load flushes nothing);
 * - an old environment cannot act: every input a platform callback, a timer or the build effect delivers carries the
 *   generation it was armed in, and `reduce` drops a stale one with no effect at all (AR:B4, by construction
 *   rather than by port identity and stopped timers); and the executor runs an output's effects only while the
 *   environment it was computed for stands, so it stops at the first effect after embedder code tore that environment
 *   down (AR:B5, R4:L-2: a listener's reset or terminate is never undone, at one comparison site; LM-2: embedder code that runs
 *   inside the element's own build, or inside its warning, and builds again).
 *
 * The inputs and the effects are declared as values (LC_INPUTS, LC_EFFECTS; S76): each input kind with where it comes
 * from, whether it carries a generation, and the states and modes it can arrive in. LcInput and Effect are derived from
 * them, `reduce` asserts the preconditions, the model runs check them (test/model/), and lifecycle-transitions.ts lists
 * from them the transitions `reduce` can make, which the docs' state diagram is drawn from.
 *
 * Where src/host.ts and the S65 plan disagree, this module follows host.ts (and README.md and docs/API.md), and says so
 * at the place: search for "Today's code".
 */
import type { SandboxState } from '../host';
import { hostLine, reasonText } from './reasons';

/**
 * What a build reads besides the reducer's own state, asked of the host at the moment the build starts: whether the
 * element may build where it is (host.ts, buildsHere: in the defining realm's document, and connected; R2:L-1), the
 * refusal the config and the files give apart from an unusable config (an unknown mode, AR:A4; a strict entry that
 * names no registered JavaScript file, R2:L-4), and the two facts of the build that its completion depends on: strict
 * mode (the view checks in on its port, VIEW_READY) and whether the guest frame runs a bootstrap that announces its
 * port (`allow-scripts` in cooperative mode, always in worker mode; BR:CB1).
 */
export interface BuildContext {
    buildsHere: boolean;
    blocked: string | null;
    strict: boolean;
    announces: boolean;
}

/** A line the element dispatches as 'sandbox-log' before it acts (the `notice` effect): one event per notice. */
export interface Notice {
    level: 'error' | 'warn';
    text: string;
    source: 'host' | 'guest'; // 'guest': the guest's own text, through the guest relay's rate limit (FR:F3)
}

/**
 * The progress of the standing build, from the build effect to the next teardown.
 */
export interface BuildProgress {
    readonly strict: boolean;
    readonly announces: boolean;
    readonly frameLoaded: boolean; // the wrapper's one load arrived
    readonly accepted: boolean; // the one announcement this build accepts arrived (a port, or worker mode's refusal)
    // The window the accepted announcement came from, when it carried a port (the guest checked in), else null: the
    // guest frame the wrapper's load must hold (S46). Opaque here, compared by identity only; released with the build.
    readonly announcer: unknown;
}

declare const generationBrand: unique symbol;

/**
 * Counts environments. Minted only by INITIAL_LIFECYCLE and by a teardown (tornDown), and compared only with another
 * generation: the host's other counters (its probes' pings, its view writes) type-check as numbers, never as this.
 */
export type Generation = number & { readonly [generationBrand]: true };

/** What every state holds, whatever it is. */
export interface LcCommon {
    // Counts environments: every teardown increments it (host.ts, `_generation`). The only clock the reducer compares.
    readonly gen: Generation;
    // The 'terminated' reasons being dispatched, innermost last (host.ts, `_terminationDispatched`, saved and restored
    // around each dispatch: the same stack, kept as one value and the call stack).
    readonly dispatching: readonly string[];
    // The 'terminated' being dispatched when the last build started, or null (R2:L-4). Kept across teardowns: only the
    // next build replaces it.
    readonly within: string | null;
    // What a build reads changed this many times: setConfig(), load(), the files.
    readonly inputs: number;
    // `inputs` when the last usable setConfig() argument was stored, or null after a refusal (the copy itself is the
    // host's data, host.ts's `_lastConfig`, compared by the host: `setConfig.same`).
    readonly lastInputs: number | null;
    // Why the last setConfig() argument could not be used, or null: every build is refused with it while it is set.
    readonly refused: string | null;
}

// A build's 'terminated' waiting for its task (R1:R3-2), with the generation it belongs to. host.ts holds a
// token object instead; the two are the same rule, since every teardown both clears the token and increments the
// generation, and nothing else replaces the token.
export interface PendingTermination {
    readonly reason: string;
    readonly gen: Generation;
}

/**
 * The lifecycle's state, by `state`: a build stands (`build`) exactly while it is `loading` or `ready`, and no refusal
 * stands then (a refused build is `terminated` at once); a build's 'terminated' waits for its task only in `terminated`.
 */
export type LcState =
    | (LcCommon & { readonly state: 'idle'; readonly build: null; readonly pending: null })
    | (LcCommon & { readonly state: 'loading' | 'ready'; readonly build: BuildProgress; readonly pending: null; readonly refused: null })
    | (LcCommon & { readonly state: 'terminated'; readonly build: null; readonly pending: PendingTermination | null });

/** A state in which a build stands. */
export type StandingState = Extract<LcState, { readonly state: 'loading' | 'ready' }>;

const standing = (state: LcState): state is StandingState => state.state === 'loading' || state.state === 'ready';

export const INITIAL_LIFECYCLE: LcState = Object.freeze({
    state: 'idle',
    gen: 0 as Generation,
    pending: null,
    dispatching: Object.freeze([]) as readonly string[],
    within: null,
    build: null,
    inputs: 0,
    lastInputs: null,
    refused: null,
});

// ---- the declaration: the reducer's inputs and effects, as values --------------------------------------------------

declare const fieldType: unique symbol;

/** A field of an input or an effect: the name of its type, for the docs, and the type itself, for the compiler. */
export interface Field<T> {
    readonly type: string;
    readonly optional: boolean;
    readonly [fieldType]?: T;
}

const field = <T>(type: string): Field<T> => ({ type, optional: false });
const optional = <T>(type: string): Field<T> & { readonly optional: true } => ({ type, optional: true });

type Fields = Readonly<Record<string, Field<unknown>>>;
type Simplify<T> = { [K in keyof T]: T[K] };
type FieldsOf<F extends Fields> = Simplify<
    { -readonly [K in keyof F as F[K] extends { readonly optional: true } ? never : K]: F[K] extends Field<infer T> ? T : never }
    & { -readonly [K in keyof F as F[K] extends { readonly optional: true } ? K : never]?: F[K] extends Field<infer T> ? T : never }
>;

/** The modes a build can be in. The reducer tells them apart by its build's `strict` only. */
export type LcMode = 'strict' | 'cooperative' | 'worker';

export const LC_STATES = ['idle', 'loading', 'ready', 'terminated'] as const satisfies readonly SandboxState[];
const ANY_STATE = LC_STATES;
const STANDING = ['loading', 'ready'] as const;

/**
 * An input kind: where it comes from, whether it carries the generation it was armed in (`stamped`: dropped once that
 * environment is gone, isStale), and the preconditions of one that is not stale: the states it can arrive in, and,
 * where it matters, the modes. `reduce` asserts them (`admits`); lifecycleTransitions() explores only these pairs.
 */
export interface InputKind {
    readonly from: string;
    readonly stamped: 'always' | 'optional' | 'never';
    readonly states: readonly SandboxState[];
    readonly modes?: readonly LcMode[];
    readonly fields: Fields;
}

/**
 * What can happen to the lifecycle. The inputs that carry `gen` come from a platform callback or a timer armed in that
 * environment, and are dropped when it is gone; the others come from the embedder's call or from the executor itself,
 * now, and carry none. A stamped input that is not stale arrives only while the environment it was armed in stands:
 * every transition but `loading` → `ready` is a teardown, which counts the generation up.
 */
export const LC_INPUTS = {
    // connectedCallback (host.ts, `connected`); the host does not step it when the engine refused to give a Firefox-adopted
    // element its prototype back (restorePrototype: the element stays idle, as its `disconnect` left it).
    connect: { from: 'connectedCallback', stamped: 'never', states: ANY_STATE, fields: { ctx: field<BuildContext>('BuildContext') } },
    // disconnectedCallback and adoptedCallback alike (host.ts, `disconnected`, `adopted`): the environment ends, quietly.
    disconnect: { from: 'disconnectedCallback, adoptedCallback', stamped: 'never', states: ANY_STATE, fields: {} },
    // reset() and load() (load() stores its html first: the host's data).
    build: { from: 'reset(), load()', stamped: 'never', states: ANY_STATE, fields: { why: field<'reset' | 'load'>("'reset' | 'load'"), ctx: field<BuildContext>('BuildContext') } },
    // setConfig(): `same` is the host's comparison of the structured clone with the last usable copy (a clone that failed
    // is never the same). The rest of the no-op predicate is the reducer's (R1:R3-7).
    setConfig: { from: 'setConfig()', stamped: 'never', states: ANY_STATE, fields: { same: field<boolean>('boolean') } },
    // The config was applied (the `applyConfig` effect): its refusal, or null, and the context of the build it starts.
    configured: { from: 'the applyConfig effect', stamped: 'never', states: ANY_STATE, fields: { refusal: field<string | null>('string | null'), ctx: field<BuildContext>('BuildContext') } },
    // registerFiles(), unregisterFiles() or commitGuestWrites() changed the store (its 'fileschanged' is the host's).
    filesChanged: { from: 'registerFiles(), unregisterFiles(), commitGuestWrites()', stamped: 'never', states: ANY_STATE, fields: {} },
    // The build effect returned what it prepared, or threw (the reason the host gives for what it threw), for the build of
    // `gen` (LM-2: embedder code can run inside the build effect and build again, and then this build is gone). The
    // `attach` effect's own throw is a `buildFailed` of its build too. Its build is `loading` until it is attached.
    built: { from: 'the build effect', stamped: 'always', states: ['loading'], fields: { prepared: field<unknown>('unknown') } },
    buildFailed: { from: 'the build or attach effect', stamped: 'always', states: ['loading'], fields: { reason: field<string>('string') } },
    // The task of a build's 'terminated' (R1:R3-2), armed as the build ends.
    buildTerminationDue: { from: 'the task effect', stamped: 'always', states: ['terminated'], fields: {} },
    // A termination. Without `gen`: terminate() (its reason already defaulted, R2:L-7), or a build failure
    // the executor caught. With `gen`: one the element starts (the watchdog, the view's watchdog, workerExecutionTimeout,
    // the uncaught budget, VIEW_OVERRUN, an entry failure, a host-page refusal, a second announcement, the frame-integrity
    // checks at the wrapper's load), whatever decides it (the host decides, for instance, which VIEW_OVERRUN ends the
    // sandbox); with `notices`, the lines dispatched before it, one by one. In any state: a guarded effect that throws
    // after its own output terminated ends that environment again, which changes nothing.
    terminate: { from: "terminate(), the element's own terminations, the executor", stamped: 'optional', states: ANY_STATE, fields: { reason: field<string>('string'), notices: optional<readonly Notice[]>('readonly Notice[]') } },
    // The load deadline (BR:CB3): LOAD_TIMEOUT_MS of loading.
    loadDeadline: { from: 'the load deadline', stamped: 'always', states: STANDING, fields: {} },
    // The wrapper's load, in the microtask the host's load handler queues (R4:L-1): `gen` as the load event found it;
    // `stillOurs` whether, in the microtask, the frame is still the element's and both are connected; `guest` the guest
    // frame's window, or null (R2:L-6, S46): compared with the build's `announcer` by identity.
    frameLoad: { from: "the wrapper's load event", stamped: 'always', states: STANDING, fields: { stillOurs: field<boolean>('boolean'), guest: field<unknown>('window | null') } },
    // The guest frame's announcement (BR:CB1). `valid`: trusted, and exactly one port or worker mode's refusal; `refusal`:
    // the reason worker mode's frame gave for a worker that could not start (R2:C-5), else null; `source`:
    // the window it came from (the guest frame's: the host's listener hears no other). A strict build listens for none.
    announced: { from: "the host page's message listener", stamped: 'always', states: STANDING, modes: ['cooperative', 'worker'], fields: { valid: field<boolean>('boolean'), refusal: field<string | null>('string | null'), port: field<unknown>('unknown'), source: field<unknown>('window') } },
    // The strict view's check-in on its port (R1:R3-1), with what the host checks then.
    viewReady: { from: "the view port's VIEW_READY", stamped: 'always', states: STANDING, modes: ['strict'], fields: { height: field<unknown>('unknown'), stillStyleRefused: field<boolean>('boolean') } },
    // Around each 'terminated' dispatch (the executor's; R4:L-3: every one, so the no-repeat rule holds for all).
    dispatchStarted: { from: 'the executor', stamped: 'never', states: ANY_STATE, fields: { reason: field<string>('string') } },
    dispatchEnded: { from: 'the executor', stamped: 'never', states: ANY_STATE, fields: {} },
} as const satisfies Record<string, InputKind>;

export type LcInputKind = keyof typeof LC_INPUTS;

type StampOf<S> = S extends 'always' ? { gen: Generation } : S extends 'optional' ? { gen?: Generation } : unknown;
type InputOf<K extends LcInputKind> = Simplify<{ t: K } & FieldsOf<(typeof LC_INPUTS)[K]['fields']> & StampOf<(typeof LC_INPUTS)[K]['stamped']>>;

/** An input of the reducer, derived from LC_INPUTS. */
export type LcInput = { [K in LcInputKind]: InputOf<K> }[LcInputKind];

/** An effect kind: one thing to the element's resources, or one dispatch; `variants` where one kind has several shapes. */
export interface EffectKind {
    readonly summary: string;
    readonly fields?: Fields;
    readonly variants?: readonly Fields[];
}

// The calls are marked pure: the element reads none of this at run time, and a bundle leaves it out.
export const LC_EFFECTS = {
    teardown: { summary: "host.ts, `_teardown` without its generation and pending-termination lines, which are the reducer's" },
    discardWrites: { summary: "the guest writes' overlay is dropped" },
    applyConfig: { summary: 'stores the clone (normaliseConfig), and answers with its refusal: then `configured`' },
    // host.ts, `_prepareBuild`: everything of the build that can run embedder code (the HTML sinks a host page's Trusted
    // Types default policy runs at, the warnings), into values the element does not hold yet
    build: { summary: 'prepares the build; then `built`, or `buildFailed` if it threw' },
    // host.ts, `_attachBuild`: the prepared build becomes the element's (its frame, its announcement listener, its bridge
    // and overlay); no embedder code runs there, so no other build can come in between (LM-2)
    attach: { summary: "the prepared build becomes the element's", fields: { prepared: /* @__PURE__ */ field<unknown>('unknown') } },
    startLoadDeadline: { summary: 'arms the load deadline (LOAD_TIMEOUT_MS)' },
    stopLoadDeadline: { summary: 'stops the load deadline' },
    sendInitView: { summary: "strict mode, at the wrapper's load: the view (`target`) gets its ports (`_setupStrictChannels`)", fields: { target: /* @__PURE__ */ field<unknown>('window') } },
    openChannel: { summary: 'cooperative and worker mode: the announced port, or none (`setupChannel`)', fields: { port: /* @__PURE__ */ field<unknown>('unknown') } },
    closePort: { summary: 'an announced port no build takes', fields: { port: /* @__PURE__ */ field<unknown>('unknown') } },
    checkView: { summary: "the view's size and still-style warnings (R3-1)", fields: { height: /* @__PURE__ */ field<unknown>('unknown'), stillStyleRefused: /* @__PURE__ */ field<boolean>('boolean') } },
    flush: { summary: 'what waited for `ready` goes to the port (`_flushQueues`)' },
    startWatchdogs: { summary: "the guest's and, in strict mode, the view's" },
    startAutoResize: { summary: 'the resizer, in place for the reports buffered before the port' },
    warn: { summary: 'a console warning', fields: { text: /* @__PURE__ */ field<string>('string') } },
    warnForeignDocument: { summary: 'once per element (CB7)' },
    dispatch: { summary: "one of the lifecycle's two events", variants: [{ event: /* @__PURE__ */ field<'ready'>("'ready'") }, { event: /* @__PURE__ */ field<'terminated'>("'terminated'"), reason: /* @__PURE__ */ field<string>('string') }] },
    notice: { summary: "a line, as 'sandbox-log'", fields: { notice: /* @__PURE__ */ field<Notice>('Notice') } },
    step: { summary: 'a nested step, synchronously', fields: { input: /* @__PURE__ */ field<LcInput>('LcInput') } },
    task: { summary: 'a step in a task of its own', fields: { input: /* @__PURE__ */ field<LcInput>('LcInput') } },
} as const satisfies Record<string, EffectKind>;

export type EffectKindName = keyof typeof LC_EFFECTS;

type EffectOf<K extends EffectKindName, D = (typeof LC_EFFECTS)[K]> =
    D extends { readonly variants: readonly (infer V extends Fields)[] } ? (V extends Fields ? Simplify<{ k: K } & FieldsOf<V>> : never)
    : D extends { readonly fields: infer F extends Fields } ? Simplify<{ k: K } & FieldsOf<F>>
    : { k: K };

/** An effect of the reducer, derived from LC_EFFECTS. */
export type Effect = { [K in EffectKindName]: EffectOf<K> }[EffectKindName];

/** Whether the declaration admits `input` in `state` (a stale one is not asked: `reduce` drops it first). */
export function admits(state: LcState, input: LcInput): boolean {
    const kind: InputKind = LC_INPUTS[input.t];
    if (!kind.states.includes(state.state)) return false;
    if (kind.modes === undefined || state.build === null) return true;
    const strict = state.build.strict;
    return kind.modes.some(mode => (mode === 'strict') === strict);
}

/** The exhaustiveness check of a switch over a declared union: a kind added and not handled fails to compile there. */
export function assertNever(value: never): never {
    throw new Error(`[Sandbox] lifecycle: unhandled ${JSON.stringify(value)}`);
}

export interface LcOutput {
    state: LcState;
    effects: readonly Effect[];
    // Whether an effect that throws ends the sandbox (the reason `buildFailed`, reasons.ts): the completion of a build, on
    // all three of its paths, the wrapper's load, the guest's check-in and the view's. A throw there would otherwise leave
    // the build `loading`, its load deadline already stopped. These effects do not throw in practice (they are backstops);
    // one that does leaves nothing half-done behind.
    guarded?: boolean;
}

// ---- the reducer -------------------------------------------------------------------------------------------------

const NOTHING: readonly Effect[] = Object.freeze([]);

const unchanged = (state: LcState): LcOutput => ({ state, effects: NOTHING });

const top = (stack: readonly string[]): string | null => (stack.length > 0 ? stack[stack.length - 1]! : null);

// The generation-and-pending half of host.ts's `_teardown`: a new environment count, and a build's 'terminated' still
// to come is dropped with the environment (R1:R3-2). The resource half is the `teardown` effect.
function tornDown(state: LcCommon): LcCommon {
    return { gen: (state.gen + 1) as Generation, dispatching: state.dispatching, within: state.within, inputs: state.inputs, lastInputs: state.lastInputs, refused: state.refused };
}

// Every termination that is not a build's. Already terminated means nothing to do, which is what
// makes 'terminated' fire once per termination. Warned first, then torn down, then dispatched synchronously: terminate()
// keeps its documented synchronous event (docs/API.md, Lifecycle), and a listener reads `state` 'terminated'.
function terminateNow(state: LcState, reason: string): LcOutput {
    if (state.state === 'terminated') return unchanged(state);
    return {
        state: { ...tornDown(state), state: 'terminated', build: null, pending: null },
        effects: [{ k: 'warn', text: `[Sandbox] terminated: ${reason}` }, { k: 'teardown' }, { k: 'dispatch', event: 'terminated', reason }],
    };
}

// The termination of the build being made. The state is 'terminated' at once; the event comes in a task of its own, like
// 'ready' (R1:R3-2), so a listener added right after setConfig(), reset() or load() hears it; and not at all if the
// environment changed meanwhile (`buildTerminationDue` is dropped as stale).
// The one "no repeat" rule (BR:CB5; R2:L-4; R3:L-1; R4:L-3): a build started while a 'terminated' is dispatched, refused
// or failed with that very reason, ends 'terminated' and dispatches nothing, and says nothing either (the answer being
// dispatched was warned already). Without it a 'terminated' listener that built again from the same inputs recurses
// until the stack runs out (BR:CB5); with it every such build ends at once, so no listener can loop. The rule is on the
// answer, never a build skipped (R3:L-1: a listener's move leaves the element connected and 'idle').
// A refused build counts the generation up twice (`initialize` tears down, then here); the reference model counts once,
// and the oracle compares only whether it changed.
function terminateBuild(state: LcState, reason: string): LcOutput {
    if (state.state === 'terminated') return unchanged(state);
    return endBuild(state, reason);
}

// The termination of a build that is not terminated: one that stands, or the one `initialize` is making (torn down,
// and refused before it is `loading`).
function endBuild(state: LcCommon, reason: string): LcOutput {
    const repeated = state.within === reason;
    const next = { ...tornDown(state), state: 'terminated' as const, build: null, pending: null };
    const effects: Effect[] = [];
    if (!repeated) effects.push({ k: 'warn', text: `[Sandbox] terminated: ${reason}` });
    effects.push({ k: 'teardown' });
    if (repeated) return { state: next, effects };
    effects.push({ k: 'task', input: { t: 'buildTerminationDue', gen: next.gen } });
    return { state: { ...next, pending: { reason, gen: next.gen } }, effects };
}

// The element left (or never reached) a document it can build in. No event.
function stop(state: LcState): LcOutput {
    return { state: { ...tornDown(state), state: 'idle', build: null, pending: null }, effects: [{ k: 'teardown' }, { k: 'discardWrites' }] };
}

// The one place a build starts (connection, reset(), load(), setConfig()), then the build effect, whose answer is
// `built` or `buildFailed` (LM-2: see there). Every build runs, from a 'terminated' listener too (R3:L-1); the no-repeat
// rule is on its answer (terminateBuild). Where the element may not build (R2:L-1: one predicate, asked by every
// build), it stops instead and stays idle. Otherwise 'loading'
// first: every attempt that fails is one termination with its own reason, also from 'terminated' (reset() of a refused
// config says again why it cannot start).
function initialize(state: LcCommon, ctx: BuildContext): LcOutput {
    const within = top(state.dispatching);
    const torn: LcCommon = { ...tornDown(state), within };
    const effects: Effect[] = [{ k: 'teardown' }, { k: 'discardWrites' }];
    if (!ctx.buildsHere) return { state: { ...torn, state: 'idle', build: null, pending: null }, effects };
    const refusal = state.refused ?? ctx.blocked;
    if (refusal !== null) {
        const refused = endBuild(torn, refusal);
        return { state: refused.state, effects: [...effects, ...refused.effects] };
    }
    const build: BuildProgress = { strict: ctx.strict, announces: ctx.announces, frameLoaded: false, accepted: false, announcer: null };
    effects.push({ k: 'build' });
    return { state: { ...torn, state: 'loading', build, pending: null, refused: null }, effects };
}

// The transition to `ready`, in every mode, and the one place what waited for it is released (R5:L-1). The load
// deadline stops; the queue goes to the port in the order it was issued; the watchdogs
// are armed before 'ready' is dispatched (a 'ready' listener that resets or terminates stops them with the rest, instead
// of leaving one running for a port that is gone); the resizer is in place for the reports buffered before the port.
// The state is 'ready' before the first effect, as every state is stored before its effects run. Nothing the flush or the
// watchdogs run reads it (the host's own code, no embedder code), so that is not observable there;
// test/unit/lifecycle-reducer.test.ts pins the order.
function enterReady(state: StandingState, before: readonly Effect[] = NOTHING): LcOutput {
    return {
        state: { ...state, state: 'ready' },
        effects: [...before, { k: 'stopLoadDeadline' }, { k: 'flush' }, { k: 'startWatchdogs' }, { k: 'startAutoResize' }, { k: 'dispatch', event: 'ready' }],
        guarded: true,
    };
}

// Cooperative and worker mode complete at the guest's check-in, with its port, or, where the guest runs no bootstrap, at
// the wrapper's load, with none. Past `loading`: the port is closed, nothing else.
function finishBuild(state: StandingState, port: unknown): LcOutput {
    if (state.state !== 'loading') return { state, effects: port === null ? NOTHING : [{ k: 'closePort', port }] };
    return enterReady(state, [{ k: 'openChannel', port }]);
}

// The wrapper's load. The wrapper is written once and has no script, so it
// loads exactly once: a second load means something navigated or reloaded it. A guest that checked in already must be
// the one the load holds (S46). Then: a bootstrap's check-in completes the build, after this load; strict mode hands the
// view its ports and completes at VIEW_READY, never on this load alone (R1:R3-1: it also fires for a view whose bootstrap
// the host page refused); a guest with no bootstrap completes now.
function frameLoad(state: LcState, input: Extract<LcInput, { t: 'frameLoad' }>): LcOutput {
    if (!input.stillOurs || !standing(state)) return unchanged(state);
    const build = state.build;
    const guarded = (output: LcOutput): LcOutput => ({ ...output, guarded: true });
    if (build.frameLoaded) return guarded(terminateNow(state, reasonText('secondLoad')));
    const loaded: StandingState = { ...state, build: { ...build, frameLoaded: true } };
    if (build.announcer !== null) return guarded(input.guest === build.announcer ? unchanged(loaded) : terminateNow(loaded, reasonText('secondLoad')));
    if (input.guest === null) return guarded(terminateNow(loaded, reasonText('frameMissing')));
    if (build.announces) return guarded(unchanged(loaded));
    if (build.strict) return { state: loaded, effects: [{ k: 'sendInitView', target: input.guest }], guarded: true };
    return finishBuild(loaded, null);
}

// The guest frame's announcement: exactly one per environment, from a build that expects one. Any other (a second one,
// one strict mode's frame never sends, an untrusted or malformed one) ends the environment: a guest that reloads or
// rewrites itself announces again, and a forgery can only end its own environment (BR:PD8). Worker mode's refusal is the
// frame's one announcement: one host line, then the termination with its reason (R2:C-5).
function announced(state: LcState, input: Extract<LcInput, { t: 'announced' }>): LcOutput {
    if (!standing(state) || state.build.accepted || !state.build.announces || !input.valid) return terminateNow(state, reasonText('secondAnnouncement'));
    const build = state.build;
    if (input.refusal !== null) {
        const accepted: StandingState = { ...state, build: { ...build, accepted: true } };
        return refusedByHostPage(accepted, input.refusal);
    }
    const checkedIn: StandingState = { ...state, build: { ...build, accepted: true, announcer: input.source } };
    return { ...finishBuild(checkedIn, input.port), guarded: true };
}

// A frame of ours the host page's policy refused (host.ts, `_refusedByHostPage`, for the view's refusals): one host line,
// then the termination, unless a listener of that line acted first.
function refusedByHostPage(state: LcState, reason: string): LcOutput {
    return terminate(state, { t: 'terminate', reason, gen: state.gen, notices: [{ level: 'error', text: hostLine('refusedByHostPage', reason), source: 'host' }] });
}

// A termination. With notices, the lines come first, one event each, and the termination is a nested step after them:
// the executor stops before the next notice, and before the step, once a listener tore the environment down (AR:B5;
// R4:L-2: a second line of one callback must not reach the next environment's listeners).
function terminate(state: LcState, input: Extract<LcInput, { t: 'terminate' }>): LcOutput {
    const notices = input.notices ?? [];
    if (notices.length === 0) return terminateNow(state, input.reason);
    const effects: Effect[] = [];
    for (const notice of notices) effects.push({ k: 'notice', notice });
    effects.push({ k: 'step', input: { t: 'terminate', reason: input.reason, gen: state.gen } });
    return { state, effects };
}

// Why a build is still `loading` at its deadline: once the wrapper has loaded, the frame that runs the library's startup
// script (the strict view, or the guest's bootstrap) has loaded too, and that script runs first: had it run, it would
// have checked in. So the host page's policy stopped it (R1:R3-1). Before the wrapper's load, the frame did not finish
// loading. A deadline bounds `loading` only, of the build it was started for (LM-2): the input carries that build's
// generation, and it acts only while that build is `loading`; `enterReady` stops it as well, but the bound does not rest
// on a timer stopped.
function loadDeadline(state: LcState): LcOutput {
    if (state.state !== 'loading') return unchanged(state);
    const build = state.build;
    const scripted = build.strict || build.announces;
    return terminateNow(state, build.frameLoaded && scripted ? reasonText('startupBlocked') : reasonText('loadTimeout'));
}

// A build's deferred 'terminated': dispatched only if nothing tore the environment down since it was armed.
function buildTerminationDue(state: LcState): LcOutput {
    if (state.state !== 'terminated') return unchanged(state);
    const pending = state.pending;
    if (pending === null || pending.gen !== state.gen) return unchanged(state);
    return { state: { ...state, pending: null }, effects: [{ k: 'dispatch', event: 'terminated', reason: pending.reason }] };
}

// setConfig() (R1:R3-7): the configuration the standing
// environment was built from, again, with nothing a build reads changed since and no refusal standing, rebuilds nothing
// (an embedder that applies its config on every edit keeps its guest). Otherwise the inputs count up, and the host
// applies the copy: the no-op is decided before anything of the argument is applied (warnings, the stored config).
function setConfig(state: LcState, same: boolean): LcOutput {
    const current = same && state.lastInputs === state.inputs && state.refused === null && (state.state === 'ready' || state.state === 'loading');
    if (current) return unchanged(state);
    return { state: { ...state, inputs: state.inputs + 1 }, effects: [{ k: 'applyConfig' }] };
}

function configured(state: LcState, input: Extract<LcInput, { t: 'configured' }>): LcOutput {
    const stored: LcCommon = { ...state, refused: input.refusal, lastInputs: input.refusal === null ? state.inputs : null };
    return initialize(stored, input.ctx);
}

/**
 * Whether `input` belongs to an environment that is gone: then `reduce` gives no effects and leaves the state as it is.
 * The inputs that carry the generation they were armed in are the kinds LC_INPUTS stamps, and the type derived from it
 * gives exactly those a `gen` (required where `stamped` is 'always'): a kind newly stamped is checked here with no list
 * to extend.
 */
export function isStale(state: LcState, input: LcInput): boolean {
    return 'gen' in input && input.gen !== undefined && input.gen !== state.gen;
}

/**
 * The lifecycle's one transition function: pure, total over the declared pairs, and the only place a next state is
 * computed. An input that is not stale and that the declaration does not admit in this state (LC_INPUTS: its states
 * and modes) throws, before anything is stored or run: the declaration is what the docs' state diagram is drawn from
 * (lifecycleTransitions), so an input it does not foresee is a bug of the declaration or of the host, never a no-op.
 * Asserted always, not only in tests: one lookup per input, a few inputs a build, and the package has no development
 * build to put it in.
 */
export function reduce(state: LcState, input: LcInput): LcOutput {
    if (isStale(state, input)) return unchanged(state);
    if (!admits(state, input)) throw new Error(`[Sandbox] lifecycle: ${input.t} cannot arrive in ${state.state}${state.build === null ? '' : state.build.strict ? ' (strict)' : ' (not strict)'}`);
    switch (input.t) {
        case 'connect':
            if (!input.ctx.buildsHere) {
                const stopped = stop(state);
                return { state: stopped.state, effects: [...stopped.effects, { k: 'warnForeignDocument' }] };
            }
            return initialize(state, input.ctx);
        case 'disconnect':
            return stop(state);
        case 'build':
            return initialize(input.why === 'load' ? { ...state, inputs: state.inputs + 1 } : state, input.ctx);
        case 'setConfig':
            return setConfig(state, input.same);
        case 'configured':
            return configured(state, input);
        case 'filesChanged':
            return { state: { ...state, inputs: state.inputs + 1 }, effects: NOTHING };
        case 'built':
            // LM-2 (class L; S65). Embedder code runs inside the build effect: a host page's Trusted Types default
            // policy at each HTML sink it writes (the wrapper's srcdoc, the inert parse of the markup), a patched
            // console.warn at each warning. One that calls reset() there builds again, from inside the build, and the
            // outer build must not go on over the nested one with the element's fields: a second load deadline would
            // overwrite the first, which would never be stopped and would end the sandbox LOAD_TIMEOUT_MS later, `ready`
            // as it was; its announcement listener would go on the nested frame and overwrite the nested one's stop, so
            // one listener would outlive its environment; it would append the nested frame a second time; and its
            // failure, had it thrown, would end the nested build. So, by construction, in three parts:
            // - the build effect prepares and attaches nothing (host.ts, `_prepareBuild`), and this input carries the
            //   generation of its build: a build that a nested one replaced is stale here, and what it prepared is
            //   dropped, never the element's;
            // - the build becomes the element's in `attach`, which runs no embedder code, and every per-build resource is
            //   made there or later and released by the `teardown` effect: one frame, one listener, one deadline per build;
            // - the deadline starts here, once per build (one `built` per build effect), and acts only for its generation
            //   and only while that build is `loading` (`loadDeadline`).
            return state.state === 'loading' ? { state, effects: [{ k: 'attach', prepared: input.prepared }, { k: 'startLoadDeadline' }] } : unchanged(state);
        case 'buildFailed':
            // A build's failure carries the generation of its build, because it is that build's answer: a refusal known
            // before building is decided inside `initialize` and needs no input, so this input comes only from the build
            // effect (or `attach`), and the only way its build can be gone by then is embedder code inside the build that
            // built again (LM-2). That nested build then stands, complete, and the outer build's failure is not the
            // sandbox's state, exactly as a build's deferred 'terminated' is not once another build started
            // (`buildTerminationDue`, R1:R3-2). Without the generation, the outer build's throw would end a build that
            // had nothing wrong with it.
            return terminateBuild(state, input.reason);
        case 'buildTerminationDue':
            return buildTerminationDue(state);
        case 'terminate':
            return terminate(state, input);
        case 'loadDeadline':
            return loadDeadline(state);
        case 'frameLoad':
            return frameLoad(state, input);
        case 'announced':
            return announced(state, input);
        case 'viewReady':
            // host.ts, `_onViewMessage` VIEW_READY: the view's check-in, the first frame on the port only its bootstrap
            // holds (R1:R3-1). Guarded, like the two other completions (see LcOutput.guarded).
            if (state.state !== 'loading') return unchanged(state);
            return enterReady(state, [{ k: 'checkView', height: input.height, stillStyleRefused: input.stillStyleRefused }]);
        case 'dispatchStarted':
            return { state: { ...state, dispatching: [...state.dispatching, input.reason] }, effects: NOTHING };
        case 'dispatchEnded':
            return { state: { ...state, dispatching: state.dispatching.slice(0, -1) }, effects: NOTHING };
        default:
            return assertNever(input);
    }
}

// ---- the executor ------------------------------------------------------------------------------------------------

/**
 * What the executor needs of the element. Every method does one thing to the element's resources, or dispatches one
 * event; none decides anything about the lifecycle. `step` is the executor's own entry (below, as a rule), for nested
 * steps; `task` runs one in a task of its own (setTimeout 0).
 */
export interface LifecycleHost {
    lc: LcState;
    step(input: LcInput): void;
    task(input: LcInput): void;
    teardown(): void;
    discardWrites(): void;
    applyConfig(): string | null;
    buildContext(): BuildContext;
    // The build effect: prepares the build, and returns what it prepared, which `attach` makes the element's (LM-2).
    build(): unknown;
    attach(prepared: unknown): void;
    failureReason(error: unknown, phase: 'build' | 'complete'): string;
    startLoadDeadline(): void;
    stopLoadDeadline(): void;
    sendInitView(target: unknown): void;
    openChannel(port: unknown): void;
    closePort(port: unknown): void;
    checkView(height: unknown, stillStyleRefused: boolean): void;
    flush(): void;
    startWatchdogs(): void;
    startAutoResize(): void;
    warn(text: string): void;
    warnForeignDocument(): void;
    dispatchReady(): void;
    dispatchTerminated(reason: string): void;
    notice(notice: Notice): void;
}

/**
 * One step: reduce, store the state, then run its effects. The state is stored before the first effect runs, so it has
 * settled before any embedder code does (a listener reads the `state` its event announces). Steps nest synchronously,
 * with no queue and no lock: terminate() from a listener, or from a getter among a call's arguments, dispatches its
 * 'terminated' synchronously inside that listener, as docs/API.md says and the model checks. (Research 18's design runs
 * the effects of a public method at the end of its outermost call; today's code, and the S65 plan, nest them.)
 */
export function step(host: LifecycleHost, input: LcInput): void {
    const output = reduce(host.lc, input);
    host.lc = output.state;
    runEffects(host, output.effects, output.state.gen, output.guarded === true);
}

const isEmbedderFacing = (effect: Effect) => effect.k === 'dispatch' || effect.k === 'notice' || effect.k === 'step';

// The executor's one comparison of generations (AR:B5; R4:L-2; LM-2): whether the environment an output, or a
// host path's announcement, was made for was torn down since, by embedder code that ran in between (a listener of what
// was just dispatched, a Trusted Types default policy inside the build, a patched console.warn). `reduce` drops a stale
// input (isStale); this stops what is left of a run once its environment is gone. host.ts compares generations
// nowhere else, apart from a call's own environment (`_issue`, `_postRpc`; R3:L-2), and
// test/unit/lifecycle-reducer.test.ts scans for it.
const tornDownSince = (host: { readonly lc: LcState }, stampGen: Generation): boolean => host.lc.gen !== stampGen;

/**
 * Applies one output's effects in order. `stampGen` is the generation the output was computed at: before each effect the
 * executor compares it with the state's, and stops once embedder code tore the environment down in between, so nothing
 * of the output acts on the environment that replaced it (AR:B5, R4:L-2: a listener's reset or terminate is never
 * undone, here at one site). The comparison is made before every effect, not only a dispatch, a notice or a nested step,
 * because a resource effect can run embedder code too (a warning, through a patched console.warn): a `teardown` after a
 * warning whose hook built again would tear down that new build, leaving it `loading` with no frame. So no effect of a
 * gone environment runs. With `guarded`, an effect other than a dispatch that throws ends the sandbox: the completion of a
 * build (see LcOutput.guarded).
 *
 * That termination carries the output's generation. The decision: the throw is a
 * failure of the completion of this environment, so it may end this environment only. A guarded effect can run embedder
 * code (`checkView` warns, through a console.warn the page may have patched), and code that built again from there and
 * then threw would otherwise have its new build ended by the old one's failure: the same rule as a build's own failure
 * (`buildFailed{gen}`, LM-2). In every other case the generation is the current one.
 */
export function runEffects(host: LifecycleHost, effects: readonly Effect[], stampGen: Generation, guarded = false): void {
    for (const effect of effects) {
        if (tornDownSince(host, stampGen)) return;
        if (!guarded || isEmbedderFacing(effect)) {
            runEffect(host, effect, stampGen);
            continue;
        }
        try {
            runEffect(host, effect, stampGen);
        } catch (error) {
            host.step({ t: 'terminate', reason: host.failureReason(error, 'complete'), gen: stampGen });
            return;
        }
    }
}

/**
 * The same rule for a host path that is not a transition of the lifecycle (host.ts, `_handleGuestWrite`: 'fileswritten',
 * then the guest's acknowledgement): each notice dispatches one event, the next one runs only if no listener tore the
 * environment down meanwhile, and `act` runs only then too (AR:B5: an action after a listener's reset() or terminate()
 * would undo it). The terminations that carry notices are `terminate{gen, notices}`. True if `act` ran.
 */
export function runNotices(host: { readonly lc: LcState }, notices: readonly (() => void)[], act: () => void): boolean {
    const stampGen = host.lc.gen;
    for (const notice of notices) {
        notice();
        if (tornDownSince(host, stampGen)) return false;
    }
    act();
    return true;
}

function runEffect(host: LifecycleHost, effect: Effect, stampGen: Generation): void {
    switch (effect.k) {
        case 'teardown': host.teardown(); return;
        case 'discardWrites': host.discardWrites(); return;
        case 'applyConfig': {
            // Not compared with `stampGen`: setConfig() applies and builds with nothing in between.
            const refusal = host.applyConfig();
            host.step({ t: 'configured', refusal, ctx: host.buildContext() });
            return;
        }
        case 'build':
            runBuild(host, stampGen);
            return;
        case 'attach':
            // a throw while attaching is a failure of this build, like one while preparing it (`runBuild`)
            try {
                host.attach(effect.prepared);
            } catch (error) {
                host.step({ t: 'buildFailed', gen: stampGen, reason: host.failureReason(error, 'build') });
            }
            return;
        case 'startLoadDeadline': host.startLoadDeadline(); return;
        case 'stopLoadDeadline': host.stopLoadDeadline(); return;
        case 'sendInitView': host.sendInitView(effect.target); return;
        case 'openChannel': host.openChannel(effect.port); return;
        case 'closePort': host.closePort(effect.port); return;
        case 'checkView': host.checkView(effect.height, effect.stillStyleRefused); return;
        case 'flush': host.flush(); return;
        case 'startWatchdogs': host.startWatchdogs(); return;
        case 'startAutoResize': host.startAutoResize(); return;
        case 'warn': host.warn(effect.text); return;
        case 'warnForeignDocument': host.warnForeignDocument(); return;
        case 'dispatch':
            if (effect.event === 'ready') host.dispatchReady();
            else dispatchTerminated(host, effect.reason);
            return;
        case 'notice': host.notice(effect.notice); return;
        case 'step': host.step(effect.input); return;
        case 'task': host.task(effect.input); return;
        default: assertNever(effect);
    }
}

// The build effect: anything the build throws ends it with a reason, and a build that
// returned is attached and starts its deadline. Both answers carry the generation of the build (`stampGen`, the one its
// output was computed at), and `reduce` drops them once embedder code inside the build built again (LM-2: see `built`
// and `buildFailed` in reduce).
function runBuild(host: LifecycleHost, stampGen: Generation): void {
    let prepared: unknown;
    try {
        prepared = host.build();
    } catch (error) {
        host.step({ t: 'buildFailed', gen: stampGen, reason: host.failureReason(error, 'build') });
        return;
    }
    host.step({ t: 'built', gen: stampGen, prepared });
}

// The one place 'terminated' is dispatched (R4:L-3), with its reason on the
// dispatching stack while its listeners run, so the no-repeat rule holds for every termination, not only a build's.
// The two steps around it carry no generation and are never skipped: the stack is restored however the listeners end.
function dispatchTerminated(host: LifecycleHost, reason: string): void {
    host.step({ t: 'dispatchStarted', reason });
    try {
        host.dispatchTerminated(reason);
    } finally {
        host.step({ t: 'dispatchEnded' });
    }
}
